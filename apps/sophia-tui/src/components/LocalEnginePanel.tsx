import React from "react";
import { Box, Text } from "ink";
import type { AccessibilityPrefs } from "../lib/accessibility.js";
import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  describeMemoryFitRefusal,
  localEnginePanelRows,
  summarizeLocalRuntime,
  type LocalEnginePanelRow,
  type LocalEngineState,
  type MemoryFitRefusal,
} from "../lib/localOps.js";
import type { LocalEngineSummary } from "../lib/providerRuntime.js";
import { formatTokens } from "../lib/tokens.js";
import { truncateToWidth } from "../lib/textWidth.js";
import type { Theme } from "../lib/theme.js";
import { MatrixText } from "./MatrixText.js";

// ---------------------------------------------------------------------------
// Wire-shaped data this panel reads. code_bridge.py's `local_engine_report`
// and `adapter_status` commands are not wired into providerRuntime.ts yet (no
// caller sends either command today), so this file owns its own defensive
// parsing rather than trusting a shared type that does not exist on the wire
// side yet — every field is optional/untyped on the way in, exactly like
// providerRuntime.ts's own `record`/`text`/`bool` helpers treat the `ready`
// event, and a missing or malformed field degrades to "unknown", never a
// thrown exception or a fabricated value.
// ---------------------------------------------------------------------------

export interface LocalRuntimeReportEndpoint {
  name: string;
  provider: string;
  baseUrl: string;
  installed: boolean;
  running: boolean;
}

export interface LocalRuntimeReport {
  osName: string;
  machine: string;
  isAppleSilicon: boolean;
  hasNvidia: boolean;
  mlxImportable: boolean;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  endpoints: LocalRuntimeReportEndpoint[];
  modelCounts: { ollama: number; huggingFace: number; mlx: number; ds4: number };
  /** Bounded GGUF scan results; a listed path is not claimed to be loaded/reachable. */
  modelFiles: string[];
  recommendation: string;
  setupSuggestions: string[];
}

export interface AdapterStatus {
  configured: boolean;
  path: string | null;
  name: string | null;
  exists: boolean;
  cachedAdapters: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback = ""): string {
  const s = String(value ?? "").trim();
  return s || fallback;
}
function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}
function bool(value: unknown): boolean {
  return value === true;
}
function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => text(v)).filter(Boolean) : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function parsedModelFiles(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(strArray(value));
  const byProvider = record(value);
  return uniqueStrings([
    ...strArray(byProvider.ds4),
    ...strArray(byProvider.pulsar),
    ...strArray(byProvider.gguf),
  ]);
}

/**
 * Parse a `{"cmd":"local_engine_report"}` response body. Returns null both
 * when the report has not arrived yet (`raw` is null/undefined — the caller
 * has not asked, or the async background probe has not answered) and when
 * the kernel explicitly reported failure (`ok:false`) — the panel renders the
 * same honest "not probed yet" state either way rather than guessing which
 * one happened from a half-populated object.
 */
export function parseLocalRuntimeReport(raw: unknown): LocalRuntimeReport | null {
  if (raw === null || raw === undefined) return null;
  const body = record(raw);
  if (body.ok === false) return null;
  const counts = record(body.modelCounts);
  const combinedGgufCount = num(counts.gguf, -1);
  const ds4Count = combinedGgufCount >= 0
    ? combinedGgufCount
    : num(counts.ds4) + num(counts.pulsar);
  return {
    osName: text(body.osName, "unknown"),
    machine: text(body.machine, "unknown"),
    isAppleSilicon: bool(body.isAppleSilicon),
    hasNvidia: bool(body.hasNvidia),
    mlxImportable: bool(body.mlxImportable),
    ollamaInstalled: bool(body.ollamaInstalled),
    ollamaRunning: bool(body.ollamaRunning),
    endpoints: (Array.isArray(body.endpoints) ? body.endpoints : []).map(record).map((e) => ({
      name: text(e.name),
      provider: text(e.provider),
      baseUrl: text(e.baseUrl),
      installed: bool(e.installed),
      running: bool(e.running),
    })),
    modelCounts: {
      ollama: num(counts.ollama),
      huggingFace: num(counts.huggingFace),
      mlx: num(counts.mlx),
      ds4: ds4Count,
    },
    modelFiles: parsedModelFiles(body.modelFiles),
    recommendation: text(body.recommendation),
    setupSuggestions: strArray(body.setupSuggestions),
  };
}

