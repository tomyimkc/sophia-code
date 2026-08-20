import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_REFINEMENT_LESSON_CHARS = 1_000;
export const MAX_REFINEMENT_EVIDENCE_CHARS = 2_000;
export const MAX_REFINEMENT_QUERY_CHARS = 500;
export const REFINEMENT_PREVIEW_LIMIT = 3;

const MAX_QUERY_TERMS = 16;
const MAX_STATE_BYTES = 1024 * 1024;
const POISON_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["test_bypass", "skip tests"],
  ["test_bypass", "disable tests"],
  ["test_bypass", "delete tests"],
  ["test_bypass", "modify tests"],
  ["test_bypass", "edit tests"],
  ["verifier_bypass", "bypass verifier"],
  ["verifier_bypass", "verifier bypass"],
  ["verifier_bypass", "disable verifier"],
  ["verifier_bypass", "modify verifier"],
  ["verifier_bypass", "edit verifier"],
  ["verifier_bypass", "ignore verifier"],
  ["fixture_shortcut", "hard-code task"],
  ["fixture_shortcut", "hardcode task"],
  ["fixture_shortcut", "hard-code fixture"],
  ["fixture_shortcut", "hardcode fixture"],
  ["fixture_shortcut", "task-id branch"],
  ["fixture_shortcut", "task id branch"],
  ["visible_answer", "copy the visible answer"],
  ["visible_answer", "exact visible answer"],
  ["visible_answer", "hard-code answer"],
  ["visible_answer", "hardcode answer"],
  ["visible_answer", "return constant"],
];

export type HarnessState = {
  version?: number;
  supplemental?: Record<string, unknown[]>;
};

export type RefinementProposal = {
  id: string;
  category: "lesson";
  lesson: string;
  evidence: string;
  status: "pending";
  created_at: string;
  candidateOnly: true;
  applied: false;
  weightUpdate: false;
  promotionEligible: false;
  canClaimAGI: false;
};

export type HarnessPreviewLesson = {
  category: string;
  text: string;
  evidence: string;
  created_at: string;
  status: "applied";
  score: number;
};

export type RefinementRiskSignal = {
  kind: string;
  matched: string;
};

export type RefineSlashIntent =
  | { action: "help" }
  | { action: "invalid"; reason: string }
  | { action: "propose"; lesson: string; evidence: string }
  | { action: "preview"; query: string };

function harnessPaths(root: string): {
  sophia: string;
  harness: string;
  state: string;
  proposals: string;
} {
  const workspace = path.resolve(root);
  const sophia = path.join(workspace, ".sophia");
  const harness = path.join(sophia, "harness");
  return {
    sophia,
    harness,
    state: path.join(harness, "state.json"),
    proposals: path.join(harness, "proposals.jsonl"),
  };
}

async function isSafeDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  if (!await isSafeDirectory(directory)) {
    throw new Error(`refusing unsafe harness directory: ${directory}`);
  }
}

async function ensureHarnessDirectory(root: string): Promise<ReturnType<typeof harnessPaths>> {
  const paths = harnessPaths(root);
  await ensureSafeDirectory(paths.sophia);
  await ensureSafeDirectory(paths.harness);
  return paths;
}

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function tokens(value: unknown): string[] {
  return [...new Set(normalized(value).match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function deterministicTextCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundedText(label: string, value: unknown, maxChars: number): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (Array.from(text).length > maxChars) {
    throw new Error(`${label} exceeds ${maxChars} characters`);
  }
  return text;
}

function storedText(value: unknown, maxChars: number): string {
  return Array.from(String(value ?? "").trim()).slice(0, maxChars).join("");
}

function phraseIsNegated(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 20), start).trimEnd();
  return ["do not", "don't", "never", "must not"]
    .some((negation) => prefix.endsWith(negation));
}

export function refinementRiskSignals(
  lesson: unknown,
  evidence: unknown = "",
): RefinementRiskSignal[] {
  const text = normalized(`${String(lesson ?? "")}\n${String(evidence ?? "")}`);
  const signals: RefinementRiskSignal[] = [];
  for (const [kind, phrase] of POISON_PHRASES) {
    let start = text.indexOf(phrase);
    let matched = false;
    while (start >= 0) {
      if (!phraseIsNegated(text, start)) {
        matched = true;
        break;
      }
      start = text.indexOf(phrase, start + phrase.length);
    }
    if (!matched) continue;
    if (!signals.some((signal) => signal.kind === kind && signal.matched === phrase)) {
      signals.push({ kind, matched: phrase });
    }
  }
  return signals;
}

function appliedSupplementalItems(state: HarnessState | null): Array<HarnessPreviewLesson & { order: number }> {
  const items: Array<HarnessPreviewLesson & { order: number }> = [];
  let order = 0;
  for (const [category, rows] of Object.entries(state?.supplemental ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const value = row as Record<string, unknown>;
      // State written before the explicit status field is applied state.
      if (String(value.status ?? "applied").toLowerCase() !== "applied") continue;
      const text = storedText(value.text, MAX_REFINEMENT_LESSON_CHARS);
      if (!text) continue;
      const evidence = storedText(value.evidence, MAX_REFINEMENT_EVIDENCE_CHARS);
      if (refinementRiskSignals(text, evidence).length > 0) continue;
      items.push({
        category: storedText(category, 64),
        text,
        evidence,
        created_at: storedText(value.created_at, 64),
        status: "applied",
        score: 0,
        order,
      });
      order += 1;
    }
  }
  return items;
}

