/**
 * Pure state + wire contract for the Sophia TUI custom-model endpoint flow.
 *
 * Security boundary:
 * - Saved profiles contain credential REFERENCES only (`env:...`,
 *   `keychain:...`, or `none`).
 * - A masked one-time entry can send a raw credential to the local Python
 *   bridge solely for OS-keyring storage. It is cleared immediately and never
 *   enters the transcript, saved profile, or a backend response.
 * - Command builders validate the reference again before anything reaches the
 *   bridge.
 * - Backend responses are projected through an allow-list; unexpected fields
 *   such as `apiKey` or `authorization` are ignored.
 *
 * Backend contract (additive; the Python bridge may wire it independently):
 *   command: { cmd: "model_connection", action, requestId, ... }
 *   event:   { type: "model_connection", action, requestId, ok, ... }
 */

export type ModelConnectionProtocol =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-messages";

export type ModelConnectionTemplateId =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-messages"
  | "ollama"
  | "vllm"
  | "sglang"
  | "llama.cpp"
  | "mlx";

export type ModelConnectionField =
  | "displayName"
  | "protocol"
  | "baseUrl"
  | "model"
  | "credentialRef";

export type ModelConnectionCheckState =
  | "not_checked"
  | "pending"
  | "passed"
  | "failed";

export interface ModelConnectionCheck {
  state: ModelConnectionCheckState;
  detail: string;
  requestId?: string;
}

export interface ModelConnectionChecks {
  connectivity: ModelConnectionCheck;
  responseFormat: ModelConnectionCheck;
}

export interface ModelConnectionTemplate {
  id: ModelConnectionTemplateId;
  label: string;
  description: string;
  displayName: string;
  protocol: ModelConnectionProtocol;
  baseUrl: string;
  model: string;
  credentialRef: string;
  allowPrivateNetwork: boolean;
}

export interface ModelConnectionDraft {
  templateId: ModelConnectionTemplateId;
  displayName: string;
  protocol: ModelConnectionProtocol;
  baseUrl: string;
  model: string;
  credentialRef: string;
  allowPrivateNetwork: boolean;
  checks: ModelConnectionChecks;
}

export interface ModelConnectionRecord extends ModelConnectionDraft {
  id: string;
  /**
   * Optional backend-resolved model alias/spec. The TUI exposes a saved custom
   * connection in the normal model picker only when the backend supplies this;
   * it never invents a runnable spec from an unconfirmed draft.
   */
  modelSpec?: string;
}

export type ModelConnectionAction =
  | "list"
  | "save"
  | "remove"
  | "store_credential"
  | "check"
  | "format_probe"
  | "repair_plan";

export interface ModelConnectionPayload {
  id?: string;
  templateId: ModelConnectionTemplateId;
  displayName: string;
  protocol: ModelConnectionProtocol;
  baseUrl: string;
  model: string;
  credentialRef: string;
  allowPrivateNetwork: boolean;
}

export type ModelConnectionCommand =
  | {
      cmd: "model_connection";
      action: "list";
      requestId: string;
    }
  | {
      cmd: "model_connection";
      action: "save";
      requestId: string;
      connection: ModelConnectionPayload;
    }
  | {
      cmd: "model_connection";
      action: "remove";
      requestId: string;
      connectionId: string;
    }
  | {
      cmd: "model_connection";
      action: "store_credential";
      requestId: string;
      credentialRef: string;
      credentialValue: string;
    }
  | {
      cmd: "model_connection";
      action: "check";
      requestId: string;
      connection: ModelConnectionPayload;
    }
  | {
      cmd: "model_connection";
      action: "format_probe";
      requestId: string;
      consent: true;
      connection: ModelConnectionPayload;
    }
  | {
      cmd: "model_connection";
      action: "repair_plan";
      requestId: string;
      consent: true;
      connection: ModelConnectionPayload;
    };

export interface ModelConnectionRepairSuggestion {
  summary: string;
  changes: Partial<
    Pick<ModelConnectionDraft, "displayName" | "protocol" | "baseUrl" | "model" | "credentialRef">
  >;
}

export interface ModelConnectionBridgeEvent {
  type: "model_connection";
  action: ModelConnectionAction;
  requestId: string;
  ok: boolean;
  connectionId?: string;
  connection?: ModelConnectionRecord;
  connections?: ModelConnectionRecord[];
  detail?: string;
  suggestion?: ModelConnectionRepairSuggestion;
}

export type ModelConnectionsView =
  | "closed"
  | "list"
  | "templates"
  | "form"
  | "credential_entry"
  | "remove_confirm"
  | "repair_consent"
  | "repair_pending"
  | "repair_preview";