/** Same not-arrived-vs-failed collapse as parseLocalRuntimeReport, for `{"cmd":"adapter_status"}`. */
export function parseAdapterStatus(raw: unknown): AdapterStatus | null {
  if (raw === null || raw === undefined) return null;
  const body = record(raw);
  if (body.ok === false) return null;
  return {
    configured: bool(body.configured),
    path: optionalText(body.path),
    name: optionalText(body.name),
    exists: bool(body.exists),
    cachedAdapters: strArray(body.cachedAdapters),
  };
}

// ---------------------------------------------------------------------------
// Model rows: reachability, context window, and size, reachable-first.
// ---------------------------------------------------------------------------

export interface LocalModelRow {
  /** Model id/path as the engine reports it (e.g. "phi4:14b"). */
  id: string;
  engineName: string;
  /** Whether the engine hosting this model is ready right now. This is
   * engine-level reachability, not per-model verification — the kernel does
   * not load every cached model just to answer a status query. */
  reachable: boolean;
  /** Advertised context window in tokens, or null/absent when genuinely
   * unknown — never guessed from the model name. */
  contextWindow?: number | null;
  /** A pre-formatted size string (e.g. "18 GB", "35B params") from the
   * kernel; this module does no unit conversion of its own. Absent/null
   * means unknown. */
  sizeLabel?: string | null;
}

/**
 * Fallback model rows built from the bare names `providerRuntime.ts` already
 * parses off the `ready` event, for use until a future kernel change reports
 * context window/size per model directly (see this file's `models` prop).
 * Context window and size are always "unknown" here — that is the honest
 * answer for data the kernel has not sent, not a gap in this function.
 */
export function localModelRowsFromEngines(
  engines: readonly LocalEngineSummary[],
): LocalModelRow[] {
  const rows: LocalModelRow[] = [];
  for (const engine of engines) {
    for (const model of engine.models) {
      rows.push({ id: model, engineName: engine.name, reachable: engine.ready });
    }
  }
  return rows;
}

/** Merge bounded DS4/Pulsar GGUF scan paths from ready-state engines and the detailed report. */
export function ds4ModelFilesFromSources(
  report: LocalRuntimeReport | null,
  engines: readonly LocalEngineSummary[],
): string[] {
  const engineFiles = engines
    .filter((engine) => ["ds4", "pulsar"].includes(engine.provider.toLowerCase()))
    .flatMap((engine) => engine.modelFiles);
  return uniqueStrings([...(report?.modelFiles ?? []), ...engineFiles]);
}

/**
 * Reachable models first; ties keep their original relative order (explicit
 * index tiebreaker, matching localOps.ts's rankModelOptions rather than
 * leaning on `Array.prototype.sort`'s stability as the only guarantee).
 */
export function sortLocalModelRows(rows: readonly LocalModelRow[]): LocalModelRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.reachable !== b.row.reachable) return a.row.reachable ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

// ---------------------------------------------------------------------------
// Layout + row formatting
// ---------------------------------------------------------------------------

export type LocalEnginePanelLayout = "wide" | "compact" | "minimal";

export function localEnginePanelLayout(width: number): LocalEnginePanelLayout {
  if (width >= 76) return "wide";
  if (width >= 46) return "compact";
  return "minimal";
}

export function localEnginePanelBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

const ENGINE_STATE_GLYPH: Record<LocalEngineState, string> = {
  ready: "●",
  "not-installed": "○",
  "installed-but-not-running": "◐",
  unknown: "?",
};

function engineColor(state: LocalEngineState, theme: Theme): string {
  if (state === "ready") return theme.success;
  if (state === "installed-but-not-running") return theme.warn;
  return theme.dim;
}

