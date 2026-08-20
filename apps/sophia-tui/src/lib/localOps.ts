/**
 * Local-engine operations: pure helpers for the local-LLM story (MLX, Ollama,
 * OpenAI-compatible servers like vLLM/SGLang/DS4/Pulsar, and llama.cpp).
 *
 * Everything here is a pure function of its arguments — no bridge calls, no
 * timers, no filesystem/network access. Callers own fetching the raw report
 * (from the kernel) and the live telemetry sample (from the run-result event);
 * this module only turns that data into display-ready strings and structures,
 * the same split `tokens.ts` and `providerRuntime.ts` already use. Building
 * blocks are reused rather than re-implemented: `contextFillPercent` from
 * `tokens.ts` for the pressure percentage, `displayWidth`/`truncateToWidth`
 * from `textWidth.ts` for anything column-width-sensitive, and
 * `LocalEngineSummary` from `providerRuntime.ts` for the engine shape the
 * bridge already reports — a second, slightly-different local-engine type
 * here would just be one more place for the two to drift apart.
 */
import { contextFillPercent } from "./tokens.js";
import { displayWidth } from "./textWidth.js";
import type { LocalEngineSummary } from "./providerRuntime.js";

// ---------------------------------------------------------------------------
// 1. Model spec classification
// ---------------------------------------------------------------------------

/** The local inference runtimes this build knows how to reach directly. */
export type LocalRuntimeKind = "mlx" | "ollama" | "openai-compatible" | "llama.cpp";

/** Every runtime family `classifyModelSpec` can return. */
export type ModelRuntimeKind = LocalRuntimeKind | "cloud" | "unknown";

export interface ModelSpecClassification {
  /** The spec exactly as given (trimmed), for round-tripping/logging. */
  spec: string;
  /** True only for a runtime this process can talk to without leaving the machine. */
  isLocal: boolean;
  runtime: ModelRuntimeKind;
  /** The model id/path portion of the spec, or null when the spec names none. */
  model: string | null;
  /** An explicit `@base-url` override, or null when the spec has none. */
  baseUrl: string | null;
  /** Short human label for a status line or picker row. */
  label: string;
}

const MLX_PREFIXES = ["mlx:", "omlx:"];
const OPENAI_COMPAT_PREFIXES = ["vllm:", "sglang:"];
const DS4_PREFIXES = ["ds4:", "pulsar:"];
const LLAMACPP_PREFIXES = ["llamacpp:", "llama.cpp:"];
const OLLAMA_PREFIX = "ollama:";

// Bare (no-colon) preset aliases this repo ships today. Kept separate from the
// prefixed forms above because a bare alias carries no model id of its own —
// resolving one to a concrete model is `agent/model.py`'s job, not ours.
const MLX_BARE = new Set(["omlx", "mlx", "mlx-lm"]);
const OLLAMA_BARE = new Set(["ollama"]);
const OPENAI_COMPAT_BARE = new Set(["vllm", "qwen3.6-35b", "qwen3.6", "qwen36-local", "sglang"]);
const DS4_BARE = new Set(["ds4", "pulsar"]);
const LLAMACPP_BARE = new Set(["llamacpp", "llama.cpp", "llama-server"]);

function stripBaseUrl(spec: string): { rest: string; baseUrl: string | null } {
  const at = spec.indexOf("@");
  if (at < 0) return { rest: spec, baseUrl: null };
  const baseUrl = spec.slice(at + 1).trim();
  return { rest: spec.slice(0, at), baseUrl: baseUrl || null };
}

function stripPrefix(value: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return null;
}

/** Host:port suffix of a base URL, for a compact label — "" when unparsable. */
function hostSuffix(baseUrl: string | null): string {
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    return ` @${url.host}`;
  } catch {
    return "";
  }
}

/**
 * Classify a `--model`/`/model` spec into local-vs-cloud, a runtime family,
 * and a short display label. Handles the spec shapes this repo actually
 * produces: a bare preset alias ("omlx", "vllm", "ollama", ...), a prefixed
 * spec with a model id ("ollama:phi4:14b", "mlx:Qwen/Qwen2.5-3B-Instruct"),
 * and a discovered vLLM/SGLang spec with an explicit endpoint
 * ("vllm:<model>@http://host:8000/v1", the exact shape
 * `_discover_vllm_specs()` in `agent/cli.py` emits).
 *
 * Never throws: an empty, malformed, or unrecognized spec classifies as
 * `runtime: "unknown"` rather than raising, since this runs on whatever the
 * user (or a stale saved session) typed.
 */
