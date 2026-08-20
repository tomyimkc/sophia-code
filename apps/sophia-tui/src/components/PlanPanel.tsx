import React from "react";
import { Box, Text, type Key } from "ink";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  planProgress,
  type PlanModeState,
  type PlanPhase,
  type PlanStepStatus,
} from "../lib/planMode.js";
import {
  derivePlanProgress,
  type PlanGateStatus,
  type PlanModel,
  type PlanModelStepStatus,
  type PlanRevisionDiff,
} from "../lib/planModel.js";
import type { Theme } from "../lib/theme.js";
import { MatrixText } from "./MatrixText.js";

export type PlanPanelIntent =
  | "move_up"
  | "move_down"
  | "submit_for_approval"
  | "approve"
  | "reject"
  | "start"
  | "complete_step"
  | "request_exit"
  | "confirm_exit"
  | "cancel_exit"
  | "resume"
  | null;

export function planPhaseLabel(phase: PlanPhase): string {
  return ({
    draft: "Draft",
    awaiting_approval: "Awaiting approval",
    approved: "Approved",
    running: "Running",
    completed: "Completed",
    exit_requested: "Exit confirmation",
    exited: "Exited · resumable locally",
  } as Record<PlanPhase, string>)[phase];
}

export function planStepGlyph(status: PlanStepStatus): string {
  return ({ pending: "○", in_progress: "▶", completed: "✓" } as Record<PlanStepStatus, string>)[status];
}

export function planPanelBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

export function planPanelHelp(phase: PlanPhase): string {
  if (phase === "draft") return "↑↓ inspect · Enter submit for approval · e request exit";
  if (phase === "awaiting_approval") return "a approve · r return to draft · e request exit";
  if (phase === "approved") return "s or Enter start · e request exit";
  if (phase === "running") return "↑↓ inspect · Space complete active step · e request exit";
  if (phase === "exit_requested") return "y confirm exit · n or Esc keep plan";
  if (phase === "exited") return "r or Enter resume local plan";
  return "Plan complete";
}

/**
 * Translate modal key input into an intent without owning stdin. App wiring can
 * route these intents through the enforceable plan reducer without competing
 * with the main composer for Ink input events.
 */
export function resolvePlanPanelKey(
  input: string,
  key: Partial<Key>,
  phase: PlanPhase,
): PlanPanelIntent {
  if (key.upArrow) return "move_up";
  if (key.downArrow) return "move_down";
  if (phase === "exit_requested") {
    if (input.toLowerCase() === "y" || key.return) return "confirm_exit";
    if (input.toLowerCase() === "n" || key.escape) return "cancel_exit";
    return null;
  }
  if (phase === "draft" && key.return) return "submit_for_approval";
  if (phase === "awaiting_approval" && input.toLowerCase() === "a") return "approve";
  if (phase === "awaiting_approval" && input.toLowerCase() === "r") return "reject";
  if (phase === "approved" && (input.toLowerCase() === "s" || key.return)) return "start";
  if (phase === "running" && input === " ") return "complete_step";
  if (phase === "exited" && (input.toLowerCase() === "r" || key.return)) return "resume";
  if (
    input.toLowerCase() === "e" &&
    phase !== "completed" &&
    phase !== "exited"
  ) return "request_exit";
  return null;
}

/**
 * The PlanModel-driven gate (lib/planModel.ts) tracks approval as a
 * pending/approved/rejected status pinned to a revision number, not as a
 * step in planMode.ts's draft/awaiting_approval/approved/running FSM — a
 * model can revise the plan while the gate is still pending, which the FSM's
 * linear phases have no room to express. This intent vocabulary is the
 * gate's own, deliberately smaller than PlanPanelIntent above.
 */
export type PlanModelPanelIntent =
  | "move_up"
  | "move_down"
  | "select"
  | "approve"
  | "reject"
  | "close"
  | null;

export function planModelGateLabel(status: PlanGateStatus): string {
  return ({ pending: "Awaiting approval", approved: "Approved", rejected: "Rejected" } as Record<PlanGateStatus, string>)[status];
}

export function planModelStepGlyph(status: PlanModelStepStatus): string {
  return ({
    pending: "○",
    active: "▶",
    done: "✓",
    failed: "✗",
    skipped: "⏭",
  } as Record<PlanModelStepStatus, string>)[status];
}

