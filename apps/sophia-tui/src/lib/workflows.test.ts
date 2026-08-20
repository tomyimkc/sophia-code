import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryLocalWorkflowMetadataStore,
  assessWorkflow,
  createLocalWorkflowMetadata,
  filterWorkflowPickerEntries,
  isWorkflowResumable,
  parseLocalWorkflowMetadata,
  serializeLocalWorkflowMetadata,
  updateLocalWorkflowMetadata,
  workflowPickerEntries,
  type SophiaSkill,
  type SophiaWorkflowDefinition,
} from "./workflows.js";

const readCapability = { id: "files.read", label: "Read files", risk: "read" as const };
const executeCapability = { id: "shell.execute", label: "Run commands", risk: "execute" as const };

const skills: SophiaSkill[] = [
  {
    id: "repo-inspector",
    name: "Repository inspector",
    summary: "Reads local project files.",
    source: "sophia",
    availability: "available",
    capabilities: [readCapability],
  },
  {
    id: "terminal-runner",
    name: "Terminal runner",
    summary: "Runs approved local commands.",
    source: "local",
    availability: "needs_setup",
    reason: "Choose a permission mode before command execution.",
    capabilities: [executeCapability],
  },
  {
    id: "provenance-preview",
    name: "Provenance preview",
    summary: "Experimental local provenance view.",
    source: "sophia",
    availability: "experimental",
    experimental: true,
    capabilities: [readCapability],
  },
];

const inspectWorkflow: SophiaWorkflowDefinition = {
  id: "inspect",
  title: "Inspect repository",
  summary: "Build a local evidence-based inventory.",
  version: "1",
  requiredSkillIds: ["repo-inspector"],
  capabilityIds: ["files.read"],
  resumable: true,
  localOnly: true,
};

test("workflow assessment is ready only when required skills and capabilities are available", () => {
  const assessment = assessWorkflow(inspectWorkflow, skills);
  assert.equal(assessment.readiness, "ready");
  assert.equal(assessment.selectable, true);
  assert.deepEqual(assessment.capabilities.map((capability) => capability.id), ["files.read"]);
});

test("missing, disabled, or not-yet-configured required skills block selection honestly", () => {
  const workflow: SophiaWorkflowDefinition = {
    ...inspectWorkflow,
    id: "change",
    title: "Implement change",
    requiredSkillIds: ["repo-inspector", "terminal-runner", "not-installed"],
  };
  const assessment = assessWorkflow(workflow, skills);
  assert.equal(assessment.readiness, "blocked");
  assert.equal(assessment.selectable, false);
  assert.deepEqual(assessment.blockedSkillIds, ["terminal-runner"]);
  assert.deepEqual(assessment.missingSkillIds, ["not-installed"]);
  assert.match(assessment.reasons.join(" "), /permission mode/);
  assert.match(assessment.reasons.join(" "), /not installed/);
});

test("experimental skills and workflows remain selectable but visibly experimental", () => {
  const workflow: SophiaWorkflowDefinition = {
    ...inspectWorkflow,
    id: "provenance",
    title: "Preview provenance",
    requiredSkillIds: ["provenance-preview"],
  };
  const assessment = assessWorkflow(workflow, skills);
  assert.equal(assessment.readiness, "experimental");
  assert.equal(assessment.selectable, true);
});

test("picker entries represent both workflows and skills with honest badges", () => {
  const blocked: SophiaWorkflowDefinition = {
    ...inspectWorkflow,
    id: "execute",
    title: "Execute checks",
    requiredSkillIds: ["terminal-runner"],
  };
  const entries = workflowPickerEntries([inspectWorkflow, blocked], skills);
  assert.equal(entries.find((entry) => entry.id === "inspect")?.badge, "ready");
  assert.equal(entries.find((entry) => entry.id === "execute")?.selectable, false);
  assert.equal(entries.find((entry) => entry.id === "terminal-runner")?.badge, "needs setup");
});

test("picker filtering searches capability, reason, kind, and visible text", () => {
  const entries = workflowPickerEntries([inspectWorkflow], skills);
  assert.deepEqual(
    filterWorkflowPickerEntries(entries, "files.read", "workflow").map((entry) => entry.id),
    ["inspect"],
  );
  assert.deepEqual(
    filterWorkflowPickerEntries(entries, "permission", "skill").map((entry) => entry.id),
    ["terminal-runner"],
  );
});

test("resumable metadata is explicitly local-only and round-trips a bounded schema", () => {
  const metadata = createLocalWorkflowMetadata({
    runId: "run-1",
    workflow: inspectWorkflow,
    workspaceKey: "workspace-sha256-abc",
    sessionId: "session-1",
    planId: "plan-1",
    at: "2026-07-30T01:00:00.000Z",
  });
  const parsed = parseLocalWorkflowMetadata(serializeLocalWorkflowMetadata(metadata));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.storage, "local-only");
  assert.equal(parsed.value.workflowId, "inspect");
  assert.equal(isWorkflowResumable(parsed.value), true);
});

test("metadata checkpoints deduplicate completed steps and count resumes", () => {
  let metadata = createLocalWorkflowMetadata({
    runId: "run-1",
    workflow: inspectWorkflow,
    workspaceKey: "workspace-key",
  });
  metadata = updateLocalWorkflowMetadata(metadata, {
    status: "paused",
    currentStepId: "verify",
    completedStepId: "inspect",
    resumed: true,
  });
  metadata = updateLocalWorkflowMetadata(metadata, { completedStepId: "inspect" });
  assert.deepEqual(metadata.completedStepIds, ["inspect"]);
  assert.equal(metadata.currentStepId, "verify");
  assert.equal(metadata.resumeCount, 1);
  assert.equal(isWorkflowResumable(metadata), true);
  assert.equal(isWorkflowResumable({ ...metadata, status: "completed" }), false);
});

test("metadata parser rejects remote scope, unknown status, and malformed data", () => {
  const base = createLocalWorkflowMetadata({
    runId: "run-1",
    workflow: inspectWorkflow,
    workspaceKey: "workspace-key",
  });
  assert.deepEqual(parseLocalWorkflowMetadata("{nope"), {
    ok: false,
    error: "Workflow metadata is not valid JSON.",
  });
  assert.match(
    parseLocalWorkflowMetadata(JSON.stringify({ ...base, storage: "cloud" })).ok
      ? ""
      : (parseLocalWorkflowMetadata(JSON.stringify({ ...base, storage: "cloud" })) as { ok: false; error: string }).error,
    /local-only/,
  );
  assert.equal(parseLocalWorkflowMetadata(JSON.stringify({ ...base, status: "mystery" })).ok, false);
});

test("the local metadata store returns clones and newest records first", async () => {
  const store = new MemoryLocalWorkflowMetadataStore();
  const first = createLocalWorkflowMetadata({
    runId: "run-1",
    workflow: inspectWorkflow,
    workspaceKey: "workspace-key",
    at: "2026-07-30T01:00:00.000Z",
  });
  const second = createLocalWorkflowMetadata({
    runId: "run-2",
    workflow: inspectWorkflow,
    workspaceKey: "workspace-key",
    at: "2026-07-30T02:00:00.000Z",
  });
  await store.save(first);
  await store.save(second);
  const loaded = await store.load("run-1");
  assert.ok(loaded);
  loaded.completedStepIds.push("mutated-only-in-caller");
  assert.deepEqual((await store.load("run-1"))?.completedStepIds, []);
  assert.deepEqual((await store.list()).map((item) => item.runId), ["run-2", "run-1"]);
});
