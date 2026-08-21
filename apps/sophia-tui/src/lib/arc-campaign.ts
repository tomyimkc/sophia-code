/**
 * Read-only ARC-AGI campaign projections for the Sophia TUI.
 *
 * The operator flow deliberately exposes only `status --json` and
 * `plan --contest ... --json`. It never shells out, never submits, never starts
 * public evaluation, and never sends a stop/cancel signal to a sealed run.
 * Output is projected through a small allowlist so arbitrary CLI JSON (or a
 * diagnostic containing credentials) is not copied into the transcript.
 */
import { execFile } from "node:child_process";
import {
  pythonCommandLine,
  resolvePythonLaunch,
  type PythonLaunch,
} from "./pythonResolver.js";

export type ArcContest = "arc-agi-2" | "arc-agi-3";
export type ArcViewKind = "status" | "plan";
export type ArcHeartbeatState = "fresh" | "stale" | "stalled" | "missing" | "unknown";
export type ArcSubmissionGateState = "ready" | "blocked" | "unknown";

export interface ArcProgress {
  completed: number | null;
  total: number | null;
  percent: number | null;
  label: string;
}

export interface ArcGateView {
  id: string;
  passed: boolean | null;
  detail: string;
}

export interface ArcPlanStepView {
  index: number;
  id: string;
  title: string;
  dependsOn: string[];
  maxSteps: number | null;
  executionAuthorized: boolean;
}

export interface ArcCampaignView {
  contest: ArcContest;
  kind: ArcViewKind;
  campaignId: string;
  candidateId: string;
  phase: string;
  state: string;
  verdict: string;
  hypothesis: string;
  candidateOnly: true;
  candidatePolicyValid: boolean;
  submissionGate: ArcSubmissionGateState;
  submissionBlockers: string[];
  progress: ArcProgress;
  heartbeatState: ArcHeartbeatState;
  heartbeatDetail: string;
  stalled: boolean;
  stallReason: string;
  pidObserved: boolean;
  pidLabel: string;
  gates: ArcGateView[];
  planSteps: ArcPlanStepView[];
  budgetDetail: string;
  note: string;
}

export interface ArcCampaignQuery {
  kind: ArcViewKind;
  contest?: ArcContest;
}

export interface ArcCampaignPanelState {
  phase: "loading" | "ready" | "error";
  query: ArcCampaignQuery;
  command: string;
  views: ArcCampaignView[];
  error: string;
  loadedAt: string;
}

export type ArcSlashIntent =
  | { action: "query"; query: ArcCampaignQuery }
  | { action: "copy"; command: string }
  | { action: "close" }
  | { action: "help" }
  | { action: "invalid"; reason: string };

export interface ArcCommandResult {
  stdout: string;
  stderr: string;
}

export type ArcCommandExecutor = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number },
) => Promise<ArcCommandResult>;

const MAX_JSON_BYTES = 1_000_000;
const COMMAND_TIMEOUT_MS = 12_000;

/**
 * The displayed/executed ARC campaign prefix follows the shared Python
 * resolver: `python3` on POSIX, the probed `python`/`py -3` on win32, and an
 * explicit `SOPHIA_PYTHON`/`PYTHON` override everywhere.
 */
function arcPythonLaunch(): PythonLaunch {
  return resolvePythonLaunch(process.env);
}

function arcCommandForQuery(query: ArcCampaignQuery): string {
  const launch = arcPythonLaunch();
  return pythonCommandLine(launch, arcCommandArgs(query));
}

function statusCommand(): string {
  return arcCommandForQuery({ kind: "status" });
}

const CONTEST_ALIASES: Record<ArcContest, string[]> = {
  "arc-agi-2": ["arc-agi-2", "arc_agi_2", "arc2", "arc-2", "2"],
  "arc-agi-3": ["arc-agi-3", "arc_agi_3", "arc3", "arc-3", "3"],
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstDefined(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "ready") return true;
    if (normalized === "false" || normalized === "no" || normalized === "blocked") return false;
  }
  return null;
}