export function planModelPanelHelp(gateStatus: PlanGateStatus): string {
  if (gateStatus === "pending") return "↑↓ move · Enter select · a approve · r reject · Esc close";
  return "↑↓ move · Enter select · Esc close";
}

/**
 * True when a step id was introduced by the plan's most recent revision. A
 * caller passes the PlanRevisionDiff produced by planModel.ts's
 * revisePlanModel so an operator watching a plan get revised mid-run sees
 * exactly what is new — the unchanged glyph on every surviving step is the
 * other half of that story, and needs no marker at all: mergePlanRevision
 * already carried its status forward untouched.
 */
export function planModelStepIsNew(diff: PlanRevisionDiff | undefined, stepId: string): boolean {
  return Boolean(diff && diff.added.includes(stepId));
}

/**
 * Same translate-key-to-intent contract as resolvePlanPanelKey: approve and
 * reject only ever resolve while the gate is still pending, so a caller can
 * wire this straight into a key handler without re-checking gate status
 * itself before dispatching the resulting intent to onApprove/onReject.
 */
export function resolvePlanModelPanelKey(
  input: string,
  key: Partial<Key>,
  gateStatus: PlanGateStatus,
): PlanModelPanelIntent {
  if (key.upArrow) return "move_up";
  if (key.downArrow) return "move_down";
  if (key.escape) return "close";
  if (key.return) return "select";
  if (gateStatus === "pending" && input.toLowerCase() === "a") return "approve";
  if (gateStatus === "pending" && input.toLowerCase() === "r") return "reject";
  return null;
}

export function planModelStepColor(status: PlanModelStepStatus, theme: Theme): string {
  if (status === "done") return theme.success;
  if (status === "active") return theme.accent;
  if (status === "failed") return theme.error;
  return theme.dim; // pending / skipped
}

function planModelGateColor(status: PlanGateStatus, theme: Theme): string {
  if (status === "approved") return theme.success;
  return theme.warn; // pending / rejected both want the operator's attention
}

function phaseColor(phase: PlanPhase, theme: Theme): string {
  if (phase === "completed") return theme.success;
  if (phase === "exit_requested") return theme.warn;
  if (phase === "running") return theme.accent;
  if (phase === "awaiting_approval") return theme.warn;
  return theme.dim;
}

function stepColor(status: PlanStepStatus, theme: Theme): string {
  if (status === "completed") return theme.success;
  if (status === "in_progress") return theme.accent;
  return theme.dim;
}

