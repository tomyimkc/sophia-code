import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  explicitSettingKeys,
  initialPromptCanStart,
  missingCliFlagValue,
  operatorOwnedSettingsPatch,
  permissionFromBridge,
  readySettingValue,
  reconcileWorkflowRoutingModes,
  selectedStartupPluginProfile,
  settingIsOwned,
  settingsPatchMatchesSnapshot,
  withOwnedSetting,
} from "./cliSettings.js";

test("the bridge says 'approve'; the UI calls it 'manual' — that must map", () => {
  // _normalize_permission canonicalises ""/manual/approve -> "approve", so the
  // bridge NEVER emits "manual". Guards testing for "manual" therefore never
  // matched and the persisted permission was silently ignored.
  assert.equal(permissionFromBridge("approve"), "manual");
  assert.equal(permissionFromBridge("manual"), "manual");
  assert.equal(permissionFromBridge("auto"), "auto");
  assert.equal(permissionFromBridge("readonly"), "readonly");
});

test("an unrecognised permission leaves the current setting alone", () => {
  assert.equal(permissionFromBridge("surprise"), null);
  assert.equal(permissionFromBridge(undefined), null);
  assert.equal(permissionFromBridge(""), null);
});

const NO_ENV = {} as NodeJS.ProcessEnv;

test("a bare launch establishes nothing — the persisted snapshot may fill it in", () => {
  assert.deepEqual([...explicitSettingKeys([], NO_ENV)], []);
});

test("a flag the user typed is explicit, in both --x v and --x=v spellings", () => {
  assert.ok(explicitSettingKeys(["--model", "grok"], NO_ENV).has("model"));
  assert.ok(explicitSettingKeys(["--model=grok"], NO_ENV).has("model"));
  assert.ok(explicitSettingKeys(["-m", "grok"], NO_ENV).has("model"));
  assert.ok(explicitSettingKeys(["--mode", "precise"], NO_ENV).has("mode"));
  assert.ok(explicitSettingKeys(["--permission", "auto"], NO_ENV).has("permission"));
  assert.ok(explicitSettingKeys(["-p", "auto"], NO_ENV).has("permission"));
  assert.ok(
    explicitSettingKeys(["--thinking", "stream"], NO_ENV).has("thinkingVisibility"),
  );
});

test("a DEFAULTED flag value is not a choice — only argv can say", () => {
  // The exact shape of the bug: --model is declared with a default, so the
  // parsed flag is always truthy. Asking the parsed flags "was it set?" always
  // answers yes, which is why the ready snapshot was allowed to overwrite it.
  const parsedFlags = { model: "mock", mode: "balanced", permission: "manual" };
  assert.equal(parsedFlags.model.length > 0, true, "value is truthy...");
  assert.deepEqual([...explicitSettingKeys([], NO_ENV)], [], "...but nothing was chosen");
});

test("--mock counts as choosing the model (it forces mock over --model)", () => {
  assert.ok(explicitSettingKeys(["--mock"], NO_ENV).has("model"));
});

test("the env vars index.tsx seeds the model from also count as a choice", () => {
  assert.ok(explicitSettingKeys([], { SOPHIA_MODEL: "grok" } as NodeJS.ProcessEnv).has("model"));
  assert.ok(
    explicitSettingKeys([], { SOPHIA_MODEL_PROVIDER: "grok" } as NodeJS.ProcessEnv).has("model"),
  );
  // Empty/whitespace is not a choice.
  assert.equal(
    explicitSettingKeys([], { SOPHIA_MODEL: "  " } as NodeJS.ProcessEnv).has("model"),
    false,
  );
});

test("workflow ownership exists only for an explicit flag or environment value", () => {
  assert.equal(explicitSettingKeys([], NO_ENV).has("workflowMode"), false);
  assert.equal(
    explicitSettingKeys(["--workflow", "off"], NO_ENV).has("workflowMode"),
    true,
  );
  assert.equal(
    explicitSettingKeys([], {
      SOPHIA_WORKFLOW_MODE: "auto",
    } as NodeJS.ProcessEnv).has("workflowMode"),
    true,
  );
});

test("conscience ownership exists only for an explicit flag or environment value", () => {
  assert.equal(explicitSettingKeys([], NO_ENV).has("conscienceMode"), false);
  assert.equal(
    explicitSettingKeys(["--conscience", "off"], NO_ENV).has("conscienceMode"),
    true,
  );
  assert.equal(
    explicitSettingKeys([], {
      SOPHIA_CONSCIENCE_MODE: "report",
    } as NodeJS.ProcessEnv).has("conscienceMode"),
    true,
  );
});

