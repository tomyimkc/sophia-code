#!/usr/bin/env node
// Test-only stand-in for `prime-agent --mode rpc`. Selected via an explicit
// PrimeAgentRuntime argv so tests stay hermetic (no Prime install, no network).
//
// Protocol (minimal Prime Agent v0.7.1 subset that Sophia consumes):
//   stdin  — one JSON command per line, e.g. {"type":"prompt","message":"..."}
//   stdout — JSONL response + agent/message/tool/UI events
//
// Modes via FAKE_PI_MODE:
//   "echo"     (default) — stream the prompt text, then agent_end
//   "ui"       — emit one confirm request, wait for response, then agent_end
//   "tools"    — emit a read tool start/end before the answer
//   "multi"    — emit intermediate assistant text before the final answer
//   "extension_error" — invalidate the policy extension during a turn
//   "error"    — reject the prompt command
//   "silent"   — never write (timeout path)

import readline from "node:readline";

const mode = process.env.FAKE_PI_MODE || "echo";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (mode === "silent") {
  // Hang until parent kills us.
  setInterval(() => {}, 60_000);
} else {
  let pendingUi = null; // { message, requestId } | null
  let turn = 0;

  function finish(message, requestId) {
    turn += 1;
    const text = `[prime-fixture turn=${turn}] ${message}\u2028unicode-separator-preserved`;
    const assistant = { role: "assistant", content: [{ type: "text", text }] };
    emit({ type: "message_start", message: assistant });
    emit({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    emit({ type: "message_end", message: assistant });
    emit({ type: "agent_end", messages: [
      { role: "user", content: [{ type: "text", text: message }] },
      assistant,
    ] });
    return requestId;
  }

  rl.on("line", (line) => {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      emit({ type: "error", error: "invalid JSON command" });
      return;
    }
    const type = cmd.type || cmd.cmd;

    if (pendingUi && type === "extension_ui_response") {
      const allowed = Boolean(cmd.confirmed ?? cmd.allow);
      const { message, requestId } = pendingUi;
      pendingUi = null;
      finish(
        allowed
          ? `[prime-fixture-ui-allowed] ${message}`
          : `[prime-fixture-ui-denied] ${message}`,
        requestId,
      );
      return;
    }

    if (type === "abort") {
      emit({ type: "response", command: "abort", success: true });
      emit({ type: "agent_end", messages: [] });
      return;
    }

    if (type === "get_commands") {
      emit({
        id: cmd.id,
        type: "response",
        command: "get_commands",
        success: true,
        data: {
          commands: mode === "missing_policy" ? [] : [{
            name: "sophia-policy-status",
            description: "fixture policy handshake",
            source: "extension",
            sourceInfo: { scope: "temporary", source: "cli" },
          }],
        },
      });
      return;
    }

    if (type !== "prompt") {
      emit({ id: cmd.id, type: "response", command: type, success: false,
        error: `unsupported command ${type}` });
      return;
    }
    const message = String(cmd.message || cmd.prompt || "");

    if (mode === "error") {
      emit({ id: cmd.id, type: "response", command: "prompt", success: false,
        error: "fixture forced error" });
      return;
    }

    emit({ id: cmd.id, type: "response", command: "prompt", success: true });
    emit({ type: "agent_start" });

    if (mode === "extension_error") {
      emit({ type: "extension_error", error: "fixture invalidated extension" });
      return;
    }

    if (mode === "ui") {
      pendingUi = { message, requestId: cmd.id };
      emit({
        type: "extension_ui_request",
        id: "ui-fixture-1",
        method: "confirm",
        title: "Fixture confirmation",
        message: "Allow the fixture response?",
      });
      return;
    }

    if (mode === "tools") {
      emit({
        type: "tool_execution_start",
        toolCallId: "tool-fixture-1",
        toolName: "read",
        args: { path: "README.md" },
      });
      emit({
        type: "tool_execution_end",
        toolCallId: "tool-fixture-1",
        toolName: "read",
        result: { content: "fixture" },
        isError: false,
      });
    }

    if (mode === "multi") {
      const intermediate = {
        role: "assistant",
        content: [{ type: "text", text: "intermediate planning text" }],
      };
      emit({ type: "message_start", message: intermediate });
      emit({
        type: "message_update",
        message: intermediate,
        assistantMessageEvent: {
          type: "text_delta",
          delta: "intermediate planning text",
        },
      });
      emit({ type: "message_end", message: intermediate });
    }

    finish(message, cmd.id);
  });
}
