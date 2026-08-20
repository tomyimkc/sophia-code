/**
 * A2A dispatch state for the right-hand Agents panel.
 *
 * Kernel events (a2a_chain_start / a2a_agent_start / a2a_agent_end /
 * a2a_handoff / a2a_chain_end) fold into this pure reducer. Historical
 * parallel-lane receipts remain separate (teamLanes.ts).
 */

export type A2AAgentStatus =
  | "idle"
  | "disconnected"
  | "queued"
  | "queued_for_model"
  | "spawning"
  | "running"
  | "waiting_input"
  | "auth_required"
  | "verifying"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost"
  | "needs_reconciliation"
  | "skipped"
  | "unstarted";

export interface A2AAgent {
  id?: string;
  name: string;
  index: number;
  status: A2AAgentStatus;
  active: boolean;
  summary: string;
  role?: string;
  /** Role-library persona id (not the chain slot main|sub|verify). */
  persona?: string;
  personaName?: string;
  personaVia?: string;
  skills?: string[];
  skillVia?: string[];
  allowedTools?: string[];
  toolScopeVia?: string;
  source?: string;
  protocol?: string;
  connected?: boolean;
  description?: string;
  version?: string;
  endpoint?: string;
  capabilities?: Record<string, unknown>;
  supportedInterfaces?: {
    url: string;
    protocolBinding: string;
    protocolVersion: string;
  }[];
  securitySchemes?: string[];
  currentTaskId?: string;
  currentTool?: string;
  tokenUsage?: Record<string, number>;
  lastActivityAt?: string;
  /** Dynamic-workflow stage inferred from the durable task board. */
  workflowStage?: number;
  /** Actionable terminal detail recovered from a task/result receipt. */
  failureReason?: string;
}

export interface A2AOrchestrationTask {
  id: string;
  subject: string;
  description: string;
  state: string;
  terminal: boolean;
  ownerId: string;
  blockedBy: string[];
  blocks: string[];
  doneCriteria: string[];
  expectedOutput: string;
  stage?: number;
  summary: string;
  artifacts: { name: string; kind: string; uri: string }[];
  updatedAt: string;
}

export type A2AMessageKind =
  | "human"
  | "coordinator"
  | "worker_result"
  | "peer"
  | "system"
  | "task_notification";

export interface A2AOrchestrationMessage {
  id: string;
  kind: A2AMessageKind;
  sender: string;
  recipient: string;
  taskId: string;
  summary: string;
  body: string;
  artifacts: { name: string; kind: string; uri: string }[];
  trusted: boolean;
  unread: boolean;
  createdAt: string;
}

export interface A2AOrchestrationState {
  schema: string;
  session: string;
  runId: string;
  mode: string;
  version: number;
  updatedAt: string;
  coordinatorId: string;
  agents: A2AAgent[];
  tasks: A2AOrchestrationTask[];
  messages: A2AOrchestrationMessage[];
}

export interface A2AState {
  enabled: boolean;
  /** Current-stage and non-terminal agents shown in the compact live roster. */
  agents: A2AAgent[];
  /** Terminal agents from prior workflow stages, retained for detail/history. */
  archivedAgents?: A2AAgent[];
  activeName: string;
  handoffPreview: string;
  orchestration?: A2AOrchestrationState;
  dispatchManifest?: {
    schema: string;
    path: string;
    version: number;
    status: string;
    phase: string;
    dispatch: Record<string, unknown>;
  };
}

export const EMPTY_A2A_STATE: A2AState = {
  enabled: false,
  agents: [],
  archivedAgents: [],
  activeName: "",
  handoffPreview: "",
};

export type A2AEvent = { type: string } & Record<string, unknown>;

function asStatus(value: unknown): A2AAgentStatus {
  const raw = String(value || "").toLowerCase().replace(/-/g, "_");
  if (
    !raw
    || raw === "unstarted"
    || raw === "never_started"
    || raw === "not_started"
    || raw === "unknown"
  ) {
    return "unstarted";
  }
  const aliases: Record<string, A2AAgentStatus> = {
    working: "running",
    completed: "succeeded",
    canceled: "cancelled",
  };
  const s = aliases[raw] || raw;
  const known: A2AAgentStatus[] = [
    "idle",
    "disconnected",
    "queued",
    "queued_for_model",
    "spawning",
    "running",
    "waiting_input",
    "auth_required",
    "verifying",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "lost",
    "needs_reconciliation",
    "skipped",
    "unstarted",
  ];
  if (known.includes(s as A2AAgentStatus)) {
    return s as A2AAgentStatus;
  }
  return "unstarted";
}

