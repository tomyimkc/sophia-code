import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INITIAL_PLUGIN_MANAGER_STATE,
  formatPluginResult,
  normalizePluginSettingsPatch,
  parsePluginSlash,
  pluginManagerActivityLine,
  pluginManagerReducer,
  selectedPluginManagerEntry,
} from "./plugins.js";
import { resolve } from "./slash.js";

test("plugin confirmations keep sandbox authority conditional", () => {
  const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /Executable contributions run under your OS-user authority and are not OS-sandboxed/,
  );
  assert.doesNotMatch(source, /this is not an OS-level sandbox/);
  assert.doesNotMatch(
    source,
    /read-only request is not an OS-level sandbox/,
  );
  assert.equal(
    source.match(
      /required mode (?:still )?fails closed, while mode off or optional fallback may run under your OS-user authority/g,
    )?.length,
    3,
  );
});

test("parsePluginSlash keeps executable approval explicit", () => {
  assert.deepEqual(parsePluginSlash("enable deepseek-harness"), {
    ok: true,
    command: {
      action: "enable",
      pluginId: "deepseek-harness",
      approvePermissions: false,
    },
  });
  assert.deepEqual(parsePluginSlash("enable deepseek-harness --approve"), {
    ok: true,
    command: {
      action: "enable",
      pluginId: "deepseek-harness",
      approvePermissions: true,
    },
  });
});

test("parsePluginSlash keeps plugin-use leases bounded and approval explicit", () => {
  assert.deepEqual(
    parsePluginSlash("use sophia-review-pack/production-beta"),
    {
      ok: true,
      command: {
        action: "use",
        reference: "sophia-review-pack/production-beta",
        lease: "task",
        approvePermissions: false,
      },
    },
  );
  assert.deepEqual(
    parsePluginSlash("use deepseek-harness/headless --session --approve challenge-123"),
    {
      ok: true,
      command: {
        action: "use",
        reference: "deepseek-harness/headless",
        lease: "session",
        approvePermissions: true,
        approvalToken: "challenge-123",
      },
    },
  );
  assert.deepEqual(
    parsePluginSlash("use dynamic/adaptive --approve-settings proposal-456"),
    {
      ok: true,
      command: {
        action: "use",
        reference: "dynamic/adaptive",
        lease: "task",
        approvePermissions: false,
        approveSettings: true,
        approvalToken: "proposal-456",
      },
    },
  );
  assert.deepEqual(parsePluginSlash("use off"), {
    ok: true,
    command: {
      action: "use",
      reference: "off",
    },
  });
  assert.equal(
    parsePluginSlash("use pack/profile --task --session").ok,
    false,
  );
  assert.equal(
    parsePluginSlash("use off --approve").ok,
    false,
  );
  assert.equal(
    parsePluginSlash("use pack/profile --approve").ok,
    false,
  );
  assert.equal(
    parsePluginSlash("use pack/profile --approve one --approve-settings two").ok,
    false,
  );
});

test("parsePluginSlash supports profile, runtime, and safe mode actions", () => {
  assert.equal(
    parsePluginSlash("profile use sophia-review-pack/production-beta").command?.action,
    "profile_use",
  );
  assert.equal(
    parsePluginSlash("workflow use sophia-review-pack/bounded-review").command?.action,
    "workflow_use",
  );
  assert.equal(parsePluginSlash("runtime status").command?.action, "runtime_status");
  assert.deepEqual(parsePluginSlash("safe-mode on").command, {
    action: "safe_mode",
    enabled: true,
  });
  assert.deepEqual(parsePluginSlash("safe-mode off").command, {
    action: "safe_mode",
    enabled: false,
  });
  assert.equal(parsePluginSlash("", "reload-plugins").command?.action, "reload");
  assert.deepEqual(parsePluginSlash("lock export ./plugins.lock").command, {
    action: "lock_export",
    path: "./plugins.lock",
  });
  assert.deepEqual(parsePluginSlash("lock import ./plugins.lock").command, {
    action: "lock_import",
    path: "./plugins.lock",
  });
  assert.deepEqual(
    parsePluginSlash('lock export "/tmp/plugin locks/release.lock.json"').command,
    {
      action: "lock_export",
      path: "/tmp/plugin locks/release.lock.json",
    },
  );
  assert.deepEqual(
    parsePluginSlash("lock import '/tmp/plugin locks/release.lock.json'").command,
    {
      action: "lock_import",
      path: "/tmp/plugin locks/release.lock.json",
    },
  );
  assert.equal(parsePluginSlash('lock import "/tmp/unterminated').ok, false);
});