function LegacyPlanPanelBody({
  state,
  theme,
  width,
  height,
  selectedStep,
  focused,
  ax,
}: {
  state: PlanModeState;
  theme: Theme;
  width: number;
  height?: number;
  selectedStep: number;
  focused: boolean;
  ax: AccessibilityPrefs;
}): React.ReactElement {
  const t = accessibleTheme(theme, ax);
  const progress = planProgress(state);
  const clampedSelection = state.steps.length
    ? Math.max(0, Math.min(selectedStep, state.steps.length - 1))
    : 0;
  const seenStepIdsRef = React.useRef<Set<string>>(
    new Set(state.steps.map((step) => step.id)),
  );
  const newStepIds = new Set(
    state.steps
      .filter((step) => !seenStepIdsRef.current.has(step.id))
      .map((step) => step.id),
  );
  React.useEffect(() => {
    for (const step of state.steps) seenStepIdsRef.current.add(step.id);
  }, [state.steps]);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={planPanelBorderStyle(ax)}
      borderColor={state.phase === "exit_requested" ? t.warn : t.dim}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text color={t.accent} bold wrap="truncate-end">Sophia plan</Text>
        <Text color={phaseColor(state.phase, t)} wrap="truncate-end">
          <MatrixText text={planPhaseLabel(state.phase)} seed={811} />
        </Text>
      </Box>
      <Text color={t.text} bold wrap="truncate-end">
        <MatrixText text={state.title} seed={823} />
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={`revision ${state.revision} · ${progress.completed}/${progress.total} complete · ${progress.percent}%`}
          seed={827}
        />
      </Text>
      {state.phase === "awaiting_approval" ? (
        <Text color={t.warn} wrap="wrap">
          <MatrixText
            text="Execution is locked until this exact revision is approved."
            animateOnMount
            seed={829}
          />
        </Text>
      ) : null}
      {state.phase === "exit_requested" ? (
        <Text color={t.warn} bold wrap="wrap">
          <MatrixText
            text="Exit pauses active work and keeps this plan resumable on this device. Confirm?"
            animateOnMount
            seed={839}
          />
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {state.steps.length === 0 ? (
          <Text color={t.dim}>No steps yet.</Text>
        ) : state.steps.map((step, index) => {
          const selected = focused && index === clampedSelection;
          return (
            <Box key={step.id} flexDirection="column">
              <Text color={selected ? t.accent : stepColor(step.status, t)} bold={selected} wrap="truncate-end">
                {selected ? "› " : "  "}
                {planStepGlyph(step.status)}{" "}
                <MatrixText
                  text={step.title}
                  animateOnMount={newStepIds.has(step.id)}
                  seed={step.id.length * 61}
                />
                <Text color={t.dim}>
                  {" "}
                  <MatrixText
                    text={`[${step.status.replace("_", " ")}]`}
                    animateOnMount={newStepIds.has(step.id)}
                    seed={step.id.length * 67}
                  />
                </Text>
              </Text>
              {selected && step.detail ? (
                <Text color={t.dim} wrap="truncate-end">
                  {"    "}
                  <MatrixText text={step.detail} seed={step.id.length * 71} />
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={t.dim} wrap="truncate-end">{planPanelHelp(state.phase)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Renders lib/planModel.ts's PlanModel directly instead of going through an
 * adapter into planMode.ts's draft/awaiting_approval/... FSM — that FSM has
 * no vocabulary for a step that failed or was skipped, and resets every step
 * back to pending on each revision, which would silently discard the exact
 * "surviving step state" this model exists to preserve. `diff` is optional
 * and only used to badge steps the most recent revision introduced; omitting
 * it still renders a fully correct (just less annotated) plan.
 *
 * PRESENTATION ONLY, same as SessionBrowser/GraphPanel: ↑↓/Enter/Esc/a/r are
 * resolved by the caller's own key handler via resolvePlanModelPanelKey, and
 * the corresponding onApprove/onReject/onSelectStep/onClose prop is what
 * reports that decision back — this component never reads stdin itself. A
 * useInput here would risk the same PTY-coalesced-arrow-plus-Enter drop
 * SessionBrowser's own comment documents; App.tsx's stable input path does
 * not have that problem.
 */
function PlanModelPanelBody({
  model,
  diff,
  theme,
  width,
  height,
  selectedStep,
  focused,
  ax,
}: {
  model: PlanModel;
  diff?: PlanRevisionDiff;
  theme: Theme;
  width: number;
  height?: number;
  selectedStep: number;
  focused: boolean;
  ax: AccessibilityPrefs;
}): React.ReactElement {
  const t = accessibleTheme(theme, ax);
  const progress = derivePlanProgress(model.steps);
  const clampedSelection = model.steps.length
    ? Math.max(0, Math.min(selectedStep, model.steps.length - 1))
    : 0;
  const addedCount = diff?.added.length ?? 0;
  const removedCount = diff?.removed.length ?? 0;
  const seenStepIdsRef = React.useRef<Set<string>>(
    new Set(model.steps.map((step) => step.id)),
  );
  const newStepIds = new Set(
    model.steps
      .filter((step) => !seenStepIdsRef.current.has(step.id))
      .map((step) => step.id),
  );
  React.useEffect(() => {
    for (const step of model.steps) seenStepIdsRef.current.add(step.id);
  }, [model.steps]);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={planPanelBorderStyle(ax)}
      borderColor={model.gate.status === "rejected" ? t.warn : t.dim}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text color={t.accent} bold wrap="truncate-end">Sophia plan</Text>
        <Text color={planModelGateColor(model.gate.status, t)} wrap="truncate-end">
          <MatrixText text={planModelGateLabel(model.gate.status)} seed={853} />
        </Text>
      </Box>
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={`revision ${model.revision}${
            model.truncated ? " · truncated" : ""
          }${addedCount ? ` · ${addedCount} new` : ""}${
            removedCount ? ` · ${removedCount} removed` : ""
          } · ${progress.label} · ${progress.percent}%`}
          seed={857}
        />
      </Text>
      {model.gate.status === "pending" ? (
        <Text color={t.warn} wrap="wrap">
          <MatrixText
            text="Execution is locked until this exact revision is approved."
            animateOnMount
            seed={859}
          />
        </Text>
      ) : null}
      {model.gate.status === "rejected" ? (
        <Text color={t.warn} wrap="wrap">
          <MatrixText
            text={`Rejected at revision ${
              model.gate.decidedRevision ?? model.revision
            }${model.gate.reason ? `: ${model.gate.reason}` : ""} — needs a new revision before it can run.`}
            animateOnMount
            seed={863}
          />
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {model.steps.length === 0 ? (
          <Text color={t.dim}>No steps yet.</Text>
        ) : model.steps.map((step, index) => {
          const selected = focused && index === clampedSelection;
          const indent = "  ".repeat(step.depth);
          return (
            <Box key={step.id} flexDirection="column">
              <Text color={selected ? t.accent : planModelStepColor(step.status, t)} bold={selected} wrap="truncate-end">
                {selected ? "› " : "  "}
                {indent}
                {planModelStepGlyph(step.status)}{" "}
                <MatrixText
                  text={step.title}
                  animateOnMount={newStepIds.has(step.id)}
                  seed={step.id.length * 73}
                />
                <Text color={t.dim}>
                  {" "}
                  <MatrixText
                    text={`[${step.status}]`}
                    animateOnMount={newStepIds.has(step.id)}
                    seed={step.id.length * 79}
                  />
                </Text>
                {planModelStepIsNew(diff, step.id) ? <Text color={t.accent}> new</Text> : null}
              </Text>
              {selected && step.detail ? (
                <Text color={t.dim} wrap="truncate-end">
                  {"    "}
                  <MatrixText text={step.detail} seed={step.id.length * 83} />
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={t.dim} wrap="truncate-end">{planModelPanelHelp(model.gate.status)}</Text>
      </Box>
    </Box>
  );
}

export function PlanPanel({
  state,
  model,
  diff,
  theme,
  width,
  height,
  selectedStep = 0,
  focused = true,
  onApprove,
  onReject,
  onSelectStep,
  onClose,
}: {
  state?: PlanModeState;
  /** When set, renders lib/planModel.ts's PlanModel instead of `state` — see PlanModelPanelBody. */
  model?: PlanModel;
  /** Marks steps the most recent revision introduced; ignored unless `model` is set. */
  diff?: PlanRevisionDiff;
  theme: Theme;
  width: number;
  height?: number;
  selectedStep?: number;
  focused?: boolean;
  /** Reports an "approve" intent from resolvePlanModelPanelKey; only meaningful with `model`. */
  onApprove?: () => void;
  /** Reports a "reject" intent from resolvePlanModelPanelKey; only meaningful with `model`. */
  onReject?: (reason?: string) => void;
  /** Reports a "select" intent (Enter on a step) with that step's id; only meaningful with `model`. */
  onSelectStep?: (stepId: string) => void;
  /** Reports a "close" intent (Esc); only meaningful with `model`. */
  onClose?: () => void;
}): React.ReactElement {
  const ax = useAccessibility();
  // onApprove/onReject/onSelectStep/onClose are not called from inside this
  // component (see PlanModelPanelBody's doc comment) — they exist on the
  // prop contract so the caller's own key handler has a named place to
  // report each PlanModelPanelIntent, the same forward-declared-callback
  // shape GraphPanel's onToggle/onSelect already established for this
  // presentation-only panel family.

  if (model) {
    return (
      <PlanModelPanelBody
        model={model}
        diff={diff}
        theme={theme}
        width={width}
        height={height}
        selectedStep={selectedStep}
        focused={focused}
        ax={ax}
      />
    );
  }

  if (!state) {
    const t = accessibleTheme(theme, ax);
    return (
      <Box flexDirection="column" width={width} height={height} borderStyle={planPanelBorderStyle(ax)} borderColor={t.dim} paddingX={1} overflow="hidden">
        <Text color={t.accent} bold wrap="truncate-end">Sophia plan</Text>
        <Text color={t.dim} wrap="truncate-end">No plan yet.</Text>
      </Box>
    );
  }

  return (
    <LegacyPlanPanelBody
      state={state}
      theme={theme}
      width={width}
      height={height}
      selectedStep={selectedStep}
      focused={focused}
      ax={ax}
    />
  );
}
