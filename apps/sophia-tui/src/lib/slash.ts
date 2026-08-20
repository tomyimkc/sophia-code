/**
 * Sophia-native slash, help, handler, and product-default metadata.
 * Data is generated from agent/slash_catalog.py.
 */
import { createRequire } from "node:module";

export type SlashClient = "tui" | "terminal";
export type SlashExecutionState = "implemented_local" | "prompt" | "info" | "unsupported";

export interface SlashArgument {
  name: string;
  value_type: string;
  required: boolean;
  choices: string[];
  rest: boolean;
}

export interface SlashArgumentSchema {
  usage: string;
  min_args: number;
  max_args: number | null;
  positionals: SlashArgument[];
  examples: string[];
  custom_parser: boolean;
}

export interface ClientExecution {
  execution_state: SlashExecutionState;
  handler: string;
  handler_names: string[];
  note: string;
}

export interface SlashHelp {
  usage: string;
  category_id: string;
  category_label: string;
  badges: string[];
  availability: SlashExecutionState;
  note: string;
  deprecated_aliases: string[];
}

export interface SlashCategory {
  id: string;
  label: string;
  description: string;
}

export interface ProductDefaultValue {
  mode: string;
  value: string | null;
  runtime_permission?: string;
}

export interface ProductProfile {
  label: string;
  audience: string;
  model: ProductDefaultValue;
  authority: ProductDefaultValue;
  dispatch: ProductDefaultValue;
  image_generation: ProductDefaultValue;
  configurable: boolean;
}

export interface ProductDefaults {
  schema: "sophia.product-defaults.v1";
  runtime_binding: string;
  profile_order: string[];
  profiles: Record<string, ProductProfile>;
  candidateOnly: true;
  canClaimAGI: false;
  edition_ids?: string[];
  defaultEdition?: "oss" | "full";
  editionUnavailableTemplate?: string;
}

export interface SlashCatalog {
  version: number;
  hash: string;
  source: string;
  canClaimAGI: false;
  commands: SlashCommand[];
  category_metadata: SlashCategory[];
  clients: Record<SlashClient, {
    label: string;
    retired_handlers: Record<string, string[]>;
  }>;
  product_defaults: ProductDefaults;
}

export interface SlashCommand {
  name: string;
  slash: string;
  description: string;
  category: string;
  kind: string;
  support_state?: "supported" | "unsupported";
  execution_state?: SlashExecutionState;
  client_execution?: Partial<Record<SlashClient, ClientExecution>>;
  aliases?: string[];
  deprecated_aliases?: string[];
  badges?: string[];
  hint?: string;
  arguments?: SlashArgumentSchema;
  help?: SlashHelp;
  collapse_chat?: boolean;
  prompt_template?: string;
  editions?: string[];
}

const require = createRequire(import.meta.url);
const catalog = require("./slash-commands.json") as SlashCatalog;
if (
  catalog.canClaimAGI !== false ||
  catalog.product_defaults?.canClaimAGI !== false ||
  !catalog.hash ||
  catalog.version < 3
) {
  throw new Error("Invalid slash catalog metadata");
}
const CATALOG_COMMANDS: SlashCommand[] = catalog.commands || [];
const CATEGORY_LABELS = new Map(
  (catalog.category_metadata || []).map((category) => [category.id, category.label]),
);

export type ProductEdition = "oss" | "full";

export function activeEdition(): ProductEdition {
  const env = String(process.env.SOPHIA_EDITION || "").trim().toLowerCase();
  if (env === "oss" || env === "full") return env;
  const baked = String(catalog.product_defaults?.defaultEdition || "full").toLowerCase();
  return baked === "oss" ? "oss" : "full";
}

function commandInEdition(command: SlashCommand, edition: ProductEdition): boolean {
  const editions = command.editions?.length ? command.editions : ["oss", "full"];
  return editions.includes(edition);
}

export function commandsForEdition(edition: ProductEdition): SlashCommand[] {
  return CATALOG_COMMANDS.filter((command) => commandInEdition(command, edition));
}

function visibleCommands(): SlashCommand[] {
  return commandsForEdition(activeEdition());
}

export function allCommands(): SlashCommand[] {
  return visibleCommands();
}