export function classifyModelSpec(rawSpec: unknown): ModelSpecClassification {
  const spec = String(rawSpec ?? "").trim();
  if (!spec) {
    return { spec: "", isLocal: false, runtime: "unknown", model: null, baseUrl: null, label: "(no model)" };
  }
  const { rest, baseUrl } = stripBaseUrl(spec);

  const ollamaModel = stripPrefix(rest, [OLLAMA_PREFIX]);
  if (ollamaModel !== null) {
    const model = ollamaModel || null;
    return { spec, isLocal: true, runtime: "ollama", model, baseUrl, label: model ? `Ollama · ${model}` : "Ollama" };
  }
  const mlxModel = stripPrefix(rest, MLX_PREFIXES);
  if (mlxModel !== null) {
    const model = mlxModel || null;
    return { spec, isLocal: true, runtime: "mlx", model, baseUrl, label: model ? `MLX · ${model}` : "MLX" };
  }
  const compatModel = stripPrefix(rest, OPENAI_COMPAT_PREFIXES);
  if (compatModel !== null) {
    const model = compatModel || null;
    return {
      spec, isLocal: true, runtime: "openai-compatible", model, baseUrl,
      label: `${model ?? "vLLM"}${hostSuffix(baseUrl)}`,
    };
  }
  const ds4Model = stripPrefix(rest, DS4_PREFIXES);
  if (ds4Model !== null) {
    const model = ds4Model || null;
    const provider = rest.startsWith("pulsar:") ? "Pulsar" : "DS4";
    return {
      spec, isLocal: true, runtime: "openai-compatible", model, baseUrl,
      label: `${provider}${model ? ` · ${model}` : ""}${hostSuffix(baseUrl)}`,
    };
  }
  const llamaModel = stripPrefix(rest, LLAMACPP_PREFIXES);
  if (llamaModel !== null) {
    const model = llamaModel || null;
    return {
      spec, isLocal: true, runtime: "llama.cpp", model, baseUrl,
      label: model ? `llama.cpp · ${model}` : "llama.cpp",
    };
  }

  // No recognized prefix: fall back to the bare-alias tables, then to "this
  // is presumably a cloud alias/CLI backend we don't need to special-case" —
  // never a guessed local runtime for an alias we don't actually recognize.
  const bare = rest.toLowerCase();
  if (OLLAMA_BARE.has(bare)) {
    return { spec, isLocal: true, runtime: "ollama", model: null, baseUrl, label: "Ollama" };
  }
  if (MLX_BARE.has(bare)) {
    return { spec, isLocal: true, runtime: "mlx", model: null, baseUrl, label: "MLX" };
  }
  if (OPENAI_COMPAT_BARE.has(bare)) {
    const label = bare === "sglang" ? "SGLang" : bare === "vllm" ? "vLLM" : `vLLM · ${rest}`;
    return { spec, isLocal: true, runtime: "openai-compatible", model: null, baseUrl, label };
  }
  if (DS4_BARE.has(bare)) {
    return {
      spec,
      isLocal: true,
      runtime: "openai-compatible",
      model: null,
      baseUrl,
      label: bare === "pulsar" ? "Pulsar" : "DS4",
    };
  }
  if (LLAMACPP_BARE.has(bare)) {
    return { spec, isLocal: true, runtime: "llama.cpp", model: null, baseUrl, label: "llama.cpp" };
  }
  return { spec, isLocal: false, runtime: "cloud", model: null, baseUrl, label: rest };
}

// ---------------------------------------------------------------------------
// 2. Live throughput formatting
// ---------------------------------------------------------------------------