/**
 * Redact common credential shapes and remove terminal controls before any CLI
 * diagnostic or selected text reaches the TUI.
 */
export function sanitizeArcText(value: unknown, maxLength = 320): string {
  const raw = String(value ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(
      /\b(api[_-]?key|access[_-]?key|secret|token|password|authorization)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return raw.length > maxLength ? `${raw.slice(0, Math.max(0, maxLength - 1))}…` : raw;
}

function text(value: unknown, fallback = ""): string {
  return sanitizeArcText(value) || fallback;
}

function stringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => {
      const row = record(item);
      return text(row.id ?? row.gateId ?? row.gate_id ?? row.reason ?? row.description ?? item);
    })
    .filter(Boolean);
}

export function normalizeArcContest(value: string): ArcContest | null {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  for (const contest of Object.keys(CONTEST_ALIASES) as ArcContest[]) {
    if (CONTEST_ALIASES[contest].includes(normalized)) return contest;
  }
  return null;
}

export function arcContestLabel(contest: ArcContest): "ARC2" | "ARC3" {
  return contest === "arc-agi-2" ? "ARC2" : "ARC3";
}

export function arcCommandFor(query: ArcCampaignQuery): string {
  if (query.kind === "status") return statusCommand();
  if (!query.contest) throw new Error("ARC plan command requires a contest");
  return arcCommandForQuery({ kind: "plan", contest: query.contest });
}

export function arcCommandArgs(query: ArcCampaignQuery): string[] {
  if (query.kind === "status") return ["-m", "agent.arc_campaign", "status", "--json"];
  if (!query.contest) throw new Error("ARC plan command requires a contest");
  return [
    "-m",
    "agent.arc_campaign",
    "plan",
    "--contest",
    query.contest,
    "--json",
  ];
}

export function arcOperatorCommands(): string[] {
  return [
    statusCommand(),
    arcCommandFor({ kind: "plan", contest: "arc-agi-2" }),
    arcCommandFor({ kind: "plan", contest: "arc-agi-3" }),
  ];
}

export function parseArcSlashArgs(args: string): ArcSlashIntent {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = (parts.shift() || "status").toLowerCase();
  if (action === "status") {
    if (parts.length) {
      return { action: "invalid", reason: "status takes no contest; it reports both ARC2 and ARC3" };
    }
    return { action: "query", query: { kind: "status" } };
  }
  if (action === "plan") {
    const contest = normalizeArcContest(parts.shift() || "");
    if (!contest || parts.length) {
      return { action: "invalid", reason: "plan requires exactly one contest: arc2 or arc3" };
    }
    return { action: "query", query: { kind: "plan", contest } };
  }
  if (action === "copy") {
    const target = (parts.shift() || "status").toLowerCase();
    if (target === "status" && !parts.length) {
      return { action: "copy", command: statusCommand() };
    }
    if (target === "plan") {
      const contest = normalizeArcContest(parts.shift() || "");
      if (contest && !parts.length) {
        return { action: "copy", command: arcCommandFor({ kind: "plan", contest }) };
      }
    }
    return {
      action: "invalid",
      reason: "copy usage: /arc copy status | /arc copy plan arc2|arc3",
    };
  }
  if (action === "close") return parts.length
    ? { action: "invalid", reason: "close takes no arguments" }
    : { action: "close" };
  if (action === "help") return { action: "help" };

  // Explicitly reject the tempting dangerous verbs instead of letting them
  // become agent prompts or undocumented aliases.
  if (["submit", "run", "eval", "evaluate", "public-eval", "stop", "cancel", "kill"].includes(action)) {
    return {
      action: "invalid",
      reason: `/${action} is outside the read-only ARC operator flow`,
    };
  }
  return {
    action: "invalid",
    reason: "usage: /arc status | plan arc2|arc3 | copy status|plan <contest> | close",
  };
}

function contestMatches(value: unknown, contest: ArcContest): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  return CONTEST_ALIASES[contest].includes(normalized);
}