function unnamedA2AAgent(index: number): A2AAgent {
  return {
    name: `Unnamed agent ${index + 1}`,
    index,
    status: "unstarted",
    active: false,
    summary: "nameless or malformed agent row",
  };
}

function parseAgent(raw: unknown, fallbackIndex: number): A2AAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return unnamedA2AAgent(fallbackIndex);
  }
  const row = raw as Record<string, unknown>;
  const name = String(row.name || "").trim()
    || `Unnamed agent ${fallbackIndex + 1}`;
  const nameless = !String(row.name || "").trim();
  const index = Number.isFinite(Number(row.index))
    ? Math.max(0, Math.floor(Number(row.index)))
    : fallbackIndex;
  const skillsRaw = row.skills;
  const skills = Array.isArray(skillsRaw)
    ? skillsRaw.map((s) => String(s || "").trim()).filter(Boolean)
    : undefined;
  const status = nameless ? "unstarted" : asStatus(row.status);
  const activeStates: A2AAgentStatus[] = [
    "spawning",
    "running",
    "waiting_input",
    "auth_required",
    "verifying",
    "cancelling",
  ];
  return {
    id: String(row.id || "").trim() || undefined,
    name,
    index,
    status,
    active: row.active === true || activeStates.includes(status),
    summary: String(row.summary || "").trim(),
    role: String(row.role || "").trim() || undefined,
    persona: String(row.persona || row.personaId || "").trim() || undefined,
    personaName: String(row.personaName || "").trim() || undefined,
    personaVia: String(row.personaVia || "").trim() || undefined,
    skills: skills && skills.length ? skills : undefined,
    skillVia: stringList(row.skillVia),
    allowedTools: stringList(row.allowedTools),
    toolScopeVia: String(row.toolScopeVia || "").trim() || undefined,
    source: String(row.source || "").trim() || undefined,
    protocol: String(row.protocol || "").trim() || undefined,
    connected: typeof row.connected === "boolean" ? row.connected : undefined,
    description: String(row.description || "").trim() || undefined,
    version: String(row.version || "").trim() || undefined,
    endpoint: String(row.endpoint || "").trim() || undefined,
    capabilities:
      row.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities)
        ? (row.capabilities as Record<string, unknown>)
        : undefined,
    supportedInterfaces: Array.isArray(row.supportedInterfaces)
      ? row.supportedInterfaces.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          return [{
            url: String(entry.url || "").trim(),
            protocolBinding: String(entry.protocolBinding || "").trim(),
            protocolVersion: String(entry.protocolVersion || "").trim(),
          }];
        })
      : undefined,
    securitySchemes: stringList(row.securitySchemes),
    currentTaskId: String(row.currentTaskId || "").trim() || undefined,
    currentTool: String(row.currentTool || "").trim() || undefined,
    tokenUsage:
      row.tokenUsage && typeof row.tokenUsage === "object" && !Array.isArray(row.tokenUsage)
        ? Object.fromEntries(
            Object.entries(row.tokenUsage as Record<string, unknown>)
              .filter(([, value]) => Number.isFinite(Number(value)))
              .map(([key, value]) => [key, Number(value)]),
          )
        : undefined,
    lastActivityAt: String(row.lastActivityAt || "").trim() || undefined,
  };
}

function parseAgents(raw: unknown): A2AAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: A2AAgent[] = [];
  raw.forEach((item, i) => {
    const agent = parseAgent(item, i);
    if (agent) out.push(agent);
  });
  return out;
}

const TERMINAL_AGENT_STATES = new Set<A2AAgentStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "needs_reconciliation",
  "skipped",
  "unstarted",
]);

const FAILED_AGENT_STATES = new Set<A2AAgentStatus>([
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "needs_reconciliation",
  "skipped",
  "unstarted",
]);

function genericProgressSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized
    || normalized === "model result"
    || normalized === "provider progress"
    || normalized === "provider activity"
    || normalized === "worker progress"
  );
}

function workflowStageFromAgent(agent: A2AAgent): number | undefined {
  const raw = agent.capabilities?.workflowStage;
  return Number.isFinite(Number(raw))
    ? Math.max(1, Math.floor(Number(raw)))
    : undefined;
}

