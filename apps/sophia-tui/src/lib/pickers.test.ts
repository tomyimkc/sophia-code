import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  RESPONSE_STYLE_OPTIONS,
  effortLabel,
  groupModelOptions,
  mergeModelOptions,
  modelGroupForOption,
  modelPickerSelectionIndex,
  moveSelection,
  normalizeEffort,
  optionsFor,
  toggleModelGroup,
  titleFor,
  windowFor,
} from "./pickers.js";
import {
  PICKER_COMMAND_KINDS,
  PICKER_SLASH_COMMANDS,
  allCommands,
  pickerKindFor,
} from "./slash.js";

test("normalizes effort aliases to canonical runtime values", () => {
  assert.equal(normalizeEffort(" low "), "low");
  assert.equal(normalizeEffort("MED"), "medium");
  assert.equal(normalizeEffort("HIGH"), "high");
  for (const alias of ["max", "ultra", "ULTRAMODE", "xhigh", "ultracode"]) {
    assert.equal(normalizeEffort(alias), "ultramode", alias);
    assert.equal(effortLabel(alias), "ultra", alias);
  }
  assert.equal(normalizeEffort("turbo"), null);
});

test("effort picker exposes Ultra while emitting canonical ultramode", () => {
  assert.deepEqual(EFFORT_OPTIONS.map(({ value, label }) => ({ value, label })), [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "ultramode", label: "ultra" },
  ]);
});

test("responseStyle picker exposes the four approved styles", () => {
  assert.deepEqual(RESPONSE_STYLE_OPTIONS.map(({ value }) => value), [
    "adaptive",
    "concise",
    "explanatory",
    "structured",
  ]);
  assert.equal(optionsFor("responseStyle"), RESPONSE_STYLE_OPTIONS);
  assert.equal(titleFor("responseStyle"), "Select response style");
});

test("benchMode picker offers exactly the knowledge and tool-use benchmarks", () => {
  assert.deepEqual(
    optionsFor("benchMode").map(({ value }) => value),
    ["knowledge", "tool-use"],
  );
  assert.equal(titleFor("benchMode"), "Select benchmark mode");
});

test("login picker offers Grok and Codex subscription browser sign-in", () => {
  assert.deepEqual(
    optionsFor("login").map(({ value }) => value),
    ["grok", "codex"],
  );
  assert.equal(titleFor("login"), "Sign in to a subscription provider");
  assert.equal(pickerKindFor("login"), "login");
});

test("picker command registry covers every picker-backed slash and alias", () => {
  assert.deepEqual([...PICKER_SLASH_COMMANDS].sort(), Object.keys(PICKER_COMMAND_KINDS).sort());
  assert.equal(pickerKindFor("permissions"), "permission");
  assert.equal(pickerKindFor("permission"), "permission");
  assert.equal(pickerKindFor("status"), null);

  const catalogNames = new Set(allCommands().flatMap((command) => [command.name, ...(command.aliases || [])]));
  for (const command of PICKER_SLASH_COMMANDS) {
    assert.ok(catalogNames.has(command), `missing picker command in catalog: ${command}`);
    assert.ok(optionsFor(pickerKindFor(command)!).length > 0, `empty picker: ${command}`);
  }
});

// --- moveSelection: the single WRAP-around rule shared by the slash menu,
// the model/effort/mode/theme/permission picker, and the session-resume
// picker (App.tsx previously hand-rolled `(i + delta + n) % n` three times;
// see the doc comment on moveSelection for why one of those three copies
// was actually broken). ---

test("moveSelection wraps Down past the last row to the first row", () => {
  assert.equal(moveSelection(4, 1, 5), 0);
});

test("moveSelection wraps Up past the first row to the last row", () => {
  assert.equal(moveSelection(0, -1, 5), 4);
});

test("moveSelection moves normally inside the list", () => {
  assert.equal(moveSelection(2, 1, 5), 3);
  assert.equal(moveSelection(2, -1, 5), 1);
});

