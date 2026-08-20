import test from "node:test";
import assert from "node:assert/strict";
import {
  contextPressureColor,
  controlStatusRows,
  layoutStatusLine,
  resolveOrchestrationStatus,
  BRAND,
  SEP,
} from "./StatusLine.js";
import { resolveTheme } from "../lib/theme.js";

const BASE = {
  width: 105,
  model: "mock",
  effort: "medium",
  mode: "balanced",
  permission: "manual",
  bridgeReady: true,
  session: "tui-default",
  running: false,
  hasEpistemicChip: false,
};

function renderedWidth(layout: ReturnType<typeof layoutStatusLine>): number {
  // Mirrors exactly what StatusLine.tsx concatenates onto one row: this is
  // the invariant the whole layout function exists to guarantee.
  let s = BRAND;
  s += SEP + layout.model;
  if (layout.effort) s += SEP + layout.effort;
  if (layout.mode) s += SEP + layout.mode;
  s += SEP + layout.bridgeWord;
  if (layout.session) s += SEP + layout.session;
  if (layout.context) s += SEP + layout.context.text;
  if (layout.throughput) s += SEP + layout.throughput;
  if (layout.showRunning) {
    s += SEP + "running…";
    if (layout.showRunningElapsed) s += " (12s)"; // worst-plausible elapsed suffix width
  }
  return [...s].length;
}

test("REGRESSION: the reported 107-column overflow — a long mlx path clips every field mid-word", () => {
  // This is the exact confirmed defect: at contentWidth=105 (107 cols minus
  // the app's paddingX=1 on each side), the un-budgeted row used to run to
  // 109 columns and Ink's hard-clip dropped characters from arbitrary
  // fields ("sophia"->"sophi", "medium"->"mediu", "readonly"->"readonl").
  const layout = layoutStatusLine({
    ...BASE,
    width: 105,
    model: "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit",
    permission: "readonly",
  });
  assert.ok(
    renderedWidth(layout) <= 105,
    `row must fit 105 columns, computed ${renderedWidth(layout)}`,
  );
  // The model is shortened to its basename, not chopped mid-path.
  assert.equal(layout.model, "Qwen3.6-35B-A3B-4bit");
});

test("layoutStatusLine never exceeds the given width across a sweep of realistic terminal sizes", () => {
  const longModel = "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit";
  for (const width of [36, 40, 60, 80, 105, 160, 220]) {
    for (const hasEpistemicChip of [false, true]) {
      const layout = layoutStatusLine({
        ...BASE,
        width,
        model: longModel,
        permission: "readonly",
        running: true,
        hasEpistemicChip,
      });
      assert.ok(
        renderedWidth(layout) <= width,
        `width=${width} hasEpistemicChip=${hasEpistemicChip}: computed ${renderedWidth(layout)}`,
      );
    }
  }
});

test("a short model spec that already fits is shown unshortened", () => {
  const layout = layoutStatusLine({ ...BASE, model: "zai" });
  assert.equal(layout.model, "zai");
});

test("a long mlx path is shown as its basename rather than a mid-string ellipsis, when the basename fits", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 105,
    model: "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit",
  });
  assert.equal(layout.model, "Qwen3.6-35B-A3B-4bit");
  assert.ok(!layout.model.includes("…"), "basename fits without needing an ellipsis");
});

test("on a wide terminal every optional field is shown", () => {
  const layout = layoutStatusLine({ ...BASE, width: 160, running: true });
  assert.equal(layout.effort, "medium");
  assert.equal(layout.mode, "balanced");
  assert.equal(layout.session, "tui-default");
  assert.equal(layout.showRunning, true);
});

test("an explicitly embedded layout can omit brand and session without reserving their width", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 60,
    model: "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit",
    showBrand: false,
    showSession: false,
  });
  assert.equal(layout.session, null);
  assert.ok(layout.model.length > 0);
  assert.ok(layout.bridgeWord.length > 0);
});

test("the operator-facing brand is the requested My Sophia Code wording", () => {
  assert.equal(BRAND, "My Sophia Code");
});

test("on a narrow terminal, effort/mode/running are dropped before bridge/model", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 40,
    model: "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit",
    running: true,
  });
  assert.equal(layout.bridgeWord, "bridge", "bridge connectivity is never dropped");
  assert.ok(layout.model.length > 0, "model identity is shortened, never blanked");
});

test("controlStatusRows labels permission and exposes AGI, A2A, and Workflow in words", () => {
  const rows = controlStatusRows({
    width: 120,
    permission: "auto",
    agiEnabled: false,
    a2aMode: "parallel",
    workflowMode: "off",
  });
  assert.deepEqual(
    rows.flat().map((chip) => `${chip.label}: ${chip.value}`),
    [
      "Permission: auto",
      "AGI: off",
      "A2A: parallel",
      "Workflow: off",
    ],
  );
});

test("controlStatusRows wraps rather than dropping controls on a narrow terminal", () => {
  const width = 38;
  const rows = controlStatusRows({
    width,
    permission: "readonly",
    agiEnabled: true,
    a2aMode: "serial",
    workflowMode: "off",
  });
  assert.ok(rows.length > 1, "narrow layouts should wrap");
  assert.deepEqual(
    rows.flat().map((chip) => chip.label),
    ["Permission", "AGI", "A2A", "Workflow"],
  );
  for (const row of rows) {
    const text = row.map((chip) => `${chip.label}: ${chip.value}`).join(SEP);
    assert.ok([...text].length <= width, `control row must fit ${width} columns: ${text}`);
  }
});