/** One engine row: glyph + explicit state word (never colour alone) + detail + fix command. */
export function engineRowLine(
  row: LocalEnginePanelRow,
  width: number,
  layout: LocalEnginePanelLayout = localEnginePanelLayout(width),
): string {
  const gateway = row.optionalGateway ? " (optional gateway)" : "";
  const fix = layout !== "minimal" && row.fixCommand ? ` · fix: ${row.fixCommand}` : "";
  const line = `${ENGINE_STATE_GLYPH[row.state]} ${row.name} [${row.state}]${gateway} — ${row.detail}${fix}`;
  return truncateToWidth(line, Math.max(1, width));
}

/** One model row: reachability, context window, and size — "unknown" stated in words, never guessed or silently omitted. */
export function localModelRowLine(
  row: LocalModelRow,
  width: number,
  layout: LocalEnginePanelLayout = localEnginePanelLayout(width),
): string {
  const reachWord = row.reachable ? "reachable" : "unreachable";
  const ctx =
    row.contextWindow != null && Number.isFinite(row.contextWindow) && row.contextWindow > 0
      ? `context ${formatTokens(row.contextWindow)}`
      : "context unknown";
  const size = row.sizeLabel?.trim() ? row.sizeLabel.trim() : "size unknown";
  const detail = layout === "minimal" ? reachWord : `${reachWord} · ${ctx} · ${size}`;
  const line = `${row.reachable ? "●" : "○"} ${row.id} · ${row.engineName} — ${detail}`;
  return truncateToWidth(line, Math.max(1, width));
}

/** "darwin/arm64 · Apple Silicon" — never claims a chip family that was not reported. */
export function hardwareSummaryLine(report: LocalRuntimeReport | null): string {
  if (!report) return "hardware: not probed yet";
  const chip = report.isAppleSilicon
    ? "Apple Silicon"
    : report.hasNvidia
      ? "NVIDIA GPU"
      : "no GPU acceleration detected";
  return `${report.osName}/${report.machine} · ${chip}`;
}

/** "no adapter configured" / the active adapter's name, plus a cached count. */
export function adapterSummaryLine(adapter: AdapterStatus | null): string {
  if (!adapter) return "adapter: not probed yet";
  if (!adapter.configured) return "no adapter configured";
  const missing = adapter.exists ? "" : " (file missing)";
  const cached = adapter.cachedAdapters.length
    ? ` · ${adapter.cachedAdapters.length} cached`
    : "";
  return `${adapter.name ?? adapter.path ?? "adapter"}${missing}${cached}`;
}

/**
 * Literal setup commands, problem-engines' fix commands first (most specific
 * to what is actually broken on this machine) then the report's own general
 * suggestions, de-duplicated in that order. Never fabricated — both sources
 * are static repo knowledge (ENGINE_FIX in localOps.ts) or kernel-reported
 * text, never derived from anything this panel guesses.
 */
export function guidedSetupLines(
  report: LocalRuntimeReport | null,
  rows: readonly LocalEnginePanelRow[],
): string[] {
  const fromRows = rows.map((row) => row.fixCommand).filter((cmd): cmd is string => !!cmd);
  const fromReport = report?.setupSuggestions ?? [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of [...fromRows, ...fromReport]) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return lines;
}