export interface LocalTelemetrySample {
  /** Generation rate in tokens/sec, once at least one token has been produced. */
  tokensPerSec?: number;
  /** Time to the first streamed token/chunk, in milliseconds. */
  ttftMs?: number;
  /** Wall-clock time for the turn so far, in milliseconds. */
  elapsedMs?: number;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** "42 tok/s" below 10, "6.3 tok/s" ... wait: one decimal under 10, none at/above. */
function formatRate(value: number): string {
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded} tok/s`;
}

function formatMs(value: number, suffixWhenSeconds: string): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  const rounded = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return `${rounded}${suffixWhenSeconds}`;
}

/**
 * Compact "42 tok/s · ttft 180ms · 3.4s" status string from a live telemetry
 * sample, never exceeding `maxWidthColumns` display columns.
 *
 * Segments are ordered most- to least-important (tok/s first — it is the
 * headline number local-model users actually watch, per the kernel side of
 * this work; elapsed last) and elided from the END when the budget is tight,
 * so a narrow footer loses the least useful segment first rather than
 * truncating the whole string mid-number. A field the sample does not have is
 * simply omitted — never rendered as "?" or a guessed value, and never
 * degrades to filler text that would misrepresent a real measurement.
 */
export function formatLocalThroughput(sample: LocalTelemetrySample, maxWidthColumns: number): string {
  const segments: string[] = [];
  if (isPositiveFiniteNumber(sample.tokensPerSec)) segments.push(formatRate(sample.tokensPerSec));
  if (isPositiveFiniteNumber(sample.ttftMs)) segments.push(`ttft ${formatMs(sample.ttftMs, "s")}`);
  if (isPositiveFiniteNumber(sample.elapsedMs)) segments.push(formatMs(sample.elapsedMs, "s total"));
  if (!segments.length) return "";
  if (maxWidthColumns <= 0) return "";

  const separator = " · ";
  let out = "";
  for (const segment of segments) {
    const candidate = out ? `${out}${separator}${segment}` : segment;
    if (displayWidth(candidate) > maxWidthColumns) {
      // Nothing fits at all, not even the single most important segment: give
      // up rather than emit a half-string that looks like a different number.
      return out;
    }
    out = candidate;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Local-runtime report -> summary + panel rows
// ---------------------------------------------------------------------------

export type LocalEngineState = "ready" | "not-installed" | "installed-but-not-running" | "unknown";

export interface LocalEnginePanelRow {
  name: string;
  provider: string;
  state: LocalEngineState;
  detail: string;
  /** A single actionable next step, or null when the engine is ready or none is known. */
  fixCommand: string | null;
  optionalGateway: boolean;
}

// Actionable next steps, by provider. Deliberately a fixed table rather than
// something derived from the (untrusted, possibly-absent) report fields: a
// wrong or missing fix command is worse than none, but a table entry here is
// static repo knowledge, not a number the kernel measured — nothing here can
// go stale the way a fabricated GB figure could.
const ENGINE_FIX: Record<string, { notInstalled: string; notRunning: string }> = {
  ollama: {
    notInstalled: "install Ollama (https://ollama.com), then `ollama pull <model>`",
    notRunning: "start the Ollama app (or run `ollama serve`)",
  },
  omlx: {
    notInstalled: "install oMLX, then start it so it listens on 127.0.0.1:8000",
    notRunning: "start the oMLX app so it listens on 127.0.0.1:8000",
  },
  vllm: {
    notInstalled: "run `/config install-vllm`",
    notRunning: "start a local vLLM server on 127.0.0.1:8000",
  },
  sglang: {
    notInstalled: "run `/config install-sglang`",
    notRunning: "start a local SGLang server on 127.0.0.1:30000",
  },
  llamacpp: {
    notInstalled: "run `/config install-llamacpp`",
    notRunning: "start llama-server so it listens on 127.0.0.1:8080",
  },
  ds4: {
    notInstalled: "run `/config install-ds4` (separate approval required)",
    notRunning: "start `sophia-ds4.service` or the guarded DS4 wrapper on loopback",
  },
  pulsar: {
    notInstalled: "install `pulsar-server` and ensure it is on PATH",
    notRunning: "start `pulsar-server` on its configured local OpenAI-compatible endpoint",
  },
};

function engineFixCommand(provider: string, state: LocalEngineState): string | null {
  const fix = ENGINE_FIX[provider.toLowerCase()];
  if (!fix) return null;
  if (state === "not-installed") return fix.notInstalled;
  if (state === "installed-but-not-running") return fix.notRunning;
  return null;
}

/** Derive a display state from the fields `providerRuntime.ts` already parses. */
export function localEngineState(
  engine: Pick<LocalEngineSummary, "installed" | "running" | "ready">,
): LocalEngineState {
  if (engine.ready) return "ready";
  if (!engine.installed) return "not-installed";
  if (engine.installed && !engine.running) return "installed-but-not-running";
  return "unknown";
}

const STATE_PRIORITY: Record<LocalEngineState, number> = {
  "not-installed": 0,
  "installed-but-not-running": 1,
  unknown: 2,
  ready: 3,
};

/**
 * Turn the bridge-reported local engines into panel rows, problems first: a
 * config screen exists so an operator can see what to fix, so a row that
 * needs action should never be scrolled below a page of engines that are
 * already fine. Ties (e.g. two "not-installed" engines) keep their original
 * report order — sort is by state priority only, and `Array.prototype.sort`
 * is stable, so this never reorders two rows the kernel reported adjacently
 * for no visible reason.
 */
export function localEnginePanelRows(engines: readonly LocalEngineSummary[]): LocalEnginePanelRow[] {
  return engines
    .map((engine): LocalEnginePanelRow => {
      const state = localEngineState(engine);
      const modelCount = Array.isArray(engine.models) ? engine.models.length : 0;
      const modelFileCount = Array.isArray(engine.modelFiles) ? engine.modelFiles.length : 0;
      const stateDetail =
        state === "ready"
          ? modelCount > 0
            ? `${modelCount} model${modelCount === 1 ? "" : "s"} available`
            : "running, ready"
          : state === "not-installed"
            ? "not installed"
            : state === "installed-but-not-running"
              ? "installed, not running"
              : "state unknown";
      const fileDetail = modelFileCount > 0
        ? `${modelFileCount} GGUF file${modelFileCount === 1 ? "" : "s"} scanned`
        : "";
      const detail = [stateDetail, fileDetail].filter(Boolean).join(" · ");
      return {
        name: engine.name,
        provider: engine.provider,
        state,
        detail,
        fixCommand: engineFixCommand(engine.provider, state),
        optionalGateway: Boolean(engine.optionalGateway),
      };
    })
    .sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state]);
}

/**
 * One-line "N of M local engines ready" summary. Optional loopback gateways
 * (Codex API proxy, Qwen Coding proxy) are excluded from the count — they are
 * transport conveniences to a paid plan, not a local model running on this
 * machine, the same distinction `doctorLines()` already draws.
 */
export function summarizeLocalRuntime(engines: readonly LocalEngineSummary[]): string {
  const real = engines.filter((engine) => !engine.optionalGateway);
  if (!real.length) return "no local engines detected";
  const ready = real.filter((engine) => engine.ready);
  const plural = real.length === 1 ? "" : "s";
  if (ready.length === real.length) {
    return `${ready.length} of ${real.length} local engine${plural} ready (${ready.map((e) => e.name).join(", ")})`;
  }
  const notReady = real.filter((engine) => !engine.ready).map((e) => e.name).join(", ");
  return `${ready.length} of ${real.length} local engine${plural} ready; ${notReady} not ready`;
}

// ---------------------------------------------------------------------------
// 4. Context pressure
// ---------------------------------------------------------------------------

export type ContextPressureLevel = "ok" | "warn" | "critical" | "unknown";

export interface ContextPressure {
  level: ContextPressureLevel;
  label: string;
  /** The same percentage `contextFillPercent` returns; null exactly when it is. */
  percent: number | null;
}

const WARN_AT_PERCENT = 70;
const CRITICAL_AT_PERCENT = 90;

/**
 * Classify context-window pressure from used/window token counts. Delegates
 * the actual percentage math to `contextFillPercent` (tokens.ts) instead of
 * dividing here a second time, so the "unknown window -> null, never a
 * fabricated percentage, never a divide-by-zero" guarantee lives in exactly
 * one place.
 */
export function contextPressure(used: number, window: number | null | undefined): ContextPressure {
  const percent = contextFillPercent(used, window);
  if (percent === null) return { level: "unknown", label: "context: unknown window", percent: null };
  if (percent >= CRITICAL_AT_PERCENT) return { level: "critical", label: `context ${percent}% · critical`, percent };
  if (percent >= WARN_AT_PERCENT) return { level: "warn", label: `context ${percent}% · getting full`, percent };
  return { level: "ok", label: `context ${percent}%`, percent };
}

// ---------------------------------------------------------------------------
// 5. Ranking model options by availability
// ---------------------------------------------------------------------------

export interface ModelOptionCandidate {
  value: string;
  label?: string;
  /** Whether this option is usable right now (installed, running, reachable, credentialed — caller decides). */
  available: boolean;
  /** WHY it's unavailable; used verbatim when `available` is false and this is set. */
  reason?: string;
}

export interface RankedModelOption extends ModelOptionCandidate {
  /** Non-null exactly when `available` is false. */
  unavailableReason: string | null;
}

/**
 * Sort model options so available ones lead, unavailable ones trail, each
 * annotated with why. Pure and stable: two options with the same
 * availability keep their original relative order (an explicit index
 * tiebreaker, not a bare reliance on sort stability, so behavior does not
 * depend on the JS engine's sort implementation).
 */
export function rankModelOptions(options: readonly ModelOptionCandidate[]): RankedModelOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      if (a.option.available !== b.option.available) return a.option.available ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ option }) => ({
      ...option,
      unavailableReason: option.available ? null : (option.reason?.trim() || "not currently reachable"),
    }));
}

// ---------------------------------------------------------------------------
// 6. Memory-fit refusal messaging
// ---------------------------------------------------------------------------

export interface MemoryFitRefusal {
  /** Raw server-reported detail text, when the caller has one (never invented if absent). */
  detail?: string;
  /** Already-parsed figures, preferred over re-parsing `detail` when present. */
  requiredGb?: number;
  freeGb?: number;
  /** The quantization/precision tag of the refused model, when known (e.g. "bf16", "q8_0"). */
  quantization?: string;
}

// Mirrors agent/runtime_config.py's `_QUANT_STEP_DOWN`: first matching marker
// wins. Kept in sync by hand rather than shared code, since this is a
// different language on the other side of the process boundary — but the
// ordering and the suggestions themselves are the same repo knowledge.
const QUANT_STEP_DOWN: ReadonlyArray<readonly [string, string]> = [
  ["bf16", "8-bit"], ["fp16", "8-bit"], ["f16", "8-bit"],
  ["8bit", "4-bit"], ["8-bit", "4-bit"], ["q8_0", "q4_k_m"],
  ["4bit", "a smaller parameter-count model"], ["4-bit", "a smaller parameter-count model"],
  ["q4_k_m", "q3_k_m or a smaller parameter-count model"],
];

function quantStepDown(...sources: Array<string | undefined>): string {
  const haystack = sources.filter(Boolean).join(" ").toLowerCase();
  for (const [marker, suggestion] of QUANT_STEP_DOWN) {
    if (haystack.includes(marker)) return suggestion;
  }
  return "a smaller quantization";
}

function formatGb(value: number): string {
  return `${value.toFixed(1)}GB`;
}

/**
 * Turn a local-engine memory-fit refusal into an actionable message that
 * names a smaller quantization instead of reading like a generic connection
 * failure. Never fabricates the GB figures: it uses `requiredGb`/`freeGb`
 * when both are given, falls back to the server's own `detail` text when
 * only that is available, and otherwise states the refusal without inventing
 * numbers it was never given.
 */
export function describeMemoryFitRefusal(refusal: MemoryFitRefusal): string {
  const haveNumbers = isPositiveFiniteNumber(refusal.requiredGb) && isPositiveFiniteNumber(refusal.freeGb);
  const fitClause = haveNumbers
    ? `needs ${formatGb(refusal.requiredGb as number)}, only ${formatGb(refusal.freeGb as number)} free`
    : refusal.detail?.trim()
      ? refusal.detail.trim()
      : "does not fit in the memory available";
  const suggestion = quantStepDown(refusal.quantization, refusal.detail);
  const from = refusal.quantization?.trim() ? ` instead of ${refusal.quantization.trim()}` : "";
  return `The model ${fitClause}. Try ${suggestion}${from}.`;
}
