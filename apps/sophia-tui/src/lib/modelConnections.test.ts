import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_MODEL_CONNECTIONS_STATE,
  MODEL_CONNECTION_TEMPLATES,
  appendCredentialInput,
  appendCredentialReference,
  buildModelConnectionCommand,
  createDraftFromTemplate,
  credentialReferenceError,
  maskCredentialReference,
  modelConnectionsReducer,
  parseModelConnectionBridgeEvent,
  validateModelConnectionDraft,
  type ModelConnectionRecord,
  type ModelConnectionsState,
} from "./modelConnections.js";

const savedConnection: ModelConnectionRecord = {
  id: "conn-1",
  templateId: "vllm",
  displayName: "Lab vLLM",
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "Qwen/Qwen3-Coder",
  credentialRef: "env:VLLM_API_KEY",
  allowPrivateNetwork: false,
  modelSpec: "custom:conn-1",
  checks: {
    connectivity: { state: "passed", detail: "reachable" },
    responseFormat: { state: "passed", detail: "assistant text parsed" },
  },
};

test("ships the requested provider templates without guessing installed models", () => {
  assert.deepEqual(
    MODEL_CONNECTION_TEMPLATES.map((template) => template.label),
    [
      "OpenAI-compatible",
      "OpenAI Responses",
      "Anthropic Messages",
      "Ollama",
      "vLLM",
      "SGLang",
      "llama.cpp",
      "oMLX / MLX",
    ],
  );
  assert.equal(
    MODEL_CONNECTION_TEMPLATES.find((template) => template.id === "openai-responses")?.protocol,
    "openai-responses",
  );
  assert.equal(
    MODEL_CONNECTION_TEMPLATES.find((template) => template.id === "anthropic-messages")?.protocol,
    "anthropic-messages",
  );
  assert.equal(
    MODEL_CONNECTION_TEMPLATES.filter((template) =>
      !["anthropic-messages", "openai-responses"].includes(template.id)
    )
      .every((template) => template.protocol === "openai-compatible"),
    true,
  );
  assert.equal(
    MODEL_CONNECTION_TEMPLATES.filter((template) => template.id !== "openai-compatible")
      .every((template) => template.model === ""),
    true,
  );
});

test("accepts references, masks them, and rejects direct secrets", () => {
  assert.equal(credentialReferenceError("env:OPENAI_API_KEY"), null);
  assert.equal(credentialReferenceError("keychain:sophia/openai"), null);
  assert.match(credentialReferenceError("sk-proj-1234567890abcdef") || "", /Raw secrets/);
  assert.equal(maskCredentialReference("env:OPENAI_API_KEY"), "env:OPE…KEY");
  assert.equal(maskCredentialReference("keychain:sophia/openai"), "keychain:so…ia/op…ai");

  const typed = appendCredentialReference("sk", "-proj-1234567890abcdef");
  assert.deepEqual(typed, { value: "", rejectedRawSecret: true });
});

test("validates URL, model, and credential reference before bridge serialization", () => {
  const draft = createDraftFromTemplate("vllm");
  assert.deepEqual(validateModelConnectionDraft(draft), ["Model is required."]);
  const badUrl = {
    ...draft,
    model: "qwen",
    baseUrl: "https://user:secret@example.test/v1",
  };
  assert.match(validateModelConnectionDraft(badUrl).join(" "), /must not contain embedded credentials/);

  const privateWithoutConsent = {
    ...draft,
    model: "qwen",
    baseUrl: "https://10.0.0.8/v1",
  };
  assert.match(
    validateModelConnectionDraft(privateWithoutConsent).join(" "),
    /require explicit approval/,
  );

  const privatePlaintext = {
    ...privateWithoutConsent,
    baseUrl: "http://model.internal/v1",
    allowPrivateNetwork: true,
  };
  assert.match(
    validateModelConnectionDraft(privatePlaintext).join(" "),
    /require HTTPS/,
  );

  const metadataHost = {
    ...privateWithoutConsent,
    baseUrl: "https://metadata.google.internal/computeMetadata/v1",
    allowPrivateNetwork: true,
  };
  assert.match(
    validateModelConnectionDraft(metadataHost).join(" "),
    /metadata endpoints are forbidden/,
  );

  const privateApproved = {
    ...privateWithoutConsent,
    allowPrivateNetwork: true,
  };
  assert.deepEqual(validateModelConnectionDraft(privateApproved), []);
});