export interface ModelConnectionsState {
  open: boolean;
  view: ModelConnectionsView;
  connections: ModelConnectionRecord[];
  selected: number;
  templateSelected: number;
  formSelected: number;
  draft: ModelConnectionDraft | null;
  editingId: string | null;
  removeTargetId: string | null;
  pending:
    | {
        action: ModelConnectionAction;
        requestId: string;
        connectionId?: string;
      }
    | null;
  notice: string;
  secretInputRejected: boolean;
  repairReturnView: "list" | "form";
  repairConsent: "no" | "yes";
  repairPreviewApproval: "no" | "yes";
  repairSuggestion: ModelConnectionRepairSuggestion | null;
  credentialInput: string;
}

export const EMPTY_MODEL_CONNECTION_CHECK: ModelConnectionCheck = {
  state: "not_checked",
  detail: "not checked",
};

export const EMPTY_MODEL_CONNECTION_CHECKS: ModelConnectionChecks = {
  connectivity: { ...EMPTY_MODEL_CONNECTION_CHECK },
  responseFormat: { ...EMPTY_MODEL_CONNECTION_CHECK },
};

export const MODEL_CONNECTION_TEMPLATES: readonly ModelConnectionTemplate[] = [
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    description: "OpenAI Chat Completions-compatible HTTPS endpoint",
    displayName: "OpenAI-compatible endpoint",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    credentialRef: "env:OPENAI_API_KEY",
    allowPrivateNetwork: false,
  },
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    description: "OpenAI Responses-compatible HTTPS endpoint",
    displayName: "OpenAI Responses endpoint",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    credentialRef: "env:OPENAI_API_KEY",
    allowPrivateNetwork: false,
  },
  {
    id: "anthropic-messages",
    label: "Anthropic Messages",
    description: "Anthropic Messages API-compatible endpoint",
    displayName: "Anthropic Messages endpoint",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    model: "",
    credentialRef: "env:ANTHROPIC_API_KEY",
    allowPrivateNetwork: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    description: "Local Ollama OpenAI-compatible API",
    displayName: "Ollama",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    credentialRef: "none",
    allowPrivateNetwork: false,
  },
  {
    id: "vllm",
    label: "vLLM",
    description: "Local or remote vLLM OpenAI-compatible server",
    displayName: "vLLM",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "",
    credentialRef: "none",
    allowPrivateNetwork: false,
  },
  {
    id: "sglang",
    label: "SGLang",
    description: "SGLang OpenAI-compatible server",
    displayName: "SGLang",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:30000/v1",
    model: "",
    credentialRef: "none",
    allowPrivateNetwork: false,
  },
  {
    id: "llama.cpp",
    label: "llama.cpp",
    description: "llama.cpp OpenAI-compatible server",
    displayName: "llama.cpp",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "",
    credentialRef: "none",
    allowPrivateNetwork: false,
  },
  {
    id: "mlx",
    label: "oMLX / MLX",
    description: "oMLX or MLX OpenAI-compatible local server",
    displayName: "oMLX / MLX",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "",
    credentialRef: "none",
    allowPrivateNetwork: false,
  },
] as const;

export const MODEL_CONNECTION_FORM_ROWS: readonly (
  | { kind: "field"; field: ModelConnectionField; label: string }
  | {
      kind: "action";
      action:
        | "toggle_private_network"
        | "store_credential"
        | "check"
        | "format_probe"
        | "save"
        | "cancel";
      label: string;
    }
)[] = [
  { kind: "field", field: "displayName", label: "Display name" },
  { kind: "field", field: "protocol", label: "Protocol" },
  { kind: "field", field: "baseUrl", label: "Base URL" },
  { kind: "field", field: "model", label: "Model" },
  { kind: "field", field: "credentialRef", label: "Credential reference" },
  { kind: "action", action: "toggle_private_network", label: "Allow private/LAN HTTPS" },
  { kind: "action", action: "store_credential", label: "Store API key securely…" },
  { kind: "action", action: "check", label: "Run connectivity check" },
  { kind: "action", action: "format_probe", label: "Probe response format" },
  { kind: "action", action: "save", label: "Save endpoint" },
  { kind: "action", action: "cancel", label: "Discard draft" },
] as const;

export const INITIAL_MODEL_CONNECTIONS_STATE: ModelConnectionsState = {
  open: false,
  view: "closed",
  connections: [],
  selected: 0,
  templateSelected: 0,
  formSelected: 0,
  draft: null,
  editingId: null,
  removeTargetId: null,
  pending: null,
  notice: "",
  secretInputRejected: false,
  repairReturnView: "form",
  repairConsent: "no",
  repairPreviewApproval: "no",
  repairSuggestion: null,
  credentialInput: "",
};

