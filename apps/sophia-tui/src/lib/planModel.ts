/**
 * A model's plan is untrusted, free-form text — numbered or bulleted, maybe
 * nested, maybe carrying an inline "because" for each step — long before it
 * becomes the clean {id,title,detail} list that planMode.ts's approval FSM
 * accepts. This module is that upstream stage: parse whatever text came
 * back without throwing, track per-step execution outcomes at a resolution
 * planMode.ts's FSM does not need (a step here can fail or be skipped, not
 * just complete), derive a progress readout that only reports what is
 * actually known, and merge a revised plan into the one already running.
 *
 * planMode.ts's own `revise` action resets every step back to "pending" on
 * every revision — correct for that FSM, where a re-approved plan should
 * start clean, but wrong here: discarding the state of every surviving step
 * each time the model appends one more line would make "revise mid-run" a
 * feature nobody could use. `mergePlanRevision` below is the fix, done at
 * this layer instead of touching that FSM.
 *
 * Pure, synchronous, no I/O and no timers: callers pass an explicit `at`
 * timestamp, exactly like planMode.ts's own `timestamp()` helper, so this
 * module never reads the clock on its own and stays trivially testable.
 */
import { sanitizeTerminalText } from "./chatLayout.js";
import { truncateToWidth } from "./textWidth.js";

export type PlanModelStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface PlanModelStep {
  id: string;
  title: string;
  detail?: string;
  /** Nesting level under a numbered/bulleted parent step; 0 = top level. */
  depth: number;
  status: PlanModelStepStatus;
}

export interface ParsedPlan {
  steps: PlanModelStep[];
  /** True when the input contained more steps than MAX_STEPS and the tail was dropped. */
  truncated: boolean;
}

export type PlanGateStatus = "pending" | "approved" | "rejected";

export interface PlanGate {
  status: PlanGateStatus;
  /** Revision this decision applies to; a later revision silently outdates it. */
  decidedRevision: number | null;
  reason?: string;
  updatedAt: string;
}

export interface PlanModel {
  steps: PlanModelStep[];
  revision: number;
  truncated: boolean;
  gate: PlanGate;
  updatedAt: string;
}

export interface PlanRevisionDiff {
  steps: PlanModelStep[];
  added: string[];
  removed: string[];
  reordered: boolean;
}

export interface PlanRevisionResult {
  model: PlanModel;
  diff: PlanRevisionDiff;
}

export interface PlanProgress {
  /** Steps resolved either way (done, failed or skipped) — not just "done". */
  resolved: number;
  done: number;
  failed: number;
  skipped: number;
  total: number;
  percent: number;
  /** 1-based position of the active step, or null when nothing is active. */
  activeIndex: number | null;
  /** e.g. "Step 3 of 7" — or an honest fallback when no step is active. */
  label: string;
}

// A real plan runs a handful of steps; these caps exist purely so a hostile
// or garbled model reply (a runaway numbered list, one gigantic line) costs
// this process a bounded amount of work instead of an unbounded one.
const MAX_INPUT_CHARS = 200_000;
const MAX_LINE_CHARS = 2_000;
const MAX_STEPS = 200;
const MAX_TITLE_COLUMNS = 200;
const MAX_DETAIL_COLUMNS = 600;
const MAX_DEPTH = 8;

function timestamp(at?: string): string {
  return at || new Date().toISOString();
}

