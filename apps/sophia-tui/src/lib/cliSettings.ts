/**
 * Which settings did the OPERATOR actually choose at launch?
 *
 * Same subtlety as `sessionExplicitlyRequested`: `--model`, `--mode` and
 * `--permission` are all declared with defaults, so the parsed flags are always
 * truthy and "was it set?" is always true. Only the raw argv can answer whether
 * the user typed it.
 *
 * This matters because the bridge's `ready` event carries a boot snapshot of the
 * persisted defaults, and the app used to adopt all of it unconditionally — then
 * echo it back with setSettings, writing it to disk. So `sophia --model grok`
 * showed grok for a moment and then silently became whatever was persisted, and
 * the flag was overwritten rather than merely ignored. A value the operator
 * stated on the command line outranks a stale snapshot.
 */

/** Settings the ready snapshot may adopt. "effort" has no CLI flag, so it only
 *  ever becomes owned by an in-session change — but it shares the same rule. */
export type SettingKey =
  | "runtime"
  | "model"
  | "mode"
  | "permission"
  | "effort"
  | "responseStyle"
  | "thinkingVisibility"
  | "conscienceMode"
  | "agiMode"
  | "agiProfile"
  | "agiRoute"
  | "agiPlannerModel"
  | "agiWorkerModel"
  | "agiVerifierModel"
  | "workflowMode"
  | "workflowMaxStages"
  | "workflowMaxAgents"
  | "a2aAgents"
  | "a2aExecution"
  | "terminalLayout"
  | "autoTeam"
  | "team"
  | "deepMode"
  | "semanticFallbackModel"
  | "semanticFallbackPolicy"
  | "semanticReturnToPrimary";

export type WorkflowRoutingMode = "off" | "auto" | "on";

function workflowRoutingMode(
  value: unknown,
  fallback: WorkflowRoutingMode,
): WorkflowRoutingMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "off" || normalized === "auto" || normalized === "on"
    ? normalized
    : fallback;
}

/**
 * Reconcile the mutually-exclusive outer workflow and AGI-workflow settings.
 *
 * An operator-owned launch or in-session choice outranks persisted defaults.
 * If neither setting is owned, AGI-workflow retains the historical precedence
 * because it is the more specific outer controller. This prevents a stale
 * persisted AGI-workflow preference from silently disabling an explicit
 * `--workflow on` launch.
 */
export function reconcileWorkflowRoutingModes(input: {
  currentWorkflow: WorkflowRoutingMode;
  currentAgiWorkflow: WorkflowRoutingMode;
  snapshotWorkflow: unknown;
  snapshotAgiWorkflow: unknown;
  workflowOwned: boolean;
  agiWorkflowOwned: boolean;
}): {
  workflowMode: WorkflowRoutingMode;
  agiWorkflowMode: WorkflowRoutingMode;
} {
  let workflowMode = input.workflowOwned
    ? input.currentWorkflow
    : workflowRoutingMode(input.snapshotWorkflow, input.currentWorkflow);
  let agiWorkflowMode = input.agiWorkflowOwned
    ? input.currentAgiWorkflow
    : workflowRoutingMode(input.snapshotAgiWorkflow, input.currentAgiWorkflow);

  if (workflowMode !== "off" && agiWorkflowMode !== "off") {
    if (input.agiWorkflowOwned) {
      workflowMode = "off";
    } else if (input.workflowOwned) {
      agiWorkflowMode = "off";
    } else {
      workflowMode = "off";
    }
  }
  return { workflowMode, agiWorkflowMode };
}

/** True when launch args/env or an in-session choice own a setting over a ready snapshot. */
export function settingIsOwned(
  key: SettingKey,
  explicit: ReadonlySet<SettingKey>,
  userChanged: ReadonlySet<SettingKey>,
): boolean {
  return explicit.has(key) || userChanged.has(key);
}

/** Return a new ownership snapshot with one in-session choice recorded. */
export function withOwnedSetting(
  owned: ReadonlySet<SettingKey>,
  key: SettingKey,
): Set<SettingKey> {
  const next = new Set(owned);
  next.add(key);
  return next;
}

/** Reconcile a boot snapshot without overwriting an operator-owned live value. */
export function readySettingValue<T>(
  owned: boolean,
  current: T,
  snapshot: T | null | undefined,
): T {
  return owned || snapshot == null ? current : snapshot;
}

/**
 * Keep only settings that the operator owns.
 *
 * Plugin profiles are persisted by CodeBridge before their result reaches the
 * TUI. The UI may correctly preserve an explicit CLI/slash-command value in
 * memory while the durable bridge state still contains the profile value. This
 * helper builds the narrow patch that must be written back after a successful
 * startup profile application. Callers should pass only keys the profile
 * actually proposed, so unrelated durable settings are left untouched.
 */
export function operatorOwnedSettingsPatch(
  values: Readonly<Partial<Record<SettingKey, unknown>>>,
  explicit: ReadonlySet<SettingKey>,
  userChanged: ReadonlySet<SettingKey>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey as SettingKey;
    if (
      value !== undefined
      && settingIsOwned(key, explicit, userChanged)
    ) {
      patch[key] = value;
    }
  }
  return patch;
}

/**
 * Confirm that a CodeBridge state acknowledgement contains every value from a
 * pending operator-owned patch. Extra snapshot keys are expected and ignored.
 */