test("/plugins is an exact alias for /plugin parsing", () => {
  assert.equal(resolve("/plugins").name, "plugin");
  assert.equal(resolve("/plugins").cmd?.name, "plugin");
  assert.deepEqual(
    parsePluginSlash("", "plugins"),
    parsePluginSlash("", "plugin"),
  );
  assert.deepEqual(
    parsePluginSlash("compat inspect dsh-pack", "plugins"),
    parsePluginSlash("compat inspect dsh-pack", "plugin"),
  );
});

test("parsePluginSlash supports the exact DSH compatibility command surface", () => {
  assert.deepEqual(parsePluginSlash("compat list").command, {
    action: "compat_list",
  });
  assert.deepEqual(parsePluginSlash("compat discover ./plugin").command, {
    action: "compat_discover",
    source: "./plugin",
  });
  assert.deepEqual(parsePluginSlash("compat install github:owner/plugin").command, {
    action: "compat_install",
    source: "github:owner/plugin",
    approveInstall: false,
  });
  assert.deepEqual(parsePluginSlash("compat install github:owner/plugin --approve").command, {
    action: "compat_install",
    source: "github:owner/plugin",
    approveInstall: true,
  });
  assert.deepEqual(parsePluginSlash("compat uninstall dsh-pack").command, {
    action: "compat_uninstall",
    compatibilityId: "dsh-pack",
  });
  assert.deepEqual(parsePluginSlash("compat rollback dsh-pack").command, {
    action: "compat_rollback",
    compatibilityId: "dsh-pack",
  });
  assert.deepEqual(parsePluginSlash("compat transactions").command, {
    action: "compat_transactions",
  });
  assert.deepEqual(parsePluginSlash("compat inspect dsh-pack").command, {
    action: "compat_inspect",
    compatibilityId: "dsh-pack",
  });
  assert.deepEqual(parsePluginSlash("compat test dsh-pack").command, {
    action: "compat_test",
    compatibilityId: "dsh-pack",
  });
  assert.deepEqual(parsePluginSlash("compat health").command, {
    action: "compat_health",
  });
  assert.deepEqual(parsePluginSlash("compat health dsh-pack").command, {
    action: "compat_health",
    compatibilityId: "dsh-pack",
  });
  assert.deepEqual(parsePluginSlash("compat tools dsh-pack").command, {
    action: "compat_tool_list",
    compatibilityId: "dsh-pack",
  });
  assert.deepEqual(
    parsePluginSlash("compat skills @tt-a1i/archify-dsh").command,
    {
      action: "compat_skill_list",
      compatibilityId: "@tt-a1i/archify-dsh",
    },
  );
  assert.deepEqual(
    parsePluginSlash("compat skill use @tt-a1i/archify-dsh archify").command,
    {
      action: "compat_skill_use",
      compatibilityId: "@tt-a1i/archify-dsh",
      reference: "archify",
    },
  );
  assert.deepEqual(parsePluginSlash("compat skill off").command, {
    action: "compat_skill_use",
    reference: "off",
  });
  assert.deepEqual(
    parsePluginSlash('compat call dsh-pack/search {"query":"safe","limit":3}').command,
    {
      action: "compat_tool_call",
      compatibilityId: "dsh-pack",
      tool: "search",
      input: { query: "safe", limit: 3 },
    },
  );
});

