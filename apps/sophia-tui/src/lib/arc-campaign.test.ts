import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  arcCampaignViewLines,
  arcCommandArgs,
  arcCommandFor,
  arcOperatorCommands,
  arcViewBadges,
  loadArcCampaignPanel,
  parseArcSlashArgs,
  projectArcCampaignJson,
  sanitizeArcText,
} from "./arc-campaign.js";
import { pythonCommandLine, resolvePythonLaunch } from "./pythonResolver.js";

// Expected command text is built from the same resolver the implementation
// uses, so the assertions hold on POSIX (python3) and on Windows (probed
// python / py -3) alike.
const expectedArcCommand = (args: string[]) =>
  pythonCommandLine(resolvePythonLaunch(process.env), args);

test("operator commands target only bounded status and plan JSON entry points", () => {
  assert.deepEqual(arcOperatorCommands(), [
    expectedArcCommand(["-m", "agent.arc_campaign", "status", "--json"]),
    expectedArcCommand(["-m", "agent.arc_campaign", "plan", "--contest", "arc-agi-2", "--json"]),
    expectedArcCommand(["-m", "agent.arc_campaign", "plan", "--contest", "arc-agi-3", "--json"]),
  ]);
  assert.deepEqual(arcCommandArgs({ kind: "status" }), [
    "-m",
    "agent.arc_campaign",
    "status",
    "--json",
  ]);
  assert.equal(
    arcCommandFor({ kind: "plan", contest: "arc-agi-3" }),
    expectedArcCommand(["-m", "agent.arc_campaign", "plan", "--contest", "arc-agi-3", "--json"]),
  );
});

test("slash parser defaults to status, accepts ARC aliases, and refuses operational verbs", () => {
  assert.deepEqual(parseArcSlashArgs(""), {
    action: "query",
    query: { kind: "status" },
  });
  assert.deepEqual(parseArcSlashArgs("plan ARC3"), {
    action: "query",
    query: { kind: "plan", contest: "arc-agi-3" },
  });
  assert.deepEqual(parseArcSlashArgs("copy plan arc2"), {
    action: "copy",
    command: expectedArcCommand(["-m", "agent.arc_campaign", "plan", "--contest", "arc-agi-2", "--json"]),
  });
  for (const unsafe of ["submit", "run", "eval", "public-eval", "stop", "cancel", "kill"]) {
    const intent = parseArcSlashArgs(unsafe);
    assert.equal(intent.action, "invalid");
    assert.match(intent.action === "invalid" ? intent.reason : "", /read-only ARC operator flow/);
  }
});

test("status projection shows ARC2 and ARC3 with explicit candidate/submission badges", () => {
  const views = projectArcCampaignJson(
    {
      contests: {
        arc2: {
          campaignId: "arc2-candidate-a",
          status: "running",
          completedUnits: 3,
          expectedUnits: 10,
          heartbeatAgeSeconds: 4,
          heartbeatSeconds: 10,
          pid: 4242,
          candidateOnly: true,
          submissionGate: { authorized: false, blockers: ["promotion_receipt_missing"] },
        },
        "arc-agi-3": {
          campaign_id: "arc3-sealed",
          state: "prospective",
          completed_pairs: 0,
          expected_pairs: 24,
          heartbeat_age_seconds: 95,
          heartbeat_seconds: 15,
          runner_pid: 78187,
          candidate_only: true,
          submission_gate: { authorized: false },
        },
      },
    },
    { kind: "status" },
    Date.parse("2026-08-12T12:00:00Z"),
  );

  assert.equal(views.length, 2);
  assert.deepEqual(arcViewBadges(views[0]), [
    "CANDIDATE-ONLY",
    "SUBMISSION-GATE: BLOCKED",
  ]);
  assert.equal(views[0].progress.label, "3/10 · 30%");
  assert.equal(views[0].heartbeatState, "fresh");
  assert.equal(views[1].heartbeatState, "stale");
  assert.equal(views[1].stalled, true);
});

test("a live PID is presented as liveness evidence and never converted into success", () => {
  const [view] = projectArcCampaignJson(
    {
      contest: "arc-agi-3",
      state: "running",
      pid: 78187,
      heartbeatAgeSeconds: 2,
      candidateOnly: true,
      submissionGate: { authorized: false },
    },
    { kind: "plan", contest: "arc-agi-3" },
  );
  const text = arcCampaignViewLines(view).join("\n");
  assert.match(text, /PID 78187 observed/);
  assert.match(text, /never success/);
  assert.doesNotMatch(text, /\bsucceeded\b|\bsuccessful\b/i);
});

test("missing candidate policy and caller asserted authorization fail closed", () => {
  const [view] = projectArcCampaignJson(
    {
      contest: "arc-agi-2",
      submissionGate: {
        authorized: true,
        blockers: [],
      },
    },
    { kind: "plan", contest: "arc-agi-2" },
  );

  assert.equal(view.candidatePolicyValid, false);
  assert.equal(view.submissionGate, "blocked");
  assert.deepEqual(arcViewBadges(view), [
    "CANDIDATE POLICY INVALID",
    "SUBMISSION-GATE: BLOCKED",
  ]);
});