test("resolveOrchestrationStatus distinguishes serial from parallel A2A routing", () => {
  assert.deepEqual(
    resolveOrchestrationStatus({
      executionRuntime: "sophia",
      agiMode: false,
      a2aAgents: -1,
    }),
    {
      agiEnabled: false,
      a2aMode: "serial",
      workflowMode: "off",
    },
  );
  assert.deepEqual(
    resolveOrchestrationStatus({
      executionRuntime: "sophia",
      agiMode: false,
      a2aAgents: -1,
      a2aConcurrency: 2,
    }),
    {
      agiEnabled: false,
      a2aMode: "parallel",
      workflowMode: "off",
    },
  );
});

test("resolveOrchestrationStatus gives active workflow ownership of parallel A2A", () => {
  assert.deepEqual(
    resolveOrchestrationStatus({
      executionRuntime: "sophia",
      agiMode: false,
      a2aAgents: -1,
      workflowMode: "auto",
      workflowActive: true,
    }),
    {
      agiEnabled: false,
      a2aMode: "parallel",
      workflowMode: "active",
    },
  );
});

test("resolveOrchestrationStatus shows A2A suspended under AGI or Prime", () => {
  assert.deepEqual(
    resolveOrchestrationStatus({
      executionRuntime: "sophia",
      agiMode: true,
      a2aAgents: -1,
    }),
    {
      agiEnabled: true,
      a2aMode: "off",
      workflowMode: "off",
    },
  );
  assert.deepEqual(
    resolveOrchestrationStatus({
      executionRuntime: "prime",
      agiMode: true,
      a2aAgents: -1,
    }),
    {
      agiEnabled: false,
      a2aMode: "off",
      workflowMode: "off",
    },
  );
});

test("running without elapsed still shows the badge when there is no room for the elapsed suffix", () => {
  // Wide enough for "running…" but not for a further " (12s)"-shaped suffix.
  const layout = layoutStatusLine({
    ...BASE,
    width: 75,
    model: "mock",
    session: "tui-default",
    running: true,
  });
  assert.equal(layout.showRunning, true);
  assert.equal(layout.showRunningElapsed, false);
});

test("an unusually long epistemic label reserves budget so the row still fits", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 60,
    model: "mock",
    hasEpistemicChip: true,
  });
  assert.ok(renderedWidth(layout) <= 60);
});

test("a critical context reading survives width pressure that already drops mode/effort/running", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 69,
    model: "mock",
    running: true,
    contextUsage: { used: 95, window: 100 },
  });
  assert.ok(layout.context, "a critical reading must still render");
  assert.equal(layout.context?.level, "critical");
  assert.match(layout.context?.text ?? "", /critical/);
  assert.equal(layout.mode, null, "mode must yield to a critical context reading");
  assert.equal(layout.effort, null, "effort must yield to a critical context reading");
  assert.equal(layout.showRunning, false, "the running badge must yield to a critical context reading");
  assert.ok(renderedWidth(layout) <= 69, `computed ${renderedWidth(layout)}`);
});

test("a non-critical context reading is dropped before session, mode, or effort when width is tight", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 60,
    model: "mock",
    contextUsage: { used: 75, window: 100 },
  });
  assert.equal(layout.session, "tui-default", "session outranks a merely-warn reading");
  assert.equal(layout.mode, "balanced", "mode outranks a merely-warn reading");
  assert.equal(layout.context, null, "a warn (not critical) reading yields to session/mode");
  assert.ok(renderedWidth(layout) <= 60, `computed ${renderedWidth(layout)}`);
});

test("an unknown context window says so in words, never a fabricated percentage", () => {
  const layout = layoutStatusLine({
    ...BASE,
    width: 120,
    contextUsage: { used: 500, window: null },
  });
  assert.equal(layout.context?.level, "unknown");
  assert.equal(layout.context?.text, "context: unknown window");
  assert.ok(!/%/.test(layout.context?.text ?? "%"), "no percentage is fabricated for an unknown window");
});

test("the throughput chip renders when there is room, and is the first field dropped under width pressure", () => {
  const wide = layoutStatusLine({
    ...BASE,
    width: 160,
    running: true,
    throughput: { tokensPerSec: 42, ttftMs: 180 },
  });
  assert.ok(wide.throughput);
  assert.match(wide.throughput ?? "", /tok\/s/);
  assert.ok(renderedWidth(wide) <= 160, `computed ${renderedWidth(wide)}`);

  // Same narrow scenario as the "effort/mode/running are dropped" test above:
  // a requested throughput chip must also be absent there — it is strictly
  // lower priority than fields this row already drops first.
  const narrow = layoutStatusLine({
    ...BASE,
    width: 40,
    model: "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit",
    running: true,
    throughput: { tokensPerSec: 42, ttftMs: 180 },
  });
  assert.equal(narrow.throughput, null);
});

test("layoutStatusLine never exceeds width with both a critical context reading and a throughput sample requested", () => {
  const longModel = "mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit";
  for (const width of [36, 40, 60, 80, 105, 160, 220]) {
    for (const hasEpistemicChip of [false, true]) {
      const layout = layoutStatusLine({
        ...BASE,
        width,
        model: longModel,
        permission: "readonly",
        running: true,
        hasEpistemicChip,
        contextUsage: { used: 95, window: 100 },
        throughput: { tokensPerSec: 6.4, ttftMs: 2200 },
      });
      assert.ok(
        renderedWidth(layout) <= width,
        `width=${width} hasEpistemicChip=${hasEpistemicChip}: computed ${renderedWidth(layout)}`,
      );
    }
  }
});

test("contextPressureColor maps level to theme role, never inventing a colour the theme lacks", () => {
  const theme = resolveTheme("dark", {});
  assert.equal(contextPressureColor("critical", theme), theme.error);
  assert.equal(contextPressureColor("warn", theme), theme.warn);
  assert.equal(contextPressureColor("ok", theme), theme.dim);
  assert.equal(contextPressureColor("unknown", theme), theme.dim);
});
