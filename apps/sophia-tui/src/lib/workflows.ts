export type SkillAvailability =
  | "available"
  | "experimental"
  | "needs_setup"
  | "disabled"
  | "unavailable";

export type SkillSource = "sophia" | "local" | "mcp" | "external";

export type CapabilityRisk = "read" | "write" | "execute" | "network" | "external";

export interface SkillCapability {
  id: string;
  label: string;
  description?: string;
  risk: CapabilityRisk;
}

export interface SophiaSkill {
  id: string;
  name: string;
  summary: string;
  source: SkillSource;
  availability: SkillAvailability;
  capabilities: SkillCapability[];
  reason?: string;
  experimental?: boolean;
}

export interface SophiaWorkflowDefinition {
  id: string;
  title: string;
  summary: string;
  version: string;
  requiredSkillIds: string[];
  optionalSkillIds?: string[];
  capabilityIds?: string[];
  resumable: boolean;
  localOnly: true;
  experimental?: boolean;
}

export type WorkflowReadiness = "ready" | "experimental" | "blocked";

export interface WorkflowAssessment {
  readiness: WorkflowReadiness;
  selectable: boolean;
  missingSkillIds: string[];
  blockedSkillIds: string[];
  reasons: string[];
  capabilities: SkillCapability[];
}

export type WorkflowPickerEntryKind = "workflow" | "skill";

export interface WorkflowPickerEntry {
  id: string;
  kind: WorkflowPickerEntryKind;
  label: string;
  summary: string;
  badge: string;
  selectable: boolean;
  reason?: string;
  capabilities: SkillCapability[];
}

export type WorkflowRunStatus =
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface LocalWorkflowMetadata {
  schemaVersion: 1;
  storage: "local-only";
  runId: string;
  workflowId: string;
  workflowVersion: string;
  title: string;
  status: WorkflowRunStatus;
  workspaceKey: string;
  sessionId?: string;
  planId?: string;
  currentStepId?: string;
  completedStepIds: string[];
  createdAt: string;
  updatedAt: string;
  resumeCount: number;
  experimental: boolean;
}

export type ParseLocalWorkflowMetadataResult =
  | { ok: true; value: LocalWorkflowMetadata }
  | { ok: false; error: string };

export interface LocalWorkflowMetadataStore {
  readonly storage: "local-only";
  load(runId: string): Promise<LocalWorkflowMetadata | null>;
  save(metadata: LocalWorkflowMetadata): Promise<void>;
  remove(runId: string): Promise<void>;
  list(): Promise<LocalWorkflowMetadata[]>;
}

const BLOCKING_SKILL_STATES: ReadonlySet<SkillAvailability> = new Set([
  "needs_setup",
  "disabled",
  "unavailable",
]);

function uniqueCapabilities(capabilities: SkillCapability[]): SkillCapability[] {
  const byId = new Map<string, SkillCapability>();
  for (const capability of capabilities) {
    if (!byId.has(capability.id)) byId.set(capability.id, capability);
  }
  return [...byId.values()];
}

function skillReason(skill: SophiaSkill): string {
  if (skill.reason?.trim()) return skill.reason.trim();
  if (skill.availability === "needs_setup") return `${skill.name} needs setup.`;
  if (skill.availability === "disabled") return `${skill.name} is disabled.`;
  if (skill.availability === "unavailable") return `${skill.name} is unavailable.`;
  return "";
}

