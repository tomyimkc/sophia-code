/**
 * Pure session-picker logic: fuzzy filter/rank, forked-session naming, session
 * name validation, and per-workspace scope labeling.
 *
 * The session name validator is a SECURITY BOUNDARY, not just a UX nicety.
 * sessionStore.ts's conversationPath() already maps every character outside
 * `[\p{L}\p{N}-_.]` to `_`, so a raw kernel write can never itself escape the
 * conversations directory — but that mapping is silent: type
 * "../../etc/passwd" with no validation in front of it and the operator gets
 * a session mysteriously named "..-..-etc-passwd" with no explanation. This
 * module rejects the hostile input BEFORE it ever reaches that layer, with a
 * reason and a suggested name the operator can accept instead — defense in
 * depth on top of conversationPath's existing sanitization, not a replacement
 * for it.
 */
import { graphemes } from "./textWidth.js";

// ---------------------------------------------------------------------------
// Session name validation.

/** Grapheme count, not UTF-16 code units — a surrogate pair or combining mark
 *  must count once, or the cap could split one in half when truncating. */
export const SESSION_NAME_MAX_GRAPHEMES = 200;

// Written as a scan, not a /[\x00-\x1f\x7f]/ character-class literal, so the
// control-character range never has to appear as literal source bytes.
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const PATH_SEPARATOR_RE = /[/\\]/u;

export interface SessionNameAccepted {
  ok: true;
  name: string;
}

export interface SessionNameRejected {
  ok: false;
  reason: string;
  /** Always itself accepted by validateSessionName — see sessionScope.test.ts's
   *  round-trip check. An operator stuck without a legal alternative is worse
   *  than a slightly opinionated cleanup. */
  suggestion: string;
}

export type SessionNameValidation = SessionNameAccepted | SessionNameRejected;

function rejected(raw: string, reason: string): SessionNameRejected {
  return { ok: false, reason, suggestion: suggestSessionName(raw) };
}

/**
 * Validate a user-supplied session name before it is ever used to build a
 * file path. Every field crossing into this function is untrusted input, so
 * it accepts `unknown` and coerces defensively rather than assuming a string.
 */
export function validateSessionName(raw: unknown): SessionNameValidation {
  const value = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const trimmed = value.trim();
  if (!trimmed) return rejected(value, "session name cannot be empty");
  if (hasControlCharacter(value)) {
    return rejected(value, "session name contains a control character (including NUL)");
  }
  if (PATH_SEPARATOR_RE.test(trimmed)) {
    return rejected(value, "session name cannot contain a path separator (/ or \\)");
  }
  if (trimmed.startsWith("~")) {
    return rejected(value, "session name cannot start with ~ (home-directory shorthand)");
  }
  if (trimmed === "." || trimmed === "..") {
    return rejected(value, 'session name cannot be "." or ".."');
  }
  if (graphemes(trimmed).length > SESSION_NAME_MAX_GRAPHEMES) {
    return rejected(value, `session name is too long (max ${SESSION_NAME_MAX_GRAPHEMES} characters)`);
  }
  return { ok: true, name: trimmed };
}

/**
 * Best-effort cleanup used both as the rejection suggestion and as the base
 * for proposeForkedSessionName: replace every character validateSessionName
 * would reject with "-", drop a leading "~" run, collapse to a legal length
 * at a grapheme boundary, and fall back to a fixed non-empty name rather than
 * ever producing "" (which is itself invalid).
 */