test("builds the exact model_connection command family and never emits a raw key field", () => {
  const draft = {
    ...createDraftFromTemplate("openai-compatible"),
    model: "gpt-compatible-model",
  };
  const save = buildModelConnectionCommand({
    action: "save",
    requestId: "req-save",
    draft,
  });
  assert.deepEqual(save, {
    cmd: "model_connection",
    action: "save",
    requestId: "req-save",
    connection: {
      templateId: "openai-compatible",
      displayName: "OpenAI-compatible endpoint",
      protocol: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-compatible-model",
      credentialRef: "env:OPENAI_API_KEY",
      allowPrivateNetwork: false,
    },
  });
  assert.equal(JSON.stringify(save).includes("apiKey"), false);
  assert.equal(JSON.stringify(save).includes("sk-"), false);

  assert.deepEqual(
    buildModelConnectionCommand({
      action: "format_probe",
      requestId: "req-format",
      draft,
    }),
    {
      cmd: "model_connection",
      action: "format_probe",
      requestId: "req-format",
      consent: true,
      connection: save.connection,
    },
  );

  assert.deepEqual(
    buildModelConnectionCommand({
      action: "repair_plan",
      requestId: "req-repair",
      draft,
    }),
    {
      cmd: "model_connection",
      action: "repair_plan",
      requestId: "req-repair",
      consent: true,
      connection: save.connection,
    },
  );
});

test("stores a raw credential only in the one-way local bridge command", () => {
  const secret = "credential-value-never-for-output";
  const command = buildModelConnectionCommand({
    action: "store_credential",
    requestId: "req-store",
    credentialRef: "keychain:sophia/lab",
    credentialValue: secret,
  });
  assert.deepEqual(command, {
    cmd: "model_connection",
    action: "store_credential",
    requestId: "req-store",
    credentialRef: "keychain:sophia/lab",
    credentialValue: secret,
  });
  assert.throws(
    () => buildModelConnectionCommand({
      action: "store_credential",
      requestId: "req-bad-store",
      credentialRef: "env:CUSTOM_MODEL_API_KEY",
      credentialValue: secret,
    }),
    /keychain/,
  );
});

test("credential entry is masked, bounded, cancellable, and cleared on send", () => {
  let state: ModelConnectionsState = {
    ...INITIAL_MODEL_CONNECTIONS_STATE,
    open: true,
    view: "form",
    draft: {
      ...createDraftFromTemplate("openai-compatible"),
      model: "gpt-compatible-model",
      credentialRef: "keychain:sophia/lab",
      allowPrivateNetwork: false,
    },
  };
  state = modelConnectionsReducer(state, { type: "start_credential_entry" });
  assert.equal(state.view, "credential_entry");
  state = modelConnectionsReducer(state, {
    type: "append_credential_input",
    value: "secret\nvalue",
  });
  assert.equal(state.credentialInput, "secretvalue");
  state = modelConnectionsReducer(state, {
    type: "request_started",
    action: "store_credential",
    requestId: "req-store",
  });
  assert.equal(state.credentialInput, "");

  const bounded = appendCredentialInput("", "x".repeat(9000));
  assert.equal(bounded.length, 8192);
});

test("does not optimistically claim save success before a backend event", () => {
  let state = modelConnectionsReducer(INITIAL_MODEL_CONNECTIONS_STATE, {
    type: "open",
    start: "templates",
  });
  state = modelConnectionsReducer(state, { type: "select_template" });
  state = modelConnectionsReducer(state, {
    type: "set_field",
    field: "model",
    value: "Qwen/Qwen3-Coder",
  });
  state = modelConnectionsReducer(state, {
    type: "request_started",
    action: "save",
    requestId: "req-save",
  });
  assert.equal(state.pending?.action, "save");
  assert.equal(state.connections.length, 0);
  assert.equal(state.view, "form");

  state = modelConnectionsReducer(state, {
    type: "backend_event",
    event: {
      type: "model_connection",
      action: "save",
      requestId: "req-save",
      ok: true,
      connection: savedConnection,
    },
  });
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].id, "conn-1");
  assert.equal(state.view, "list");
});