const MAX_MODEL_ROWS = 10;
const MAX_MODEL_FILE_ROWS = 6;
const MAX_SETUP_LINES = 6;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface LocalEnginePanelProps {
  theme: Theme;
  width: number;
  /** Local engines as already parsed by providerRuntime.ts's parseReadyRuntime(). */
  engines?: readonly LocalEngineSummary[];
  /** True once the kernel has actually reported local-engine state at least
   * once (e.g. after the first `ready` event). Distinguishes "probed, zero
   * engines configured" from "never asked" — `engines` defaults to `[]` in
   * both cases, so this flag is the only honest way to tell them apart.
   * Defaults to false: the safe assumption is "not probed" until told
   * otherwise, never "probed and fine". */
  probed?: boolean;
  /** Raw `{"cmd":"local_engine_report"}` response body, or undefined/null
   * before it arrives. Parsed via parseLocalRuntimeReport. */
  runtimeReport?: unknown;
  /** Raw `{"cmd":"adapter_status"}` response body, or undefined/null before
   * it arrives. Parsed via parseAdapterStatus. */
  adapterStatus?: unknown;
  /** Optional richer per-model rows (context window/size) once a future
   * kernel change reports them directly; falls back to bare `engines[].models`
   * names (context/size shown as "unknown") when omitted. */
  models?: readonly LocalModelRow[];
  /** The most recent memory-fit refusal to surface inline, when a run just
   * failed that way. */
  memoryFitRefusal?: (MemoryFitRefusal & { modelId?: string }) | null;
}

/**
 * Local-engine operations panel: per-runtime health with an exact fix
 * command, the machine's hardware summary, locally available models
 * (reachable-first, annotated with context window and size), a memory-fit
 * refusal naming a smaller quantisation when one just happened, adapter/LoRA
 * state, and guided-setup commands. Display-only — it never runs a command
 * itself; every setup step is shown as literal text for an operator to copy
 * or approve, matching the confirm-gated install path /config already uses.
 */