function contestRow(rootValue: unknown, contest: ArcContest): Record<string, unknown> {
  const root = record(rootValue);
  const containers = [
    root,
    record(root.contests),
    record(root.campaigns),
    record(root.status),
    record(root.plans),
    record(root.data),
  ];
  for (const container of containers) {
    for (const alias of CONTEST_ALIASES[contest]) {
      const found = container[alias] ?? container[alias.replaceAll("-", "_")];
      if (found && typeof found === "object") return record(found);
    }
  }
  for (const value of [
    ...array(root.contests),
    ...array(root.campaigns),
    ...array(root.plans),
    ...array(root.data),
  ]) {
    const row = record(value);
    if (contestMatches(row.contest ?? row.name ?? row.id, contest)) return row;
  }
  if (contestMatches(root.contest ?? root.name, contest)) return root;
  return {};
}

function progressFrom(sources: readonly Record<string, unknown>[]): ArcProgress {
  const completed = finite(firstDefined(sources, [
    "completed",
    "completedUnits",
    "completed_units",
    "completedPairs",
    "completed_pairs",
    "done",
  ]));
  const total = finite(firstDefined(sources, [
    "total",
    "expected",
    "expectedUnits",
    "expected_units",
    "expectedPairs",
    "expected_pairs",
    "maxUnits",
    "max_units",
  ]));
  const explicitPercent = finite(firstDefined(sources, ["percent", "progressPercent", "progress_percent"]));
  const percent =
    explicitPercent !== null
      ? Math.max(0, Math.min(100, explicitPercent))
      : completed !== null && total !== null && total > 0
        ? Math.max(0, Math.min(100, (completed / total) * 100))
        : null;
  const label =
    completed !== null && total !== null
      ? `${completed}/${total}${percent !== null ? ` · ${percent.toFixed(percent % 1 ? 1 : 0)}%` : ""}`
      : percent !== null
        ? `${percent.toFixed(percent % 1 ? 1 : 0)}%`
        : "not reported";
  return { completed, total, percent, label };
}

function heartbeatFrom(
  sources: readonly Record<string, unknown>[],
  nowMs: number,
): {
  state: ArcHeartbeatState;
  detail: string;
  stalled: boolean;
  reason: string;
} {
  const explicitStalled = bool(firstDefined(sources, ["stalled", "isStalled", "is_stalled"])) === true;
  const stateWord = text(firstDefined(sources, ["heartbeatState", "heartbeat_state", "liveness", "health"])).toLowerCase();
  const reason = text(firstDefined(sources, ["stallReason", "stall_reason", "blockedReason", "blocked_reason"]));
  if (explicitStalled || stateWord === "stalled") {
    return { state: "stalled", detail: reason || "runner reported stalled", stalled: true, reason };
  }
  const ageSeconds = finite(firstDefined(sources, [
    "heartbeatAgeSeconds",
    "heartbeat_age_seconds",
    "secondsSinceHeartbeat",
    "seconds_since_heartbeat",
  ]));
  const intervalSeconds = finite(firstDefined(sources, [
    "heartbeatSeconds",
    "heartbeat_seconds",
    "heartbeatIntervalSeconds",
    "heartbeat_interval_seconds",
  ]));
  const heartbeatAt = firstDefined(sources, [
    "lastHeartbeat",
    "last_heartbeat",
    "heartbeatAt",
    "heartbeat_at",
    "lastHeartbeatAt",
    "last_heartbeat_at",
  ]);
  let derivedAge = ageSeconds;
  if (derivedAge === null && heartbeatAt !== undefined) {
    const parsed = Date.parse(String(heartbeatAt));
    if (Number.isFinite(parsed)) derivedAge = Math.max(0, (nowMs - parsed) / 1000);
  }
  if (derivedAge !== null) {
    const staleAfter = Math.max(30, (intervalSeconds ?? 15) * 2);
    const state: ArcHeartbeatState = derivedAge > staleAfter ? "stale" : "fresh";
    return {
      state,
      detail: `${Math.round(derivedAge)}s ago${intervalSeconds !== null ? ` · expected every ${intervalSeconds}s` : ""}`,
      stalled: state === "stale",
      reason: state === "stale" ? reason || `heartbeat exceeded ${Math.round(staleAfter)}s threshold` : reason,
    };
  }
  if (heartbeatAt !== undefined) {
    return { state: "unknown", detail: text(heartbeatAt, "unparseable timestamp"), stalled: false, reason };
  }
  const heartbeatPresent = bool(firstDefined(sources, ["heartbeat", "heartbeatPresent", "heartbeat_present"]));
  if (heartbeatPresent === false) {
    return { state: "missing", detail: "no heartbeat receipt", stalled: false, reason };
  }
  if (stateWord === "fresh" || stateWord === "healthy" || stateWord === "live") {
    return { state: "fresh", detail: stateWord, stalled: false, reason };
  }
  if (stateWord === "stale") {
    return { state: "stale", detail: stateWord, stalled: true, reason };
  }
  return { state: "unknown", detail: "not reported", stalled: false, reason };
}