test("parsePluginSlash supports governed catalog status, search, inspect, and select", () => {
  assert.deepEqual(parsePluginSlash("catalog status").command, {
    action: "catalog_status",
  });
  assert.deepEqual(
    parsePluginSlash(
      "catalog search review tools --contribution skills --capability review.code "
      + "--protocol sophia.plugin/v1 --host-protocol sophia.plugin/v1 "
      + "--platform darwin --architecture arm64 --eligible-only",
    ).command,
    {
      action: "catalog_search",
      query: "review tools",
      contribution: ["skills"],
      capability: ["review.code"],
      protocol: ["sophia.plugin/v1"],
      hostProtocols: ["sophia.plugin/v1"],
      platform: "darwin",
      architecture: "arm64",
      eligibleOnly: true,
    },
  );
  assert.deepEqual(
    parsePluginSlash(
      "catalog inspect reviewer --host-protocol sophia.plugin/v1 "
      + "--platform darwin --architecture arm64",
    ).command,
    {
      action: "catalog_inspect",
      pluginId: "reviewer",
      hostProtocols: ["sophia.plugin/v1"],
      platform: "darwin",
      architecture: "arm64",
    },
  );
  assert.deepEqual(
    parsePluginSlash(
      "catalog select reviewer --version 1.2.3 "
      + "--protocol sophia.plugin/v1 --host-protocol sophia.plugin/v1 "
      + "--allow-stale --allow-prerelease",
    ).command,
    {
      action: "catalog_select",
      pluginId: "reviewer",
      version: "1.2.3",
      protocol: ["sophia.plugin/v1"],
      hostProtocols: ["sophia.plugin/v1"],
      allowStale: true,
      allowPrerelease: true,
    },
  );
});

test("catalog parser rejects unknown, duplicated, or action-incompatible flags", () => {
  assert.equal(parsePluginSlash("catalog").ok, false);
  assert.equal(parsePluginSlash("catalog status extra").ok, false);
  assert.equal(parsePluginSlash("catalog inspect").ok, false);
  assert.equal(parsePluginSlash("catalog select reviewer --eligible-only").ok, false);
  assert.equal(
    parsePluginSlash("catalog select reviewer --version 1.0.0 --version 2.0.0").ok,
    false,
  );
  assert.equal(parsePluginSlash("catalog search q --unknown value").ok, false);
});

test("compat parser rejects ambiguous flags, invalid namespaced tools, and non-object JSON", () => {
  assert.equal(parsePluginSlash("compat install x --force").ok, false);
  assert.equal(parsePluginSlash("compat call missing-slash {}").ok, false);
  assert.equal(parsePluginSlash("compat call p/t []").ok, false);
  assert.equal(parsePluginSlash("compat call p/t {bad").ok, false);
  assert.equal(parsePluginSlash("compat discover").ok, false);
  assert.equal(parsePluginSlash("compat skill use archify").ok, false);
  assert.equal(parsePluginSlash("compat skill off extra").ok, false);
});

test("normalizePluginSettingsPatch strips unknown and malformed fields", () => {
  assert.deepEqual(normalizePluginSettingsPatch({
    workflowMode: "auto",
    workflowMaxStages: 4,
    autoTeam: false,
    gateBypass: true,
    team: "8",
  }), {
    workflowMode: "auto",
    workflowMaxStages: 4,
  });
});

test("formatPluginResult names the authority boundary", () => {
  const text = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "list",
    safeMode: false,
    plugins: [],
    selections: {},
    lockPath: "/tmp/plugins.lock",
  });
  assert.match(text, /Sophia validates, authorizes, executes, records, and gates/);
});

