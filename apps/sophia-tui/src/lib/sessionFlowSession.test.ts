import test from "node:test";
import assert from "node:assert/strict";
import {
  retargetFlowRunSessions,
  sessionForFlowEvent,
} from "./sessionFlowSession.js";

test("late events remain owned by their original session after a session switch", () => {
  const ledger = new Map<string, string>();
  assert.equal(
    sessionForFlowEvent(
      { type: "run_start", runId: "run-a", session: "session-a" },
      "session-a",
      ledger,
    ),
    "session-a",
  );
  assert.equal(
    sessionForFlowEvent(
      { type: "tool_result", runId: "run-a", ok: true },
      "session-b",
      ledger,
    ),
    "session-a",
  );
  assert.equal(
    sessionForFlowEvent(
      { type: "run_start", runId: "run-b", session: "session-b" },
      "session-b",
      ledger,
    ),
    "session-b",
  );
});

test("session rename retargets remembered run ownership without losing receipts", () => {
  const ledger = new Map([["run-a", "old-name"]]);
  retargetFlowRunSessions(ledger, "old-name", "new-name");
  assert.equal(ledger.get("run-a"), "new-name");
});