function enrichOrchestrationAgents(
  agents: A2AAgent[],
  tasks: A2AOrchestrationTask[],
  messages: A2AOrchestrationMessage[],
): A2AAgent[] {
  return agents.map((agent) => {
    const ownedTasks = tasks.filter((task) =>
      (agent.currentTaskId && task.id === agent.currentTaskId)
      || (agent.id && task.ownerId === agent.id)
    );
    const task = ownedTasks.at(-1);
    const workerMessage = messages.slice().reverse().find((message) =>
      message.kind === "worker_result"
      && (
        (task?.id && message.taskId === task.id)
        || message.sender === agent.name
      )
    );
    const actionable = [
      task?.summary || "",
      workerMessage?.body || "",
      workerMessage?.summary || "",
    ].find((value) => !genericProgressSummary(value));
    const stage = task?.stage || workflowStageFromAgent(agent);
    const failed = FAILED_AGENT_STATES.has(agent.status);
    return {
      ...agent,
      currentTaskId: agent.currentTaskId || task?.id,
      workflowStage: stage,
      summary:
        genericProgressSummary(agent.summary) && actionable
          ? actionable
          : agent.summary,
      failureReason: failed && actionable ? actionable : agent.failureReason,
    };
  });
}

function partitionWorkflowAgents(
  orchestration: A2AOrchestrationState,
): { current: A2AAgent[]; archived: A2AAgent[] } {
  if (orchestration.mode !== "workflow") {
    return { current: orchestration.agents, archived: [] };
  }
  const stages = orchestration.tasks
    .map((task) => task.stage)
    .filter((stage): stage is number => stage != null);
  if (!stages.length) return { current: orchestration.agents, archived: [] };
  const activeStages = orchestration.tasks
    .filter((task) => !task.terminal && task.stage != null)
    .map((task) => task.stage as number);
  const currentStage = Math.max(...(activeStages.length ? activeStages : stages));
  const archived = orchestration.agents.filter((agent) =>
    agent.workflowStage != null
    && agent.workflowStage < currentStage
    && TERMINAL_AGENT_STATES.has(agent.status)
  );
  const archivedIds = new Set(archived.map((agent) => agent.id || agent.name));
  return {
    current: orchestration.agents.filter(
      (agent) => !archivedIds.has(agent.id || agent.name),
    ),
    archived,
  };
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function parseArtifacts(
  raw: unknown,
): { name: string; kind: string; uri: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      name: String(row.name || "").trim(),
      kind: String(row.kind || "").trim(),
      uri: String(row.uri || "").trim(),
    }];
  });
}

function parseOrchestration(raw: unknown): A2AOrchestrationState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;
  if (String(data.schema || "") !== "sophia.a2a-orchestration.v1") return undefined;
  const parsedAgents = parseAgents(data.agents);
  const tasks: A2AOrchestrationTask[] = Array.isArray(data.tasks)
    ? data.tasks.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const id = String(row.id || "").trim();
        if (!id) return [];
        return [{
          id,
          subject: String(row.subject || "").trim(),
          description: String(row.description || "").trim(),
          state: String(row.state || "unstarted").trim() || "unstarted",
          terminal: row.terminal === true,
          ownerId: String(row.ownerId || "").trim(),
          blockedBy: stringList(row.blockedBy),
          blocks: stringList(row.blocks),
          doneCriteria: stringList(row.doneCriteria),
          expectedOutput: String(row.expectedOutput || "").trim(),
          stage: Number.isFinite(Number(row.stage))
            ? Math.max(1, Math.floor(Number(row.stage)))
            : undefined,
          summary: String(row.summary || "").trim(),
          artifacts: parseArtifacts(row.artifacts),
          updatedAt: String(row.updatedAt || "").trim(),
        }];
      })
    : [];
  const messageKinds: A2AMessageKind[] = [
    "human",
    "coordinator",
    "worker_result",
    "peer",
    "system",
    "task_notification",
  ];
  const messages: A2AOrchestrationMessage[] = Array.isArray(data.messages)
    ? data.messages.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const id = String(row.id || "").trim();
        if (!id) return [];
        const candidateKind = String(row.kind || "system") as A2AMessageKind;
        return [{
          id,
          kind: messageKinds.includes(candidateKind) ? candidateKind : "system",
          sender: String(row.sender || "").trim(),
          recipient: String(row.recipient || "").trim(),
          taskId: String(row.taskId || "").trim(),
          summary: String(row.summary || "").trim(),
          body: String(row.body || "").trim(),
          artifacts: parseArtifacts(row.artifacts),
          trusted: row.trusted === true && candidateKind !== "peer",
          unread: row.unread !== false,
          createdAt: String(row.createdAt || "").trim(),
        }];
      })
    : [];
  const agents = enrichOrchestrationAgents(parsedAgents, tasks, messages);
  return {
    schema: String(data.schema),
    session: String(data.session || ""),
    runId: String(data.runId || ""),
    mode: String(data.mode || "a2a"),
    version: Math.max(0, Math.floor(Number(data.version) || 0)),
    updatedAt: String(data.updatedAt || ""),
    coordinatorId: String(data.coordinatorId || "main"),
    agents,
    tasks,
    messages,
  };
}

