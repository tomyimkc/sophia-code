import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./types.js";
import {
  dragAutoScrollAtRow,
  hitRegionAtRow,
  nearestHitRegion,
  selectedMessageIds,
  selectedTranscriptText,
} from "./transcriptSelection.js";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "first prompt" },
  { id: "a1", role: "assistant", text: "first answer" },
  { id: "u2", role: "user", text: "second prompt" },
  { id: "a2", role: "assistant", text: "second answer" },
];

test("selection spans messages in either drag direction and copies content without chrome", () => {
  const down = { anchorId: "a1", headId: "a2" };
  const up = { anchorId: "a2", headId: "a1" };
  assert.deepEqual([...selectedMessageIds(messages, down)], ["a1", "u2", "a2"]);
  assert.deepEqual([...selectedMessageIds(messages, up)], ["a1", "u2", "a2"]);
  assert.equal(
    selectedTranscriptText(messages, down),
    "first answer\n\nsecond prompt\n\nsecond answer",
  );
});

test("stale or missing selection endpoints fail closed", () => {
  assert.deepEqual([...selectedMessageIds(messages, { anchorId: "missing", headId: "a2" })], []);
  assert.equal(selectedTranscriptText(messages, null), "");
});

test("hit testing uses whole visible message regions and can clamp outside the pane", () => {
  const hits = [
    { id: "a", screenRow: 5, screenEndRow: 8 },
    { id: "b", screenRow: 9, screenEndRow: 12 },
  ];
  assert.equal(hitRegionAtRow(hits, 7)?.id, "a");
  assert.equal(hitRegionAtRow(hits, 10)?.id, "b");
  assert.equal(hitRegionAtRow(hits, 4), null);
  assert.equal(nearestHitRegion(hits, 1)?.id, "a");
  assert.equal(nearestHitRegion(hits, 30)?.id, "b");
});

test("drag autoscroll activates at both pane edges and accelerates outside", () => {
  assert.deepEqual(dragAutoScrollAtRow(10, 10, 20), { delta: 2 });
  assert.deepEqual(dragAutoScrollAtRow(11, 10, 20), { delta: 1 });
  assert.equal(dragAutoScrollAtRow(15, 10, 20), null);
  assert.deepEqual(dragAutoScrollAtRow(28, 10, 20), { delta: -1 });
  assert.deepEqual(dragAutoScrollAtRow(29, 10, 20), { delta: -2 });
  assert.deepEqual(dragAutoScrollAtRow(35, 10, 20), { delta: -5 });
});
