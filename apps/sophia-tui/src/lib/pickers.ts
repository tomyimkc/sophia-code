/**
 * Option lists for interactive pickers (model, effort, mode, …).
 */
import type { PickerOption } from "../components/OptionPicker.js";

/**
 * Merge the static model presets with the models the bridge discovered
 * locally (MLX/Ollama/vLLM/DS4 caches + cloud options). Discovered models whose
 * alias is already a static preset value are deduped away (the preset's label
 * wins). Pure — unit-tested.
 *
 * Without this, a locally-cached model like `mlx:mlx-community/Qwen3.6-35B-A3B-4bit`
 * never appears in the /model picker even though the bridge detected it and can
 * run it — the picker previously showed only its hardcoded static preset list.
 */
export function mergeModelOptions(
  base: PickerOption[],
  discovered: { alias: string; label?: string; setup?: string; group?: ModelGroupId }[],
): PickerOption[] {
  if (!discovered.length) return base;
  const seen = new Set(base.map((o) => o.value));
  const added: PickerOption[] = [];
  for (const m of discovered) {
    const value = String(m.alias || "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    added.push({
      value,
      label: value,
      hint: m.setup || m.label,
      ...(m.group ? { groupId: m.group } : {}),
    });
  }
  return added.length ? [...base, ...added] : base;
}

export type ModelGroupId =
  | "ollama"
  | "vllm"
  | "ds4"
  | "mlx"
  | "gateway"
  | "claude"
  | "cloud"
  | "cli"
  | "other";

export interface ModelPickerRow extends PickerOption {
  kind: "group" | "option";
  groupId: ModelGroupId;
  expanded?: boolean;
  optionCount?: number;
}

const MODEL_GROUPS: ReadonlyArray<{ id: ModelGroupId; label: string }> = [
  { id: "ollama", label: "Ollama" },
  { id: "vllm", label: "vLLM" },
  { id: "ds4", label: "DS4 / Pulsar" },
  { id: "mlx", label: "oMLX / legacy MLX" },
  { id: "gateway", label: "Local gateways" },
  { id: "claude", label: "Claude gateways" },
  { id: "cloud", label: "Cloud APIs" },
  { id: "cli", label: "CLI backends" },
  { id: "other", label: "Other" },
];

const VLLM_PRESETS = new Set(["vllm", "qwen3.6-35b", "qwen3.6", "qwen36-local"]);
const CLAUDE_PRESETS = new Set([
  "anthropic",
  "teamorouter",
  "aipro",
  "aipro-2",
]);
const CLI_PRESETS = new Set([
  "codex",
  "codex-terra",
  "codex-luna",
  "codex-fugu",
  "fugu",
  "grok",
  "grok-cli",
  "openclaw",
]);

export function modelGroupForOption(
  option: Pick<PickerOption, "value" | "groupId">,
): ModelGroupId {
  if (option.groupId) return option.groupId;
  const value = option.value.trim().toLowerCase();
  if (value === "ollama" || value.startsWith("ollama:")) return "ollama";
  if (VLLM_PRESETS.has(value) || value.startsWith("vllm:")) return "vllm";
  if (
    value === "ds4" ||
    value === "pulsar" ||
    value.startsWith("ds4:") ||
    value.startsWith("pulsar:")
  ) return "ds4";
  if (value === "omlx" || value === "mlx" || value.startsWith("mlx:")) return "mlx";
  if (value === "qwen-coding" || value === "codex-api") return "gateway";
  if (CLAUDE_PRESETS.has(value) || value.startsWith("anthropic:")) return "claude";
  if (CLI_PRESETS.has(value) || value.startsWith("codex:") || value.startsWith("grok:")) return "cli";
  if (value === "mock") return "other";
  return "cloud";
}

export function groupModelOptions(
  options: PickerOption[],
  expandedGroups: ReadonlySet<ModelGroupId> | readonly ModelGroupId[],
): ModelPickerRow[] {
  const expanded = expandedGroups instanceof Set
    ? expandedGroups
    : new Set<ModelGroupId>(expandedGroups);
  const grouped = new Map<ModelGroupId, PickerOption[]>();
  for (const option of options) {
    const groupId = modelGroupForOption(option);
    const bucket = grouped.get(groupId) || [];
    bucket.push(option);
    grouped.set(groupId, bucket);
  }
  const rows: ModelPickerRow[] = [];
  for (const group of MODEL_GROUPS) {
    const bucket = grouped.get(group.id);
    if (!bucket?.length) continue;
    const isExpanded = expanded.has(group.id);
    rows.push({
      kind: "group",
      groupId: group.id,
      value: `__model_group__:${group.id}`,
      label: group.label,
      hint: `${bucket.length} model${bucket.length === 1 ? "" : "s"}`,
      expanded: isExpanded,
      optionCount: bucket.length,
    });
    if (isExpanded) {
      rows.push(...bucket.map((option) => ({
        ...option,
        kind: "option" as const,
        groupId: group.id,
      })));
    }
  }
  return rows;
}