test("ready display requires an independently verified authorization receipt", () => {
  const [view] = projectArcCampaignJson(
    {
      contest: "arc-agi-2",
      candidateOnly: true,
      submissionGate: {
        authorized: true,
        authorizationVerified: true,
        blockers: [],
      },
    },
    { kind: "plan", contest: "arc-agi-2" },
  );

  assert.equal(view.candidatePolicyValid, true);
  assert.equal(view.submissionGate, "ready");
});

test("status projection consumes the CLI reported receipt without upgrading PID liveness", () => {
  const [arc2, arc3] = projectArcCampaignJson(
    {
      contests: [
        {
          contest: "arc-agi-2",
          state: "unconfigured",
          candidateOnly: true,
          submissionAuthorized: false,
          successVerified: false,
        },
        {
          contest: "arc-agi-3",
          state: "running",
          candidateOnly: true,
          submissionAuthorized: false,
          successVerified: false,
          reported: {
            progress: { completedPairs: 7, expectedPairs: 24 },
            heartbeatAt: "2026-08-12T11:59:55Z",
            pid: 78187,
          },
        },
      ],
    },
    { kind: "status" },
    Date.parse("2026-08-12T12:00:00Z"),
  );
  assert.equal(arc2.state, "unconfigured");
  assert.equal(arc3.progress.label, "7/24 · 29.2%");
  assert.equal(arc3.heartbeatState, "fresh");
  assert.equal(arc3.pidObserved, true);
  assert.equal(arc3.submissionGate, "blocked");
  assert.match(arcCampaignViewLines(arc3).join("\n"), /liveness evidence only, never success/);
});

test("plan projection keeps gates, bounds, and non-authorizing submission state visible", () => {
  const [view] = projectArcCampaignJson(
    {
      contest: "arc-agi-2",
      campaignId: "arc2-campaign",
      phase: "pilot",
      candidate: {
        candidateId: "candidate-v2",
        hypothesis: "Bounded search may improve exact match.",
        candidateOnly: true,
      },
      computeBudget: {
        maxWallSeconds: 120,
        maxUnitSeconds: 30,
        maxUnits: 4,
        heartbeatSeconds: 5,
      },
      promotionGates: [
        { gateId: "complete", description: "Every frozen unit completed." },
        { gateId: "accuracy", description: "Paired accuracy gate passed." },
      ],
      submissionGate: { blockers: ["promotion_receipt_missing"] },
    },
    { kind: "plan", contest: "arc-agi-2" },
  );
  const lines = arcCampaignViewLines(view);
  assert.match(lines.join("\n"), /wall 120s/);
  assert.match(lines.join("\n"), /PENDING · complete/);
  assert.match(lines.join("\n"), /promotion_receipt_missing/);
  assert.equal(view.submissionGate, "blocked");
});

test("live CLI plan shape is rendered as a bounded dormant specialist DAG", () => {
  const [view] = projectArcCampaignJson(
    {
      campaigns: [
        {
          contest: "arc-agi-3",
          phase: "plan",
          candidateOnly: true,
          submissionAuthorized: false,
          nodes: [
            {
              index: 1,
              id: "mechanics_dsl",
              dependsOn: [],
              executionAuthorized: false,
              role: {
                title: "Mechanics / DSL specialist",
                scope: { maxSteps: 3 },
              },
            },
            {
              index: 2,
              id: "search_planning",
              dependsOn: ["mechanics_dsl"],
              executionAuthorized: false,
              role: {
                title: "Search / planning specialist",
                scope: { maxSteps: 4 },
              },
            },
          ],
        },
      ],
    },
    { kind: "plan", contest: "arc-agi-3" },
  );
  const lines = arcCampaignViewLines(view).join("\n");
  assert.match(lines, /2 bounded steps · 7 aggregate max agent steps/);
  assert.match(lines, /mechanics_dsl .* maxSteps=3 · EXECUTION DISABLED/);
  assert.match(lines, /search_planning .* deps=mechanics_dsl .* EXECUTION DISABLED/);
  assert.doesNotMatch(lines, /EXECUTION AUTHORIZED/);
});

test("CLI diagnostics are redacted before display", async () => {
  assert.equal(
    sanitizeArcText("OPENAI_API_KEY=sk-proj-secret Bearer abc.def.ghi"),
    "OPENAI_API_KEY=[REDACTED] Bearer [REDACTED]",
  );
  const panel = await loadArcCampaignPanel(
    { kind: "status" },
    "/tmp",
    async () => {
      throw new Error("GITHUB_TOKEN=ghp_supersecret123 failed");
    },
  );
  assert.equal(panel.phase, "error");
  assert.doesNotMatch(panel.error, /ghp_supersecret123/);
  assert.match(panel.error, /\[REDACTED\]/);
});

test("TUI catalog and App wire /arc as a local handler without submit/run controls", () => {
  const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
  const catalogPath = fileURLToPath(new URL("./slash-commands.json", import.meta.url));
  const app = readFileSync(appPath, "utf8");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    commands: Array<Record<string, unknown>>;
  };
  const command = catalog.commands.find((row) => row.name === "arc");
  assert.ok(command);
  assert.equal(command.execution_state, "implemented_local");
  assert.match(app, /name === "arc"/);
  assert.match(app, /loadArcCampaignPanel/);
  assert.doesNotMatch(app, /agent\.arc_campaign",\s*"submit"/);
  assert.doesNotMatch(app, /agent\.arc_campaign",\s*"run"/);
});