test("lock import/export results render bounded path, count, and match state", () => {
  const exported = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "lock_export",
    lock: {
      path: `/tmp/${"x".repeat(700)}`,
      pluginCount: 4,
    },
  });
  assert.match(exported, /Plugin lock export complete/);
  assert.match(exported, /plugins: 4/);
  assert.ok(exported.length < 700);
  assert.doesNotMatch(exported, /safe mode: off/);

  const imported = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "lock_import",
    lock: {
      path: "/tmp/release.lock.json",
      count: 4,
      match: true,
      authorityImported: false,
    },
  });
  assert.match(imported, /plugins: 4/);
  assert.match(imported, /match: yes/);
  assert.match(imported, /authority imported: no/);
});

test("compat transaction results render bounded pending and rollback state", () => {
  const text = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "compat_transactions",
    transactions: {
      history: [
        {
          operationId: "a".repeat(32),
          pluginId: "@fixture/one",
          action: "update",
          status: "pending",
        },
        {
          operationId: "b".repeat(32),
          pluginId: "@fixture/two",
          action: "rollback",
          status: "rolled-back",
          error: "recovered after crash",
        },
        ...Array.from({ length: 80 }, (_, index) => ({
          operationId: String(index).padStart(32, "0"),
          pluginId: `fixture-${index}`,
          action: "install",
          status: "committed",
        })),
      ],
      rollbackAvailable: ["@fixture/one", "@fixture/two"],
    },
  });
  assert.match(text, /pending: 1/);
  assert.match(text, /rollback available: @fixture\/one, @fixture\/two/);
  assert.match(text, /rolled back/);
  assert.ok(text.length < 5000);
  assert.doesNotMatch(text, /safe mode: off/);
});

test("plugin result reducer never infers safe mode off when omitted", () => {
  const state = pluginManagerReducer(
    { ...INITIAL_PLUGIN_MANAGER_STATE, safeMode: true },
    {
      type: "bridge_event",
      event: {
        type: "plugin_result",
        ok: true,
        action: "lock_export",
        lock: { path: "/tmp/plugins.lock", pluginCount: 0 },
      },
    },
  );
  assert.equal(state.safeMode, true);
});

test("formatPluginResult renders bounded governed catalog responses", () => {
  const status = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "catalog_status",
    catalog: {
      catalogId: "local-governed",
      sequence: 8,
      cacheStatus: "fresh",
      evaluatedAt: "2026-08-15T01:02:03Z",
      pluginCount: 2,
      publisherCount: 1,
      revocationCount: 1,
    },
  });
  assert.match(status, /Plugin catalog status/);
  assert.match(status, /local-governed/);
  assert.match(status, /discovery only/i);

  const inspect = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "catalog_inspect",
    catalog: {
      id: "reviewer",
      name: "Reviewer",
      publisherId: "acme",
      releases: [{
        version: "1.0.0",
        compatibility: { status: "manifest-valid" },
        publisher: { trustStatus: "trusted" },
        publisherSignature: { status: "valid" },
        quarantine: { status: "clear" },
        revocation: { status: "active" },
      }],
    },
  });
  assert.match(inspect, /reviewer/);
  assert.match(inspect, /1\.0\.0/);

  const select = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "catalog_select",
    selection: {
      pluginId: "reviewer",
      version: "1.0.0",
      selectionMode: "explicit-version",
      explicitVersion: "1.0.0",
      requestedProtocols: ["sophia.plugin/v1"],
      allowStale: false,
      allowPrerelease: false,
      artifact: {
        kind: "npm",
        reference: "@acme/reviewer@1.0.0",
        sha256: `sha256:${"a".repeat(64)}`,
      },
      evaluatedEnvironment: {
        sophiaApi: "1",
        platform: "darwin",
        architecture: "arm64",
        protocols: ["sophia.plugin/v1"],
      },
    },
  });
  assert.match(select, /explicit-version/);
  assert.match(select, /requested protocols: sophia\.plugin\/v1/);
  assert.match(select, /install approval: no/);

  const search = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "catalog_search",
    catalog: {
      catalogId: "\u001b[31mlocal-governed",
      sequence: 8,
      cacheStatus: "fresh",
    },
    results: Array.from({ length: 200 }, (_, index) => ({
      id: `plugin-${index}\u001b[2J`,
      name: "x".repeat(10_000),
      bestRelease: {
        version: "1.0.0",
        referenceSelectable: true,
        compatibility: { status: "manifest-valid" },
        publisher: { trustStatus: "trusted" },
        publisherSignature: { status: "valid" },
        quarantine: { status: "clear" },
        revocation: { status: "active" },
      },
    })),
  });
  assert.match(search, /Plugin catalog search/);
  assert.match(search, /plugin-0@1\.0\.0/);
  assert.doesNotMatch(search, /plugin-30@/);
  assert.doesNotMatch(search, /\u001b/);
  assert.ok(search.length <= 12_000);
});