export function settingsPatchMatchesSnapshot(
  patch: Readonly<Record<string, unknown>>,
  snapshot: unknown,
): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const values = snapshot as Record<string, unknown>;
  return Object.entries(patch).every(([key, value]) => Object.is(values[key], value));
}

/**
 * Return the profile the plugin host says is selected at bridge startup.
 *
 * The ready payload deliberately exposes the plugin host summary rather than
 * copying profile settings into the TUI. Re-applying this reference through
 * CodeBridge keeps PluginHost + CodeBridge as the validation/persistence
 * authority; the UI must not trust and apply manifest settings itself.
 */
export function selectedStartupPluginProfile(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selections = (value as Record<string, unknown>).selections;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    return null;
  }
  const profile = (selections as Record<string, unknown>).profile;
  return typeof profile === "string" && profile.trim() ? profile.trim() : null;
}

/**
 * Initial positional prompts are automation, so they wait for every startup
 * authority that can change the run configuration. In particular, "ready"
 * may report a selected plugin profile whose settings patch has not yet been
 * revalidated and persisted by CodeBridge.
 */
export function initialPromptCanStart(options: {
  initialPrompt?: string;
  bridgeReady: boolean;
  sessionHydrated: boolean;
  startupProfileApplied: boolean;
  alreadySent: boolean;
}): boolean {
  return Boolean(
    options.initialPrompt
    && options.bridgeReady
    && options.sessionHydrated
    && options.startupProfileApplied
    && !options.alreadySent
  );
}

export type UiPermission = "auto" | "manual" | "readonly";

/**
 * The bridge's permission vocabulary, translated to the UI's.
 *
 * `_normalize_permission` canonicalises "", "manual" and "approve" all to
 * **"approve"**, so the bridge can only ever report auto/approve/readonly — it
 * never says "manual". Every guard in the app tested for "manual", so the
 * persisted permission simply never matched and was silently dropped: an
 * operator who set approve-mode elsewhere (or last session) saw the UI ignore
 * it. Returns null for anything unrecognised, so an unknown value leaves the
 * current setting alone rather than guessing.
 */
export function permissionFromBridge(value: unknown): UiPermission | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "approve" || raw === "manual") return "manual";
  if (raw === "auto" || raw === "readonly") return raw;
  return null;
}

/** Flags that consume the NEXT argv token, so that token is a value not a flag. */
const VALUE_FLAGS = new Set([
  "--model", "-m", "--mode", "--permission", "-p", "--session", "-s", "--cwd", "--theme",
  "--conscience",
  "--thinking",
  "--workflow", "--workflow-max-stages", "--workflow-max-agents",
  "--finished-out",
]);

/**
 * Return the first value-taking flag whose value is missing.
 *
 * `meow` applies a declared default when a string flag is left dangling, so a
 * shell command ending in `--permission` used to open a normal-looking TUI in
 * manual mode while silently dropping everything the operator intended to put
 * on the following line. Fail before parsing instead of making a truncated
 * automation command look like a stuck run.
 */
export function missingCliFlagValue(
  argv: readonly string[],
): string | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break;
    if (!VALUE_FLAGS.has(token)) continue;
    const next = argv[i + 1];
    if (next == null || next === "--" || next.startsWith("-")) return token;
    i++;
  }
  return null;
}

/** The tokens that are actually FLAGS, skipping values and anything after `--`. */
function flagTokens(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") break;             // everything after is positional
    if (!tok.startsWith("-")) continue;  // a bare positional
    out.push(tok);
    // `--model grok` consumes "grok"; `--model=grok` consumes nothing. Skipping
    // the value matters because it can itself look like a flag — a prompt or a
    // theme name of "--model" must not read as choosing the model.
    if (VALUE_FLAGS.has(tok) && i + 1 < argv.length) i++;
  }
  return out;
}

function hasFlag(argv: readonly string[], ...names: readonly string[]): boolean {
  return flagTokens(argv).some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/**
 * The setting keys the launch explicitly established, from argv and the env
 * vars index.tsx itself consults when seeding the model.
 *
 * `--mock` counts as choosing the model: it forces "mock" regardless of --model.
 */
export function explicitSettingKeys(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Set<SettingKey> {
  const keys = new Set<SettingKey>();
  if (
    hasFlag(argv, "--model", "-m") ||
    hasFlag(argv, "--mock") ||
    // index.tsx seeds the model from these, so an operator who exported one has
    // chosen just as deliberately as one who typed the flag.
    (env.SOPHIA_MODEL_PROVIDER || "").trim() ||
    (env.SOPHIA_MODEL || "").trim()
  ) {
    keys.add("model");
  }
  if (hasFlag(argv, "--mode")) keys.add("mode");
  if (hasFlag(argv, "--permission", "-p")) keys.add("permission");
  if (hasFlag(argv, "--thinking")) keys.add("thinkingVisibility");
  if (
    hasFlag(argv, "--conscience")
    || (env.SOPHIA_CONSCIENCE_MODE || "").trim()
  ) {
    keys.add("conscienceMode");
  }
  if (
    hasFlag(argv, "--workflow") ||
    (env.SOPHIA_WORKFLOW_MODE || "").trim()
  ) {
    keys.add("workflowMode");
  }
  if (hasFlag(argv, "--workflow-max-stages")) keys.add("workflowMaxStages");
  if (hasFlag(argv, "--workflow-max-agents")) keys.add("workflowMaxAgents");
  return keys;
}
