import test from "node:test";
import assert from "node:assert/strict";
import { resolveAccessibility } from "../lib/accessibility.js";
import {
  emptyLaneBudgets,
  resolveTeamDispatchPolicy,
  type TeamLane,
  type TeamLaneState,
} from "../lib/teamLanes.js";
import { displayWidth } from "../lib/textWidth.js";
import {
  laneBudgetSummary,
  laneLifecycleLabel,
  teamDispatchLabel,
  teamLaneBorderStyle,
  teamLaneLine,
  teamLanePanelLayout,
  teamMergeLabel,
} from "./TeamLanePanel.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

function lane(overrides: Partial<TeamLane> = {}): TeamLane {
  return {
    id: "lane-1",
    title: "Inspect local provider and retry behavior",
    role: "reviewer",
    lifecycle: "running",
    control: { cancel: "none", interrupt: "none" },
    budgets: {
      tokens: {
        used: 850,
        limit: 1_000,
        source: "kernel-reported",
        enforcement: "kernel-reported",
      },
      timeMs: {
        used: 12_000,
        limit: 30_000,
        source: "ui-estimate",
        enforcement: "not-reported",
      },
      tools: {
        used: 2,
        limit: 5,
        source: "configured",
        enforcement: "not-reported",
      },
    },
    result: { state: "partial" },
    ...overrides,
  };
}

function state(overrides: Partial<TeamLaneState> = {}): TeamLaneState {
  return {
    storage: "local-only",
    dispatch: resolveTeamDispatchPolicy({ localDefault: "auto" }),
    taskEligible: true,
    lanes: [lane()],
    merge: {
      state: "collecting",
      includedLaneIds: [],
      excludedLaneIds: [],
      conflicts: [],
    },
    selectedLaneId: "lane-1",
    ...overrides,
  };
}

test("panel layout collapses deterministically with terminal width", () => {
  assert.equal(teamLanePanelLayout(100), "wide");
  assert.equal(teamLanePanelLayout(78), "wide");
  assert.equal(teamLanePanelLayout(60), "compact");
  assert.equal(teamLanePanelLayout(46), "compact");
  assert.equal(teamLanePanelLayout(30), "minimal");
});
test("screen-reader mode removes decorative borders", () => {
  assert.equal(
    teamLaneBorderStyle(
      resolveAccessibility(["--ax-screen-reader"], NO_ENV),
    ),
    undefined,
  );
  assert.equal(
    teamLaneBorderStyle(resolveAccessibility([], NO_ENV)),
    "round",
  );
});

test("a cancel request is not mislabeled as a completed cancellation", () => {
  const label = laneLifecycleLabel(
    lane({
      lifecycle: "running",
      control: { cancel: "requested", interrupt: "none" },
    }),
  );
  assert.equal(label, "running; cancel requested");
  assert.ok(!/^cancelled$/.test(label));
});

test("interrupt acknowledgement remains distinct from interrupted", () => {
  const label = laneLifecycleLabel(
    lane({
      lifecycle: "waiting",
      control: { cancel: "none", interrupt: "acknowledged" },
    }),
  );
  assert.equal(label, "waiting; interrupt acknowledged");
  assert.notEqual(label, "interrupted");
});

test("budget summary exposes all three per-lane meters and enforcement evidence", () => {
  const summary = laneBudgetSummary(lane());
  assert.match(summary, /tok 850\/1k~ enforced/);
  assert.match(summary, /time 12s\/30s/);
  assert.match(summary, /tools 2\/5/);
});

test("unknown budgets are honest instead of displaying zero usage", () => {
  const summary = laneBudgetSummary(lane({ budgets: emptyLaneBudgets() }));
  assert.equal(summary, "tok ?/? · time ?/? · tools ?/?");
});

test("legacy policy receipt says eligible rather than claiming a dispatch occurred", () => {
  const label = teamDispatchLabel(state());
  assert.equal(label, "legacy dispatch was eligible · local-default");
  assert.ok(!/started|launched|dispatched/.test(label));
});

test("legacy ask-first receipt preserves its confirmation requirement", () => {
  const label = teamDispatchLabel(
    state({
      dispatch: resolveTeamDispatchPolicy({ publicDefault: "ask-first" }),
    }),
  );
  assert.equal(
    label,
    "legacy dispatch required confirmation · public-default",
  );
});

test("merge conflicts and excluded lanes remain visible", () => {
  const label = teamMergeLabel(
    state({
      merge: {
        state: "conflict",
        includedLaneIds: ["lane-1"],
        excludedLaneIds: ["lane-2"],
        conflicts: [
          {
            id: "conflict-1",
            laneIds: ["lane-1", "lane-2"],
            summary: "Provider recommendations differ",
            state: "open",
          },
        ],
      },
    }),
  );
  assert.equal(
    label,
    "merge conflicts require review · 1 open conflict · 1 excluded lane",
  );
});

test("lane rows fit the requested width even with CJK and long titles", () => {
  const item = lane({
    title: "跨平台终端中的很长执行通道标题 with extra detail",
  });
  for (const width of [18, 30, 60, 100]) {
    const line = teamLaneLine(item, width);
    assert.ok(
      displayWidth(line) <= width,
      `${JSON.stringify(line)} exceeds ${width} columns`,
    );
  }
});

test("agency-agent lanes display the specialist name once without redundancy", () => {
  const line = teamLaneLine(
    lane({
      title: "Frontend Developer (engineering) #1",
      role: "Frontend Developer",
      division: "engineering",
      source: "agency_router",
      skills: ["codebase-design", "tdd-implementation"],
    }),
    120,
    "compact",
  );
  assert.equal(
    line,
    "▶ Frontend Developer (engineering) #1 · running · result:partial",
  );
  assert.equal(line.match(/Frontend Developer/g)?.length, 1);
});