test("formatPluginResult distinguishes lease preview, activation, and cleanup", () => {
  const preview = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "use",
    activated: false,
    needsApproval: true,
    authorityDisclosure: {
      reference: "deepseek-harness/headless",
      leaseScope: "task",
      session: "review-session",
      requestedPermissions: ["runtime.execute", "process.spawn"],
      plugin: { digest: "a".repeat(64) },
      executableIdentities: [{
        kind: "entrypoint",
        path: "/plugins/deepseek/sidecar.py",
        sha256: "b".repeat(64),
      }],
      bindingHash: "c".repeat(64),
      authorizationEpoch: 17,
      approvalBinding: {
        authorizationEpoch: 17,
        settingsPatch: {
          workflowMode: "off",
          team: 1,
        },
      },
      executable: true,
      safeModeCurrently: true,
    },
    approvalChallenge: {
      stage: "permissions",
      token: "challenge-123",
    },
  });
  assert.match(preview, /Plugin lease preview/);
  assert.match(preview, /does not install the plugin/);
  assert.match(preview, /sandbox enforcement is conditional/i);
  assert.match(preview, /session: review-session/);
  assert.match(preview, new RegExp(`digest: ${"a".repeat(64)}`));
  assert.match(preview, new RegExp(`binding hash: ${"c".repeat(64)}`));
  assert.match(preview, /authorization epoch: 17/);
  assert.match(preview, /entrypoint .*bbbbbbbbbbbb/);
  assert.match(preview, /settings: .*workflowMode.*off/);
  assert.match(preview, /--approve challenge-123/);

  const proposal = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "use",
    activated: false,
    needsSettingsApproval: true,
    settingsPatch: {
      workflowMode: "auto",
      workflowMaxStages: 3,
    },
    authorityDisclosure: {
      reference: "dynamic/adaptive",
      leaseScope: "task",
      session: "review-session",
      requestedPermissions: ["workflow.propose", "process.spawn"],
      plugin: { digest: "d".repeat(64) },
      proposalHash: "e".repeat(64),
      bindingHash: "f".repeat(64),
      executable: true,
    },
    approvalChallenge: {
      stage: "settings",
      token: "proposal-456",
    },
  });
  assert.match(proposal, /Plugin settings proposal/);
  assert.match(proposal, new RegExp(`proposal hash: ${"e".repeat(64)}`));
  assert.match(proposal, /workflowMaxStages.*3/);
  assert.match(proposal, /--approve-settings proposal-456/);

  const active = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "use",
    activated: true,
    activeLease: {
      reference: "deepseek-harness/headless",
      scope: "session",
      permissions: ["runtime.execute", "process.spawn"],
    },
    authorityDisclosure: {
      executable: true,
    },
  });
  assert.match(active, /Plugin lease active/);
  assert.match(active, /durable safe mode were not changed/);
  assert.match(active, /when this session changes/);

  const ended = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "use",
    activated: false,
    leaseEnded: true,
    reason: "task_ended",
    safeMode: true,
    endedLease: {
      reference: "deepseek-harness/headless",
      scope: "task",
    },
  });
  assert.match(ended, /Plugin lease ended/);
  assert.match(ended, /owned sidecars were retired/);
  assert.match(ended, /durable safe mode: on/);
});

