import test from "node:test";
import assert from "node:assert/strict";

import { resolveAccessibility } from "../lib/accessibility.js";
import { localEnginePanelRows } from "../lib/localOps.js";
import type { LocalEngineSummary } from "../lib/providerRuntime.js";
import {
  adapterSummaryLine,
  engineRowLine,
  guidedSetupLines,
  hardwareSummaryLine,
  localEnginePanelBorderStyle,
  localEnginePanelLayout,
  localModelRowLine,
  localModelRowsFromEngines,
  ds4ModelFilesFromSources,
  parseAdapterStatus,
  parseLocalRuntimeReport,
  sortLocalModelRows,
  type LocalModelRow,
} from "./LocalEnginePanel.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

const ENGINES: LocalEngineSummary[] = [
  {
    name: "MLX",
    provider: "omlx",
    installed: true,
    running: true,
    ready: true,
    optionalGateway: false,
    models: ["mlx-community/Qwen3.6-35B-A3B-4bit"],
    modelFiles: [],
  },
  {
    name: "Ollama",
    provider: "ollama",
    installed: true,
    running: false,
    ready: false,
    optionalGateway: false,
    models: ["phi4:14b", "llama3.2:3b"],
    modelFiles: [],
  },
];

test("parseLocalRuntimeReport returns null when the report has not arrived or failed server-side", () => {
  assert.equal(parseLocalRuntimeReport(undefined), null);
  assert.equal(parseLocalRuntimeReport(null), null);
  assert.equal(parseLocalRuntimeReport({ ok: false, error: "boom" }), null);
});

test("parseLocalRuntimeReport parses a full report defensively, never throwing on odd shapes", () => {
  const report = parseLocalRuntimeReport({
    ok: true,
    osName: "darwin",
    machine: "arm64",
    isAppleSilicon: true,
    hasNvidia: false,
    mlxImportable: true,
    ollamaInstalled: true,
    ollamaRunning: false,
    endpoints: [
      { name: "omlx", provider: "omlx", baseUrl: "http://127.0.0.1:8000", installed: true, running: true },
      "not-an-object",
    ],
    modelCounts: { ollama: 4, huggingFace: "not-a-number", mlx: 2, ds4: 1 },
    modelFiles: {
      ds4: ["/models/deepseek-v4-flash.gguf", "/models/deepseek-v4-flash.gguf"],
      pulsar: ["/models/glm-5.2.gguf"],
    },
    recommendation: "use omlx",
    setupSuggestions: ["ollama pull phi4:14b", "", "  "],
  });
  assert.ok(report);
  assert.equal(report?.osName, "darwin");
  assert.equal(report?.isAppleSilicon, true);
  assert.equal(report?.endpoints.length, 2);
  assert.equal(report?.endpoints[0]?.baseUrl, "http://127.0.0.1:8000");
  assert.equal(report?.modelCounts.ollama, 4);
  assert.equal(report?.modelCounts.huggingFace, 0, "a non-numeric count degrades to 0, not NaN");
  assert.equal(report?.modelCounts.ds4, 1);
  assert.deepEqual(report?.modelFiles, [
    "/models/deepseek-v4-flash.gguf",
    "/models/glm-5.2.gguf",
  ]);
  assert.deepEqual(report?.setupSuggestions, ["ollama pull phi4:14b"], "blank suggestions are dropped");
});

test("DS4 GGUF paths merge report and engine scans without claiming reachability", () => {
  const report = parseLocalRuntimeReport({
    ok: true,
    modelCounts: { gguf: 3 },
    modelFiles: ["/models/a.gguf", "/models/b.gguf"],
  });
  const files = ds4ModelFilesFromSources(report, [
    {
      name: "DS4",
      provider: "ds4",
      installed: true,
      running: true,
      ready: true,
      optionalGateway: false,
      models: ["deepseek-v4-flash"],
      modelFiles: ["/models/b.gguf", "/models/c.gguf"],
    },
  ]);
  assert.equal(report?.modelCounts.ds4, 3);
  assert.deepEqual(files, ["/models/a.gguf", "/models/b.gguf", "/models/c.gguf"]);
});

test("parseLocalRuntimeReport never crashes on a completely malformed payload", () => {
  assert.doesNotThrow(() => parseLocalRuntimeReport("just a string"));
  assert.doesNotThrow(() => parseLocalRuntimeReport(42));
  assert.doesNotThrow(() => parseLocalRuntimeReport([1, 2, 3]));
  const parsed = parseLocalRuntimeReport("just a string");
  assert.equal(parsed?.osName, "unknown");
});

