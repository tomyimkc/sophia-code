/**
 * Should the TUI hydrate the previous transcript on startup?
 *
 * A new session must start EMPTY. Auto-hydrating made every launch silently
 * inherit the last conversation — surprising, and expensive, because that
 * transcript is replayed into the model's history on the next run (a 48-turn
 * carry-over was observed in the wild, along with the model degenerating on the
 * repeated context).
 *
 * The subtlety that broke the first attempt at this: `--session` is declared
 * with `default: "tui-default"`, so the parsed flag is ALWAYS truthy. Gating on
 * "is there a session name?" is therefore always true and disables nothing. The
 * question is not whether a session name exists — one always does — but whether
 * the USER ASKED for one. That can only be answered from argv, before defaults
 * are filled in.
 */

import { randomUUID } from "node:crypto";

/** True only when --session/-s appears in the raw argv the user typed. */
export function sessionExplicitlyRequested(argv: readonly string[]): boolean {
  return argv.some(
    (a) => a === "--session" || a === "-s" || a.startsWith("--session=") || a.startsWith("-s="),
  );
}

/**
 * True only when --continue/-c appears in the raw argv. Sophia's fast-resume
 * fast path: reopen the MOST RECENT session instantly, no picker. Like
 * --session, this is an explicit user act, so it implies auto-resume; the actual
 * "which session is most recent" resolution needs disk and lives in the caller
 * (index.tsx), keeping this module pure.
 */
export function continueRequested(argv: readonly string[]): boolean {
  return argv.some((a) => a === "--continue" || a === "-c" || a.startsWith("--continue="));
}

/**
 * Resuming is an explicit act: `--session`, `--continue`, or `/resume` once
 * the session is running. Environment variables are intentionally not part of
 * this launch decision: a shell profile, IDE, or copied command must not turn
 * a bare `sophia` launch into an implicit resume.
 */
export function shouldAutoResume(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Keep the env parameter for API compatibility with callers/tests that pass
  // a sanitized environment. It is deliberately ignored for launch resume.
  void env;
  return sessionExplicitlyRequested(argv) || continueRequested(argv);
}

/**
 * The session name a launch should use.
 *
 * `--session` used to default to the fixed name "tui-default", so every launch
 * reused ONE growing conversation file. That is the real reason a "new" session
 * still remembered everything: the bridge loads history from disk per run
 * (code_bridge.py, `history = _load_conversation(_conversation_path(session))`),
 * independently of whether the UI hydrated its transcript. Emptying the UI alone
 * made it worse — the transcript then HID the context still being sent.
 *
 * So a fresh launch gets a fresh id instead of silently reusing old context
 * rather than reopening one. Turns within a session still accumulate normally;
 * what stops is inheriting a previous session's turns.
 */
export function resolveSessionName(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
  now: Date = new Date(),
  freshSuffix = randomUUID().replaceAll("-", "").slice(0, 10),
): string {
  if (sessionExplicitlyRequested(argv) && explicit) return explicit;
  // --continue is resolved to the newest concrete session by index.tsx. This
  // fallback only covers an empty session catalog and must still be fresh.
  // There is deliberately no implicit "tui-default" fallback here.
  void env;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `sess-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}` +
    `-${String(freshSuffix || randomUUID().replaceAll("-", "").slice(0, 10)).slice(0, 10)}`
  );
}

// ---------------------------------------------------------------------------
// Safe draft/session interaction contract.
//
// UI code should not improvise what happens to text in the composer while a
// session changes. The default transition below is deliberately lossless:
// preserve the current session's draft, restore the target session's draft, and
// refuse any switch while a run is in flight.

export type SessionDraftMap = Readonly<Record<string, string>>;

export interface SessionSwitchRequest {
  currentSession: string;
  targetSession: string;
  currentDraft: string;
  drafts?: SessionDraftMap;
  runInFlight?: boolean;
  /**
   * Explicit destructive opt-in. The default is false, so a non-empty draft is
   * saved under currentSession before the target draft is restored.
   */
  discardCurrentDraft?: boolean;
}

export type SessionSwitchBlockReason =
  | "run-in-flight"
  | "missing-current-session"
  | "missing-target-session";

export interface AllowedSessionSwitch {
  ok: true;
  from: string;
  to: string;
  changed: boolean;
  nextDraft: string;
  drafts: Record<string, string>;
  preservedCurrentDraft: boolean;
}

export interface BlockedSessionSwitch {
  ok: false;
  from: string;
  to: string;
  reason: SessionSwitchBlockReason;
  nextDraft: string;
  drafts: Record<string, string>;
  preservedCurrentDraft: true;
}

export type SessionSwitchPlan = AllowedSessionSwitch | BlockedSessionSwitch;

function copyDrafts(value: SessionDraftMap | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [session, draft] of Object.entries(value || {})) {
    const key = String(session || "").trim();
    if (key) out[key] = String(draft ?? "");
  }
  return out;
}

/**
 * Plan a session switch without mutating UI state.
 *
 * - A live run blocks switching.
 * - A draft is preserved by default, even if it is empty (restoring the exact
 *   per-session composer state is safer than conflating "none" and "blank").
 * - Destructive discard requires discardCurrentDraft:true.
 */
export function planSessionSwitch(request: SessionSwitchRequest): SessionSwitchPlan {
  const from = String(request.currentSession || "").trim();
  const to = String(request.targetSession || "").trim();
  const drafts = copyDrafts(request.drafts);
  const currentDraft = String(request.currentDraft ?? "");

  if (!from) {
    return {
      ok: false,
      from,
      to,
      reason: "missing-current-session",
      nextDraft: currentDraft,
      drafts,
      preservedCurrentDraft: true,
    };
  }
  if (!to) {
    return {
      ok: false,
      from,
      to,
      reason: "missing-target-session",
      nextDraft: currentDraft,
      drafts,
      preservedCurrentDraft: true,
    };
  }
  if (request.runInFlight) {
    drafts[from] = currentDraft;
    return {
      ok: false,
      from,
      to,
      reason: "run-in-flight",
      nextDraft: currentDraft,
      drafts,
      preservedCurrentDraft: true,
    };
  }
  if (!request.discardCurrentDraft) drafts[from] = currentDraft;
  else delete drafts[from];
  return {
    ok: true,
    from,
    to,
    changed: from !== to,
    nextDraft: from === to ? currentDraft : (drafts[to] ?? ""),
    drafts,
    preservedCurrentDraft: !request.discardCurrentDraft,
  };
}