test("an explicit workflow launch outranks a stale AGI-workflow snapshot", () => {
  assert.deepEqual(
    reconcileWorkflowRoutingModes({
      currentWorkflow: "on",
      currentAgiWorkflow: "off",
      snapshotWorkflow: "auto",
      snapshotAgiWorkflow: "on",
      workflowOwned: true,
      agiWorkflowOwned: false,
    }),
    {
      workflowMode: "on",
      agiWorkflowMode: "off",
    },
  );
});

test("an explicitly owned AGI workflow remains the more specific route", () => {
  assert.deepEqual(
    reconcileWorkflowRoutingModes({
      currentWorkflow: "on",
      currentAgiWorkflow: "auto",
      snapshotWorkflow: "on",
      snapshotAgiWorkflow: "off",
      workflowOwned: true,
      agiWorkflowOwned: true,
    }),
    {
      workflowMode: "off",
      agiWorkflowMode: "auto",
    },
  );
});

test("when neither route is owned persisted AGI workflow retains precedence", () => {
  assert.deepEqual(
    reconcileWorkflowRoutingModes({
      currentWorkflow: "off",
      currentAgiWorkflow: "off",
      snapshotWorkflow: "on",
      snapshotAgiWorkflow: "auto",
      workflowOwned: false,
      agiWorkflowOwned: false,
    }),
    {
      workflowMode: "off",
      agiWorkflowMode: "auto",
    },
  );
});

test("index leaves an omitted workflow mode to the backend default", () => {
  const indexPath = fileURLToPath(new URL("../index.tsx", import.meta.url));
  const source = readFileSync(indexPath, "utf8");
  const flagStart = source.indexOf("workflow: {");
  const nextFlag = source.indexOf("workflowMaxStages:", flagStart);
  assert.ok(flagStart >= 0 && nextFlag > flagStart);
  const workflowFlag = source.slice(flagStart, nextFlag);
  assert.doesNotMatch(
    workflowFlag,
    /default\s*:/,
    "an omitted --workflow must not be converted to off in the CLI parser",
  );
  assert.match(
    source,
    /const workflowRaw\s*=\s*cli\.flags\.workflow \?\? process\.env\.SOPHIA_WORKFLOW_MODE/,
  );
  assert.match(
    source,
    /workflowMode as "off" \| "auto" \| "on" \| undefined/,
  );
});

test("one flag does not make the others explicit", () => {
  const keys = explicitSettingKeys(["--model", "grok"], NO_ENV);
  assert.deepEqual([...keys], ["model"]);
});

test("workflow limit flags own only the limits the operator explicitly supplied", () => {
  const stagesOnly = explicitSettingKeys(
    ["--workflow", "on", "--workflow-max-stages", "3", "audit"],
    NO_ENV,
  );
  assert.equal(stagesOnly.has("workflowMode"), true);
  assert.equal(stagesOnly.has("workflowMaxStages"), true);
  assert.equal(stagesOnly.has("workflowMaxAgents"), false);

  const both = explicitSettingKeys(
    ["--workflow-max-stages=4", "--workflow-max-agents=8", "audit"],
    NO_ENV,
  );
  assert.equal(both.has("workflowMaxStages"), true);
  assert.equal(both.has("workflowMaxAgents"), true);
});

test("startup profile reassertion contains only profile-overlapping operator-owned settings", () => {
  const patch = operatorOwnedSettingsPatch(
    {
      workflowMode: "on",
      workflowMaxStages: 4,
      workflowMaxAgents: 8,
      responseStyle: "concise",
      agiMode: false,
    },
    new Set(["workflowMode", "workflowMaxStages", "workflowMaxAgents"]),
    new Set(["responseStyle"]),
  );
  assert.deepEqual(patch, {
    workflowMode: "on",
    workflowMaxStages: 4,
    workflowMaxAgents: 8,
    responseStyle: "concise",
  });
});

test("plugin routing proposals cannot overwrite operator-owned team and A2A settings", () => {
  const patch = operatorOwnedSettingsPatch(
    {
      a2aAgents: -1,
      a2aExecution: "terminal",
      terminalLayout: "auto",
      autoTeam: false,
      team: 1,
      deepMode: false,
    },
    new Set(["team"]),
    new Set([
      "a2aAgents",
      "a2aExecution",
      "terminalLayout",
      "autoTeam",
      "deepMode",
    ]),
  );
  assert.deepEqual(patch, {
    a2aAgents: -1,
    a2aExecution: "terminal",
    terminalLayout: "auto",
    autoTeam: false,
    team: 1,
    deepMode: false,
  });
});

