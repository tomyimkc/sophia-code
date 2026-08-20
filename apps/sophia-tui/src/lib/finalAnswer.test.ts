import test from "node:test";
import assert from "node:assert/strict";
import {
  activeExchangeAssistantTexts,
  displayFinalText,
  pinMessageToEnd,
  preferBestFinalText,
  resolveFinalRow,
  shouldRevealTerminalResult,
} from "./finalAnswer.js";

test("a terminal answer is revealed when the viewport only drifted a few rows", () => {
  assert.equal(
    shouldRevealTerminalResult({ followLatest: false, scrollOffset: 3 }),
    true,
  );
  assert.equal(
    shouldRevealTerminalResult({ followLatest: false, scrollOffset: 12 }),
    true,
  );
});

test("intentional deep scrollback is preserved and must show a completion hint", () => {
  assert.equal(
    shouldRevealTerminalResult({ followLatest: false, scrollOffset: 13 }),
    false,
  );
  assert.equal(
    shouldRevealTerminalResult({ followLatest: false, scrollOffset: 200 }),
    false,
  );
});

test("follow-latest always reveals the terminal answer", () => {
  assert.equal(
    shouldRevealTerminalResult({ followLatest: true, scrollOffset: 200 }),
    true,
  );
});

test("exact output is never modified by the display cap", () => {
  const payload = "X".repeat(9000);
  assert.equal(
    displayFinalText(payload, { exactOutput: true, cap: 8000 }),
    payload,
  );
});

test("ordinary long output remains honestly clamped for layout cost", () => {
  const payload = "X".repeat(9000);
  const shown = displayFinalText(payload, { exactOutput: false, cap: 8000 });
  assert.equal(shown.slice(0, 8000), payload.slice(0, 8000));
  assert.match(shown, /truncated for display: 9000 chars total/);
});

test("the authoritative result UPGRADES the truncated preview instead of being deduped away", () => {
  // The exact defect. The kernel's `final` is a capped preview and the bridge's
  // `result` carries the full answer, but both key on ev.id || ev.runId and
  // neither carries an id — so the keys collide. Treating the result as a
  // duplicate dropped the full answer and the user read a reply cut off
  // mid-sentence, with no marker.
  assert.deepEqual(
    resolveFinalRow({ text: "A".repeat(900), previewRowId: "row-1", alreadyDelivered: true }),
    { action: "upgrade", id: "row-1" },
  );
});

test("a longer result still pushes when delivery was marked but the preview row id was lost", () => {
  assert.deepEqual(
    resolveFinalRow({
      text: "A".repeat(900),
      alreadyDelivered: true,
      existingTextLength: 500,
    }),
    { action: "push" },
  );
});

test("a preview row is upgraded even when the key was not otherwise recorded", () => {
  assert.deepEqual(
    resolveFinalRow({ text: "full answer", previewRowId: "row-7", alreadyDelivered: false }),
    { action: "upgrade", id: "row-7" },
  );
});

test("with no preview row, an undelivered result is pushed as a new row", () => {
  assert.deepEqual(
    resolveFinalRow({ text: "answer", alreadyDelivered: false }),
    { action: "push" },
  );
});

test("a genuinely duplicated result is still skipped — the answer must not render twice", () => {
  // The opposite failure: upgrading unconditionally, or always pushing, would
  // duplicate the reply. Only a PREVIEW row may be rewritten.
  assert.deepEqual(
    resolveFinalRow({ text: "answer", alreadyDelivered: true }),
    { action: "skip" },
  );
});

test("an empty or whitespace-only result is an error row, never a silent no-op", () => {
  // A run that ends with nothing must say so; silently ending is how a failed
  // run looks identical to a successful one.
  for (const text of ["", "   ", "\n\t "]) {
    assert.deepEqual(resolveFinalRow({ text, alreadyDelivered: false }), { action: "error" });
    assert.deepEqual(
      resolveFinalRow({ text, previewRowId: "row-1", alreadyDelivered: true }),
      { action: "error" },
      "emptiness outranks the preview: never blank out a row that already has text",
    );
  }
});

test("preferBestFinalText keeps a longer mid-run report over a short terminal recap", () => {
  const report = "All 8 attempts complete. Final report:\n" + "A".repeat(500);
  const recap = "The task is fully complete and the final report has been delivered.";
  assert.equal(
    preferBestFinalText(recap, ["short", report, "also short"]),
    report,
  );
  assert.equal(preferBestFinalText(report, ["tiny"]), report);
});

test("pinMessageToEnd moves the answer to the lowest chat row", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "t1", role: "tool" },
    { id: "a2", role: "assistant" },
  ];
  const pinned = pinMessageToEnd(messages, { id: "a1", role: "assistant", text: "FINAL" } as {
    id: string;
    role: string;
    text?: string;
  });
  assert.equal(pinned.at(-1)?.id, "a1");
  assert.equal(pinned.filter((m) => m.id === "a1").length, 1);
  assert.deepEqual(
    pinned.map((m) => m.id),
    ["u1", "t1", "a2", "a1"],
  );
});

test("activeExchangeAssistantTexts only reads after the last user turn", () => {
  const texts = activeExchangeAssistantTexts([
    { role: "user", text: "old goal" },
    { role: "assistant", text: "old answer" },
    { role: "user", text: "new goal" },
    { role: "assistant", text: "step 1" },
    { role: "tool", text: "ok" },
    { role: "assistant", text: "FINAL REPORT" },
  ]);
  assert.deepEqual(texts, ["step 1", "FINAL REPORT"]);
});