// "1." "1)" or a bullet, followed by at least one space and the step text.
// Deliberately requires the trailing whitespace so a markdown "---" rule or
// a sentence starting "3-2 down" is never mistaken for a list marker.
const MARKER_RE = /^(\d{1,6}[.)]|[-*•])\s+(.*)$/;
// A continuation line that is entirely a labelled rationale, e.g. a step's
// reasoning wrapped onto its own line as "Rationale: because X."
const LABELLED_LINE_RE = /^(?:rationale|why|reason)\s*:\s*(.*)$/i;
// The same label appearing inline after the step's own title, e.g.
// "Add the index — rationale: lookups are O(n) today" or "(why: ...)". The
// colon is required so an ordinary title that happens to contain the word
// "why" or "reason" is never mistaken for one carrying a rationale.
const INLINE_RATIONALE_RE = /(?:^|[\s(—-]+)(?:rationale|why|reason|because)\s*:\s*(.*)$/i;

function clampLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

function expandTabs(line: string): string {
  return line.includes("\t") ? line.replace(/\t/g, "    ") : line;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function splitInlineRationale(text: string): { title: string; detail?: string } {
  const match = INLINE_RATIONALE_RE.exec(text);
  if (!match || match.index === undefined) return { title: text.trim() };
  const title = text.slice(0, match.index).replace(/[\s—:(-]+$/, "").trim();
  if (!title) return { title: text.trim() }; // the whole line WAS the label; nothing to split off
  const detail = match[1].replace(/\)\s*$/, "").trim();
  return detail ? { title, detail } : { title };
}

function slugify(text: string, fallback: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || fallback;
}

function uniqueId(base: string, seen: Map<string, number>): string {
  const count = (seen.get(base) || 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

function appendDetail(step: PlanModelStep, text: string): void {
  if (!text) return;
  const merged = step.detail ? `${step.detail} ${text}` : text;
  step.detail = truncateToWidth(merged, MAX_DETAIL_COLUMNS);
}

/**
 * Turn raw, untrusted model plan text into structured steps. Never throws:
 * unterminated markup, ANSI escapes, duplicate step numbers and an absurd
 * step count all degrade to something reasonable rather than an exception,
 * because this runs on whatever the model happened to emit, not on text
 * this process controls.
 */
export function parsePlanText(raw: string): ParsedPlan {
  const clean = sanitizeTerminalText(String(raw ?? "")).slice(0, MAX_INPUT_CHARS);
  const lines = clean.split(/\r\n|\r|\n/);

  const steps: PlanModelStep[] = [];
  const seenIds = new Map<string, number>();
  const indentStack: number[] = [-1];
  let truncated = false;

  for (const rawLine of lines) {
    const line = expandTabs(clampLine(rawLine));
    const trimmed = line.trim();
    if (!trimmed) continue;

    const marker = MARKER_RE.exec(trimmed);
    if (marker) {
      if (steps.length >= MAX_STEPS) {
        truncated = true;
        break;
      }
      const indent = leadingSpaces(line);
      // Monotonic indentation stack: nesting depth follows relative
      // indentation, not an assumed 2- or 4-space multiple, so a model
      // mixing tab widths or indent styles still nests sensibly.
      while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
        indentStack.pop();
      }
      const depth = Math.min(indentStack.length - 1, MAX_DEPTH);
      indentStack.push(indent);

      const { title, detail } = splitInlineRationale(marker[2]);
      const finalTitle = truncateToWidth(title || marker[2].trim() || "Untitled step", MAX_TITLE_COLUMNS);
      // Ids are derived from title text, not the model's own numbering, so
      // duplicate or repeated numerals ("1." twice) never collide and — as
      // a side effect — an unchanged step keeps the same id across a later
      // re-parse, which is exactly what mergePlanRevision relies on.
      const id = uniqueId(slugify(finalTitle, `step-${steps.length + 1}`), seenIds);
      steps.push({
        id,
        title: finalTitle,
        ...(detail ? { detail: truncateToWidth(detail, MAX_DETAIL_COLUMNS) } : {}),
        depth,
        status: "pending",
      });
      continue;
    }

    // Not a marker line: either preamble before the first step (dropped —
    // a model's "Here's my plan:" preface is not a step) or a continuation
    // line carrying more rationale for the step just parsed.
    if (!steps.length) continue;
    const labelled = LABELLED_LINE_RE.exec(trimmed);
    appendDetail(steps[steps.length - 1], labelled ? labelled[1].trim() : trimmed);
  }

  return { steps, truncated };
}

/**
 * Merge a freshly parsed plan into the currently tracked steps, preserving
 * the status of any step whose id survived. A step whose wording changed is,
 * honestly, a different step: guessing that reworded text is "the same"
 * step could resurrect a "done" status onto work the model never actually
 * finished, which is worse than treating it as new and pending.
 */
export function mergePlanRevision(
  previous: readonly PlanModelStep[],
  next: readonly PlanModelStep[],
): PlanRevisionDiff {
  const previousById = new Map(previous.map((step) => [step.id, step]));
  const nextIds = new Set(next.map((step) => step.id));

  const steps = next.map((step) => {
    const prior = previousById.get(step.id);
    return prior ? { ...step, status: prior.status } : step;
  });
  const added = next.filter((step) => !previousById.has(step.id)).map((step) => step.id);
  const removed = previous.filter((step) => !nextIds.has(step.id)).map((step) => step.id);

  const survivedBefore = previous.filter((step) => nextIds.has(step.id)).map((step) => step.id);
  const survivedAfter = next.filter((step) => previousById.has(step.id)).map((step) => step.id);
  const reordered = survivedBefore.join(" ") !== survivedAfter.join(" ");

  return { steps, added, removed, reordered };
}

/** Update one step's status by id. Ignores an unknown id rather than throwing. */
export function setPlanStepStatus(
  model: PlanModel,
  stepId: string,
  status: PlanModelStepStatus,
  at?: string,
): PlanModel {
  const index = model.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return model;
  const steps = model.steps.map((step, i) => (i === index ? { ...step, status } : step));
  return { ...model, steps, updatedAt: timestamp(at) };
}

/**
 * Progress that reports what is actually known rather than assuming linear
 * completion: a step is only "done" because something marked it done, the
 * active pointer only exists when a step is truly active, and a plan with
 * nothing active yet — resumed, stalled, or not started — says so plainly
 * instead of fabricating a "step N" position nobody chose.
 */
export function derivePlanProgress(steps: readonly PlanModelStep[]): PlanProgress {
  const total = steps.length;
  const done = steps.filter((step) => step.status === "done").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const skipped = steps.filter((step) => step.status === "skipped").length;
  const resolved = done + failed + skipped;
  const percent = total ? Math.round((resolved / total) * 100) : 0;
  const activeAt = steps.findIndex((step) => step.status === "active");
  const activeIndex = activeAt >= 0 ? activeAt + 1 : null;

  let label: string;
  if (!total) {
    label = "No steps yet";
  } else if (activeIndex !== null) {
    label = `Step ${activeIndex} of ${total}`;
  } else if (resolved >= total) {
    label = failed > 0 || skipped > 0
      ? `${done} of ${total} done (${failed} failed, ${skipped} skipped)`
      : `${total} of ${total} done`;
  } else {
    label = `${resolved} of ${total} resolved`;
  }

  return { resolved, done, failed, skipped, total, percent, activeIndex, label };
}

export function createPlanGate(at?: string): PlanGate {
  return { status: "pending", decidedRevision: null, updatedAt: timestamp(at) };
}

export function approvePlan(revision: number, at?: string): PlanGate {
  return { status: "approved", decidedRevision: revision, reason: undefined, updatedAt: timestamp(at) };
}

export function rejectPlan(revision: number, reason?: string, at?: string): PlanGate {
  return { status: "rejected", decidedRevision: revision, reason, updatedAt: timestamp(at) };
}

/** Execution is allowed only once the gate approved THIS exact revision. */
export function planGateAllowsExecution(gate: PlanGate, currentRevision: number): boolean {
  return gate.status === "approved" && gate.decidedRevision === currentRevision;
}

export function createPlanModel(rawPlanText: string, at?: string): PlanModel {
  const { steps, truncated } = parsePlanText(rawPlanText);
  const when = timestamp(at);
  return { steps, revision: 1, truncated, gate: createPlanGate(when), updatedAt: when };
}

/**
 * Re-parse the model's updated plan text and fold it into the running
 * model. Steps whose id survived keep their execution status; new steps
 * arrive pending; removed steps simply drop out. The revision counter
 * always advances here, which — because a gate decision is pinned to the
 * revision it was made for — silently invalidates a stale approval without
 * this function having to touch `gate.status` at all.
 */
export function revisePlanModel(model: PlanModel, rawPlanText: string, at?: string): PlanRevisionResult {
  const { steps: nextSteps, truncated } = parsePlanText(rawPlanText);
  const diff = mergePlanRevision(model.steps, nextSteps);
  return {
    model: {
      steps: diff.steps,
      revision: model.revision + 1,
      truncated,
      gate: model.gate,
      updatedAt: timestamp(at),
    },
    diff,
  };
}

export function planModelCanExecute(model: PlanModel): boolean {
  return planGateAllowsExecution(model.gate, model.revision);
}

export function approvePlanModel(model: PlanModel, at?: string): PlanModel {
  return { ...model, gate: approvePlan(model.revision, at) };
}

export function rejectPlanModel(model: PlanModel, reason?: string, at?: string): PlanModel {
  return { ...model, gate: rejectPlan(model.revision, reason, at) };
}