function gateViews(value: unknown): ArcGateView[] {
  const rows = array(value);
  return rows.slice(0, 8).map((item, index) => {
    if (typeof item === "string") {
      return { id: text(item, `gate-${index + 1}`), passed: null, detail: "" };
    }
    const row = record(item);
    return {
      id: text(row.gateId ?? row.gate_id ?? row.id ?? row.name, `gate-${index + 1}`),
      passed: bool(row.passed ?? row.ok ?? row.ready),
      detail: text(row.description ?? row.detail ?? row.reason),
    };
  });
}

function planStepViews(value: unknown): ArcPlanStepView[] {
  return array(value).slice(0, 8).map((item, offset) => {
    const row = record(item);
    const role = record(row.role);
    const scope = record(role.scope);
    const phaseRequest = record(row.agiPhaseRequest ?? row.agi_phase_request);
    return {
      index: finite(row.index) ?? offset + 1,
      id: text(row.id ?? role.id, `specialist-${offset + 1}`),
      title: text(role.title ?? row.title),
      dependsOn: stringArray(row.dependsOn ?? row.depends_on, 8),
      maxSteps: finite(scope.maxSteps ?? scope.max_steps ?? phaseRequest.maxSteps ?? phaseRequest.max_steps),
      // Missing or malformed authorization is treated as non-authorizing.
      executionAuthorized: bool(row.executionAuthorized ?? row.execution_authorized) === true,
    };
  });
}