export function assessWorkflow(
  workflow: SophiaWorkflowDefinition,
  skills: SophiaSkill[],
): WorkflowAssessment {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const missingSkillIds: string[] = [];
  const blockedSkillIds: string[] = [];
  const reasons: string[] = [];
  const capabilities: SkillCapability[] = [];
  let hasExperimentalSkill = false;

  for (const skillId of workflow.requiredSkillIds) {
    const skill = byId.get(skillId);
    if (!skill) {
      missingSkillIds.push(skillId);
      reasons.push(`Required skill “${skillId}” is not installed.`);
      continue;
    }
    capabilities.push(...skill.capabilities);
    if (skill.availability === "experimental" || skill.experimental) hasExperimentalSkill = true;
    if (BLOCKING_SKILL_STATES.has(skill.availability)) {
      blockedSkillIds.push(skillId);
      reasons.push(skillReason(skill));
    }
  }

  for (const skillId of workflow.optionalSkillIds || []) {
    const skill = byId.get(skillId);
    if (skill && !BLOCKING_SKILL_STATES.has(skill.availability)) {
      capabilities.push(...skill.capabilities);
      if (skill.availability === "experimental" || skill.experimental) hasExperimentalSkill = true;
    }
  }

  const requested = new Set(workflow.capabilityIds || []);
  const installedCapabilities = uniqueCapabilities(capabilities);
  for (const capabilityId of requested) {
    if (!installedCapabilities.some((capability) => capability.id === capabilityId)) {
      reasons.push(`Required capability “${capabilityId}” is unavailable.`);
    }
  }

  const blocked = missingSkillIds.length > 0 || blockedSkillIds.length > 0 ||
    requested.size > installedCapabilities.filter((capability) => requested.has(capability.id)).length;
  const readiness: WorkflowReadiness = blocked
    ? "blocked"
    : workflow.experimental || hasExperimentalSkill
      ? "experimental"
      : "ready";

  return {
    readiness,
    selectable: !blocked,
    missingSkillIds,
    blockedSkillIds,
    reasons,
    capabilities: installedCapabilities,
  };
}

export function skillBadge(skill: SophiaSkill): string {
  if (skill.availability === "available") return skill.source;
  return skill.availability.replace("_", " ");
}

export function workflowPickerEntries(
  workflows: SophiaWorkflowDefinition[],
  skills: SophiaSkill[],
  includeSkills = true,
): WorkflowPickerEntry[] {
  const workflowRows = workflows.map((workflow): WorkflowPickerEntry => {
    const assessment = assessWorkflow(workflow, skills);
    return {
      id: workflow.id,
      kind: "workflow",
      label: workflow.title,
      summary: workflow.summary,
      badge: assessment.readiness,
      selectable: assessment.selectable,
      reason: assessment.reasons.join(" ") || undefined,
      capabilities: assessment.capabilities,
    };
  });
  if (!includeSkills) return workflowRows;

  const skillRows = skills.map((skill): WorkflowPickerEntry => ({
    id: skill.id,
    kind: "skill",
    label: skill.name,
    summary: skill.summary,
    badge: skillBadge(skill),
    selectable: !BLOCKING_SKILL_STATES.has(skill.availability),
    reason: skillReason(skill) || undefined,
    capabilities: skill.capabilities,
  }));
  return [...workflowRows, ...skillRows];
}

export function filterWorkflowPickerEntries(
  entries: WorkflowPickerEntry[],
  query: string,
  kind: WorkflowPickerEntryKind | "all" = "all",
): WorkflowPickerEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) return false;
    if (!needle) return true;
    const haystack = [
      entry.id,
      entry.label,
      entry.summary,
      entry.badge,
      entry.reason || "",
      ...entry.capabilities.flatMap((capability) => [capability.id, capability.label, capability.description || ""]),
    ].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

function cleanId(value: string, field: string): string {
  const result = String(value || "").trim();
  if (!result) throw new TypeError(`${field} is required.`);
  return result;
}

function isoTime(value?: string): string {
  return value || new Date().toISOString();
}

export function createLocalWorkflowMetadata(input: {
  runId: string;
  workflow: SophiaWorkflowDefinition;
  workspaceKey: string;
  sessionId?: string;
  planId?: string;
  at?: string;
}): LocalWorkflowMetadata {
  const at = isoTime(input.at);
  return {
    schemaVersion: 1,
    storage: "local-only",
    runId: cleanId(input.runId, "runId"),
    workflowId: cleanId(input.workflow.id, "workflowId"),
    workflowVersion: cleanId(input.workflow.version, "workflowVersion"),
    title: cleanId(input.workflow.title, "title"),
    status: "ready",
    workspaceKey: cleanId(input.workspaceKey, "workspaceKey"),
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    ...(input.planId?.trim() ? { planId: input.planId.trim() } : {}),
    completedStepIds: [],
    createdAt: at,
    updatedAt: at,
    resumeCount: 0,
    experimental: Boolean(input.workflow.experimental),
  };
}