export function a2aReducer(state: A2AState, ev: A2AEvent): A2AState {
  const orchestration = parseOrchestration(ev.orchestration);
  if (orchestration) {
    const roster = partitionWorkflowAgents(orchestration);
    state = {
      ...state,
      enabled: true,
      orchestration,
      agents: orchestration.agents.length ? roster.current : state.agents,
      archivedAgents: roster.archived,
      activeName:
        roster.current.find((agent) => agent.active)?.name
        || roster.current.find((agent) =>
          ["running", "waiting_input", "auth_required", "verifying"].includes(agent.status)
        )?.name
        || state.activeName,
    };
    if (ev.type === "a2a_orchestration_snapshot") return state;
  }
  switch (ev.type) {
    case "run_start":
      // Fresh run clears the previous chain unless this run itself starts A2A.
      return { ...EMPTY_A2A_STATE };
    case "a2a_chain_start": {
      const agents = parseAgents(ev.agents);
      return {
        enabled: true,
        agents,
        archivedAgents: [],
        activeName: agents.find((a) => a.active)?.name || agents[0]?.name || "",
        handoffPreview: "",
        orchestration: state.orchestration,
        dispatchManifest: state.dispatchManifest,
      };
    }
    case "a2a_agent_start": {
      const agents = parseAgents(ev.agents);
      const name = String(ev.name || "").trim();
      return {
        enabled: true,
        agents: agents.length
          ? agents
          : state.agents.map((a) => ({
              ...a,
              active: a.name === name,
              status: a.name === name ? "running" : a.status === "running" ? "queued" : a.status,
            })),
        activeName: name || state.activeName,
        handoffPreview: state.handoffPreview,
        archivedAgents: state.archivedAgents,
        orchestration: state.orchestration,
        dispatchManifest: state.dispatchManifest,
      };
    }
    case "a2a_agent_end": {
      const agents = parseAgents(ev.agents);
      return {
        enabled: true,
        agents: agents.length ? agents : state.agents,
        activeName: agents.find((a) => a.active)?.name || "",
        handoffPreview: state.handoffPreview,
        archivedAgents: state.archivedAgents,
        orchestration: state.orchestration,
        dispatchManifest: state.dispatchManifest,
      };
    }
    case "a2a_task_state": {
      const agents = parseAgents(ev.agents);
      return {
        enabled: true,
        agents: agents.length ? agents : state.agents,
        activeName: agents.find((a) => a.active)?.name || "",
        handoffPreview: state.handoffPreview,
        archivedAgents: state.archivedAgents,
        orchestration: state.orchestration,
        dispatchManifest: state.dispatchManifest,
      };
    }
    case "a2a_dispatch": {
      const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
      const agents = [...state.agents];
      // Ensure Main exists, then append/update sub rows from DISPATCH.
      if (!agents.some((a) => a.role === "main" || a.name === "Main Agent")) {
        agents.unshift({
          name: "Main Agent",
          index: 0,
          status: "succeeded",
          active: false,
          summary: "",
        });
      }
      tasks.forEach((raw, i) => {
        const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const name = String(row.name || `Sub Agent ${i + 1}`).trim();
        const task = String(row.task || "").trim();
        const persona = String(row.personaId || row.persona || "").trim();
        const skillsRaw = row.skills;
        const skills = Array.isArray(skillsRaw)
          ? skillsRaw.map((s) => String(s || "").trim()).filter(Boolean)
          : [];
        const skillVia = stringList(row.skillVia);
        const allowedTools = stringList(row.allowedTools);
        const personaName = String(row.personaName || "").trim();
        const personaVia = String(row.personaVia || "").trim();
        const toolScopeVia = String(row.toolScopeVia || "").trim();
        const bits: string[] = [];
        if (persona) bits.push(`role:${persona}`);
        if (skills.length) bits.push(`skills:${skills.join(",")}`);
        const summary = bits.length
          ? `[${bits.join(" | ")}] ${task}`.trim()
          : task;
        const existing = agents.findIndex((a) => a.name === name);
        const agent = {
          name,
          index: existing >= 0 ? agents[existing].index : agents.length,
          status: "queued" as A2AAgentStatus,
          active: false,
          summary,
          persona: persona || undefined,
          personaName: personaName || undefined,
          personaVia: personaVia || undefined,
          skills: skills.length ? skills : undefined,
          skillVia: skillVia.length ? skillVia : undefined,
          allowedTools: allowedTools.length ? allowedTools : undefined,
          toolScopeVia: toolScopeVia || undefined,
        };
        if (existing >= 0) agents[existing] = { ...agents[existing], ...agent };
        else agents.push(agent);
      });
      return {
        enabled: true,
        agents,
        activeName: state.activeName,
        handoffPreview:
          Number.isFinite(Number(ev.subCount))
            ? `dispatch · ${Number(ev.subCount)} sub-agent(s) · role/skill auto-select`
            : state.handoffPreview,
        archivedAgents: state.archivedAgents,
        orchestration: state.orchestration,
        dispatchManifest: state.dispatchManifest,
      };
    }
    case "a2a_harness_select": {
      const name = String(ev.subName || "").trim();
      if (!name) return state;
      const persona = String(ev.personaId || "").trim();
      const skillsRaw = ev.skills;
      const skills = Array.isArray(skillsRaw)
        ? skillsRaw.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      const skillVia = stringList(ev.skillVia);
      const allowedTools = stringList(ev.allowedTools);
      const personaName = String(ev.personaName || "").trim();
      const personaVia = String(ev.personaVia || "").trim();
      const toolScopeVia = String(ev.toolScopeVia || "").trim();
      const task = String(ev.task || "").trim();
      const bits: string[] = [];
      if (persona) bits.push(`role:${persona}`);
      if (skills.length) bits.push(`skills:${skills.join(",")}`);
      const stamp = bits.length ? `[${bits.join(" | ")}]` : "";
      return {
        ...state,
        enabled: true,
        agents: state.agents.map((a) =>
          a.name === name
            ? {
                ...a,
                persona: persona || a.persona,
                personaName: personaName || a.personaName,
                personaVia: personaVia || a.personaVia,
                skills: skills.length ? skills : a.skills,
                skillVia: skillVia.length ? skillVia : a.skillVia,
                allowedTools: allowedTools.length ? allowedTools : a.allowedTools,
                toolScopeVia: toolScopeVia || a.toolScopeVia,
                summary: stamp
                  ? `${stamp} ${task || a.summary}`.trim()
                  : a.summary,
              }
            : a,
        ),
        handoffPreview: stamp
          ? `harness · ${name} ${stamp}`
          : state.handoffPreview,
      };
    }
    case "subagent_dispatch": {
      const id = String(ev.assignmentId || ev.agentId || "").trim();
      const name = String(ev.name || "Delegated Sub-Agent").trim();
      const persona = String(ev.personaId || "").trim();
      const personaName = String(ev.personaName || "").trim();
      const personaVia = String(ev.personaVia || "").trim();
      const skills = stringList(ev.skills);
      const skillVia = stringList(ev.skillVia);
      const allowedTools = stringList(ev.allowedTools);
      const toolScopeVia = String(ev.toolScopeVia || "").trim();
      const task = String(ev.task || "").trim();
      const status = asStatus(ev.status);
      const active = ["running", "spawning", "queued"].includes(status);
      const summaryBits: string[] = [];
      if (persona) summaryBits.push(`role:${persona}`);
      if (skills.length) summaryBits.push(`skills:${skills.join(",")}`);
      const summary = `${
        summaryBits.length ? `[${summaryBits.join(" | ")}] ` : ""
      }${task}`.trim();
      const agent: A2AAgent = {
        id: id || undefined,
        name,
        index: 0,
        status,
        active,
        summary,
        role: "sub",
        persona: persona || undefined,
        personaName: personaName || undefined,
        personaVia: personaVia || undefined,
        skills: skills.length ? skills : undefined,
        skillVia: skillVia.length ? skillVia : undefined,
        allowedTools: allowedTools.length ? allowedTools : undefined,
        toolScopeVia: toolScopeVia || undefined,
        currentTaskId: String(ev.taskId || "").trim() || undefined,
      };
      const agents = [...state.agents];
      const existing = agents.findIndex(
        (item) =>
          (id && item.id === id) ||
          (!id && item.name === name),
      );
      if (existing >= 0) {
        agents[existing] = {
          ...agents[existing],
          ...agent,
          index: agents[existing].index,
        };
      } else {
        agent.index = agents.length;
        agents.push(agent);
      }
      return {
        ...state,
        enabled: true,
        agents,
        activeName: active ? name : state.activeName === name ? "" : state.activeName,
        handoffPreview: summary || state.handoffPreview,
      };
    }
    case "dispatch_manifest": {
      const path = String(
        ev.manifestPath || ev.dispatchManifestPath || "",
      ).trim();
      const dispatch =
        ev.dispatch && typeof ev.dispatch === "object" && !Array.isArray(ev.dispatch)
          ? (ev.dispatch as Record<string, unknown>)
          : {};
      return {
        ...state,
        enabled: true,
        dispatchManifest: {
          schema: String(ev.schema || "sophia.dispatch-manifest.v1"),
          path,
          version: Math.max(0, Math.floor(Number(ev.manifestVersion) || 0)),
          status: String(ev.status || ""),
          phase: String(ev.phase || ""),
          dispatch,
        },
      };
    }
    case "a2a_handoff": {
      const preview = String(ev.promptPreview || "").trim();
      return {
        ...state,
        enabled: true,
        handoffPreview: preview,
      };
    }
    case "a2a_chain_end": {
      const agents = parseAgents(ev.agents);
      return {
        enabled: true,
        agents: agents.length
          ? agents.map((a) => ({ ...a, active: false }))
          : state.agents.map((a) => ({ ...a, active: false })),
        activeName: "",
        handoffPreview: state.handoffPreview,
        archivedAgents: state.archivedAgents,
        orchestration: state.orchestration,
        dispatchManifest: state.dispatchManifest,
      };
    }
    case "run_finished": {
      const subs = Array.isArray(ev.subs)
        ? ev.subs.filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
        : [];
      const applyTerminalReceipts = (agents: A2AAgent[]): A2AAgent[] =>
        agents.map((agent) => {
          const receipt = subs.find(
            (item) => String(item.name || "").trim() === agent.name,
          );
          if (!receipt) return { ...agent, active: false };
          const status = asStatus(receipt.status);
          const reasonCode = String(receipt.reasonCode || "").trim();
          const fallback =
            reasonCode && genericProgressSummary(agent.summary)
              ? `worker ${status.replaceAll("_", " ")} · ${reasonCode}`
              : agent.summary;
          return {
            ...agent,
            active: false,
            status,
            summary: fallback,
            failureReason:
              FAILED_AGENT_STATES.has(status)
                ? agent.failureReason || fallback
                : agent.failureReason,
          };
        });
      const nextAgents = applyTerminalReceipts(state.agents);
      const nextArchived = applyTerminalReceipts(state.archivedAgents || []);
      return {
        ...state,
        agents: nextAgents,
        archivedAgents: nextArchived,
        orchestration: state.orchestration
          ? {
              ...state.orchestration,
              agents: applyTerminalReceipts(state.orchestration.agents),
            }
          : state.orchestration,
        activeName: "",
      };
    }
    case "error":
      return {
        ...state,
        agents: state.agents.map((a) => ({ ...a, active: false })),
        archivedAgents: (state.archivedAgents || []).map((a) => ({
          ...a,
          active: false,
        })),
        activeName: "",
      };
    default:
      return state;
  }
}

export function a2aActiveLabel(state: A2AState): string {
  if (!state.enabled || state.agents.length === 0) return "";
  if (state.activeName) return `active · ${state.activeName}`;
  const running = state.agents.find((a) => a.status === "running");
  if (running) return `active · ${running.name}`;
  return `${state.agents.length} agents`;
}