export function LocalEnginePanel({
  theme,
  width,
  engines = [],
  probed = false,
  runtimeReport,
  adapterStatus,
  models,
  memoryFitRefusal,
}: LocalEnginePanelProps): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const layout = localEnginePanelLayout(width);
  const borderStyle = localEnginePanelBorderStyle(ax);
  const innerWidth = Math.max(1, width - (ax.screenReader ? 0 : 4));

  const report = parseLocalRuntimeReport(runtimeReport);
  const adapter = parseAdapterStatus(adapterStatus);
  const rows = localEnginePanelRows(engines);
  const modelRows = sortLocalModelRows(models ?? localModelRowsFromEngines(engines));
  const ds4ModelFiles = ds4ModelFilesFromSources(report, engines);
  const ds4EnginePresent = engines.some((engine) =>
    ["ds4", "pulsar"].includes(engine.provider.toLowerCase())
  );
  const ds4ModelFileCount = Math.max(report?.modelCounts.ds4 ?? 0, ds4ModelFiles.length);
  const ds4DisplayedModelFileCount = Math.min(ds4ModelFiles.length, MAX_MODEL_FILE_ROWS);
  const showDs4ModelFiles = ds4EnginePresent || ds4ModelFileCount > 0;
  const setupLines = guidedSetupLines(report, rows);
  const hadProbeRef = React.useRef(probed);
  const animateProbeMount = probed && !hadProbeRef.current;
  React.useEffect(() => {
    hadProbeRef.current = probed;
  }, [probed]);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={borderStyle}
      borderColor={t.border}
      paddingX={ax.screenReader ? 0 : 1}
    >
      <Text color={t.accent} bold>
        Local engines
      </Text>

      {probed ? (
        <Text color={t.dim} wrap="truncate-end">
          <MatrixText
            text={truncateToWidth(summarizeLocalRuntime(engines), innerWidth)}
            animateOnMount={animateProbeMount}
            seed={977}
          />
        </Text>
      ) : (
        <Text color={t.dim}>Not probed yet — run /config status to check.</Text>
      )}
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={truncateToWidth(hardwareSummaryLine(report), innerWidth)}
          animateOnMount={animateProbeMount}
          seed={983}
        />
      </Text>

      {probed ? (
        rows.length === 0 ? (
          <Text color={t.dim}>No local engines detected.</Text>
        ) : (
          <Box flexDirection="column">
            {rows.map((row) => (
              <Text key={row.name} color={engineColor(row.state, t)} wrap="truncate-end">
                {"  "}
                <MatrixText
                  text={engineRowLine(
                    row,
                    Math.max(1, innerWidth - 2),
                    layout,
                  )}
                  animateOnMount={animateProbeMount}
                  seed={row.name.length * 101}
                />
              </Text>
            ))}
          </Box>
        )
      ) : null}

      {layout !== "minimal" ? (
        <>
          <Box height={1} />
          <Text color={t.dim}>
            Models{modelRows.length ? ` (${modelRows.length}, reachable first)` : ""}
          </Text>
          {modelRows.length === 0 ? (
            <Text color={t.dim}>
              {probed ? "No local models detected." : "Not probed yet."}
            </Text>
          ) : (
            <>
              {modelRows.slice(0, MAX_MODEL_ROWS).map((row) => (
                <Text
                  key={`${row.engineName}:${row.id}`}
                  color={row.reachable ? t.text : t.dim}
                  wrap="truncate-end"
                >
                  {"  "}
                  <MatrixText
                    text={localModelRowLine(
                      row,
                      Math.max(1, innerWidth - 2),
                      layout,
                    )}
                    animateOnMount={animateProbeMount}
                    seed={`${row.engineName}:${row.id}`.length * 103}
                  />
                </Text>
              ))}
              {modelRows.length > MAX_MODEL_ROWS ? (
                <Text color={t.dim}>
                  {"  "}
                  {modelRows.length - MAX_MODEL_ROWS} more model(s) not shown
                </Text>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {layout !== "minimal" && showDs4ModelFiles ? (
        <>
          <Box height={1} />
          <Text color={t.dim}>
            DS4 GGUF files{ds4ModelFileCount ? ` (${ds4ModelFileCount} scanned)` : ""}
          </Text>
          {ds4ModelFiles.length === 0 ? (
            <Text color={t.dim}>
              {ds4ModelFileCount
                ? "GGUF paths were not included in this runtime report."
                : "No DS4 GGUF files detected."}
            </Text>
          ) : (
            <>
              {ds4ModelFiles.slice(0, MAX_MODEL_FILE_ROWS).map((modelFile) => (
                <Text key={modelFile} color={t.dim} wrap="truncate-end">
                  {"  "}
                  <MatrixText
                    text={truncateToWidth(
                      `○ ${modelFile} · scanned, not load-verified`,
                      Math.max(1, innerWidth - 2),
                    )}
                    animateOnMount={animateProbeMount}
                    seed={modelFile.length * 107}
                  />
                </Text>
              ))}
              {ds4ModelFileCount > ds4DisplayedModelFileCount ? (
                <Text color={t.dim}>
                  {"  "}
                  {ds4ModelFileCount - ds4DisplayedModelFileCount} more GGUF file(s) not shown
                </Text>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {memoryFitRefusal ? (
        <>
          <Box height={1} />
          <Text color={t.error} wrap="truncate-end">
            ⚠{" "}
            <MatrixText
              text={`${
                memoryFitRefusal.modelId ? `${memoryFitRefusal.modelId}: ` : ""
              }${truncateToWidth(
                describeMemoryFitRefusal(memoryFitRefusal),
                innerWidth,
              )}`}
              animateOnMount
              seed={991}
            />
          </Text>
        </>
      ) : null}

      <Box height={1} />
      <Text color={t.dim}>Adapter</Text>
      <Text color={t.dim} wrap="truncate-end">
        <MatrixText
          text={truncateToWidth(adapterSummaryLine(adapter), innerWidth)}
          animateOnMount={animateProbeMount}
          seed={997}
        />
      </Text>

      {setupLines.length ? (
        <>
          <Box height={1} />
          <Text color={t.dim}>Guided setup</Text>
          {setupLines.slice(0, MAX_SETUP_LINES).map((line, i) => (
            <Text key={i} color={t.dim} wrap="truncate-end">
              {"  $ "}
              <MatrixText
                text={truncateToWidth(line, Math.max(1, innerWidth - 4))}
                animateOnMount={animateProbeMount}
                seed={1009 + i}
              />
            </Text>
          ))}
          <Text color={t.dim} wrap="truncate-end">
            Nothing above runs automatically — copy a command yourself, or approve it if Sophia
            proposes running one.
          </Text>
        </>
      ) : null}
    </Box>
  );
}