test("moveSelection returns 0 (not NaN) for an empty list", () => {
  // This is the exact defect: App.tsx's session-resume picker computed
  // `(selected + delta + sessionOptions.length) % sessionOptions.length`
  // directly, and with zero saved sessions that is `x % 0` === NaN — the
  // picker got permanently stuck showing "NaN/0" after the first keypress.
  assert.equal(moveSelection(0, 1, 0), 0);
  assert.equal(moveSelection(0, -1, 0), 0);
  assert.ok(!Number.isNaN(moveSelection(0, 1, 0)));
});

test("moveSelection stays put on a single-item list", () => {
  assert.equal(moveSelection(0, 1, 1), 0);
  assert.equal(moveSelection(0, -1, 1), 0);
});

test("moveSelection self-heals a non-finite current index instead of propagating NaN", () => {
  assert.equal(moveSelection(NaN, 1, 5), 1);
});

test("moveSelection wraps correctly for a multi-step jump (Home/End/PageUp style)", () => {
  assert.equal(moveSelection(0, -5, 3), 1);
  assert.equal(moveSelection(0, 5, 3), 2);
});

// --- windowFor: shared scroll-window math for every scrollable picker.
// SlashSuggest and OptionPicker both delegate to this instead of each
// keeping their own copy of the centering/clamping arithmetic. ---

test("windowFor shows the whole list when it fits without scrolling", () => {
  assert.deepEqual(windowFor(5, 2, 12), { start: 0, end: 5, index: 2 });
});

test("windowFor enforces a minimum window of 3 rows even for a tiny maxVisible", () => {
  assert.deepEqual(windowFor(10, 0, 1), { start: 0, end: 3, index: 0 });
});

test("windowFor centers the window around the current selection", () => {
  assert.deepEqual(windowFor(100, 50, 12), { start: 44, end: 56, index: 50 });
});

test("windowFor clamps the window at the trailing edge instead of overflowing past the end", () => {
  const { start, end, index } = windowFor(100, 99, 12);
  assert.equal(end, 100);
  assert.equal(start, 88);
  assert.equal(index, 99);
});

test("windowFor clamps the window at the leading edge", () => {
  assert.deepEqual(windowFor(100, 0, 12), { start: 0, end: 12, index: 0 });
});

test("windowFor's clamped index always falls inside its own [start, end) window", () => {
  for (const total of [1, 2, 3, 7, 12, 50]) {
    for (const selected of [-5, 0, 1, Math.floor(total / 2), total - 1, total, total + 5]) {
      const { start, end, index } = windowFor(total, selected, 12);
      assert.ok(index >= start && index < end, `total=${total} selected=${selected} -> [${start},${end}) index=${index}`);
    }
  }
});

test("windowFor returns a degenerate empty window for zero items without throwing", () => {
  assert.deepEqual(windowFor(0, 3, 12), { start: 0, end: 0, index: 0 });
});

test("windowFor clamps an out-of-range selected index to the last valid row (stale-index race)", () => {
  // The exact scenario this guards: the filtered list shrinks on a keystroke
  // and, for one render, a picker still holds the previous (now too large)
  // selected index before the caller's reset effect runs.
  assert.equal(windowFor(5, 999, 12).index, 4);
  assert.equal(windowFor(5, -3, 12).index, 0);
});

test("windowFor treats a non-finite selected index as 0 rather than propagating NaN", () => {
  const { index } = windowFor(5, NaN, 12);
  assert.equal(index, 0);
  assert.ok(!Number.isNaN(index));
});

// ── mergeModelOptions ───────────────────────────────────────────────────
// The /model picker must surface locally-cached models the bridge discovered
// (e.g. mlx:mlx-community/Qwen3.6-35B-A3B-4bit) alongside the static presets.