export type ModelConnectionsReducerAction =
  | { type: "open"; start?: "list" | "templates" }
  | { type: "close" }
  | { type: "move"; delta: number }
  | { type: "start_add" }
  | { type: "select_template" }
  | { type: "edit"; id: string }
  | { type: "set_field"; field: ModelConnectionField; value: string }
  | { type: "append_field"; field: ModelConnectionField; value: string }
  | { type: "delete_field"; field: ModelConnectionField; count?: number }
  | { type: "toggle_protocol" }
  | { type: "toggle_private_network" }
  | { type: "set_form_selected"; index: number }
  | { type: "discard_draft" }
  | { type: "start_credential_entry" }
  | { type: "append_credential_input"; value: string }
  | { type: "delete_credential_input"; count?: number }
  | { type: "cancel_credential_entry" }
  | { type: "request_remove"; id: string }
  | { type: "cancel_remove" }
  | {
      type: "request_started";
      action: ModelConnectionAction;
      requestId: string;
      connectionId?: string;
    }
  | { type: "request_failed"; requestId: string; detail: string }
  | { type: "backend_event"; event: ModelConnectionBridgeEvent }
  | { type: "set_repair_consent"; value: "no" | "yes" }
  | { type: "decline_repair" }
  | { type: "repair_requested"; requestId: string }
  | { type: "cancel_repair_request" }
  | { type: "set_repair_preview_approval"; value: "no" | "yes" }
  | { type: "finish_repair_preview" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function wrap(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

function protocol(value: unknown): ModelConnectionProtocol | null {
  const normalized = text(value).toLowerCase();
  return normalized === "openai-compatible"
    || normalized === "openai-responses"
    || normalized === "anthropic-messages"
    ? normalized
    : null;
}

function templateId(value: unknown): ModelConnectionTemplateId {
  const normalized = text(value).toLowerCase();
  return MODEL_CONNECTION_TEMPLATES.some((template) => template.id === normalized)
    ? normalized as ModelConnectionTemplateId
    : "openai-compatible";
}

function check(value: unknown): ModelConnectionCheck {
  const row = record(value);
  const rawState = text(row.state).toLowerCase();
  const state: ModelConnectionCheckState =
    rawState === "pending" || rawState === "passed" || rawState === "failed"
      ? rawState
      : "not_checked";
  return {
    state,
    detail: redactModelConnectionText(text(row.detail) || state.replaceAll("_", " ")),
    ...(text(row.requestId) ? { requestId: text(row.requestId) } : {}),
  };
}

function checks(value: unknown): ModelConnectionChecks {
  const row = record(value);
  return {
    connectivity: check(row.connectivity),
    responseFormat: check(row.responseFormat),
  };
}

function safeCredentialReferenceFromBackend(value: unknown): string {
  const candidate = text(value) || "none";
  return credentialReferenceError(candidate) ? "none" : candidate;
}

function connectionRecord(value: unknown): ModelConnectionRecord | null {
  const row = record(value);
  const id = text(row.id);
  const displayName = text(row.displayName);
  const baseUrl = text(row.baseUrl);
  const model = text(row.model);
  const resolvedProtocol = protocol(row.protocol);
  if (!id || !displayName || !baseUrl || !model || !resolvedProtocol) return null;
  return {
    id,
    templateId: templateId(row.templateId),
    displayName,
    protocol: resolvedProtocol,
    baseUrl,
    model,
    credentialRef: safeCredentialReferenceFromBackend(row.credentialRef),
    allowPrivateNetwork: row.allowPrivateNetwork === true,
    checks: checks(row.checks),
    ...(text(row.modelSpec) ? { modelSpec: text(row.modelSpec) } : {}),
  };
}

function repairSuggestion(value: unknown): ModelConnectionRepairSuggestion | null {
  const row = record(value);
  const rawChanges = record(row.changes);
  const changes: ModelConnectionRepairSuggestion["changes"] = {};
  if (text(rawChanges.displayName)) changes.displayName = text(rawChanges.displayName);
  const nextProtocol = protocol(rawChanges.protocol);
  if (nextProtocol) changes.protocol = nextProtocol;
  if (text(rawChanges.baseUrl)) changes.baseUrl = text(rawChanges.baseUrl);
  if (text(rawChanges.model)) changes.model = text(rawChanges.model);
  if (text(rawChanges.credentialRef) && !credentialReferenceError(text(rawChanges.credentialRef))) {
    changes.credentialRef = text(rawChanges.credentialRef);
  }
  const summary = redactModelConnectionText(text(row.summary) || "Suggested draft changes");
  return { summary, changes };
}

export function parseModelConnectionBridgeEvent(
  value: unknown,
): ModelConnectionBridgeEvent | null {
  const row = record(value);
  if (text(row.type) !== "model_connection") return null;
  const action = text(row.action) as ModelConnectionAction;
  if (![
    "list", "save", "remove", "store_credential", "check",
    "format_probe", "repair_plan",
  ].includes(action)) {
    return null;
  }
  const requestId = text(row.requestId);
  if (!requestId) return null;
  const parsedConnection = connectionRecord(row.connection);
  const parsedConnections = Array.isArray(row.connections)
    ? row.connections.map(connectionRecord).filter((item): item is ModelConnectionRecord => !!item)
    : undefined;
  const parsedSuggestion = repairSuggestion(row.suggestion);
  return {
    type: "model_connection",
    action,
    requestId,
    ok: row.ok === true,
    ...(text(row.connectionId) ? { connectionId: text(row.connectionId) } : {}),
    ...(parsedConnection ? { connection: parsedConnection } : {}),
    ...(parsedConnections ? { connections: parsedConnections } : {}),
    ...(text(row.detail) ? { detail: redactModelConnectionText(text(row.detail)) } : {}),
    ...(parsedSuggestion ? { suggestion: parsedSuggestion } : {}),
  };
}

export function createDraftFromTemplate(
  selected: number | ModelConnectionTemplateId,
): ModelConnectionDraft {
  const template =
    typeof selected === "number"
      ? MODEL_CONNECTION_TEMPLATES[
          Math.max(0, Math.min(MODEL_CONNECTION_TEMPLATES.length - 1, selected))
        ]
      : MODEL_CONNECTION_TEMPLATES.find((item) => item.id === selected)
        || MODEL_CONNECTION_TEMPLATES[0];
  return {
    templateId: template.id,
    displayName: template.displayName,
    protocol: template.protocol,
    baseUrl: template.baseUrl,
    model: template.model,
    credentialRef: template.credentialRef,
    allowPrivateNetwork: template.allowPrivateNetwork,
    checks: {
      connectivity: { ...EMPTY_MODEL_CONNECTION_CHECK },
      responseFormat: { ...EMPTY_MODEL_CONNECTION_CHECK },
    },
  };
}

export function draftFromConnection(connection: ModelConnectionRecord): ModelConnectionDraft {
  return {
    templateId: connection.templateId,
    displayName: connection.displayName,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    credentialRef: connection.credentialRef,
    allowPrivateNetwork: connection.allowPrivateNetwork,
    checks: {
      connectivity: { ...connection.checks.connectivity },
      responseFormat: { ...connection.checks.responseFormat },
    },
  };
}

export function looksLikeRawSecret(value: unknown): boolean {
  const candidate = String(value ?? "").trim();
  if (!candidate) return false;
  if (/^(env:|keychain:|none$)/i.test(candidate)) return false;
  if (/^(?:bearer\s+|sk-(?:ant-)?|xai-|gsk_|hf_|AIza)/i.test(candidate)) return true;
  return candidate.length >= 24
    && !candidate.includes(":")
    && /[A-Za-z]/.test(candidate)
    && /\d/.test(candidate)
    && /^[A-Za-z0-9._+/=-]+$/.test(candidate);
}

export function credentialReferenceError(value: unknown): string | null {
  const candidate = String(value ?? "").trim();
  if (!candidate) return "Use env:NAME, keychain:service/account, or none.";
  if (looksLikeRawSecret(candidate)) {
    return "Raw secrets are not accepted. Store the key outside Sophia and enter only a reference.";
  }
  if (candidate.toLowerCase() === "none") return null;
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) return null;
  if (/^keychain:[^/\s:]+\/[^/\s]+$/.test(candidate)) return null;
  return "Credential reference must be env:NAME, keychain:service/account, or none.";
}

export function appendCredentialReference(
  current: string,
  addition: string,
): { value: string; rejectedRawSecret: boolean } {
  const candidate = `${current}${addition}`.replace(/[\r\n\t]/g, "");
  if (looksLikeRawSecret(candidate)) {
    return { value: "", rejectedRawSecret: true };
  }
  return { value: candidate, rejectedRawSecret: false };
}

export function appendCredentialInput(current: string, input: string): string {
  return `${current}${input}`.replace(/[\r\n\t]/g, "").slice(0, 8192);
}

function maskPart(value: string, visible = 3): string {
  if (value.length <= visible * 2) return "•".repeat(Math.max(4, value.length));
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

export function maskCredentialReference(value: unknown): string {
  const candidate = String(value ?? "").trim();
  if (!candidate || candidate.toLowerCase() === "none") return "none";
  if (candidate.startsWith("env:")) return `env:${maskPart(candidate.slice(4), 3)}`;
  if (candidate.startsWith("keychain:")) {
    const [service = "", account = ""] = candidate.slice(9).split("/", 2);
    return `keychain:${maskPart(service, 2)}/${maskPart(account, 2)}`;
  }
  return "[rejected credential value]";
}

export function redactModelConnectionText(value: unknown): string {
  return String(value ?? "")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-(?:ant-)?|xai-|gsk_|hf_)[A-Za-z0-9._-]{6,}\b/gi, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /([A-Za-z0-9_-]*(?:secret|token|password|api[_-]?key|authorization)[A-Za-z0-9_-]*)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
}

export function validateModelConnectionDraft(
  draft: ModelConnectionDraft | null,
): string[] {
  if (!draft) return ["No endpoint draft is open."];
  const errors: string[] = [];
  if (!draft.displayName.trim()) errors.push("Display name is required.");
  if (!draft.model.trim()) errors.push("Model is required.");
  if (!protocol(draft.protocol)) errors.push("Protocol is not supported.");
  try {
    const parsed = new URL(draft.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("Base URL must use http or https.");
    }
    if (parsed.username || parsed.password) {
      errors.push("Base URL must not contain embedded credentials.");
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = hostname === "localhost"
      || hostname === "::1"
      || hostname === "127.0.0.1"
      || hostname.startsWith("127.");
    const privateIpv4 = /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^169\.254\./.test(hostname)
      || (() => {
        const match = hostname.match(/^172\.(\d+)\./);
        if (!match) return false;
        const second = Number.parseInt(match[1] || "", 10);
        return second >= 16 && second <= 31;
      })();
    const privateName = !loopback && (
      !hostname.includes(".")
      || [".internal", ".local", ".lan", ".corp", ".intranet"]
        .some((suffix) => hostname.endsWith(suffix))
    );
    const privateAuthority = privateIpv4 || privateName;
    const metadataAuthority = [
      "169.254.169.254",
      "100.100.100.200",
      "metadata.google.internal",
      "metadata.google",
      "instance-data.ec2.internal",
    ].includes(hostname);
    if (metadataAuthority) {
      errors.push("Cloud metadata endpoints are forbidden.");
    } else if (privateAuthority && !draft.allowPrivateNetwork) {
      errors.push("Private/LAN endpoints require explicit approval.");
    }
    if (draft.allowPrivateNetwork && !loopback && parsed.protocol !== "https:") {
      errors.push("Private/LAN endpoints require HTTPS.");
    }
  } catch {
    errors.push("Base URL must be a valid absolute URL.");
  }
  const credentialError = credentialReferenceError(draft.credentialRef);
  if (credentialError) errors.push(credentialError);
  return errors;
}

export function modelConnectionPayload(
  draft: ModelConnectionDraft,
  id?: string | null,
): ModelConnectionPayload {
  const errors = validateModelConnectionDraft(draft);
  if (errors.length) throw new Error(errors.join(" "));
  return {
    ...(id ? { id } : {}),
    templateId: draft.templateId,
    displayName: draft.displayName.trim(),
    protocol: draft.protocol,
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    model: draft.model.trim(),
    credentialRef: draft.credentialRef.trim(),
    allowPrivateNetwork: draft.allowPrivateNetwork,
  };
}

export function buildModelConnectionCommand(options: {
  action: ModelConnectionAction;
  requestId: string;
  draft?: ModelConnectionDraft | null;
  connectionId?: string | null;
  credentialRef?: string | null;
  credentialValue?: string | null;
}): ModelConnectionCommand {
  const { action, requestId } = options;
  if (!requestId.trim()) throw new Error("model_connection requestId is required");
  if (action === "list") {
    return { cmd: "model_connection", action, requestId };
  }
  if (action === "remove") {
    const connectionId = String(options.connectionId || "").trim();
    if (!connectionId) throw new Error("model_connection remove requires connectionId");
    return { cmd: "model_connection", action, requestId, connectionId };
  }
  if (action === "store_credential") {
    const credentialRef = String(options.credentialRef || "").trim();
    const credentialValue = String(options.credentialValue || "").trim();
    if (!/^keychain:[^/\s:]+\/[^/\s]+$/.test(credentialRef)) {
      throw new Error("secure storage requires keychain:service/account");
    }
    if (!credentialValue) throw new Error("credential value is required");
    return {
      cmd: "model_connection",
      action,
      requestId,
      credentialRef,
      credentialValue,
    };
  }
  if (!options.draft) throw new Error(`model_connection ${action} requires a draft`);
  const connection = modelConnectionPayload(options.draft, options.connectionId);
  if (action === "save") {
    return { cmd: "model_connection", action, requestId, connection };
  }
  if (action === "check") {
    return { cmd: "model_connection", action, requestId, connection };
  }
  if (action === "format_probe") {
    return { cmd: "model_connection", action, requestId, consent: true, connection };
  }
  return {
    cmd: "model_connection",
    action: "repair_plan",
    requestId,
    consent: true,
    connection,
  };
}

function setDraftField(
  state: ModelConnectionsState,
  field: ModelConnectionField,
  value: string,
  append = false,
): ModelConnectionsState {
  if (!state.draft) return state;
  if (field === "protocol") {
    const nextProtocol = protocol(value);
    return nextProtocol
      ? { ...state, draft: { ...state.draft, protocol: nextProtocol }, notice: "" }
      : state;
  }
  if (field === "credentialRef") {
    const next = append
      ? appendCredentialReference(state.draft.credentialRef, value)
      : looksLikeRawSecret(value)
        ? { value: "", rejectedRawSecret: true }
        : { value: value.replace(/[\r\n\t]/g, ""), rejectedRawSecret: false };
    return {
      ...state,
      draft: { ...state.draft, credentialRef: next.value },
      secretInputRejected: next.rejectedRawSecret,
      notice: next.rejectedRawSecret
        ? "Raw secret rejected. Enter env:NAME or keychain:service/account instead."
        : "",
    };
  }
  const current = state.draft[field];
  return {
    ...state,
    draft: {
      ...state.draft,
      [field]: append ? `${current}${value}`.replace(/[\r\n\t]/g, "") : value.replace(/[\r\n\t]/g, ""),
    },
    notice: "",
    secretInputRejected: false,
  };
}

function setConnectionCheck(
  connection: ModelConnectionRecord,
  action: "check" | "format_probe",
  next: ModelConnectionCheck,
): ModelConnectionRecord {
  return {
    ...connection,
    checks: {
      ...connection.checks,
      [action === "check" ? "connectivity" : "responseFormat"]: next,
    },
  };
}

function updateDraftCheck(
  draft: ModelConnectionDraft | null,
  action: "check" | "format_probe",
  next: ModelConnectionCheck,
): ModelConnectionDraft | null {
  if (!draft) return null;
  return {
    ...draft,
    checks: {
      ...draft.checks,
      [action === "check" ? "connectivity" : "responseFormat"]: next,
    },
  };
}

function markCheckPending(
  state: ModelConnectionsState,
  action: "check" | "format_probe",
  requestId: string,
  connectionId?: string,
): ModelConnectionsState {
  const next: ModelConnectionCheck = {
    state: "pending",
    detail: action === "check" ? "connectivity check pending" : "response-format probe pending",
    requestId,
  };
  return {
    ...state,
    draft: updateDraftCheck(state.draft, action, next),
    connections: connectionId
      ? state.connections.map((connection) =>
          connection.id === connectionId
            ? setConnectionCheck(connection, action, next)
            : connection
        )
      : state.connections,
  };
}

function applyBackendEvent(
  state: ModelConnectionsState,
  event: ModelConnectionBridgeEvent,
): ModelConnectionsState {
  if (state.pending && state.pending.requestId !== event.requestId) return state;
  if (event.action === "list") {
    return {
      ...state,
      connections: event.ok ? event.connections || [] : state.connections,
      pending: null,
      notice: event.ok ? "" : event.detail || "Endpoint list request failed.",
      selected: Math.min(state.selected, event.ok ? (event.connections || []).length : state.connections.length),
    };
  }
  if (event.action === "save") {
    if (!event.ok || !event.connection) {
      return {
        ...state,
        pending: null,
        view: "form",
        notice: event.detail || "Endpoint was not saved.",
      };
    }
    const withoutOld = state.connections.filter((connection) => connection.id !== event.connection?.id);
    return {
      ...state,
      connections: [...withoutOld, event.connection],
      pending: null,
      view: "list",
      draft: null,
      editingId: null,
      selected: withoutOld.length + 1,
      notice: "Endpoint saved by the backend.",
    };
  }
  if (event.action === "remove") {
    if (!event.ok) {
      return {
        ...state,
        pending: null,
        view: "list",
        removeTargetId: null,
        notice: event.detail || "Endpoint was not removed.",
      };
    }
    const id = event.connectionId || state.removeTargetId || state.pending?.connectionId || "";
    const remaining = state.connections.filter((connection) => connection.id !== id);
    return {
      ...state,
      connections: remaining,
      pending: null,
      view: "list",
      removeTargetId: null,
      selected: Math.min(state.selected, remaining.length),
      notice: "Endpoint removed by the backend.",
    };
  }
  if (event.action === "check" || event.action === "format_probe") {
    const checkAction = event.action;
    const status: ModelConnectionCheck = {
      state: event.ok ? "passed" : "failed",
      detail: event.detail || (event.ok ? "check passed" : "check failed"),
      requestId: event.requestId,
    };
    const connectionId =
      event.connectionId || state.pending?.connectionId || state.editingId || undefined;
    const nextState: ModelConnectionsState = {
      ...state,
      pending: null,
      draft: updateDraftCheck(state.draft, checkAction, status),
      connections: connectionId
        ? state.connections.map((connection) =>
            connection.id === connectionId
              ? setConnectionCheck(connection, checkAction, status)
              : connection
          )
        : state.connections,
      notice: status.detail,
    };
    if (!event.ok) {
      return {
        ...nextState,
        view: "repair_consent",
        repairReturnView: state.view === "form" ? "form" : "list",
        repairConsent: "no",
        repairSuggestion: null,
      };
    }
    return nextState;
  }
  if (!event.ok || !event.suggestion) {
    return {
      ...state,
      pending: null,
      view: state.repairReturnView,
      notice: event.detail || "No repair suggestion was produced.",
    };
  }
  return {
    ...state,
    pending: null,
    view: "repair_preview",
    repairSuggestion: event.suggestion,
    repairPreviewApproval: "no",
    notice: "",
  };
}

export function modelConnectionsReducer(
  state: ModelConnectionsState,
  action: ModelConnectionsReducerAction,
): ModelConnectionsState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        open: true,
        view: action.start || "list",
        selected: 0,
        templateSelected: 0,
        notice: "",
        secretInputRejected: false,
      };
    case "close":
      return {
        ...state,
        open: false,
        view: "closed",
        draft: null,
        editingId: null,
        removeTargetId: null,
        pending: null,
        notice: "",
        repairSuggestion: null,
        credentialInput: "",
      };
    case "move":
      if (state.view === "list") {
        return { ...state, selected: wrap(state.selected, action.delta, state.connections.length + 1) };
      }
      if (state.view === "templates") {
        return {
          ...state,
          templateSelected: wrap(
            state.templateSelected,
            action.delta,
            MODEL_CONNECTION_TEMPLATES.length,
          ),
        };
      }
      if (state.view === "form") {
        return {
          ...state,
          formSelected: wrap(
            state.formSelected,
            action.delta,
            MODEL_CONNECTION_FORM_ROWS.length,
          ),
        };
      }
      if (state.view === "repair_consent") {
        return {
          ...state,
          repairConsent: state.repairConsent === "no" ? "yes" : "no",
        };
      }
      if (state.view === "repair_preview") {
        return {
          ...state,
          repairPreviewApproval: state.repairPreviewApproval === "no" ? "yes" : "no",
        };
      }
      return state;
    case "start_add":
      return {
        ...state,
        open: true,
        view: "templates",
        templateSelected: 0,
        draft: null,
        editingId: null,
        notice: "",
      };
    case "select_template":
      return {
        ...state,
        view: "form",
        draft: createDraftFromTemplate(state.templateSelected),
        editingId: null,
        formSelected: 0,
        notice: "",
        secretInputRejected: false,
      };
    case "edit": {
      const connection = state.connections.find((item) => item.id === action.id);
      if (!connection) return { ...state, notice: "Endpoint is no longer available." };
      return {
        ...state,
        view: "form",
        draft: draftFromConnection(connection),
        editingId: connection.id,
        formSelected: 0,
        notice: "",
      };
    }
    case "set_field":
      return setDraftField(state, action.field, action.value);
    case "append_field":
      return setDraftField(state, action.field, action.value, true);
    case "delete_field": {
      if (!state.draft || action.field === "protocol") return state;
      const current = state.draft[action.field];
      return setDraftField(
        state,
        action.field,
        current.slice(0, -Math.max(1, action.count || 1)),
      );
    }
    case "toggle_protocol":
      if (!state.draft) return state;
      {
        const protocols: readonly ModelConnectionProtocol[] = [
          "openai-compatible",
          "openai-responses",
          "anthropic-messages",
        ];
        const current = protocols.indexOf(state.draft.protocol);
        const next = protocols[(current + 1) % protocols.length];
        return {
          ...state,
          draft: {
            ...state.draft,
            protocol: next,
          },
          notice: "",
        };
      }
    case "toggle_private_network":
      if (!state.draft) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          allowPrivateNetwork: !state.draft.allowPrivateNetwork,
        },
        notice: state.draft.allowPrivateNetwork
          ? "Private/LAN endpoint authority disabled."
          : "Private/LAN HTTPS authority enabled for this exact profile.",
      };
    case "set_form_selected":
      return {
        ...state,
        formSelected: Math.max(
          0,
          Math.min(MODEL_CONNECTION_FORM_ROWS.length - 1, action.index),
        ),
      };
    case "discard_draft":
      return {
        ...state,
        view: "list",
        draft: null,
        editingId: null,
        notice: "Draft discarded.",
      };
    case "start_credential_entry":
      if (
        !state.draft
        || !/^keychain:[^/\s:]+\/[^/\s]+$/.test(state.draft.credentialRef)
      ) {
        return {
          ...state,
          notice: "Set Credential reference to keychain:service/account first.",
        };
      }
      return {
        ...state,
        view: "credential_entry",
        credentialInput: "",
        notice: "",
      };
    case "append_credential_input":
      return {
        ...state,
        credentialInput: appendCredentialInput(
          state.credentialInput,
          action.value,
        ),
        notice: "",
      };
    case "delete_credential_input":
      return {
        ...state,
        credentialInput: state.credentialInput.slice(
          0,
          -Math.max(1, action.count || 1),
        ),
      };
    case "cancel_credential_entry":
      return {
        ...state,
        view: "form",
        credentialInput: "",
        notice: "Credential entry cancelled; nothing was stored.",
      };
    case "request_remove":
      return {
        ...state,
        view: "remove_confirm",
        removeTargetId: action.id,
        notice: "",
      };
    case "cancel_remove":
      return {
        ...state,
        view: "list",
        removeTargetId: null,
        notice: "Removal cancelled.",
      };
    case "request_started": {
      const next = {
        ...state,
        pending: {
          action: action.action,
          requestId: action.requestId,
          ...(action.connectionId ? { connectionId: action.connectionId } : {}),
        },
        notice: "",
        ...(action.action === "store_credential"
          ? { credentialInput: "" }
          : {}),
      };
      return action.action === "check" || action.action === "format_probe"
        ? markCheckPending(next, action.action, action.requestId, action.connectionId)
        : next;
    }
    case "request_failed":
      if (!state.pending || state.pending.requestId !== action.requestId) return state;
      return {
        ...state,
        pending: null,
        view: state.view === "repair_pending" ? state.repairReturnView : state.view,
        notice: redactModelConnectionText(action.detail),
      };
    case "backend_event":
      if (action.event.action === "store_credential") {
        return {
          ...state,
          pending: null,
          view: "form",
          credentialInput: "",
          notice: action.event.ok
            ? "Credential stored in the OS keyring."
            : action.event.detail || "Credential was not stored.",
        };
      }
      return applyBackendEvent(state, action.event);
    case "set_repair_consent":
      return { ...state, repairConsent: action.value };
    case "decline_repair":
      return {
        ...state,
        view: state.repairReturnView,
        repairConsent: "no",
        notice: "Repair suggestion declined; no code or configuration changed.",
      };
    case "repair_requested":
      return {
        ...state,
        view: "repair_pending",
        pending: {
          action: "repair_plan",
          requestId: action.requestId,
          ...(state.editingId ? { connectionId: state.editingId } : {}),
        },
        repairConsent: "yes",
        notice: "",
      };
    case "cancel_repair_request":
      return {
        ...state,
        view: state.repairReturnView,
        pending: null,
        notice: "Repair request dismissed; no suggestion was applied.",
      };
    case "set_repair_preview_approval":
      return { ...state, repairPreviewApproval: action.value };
    case "finish_repair_preview": {
      if (state.repairPreviewApproval !== "yes" || !state.repairSuggestion) {
        return {
          ...state,
          view: state.repairReturnView,
          repairSuggestion: null,
          repairPreviewApproval: "no",
          notice: "Repair preview closed; no draft or configuration changed.",
        };
      }
      const saved = state.editingId
        ? state.connections.find((connection) => connection.id === state.editingId)
        : undefined;
      const base = state.draft || (saved ? draftFromConnection(saved) : null);
      if (!base) {
        return {
          ...state,
          view: "list",
          repairSuggestion: null,
          notice: "Repair preview could not be applied because the draft is unavailable.",
        };
      }
      return {
        ...state,
        view: "form",
        draft: {
          ...base,
          ...state.repairSuggestion.changes,
          checks: base.checks,
        },
        repairSuggestion: null,
        repairPreviewApproval: "no",
        notice: "Suggestion applied to the unsaved draft only. Review it, then save explicitly.",
      };
    }
  }
}

export function modelConnectionStatusLabel(checkStatus: ModelConnectionCheck): string {
  switch (checkStatus.state) {
    case "pending":
      return "pending";
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    default:
      return "not checked";
  }
}
