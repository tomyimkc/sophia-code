import test from "node:test";
import assert from "node:assert/strict";
import {
  formatLanesAbandonedMessage,
  formatRuntimeSourceWarning,
  formatSynthesisDetail,
  formatTeamStartMessage,
} from "./teamRouting.js";

test("team_start with SwarmRouter routing names roles and source", () => {
  const text = formatTeamStartMessage({
    type: "team_start",
    team: 2,
    roles: ["search-1", "search-2"],
    workerModel: "claude-sonnet-5",
    routing: {
      mode: "swarm",
      source: "swarm_router",
      rationale: "multi-hop/contested → research",
      nAgents: 3,
    },
  }, { verbose: true });
  assert.match(text, /team · 2 lanes/);
  assert.match(text, /roles: search-1, search-2/);
  assert.match(text, /workers: claude-sonnet-5/);
  assert.match(text, /routed by SwarmRouter/);
  assert.match(text, /multi-hop\/contested/);
});

test("team_start with TEAM_ROLES fallback says forced roles when router solo", () => {
  const text = formatTeamStartMessage({
    team: 2,
    roles: ["implementer", "reviewer"],
    routing: {
      mode: "solo",
      source: "team_roles",
      rationale: "difficulty 0.1 < solo floor 0.34, no hard signal: backbone answers solo",
    },
  }, { verbose: true });
  assert.match(text, /roles: implementer, reviewer/);
  assert.match(text, /forced roles \(router said solo\)/);
  // Rationale is truncated if long — still present in abbreviated form.
  assert.match(text, /difficulty|solo floor/);
});

test("team_start is compact by default", () => {
  const text = formatTeamStartMessage({ team: 3, roles: ["a", "b", "c"] });
  assert.equal(text, "Agents · 3 active");
});

test("team_start only warns about runtime provenance in verbose mode", () => {
  const text = formatTeamStartMessage({
    team: 2,
    roles: ["backend", "frontend"],
    runtimeSourceMatchesWorkspace: false,
  }, { verbose: true });
  assert.match(text, /runtime bundle differs from workspace/);
  assert.match(text, /runtime-source tools/);
  assert.doesNotMatch(
    formatTeamStartMessage({
      team: 2,
      runtimeSourceMatchesWorkspace: false,
    }),
    /runtime|workspace|source/i,
  );
});

test("runtime mismatch warning names the compared anchor and hashes", () => {
  const text = formatRuntimeSourceWarning({
    runtimeSourceMatchesWorkspace: false,
    runtimeSourceAnchor: "agent/code_bridge.py",
    runtimeSourceSha256: "aaaaaaaaaaaa0000",
    workspaceSourceSha256: "bbbbbbbbbbbb1111",
  });
  assert.match(text || "", /agent\/code_bridge\.py/);
  assert.match(text || "", /aaaaaaaaaaaa ≠ workspace bbbbbbbbbbbb/);
  assert.match(text || "", /runtime-source tools/);
  assert.equal(
    formatRuntimeSourceWarning({ runtimeSourceMatchesWorkspace: true }),
    null,
  );
});

test("team_start can suppress a mismatch already shown by run_start", () => {
  const text = formatTeamStartMessage(
    {
      team: 2,
      roles: ["backend", "frontend"],
      runtimeSourceMatchesWorkspace: false,
    },
    { includeRuntimeWarning: false, verbose: true },
  );
  assert.doesNotMatch(text, /runtime bundle differs/);
});

test("lanes_abandoned prefers the kernel detail string", () => {
  const text = formatLanesAbandonedMessage({
    lanes: ["team-lane-1", "team-lane-2"],
    detail: "2 lane(s) did not finish within the drain budget; their output is NOT in the final answer.",
  });
  assert.match(text, /^⚠ /);
  assert.match(text, /NOT in the final answer/);
  assert.match(text, /2 lane/);
});

test("lanes_abandoned without detail still warns", () => {
  const text = formatLanesAbandonedMessage({ lanes: ["team-lane-1"] });
  assert.match(text, /abandoned/);
  assert.match(text, /NOT in the final answer/);
});

test("synthesis detail names the lane count", () => {
  assert.equal(formatSynthesisDetail({ lanes: 3 }), "synthesizing 3 lanes");
  assert.equal(formatSynthesisDetail({}), "synthesizing lanes");
});