test("mergeModelOptions appends discovered models not already in the static presets", () => {
  const base = [{ value: "qwen3.6-35b", label: "qwen3.6-35b" }, { value: "mock", label: "mock" }];
  const discovered = [
    { alias: "mlx:mlx-community/Qwen3.6-35B-A3B-4bit", setup: "Local MLX cache model", group: "mlx" as const },
    { alias: "ollama:qwen3:30b-a3b", label: "Local Ollama model" },
  ];
  const merged = mergeModelOptions(base, discovered);
  assert.equal(merged.length, 4);
  // Static presets keep their position and label (preset wins).
  assert.deepEqual(merged[0], { value: "qwen3.6-35b", label: "qwen3.6-35b" });
  // Discovered models appended after, with alias as value+label, setup as hint.
  assert.deepEqual(merged[2], { value: "mlx:mlx-community/Qwen3.6-35B-A3B-4bit", label: "mlx:mlx-community/Qwen3.6-35B-A3B-4bit", hint: "Local MLX cache model", groupId: "mlx" });
  assert.deepEqual(merged[3], { value: "ollama:qwen3:30b-a3b", label: "ollama:qwen3:30b-a3b", hint: "Local Ollama model" });
});

test("mergeModelOptions dedupes discovered models whose alias collides with a preset", () => {
  // A discovered alias that is already a static preset value is NOT added —
  // the preset's hand-written label/hint wins.
  const base = [{ value: "mock", label: "offline deterministic" }];
  const discovered = [
    { alias: "mock", setup: "should be deduped" },
    { alias: "mlx:mlx-community/Qwen3.6-35B-A3B-4bit", setup: "Local MLX cache model" },
  ];
  const merged = mergeModelOptions(base, discovered);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].value, "mock");
  assert.equal(merged[0].label, "offline deterministic"); // preset label preserved
});

test("mergeModelOptions returns base unchanged when nothing was discovered", () => {
  const base = [{ value: "mock", label: "mock" }];
  assert.equal(mergeModelOptions(base, []), base, "must return the same array reference, not a copy");
});

test("mergeModelOptions skips discovered entries with empty/missing alias", () => {
  const base = [{ value: "mock", label: "mock" }];
  const discovered = [
    { alias: "", setup: "empty alias" },
    { alias: "mlx:mlx-community/Qwen3.6-35B-A3B-4bit", setup: "ok" },
  ] as { alias: string; setup?: string }[];
  const merged = mergeModelOptions(base, discovered);
  assert.equal(merged.length, 2);
  assert.ok(!merged.some((m) => m.value === ""));
});

test("model picker classifies local runtimes and provider families", () => {
  const cases = {
    "ollama:qwen3:30b-a3b": "ollama",
    "mlx:mlx-community/Qwen3.6-35B-A3B-4bit": "mlx",
    mlx: "mlx",
    omlx: "mlx",
    "vllm:qwen3.6-35b-a3b@http://127.0.0.1:8000/v1": "vllm",
    "qwen3.6-35b": "vllm",
    ds4: "ds4",
    pulsar: "ds4",
    "ds4:deepseek-v4-flash@http://127.0.0.1:8000/v1": "ds4",
    "pulsar:glm-5.2@http://127.0.0.1:8001/v1": "ds4",
    "qwen-coding": "gateway",
    "codex-api": "gateway",
    teamorouter: "claude",
    aipro: "claude",
    "aipro-2": "claude",
    "020s-terra": "cloud",
    codex: "cli",
    "codex-terra": "cli",
    "codex-luna": "cli",
    "codex-fugu": "cli",
    fugu: "cli",
    "grok-cli": "cli",
    openclaw: "cli",
    mock: "other",
  } as const;
  for (const [value, expected] of Object.entries(cases)) {
    assert.equal(modelGroupForOption({ value }), expected, value);
  }
});

test("model picker exposes DS4 and Pulsar under one dedicated DS4 group", () => {
  assert.ok(MODEL_OPTIONS.some((option) => option.value === "ds4"));
  assert.ok(MODEL_OPTIONS.some((option) => option.value === "pulsar"));
  const rows = groupModelOptions([
    { value: "ds4:deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { value: "pulsar:glm-5.2", label: "GLM 5.2" },
  ], ["ds4"]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.groupId, row.value]),
    [
      ["group", "ds4", "__model_group__:ds4"],
      ["option", "ds4", "ds4:deepseek-v4-flash"],
      ["option", "ds4", "pulsar:glm-5.2"],
    ],
  );
});