function budgetLine(sources: readonly Record<string, unknown>[]): string {
  const wall = finite(firstDefined(sources, ["maxWallSeconds", "max_wall_seconds", "wallClockSec"]));
  const unit = finite(firstDefined(sources, ["maxUnitSeconds", "max_unit_seconds"]));
  const units = finite(firstDefined(sources, ["maxUnits", "max_units"]));
  const heartbeat = finite(firstDefined(sources, ["heartbeatSeconds", "heartbeat_seconds"]));
  const parts = [
    wall !== null ? `wall ${wall}s` : "",
    unit !== null ? `unit ${unit}s` : "",
    units !== null ? `${units} units max` : "",
    heartbeat !== null ? `heartbeat ${heartbeat}s` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function projectContest(
  root: unknown,
  contest: ArcContest,
  kind: ArcViewKind,
  nowMs: number,
): ArcCampaignView {
  const row = contestRow(root, contest);
  const reported = record(row.reported);
  const campaign = record(row.campaign);
  const plan = record(row.plan);
  const candidate = record(row.candidate);
  const progress = record(row.progress ?? reported.progress);
  const heartbeat = record(row.heartbeat ?? reported.heartbeat);
  const submission = record(row.submissionGate ?? row.submission_gate ?? row.submission);
  const budget = record(row.computeBudget ?? row.compute_budget ?? plan.computeBudget ?? plan.compute_budget);
  const sources = [row, reported, campaign, plan, candidate, progress, heartbeat, submission, budget];
  const candidateFlag = bool(firstDefined(sources, ["candidateOnly", "candidate_only"]));
  const blockers = stringArray(
    firstDefined(sources, ["blockers", "submissionBlockers", "submission_blockers"]),
  );
  const authorized = bool(firstDefined(sources, [
    "authorized",
    "authorizes",
    "submissionAuthorized",
    "submission_authorized",
    "ready",
  ]));
  const authorizationVerified = bool(firstDefined(sources, [
    "authorizationVerified",
    "authorization_verified",
    "receiptVerified",
    "receipt_verified",
  ])) === true;
  const submissionGate: ArcSubmissionGateState =
    authorized === true && authorizationVerified && blockers.length === 0
      ? "ready"
      : authorized !== null || blockers.length > 0
        ? "blocked"
        : "unknown";
  const heartbeatView = heartbeatFrom(sources, nowMs);
  const pid = finite(firstDefined(sources, ["pid", "processId", "process_id", "runnerPid", "runner_pid"]));
  const gates = gateViews(firstDefined(sources, [
    "gates",
    "promotionGates",
    "promotion_gates",
    "gateResults",
    "gate_results",
  ]));
  const planSteps = planStepViews(row.nodes ?? plan.nodes);
  return {
    contest,
    kind,
    campaignId: text(
      firstDefined(sources, ["campaignId", "campaign_id", "id"]),
      kind === "plan" ? `${contest} dormant plan` : "not reported",
    ),
    candidateId: text(firstDefined(sources, ["candidateId", "candidate_id"]), "not reported"),
    phase: text(firstDefined(sources, ["phase"]), kind === "plan" ? "plan" : "not reported"),
    state: text(firstDefined(sources, ["state", "status", "runState", "run_state"]), "not reported"),
    verdict: text(firstDefined(sources, ["verdict"]), "not reported"),
    hypothesis: text(firstDefined(sources, ["hypothesis", "summary", "description"])),
    candidateOnly: true,
    // Missing policy evidence is not equivalent to a valid candidate-only
    // receipt.  The view must fail closed rather than cosmetically upgrading
    // an arbitrary status JSON document.
    candidatePolicyValid: candidateFlag === true,
    submissionGate,
    submissionBlockers: blockers,
    progress: progressFrom(sources),
    heartbeatState: heartbeatView.state,
    heartbeatDetail: heartbeatView.detail,
    stalled: heartbeatView.stalled,
    stallReason: heartbeatView.reason,
    pidObserved: pid !== null && pid > 0,
    pidLabel: pid !== null && pid > 0 ? String(Math.floor(pid)) : "",
    gates,
    planSteps,
    budgetDetail: budgetLine(sources),
    note: text(firstDefined(sources, ["note", "operatorNote", "operator_note"])),
  };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("ARC campaign CLI returned empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }
    throw new Error("ARC campaign CLI did not return valid JSON");
  }
}

export function projectArcCampaignJson(
  raw: unknown,
  query: ArcCampaignQuery,
  nowMs = Date.now(),
): ArcCampaignView[] {
  if (query.kind === "plan") {
    if (!query.contest) throw new Error("ARC plan projection requires a contest");
    return [projectContest(raw, query.contest, "plan", nowMs)];
  }
  return [
    projectContest(raw, "arc-agi-2", "status", nowMs),
    projectContest(raw, "arc-agi-3", "status", nowMs),
  ];
}

export function arcViewBadges(view: ArcCampaignView): string[] {
  const candidate = view.candidatePolicyValid
    ? "CANDIDATE-ONLY"
    : "CANDIDATE POLICY INVALID";
  return [
    candidate,
    `SUBMISSION-GATE: ${view.submissionGate.toUpperCase()}`,
  ];
}

export function arcCampaignViewLines(view: ArcCampaignView): string[] {
  const lines = [
    `${arcContestLabel(view.contest)} · ${arcViewBadges(view).map((badge) => `[${badge}]`).join(" ")}`,
    `campaign: ${view.campaignId} · phase=${view.phase} · state=${view.state} · verdict=${view.verdict}`,
    `progress: ${view.progress.label}`,
    `heartbeat: ${view.heartbeatState} · ${view.heartbeatDetail}`,
  ];
  if (view.stalled) {
    lines.push(`stall: ${view.stallReason || "heartbeat/progress evidence is stale"}`);
  }
  if (view.pidObserved) {
    lines.push(`process: PID ${view.pidLabel} observed · PID presence is liveness evidence only, never success`);
  } else {
    lines.push("process: no PID reported · success requires terminal receipts and passing gates");
  }
  if (view.kind === "plan") {
    if (view.candidateId !== "not reported") lines.push(`candidate: ${view.candidateId}`);
    if (view.hypothesis) lines.push(`hypothesis: ${view.hypothesis}`);
    if (view.budgetDetail) lines.push(`budget: ${view.budgetDetail}`);
    if (view.planSteps.length) {
      const totalMaxSteps = view.planSteps.reduce(
        (sum, step) => sum + (step.maxSteps ?? 0),
        0,
      );
      lines.push(
        `specialist plan: ${view.planSteps.length} bounded steps${totalMaxSteps ? ` · ${totalMaxSteps} aggregate max agent steps` : ""}`,
      );
      for (const step of view.planSteps) {
        const dependencies = step.dependsOn.length ? step.dependsOn.join(", ") : "none";
        const bound = step.maxSteps !== null ? ` · maxSteps=${step.maxSteps}` : "";
        const authorization = step.executionAuthorized ? "EXECUTION AUTHORIZED" : "EXECUTION DISABLED";
        lines.push(
          `  ${step.index}. ${step.id}${step.title ? ` (${step.title})` : ""} · deps=${dependencies}${bound} · ${authorization}`,
        );
      }
    } else {
      lines.push("specialist plan: not reported");
    }
    if (view.gates.length) {
      lines.push("promotion gates:");
      for (const gate of view.gates) {
        const mark = gate.passed === true ? "PASS" : gate.passed === false ? "FAIL" : "PENDING";
        lines.push(`  ${mark} · ${gate.id}${gate.detail ? ` — ${gate.detail}` : ""}`);
      }
    } else {
      lines.push("promotion gates: not reported");
    }
  }
  if (view.submissionBlockers.length) {
    lines.push(`submission blockers: ${view.submissionBlockers.join(", ")}`);
  } else if (view.submissionGate !== "ready") {
    lines.push("submission blockers: not enumerated; gate remains non-authorizing");
  }
  if (view.note) lines.push(`note: ${view.note}`);
  return lines;
}

async function defaultExecutor(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number },
): Promise<ArcCommandResult> {
  return await new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: "utf8",
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = sanitizeArcText(stderr || error.message, 500);
          reject(new Error(detail || "ARC campaign CLI failed"));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function loadingArcCampaignPanel(query: ArcCampaignQuery): ArcCampaignPanelState {
  return {
    phase: "loading",
    query,
    command: arcCommandFor(query),
    views: [],
    error: "",
    loadedAt: "",
  };
}

export async function loadArcCampaignPanel(
  query: ArcCampaignQuery,
  cwd: string,
  executor: ArcCommandExecutor = defaultExecutor,
): Promise<ArcCampaignPanelState> {
  const command = arcCommandFor(query);
  const launch = arcPythonLaunch();
  try {
    const result = await executor(launch.command, [...launch.preArgs, ...arcCommandArgs(query)], {
      cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_JSON_BYTES,
    });
    const raw = parseJsonOutput(result.stdout);
    return {
      phase: "ready",
      query,
      command,
      views: projectArcCampaignJson(raw, query),
      error: "",
      loadedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      phase: "error",
      query,
      command,
      views: [],
      error: sanitizeArcText(error instanceof Error ? error.message : error, 500),
      loadedAt: new Date().toISOString(),
    };
  }
}
