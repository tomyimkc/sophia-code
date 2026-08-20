import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TODO_STATE, todoReducer } from "./todoState.js";

test("todo updates replace the visible checklist", () => {
  const next = todoReducer(EMPTY_TODO_STATE, {
    type: "todo_update",
    items: [
      { id: "a", content: "Inspect bridge", status: "completed" },
      { id: "b", content: "Patch panel", status: "in_progress" },
    ],
  });
  assert.deepEqual(next.items, [
    { id: "a", content: "Inspect bridge", status: "completed" },
    { id: "b", content: "Patch panel", status: "in_progress" },
  ]);
  assert.equal(typeof next.updatedAt, "number");
});

test("malformed checklist rows are ignored and empty updates clear it", () => {
  const populated = todoReducer(EMPTY_TODO_STATE, {
    type: "todo_update",
    items: [{ content: "keep", status: "unknown" }, null, { content: "" }],
  });
  assert.deepEqual(populated.items, [{ id: "td-0", content: "keep", status: "pending" }]);
  assert.deepEqual(todoReducer(populated, { type: "todo_update", items: [] }).items, []);
});

test("a new run starts with a fresh model-owned checklist", () => {
  const populated = todoReducer(EMPTY_TODO_STATE, { type: "todo_update", items: [{ content: "old" }] });
  assert.deepEqual(todoReducer(populated, { type: "run_start" }), EMPTY_TODO_STATE);
});

test("workflow-board replace and todo_write overlay merge", () => {
  const board = todoReducer(EMPTY_TODO_STATE, {
    type: "todo_update",
    source: "workflow-board",
    items: [
      { id: "bash-exitcode-control", content: "python3 tests/test_bash_exitcode.py", status: "in_progress" },
      { id: "workflow-result-authority", content: "python3 tests/test_workflow_result_authority.py", status: "pending" },
    ],
  });
  const overlaid = todoReducer(board, {
    type: "todo_update",
    source: "todo_write",
    items: [{ id: "td-extra", content: "cite both exitCodes", status: "pending" }],
  });
  assert.equal(overlaid.items.length, 3);
  assert.equal(overlaid.items[2]?.content, "cite both exitCodes");
  const failed = todoReducer(board, {
    type: "todo_update",
    source: "workflow-board",
    items: [
      { id: "bash-exitcode-control", content: "python3 tests/test_bash_exitcode.py", status: "completed" },
      { id: "workflow-result-authority", content: "python3 tests/test_workflow_result_authority.py", status: "failed" },
    ],
  });
  assert.equal(failed.items[1]?.status, "failed");
});