export function toggleModelGroup(
  expandedGroups: readonly ModelGroupId[],
  groupId: ModelGroupId,
): ModelGroupId[] {
  return expandedGroups.includes(groupId)
    ? expandedGroups.filter((id) => id !== groupId)
    : [...expandedGroups, groupId];
}

export function modelPickerSelectionIndex(
  rows: ModelPickerRow[],
  currentModel: string,
): number {
  const exact = rows.findIndex((row) => row.kind === "option" && row.value === currentModel);
  if (exact >= 0) return exact;
  const currentGroup = modelGroupForOption({ value: currentModel });
  const header = rows.findIndex((row) => row.kind === "group" && row.groupId === currentGroup);
  return Math.max(0, header);
}

export const MODEL_OPTIONS: PickerOption[] = [
  { value: "omlx", label: "oMLX", hint: "OpenAI-compatible local MLX server · native Sophia tools · :8000" },
  { value: "mlx", label: "Legacy MLX", hint: "Direct in-process mlx-lm runtime · text-only model transport" },
  { value: "ds4", label: "DS4", hint: "DGX Spark local ds4-server · OpenAI-compatible · GGUF" },
  { value: "pulsar", label: "Pulsar", hint: "Legacy pulsar-server compatibility alias · OpenAI-compatible · GGUF" },
  { value: "qwen3.6-35b", label: "qwen3.6-35b", hint: "Local Qwen3.6-35B-A3B vLLM :8000" },
  { value: "qwen3.6", label: "qwen3.6", hint: "Local Qwen3.6-35B alias" },
  { value: "qwen36-local", label: "qwen36-local", hint: "Local Qwen3.6-35B alias" },
  { value: "vllm", label: "vllm", hint: "Local vLLM OpenAI server :8000" },
  { value: "zai", label: "zai", hint: "z.ai GLM-5.2 (Anthropic-compat)" },
  { value: "glm-5.2", label: "glm-5.2", hint: "z.ai GLM-5.2 alias" },
  { value: "qwen-coding", label: "qwen-coding", hint: "Qwen 3.8 Coding Plan (sub) :8789" },
  // REMOVED, because they resolved to nothing: qwen-coding-plan, qwen-token,
  // qwen-token-plan, qwen-team, qwen-flash. None is a preset in
  // agent/model.py, so picking one raised "unknown model provider" at run time
  // — the picker was advertising five models the app could not run.
  // tests/test_picker_values_resolve.py now fails if an entry without a
  // matching preset is added back. If these aliases ARE wanted, the fix is a
  // preset each (pointing at the intended endpoint), not a picker row.
  { value: "qwen", label: "qwen", hint: "DashScope cloud (DASHSCOPE_API_KEY)" },
  { value: "codex", label: "Codex · GPT-5.6 Sol", hint: "Official ChatGPT subscription via Codex CLI · delegated read-only transport" },
  { value: "codex-terra", label: "Codex · GPT-5.6 Terra", hint: "Official ChatGPT subscription via Codex CLI · pragmatic workhorse" },
  { value: "codex-luna", label: "Codex · GPT-5.6 Luna", hint: "Official ChatGPT subscription via Codex CLI · faster repeatable work" },
  { value: "codex-api", label: "codex-api", hint: "Codex proxy :8788" },
  { value: "mock", label: "mock", hint: "offline deterministic" },
  { value: "teamorouter", label: "teamorouter", hint: "Claude Opus 5 · TEAMOROUTER_API_KEY · Sonnet 5 ultra workers" },
  { value: "aipro", label: "aipro · option 1", hint: "option 1 · Opus 5 main · Sonnet 5 subagents · SOPHIA_AIPRO_KEY" },
  { value: "aipro-2", label: "aipro · option 2", hint: "option 2 · Opus 5 main · Sonnet 5 subagents · SOPHIA_AIPRO_KEY_2" },
  { value: "anthropic", label: "anthropic", hint: "Claude API / base_url" },
  { value: "openai", label: "openai", hint: "OpenAI cloud" },
  { value: "020s", label: "020s", hint: "020s cloud · gpt-5.6-sol (SOPHIA_020S_KEY)" },
  { value: "020s-luna", label: "020s-luna", hint: "020s cloud · gpt-5.6-luna (SOPHIA_020S_KEY)" },
  { value: "020s-terra", label: "020s-terra", hint: "020s cloud · gpt-5.6-terra (SOPHIA_020S_KEY)" },
  { value: "020s-terra2", label: "020s-terra2", hint: "020s cloud · gpt-5.6-terra (key 2)" },
  { value: "020s-terra3", label: "020s-terra3", hint: "020s cloud · gpt-5.6-terra (key 3)" },
  { value: "grok", label: "grok", hint: "Grok CLI" },
  { value: "deepseek", label: "deepseek", hint: "DeepSeek API" },
  { value: "ollama", label: "ollama", hint: "local Ollama" },
];