test("model picker keeps subscription Codex, oMLX, and legacy MLX distinct", () => {
  const codex = MODEL_OPTIONS.find((option) => option.value === "codex");
  const omlx = MODEL_OPTIONS.find((option) => option.value === "omlx");
  const mlx = MODEL_OPTIONS.find((option) => option.value === "mlx");

  assert.ok(codex);
  assert.match(codex.label, /GPT-5\.6 Sol/i);
  assert.match(codex.hint || "", /ChatGPT subscription/i);
  assert.ok(!MODEL_OPTIONS.some((option) => option.value === "codex-5.6"));

  assert.equal(omlx?.label, "oMLX");
  assert.match(omlx?.hint || "", /OpenAI-compatible local MLX server/i);
  assert.equal(mlx?.label, "Legacy MLX");
  assert.match(mlx?.hint || "", /in-process mlx-lm/i);
});

test("model picker renders collapsed provider headers and expands one family", () => {
  const options = [
    { value: "ollama:qwen3:8b", label: "qwen3:8b" },
    { value: "ollama:deepseek-r1", label: "deepseek-r1" },
    { value: "mlx:mlx-community/Qwen3-4B", label: "Qwen3-4B" },
    { value: "teamorouter", label: "Claude Opus 5" },
    { value: "codex", label: "Codex CLI" },
  ];
  const collapsed = groupModelOptions(options, new Set());
  assert.ok(collapsed.every((row) => row.kind === "group"));
  assert.deepEqual(collapsed.map((row) => row.groupId), ["ollama", "mlx", "claude", "cli"]);
  assert.equal(collapsed[0].optionCount, 2);
  assert.equal(collapsed[0].expanded, false);

  const expanded = groupModelOptions(options, new Set(["ollama"]));
  assert.deepEqual(
    expanded.map((row) => [row.kind, row.groupId, row.value]),
    [
      ["group", "ollama", "__model_group__:ollama"],
      ["option", "ollama", "ollama:qwen3:8b"],
      ["option", "ollama", "ollama:deepseek-r1"],
      ["group", "mlx", "__model_group__:mlx"],
      ["group", "claude", "__model_group__:claude"],
      ["group", "cli", "__model_group__:cli"],
    ],
  );
});

test("model group toggles are immutable and reversible", () => {
  const initial = ["mlx"] as const;
  const expanded = toggleModelGroup(initial, "ollama");
  assert.deepEqual(initial, ["mlx"]);
  assert.deepEqual(expanded, ["mlx", "ollama"]);
  assert.deepEqual(toggleModelGroup(expanded, "mlx"), ["ollama"]);
});

test("model picker highlights a collapsed current group and an expanded exact model", () => {
  const options = [
    { value: "ollama:qwen3:8b", label: "qwen3:8b" },
    { value: "mlx:mlx-community/Qwen3-4B", label: "Qwen3-4B" },
  ];
  const collapsed = groupModelOptions(options, []);
  assert.equal(modelPickerSelectionIndex(collapsed, "mlx:mlx-community/Qwen3-4B"), 1);

  const expanded = groupModelOptions(options, ["mlx"]);
  assert.equal(modelPickerSelectionIndex(expanded, "mlx:mlx-community/Qwen3-4B"), 2);
  assert.equal(expanded[2].kind, "option");
});

test("model picker exposes exactly two aipro Opus coordinators with Sonnet workers", () => {
  const teamorouter = MODEL_OPTIONS.find((option) => option.value === "teamorouter");
  assert.ok(teamorouter);
  assert.match(teamorouter.hint || "", /Claude Opus 5.*TEAMOROUTER_API_KEY/i);

  const aiproOptions = MODEL_OPTIONS.filter((option) =>
    /aipro/i.test(option.value) || /aipro|vip\.aipro\.love/i.test(option.hint || "")
  );
  assert.deepEqual(aiproOptions.map((option) => option.value), ["aipro", "aipro-2"]);
  assert.match(aiproOptions[0].hint || "", /option 1.*Opus 5.*Sonnet 5.*SOPHIA_AIPRO_KEY/i);
  assert.match(aiproOptions[1].hint || "", /option 2.*Opus 5.*Sonnet 5.*SOPHIA_AIPRO_KEY_2/i);
});