test("plugin manager reducer treats ready plugins as structural data, not runtime health", () => {
  const seeded = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      safeMode: true,
      plugins: [{
        id: "native-review",
        version: "1.0.0",
        enabled: true,
        locked: true,
        permissions: ["workflow.propose"],
        approvedPermissions: ["workflow.propose"],
        health: { healthy: true },
      }],
      selections: { workflow: "native-review/bounded" },
      dshCompatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          name: "DSH Search",
          installed: false,
          compatible: true,
          health: { healthy: true },
        }],
      },
    },
  });

  const native = seeded.entries.find((entry) => entry.id === "native-review");
  const compat = seeded.entries.find((entry) => entry.id === "dsh-search");
  assert.equal(native?.present, true);
  assert.equal(native?.enabled, true);
  assert.equal(native?.approved, true);
  assert.equal(native?.locked, true);
  assert.equal(native?.selected, true);
  assert.equal(native?.runtimeHealth.status, "not_probed");
  assert.equal(compat?.present, false);
  assert.equal(compat?.structuralHealth, "ready");
  assert.equal(compat?.runtimeHealth.status, "not_probed");
});

test("plugin manager marks an explicitly selected compatibility skill", () => {
  const seeded = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      selections: {
        compatSkill: "@tt-a1i/archify-dsh::archify",
      },
      dshCompatibility: {
        plugins: [{
          compatibilityId: "@tt-a1i/archify-dsh",
          name: "Archify",
          installed: true,
          compatible: true,
        }],
      },
    },
  });

  const archify = seeded.entries.find(
    (entry) => entry.compatibilityId === "@tt-a1i/archify-dsh",
  );
  assert.equal(archify?.selected, true);
  assert.deepEqual(archify?.selectedKinds, ["compatSkill"]);
});

test("plugin manager reducer accepts untrusted shapes defensively and bounds display text", () => {
  assert.doesNotThrow(() => pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      safeMode: "no",
      plugins: [
        null,
        "bad",
        { id: "\u001b[31munsafe\nplugin", description: "x".repeat(1000) },
        { id: "" },
      ],
      issues: [{ path: "bad\npath", error: "boom\u0000now" }],
      selections: { workflow: ["not", "a", "string"] },
    },
  }));
  const state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      plugins: [{ id: "\u001b[31munsafe\nplugin", description: "x".repeat(1000) }],
      issues: [{ path: "bad\npath", error: "boom\u0000now" }],
    },
  });
  assert.equal(state.entries.length, 1);
  assert.doesNotMatch(state.entries[0].id, /[\u0000-\u001f]/);
  assert.ok(state.entries[0].description.length <= 360);
  assert.doesNotMatch(state.issues[0], /[\u0000-\u001f]/);
});

test("plugin manager reducer ignores unknown result actions and non-numeric progress counters", () => {
  const ignored = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "bridge_event",
    event: {
      type: "plugin_result",
      action: "compat_execute_arbitrary",
      compatibility: {
        plugins: [{ compatibilityId: "must-not-appear" }],
      },
    },
  });
  assert.equal(ignored, INITIAL_PLUGIN_MANAGER_STATE);

  const progress = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "bridge_event",
    event: {
      type: "plugin_progress",
      completed: "4",
      total: null,
      etaSeconds: {},
    },
  });
  assert.equal(progress.activity?.completed, null);
  assert.equal(progress.activity?.total, null);
  assert.equal(progress.activity?.etaSeconds, null);
});

test("runtime health changes only after an explicit probe result", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      dshCompatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          installed: true,
          compatible: true,
          health: { healthy: true },
        }],
      },
    },
  });
  assert.equal(state.entries[0].runtimeHealth.status, "not_probed");

  state = pluginManagerReducer(state, {
    type: "probe_started",
    compatibilityId: "dsh-search",
  });
  assert.equal(state.entries[0].runtimeHealth.status, "probing");

  state = pluginManagerReducer(state, {
    type: "bridge_event",
    event: {
      type: "plugin_result",
      ok: true,
      action: "compat_health",
      compatibilityId: "dsh-search",
      compatibility: {
        compatibilityId: "dsh-search",
        health: {
          status: "healthy",
          detail: "explicit probe passed",
        },
      },
    },
  });
  assert.equal(state.entries[0].runtimeHealth.status, "healthy");
  assert.equal(state.entries[0].runtimeHealth.probed, true);
  assert.equal(state.entries[0].structuralHealth, "ready");
});