test("parseAdapterStatus returns null before the report arrives or on server-reported failure", () => {
  assert.equal(parseAdapterStatus(undefined), null);
  assert.equal(parseAdapterStatus(null), null);
  assert.equal(parseAdapterStatus({ ok: false }), null);
});

test("parseAdapterStatus reports a configured adapter with its cached count", () => {
  const adapter = parseAdapterStatus({
    ok: true,
    configured: true,
    path: "/Users/tom/.sophia/adapters/w2-latest",
    name: "w2-latest",
    exists: true,
    cachedAdapters: ["w2-latest", "w1-archive"],
  });
  assert.ok(adapter);
  assert.equal(adapter?.configured, true);
  assert.equal(adapter?.name, "w2-latest");
  assert.equal(adapter?.cachedAdapters.length, 2);
});

test("parseAdapterStatus treats a missing name/path as null, not an empty string", () => {
  const adapter = parseAdapterStatus({ ok: true, configured: false, exists: false, cachedAdapters: [] });
  assert.ok(adapter);
  assert.equal(adapter?.path, null);
  assert.equal(adapter?.name, null);
});

test("localModelRowsFromEngines builds one row per model, reachability from the engine's ready state", () => {
  const rows = localModelRowsFromEngines(ENGINES);
  assert.equal(rows.length, 3);
  const mlxRow = rows.find((r) => r.id === "mlx-community/Qwen3.6-35B-A3B-4bit");
  assert.equal(mlxRow?.reachable, true);
  assert.equal(mlxRow?.contextWindow, undefined, "context window is genuinely unknown from this source");
  const ollamaRow = rows.find((r) => r.id === "phi4:14b");
  assert.equal(ollamaRow?.reachable, false, "the hosting engine is not ready");
});

test("sortLocalModelRows puts reachable models first and keeps relative order within each group", () => {
  const rows: LocalModelRow[] = [
    { id: "a", engineName: "x", reachable: false },
    { id: "b", engineName: "x", reachable: true },
    { id: "c", engineName: "x", reachable: false },
    { id: "d", engineName: "x", reachable: true },
  ];
  const sorted = sortLocalModelRows(rows);
  assert.deepEqual(sorted.map((r) => r.id), ["b", "d", "a", "c"]);
});

test("panel layout collapses at stable width thresholds", () => {
  assert.equal(localEnginePanelLayout(100), "wide");
  assert.equal(localEnginePanelLayout(76), "wide");
  assert.equal(localEnginePanelLayout(60), "compact");
  assert.equal(localEnginePanelLayout(46), "compact");
  assert.equal(localEnginePanelLayout(30), "minimal");
});

test("screen-reader mode removes the decorative border", () => {
  assert.equal(
    localEnginePanelBorderStyle(resolveAccessibility(["--ax-screen-reader"], NO_ENV)),
    undefined,
  );
  assert.equal(localEnginePanelBorderStyle(resolveAccessibility([], NO_ENV)), "round");
});

test("engine rows state their status in words, plus an exact fix command when not ready", () => {
  const rows = localEnginePanelRows(ENGINES);
  const ollamaRow = rows.find((r) => r.provider === "ollama");
  assert.ok(ollamaRow);
  const wide = engineRowLine(ollamaRow!, 120, "wide");
  assert.match(wide, /\[installed-but-not-running\]/);
  assert.match(wide, /fix: start the Ollama app/);

  const minimal = engineRowLine(ollamaRow!, 120, "minimal");
  assert.match(minimal, /\[installed-but-not-running\]/);
  assert.ok(!minimal.includes("fix:"), "the fix command is dropped at minimal width, not truncated mid-word");
});

test("engine rows obey the given column width", () => {
  const rows = localEnginePanelRows(ENGINES);
  for (const row of rows) {
    for (const width of [10, 24, 60]) {
      assert.ok(engineRowLine(row, width).length <= width + 1, "at most a one-char ellipsis over budget");
    }
  }
});

test("model rows annotate reachability, context window, and size — 'unknown' in words, never fabricated", () => {
  const known: LocalModelRow = {
    id: "phi4:14b",
    engineName: "Ollama",
    reachable: true,
    contextWindow: 131072,
    sizeLabel: "9.1 GB",
  };
  const unknown: LocalModelRow = { id: "mystery-model", engineName: "Ollama", reachable: false };

  const knownLine = localModelRowLine(known, 120, "wide");
  assert.match(knownLine, /reachable/);
  assert.match(knownLine, /context 131\.1k|context 131k/);
  assert.match(knownLine, /9\.1 GB/);

  const unknownLine = localModelRowLine(unknown, 120, "wide");
  assert.match(unknownLine, /unreachable/);
  assert.match(unknownLine, /context unknown/);
  assert.match(unknownLine, /size unknown/);
  assert.ok(!/undefined|null|NaN/.test(unknownLine));
});