export function parseRefineSlash(args: string): RefineSlashIntent {
  const text = String(args ?? "").trim();
  if (!text) return { action: "help" };
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const action = match?.[1]?.toLowerCase() ?? "";
  const payload = match?.[2]?.trim() ?? "";
  try {
    if (action === "propose") {
      const separator = payload.indexOf("::");
      if (separator < 0) {
        return {
          action: "invalid",
          reason: "usage: /refine propose <lesson> :: <evidence>",
        };
      }
      return {
        action: "propose",
        lesson: boundedText(
          "lesson",
          payload.slice(0, separator),
          MAX_REFINEMENT_LESSON_CHARS,
        ),
        evidence: boundedText(
          "evidence",
          payload.slice(separator + 2),
          MAX_REFINEMENT_EVIDENCE_CHARS,
        ),
      };
    }
    if (action === "preview") {
      const query = boundedText("query", payload, MAX_REFINEMENT_QUERY_CHARS);
      if (tokens(query).length === 0) {
        return {
          action: "invalid",
          reason: "query must contain at least one letter or number",
        };
      }
      return { action: "preview", query };
    }
  } catch (error) {
    return {
      action: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    action: "invalid",
    reason: "usage: /refine propose <lesson> :: <evidence> | /refine preview <query>",
  };
}

export async function readContinualHarness(root: string): Promise<HarnessState | null> {
  try {
    const paths = harnessPaths(root);
    if (!await isSafeDirectory(paths.sophia) || !await isSafeDirectory(paths.harness)) {
      return null;
    }
    const info = await lstat(paths.state);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) return null;
    const raw = await readFile(paths.state, "utf8");
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? value as HarnessState : null;
  } catch {
    return null;
  }
}

export async function proposeContinualRefinement(
  root: string,
  lesson: string,
  evidence: string,
  now: Date = new Date(),
): Promise<RefinementProposal> {
  const lessonText = boundedText(
    "lesson",
    lesson,
    MAX_REFINEMENT_LESSON_CHARS,
  );
  const evidenceText = boundedText(
    "evidence",
    evidence,
    MAX_REFINEMENT_EVIDENCE_CHARS,
  );
  const proposal: RefinementProposal = {
    id: createHash("sha256")
      .update(
        `lesson|${lessonText}|${evidenceText}|${now.toISOString()}|${randomUUID()}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 24),
    category: "lesson",
    lesson: lessonText,
    evidence: evidenceText,
    status: "pending",
    created_at: now.toISOString(),
    candidateOnly: true,
    applied: false,
    weightUpdate: false,
    promotionEligible: false,
    canClaimAGI: false,
  };
  const paths = await ensureHarnessDirectory(root);
  const line = `${JSON.stringify(proposal)}\n`;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    paths.proposals,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.appendFile(line, "utf8");
  } finally {
    await handle.close();
  }
  return proposal;
}

export function relevantAppliedLessons(
  state: HarnessState | null,
  query: string,
  limit = REFINEMENT_PREVIEW_LIMIT,
): HarnessPreviewLesson[] {
  const queryText = boundedText("query", query, MAX_REFINEMENT_QUERY_CHARS);
  const queryTokens = tokens(queryText).slice(0, MAX_QUERY_TERMS);
  if (queryTokens.length === 0) {
    throw new Error("query must contain at least one letter or number");
  }
  const queryNormalized = normalized(queryText);
  const boundedLimit = Math.min(
    REFINEMENT_PREVIEW_LIMIT,
    Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : REFINEMENT_PREVIEW_LIMIT)),
  );
  return appliedSupplementalItems(state)
    .map((item) => {
      const lessonNormalized = normalized(item.text);
      const lessonTokens = new Set(tokens(item.text));
      const categoryTokens = new Set(tokens(item.category));
      const evidenceTokens = new Set(tokens(item.evidence));
      const score =
        queryTokens.reduce((sum, token) => sum + (lessonTokens.has(token) ? 4 : 0), 0)
        + queryTokens.reduce((sum, token) => sum + (categoryTokens.has(token) ? 2 : 0), 0)
        + queryTokens.reduce((sum, token) => sum + (evidenceTokens.has(token) ? 1 : 0), 0)
        + (lessonNormalized.includes(queryNormalized) ? 8 : 0);
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || deterministicTextCompare(normalized(a.category), normalized(b.category))
      || deterministicTextCompare(normalized(a.text), normalized(b.text))
      || deterministicTextCompare(normalized(a.evidence), normalized(b.evidence))
      || a.order - b.order)
    .slice(0, boundedLimit)
    .map(({ order: _order, ...item }) => item);
}

export async function previewContinualRefinement(
  root: string,
  query: string,
): Promise<HarnessPreviewLesson[]> {
  return relevantAppliedLessons(await readContinualHarness(root), query);
}

export function formatContinualHarnessStatus(state: HarnessState | null): string {
  if (!state) return "continual harness: not initialized";
  const lessons = appliedSupplementalItems(state).length;
  return `continual harness: v${Number.isInteger(state.version) ? state.version : 0} · ${lessons} explicit lesson(s) · base policy immutable`;
}

export function formatContinualHarnessPreview(
  query: string,
  lessons: readonly HarnessPreviewLesson[],
): string {
  const header = `refine preview · APPLIED lessons only · query: ${query}`;
  const boundary = "pending proposals excluded · read-only · candidate-only · no weight update, model uplift, or auto-promotion";
  if (lessons.length === 0) {
    return `${header}\n  (no relevant applied lessons)\n${boundary}`;
  }
  return [
    header,
    ...lessons.map((lesson, index) =>
      `  ${index + 1}. [${lesson.category}] ${lesson.text} (evidence: ${lesson.evidence}) · relevance ${lesson.score}`),
    boundary,
  ].join("\n");
}