test("compat health preserves a nested runtimeHealth result", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      dshCompatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          installed: true,
          compatible: true,
        }],
      },
    },
  });
  state = pluginManagerReducer(state, {
    type: "bridge_event",
    event: {
      type: "plugin_result",
      ok: true,
      action: "compat_health",
      compatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          status: "sophia-compatible",
          runtimeHealth: {
            status: "healthy",
            detail: "nested runtime probe passed",
          },
        }],
      },
    },
  });

  assert.equal(state.entries[0].runtimeHealth.status, "healthy");
  assert.equal(state.entries[0].runtimeHealth.detail, "nested runtime probe passed");
  assert.equal(state.entries[0].runtimeHealth.probed, true);
});

test("a targeted explicit health probe can consume a result without a repeated compatibility id", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      dshCompatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          installed: true,
          compatible: true,
        }],
      },
    },
  });
  state = pluginManagerReducer(state, {
    type: "probe_started",
    compatibilityId: "dsh-search",
  });
  state = pluginManagerReducer(state, {
    type: "bridge_event",
    event: {
      type: "plugin_result",
      ok: true,
      action: "compat_health",
      compatibility: {
        status: "healthy",
        detail: "explicit probe passed",
      },
    },
  });
  assert.equal(state.entries[0].runtimeHealth.status, "healthy");
  assert.equal(state.entries[0].runtimeHealth.probed, true);
});

test("authoritative selections clear historical selection flags when switched or deselected", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      plugins: [
        { id: "plugin-a", installed: true },
        { id: "plugin-b", installed: true },
      ],
      selections: {
        runtime: "plugin-a/runtime",
        workflow: "plugin-a/workflow",
      },
    },
  });
  assert.equal(state.entries.find((entry) => entry.id === "plugin-a")?.selected, true);
  assert.deepEqual(
    state.entries.find((entry) => entry.id === "plugin-a")?.selectedKinds,
    ["workflow", "runtime"],
  );

  state = pluginManagerReducer(state, {
    type: "seed",
    payload: {
      plugins: [
        { id: "plugin-a", installed: true },
        { id: "plugin-b", installed: true },
      ],
      selections: { runtime: "plugin-b/runtime" },
    },
  });
  assert.equal(state.entries.find((entry) => entry.id === "plugin-a")?.selected, false);
  assert.deepEqual(
    state.entries.find((entry) => entry.id === "plugin-a")?.selectedKinds,
    [],
  );
  assert.equal(state.entries.find((entry) => entry.id === "plugin-b")?.selected, true);
  assert.deepEqual(
    state.entries.find((entry) => entry.id === "plugin-b")?.selectedKinds,
    ["runtime"],
  );

  state = pluginManagerReducer(state, {
    type: "seed",
    payload: {
      plugins: [
        { id: "plugin-a", installed: true },
        { id: "plugin-b", installed: true },
      ],
      selections: {},
    },
  });
  assert.equal(state.entries.some((entry) => entry.selected), false);
  assert.deepEqual(state.entries.flatMap((entry) => entry.selectedKinds), []);
});

test("an authoritative empty compatibility catalog clears stale compatibility entries", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      plugins: [{ id: "native-review", installed: true }],
      dshCompatibility: {
        plugins: [{
          compatibilityId: "dsh-search",
          installed: true,
          compatible: true,
        }],
      },
    },
  });
  assert.equal(state.entries.some((entry) => entry.kind === "compat"), true);

  state = pluginManagerReducer(state, {
    type: "seed",
    payload: {
      plugins: [{ id: "native-review", installed: true }],
      dshCompatibility: { plugins: [] },
    },
  });
  assert.deepEqual(
    state.entries.map((entry) => `${entry.kind}:${entry.id}`),
    ["native:native-review"],
  );
});