test("model rows drop context/size at minimal width rather than truncating them mid-number", () => {
  const row: LocalModelRow = {
    id: "phi4:14b",
    engineName: "Ollama",
    reachable: true,
    contextWindow: 131072,
    sizeLabel: "9.1 GB",
  };
  const minimal = localModelRowLine(row, 60, "minimal");
  assert.match(minimal, /reachable/);
  assert.ok(!minimal.includes("context"));
  assert.ok(!minimal.includes("GB"));
});

test("hardware summary states the chip family it was actually told, never a guess", () => {
  assert.equal(hardwareSummaryLine(null), "hardware: not probed yet");
  assert.match(
    hardwareSummaryLine({
      osName: "darwin",
      machine: "arm64",
      isAppleSilicon: true,
      hasNvidia: false,
      mlxImportable: true,
      ollamaInstalled: true,
      ollamaRunning: true,
      endpoints: [],
      modelCounts: { ollama: 0, huggingFace: 0, mlx: 0, ds4: 0 },
      modelFiles: [],
      recommendation: "",
      setupSuggestions: [],
    }),
    /Apple Silicon/,
  );
  assert.match(
    hardwareSummaryLine({
      osName: "linux",
      machine: "x86_64",
      isAppleSilicon: false,
      hasNvidia: true,
      mlxImportable: false,
      ollamaInstalled: false,
      ollamaRunning: false,
      endpoints: [],
      modelCounts: { ollama: 0, huggingFace: 0, mlx: 0, ds4: 0 },
      modelFiles: [],
      recommendation: "",
      setupSuggestions: [],
    }),
    /NVIDIA/,
  );
});

test("adapter summary distinguishes not-probed, unconfigured, and an active adapter", () => {
  assert.equal(adapterSummaryLine(null), "adapter: not probed yet");
  assert.equal(
    adapterSummaryLine({ configured: false, path: null, name: null, exists: false, cachedAdapters: [] }),
    "no adapter configured",
  );
  const active = adapterSummaryLine({
    configured: true,
    path: "/Users/tom/.sophia/adapters/w2-latest",
    name: "w2-latest",
    exists: true,
    cachedAdapters: ["w2-latest", "w1-archive"],
  });
  assert.match(active, /w2-latest/);
  assert.match(active, /2 cached/);

  const missing = adapterSummaryLine({
    configured: true,
    path: "/Users/tom/.sophia/adapters/gone",
    name: "gone",
    exists: false,
    cachedAdapters: [],
  });
  assert.match(missing, /file missing/);
});

test("guided setup lines lead with the specific engine fix commands, then the report's own suggestions, de-duplicated", () => {
  const rows = localEnginePanelRows(ENGINES);
  const lines = guidedSetupLines(
    {
      osName: "darwin",
      machine: "arm64",
      isAppleSilicon: true,
      hasNvidia: false,
      mlxImportable: true,
      ollamaInstalled: true,
      ollamaRunning: false,
      endpoints: [],
      modelCounts: { ollama: 0, huggingFace: 0, mlx: 0, ds4: 0 },
      modelFiles: [],
      recommendation: "",
      setupSuggestions: ["start the Ollama app (or run `ollama serve`)", "ollama pull phi4:14b"],
    },
    rows,
  );
  // The Ollama row's own fixCommand and the report's first suggestion are the
  // same text — de-duplicated to one entry, not shown twice.
  const occurrences = lines.filter((l) => l.includes("ollama serve")).length;
  assert.equal(occurrences, 1);
  assert.ok(lines.some((l) => l.includes("ollama pull phi4:14b")));
});

test("guided setup lines are empty when nothing is broken and the report offers nothing", () => {
  const readyEngines: LocalEngineSummary[] = [
    {
      name: "MLX",
      provider: "omlx",
      installed: true,
      running: true,
      ready: true,
      optionalGateway: false,
      models: [],
      modelFiles: [],
    },
  ];
  const lines = guidedSetupLines(null, localEnginePanelRows(readyEngines));
  assert.deepEqual(lines, []);
});
