import test from "node:test";
import assert from "node:assert/strict";
import {
  agentBotPresentation,
  agentBotState,
} from "./AgentStatusBot.js";

const motion = { screenReader: false, reducedMotion: false };

test("agent bot lifecycle mapping distinguishes work, wait, terminal, and idle states", () => {
  assert.equal(agentBotState("running"), "working");
  assert.equal(agentBotState("queued_for_model"), "queued");
  assert.equal(agentBotState("waiting_input"), "waiting");
  assert.equal(agentBotState("succeeded"), "succeeded");
  assert.equal(agentBotState("timed_out"), "failed");
  assert.equal(agentBotState("cancelled"), "cancelled");
  assert.equal(agentBotState("idle"), "idle");
  assert.equal(agentBotState("unstarted"), "unstarted");
  assert.equal(agentBotState("never_started"), "unstarted");
  assert.equal(agentBotState(""), "unstarted");
  assert.equal(agentBotState("unknown"), "unstarted");
  assert.equal(agentBotState("not-a-real-status"), "unstarted");
  assert.notEqual(agentBotState("unstarted"), "idle");
  assert.notEqual(agentBotState("not-a-real-status"), "idle");
  assert.equal(agentBotState("queued", true), "working");
  assert.equal(agentBotState("succeeded", true), "succeeded");
  assert.equal(agentBotState("failed", true), "failed");
  assert.equal(agentBotState("cancelled", true), "cancelled");
});

test("working and queued bots animate without variable-width or emoji glyphs", () => {
  const working = Array.from({ length: 4 }, (_, frame) =>
    agentBotPresentation("working", frame, motion).face
  );
  const queued = Array.from({ length: 4 }, (_, frame) =>
    agentBotPresentation("queued", frame, motion).face
  );
  assert.equal(new Set(working).size, 3);
  assert.equal(new Set(queued).size, 3);
  [...working, ...queued].forEach((face) => {
    assert.equal(face.length, 5);
    assert.match(face, /^\[[\x20-\x7e]{3}\]$/);
  });
});

test("reduced motion freezes the bot and screen readers receive status text only", () => {
  assert.equal(
    agentBotPresentation(
      "working",
      9,
      { screenReader: false, reducedMotion: true },
    ).face,
    "[o_o]",
  );
  assert.deepEqual(
    agentBotPresentation(
      "waiting",
      3,
      { screenReader: true, reducedMotion: true },
    ),
    { face: "", label: "waiting" },
  );
});