test("structured plugin progress/events reduce to compact activity without transcript text", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "bridge_event",
    event: {
      type: "plugin_progress",
      method: "execution.progress",
      executionId: "exec-1\nhidden",
      state: "running",
      completed: 2,
      total: 5,
      etaSeconds: 12.7,
      arbitraryText: "must not render",
    },
  });
  assert.equal(
    pluginManagerActivityLine(state.activity),
    "plugin progress · running · 2/5 · ETA 13s · exec-1 hidden",
  );
  state = pluginManagerReducer(state, {
    type: "bridge_event",
    event: {
      type: "plugin_compat_event",
      method: "execution.event",
      eventType: "artifact.created",
      artifactId: "artifact-1",
      status: "ready",
      text: "ignored arbitrary text",
    },
  });
  assert.equal(
    pluginManagerActivityLine(state.activity),
    "plugin event · artifact.created · ready · artifact-1",
  );
});

test("compat notifications render bounded progress and kind/name subjects", () => {
  let state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "bridge_event",
    event: {
      type: "plugin_progress",
      method: "execution.progress",
      executionId: "exec-2",
      seq: 7,
      progress: 0.625,
      stage: "running",
      text: "must not render",
    },
  });
  assert.equal(state.activity?.seq, 7);
  assert.equal(state.activity?.progress, 0.625);
  assert.equal(state.activity?.state, "running");
  assert.equal(
    pluginManagerActivityLine(state.activity),
    "plugin progress · running · 63% · exec-2",
  );

  state = pluginManagerReducer(state, {
    type: "bridge_event",
    event: {
      type: "plugin_compat_event",
      method: "execution.event",
      eventType: "completed",
      kind: "tool",
      name: "search",
      seq: 8,
      text: "must not render",
    },
  });
  assert.equal(state.activity?.seq, 8);
  assert.equal(
    pluginManagerActivityLine(state.activity),
    "plugin event · completed · tool/search",
  );
});

test("compat formatter separates structural compatibility from explicit runtime health", () => {
  const structural = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "compat_list",
    compatibility: {
      plugins: [{
        compatibilityId: "dsh-search",
        installed: true,
        compatible: true,
      }],
    },
  });
  assert.match(structural, /structural ready/);
  assert.match(structural, /runtime not probed/);
  assert.match(structural, /structural compatibility is not runtime health/);

  const probed = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "compat_health",
    compatibilityId: "dsh-search",
    compatibility: {
      plugins: [{
        compatibilityId: "dsh-search",
        installed: true,
        compatible: true,
        health: { status: "healthy" },
      }],
    },
  });
  assert.match(probed, /runtime healthy/);
  assert.match(probed, /explicit probe/);
});

test("compat tool-call transcript output strips ANSI, C0, and C1 controls", () => {
  const text = formatPluginResult({
    type: "plugin_result",
    ok: true,
    action: "compat_tool_call",
    compatibilityId: "dsh-search",
    result: {
      message: "\u001b[31mred\u001b[0m\u0000done",
      nested: ["\u009b31mblue"],
    },
  });
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(text, /\\u001b|\\u0000|\\u009b/);
  assert.match(text, /reddone/);
  assert.match(text, /blue/);
});

test("selectedPluginManagerEntry follows the active tab cursor safely", () => {
  const state = pluginManagerReducer(INITIAL_PLUGIN_MANAGER_STATE, {
    type: "seed",
    payload: {
      plugins: [
        { id: "one", installed: true },
        { id: "two", installed: true },
      ],
    },
  });
  assert.equal(selectedPluginManagerEntry(state)?.id, "one");
  const moved = pluginManagerReducer(state, { type: "move", delta: 1 });
  assert.equal(selectedPluginManagerEntry(moved)?.id, "two");
});
