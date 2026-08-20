import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyModelSpec,
  contextPressure,
  describeMemoryFitRefusal,
  formatLocalThroughput,
  localEnginePanelRows,
  localEngineState,
  rankModelOptions,
  summarizeLocalRuntime,
} from "./localOps.js";
import type { LocalEngineSummary } from "./providerRuntime.js";

function engine(overrides: Partial<LocalEngineSummary> = {}): LocalEngineSummary {
  return {
    name: "Ollama",
    provider: "ollama",
    installed: false,
    running: false,
    ready: false,
    optionalGateway: false,
    models: [],
    modelFiles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyModelSpec
// ---------------------------------------------------------------------------

test("bare local preset aliases classify as local with the right runtime", () => {
  assert.deepEqual(classifyModelSpec("omlx"), {
    spec: "omlx", isLocal: true, runtime: "mlx", model: null, baseUrl: null, label: "MLX",
  });
  assert.equal(classifyModelSpec("mlx-lm").runtime, "mlx");
  assert.equal(classifyModelSpec("ollama").runtime, "ollama");
  assert.equal(classifyModelSpec("ollama").isLocal, true);
  assert.equal(classifyModelSpec("vllm").label, "vLLM");
  assert.equal(classifyModelSpec("sglang").label, "SGLang");
  assert.equal(classifyModelSpec("ds4").label, "DS4");
  assert.equal(classifyModelSpec("pulsar").label, "Pulsar");
  assert.equal(classifyModelSpec("ds4").runtime, "openai-compatible");
  assert.equal(classifyModelSpec("pulsar").isLocal, true);
  assert.equal(classifyModelSpec("qwen3.6-35b").runtime, "openai-compatible");
  assert.equal(classifyModelSpec("llamacpp").runtime, "llama.cpp");
  assert.equal(classifyModelSpec("llama.cpp").runtime, "llama.cpp");
});

test("ds4:/pulsar: specs retain model and endpoint while staying local OpenAI-compatible", () => {
  const ds4 = classifyModelSpec("ds4:deepseek-v4-flash@http://127.0.0.1:8000/v1");
  assert.equal(ds4.runtime, "openai-compatible");
  assert.equal(ds4.isLocal, true);
  assert.equal(ds4.model, "deepseek-v4-flash");
  assert.equal(ds4.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(ds4.label, "DS4 · deepseek-v4-flash @127.0.0.1:8000");

  const pulsar = classifyModelSpec("pulsar:glm-5.2@http://localhost:8001/v1");
  assert.equal(pulsar.runtime, "openai-compatible");
  assert.equal(pulsar.model, "glm-5.2");
  assert.equal(pulsar.label, "Pulsar · glm-5.2 @localhost:8001");
});

test("ollama:<model> and mlx:<model> carry the model id through", () => {
  const ollama = classifyModelSpec("ollama:phi4:14b");
  assert.equal(ollama.runtime, "ollama");
  assert.equal(ollama.isLocal, true);
  assert.equal(ollama.model, "phi4:14b");
  assert.equal(ollama.label, "Ollama · phi4:14b");

  const mlx = classifyModelSpec("mlx:Qwen/Qwen2.5-3B-Instruct");
  assert.equal(mlx.runtime, "mlx");
  assert.equal(mlx.model, "Qwen/Qwen2.5-3B-Instruct");
  assert.equal(mlx.label, "MLX · Qwen/Qwen2.5-3B-Instruct");
});

test("vllm:<model>@<base-url> — the exact shape agent/cli.py's discovery emits", () => {
  const spec = "vllm:mlx-community--Qwen3-4B-Instruct-2507-4bit@http://127.0.0.1:8000/v1";
  const result = classifyModelSpec(spec);
  assert.equal(result.isLocal, true);
  assert.equal(result.runtime, "openai-compatible");
  assert.equal(result.model, "mlx-community--Qwen3-4B-Instruct-2507-4bit");
  assert.equal(result.baseUrl, "http://127.0.0.1:8000/v1");
  assert.match(result.label, /^mlx-community--Qwen3-4B-Instruct-2507-4bit @127\.0\.0\.1:8000$/);
});

test("an unparsable base-url suffix degrades the label gracefully instead of throwing", () => {
  assert.doesNotThrow(() => classifyModelSpec("vllm:local@not a url"));
  const result = classifyModelSpec("vllm:local@not a url");
  assert.equal(result.baseUrl, "not a url");
  assert.equal(result.label, "local"); // no host suffix appended when the URL doesn't parse
});

test("cloud/CLI aliases are never misclassified as a local runtime", () => {
  for (const alias of ["anthropic", "openai", "zai", "020s-terra2", "codex", "grok", "mock"]) {
    const result = classifyModelSpec(alias);
    assert.equal(result.isLocal, false, `${alias} should not be local`);
    assert.equal(result.runtime, "cloud");
  }
});

test("empty or missing specs classify as unknown rather than throwing", () => {
  for (const spec of ["", "   ", undefined, null]) {
    const result = classifyModelSpec(spec);
    assert.equal(result.isLocal, false);
    assert.equal(result.runtime, "unknown");
    assert.equal(result.label, "(no model)");
  }
});

// ---------------------------------------------------------------------------
// formatLocalThroughput
// ---------------------------------------------------------------------------

test("throughput renders tok/s, ttft and elapsed when the sample has all three", () => {
  const line = formatLocalThroughput({ tokensPerSec: 42.3, ttftMs: 180, elapsedMs: 3400 }, 60);
  assert.equal(line, "42 tok/s · ttft 180ms · 3.4s total");
});

test("a rate under 10 keeps one decimal, matching the tokens.ts convention", () => {
  assert.equal(formatLocalThroughput({ tokensPerSec: 6.28 }, 20), "6.3 tok/s");
});

test("missing fields are omitted, never rendered as a placeholder", () => {
  assert.equal(formatLocalThroughput({ tokensPerSec: 42 }, 60), "42 tok/s");
  assert.equal(formatLocalThroughput({ ttftMs: 500 }, 60), "ttft 500ms");
  assert.equal(formatLocalThroughput({}, 60), "");
});

test("NaN/negative telemetry values are treated as absent, not as fabricated zeros", () => {
  assert.equal(
    formatLocalThroughput({ tokensPerSec: Number.NaN, ttftMs: -5, elapsedMs: 3000 }, 60),
    "3.0s total",
  );
});

test("a tight width budget elides from the least important end", () => {
  const sample = { tokensPerSec: 42, ttftMs: 180, elapsedMs: 3400 };
  // Room for tok/s and ttft but not elapsed too ("42 tok/s · ttft 180ms" is
  // exactly 21 columns; one narrower drops the elapsed segment entirely).
  const mid = formatLocalThroughput(sample, 21);
  assert.equal(mid, "42 tok/s · ttft 180ms");
  // Room for only the headline number.
  const narrow = formatLocalThroughput(sample, 9);
  assert.equal(narrow, "42 tok/s");
});

test("a budget too small for even the first segment returns empty, not a truncated fragment", () => {
  assert.equal(formatLocalThroughput({ tokensPerSec: 42 }, 3), "");
  assert.equal(formatLocalThroughput({ tokensPerSec: 42 }, 0), "");
});

// ---------------------------------------------------------------------------
// localEngineState / localEnginePanelRows / summarizeLocalRuntime
// ---------------------------------------------------------------------------

test("engine state is derived from installed/running/ready, matching runtime_config.LocalEngine.ready", () => {
  assert.equal(localEngineState({ installed: true, running: true, ready: true }), "ready");
  assert.equal(localEngineState({ installed: false, running: false, ready: false }), "not-installed");
  assert.equal(localEngineState({ installed: true, running: false, ready: false }), "installed-but-not-running");
  // installed+running but the report didn't mark it ready: an inconsistency
  // we surface honestly rather than guessing which field is wrong.
  assert.equal(localEngineState({ installed: true, running: true, ready: false }), "unknown");
});

test("panel rows sort problems first and keep original order within a state", () => {
  const rows = localEnginePanelRows([
    engine({ name: "Ollama", provider: "ollama", installed: true, running: true, ready: true, models: ["phi4"] }),
    engine({ name: "vLLM", provider: "vllm", installed: false, running: false, ready: false }),
    engine({ name: "SGLang", provider: "sglang", installed: true, running: false, ready: false }),
    engine({ name: "llama.cpp", provider: "llamacpp", installed: false, running: false, ready: false }),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["vLLM", "llama.cpp", "SGLang", "Ollama"]);
  assert.equal(rows[0].state, "not-installed");
  assert.equal(rows[0].fixCommand, "run `/config install-vllm`");
  assert.equal(rows[2].state, "installed-but-not-running");
  assert.equal(rows[2].fixCommand, "start a local SGLang server on 127.0.0.1:30000");
  assert.equal(rows[3].state, "ready");
  assert.equal(rows[3].detail, "1 model available");
  assert.equal(rows[3].fixCommand, null);
});

test("a ready engine with zero cached models still gets an honest, non-fabricated detail", () => {
  const [row] = localEnginePanelRows([engine({ installed: true, running: true, ready: true, models: [] })]);
  assert.equal(row.detail, "running, ready");
});

test("DS4 engine rows show bounded GGUF scan counts and actionable ds4-server fixes", () => {
  const [notRunning] = localEnginePanelRows([
    engine({
      name: "DS4",
      provider: "ds4",
      installed: true,
      running: false,
      ready: false,
      modelFiles: ["/models/deepseek-v4-flash.gguf"],
    }),
  ]);
  assert.equal(notRunning.detail, "installed, not running · 1 GGUF file scanned");
  assert.equal(notRunning.fixCommand, "start `sophia-ds4.service` or the guarded DS4 wrapper on loopback");

  const [notInstalled] = localEnginePanelRows([
    engine({ name: "DS4", provider: "ds4", installed: false }),
  ]);
  assert.equal(notInstalled.fixCommand, "run `/config install-ds4` (separate approval required)");
});

test("an unrecognized provider gets no fix command rather than a guessed one", () => {
  const [row] = localEnginePanelRows([
    engine({ name: "Mystery Engine", provider: "mystery", installed: false, running: false, ready: false }),
  ]);
  assert.equal(row.fixCommand, null);
});

test("optionalGateway passes through to the row for the caller to render differently", () => {
  const [row] = localEnginePanelRows([
    engine({ name: "Codex API gateway", provider: "codex-api", optionalGateway: true, installed: true, running: true, ready: true }),
  ]);
  assert.equal(row.optionalGateway, true);
});

test("summarizeLocalRuntime excludes optional gateways from the ready-of-total count", () => {
  const engines = [
    engine({ name: "Ollama", installed: true, running: true, ready: true }),
    engine({ name: "vLLM", provider: "vllm", installed: false, running: false, ready: false }),
    engine({ name: "Codex API gateway", provider: "codex-api", optionalGateway: true, installed: true, running: true, ready: true }),
  ];
  assert.equal(summarizeLocalRuntime(engines), "1 of 2 local engines ready; vLLM not ready");
});

test("summarizeLocalRuntime reports full readiness and the empty case cleanly", () => {
  assert.equal(
    summarizeLocalRuntime([engine({ name: "Ollama", installed: true, running: true, ready: true })]),
    "1 of 1 local engine ready (Ollama)",
  );
  assert.equal(summarizeLocalRuntime([]), "no local engines detected");
  assert.equal(
    summarizeLocalRuntime([engine({ optionalGateway: true, installed: true, running: true, ready: true })]),
    "no local engines detected",
  );
});

// ---------------------------------------------------------------------------
// contextPressure
// ---------------------------------------------------------------------------

test("context pressure is unknown when the window is unknown, never a fabricated level", () => {
  assert.deepEqual(contextPressure(1000, null), { level: "unknown", label: "context: unknown window", percent: null });
  assert.deepEqual(contextPressure(1000, undefined), { level: "unknown", label: "context: unknown window", percent: null });
});

test("context pressure never divides by zero", () => {
  const result = contextPressure(1000, 0);
  assert.equal(result.level, "unknown");
  assert.equal(result.percent, null);
});

test("context pressure crosses ok/warn/critical exactly at the documented thresholds", () => {
  assert.equal(contextPressure(69, 100).level, "ok");
  assert.equal(contextPressure(70, 100).level, "warn");
  assert.equal(contextPressure(89, 100).level, "warn");
  assert.equal(contextPressure(90, 100).level, "critical");
  assert.equal(contextPressure(100, 100).level, "critical");
});

// ---------------------------------------------------------------------------
// rankModelOptions
// ---------------------------------------------------------------------------

test("available options sort above unavailable ones, each annotated with why", () => {
  const ranked = rankModelOptions([
    { value: "anthropic", available: false, reason: "ANTHROPIC_API_KEY not set" },
    { value: "omlx", available: true },
    { value: "ollama:phi4", available: false, reason: "ollama not installed" },
    { value: "vllm", available: true },
  ]);
  assert.deepEqual(ranked.map((r) => r.value), ["omlx", "vllm", "anthropic", "ollama:phi4"]);
  assert.equal(ranked[0].unavailableReason, null);
  assert.equal(ranked[2].unavailableReason, "ANTHROPIC_API_KEY not set");
  assert.equal(ranked[3].unavailableReason, "ollama not installed");
});

test("ranking is stable: equal-availability options keep their input order", () => {
  const options = [
    { value: "a", available: true },
    { value: "b", available: true },
    { value: "c", available: true },
  ];
  assert.deepEqual(rankModelOptions(options).map((r) => r.value), ["a", "b", "c"]);
});

test("an unavailable option with no given reason still gets an honest fallback message", () => {
  const [ranked] = rankModelOptions([{ value: "vllm", available: false }]);
  assert.equal(ranked.unavailableReason, "not currently reachable");
});

// ---------------------------------------------------------------------------
// describeMemoryFitRefusal
// ---------------------------------------------------------------------------

test("numeric GB figures produce an actionable message naming a smaller quantization", () => {
  const message = describeMemoryFitRefusal({ requiredGb: 19.9, freeGb: 18.5, quantization: "bf16" });
  assert.equal(message, "The model needs 19.9GB, only 18.5GB free. Try 8-bit instead of bf16.");
});

test("a q8_0 refusal steps down to q4_k_m", () => {
  const message = describeMemoryFitRefusal({ requiredGb: 12, freeGb: 8, quantization: "q8_0" });
  assert.match(message, /Try q4_k_m instead of q8_0\.$/);
});

test("falls back to the server's raw detail text when no structured numbers are given", () => {
  const message = describeMemoryFitRefusal({ detail: "requires 24.0GB, 16.0GB available" });
  assert.equal(message, "The model requires 24.0GB, 16.0GB available. Try a smaller quantization.");
});

test("never fabricates a GB figure when it has none", () => {
  const message = describeMemoryFitRefusal({});
  assert.doesNotMatch(message, /\d+(\.\d+)?GB/);
  assert.equal(message, "The model does not fit in the memory available. Try a smaller quantization.");
});