export function editionAllowsCommand(name: string): boolean {
  const n = String(name || "").replace(/^\//, "").toLowerCase();
  if (!n) return true;
  const command = CATALOG_COMMANDS.find(
    (entry) =>
      entry.name === n ||
      (entry.aliases || []).map((alias) => alias.toLowerCase()).includes(n),
  );
  if (!command) return true;
  return commandInEdition(command, activeEdition());
}

export function editionUnavailableMessage(name: string): string {
  const template =
    catalog.product_defaults?.editionUnavailableTemplate ||
    "/{name} is not part of Sophia Code (open edition). It remains in the full Sophia TUI. No action was taken.";
  return template.replace("{name}", String(name || "").replace(/^\//, ""));
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS.get(category) || category;
}

export function clientExecutionFor(
  command: SlashCommand,
  client: SlashClient = "tui",
): ClientExecution {
  const declared = command.client_execution?.[client];
  if (declared) return declared;
  const state =
    command.execution_state ||
    (command.support_state === "unsupported"
      ? "unsupported"
      : command.kind === "prompt"
        ? "prompt"
        : "info");
  return { execution_state: state, handler: "", handler_names: [], note: "" };
}

export function commandUsage(command: SlashCommand): string {
  return command.arguments?.usage || command.help?.usage || command.hint || command.slash || `/${command.name}`;
}

export function commandBadges(
  command: SlashCommand,
  client: SlashClient = "tui",
): string[] {
  if (client === "tui" && command.help?.badges?.length) return [...command.help.badges];
  const state = clientExecutionFor(command, client).execution_state;
  const primary =
    state === "implemented_local"
      ? "local"
      : state === "prompt"
        ? "agent"
        : state === "unsupported"
          ? "unavailable"
          : "info";
  const badges = [primary, ...(command.badges || [])];
  if (command.deprecated_aliases?.length) badges.push("legacy-alias");
  return [...new Set(badges)];
}

export function commandAcceptsArguments(command: SlashCommand): boolean {
  if (command.arguments) return command.arguments.max_args === null || command.arguments.max_args > 0;
  const hint = command.hint || "";
  return hint.includes("[") || hint.includes("<") || hint.includes("|");
}

export function clientHandlerRegistry(client: SlashClient): Record<string, string[]> {
  const handlers = new Map<string, Set<string>>();
  for (const command of CATALOG_COMMANDS) {
    const execution = clientExecutionFor(command, client);
    if (execution.execution_state !== "implemented_local" || !execution.handler) continue;
    const names = handlers.get(execution.handler) || new Set<string>();
    for (const name of execution.handler_names || []) names.add(name);
    handlers.set(execution.handler, names);
  }
  return Object.fromEntries(
    [...handlers.entries()].map(([handler, names]) => [handler, [...names].sort()]),
  );
}

export function clientRegistryParity(
  client: SlashClient,
  observed: Record<string, Iterable<string>>,
): Record<string, { missing: string[]; extra: string[] }> {
  const declared = clientHandlerRegistry(client);
  const retired = catalog.clients?.[client]?.retired_handlers || {};
  const handlers = new Set([...Object.keys(declared), ...Object.keys(observed)]);
  const result: Record<string, { missing: string[]; extra: string[] }> = {};
  for (const handler of [...handlers].sort()) {
    const expected = new Set(declared[handler] || []);
    const actual = new Set(observed[handler] || []);
    const allowedRetired = new Set(retired[handler] || []);
    result[handler] = {
      missing: [...expected].filter((name) => !actual.has(name)).sort(),
      extra: [...actual]
        .filter((name) => !expected.has(name) && !allowedRetired.has(name))
        .sort(),
    };
  }
  return result;
}

export function productDefaults(): ProductDefaults {
  return catalog.product_defaults;
}

export function productProfile(profile: string): ProductProfile | null {
  return catalog.product_defaults.profiles[profile] || null;
}

export function productProfileSummary(profile: string): string {
  const value = productProfile(profile);
  if (!value) return `unknown product profile: ${profile}`;
  const render = (field: ProductDefaultValue) => field.value || field.mode;
  return [
    value.label,
    `model=${render(value.model)}`,
    `authority=${render(value.authority)}`,
    `dispatch=${render(value.dispatch)}`,
    `image=${render(value.image_generation)}`,
  ].join(" · ");
}

/**
 * Relevance tier for one command against a typed `body` (already lowercased),
 * checked across the canonical name AND every alias — an alias-only hit must
 * be scored on its own merits, not on whatever `c.name` happens to be. (The
 * previous sort computed "starts with" against `c.name` alone even though the
 * filter step matched on name-or-alias, so an alias-only prefix hit could be
 * mis-ranked against a name hit of the same nominal tier; see
 * "ranks an alias-only prefix hit the same as a name hit" in slash.test.ts.)
 *
 *   0 = exact name or alias
 *   1 = name or alias prefix (startsWith) — what the old filter alone did
 *   2 = substring elsewhere in the name or an alias (typo/partial tolerance,
 *       e.g. "/review" also surfacing "security-review")
 *   null = no match, excluded
 *
 * Deliberately stops at substring — no fuzzy/subsequence tier. A command
 * palette this size (~90 entries) would turn a true fuzzy matcher (e.g.
 * "characters appear in order") into mostly noise for 1-2 char queries, and
 * nothing in this catalog needs typo-across-a-hyphen tolerance today. Do not
 * claim "fuzzy" support anywhere without actually adding and testing that
 * tier.
 */
function matchTier(names: string[], body: string): 0 | 1 | 2 | null {
  let best: 0 | 1 | 2 | null = null;
  for (const n of names) {
    if (n === body) return 0; // can't improve on exact; short-circuit
    const tier: 0 | 1 | 2 | null = n.startsWith(body) ? 1 : n.includes(body) ? 2 : null;
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/**
 * Pure ranking core behind `suggest()`, exported separately so the tier
 * scheme (matchTier, above) can be unit-tested against small synthetic
 * command lists without depending on what happens to be in the generated
 * catalog today.
 */
export function rankSlashMatches(commands: SlashCommand[], body: string): SlashCommand[] {
  const scored: { cmd: SlashCommand; tier: 0 | 1 | 2 }[] = [];
  for (const c of commands) {
    const names = [c.name, ...(c.aliases || [])].map((n) => String(n).toLowerCase());
    const tier = matchTier(names, body);
    if (tier !== null) scored.push({ cmd: c, tier });
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.cmd.name.length - b.cmd.name.length || a.cmd.name.localeCompare(b.cmd.name);
  });
  return scored.map((s) => s.cmd);
}

/**
 * Progressive filter over the full catalog.
 * - `/` alone → every command (caller may window the display)
 * - `/mo` → model, mode, …
 * Pass `limit: 0` or omit a small limit to get all matches.
 */
export function suggest(prefix: string, limit = 0): SlashCommand[] {
  let p = (prefix || "").trim().toLowerCase();
  if (!p.startsWith("/") && p !== "") p = "/" + p;
  let matches: SlashCommand[];
  const pool = visibleCommands();
  if (p === "" || p === "/") {
    matches = [...pool];
  } else {
    const head = p.split(/\s+/)[0] || "/";
    const body = head.startsWith("/") ? head.slice(1) : head;
    matches = rankSlashMatches(pool, body);
  }
  if (limit > 0) return matches.slice(0, limit);
  return matches;
}

/** Commands that open a sub-option picker when run without arguments. */
export const PICKER_COMMAND_KINDS = {
  model: "model",
  effort: "effort",
  mode: "mode",
  permissions: "permission",
  permission: "permission",
  theme: "theme",
  login: "login",
} as const;

export type PickerCommandName = keyof typeof PICKER_COMMAND_KINDS;

export function pickerKindFor(name: string): (typeof PICKER_COMMAND_KINDS)[PickerCommandName] | null {
  return PICKER_COMMAND_KINDS[name as PickerCommandName] ?? null;
}

export const PICKER_SLASH_COMMANDS = new Set(Object.keys(PICKER_COMMAND_KINDS));

export function resolve(
  line: string,
): { cmd: SlashCommand | null; name: string; args: string } {
  const text = (line || "").trim();
  if (!text.startsWith("/")) return { cmd: null, name: "", args: "" };
  const body = text.slice(1);
  if (!body) return { cmd: null, name: "", args: "" };
  const separator = body.search(/\s/);
  const rawName = separator < 0 ? body : body.slice(0, separator);
  const name = (rawName || "").toLowerCase();
  const args = separator < 0 ? "" : body.slice(separator).trim();
  const cmd =
    visibleCommands().find(
      (c) =>
        c.name === name ||
        (c.aliases || []).map((a) => a.toLowerCase()).includes(name),
    ) || null;
  return { cmd, name: cmd?.name || name, args };
}

/**
 * Local settings that are safe to apply as one pasted block.
 *
 * This is intentionally narrower than every ``implemented_local`` command.
 * Commands such as /image, /update, /goal, and diagnostic prompt commands may
 * start work, write files, or require confirmation; batching them would make
 * ordering and approval ambiguous.
 */
const BATCH_SAFE_SLASH_COMMANDS = new Set([
  "a2a",
  "brief",
  "color",
  "conscience",
  "deepmode",
  "effort",
  "fallback-model",
  "fast",
  "mode",
  "model",
  "notifications",
  "output-style",
  "permissions",
  "runtime",
  "temperature",
  "terminals",
  "theme",
  "thinking",
  "team",
  "workflow",
  "top-k",
  "top-p",
  "vim",
]);

export type SlashCommandPastePlan =
  | { kind: "batch"; commands: string[] }
  | { kind: "reject"; reason: string }
  | null;

/**
 * Recognize a pasted multi-line slash-command block before the first command
 * can swallow every later line as one free-form argument.
 *
 * Without this preflight, `/model codex\n/runtime sophia` becomes one malformed
 * model alias and fails before any provider call. A normal prompt beginning
 * with prose is left untouched.
 */
export function planSlashCommandPaste(raw: string): SlashCommandPastePlan {
  if (!/[\r\n]/.test(raw || "")) return null;
  const commands = (raw || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (commands.length < 2 || !commands[0]?.startsWith("/")) return null;
  if (commands.some((line) => !line.startsWith("/"))) {
    return {
      kind: "reject",
      reason:
        "multi-line input starts with a slash command but also contains prompt text; " +
        "submit the slash command block and the prompt separately",
    };
  }

  for (const command of commands) {
    const resolved = resolve(command);
    if (!resolved.cmd) {
      return {
        kind: "reject",
        reason: `cannot batch unknown slash command: /${resolved.name || "?"}`,
      };
    }
    if (!BATCH_SAFE_SLASH_COMMANDS.has(resolved.name)) {
      return {
        kind: "reject",
        reason:
          `/${resolved.name} is not a batch-safe local setting; ` +
          "run it separately after the settings block",
      };
    }
  }
  return { kind: "batch", commands };
}

/**
 * Decide what gets submitted when the user presses Enter while the slash menu is
 * open. This is the PURE decision extracted from App.tsx:onSlashEnterSelect so
 * the "typed /resume name is preserved" contract can be unit-tested without
 * rendering <App> (which spawns a real bridge subprocess with no DI seam).
 *
 * Rule (matches onSlashEnterSelect exactly):
 *   1. If the typed line starts with "/" and already resolves to a known
 *      command, submit the TYPED line verbatim — this preserves args like
 *      `/resume tui-default`. (Without this, the menu highlight would win and
 *      the args would be dropped.)
 *   2. Otherwise submit the highlighted (or first) menu match's slash form.
 *   3. If neither resolves, return null (caller falls back to onSubmit).
 */
export function chooseSlashSubmission(
  typed: string,
  matches: SlashCommand[],
  selectedIndex: number,
): string | null {
  const line = (typed || "").trim();
  if (line.startsWith("/")) {
    const { cmd } = resolve(line);
    if (cmd) return line;
  }
  if (!matches.length) return null;
  const c = matches[selectedIndex] || matches[0];
  if (!c) return null;
  return c.slash || "/" + c.name;
}

/**
 * Decide what Tab completion writes into the input line while the slash menu
 * is open. This is the PURE decision extracted from App.tsx:applySlashSelection
 * so Tab and Enter (chooseSlashSubmission, above) can be proven coherent: both
 * fall back to `matches[0]` on a stale/out-of-range `selectedIndex`, and Enter
 * right after a Tab-completion resolves the exact line Tab just wrote (locked
 * by the "tab then enter" test in slash.test.ts).
 *
 * Rule (matches applySlashSelection exactly):
 *   1. No match at `selectedIndex` or index 0 → return the input unchanged.
 *   2. Otherwise replace the command token with the match's canonical slash
 *      form, preserving any already-typed argument text after the first
 *      space (`rest`).
 *   3. If there is no `rest` yet and the exported argument schema accepts an
 *      argument, append a trailing space so the next keystroke starts the
 *      argument instead of running the command name together with it.
 *      Legacy synthetic test fixtures without a schema still fall back to the
 *      old hint markers.
 */
export function completeSlashSelection(
  currentInput: string,
  matches: SlashCommand[],
  selectedIndex: number,
): string {
  const c = matches[selectedIndex] || matches[0];
  if (!c) return currentInput;
  const slash = c.slash || "/" + c.name;
  const rest = currentInput.includes(" ") ? currentInput.slice(currentInput.indexOf(" ")) : "";
  const needsSpace = !rest && commandAcceptsArguments(c);
  return slash + (rest || (needsSpace ? " " : ""));
}

export function unsupportedMessage(name: string, client = "TUI"): string {
  return `/${name} is listed but is not implemented in this ${client} yet. No action was taken.`;
}

export function expandPromptCommand(cmd: SlashCommand, args: string): string {
  const tpl =
    cmd.prompt_template ||
    `Handle the /${cmd.name} request. Args: {args}`;
  const value = args || "(see repository state)";
  // A FUNCTION replacement, not a string one. With a string, JS interprets
  // `$&`, "$`", `$'` and `$$` inside the REPLACEMENT — i.e. inside whatever the
  // operator typed. Measured on the old code:
  //   "cost $& more"  -> "cost {args} more"     (their text replaced by the token)
  //   "a $` b"        -> "a Review this:  b"    (template text LEAKED into theirs)
  //   "x $' y"        -> "x  y"                 (text silently dropped)
  // `$` is ordinary in shell commands, prices and regexes, so this quietly
  // rewrote the goal actually sent to the model. A function replacement is
  // substituted verbatim and has no such syntax.
  return tpl.replace(/\{args\}/g, () => value);
}