test("startup profile reassertion does not persist unrelated owned settings", () => {
  const patch = operatorOwnedSettingsPatch(
    {
      workflowMode: "on",
      workflowMaxStages: undefined,
    },
    new Set(["model", "workflowMode", "workflowMaxStages"]),
    new Set(),
  );
  assert.deepEqual(patch, { workflowMode: "on" });
});

test("startup profile gate opens only after the durable snapshot matches the reassertion", () => {
  const patch = {
    workflowMode: "on",
    workflowMaxStages: 4,
    workflowMaxAgents: 8,
    responseStyle: "concise",
  };
  assert.equal(settingsPatchMatchesSnapshot(patch, null), false);
  assert.equal(settingsPatchMatchesSnapshot(patch, {
    workflowMode: "auto",
    workflowMaxStages: 4,
    workflowMaxAgents: 8,
    responseStyle: "concise",
  }), false);
  assert.equal(settingsPatchMatchesSnapshot(patch, {
    model: "grok",
    workflowMode: "on",
    workflowMaxStages: 4,
    workflowMaxAgents: 8,
    responseStyle: "concise",
  }), true);
});

test("startup discovers the selected plugin profile without trusting profile settings", () => {
  assert.equal(selectedStartupPluginProfile({
    selections: { profile: "sophia-review-pack/production-beta" },
  }), "sophia-review-pack/production-beta");
  assert.equal(selectedStartupPluginProfile({ selections: { profile: "  " } }), null);
  assert.equal(selectedStartupPluginProfile({ selections: [] }), null);
  assert.equal(selectedStartupPluginProfile(null), null);
});

test("an initial prompt waits for ready, session hydration, and the profile settings ack", () => {
  const base = {
    initialPrompt: "audit the beta",
    bridgeReady: true,
    sessionHydrated: true,
    startupProfileApplied: false,
    alreadySent: false,
  };
  assert.equal(initialPromptCanStart(base), false);
  assert.equal(initialPromptCanStart({ ...base, startupProfileApplied: true }), true);
  assert.equal(
    initialPromptCanStart({ ...base, startupProfileApplied: true, alreadySent: true }),
    false,
  );
  assert.equal(
    initialPromptCanStart({ ...base, startupProfileApplied: true, bridgeReady: false }),
    false,
  );
  assert.equal(
    initialPromptCanStart({ ...base, startupProfileApplied: true, sessionHydrated: false }),
    false,
  );
});

test("responseStyle participates in shared setting ownership", () => {
  const explicit = new Set(["model"] as const);
  const changed = withOwnedSetting(new Set(), "responseStyle");
  assert.equal(settingIsOwned("responseStyle", explicit, changed), true);
  assert.equal(settingIsOwned("mode", explicit, changed), false);
  assert.deepEqual([...changed], ["responseStyle"]);
});

test("conscienceMode participates in shared setting ownership", () => {
  const changed = withOwnedSetting(new Set(), "conscienceMode");
  assert.equal(settingIsOwned("conscienceMode", new Set(), changed), true);
  assert.deepEqual([...changed], ["conscienceMode"]);
});

test("ownership helper is immutable so React refs can replace snapshots safely", () => {
  const before = new Set(["effort"] as const);
  const after = withOwnedSetting(before, "responseStyle");
  assert.notEqual(after, before);
  assert.deepEqual([...before], ["effort"]);
  assert.deepEqual([...after], ["effort", "responseStyle"]);
});

test("an owned response style survives a later ready snapshot", () => {
  assert.equal(readySettingValue(true, "concise", "adaptive"), "concise");
  assert.equal(readySettingValue(false, "adaptive", "structured"), "structured");
});

test("a flag named as a VALUE is not a flag", () => {
  // `--prompt "--model"` must not read as choosing the model.
  assert.equal(explicitSettingKeys(["--mode", "--model"], NO_ENV).has("model"), false);
});

test("a dangling value flag fails closed instead of falling back to its default", () => {
  assert.equal(missingCliFlagValue(["--model", "grok", "--permission"]), "--permission");
  assert.equal(
    missingCliFlagValue(["--permission", "--workflow", "auto"]),
    "--permission",
  );
  assert.equal(missingCliFlagValue(["--permission=readonly"]), null);
  assert.equal(missingCliFlagValue(["--permission", "readonly"]), null);
  assert.equal(missingCliFlagValue(["-m"]), "-m");
  assert.equal(missingCliFlagValue(["--finished-out"]), "--finished-out");
  assert.equal(missingCliFlagValue(["--conscience"]), "--conscience");
  assert.equal(missingCliFlagValue(["--thinking"]), "--thinking");
});
