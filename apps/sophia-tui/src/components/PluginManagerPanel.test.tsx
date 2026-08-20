import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_PLUGIN_MANAGER_STATE,
  pluginManagerReducer,
  type PluginManagerState,
} from "../lib/plugins.js";
import {
  pluginManagerEntryLine,
  pluginManagerPanelLines,
  resolvePluginManagerKey,
} from "./PluginManagerPanel.js";

function managerState(): PluginManagerState {
  return pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      safeMode: true,
      plugins: [{
        id: "native-review",
        name: "Native Review",
        version: "1.2.3",
        installed: true,
        enabled: true,
        executable: true,
        requiresExplicitApproval: true,
        approved: false,
        locked: true,
        valid: true,
        permissions: ["workflow.propose"],
      }],
      selections: {
        workflow: "native-review/bounded",
      },
      dshCompatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          name: "DSH Search",
          version: "0.4.0",
          installed: false,
          compatible: true,
          approved: true,
          locked: false,
        }],
      },
    },
  });
}

test("plugin manager key resolver owns only documented panel controls", () => {
  assert.equal(resolvePluginManagerKey("", { escape: true }), "close");
  assert.equal(resolvePluginManagerKey("", { tab: true }), "next_tab");
  assert.equal(resolvePluginManagerKey("", { tab: true, shift: true }), "previous_tab");
  assert.equal(resolvePluginManagerKey("", { upArrow: true }), "move_up");
  assert.equal(resolvePluginManagerKey("", { downArrow: true }), "move_down");
  assert.equal(resolvePluginManagerKey("", { return: true }), "inspect");
  assert.equal(resolvePluginManagerKey("R", {}), "reload");
  assert.equal(resolvePluginManagerKey("p", {}), "permissions");
  assert.equal(resolvePluginManagerKey("h", {}), "health");
  assert.equal(resolvePluginManagerKey("x", {}), null);
});

test("panel projection renders four tabs and separate plugin state labels", () => {
  const state = managerState();
  const text = pluginManagerPanelLines(state).join("\n");
  assert.match(text, /\[Discover\]\s+Installed\s+Permissions\s+Health/);
  assert.match(text, /Native Review@1\.2\.3 · local · present · enabled · approval required · locked · selected/);
  assert.match(text, /DSH Search@0\.4\.0 · compat · catalog only · disabled · no approval needed · unlocked/);
  assert.match(text, /catalog presence is not installation/);
  assert.match(text, /No auto-spawn, auto-install, auto-enable, or auto-call/);
});

test("health panel labels structural evidence separately from runtime probes", () => {
  let state = managerState();
  state = pluginManagerReducer(state, { type: "set_tab", tab: "health" });
  let text = pluginManagerPanelLines(state).join("\n");
  assert.match(text, /structural ready · runtime not probed/);
  assert.match(text, /runtime not established · press h to probe explicitly/);

  state = pluginManagerReducer(state, {
    type: "bridge_event",
    event: {
      type: "plugin_progress",
      executionId: "exec-7",
      state: "running",
      completed: 1,
      total: 3,
    },
  });
  text = pluginManagerPanelLines(state).join("\n");
  assert.match(text, /plugin progress · running · 1\/3 · exec-7/);
});

test("permission rows distinguish approval state without implying enablement", () => {
  const seeded = managerState();
  const state = pluginManagerReducer(seeded, {
    type: "set_tab",
    tab: "permissions",
  });
  const selected = state.entries.find((entry) => entry.id === "native-review");
  assert.ok(selected);
  const line = pluginManagerEntryLine(selected, true, "permissions");
  assert.match(line, /approval required/);
  assert.match(line, /requested 1/);
  assert.match(line, /approved 0/);
  assert.doesNotMatch(line, /enabled/);
});
