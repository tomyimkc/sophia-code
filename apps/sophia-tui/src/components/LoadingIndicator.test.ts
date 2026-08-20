import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAccessibility } from "../lib/accessibility.js";
import { EMPTY_FRONTIER, type Row } from "../lib/anims/index.js";
import {
  loadingAnimationSnapshot,
  loadingIndicatorHeight,
  loadingIntervalEnabled,
  loadingSpinGlyph,
  loadingElapsedSeconds,
  loadingElapsedSuffix,
  syncLoadingFrontier,
} from "./LoadingIndicator.js";

const NO_ENV = {} as NodeJS.ProcessEnv;
const FRAMES = ["⠋", "⠙", "⠹", "⠸"];
const APP_SOURCE = readFileSync(new URL("../App.tsx", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const PRODUCTION_ANIMATION_SOURCES = [
  "LoadingIndicator.tsx",
  "MessageList.tsx",
  "GoalTodoPanel.tsx",
  "RightPanelDetails.tsx",
].map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).join("\n");

function rowText(row: Row): string {
  return row.map((cell) => cell.ch).join("").trimEnd();
}

test("the spin timer is disabled under reduced motion, not just frozen", () => {
  const still = resolveAccessibility(["--reduced-motion"], NO_ENV);
  const moving = resolveAccessibility([], NO_ENV);
  assert.equal(loadingIntervalEnabled(true, still), false);
  assert.equal(loadingIntervalEnabled(true, moving), true);
  // Never runs a timer for an inactive phase regardless of the preference.
  assert.equal(loadingIntervalEnabled(false, moving), false);
});

test("reduced motion holds the spinner on one still glyph across ticks", () => {
  const still = resolveAccessibility(["--ax-screen-reader"], NO_ENV);
  const rendered = [0, 1, 2, 3].map((tick) => loadingSpinGlyph(still, "thinking", true, FRAMES, tick));
  assert.equal(new Set(rendered).size, 1, "a reduced-motion spinner must not change frame to frame");
});

test("normal motion still cycles through frames", () => {
  const moving = resolveAccessibility([], NO_ENV);
  assert.equal(loadingSpinGlyph(moving, "thinking", true, FRAMES, 0), FRAMES[0]);
  assert.equal(loadingSpinGlyph(moving, "thinking", true, FRAMES, 1), FRAMES[1]);
});

test("terminal phases keep their done/error glyph regardless of motion preference", () => {
  const still = resolveAccessibility(["--reduced-motion"], NO_ENV);
  assert.equal(loadingSpinGlyph(still, "done", false, FRAMES, 0), "✓");
  assert.equal(loadingSpinGlyph(still, "error", false, FRAMES, 0), "✗");
});

test("every visible progress phase occupies exactly one replace-in-place row", () => {
  assert.equal(loadingIndicatorHeight({ phase: "idle", detail: "", streamPreview: "" }), 0);
  for (const phase of [
    "starting",
    "planning",
    "thinking",
    "tool",
    "streaming",
    "awaiting_permission",
    "paused",
    "finalizing",
    "done",
    "error",
    "cancelled",
    "cancelling",
  ] as const) {
    assert.equal(
      loadingIndicatorHeight({ phase, detail: "", streamPreview: "" }),
      1,
      `${phase} must not reserve a hidden second row`,
    );
  }
});

// Regression: the loading indicator used to show only a spinner glyph, with
// no sense of how long a tool call had been running (a competitor-parity
// gap the research pass flagged explicitly).
test("elapsed seconds is null while idle/finished, counts up while active", () => {
  assert.equal(loadingElapsedSeconds(false, null, 1_000), null, "never started");
  assert.equal(loadingElapsedSeconds(false, 1_000, 5_000), null, "run ended, no longer active");
  assert.equal(loadingElapsedSeconds(true, 1_000, 1_000), 0, "just started");
  assert.equal(loadingElapsedSeconds(true, 1_000, 4_500), 3, "3.5s in, floored to whole seconds");
});

test("elapsed suffix stays silent below the threshold, then renders seconds", () => {
  assert.equal(loadingElapsedSuffix(null), "");
  assert.equal(loadingElapsedSuffix(0), "", "sub-threshold: not worth surfacing yet");
  assert.equal(loadingElapsedSuffix(1), "");
  assert.equal(loadingElapsedSuffix(2), " (2s)");
  assert.equal(loadingElapsedSuffix(59), " (59s)");
});

test("elapsed suffix switches to minutes:seconds past a minute, for long tool calls", () => {
  assert.equal(loadingElapsedSuffix(60), " (1m 0s)");
  assert.equal(loadingElapsedSuffix(125), " (2m 5s)");
});

test("streaming projects exactly one decode row and keeps its committed prefix literal", () => {
  const moving = resolveAccessibility([], NO_ENV);
  const preview = "already committed text newest";
  const frontier = syncLoadingFrontier(EMPTY_FRONTIER, preview, true, false);
  assert.ok(frontier.committed.length > 0, "the fixture must expose a stable committed prefix");

  const animation = loadingAnimationSnapshot({
    progress: { phase: "streaming", detail: "", streamPreview: preview },
    prefs: moving,
    frontier,
    frame: 2,
    width: 60,
  });

  assert.equal(animation.job, "line");
  assert.equal(animation.rows.length, 1);
  assert.equal(
    rowText(animation.rows[0]).slice(0, frontier.committed.length),
    frontier.committed,
    "already-observed committed text must never re-scramble",
  );
});

test("streaming decode uses only English letters and binary digits", () => {
  const moving = resolveAccessibility([], NO_ENV);
  const preview = "matrix";
  const frontier = syncLoadingFrontier(EMPTY_FRONTIER, preview, true, false);
  const animation = loadingAnimationSnapshot({
    progress: { phase: "streaming", detail: "", streamPreview: preview },
    prefs: moving,
    frontier,
    frame: 0,
    width: 20,
  });
  assert.equal(animation.renderedId, "matrix-decode");
  assert.match(rowText(animation.rows[0]), /^[A-Za-z01]+$/);
});

test("tool waits never mount a 3D field in the production loading surface", () => {
  const moving = resolveAccessibility([], NO_ENV);
  const progress = { phase: "tool" as const, detail: "git status", streamPreview: "" };

  const animation = loadingAnimationSnapshot({
    progress,
    prefs: moving,
    frontier: EMPTY_FRONTIER,
    frame: 999,
    width: 40,
  });
  assert.equal(animation.job, "none");
  assert.equal(animation.rows.length, 0);
  assert.equal(animation.renderedId, "static-status");
});

test("reduced motion folds the observed preview into one still real-text row", () => {
  const still = resolveAccessibility(["--reduced-motion"], NO_ENV);
  const preview = "real thinking text";
  const frontier = syncLoadingFrontier(EMPTY_FRONTIER, preview, true, true);
  assert.equal(frontier.current, "");
  assert.equal(frontier.committed, preview);

  const animation = loadingAnimationSnapshot({
    progress: { phase: "thinking", detail: "provider:model", streamPreview: preview },
    prefs: still,
    frontier,
    frame: 999,
    width: 40,
  });
  assert.equal(animation.job, "none", "reduced motion selects no animation job");
  assert.equal(animation.rows.length, 1);
  assert.equal(rowText(animation.rows[0]), preview);
});

test("production TUI surfaces do not import or render the 3D engine", () => {
  assert.doesNotMatch(PRODUCTION_ANIMATION_SOURCES, /\bAmbientBackdrop\b/);
  assert.doesNotMatch(PRODUCTION_ANIMATION_SOURCES, /\bmakeLoadAnim\b/);
  assert.doesNotMatch(PRODUCTION_ANIMATION_SOURCES, /\bselectAnim\b/);
});

test("the production loading component has no duplicate detail or animation row", () => {
  const source = readFileSync(new URL("./LoadingIndicator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /model path/);
  assert.doesNotMatch(source, /animation\.rows\.map/);
});

test("assistant tokens remain buffered until the authoritative gated result", () => {
  assert.match(APP_SOURCE, /const visibleReasoningStreamsRef = useRef\(/);
  const tokenHandler = APP_SOURCE.match(
    /if \(t === "token"\) \{[\s\S]*?\n\s*return;\n\s*\}/,
  )?.[0] || "";
  assert.match(
    tokenHandler,
    /assistantBuf\.current \+= chunk;[\s\S]*?setPhase\(\{ phase: "streaming", streamPreview: "" \}\);/,
  );
  assert.doesNotMatch(tokenHandler, /setMessages|\bpush\(|pushStreamGrowth/);
  assert.match(
    APP_SOURCE,
    /if \(t === "final"\) \{[\s\S]*?authoritative completed body[\s\S]*?StreamFloorGuard[\s\S]*?return;/,
  );
  assert.doesNotMatch(APP_SOURCE, /\bstreamDraftIdRef\b/);
});

test("only source-authorized provider-visible thinking is coalesced into React state", () => {
  assert.match(
    APP_SOURCE,
    /if \(t === "thinking"\) \{[\s\S]*?providerReportedReasoningSource[\s\S]*?if \(!source \|\| visibility === "hidden"\) return;/,
  );
  assert.match(
    APP_SOURCE,
    /if \(t === "thinking_token"\) \{[\s\S]*?liveThinkingTokensVisible[\s\S]*?liveThinkingTokenSource[\s\S]*?pushStreamGrowth/,
  );
  assert.match(APP_SOURCE, /providerVisibleReasoningSource/);
  assert.match(
    APP_SOURCE,
    /providerVisibleReasoningCallStarted[\s\S]*?stream\.growth = createStreamGrowth\(\)/,
  );
  assert.match(
    APP_SOURCE,
    /surfaceVisibleReasoning\(liveStream, shown, source\);[\s\S]*?settledProviderReasoningGrowth\(shown, Date\.now\(\)\)/,
  );
  assert.match(
    APP_SOURCE,
    /providerReasoningScope[\s\S]*?new Map<string, VisibleReasoningStreamState>/,
  );
});
