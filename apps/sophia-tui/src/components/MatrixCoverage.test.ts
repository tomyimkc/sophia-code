import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

test("event-backed chat, tool, workflow, and process surfaces use the shared matrix presenter", () => {
  const covered = [
    "MessageList.tsx",
    "ToolCard.tsx",
    "DiffView.tsx",
    "WorkflowTree.tsx",
    "TeamLanePanel.tsx",
    "PlanPanel.tsx",
    "GoalTodoPanel.tsx",
    "RightPanelDetails.tsx",
    "SessionFlowPanel.tsx",
    "SessionFlowDetails.tsx",
    "LocalEnginePanel.tsx",
    "NotificationToast.tsx",
    "../App.tsx",
  ];

  for (const name of covered) {
    assert.match(
      source(name),
      /\bMatrixText\b|\bMatrixGlyphRuns\b|\buseMatrixReveal\b/,
      `${name} must keep dynamic event text on the shared Matrix presentation path`,
    );
  }
});

test("typing and persistent status chrome remain outside the matrix presenter", () => {
  for (const name of [
    "PromptInput.tsx",
    "StatusLine.tsx",
    "WorkspaceContextLine.tsx",
  ]) {
    assert.doesNotMatch(
      source(name),
      /\bMatrixText\b|\bMatrixGlyphRuns\b|\buseMatrixReveal\b/,
      `${name} must stay stable so animation cannot interfere with input or session chrome`,
    );
  }
});