export function updateLocalWorkflowMetadata(
  metadata: LocalWorkflowMetadata,
  patch: {
    status?: WorkflowRunStatus;
    currentStepId?: string | null;
    completedStepId?: string;
    resumed?: boolean;
    at?: string;
  },
): LocalWorkflowMetadata {
  const completedStepIds = patch.completedStepId?.trim()
    ? [...new Set([...metadata.completedStepIds, patch.completedStepId.trim()])]
    : [...metadata.completedStepIds];
  const currentStepId = patch.currentStepId === null
    ? undefined
    : patch.currentStepId?.trim() || metadata.currentStepId;
  return {
    ...metadata,
    status: patch.status || metadata.status,
    ...(currentStepId ? { currentStepId } : {}),
    ...(!currentStepId ? { currentStepId: undefined } : {}),
    completedStepIds,
    resumeCount: metadata.resumeCount + (patch.resumed ? 1 : 0),
    updatedAt: isoTime(patch.at),
  };
}

export function isWorkflowResumable(metadata: LocalWorkflowMetadata): boolean {
  return metadata.storage === "local-only" &&
    (metadata.status === "ready" || metadata.status === "running" || metadata.status === "paused" || metadata.status === "failed");
}

export function serializeLocalWorkflowMetadata(metadata: LocalWorkflowMetadata): string {
  const checked = parseLocalWorkflowMetadata(JSON.stringify(metadata));
  if (!checked.ok) throw new TypeError(checked.error);
  return JSON.stringify(checked.value, null, 2);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Parse only the bounded metadata schema Sophia owns. Arbitrary workflow
 * payloads, prompts, secrets, and cloud-sync fields are deliberately ignored.
 */
export function parseLocalWorkflowMetadata(text: string): ParseLocalWorkflowMetadataResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Workflow metadata is not valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Workflow metadata must be an object." };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return { ok: false, error: "Unsupported workflow metadata schema." };
  if (raw.storage !== "local-only") return { ok: false, error: "Sophia workflow metadata must remain local-only." };
  for (const field of ["runId", "workflowId", "workflowVersion", "title", "workspaceKey", "createdAt", "updatedAt"]) {
    if (typeof raw[field] !== "string" || !String(raw[field]).trim()) {
      return { ok: false, error: `Workflow metadata field ${field} is required.` };
    }
  }
  if (typeof raw.status !== "string" || !WORKFLOW_STATUSES.has(raw.status)) {
    return { ok: false, error: "Workflow metadata has an unknown status." };
  }
  if (!isStringArray(raw.completedStepIds)) {
    return { ok: false, error: "Workflow completedStepIds must be a string array." };
  }
  if (!Number.isInteger(raw.resumeCount) || Number(raw.resumeCount) < 0) {
    return { ok: false, error: "Workflow resumeCount must be a non-negative integer." };
  }
  if (typeof raw.experimental !== "boolean") {
    return { ok: false, error: "Workflow experimental flag must be boolean." };
  }
  for (const optional of ["sessionId", "planId", "currentStepId"]) {
    if (raw[optional] !== undefined && typeof raw[optional] !== "string") {
      return { ok: false, error: `Workflow metadata field ${optional} must be a string.` };
    }
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      storage: "local-only",
      runId: String(raw.runId),
      workflowId: String(raw.workflowId),
      workflowVersion: String(raw.workflowVersion),
      title: String(raw.title),
      status: raw.status as WorkflowRunStatus,
      workspaceKey: String(raw.workspaceKey),
      ...(raw.sessionId ? { sessionId: String(raw.sessionId) } : {}),
      ...(raw.planId ? { planId: String(raw.planId) } : {}),
      ...(raw.currentStepId ? { currentStepId: String(raw.currentStepId) } : {}),
      completedStepIds: [...new Set(raw.completedStepIds)],
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt),
      resumeCount: Number(raw.resumeCount),
      experimental: raw.experimental,
    },
  };
}

export class MemoryLocalWorkflowMetadataStore implements LocalWorkflowMetadataStore {
  readonly storage = "local-only" as const;
  readonly #records = new Map<string, LocalWorkflowMetadata>();

  async load(runId: string): Promise<LocalWorkflowMetadata | null> {
    const value = this.#records.get(runId);
    return value ? structuredClone(value) : null;
  }

  async save(metadata: LocalWorkflowMetadata): Promise<void> {
    const parsed = parseLocalWorkflowMetadata(JSON.stringify(metadata));
    if (!parsed.ok) throw new TypeError(parsed.error);
    this.#records.set(metadata.runId, structuredClone(parsed.value));
  }

  async remove(runId: string): Promise<void> {
    this.#records.delete(runId);
  }

  async list(): Promise<LocalWorkflowMetadata[]> {
    return [...this.#records.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((value) => structuredClone(value));
  }
}