test("private/LAN authority is explicit and protocol cycling includes Responses", () => {
  let state: ModelConnectionsState = {
    ...INITIAL_MODEL_CONNECTIONS_STATE,
    open: true,
    view: "form",
    draft: {
      ...createDraftFromTemplate("vllm"),
      model: "qwen",
    },
  };
  assert.equal(state.draft?.allowPrivateNetwork, false);
  state = modelConnectionsReducer(state, { type: "toggle_private_network" });
  assert.equal(state.draft?.allowPrivateNetwork, true);
  assert.match(state.notice, /enabled/);

  state = modelConnectionsReducer(state, { type: "toggle_protocol" });
  assert.equal(state.draft?.protocol, "openai-responses");
  state = modelConnectionsReducer(state, { type: "toggle_protocol" });
  assert.equal(state.draft?.protocol, "anthropic-messages");
});

test("failed checks open an optional repair consent gate defaulted to no", () => {
  let state: ModelConnectionsState = {
    ...INITIAL_MODEL_CONNECTIONS_STATE,
    open: true,
    view: "form" as const,
    draft: {
      ...createDraftFromTemplate("ollama"),
      model: "qwen3",
    },
  };
  state = modelConnectionsReducer(state, {
    type: "request_started",
    action: "check",
    requestId: "req-check",
  });
  assert.equal(state.draft?.checks.connectivity.state, "pending");
  state = modelConnectionsReducer(state, {
    type: "backend_event",
    event: {
      type: "model_connection",
      action: "check",
      requestId: "req-check",
      ok: false,
      detail: "connection refused",
    },
  });
  assert.equal(state.view, "repair_consent");
  assert.equal(state.repairConsent, "no");
  assert.equal(state.draft?.checks.connectivity.state, "failed");

  state = modelConnectionsReducer(state, { type: "decline_repair" });
  assert.equal(state.view, "form");
  assert.match(state.notice, /no code or configuration changed/);
});

test("repair plan is preview-only and applies only to the unsaved draft after approval", () => {
  let state: ModelConnectionsState = {
    ...INITIAL_MODEL_CONNECTIONS_STATE,
    open: true,
    view: "repair_pending" as const,
    draft: {
      ...createDraftFromTemplate("vllm"),
      model: "qwen",
    },
    pending: {
      action: "repair_plan" as const,
      requestId: "req-repair",
    },
  };
  state = modelConnectionsReducer(state, {
    type: "backend_event",
    event: {
      type: "model_connection",
      action: "repair_plan",
      requestId: "req-repair",
      ok: true,
      suggestion: {
        summary: "Try the server's /v1 prefix.",
        changes: { baseUrl: "http://127.0.0.1:9000/v1" },
      },
    },
  });
  assert.equal(state.view, "repair_preview");
  assert.equal(state.repairPreviewApproval, "no");
  assert.equal(state.draft?.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(state.connections.length, 0);

  state = modelConnectionsReducer(state, {
    type: "set_repair_preview_approval",
    value: "yes",
  });
  state = modelConnectionsReducer(state, { type: "finish_repair_preview" });
  assert.equal(state.view, "form");
  assert.equal(state.draft?.baseUrl, "http://127.0.0.1:9000/v1");
  assert.equal(state.connections.length, 0);
  assert.match(state.notice, /unsaved draft only/);
});

test("response parser allow-lists fields and drops an unexpected raw apiKey", () => {
  const parsed = parseModelConnectionBridgeEvent({
    type: "model_connection",
    action: "save",
    requestId: "req-save",
    ok: true,
    connection: {
      ...savedConnection,
      apiKey: "sk-should-never-survive",
    },
  });
  assert.ok(parsed?.connection);
  assert.equal("apiKey" in (parsed?.connection || {}), false);
  assert.equal(JSON.stringify(parsed).includes("sk-should-never-survive"), false);
});
