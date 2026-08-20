import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMcpHealth,
  applyProviderHealth,
  doctorLines,
  onboardingSteps,
  parseReadyRuntime,
  providerHealthWord,
} from "./providerRuntime.js";

test("ready payload becomes a bounded provider/runtime snapshot", () => {
  const runtime = parseReadyRuntime({
    defaults: { model: "omlx" },
    providerProfile: { name: "this-mac" },
    runtime: { os_name: "Darwin", machine: "arm64" },
    protocolInfo: { version: 2, minimum: 1, bridgeInstanceId: "bridge-1" },
    localEngines: [
      { name: "oMLX", provider: "omlx", installed: true, running: true, ready: true, models: ["local"] },
      {
        name: "DS4",
        provider: "ds4",
        installed: true,
        running: true,
        ready: true,
        models: ["deepseek-v4-flash"],
        modelFiles: ["/models/deepseek-v4-flash.gguf"],
      },
      { name: "proxy", provider: "codex-api", installed: true, running: false, ready: false, optionalGateway: true },
    ],
    imageProvider: { name: "grok-cli", health: { ready: true, detail: "configured" } },
    mcp: { startupProbe: false },
  });
  assert.equal(runtime.provider, "omlx");
  assert.equal(runtime.profile, "this-mac");
  assert.equal(runtime.engines[0].ready, true);
  assert.deepEqual(runtime.engines[0].modelFiles, []);
  assert.deepEqual(runtime.engines[1].modelFiles, ["/models/deepseek-v4-flash.gguf"]);
  assert.equal(runtime.engines[2].optionalGateway, true);
  assert.equal(runtime.imageProvider.name, "grok-cli");
  assert.equal(runtime.protocol.version, 2);
});

test("onboarding order is provider then permission then auto dispatch", () => {
  assert.deepEqual(onboardingSteps({
    onboarding: { required: { provider: true, permission: true, autoDispatch: true } },
  }), ["model", "permission"]);
});

test("provider and MCP health updates preserve the rest of the runtime", () => {
  let runtime = parseReadyRuntime({ defaults: { model: "omlx" } });
  runtime = applyProviderHealth(runtime, {
    status: "complete",
    providers: [{
      provider: "omlx",
      model: "local",
      state: "ready",
      ok: true,
      paidProbeMade: false,
      checks: [],
    }],
  });
  assert.equal(providerHealthWord(runtime), "healthy");
  runtime = applyMcpHealth(runtime, { status: "unreachable", ok: false, configured: true, mode: "remote" });
  assert.equal(runtime.mcp.status, "unreachable");
  assert.equal(runtime.mcp.mode, "remote");
});

test("doctor output names no-spend probes and optional gateway state", () => {
  const runtime = applyProviderHealth(parseReadyRuntime({
    defaults: { model: "mock" },
    providerProfile: { name: "public" },
  }), {
    providers: [{ provider: "mock", model: "mock", state: "ready", ok: true, checks: [] }],
  });
  const lines = doctorLines(runtime, {
    bridgeReady: true,
    model: "mock",
    permission: "manual",
    cwd: "/tmp/project",
    terminal: "100x30",
    commands: 10,
  });
  assert.ok(lines.some((line) => line.includes("paidProbeMade=false")));
  assert.ok(lines.some((line) => line.includes("no generation request")));
});