export type Effort = "low" | "medium" | "high" | "ultramode";

const EFFORT_ALIASES: Record<string, Effort> = {
  min: "low",
  minimum: "low",
  med: "medium",
  default: "medium",
  max: "ultramode",
  ultra: "ultramode",
  xhigh: "ultramode",
  ultracode: "ultramode",
};

export function normalizeEffort(value: unknown): Effort | null {
  const raw = String(value ?? "").trim().toLowerCase();
  const normalized = EFFORT_ALIASES[raw] ?? raw;
  return normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "ultramode"
    ? normalized
    : null;
}

export function effortLabel(value: unknown): string {
  return normalizeEffort(value) === "ultramode" ? "ultra" : normalizeEffort(value) ?? "medium";
}

export const EFFORT_OPTIONS: PickerOption[] = [
  { value: "low", label: "low", hint: "faster, shorter reasoning" },
  { value: "medium", label: "medium", hint: "default Sophia operating contract" },
  { value: "high", label: "high", hint: "stronger verification + thinking" },
  { value: "ultramode", label: "ultra", hint: "Sophia Ultramode + maximum effort" },
];

export const MODE_OPTIONS: PickerOption[] = [
  { value: "logical", label: "logical", hint: "deterministic, precise" },
  { value: "precise", label: "precise", hint: "careful verification" },
  { value: "balanced", label: "balanced", hint: "default middle ground" },
  { value: "creative", label: "creative", hint: "idea generation" },
  { value: "divergent", label: "divergent", hint: "max exploration" },
];

export type ResponseStyle = "adaptive" | "concise" | "explanatory" | "structured";

export const RESPONSE_STYLE_OPTIONS: PickerOption[] = [
  { value: "adaptive", label: "adaptive", hint: "match detail and structure to the request" },
  { value: "concise", label: "concise", hint: "lead with the answer and keep it brief" },
  { value: "explanatory", label: "explanatory", hint: "include reasoning and useful context" },
  { value: "structured", label: "structured", hint: "organize the answer into clear sections" },
];

export const PERMISSION_OPTIONS: PickerOption[] = [
  { value: "auto", label: "auto", hint: "tools run without prompts" },
  { value: "manual", label: "manual", hint: "approve write/bash" },
  { value: "readonly", label: "readonly", hint: "block write/exec" },
];

export const THEME_OPTIONS: PickerOption[] = [
  { value: "dark", label: "dark", hint: "Sophia dark terminal palette" },
  { value: "light", label: "light", hint: "light terminal" },
  { value: "mono", label: "mono", hint: "no color" },
];

export const THINKING_OPTIONS: PickerOption[] = [
  { value: "hidden", label: "hidden", hint: "show no provider-visible thinking rows" },
  { value: "summary", label: "summary", hint: "show a 240-char bound of provider-visible events" },
  { value: "stream", label: "stream", hint: "stream up to 800 chars of provider-visible events" },
  { value: "full", label: "full", hint: "show live thinking tokens and completed reports without a char cap (default)" },
];

export const KEYMAP_OPTIONS: PickerOption[] = [
  { value: "default", label: "default", hint: "portable Sophia terminal bindings" },
  { value: "emacs", label: "emacs", hint: "common Emacs-compatible editing chords" },
  { value: "vim", label: "vim", hint: "explicit insert/normal mode editing" },
];

export const LOGIN_OPTIONS: PickerOption[] = [
  { value: "grok", label: "Grok", hint: "xAI subscription · official `grok login` opens the browser" },
  { value: "codex", label: "Codex", hint: "ChatGPT subscription · official `codex login` opens the browser" },
];

export const IMAGE_PROVIDER_OPTIONS: PickerOption[] = [
  { value: "none", label: "none", hint: "image generation disabled" },
  { value: "grok-cli", label: "grok-cli", hint: "delegate to the locally configured Grok CLI; approval still required" },
  { value: "openai", label: "openai", hint: "OpenAI image API via saved OPENAI_API_KEY" },
];