function suggestSessionName(raw: string): string {
  let cleaned = "";
  for (const ch of raw) {
    cleaned += hasControlCharacter(ch) || PATH_SEPARATOR_RE.test(ch) ? "-" : ch;
  }
  cleaned = cleaned.replace(/^~+/u, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") cleaned = "session";
  const units = graphemes(cleaned);
  return units.length > SESSION_NAME_MAX_GRAPHEMES
    ? units.slice(0, SESSION_NAME_MAX_GRAPHEMES).join("")
    : cleaned;
}

// ---------------------------------------------------------------------------
// Forked-session naming.

const FORK_SUFFIX = "-fork";

/**
 * Propose a name for a session forked from `parentSessionId`, guaranteed to
 * (a) pass validateSessionName and (b) not collide with any id already in
 * `existingSessionIds`.
 *
 * The collision loop is bounded by existingSessionIds.size + 1 distinct
 * candidates (the plain "-fork" attempt plus one per numbered suffix): with
 * only existingSessionIds.size names actually taken, pigeonhole guarantees
 * one of those candidates is free, so this never needs a clock-based or
 * random tie-breaker to terminate.
 */
export function proposeForkedSessionName(
  parentSessionId: string,
  existingSessionIds: readonly string[] = [],
): string {
  const base = suggestSessionName(String(parentSessionId ?? "")) || "session";
  const existing = new Set(
    existingSessionIds.map((id) => String(id ?? "").trim()).filter(Boolean),
  );
  const build = (suffix: string): string => {
    const suffixUnits = graphemes(suffix).length;
    const budget = Math.max(1, SESSION_NAME_MAX_GRAPHEMES - suffixUnits);
    const baseUnits = graphemes(base);
    const trimmedBase = baseUnits.length > budget ? baseUnits.slice(0, budget).join("") : base;
    return `${trimmedBase}${suffix}`;
  };
  let candidate = build(FORK_SUFFIX);
  if (!existing.has(candidate)) return candidate;
  for (let n = 2; n <= existing.size + 1; n += 1) {
    candidate = build(`${FORK_SUFFIX}-${n}`);
    if (!existing.has(candidate)) return candidate;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Per-workspace scope.

export type SessionWorkspaceScope = "current-project" | "other-project" | "unscoped";

function normalizeWorkspacePath(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const collapsed = trimmed.replace(/[\\/]+$/u, "");
  return collapsed || trimmed;
}

/**
 * A legacy session recorded no cwd at all — it predates that field. Treating
 * it as "other project" would hide it from the default filtered view for no
 * good reason (it might well be this project's own history); treating it as
 * "current project" would falsely label sessions from a dozen unrelated
 * repos as this one. "unscoped" is the honest third answer, and callers
 * decide from there whether unscoped counts as included (see
 * includedInWorkspaceFilter).
 */
export function sessionWorkspaceScope(
  sessionCwd: string | null | undefined,
  currentCwd: string,
): SessionWorkspaceScope {
  const recorded = normalizeWorkspacePath(sessionCwd || "");
  if (!recorded) return "unscoped";
  return recorded === normalizeWorkspacePath(currentCwd) ? "current-project" : "other-project";
}

/** Whether a session should appear in the default "this project" filtered view. */
export function includedInWorkspaceFilter(scope: SessionWorkspaceScope): boolean {
  return scope !== "other-project";
}

/** Short label for a session-browser row; "" for unscoped (nothing to say). */
export function sessionWorkspaceScopeLabel(scope: SessionWorkspaceScope): string {
  switch (scope) {
    case "current-project": return "this project";
    case "other-project": return "other project";
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Fuzzy filter/rank by name, topic and recency.

export interface SessionScopeCandidate {
  id: string;
  title?: string;
  topic?: string;
  /** Epoch milliseconds. */
  updatedAt: number;
}

function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/**
 * Subsequence fuzzy score: every character of `query` must appear in
 * `haystack` in order, not necessarily contiguously. Returns null when it is
 * not a subsequence at all — a real miss, which callers filter out entirely,
 * rather than a weak match ranked at the bottom. Consecutive matches and
 * matches right after a word boundary (start, space, hyphen, underscore, dot,
 * slash) score higher, and the overall match span is penalized lightly so a
 * tight cluster of matched characters outranks the same characters scattered
 * across a much longer string.
 */
export function fuzzySessionScore(query: string, haystack: string): number | null {
  const q = normalizeForMatch(query);
  const h = normalizeForMatch(haystack);
  if (!q) return 0;
  if (!h) return null;
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let hi = 0; hi < h.length && qi < q.length; hi += 1) {
    if (h[hi] !== q[qi]) {
      consecutive = 0;
      continue;
    }
    if (firstIndex < 0) firstIndex = hi;
    lastIndex = hi;
    const boundary = hi === 0 || /[\s\-_./]/u.test(h[hi - 1]);
    score += 1 + consecutive * 2 + (boundary ? 3 : 0);
    consecutive += 1;
    qi += 1;
  }
  if (qi < q.length) return null;
  // Span is measured between the first and last MATCHED character, not out to
  // the end of the haystack — "graph-panel" matching "gp" at indices 0 and 3
  // is a tight match even though the string keeps going after index 3; only
  // the gap the match actually spans should be penalized.
  const span = lastIndex - firstIndex + 1;
  return score - span * 0.05;
}

const FIELD_WEIGHT: Record<"id" | "title" | "topic", number> = { id: 1, title: 1.5, topic: 1 };

function bestFieldScore(candidate: SessionScopeCandidate, query: string): number | null {
  const fields: Array<["id" | "title" | "topic", string]> = [
    ["id", candidate.id],
    ["title", candidate.title || ""],
    ["topic", candidate.topic || ""],
  ];
  let best: number | null = null;
  for (const [field, text] of fields) {
    if (!text) continue;
    const raw = fuzzySessionScore(query, text);
    if (raw === null) continue;
    const weighted = raw * FIELD_WEIGHT[field];
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

/**
 * Rank sessions by name/topic match quality, blended with a small recency
 * bonus so a just-touched weak match can edge out a much staler strong one —
 * without a query, recency is the ONLY signal (empty query means "browsing",
 * not "searching"). `now` is caller-supplied rather than read from Date.now()
 * here, so ranking stays deterministic under test.
 */
export function rankSessionsByQuery<T extends SessionScopeCandidate>(
  candidates: readonly T[],
  query: string,
  now: number,
): T[] {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return [...candidates].sort((a, b) => b.updatedAt - a.updatedAt);
  const scored: Array<{ candidate: T; total: number }> = [];
  for (const candidate of candidates) {
    const matchScore = bestFieldScore(candidate, trimmed);
    if (matchScore === null) continue;
    const ageDays = Math.max(0, (now - candidate.updatedAt) / 86_400_000);
    const recencyBonus = 3 / (1 + ageDays);
    scored.push({ candidate, total: matchScore + recencyBonus });
  }
  scored.sort((a, b) => b.total - a.total || b.candidate.updatedAt - a.candidate.updatedAt);
  return scored.map((entry) => entry.candidate);
}