// The two /bench modes offered by the interactive picker (see App.tsx bench flow
// + kernel _handle_bench). 'knowledge' is the prose Q&A corpus; 'tool-use' drives
// each model through the real Sophia tool loop and scores the S1-S6 tool-use skills.
export const BENCH_MODE_OPTIONS: PickerOption[] = [
  { value: "knowledge", label: "knowledge corpus", hint: "prose Q&A across the 7 domains" },
  { value: "tool-use", label: "tool-use (S1–S6 + speed)", hint: "decision-to-call, selection, args, grounding, recovery" },
];

export type PickerKind =
  | "model"
  | "effort"
  | "mode"
  | "responseStyle"
  | "permission"
  | "theme"
  | "benchMode"
  | "thinking"
  | "keymap"
  | "imageProvider"
  | "login";

export function optionsFor(kind: PickerKind): PickerOption[] {
  switch (kind) {
    case "model":
      return MODEL_OPTIONS;
    case "effort":
      return EFFORT_OPTIONS;
    case "mode":
      return MODE_OPTIONS;
    case "responseStyle":
      return RESPONSE_STYLE_OPTIONS;
    case "permission":
      return PERMISSION_OPTIONS;
    case "theme":
      return THEME_OPTIONS;
    case "benchMode":
      return BENCH_MODE_OPTIONS;
    case "thinking":
      return THINKING_OPTIONS;
    case "keymap":
      return KEYMAP_OPTIONS;
    case "imageProvider":
      return IMAGE_PROVIDER_OPTIONS;
    case "login":
      return LOGIN_OPTIONS;
  }
}

/**
 * Move a selection index by `delta` positions, WRAPPING at both ends: Down
 * past the last row goes to the first row, and Up past the first goes to
 * the last. WRAP (not clamp) is the convention already used everywhere a
 * list is navigated in this app — the slash-command menu, this
 * model/effort/mode/theme/permission picker, and the session-resume picker
 * — so this makes that one shared rule a single tested function instead of
 * three hand-rolled `(i + delta + n) % n` copies in App.tsx. Unlike the
 * inline copies, this is safe for an empty list: `% 0` is `NaN` in
 * JavaScript, which is what let the session-resume picker's Up/Down handler
 * get permanently stuck on a `NaN/0` selection when there were zero saved
 * sessions (see OptionPicker's empty-options branch for the render-side
 * half of that fix). Also tolerates a non-finite `current` (e.g. an
 * already-NaN'd selection) by treating it as 0, so it self-heals.
 */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const safeCurrent = Number.isFinite(current) ? current : 0;
  return (((safeCurrent + delta) % length) + length) % length;
}

/**
 * Shared scroll-window math for every scrollable picker (slash-command
 * menu, model/effort/mode/theme/permission picker, session-resume picker):
 * given the total item count and which index is selected, decide the
 * visible [start, end) slice and clamp `selected` into range at the same
 * time. Returning the clamped `index` alongside the window means a caller
 * that highlights row `i === index` (instead of the raw, possibly
 * out-of-range `selected` prop) can never end up with a highlight that
 * points outside the rendered window — including the single render tick
 * between a filter keystroke shrinking the list and the caller's own
 * selection-reset effect running, and including a non-finite `selected`
 * (NaN, from an unguarded `% 0` upstream).
 */
export function windowFor(
  total: number,
  selected: number,
  maxVisible: number,
): { start: number; end: number; index: number } {
  if (total <= 0) return { start: 0, end: 0, index: 0 };
  const safeSelected = Number.isFinite(selected) ? selected : 0;
  const index = Math.min(Math.max(0, safeSelected), total - 1);
  const size = Math.max(3, Math.min(maxVisible, total));
  if (total <= size) return { start: 0, end: total, index };
  let start = Math.max(0, index - Math.floor(size / 2));
  let end = start + size;
  if (end > total) {
    end = total;
    start = Math.max(0, end - size);
  }
  return { start, end, index };
}

export function titleFor(kind: PickerKind): string {
  switch (kind) {
    case "model":
      return "Select model";
    case "effort":
      return "Select effort";
    case "mode":
      return "Select response mode";
    case "responseStyle":
      return "Select response style";
    case "permission":
      return "Select permission mode";
    case "theme":
      return "Select theme";
    case "benchMode":
      return "Select benchmark mode";
    case "thinking":
      return "Select thinking visibility";
    case "keymap":
      return "Select keymap";
    case "imageProvider":
      return "Select image provider";
    case "login":
      return "Sign in to a subscription provider";
  }
}
