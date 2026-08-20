import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import * as sessionStoreModule from "./sessionStore.js";
import type { SessionListItem } from "./sessionStore.js";
import {
  conversationPath,
  conversationsDir,
  formatResumeDriftWarnings,
  isAgentContinuationNudge,
  isDegenerateRepeatedResponse,
  loadSessionFromDisk,
  listSessionsFromDisk,
  pickTopic,
  provenanceDir,
  relativeTime,
  sessionFlowEventsFromTurns,
  turnsToChatMessages,
} from "./sessionStore.js";

test("session history replay is active-session scoped and omits raw tool bodies", () => {
  const events = sessionFlowEventsFromTurns("session-live", [
    { role: "user", content: "inspect the active session" },
    {
      role: "user",
      content:
        "[tool:read_file]\nsecret tool output sk-do-not-copy\n"
        + "[tool:write_file]\npermission denied",
    },
    { role: "assistant", content: "Inspection complete." },
    {
      role: "user",
      content:
        "You just received output from `read_file`. If the goal needs more steps, CALL the next tool now.",
    },
    { role: "user", content: "verify the result" },
    { role: "assistant", content: "Verified." },
  ]);

  assert.equal(
    events.filter((event) => event.type === "run_start").length,
    2,
  );
  assert.ok(events.every((event) => event.session === "session-live"));
  assert.doesNotMatch(JSON.stringify(events), /secret tool output/);
  assert.doesNotMatch(JSON.stringify(events), /sk-do-not-copy/);
  assert.match(JSON.stringify(events), /read_file/);
  assert.match(JSON.stringify(events), /write_file/);
});

// Point the disk reader at an isolated temp dir for these tests, and restore the
// prior value on exit so we never leak state into other test files. The reader
// reads SOPHIA_CONVERSATIONS_DIR on EVERY call (no module-level cache), so
// setting/unsetting process.env around each case is sufficient.
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = path.join(os.tmpdir(), `sophia-tui-sessionstore-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const prior = process.env.SOPHIA_CONVERSATIONS_DIR;
  process.env.SOPHIA_CONVERSATIONS_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prior === undefined) delete process.env.SOPHIA_CONVERSATIONS_DIR;
    else process.env.SOPHIA_CONVERSATIONS_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(os.tmpdir(), `sophia-tui-sessionstore-async-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const prior = process.env.SOPHIA_CONVERSATIONS_DIR;
  process.env.SOPHIA_CONVERSATIONS_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prior === undefined) delete process.env.SOPHIA_CONVERSATIONS_DIR;
    else process.env.SOPHIA_CONVERSATIONS_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConversation(dir: string, name: string, turns: unknown[]): string {
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(turns), "utf8");
  return file;
}

// ---- turnsToChatMessages (pure transforms — the highest-value target) ----

test("turnsToChatMessages maps assistant and user roles", () => {
  const msgs = turnsToChatMessages([
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "done." },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].text, "do the thing");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].text, "done.");
});

test("turnsToChatMessages skips empty-content turns (flash-to-empty regression)", () => {
  // PR #1539 root cause: the UI flashed empty when resume projected blanks.
  // Empty/whitespace turns must contribute nothing, not blank rows.
  const msgs = turnsToChatMessages([
    { role: "user", content: "" },
    { role: "assistant", content: "   " },
    { role: "user", content: undefined as unknown as string },
    { role: "assistant", content: "real answer" },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "real answer");
});

function repeatedMetaResponse(): string {
  const paragraphs = [
    "The user has supplied enough information and I should now give the final answer instead of narrating what I plan to do.",
    "Wait, perhaps another tool is needed, but the evidence is already present and the active request should be answered directly.",
    "I think the goal is complete, so I should provide the answer now without repeating the same deliberation again.",
  ];
  return Array.from({ length: 6 }, () => paragraphs).flat().join("\n\n");
}

test("turnsToChatMessages hides rejected kernel-loop turns and steering nudges", () => {
  const msgs = turnsToChatMessages([
    { role: "user", content: "give me the recommendation" },
    { role: "assistant", content: repeatedMetaResponse() },
    {
      role: "user",
      content: "You announced an action but did not call a tool. Do NOT describe the next step.",
    },
    { role: "assistant", content: "Direct recommendation: use the measured control." },
  ]);
  assert.deepEqual(
    msgs.map((message) => [message.role, message.text]),
    [
      ["user", "give me the recommendation"],
      ["assistant", "Direct recommendation: use the measured control."],
    ],
  );
});

test("turnsToChatMessages replaces an unrecovered repetitive final with one warning", () => {
  const repeated = repeatedMetaResponse();
  assert.equal(isDegenerateRepeatedResponse(repeated), true);
  const msgs = turnsToChatMessages([
    { role: "user", content: "give me the recommendation" },
    { role: "assistant", content: repeated },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, "system");
  assert.match(msgs[1].text, /repetitive model response hidden/);
  assert.equal(msgs[1].ok, false);
});

test("turnsToChatMessages splits multi-tool feedback so one ERROR fails only its own row", () => {
  // The kernel packs parallel tool results into ONE user turn. Splitting on the
  // [tool:...] boundary means a sibling ERROR must NOT mark the ok tools failed.
  const content =
    "[tool:read_file]\nthe file contents\n\n" +
    "[tool:outline]\nERROR: file not found\n\n" +
    "[tool:grep]\n3 matches";
  const msgs = turnsToChatMessages([{ role: "user", content }]);
  const tools = msgs.filter((m) => m.role === "tool");
  assert.equal(tools.length, 3, "each tool block becomes its own row");
  assert.equal(tools[0].meta, "read_file");
  assert.equal(tools[0].ok, true, "read_file succeeded");
  assert.equal(tools[1].meta, "outline");
  assert.equal(tools[1].ok, false, "outline errored");
  assert.equal(tools[2].meta, "grep");
  assert.equal(tools[2].ok, true, "grep succeeded despite sibling ERROR");
});

test("turnsToChatMessages flags empty-name parallel slots (Qwen/vLLM artifact)", () => {
  // Agent-loop hardening drops empty-name tool slots at the kernel boundary, but
  // the projection must still handle them defensively if they reach disk.
  const content = "[tool:]\n(empty)\n\n[tool:real_tool]\nok";
  const msgs = turnsToChatMessages([{ role: "user", content }]);
  const tools = msgs.filter((m) => m.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].ok, false, "empty tool name is a failed row");
  assert.equal(tools[0].meta, "(empty)");
  assert.equal(tools[1].ok, true);
  assert.equal(tools[1].meta, "real_tool");
});

test("turnsToChatMessages preserves ordinary full replies, clips oversized text, and caps UI turns at 60", () => {
  const ordinary = "x".repeat(3374);
  const ordinaryMessages = turnsToChatMessages([
    { role: "assistant", content: ordinary },
  ]);
  assert.equal(
    ordinaryMessages[0].text,
    ordinary,
    "resume must not truncate a response that the live 8,000-character row showed in full",
  );

  // 61 real turns → 1 system "hidden" marker + last 60 turns.
  const long = "x".repeat(9000);
  const turns = Array.from({ length: 61 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: long,
  }));
  const msgs = turnsToChatMessages(turns);
  assert.equal(msgs.length, 61, "1 hidden-marker + 60 projected turns");
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].text, /1 earlier turn\(s\) hidden in UI/);
  // Long text is clipped with a truncation marker, not dumped whole.
  assert.match(msgs[1].text, /\[truncated for display/);
  assert.ok(msgs[1].text.length < long.length);
});

test("turnsToChatMessages routes native-tool-call frames to system, not assistant", () => {
  const msgs = turnsToChatMessages([
    { role: "assistant", content: "[native tool calls omitted for brevity]" },
    { role: "assistant", content: "[incomplete native call]\npartial" },
    { role: "assistant", content: "actual answer" },
  ]);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "system");
  assert.equal(msgs[2].role, "assistant");
});

test("turnsToChatMessages expands every assistant turn on resume", () => {
  // Replies are expanded by default now (see shouldAutoCollapse), and resume
  // MUST agree with the live path. It used to expand only the last turn, which
  // was right when everything else arrived collapsed — but leaving it that way
  // would mean the same conversation looked different depending on whether you
  // had just watched it or reopened it, which is the worst of both.
  //
  // Volume is already bounded elsewhere and does not need a second mechanism
  // here: sessionStore caps the projection at RESUME_UI_MAX_TURNS with an
  // "earlier turns hidden" banner and clips each body to RESUME_TEXT_CAP, and
  // the transcript pane is windowed (chatLayout's visibleMessageWindow), so
  // off-screen rows cost nothing to lay out.
  const msgs = turnsToChatMessages([
    { role: "user", content: "first goal" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second goal" },
    { role: "assistant", content: "second answer" },
    { role: "user", content: "third goal" },
    { role: "assistant", content: "third (latest) answer" },
  ]);
  const assistants = msgs.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 3);
  for (const [i, m] of assistants.entries()) {
    assert.equal(m.collapsed, false, `assistant turn ${i} should be readable without a keypress`);
  }
});

test("turnsToChatMessages with no assistant turns does not throw and collapses nothing", () => {
  const msgs = turnsToChatMessages([
    { role: "user", content: "a goal with no reply yet" },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
});

// ---- disk-first reader (the /resume path PR #1539 added) ----

test("loadSessionFromDisk returns empty-ok when the file is missing", () => {
  withTempDir(() => {
    const r = loadSessionFromDisk("never-existed");
    assert.equal(r.ok, true);
    assert.equal(r.turns, 0);
    assert.deepEqual(r.messages, []);
    assert.equal(r.error, undefined);
  });
});

test("loadSessionFromDisk reads and projects a real conversation file", () => {
  withTempDir((dir) => {
    writeConversation(dir, "tui-default", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi back" },
    ]);
    const r = loadSessionFromDisk("tui-default");
    assert.equal(r.ok, true);
    assert.equal(r.turns, 2);
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].role, "user");
    assert.equal(r.messages[1].role, "assistant");
    assert.equal(r.session, "tui-default");
    assert.ok(r.path.endsWith("tui-default.json"));
  });
});

test("loadSessionFromDisk reports error on malformed JSON without throwing", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "broken.json"), "{ not json", "utf8");
    const r = loadSessionFromDisk("broken");
    assert.equal(r.ok, false);
    assert.equal(r.turns, 0);
    assert.deepEqual(r.messages, []);
    assert.ok(r.error, "error message must be populated");
  });
});

test("loadSessionFromDisk rejects a non-array conversation file", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "object.json"), JSON.stringify({ a: 1 }), "utf8");
    const r = loadSessionFromDisk("object");
    assert.equal(r.ok, false);
    assert.match(r.error || "", /not a JSON array/);
  });
});

test("loadSessionFromDisk flags invalid UTF-8 bytes instead of silently loading mojibake", () => {
  // Node's default "utf8" string decode is LOSSY (substitutes U+FFFD, never
  // throws). A bit-flipped or mid-multibyte-truncated transcript must be
  // treated as corrupt — same as the Python writer's strict-UTF-8 reader
  // (agent/cli.py _load_conversation) — not silently ingested as garbled text.
  withTempDir((dir) => {
    const prefix = Buffer.from('[{"role":"user","content":"broken: ');
    const invalid = Buffer.from([0xff, 0xfe]); // not a valid UTF-8 byte sequence
    const suffix = Buffer.from('"}]');
    writeFileSync(path.join(dir, "badbytes.json"), Buffer.concat([prefix, invalid, suffix]));
    const r = loadSessionFromDisk("badbytes");
    assert.equal(r.ok, false);
    assert.equal(r.turns, 0);
    assert.deepEqual(r.messages, []);
    assert.ok(r.error, "error message must be populated");
  });
});

test("loadSessionFromDisk treats a mid-read ENOENT the same as a missing session", () => {
  // The Python kernel quarantines a corrupt transcript by renaming it aside
  // (agent/cli.py _quarantine_corrupt_conversation) — if that rename lands
  // between our stat and our read, the file is gone from this reader's
  // vantage point through no fault of its own. That must resolve exactly like
  // "no such session" (ok:true, empty), never a scary error.
  withTempDir((dir) => {
    const file = path.join(dir, "vanishes.json");
    writeFileSync(file, JSON.stringify([{ role: "user", content: "hi" }]), "utf8");
    rmSync(file);
    const r = loadSessionFromDisk("vanishes");
    assert.equal(r.ok, true);
    assert.equal(r.turns, 0);
    assert.deepEqual(r.messages, []);
    assert.equal(r.error, undefined);
  });
});

test("loadSessionFromDisk loads the latest complete provenance run", () => {
  withTempDir((dir) => {
    writeConversation(dir, "with-provenance", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const provenance = provenanceDir("with-provenance");
    mkdirSync(provenance, { recursive: true });
    const start = {
      schema: "sophia.execution-provenance.v1",
      type: "run_start",
      runId: "run-old",
      session: "with-provenance",
      timestamp: "2026-08-06T01:00:00Z",
      modelAlias: "old-alias",
      workspace: "/tmp/old",
      mode: "balanced",
      canClaimAGI: false,
    };
    writeFileSync(path.join(provenance, "20260806T010000000000Z-run-old.start.json"), JSON.stringify(start));
    writeFileSync(path.join(provenance, "20260806T010000000000Z-run-old.terminal.json"), JSON.stringify({
      schema: "sophia.execution-provenance.v1",
      type: "run_terminal",
      runId: "run-old",
      session: "with-provenance",
      timestamp: "2026-08-06T01:00:01Z",
      status: "succeeded",
      provider: "old-provider",
      resolvedModel: "old-model",
      fallbackUsed: false,
      canClaimAGI: false,
    }));
    writeFileSync(path.join(provenance, "20260806T020000000000Z-run-current.start.json"), JSON.stringify({
      ...start,
      runId: "run-current",
      timestamp: "2026-08-06T02:00:00Z",
      modelAlias: "020s",
      workspace: "/workspace/original",
    }));
    writeFileSync(path.join(provenance, "20260806T020000000000Z-run-current.terminal.json"), JSON.stringify({
      schema: "sophia.execution-provenance.v1",
      type: "run_terminal",
      runId: "run-current",
      session: "with-provenance",
      timestamp: "2026-08-06T02:00:02Z",
      status: "cancelled",
      provider: "openai-compatible",
      resolvedModel: "gpt-5.6-sol",
      fallbackUsed: false,
      cancelReason: "user_cancel",
      canClaimAGI: false,
    }));

    const r = loadSessionFromDisk("with-provenance");
    assert.equal(r.ok, true);
    assert.equal(r.provenanceWarning, undefined);
    assert.deepEqual(r.provenance, {
      runId: "run-current",
      modelAlias: "020s",
      workspace: "/workspace/original",
      mode: "balanced",
      startedAt: "2026-08-06T02:00:00Z",
      status: "cancelled",
      provider: "openai-compatible",
      resolvedModel: "gpt-5.6-sol",
      fallbackUsed: false,
      cancelReason: "user_cancel",
      finishedAt: "2026-08-06T02:00:02Z",
    });
  });
});

test("legacy and malformed provenance never block dialogue resume", () => {
  withTempDir((dir) => {
    writeConversation(dir, "legacy", [{ role: "user", content: "legacy dialogue" }]);
    const legacy = loadSessionFromDisk("legacy");
    assert.equal(legacy.ok, true);
    assert.equal(legacy.provenance, undefined);
    assert.equal(legacy.provenanceWarning, undefined);

    const provenance = provenanceDir("legacy");
    mkdirSync(provenance, { recursive: true });
    writeFileSync(path.join(provenance, "broken.start.json"), "{ broken", "utf8");
    const malformed = loadSessionFromDisk("legacy");
    assert.equal(malformed.ok, true);
    assert.equal(malformed.turns, 1);
    assert.equal(malformed.messages[0].text, "legacy dialogue");
    assert.equal(malformed.provenance, undefined);
    assert.match(malformed.provenanceWarning || "", /execution provenance.*unreadable/i);
  });
});

test("resume drift warnings are non-blocking and name model and workspace changes", () => {
  const prior = {
    runId: "run-1",
    modelAlias: "020s",
    workspace: "/workspace/original",
    mode: "balanced",
    startedAt: "2026-08-06T02:00:00Z",
    status: "succeeded",
    provider: "openai-compatible",
    resolvedModel: "gpt-5.6-sol",
    fallbackUsed: false,
    finishedAt: "2026-08-06T02:00:02Z",
  } as const;
  assert.deepEqual(
    formatResumeDriftWarnings(prior, { modelAlias: "mock", workspace: "/workspace/clone" }),
    [
      "resume warning · model changed: 020s (resolved gpt-5.6-sol) → mock",
      "resume warning · workspace changed: /workspace/original → /workspace/clone",
    ],
  );
  assert.deepEqual(
    formatResumeDriftWarnings(prior, { modelAlias: "020s", workspace: "/workspace/original" }),
    [],
  );
  assert.deepEqual(formatResumeDriftWarnings(undefined, { modelAlias: "mock", workspace: "/tmp" }), []);
});

// ---- conversationPath sanitization (path-traversal defense) ----

test("conversationPath sanitizes hostile session names and resolves under the dir", () => {
  withTempDir((dir) => {
    // A path-traversal attempt must be flattened into a safe filename, never an
    // escaped path. ../etc/passwd → etc_passwd.json inside the conversations dir.
    const hostile = conversationPath("../../etc/passwd");
    assert.ok(hostile.startsWith(dir), "hostile name must not escape the dir");
    assert.ok(hostile.endsWith("etc_passwd.json"));
    // The .json suffix and the resolved dir both present.
    const safe = conversationPath("tui-default");
    assert.ok(safe.endsWith("tui-default.json"));
    assert.ok(safe.startsWith(dir));
  });
});

test("conversationsDir honors SOPHIA_CONVERSATIONS_DIR over the default state dir", () => {
  const override = path.join(os.tmpdir(), `sophia-convdir-override-${Date.now()}`);
  const priorDir = process.env.SOPHIA_CONVERSATIONS_DIR;
  const prevState = process.env.SOPHIA_STATE_DIR;
  try {
    process.env.SOPHIA_CONVERSATIONS_DIR = override;
    delete process.env.SOPHIA_STATE_DIR;
    assert.equal(conversationsDir(), path.resolve(override));
  } finally {
    if (priorDir === undefined) delete process.env.SOPHIA_CONVERSATIONS_DIR;
    else process.env.SOPHIA_CONVERSATIONS_DIR = priorDir;
    if (prevState === undefined) delete process.env.SOPHIA_STATE_DIR;
    else process.env.SOPHIA_STATE_DIR = prevState;
    rmSync(override, { recursive: true, force: true });
  }
});

// ---- listSessionsFromDisk (ordering by recency) ----

test("listSessionsFromDisk returns sessions newest-first with previews", () => {
  withTempDir((dir) => {
    writeConversation(dir, "oldest", [{ role: "user", content: "first goal" }]);
    // Stagger mtimes deterministically — the file list order on disk is not
    // guaranteed across filesystems, so set mtime explicitly (newest > oldest).
    const now = Date.now() / 1000;
    utimesSync(path.join(dir, "oldest.json"), now - 200, now - 200);

    writeConversation(dir, "newest", [{ role: "user", content: "latest goal" }]);
    utimesSync(path.join(dir, "newest.json"), now, now);

    const metadataDir = path.join(dir, ".provenance", "newest");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(path.join(metadataDir, "run.start.json"), "{}", "utf8");

    const items = listSessionsFromDisk();
    assert.ok(items.length >= 2);
    assert.equal(items.some((item) => item.name.includes("provenance")), false);
    // Newest-first.
    assert.equal(items[0].name, "newest");
    const newest = items.find((i) => i.name === "newest");
    assert.ok(newest, "newest session present");
    assert.equal(newest!.turns, 1);
    assert.equal(newest!.lastPreview, "latest goal");
    const oldest = items.find((i) => i.name === "oldest");
    assert.ok(oldest, "oldest session present");
    assert.equal(oldest!.lastPreview, "first goal");
  });
});

test("listSessionsFromDisk returns [] when the dir does not exist", () => {
  withTempDir((dir) => {
    // Point at a subdir that does not exist under our temp dir.
    process.env.SOPHIA_CONVERSATIONS_DIR = path.join(dir, "nope");
    assert.deepEqual(listSessionsFromDisk(), []);
  });
});

test("session lookup preserves exact names and searches the full hidden transcript", () => {
  withTempDir((dir) => {
    writeConversation(dir, "exact-session", [
      { role: "user", content: "an unrelated exact-name session" },
    ]);
    writeConversation(dir, "Feature__7", [
      { role: "user", content: "legacy sanitized session name" },
    ]);
    writeConversation(dir, "multi___spaces", [
      { role: "user", content: "repeated whitespace session name" },
    ]);
    writeConversation(dir, "older-recovery", [
      { role: "user", content: "investigate a rendering regression" },
      {
        role: "assistant",
        content: "The \u001b]52;c;c2VjcmV0\u0007QUANTUM bridge failure came from stale event ordering.",
      },
      ...Array.from({ length: 70 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `later filler turn ${index}`,
      })),
    ]);
    const now = Date.now() / 1000;
    utimesSync(path.join(dir, "older-recovery.json"), now - 1_000, now - 1_000);
    for (let index = 0; index < 55; index += 1) {
      const name = `newer-${String(index).padStart(2, "0")}`;
      writeConversation(dir, name, [{ role: "user", content: `unrelated recent session ${index}` }]);
      utimesSync(path.join(dir, `${name}.json`), now + index, now + index);
    }

    type LookupResult = {
      exact: SessionListItem | null;
      matches: SessionListItem[];
    };
    const lookup = (sessionStoreModule as unknown as {
      lookupSessionsFromDisk?: (query: string, limit?: number) => LookupResult;
    }).lookupSessionsFromDisk;
    assert.equal(typeof lookup, "function", "sessionStore must expose a disk lookup boundary");

    const exact = lookup!("exact-session");
    assert.equal(exact.exact?.id, "exact-session");
    assert.deepEqual(exact.matches.map((row) => row.id), ["exact-session"]);

    const canonical = lookup!("Feature #7");
    assert.equal(canonical.exact?.id, "Feature__7");
    assert.deepEqual(canonical.matches.map((row) => row.id), ["Feature__7"]);

    const spaced = lookup!("multi   spaces");
    assert.equal(spaced.exact?.id, "multi___spaces");
    assert.deepEqual(spaced.matches.map((row) => row.id), ["multi___spaces"]);

    const content = lookup!("quantum bridge");
    assert.equal(
      listSessionsFromDisk(50).some((row) => row.id === "older-recovery"),
      false,
      "the ordinary browser cap should exclude the old target",
    );
    assert.equal(content.exact, null);
    assert.deepEqual(content.matches.map((row) => row.id), ["older-recovery"]);
    assert.equal(content.matches[0].match?.field, "assistant");
    assert.match(content.matches[0].match?.preview || "", /quantum bridge failure/i);
    assert.ok((content.matches[0].match?.preview.length || 0) <= 180);
    assert.doesNotMatch(content.matches[0].match?.preview || "", /[\u0000-\u001f\u007f]/);
    assert.doesNotMatch(content.matches[0].match?.preview || "", /\u001b|\]52/);

    const topic = lookup!("rendering regression");
    assert.equal(topic.matches[0].match?.field, "topic");
    assert.equal(topic.matches[0].match?.occurrences, 1, "one turn must not be counted again as its topic projection");

    assert.deepEqual(lookup!("definitely absent").matches, []);
  });
});

test("session lookup reports total matches separately from its display cap", () => {
  withTempDir((dir) => {
    for (let index = 0; index < 6; index += 1) {
      writeConversation(dir, `matching-${index}`, [
        { role: "user", content: `shared marker in session ${index}` },
      ]);
    }
    type LookupResult = {
      matches: SessionListItem[];
      totalMatches?: number;
      truncated?: boolean;
      query?: string;
    };
    const lookup = (sessionStoreModule as unknown as {
      lookupSessionsFromDisk?: (query: string, limit?: number) => LookupResult;
    }).lookupSessionsFromDisk;
    assert.equal(typeof lookup, "function");
    const result = lookup!("  shared   marker  " + " extra".repeat(40), 2);
    assert.equal(result.query?.split(" ").length, 12, "query term count must be bounded");
    assert.equal(result.matches.length, 0, "extra bounded terms remain part of this query");

    const capped = lookup!("shared marker", 2);
    assert.equal(capped.matches.length, 2);
    assert.equal(capped.totalMatches, 6);
    assert.equal(capped.truncated, true);
  });
});

test("async session lookup yields and ignores a corrupt sibling", async () => {
  await withTempDirAsync(async (dir) => {
    writeConversation(dir, "target", [
      { role: "assistant", content: "async quantum bridge evidence" },
    ]);
    writeFileSync(path.join(dir, "corrupt.json"), "{ not-json", "utf8");
    for (let index = 0; index < 12; index += 1) {
      writeConversation(dir, `other-${index}`, [
        { role: "user", content: `unrelated ${index}` },
      ]);
    }

    type LookupResult = {
      query: string;
      matches: SessionListItem[];
      totalMatches: number;
      truncated: boolean;
    };
    const lookupAsync = (sessionStoreModule as unknown as {
      lookupSessionsFromDiskAsync?: (query: string, limit?: number) => Promise<LookupResult>;
    }).lookupSessionsFromDiskAsync;
    assert.equal(typeof lookupAsync, "function", "sessionStore must expose an async lookup boundary");
    let eventLoopYielded = false;
    setImmediate(() => { eventLoopYielded = true; });
    const result = await lookupAsync!("quantum bridge", 5);
    assert.equal(eventLoopYielded, true, "non-exact search must yield before completing");
    assert.equal(result.query, "quantum bridge");
    assert.deepEqual(result.matches.map((row) => row.id), ["target"]);
    assert.equal(result.totalMatches, 1);
    assert.equal(result.truncated, false);
  });
});

test("async session lookup reports an invalid conversations root instead of zero matches", async () => {
  await withTempDirAsync(async (dir) => {
    const notDirectory = path.join(dir, "not-a-directory");
    writeFileSync(notDirectory, "plain file", "utf8");
    process.env.SOPHIA_CONVERSATIONS_DIR = notDirectory;
    const lookupAsync = (sessionStoreModule as unknown as {
      lookupSessionsFromDiskAsync?: (query: string, limit?: number) => Promise<unknown>;
    }).lookupSessionsFromDiskAsync;
    const lookup = (sessionStoreModule as unknown as {
      lookupSessionsFromDisk?: (query: string, limit?: number) => unknown;
    }).lookupSessionsFromDisk;
    assert.equal(typeof lookupAsync, "function");
    assert.equal(typeof lookup, "function");
    assert.throws(() => lookup!("quantum bridge", 5), /ENOTDIR|not a directory/i);
    await assert.rejects(() => lookupAsync!("quantum bridge", 5), /ENOTDIR|not a directory/i);
  });
});

test("resume select compatibility does not rewrite non-exact search text", () => {
  const intent = (sessionStoreModule as unknown as {
    resumeLookupIntent?: (input: string) => { exactCandidates: string[]; query: string };
  }).resumeLookupIntent;
  assert.equal(typeof intent, "function", "sessionStore must expose resume lookup intent parsing");
  assert.deepEqual(intent!("Feature #7"), {
    exactCandidates: ["Feature #7"],
    query: "Feature #7",
  });
  assert.deepEqual(intent!("select model"), {
    exactCandidates: ["model"],
    query: "select model",
  });
  assert.deepEqual(intent!("multi   spaces"), {
    exactCandidates: ["multi   spaces"],
    query: "multi spaces",
  });
});

// ---- descriptive resume picker (topic · turns · recency) ----

test("relativeTime formats recency human-readably", () => {
  const now = 1_000_000_000_000; // fixed reference
  assert.equal(relativeTime(now - 10 * 1000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60 * 1000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 60 * 60 * 1000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 24 * 60 * 60 * 1000, now), "2d ago");
});

test("listSessionsFromDisk description is the FIRST user message (the topic), not the last", () => {
  withTempDir((dir) => {
    writeConversation(dir, "kimi", [
      { role: "user", content: "i want kimi 3 latest technical report" },
      { role: "assistant", content: "searching…" },
      // A later nudge-like user turn must NOT become the session's description.
      { role: "user", content: "You announced an action but did not call a tool." },
      { role: "assistant", content: "here is the report" },
    ]);
    const kimi = listSessionsFromDisk().find((i) => i.name === "kimi");
    assert.ok(kimi);
    assert.equal(kimi!.description, "i want kimi 3 latest technical report");
    assert.equal(
      kimi!.lastPreview,
      "i want kimi 3 latest technical report",
      "kernel steering is hidden rather than impersonating the operator",
    );
    assert.ok(kimi!.recency.length > 0);
  });
});

// ---- agent-loop continuation nudges must not become a session's topic ----

test("isAgentContinuationNudge recognizes every kernel continuation template", () => {
  // Exact leading text of each role:"user" nudge agent/agent_loop.py injects.
  const nudges = [
    "[auto-continue 2/3] You completed 24 iterations using: delegate, glob. The goal is NOT yet achieved.",
    "You just received output from `write_file`. If the goal needs more steps, CALL the next tool now.",
    "The last tool `glob` FAILED: ENOENT. Do NOT just announce a plan — either CALL a different tool or approach NOW.",
    "You announced an action but did not call a tool. Do NOT describe or announce the next step — CALL the tool NOW.",
    "STOP NARRATING. You used: glob, read_file. The goal is NOT complete. Do NOT describe, number, or announce the next tool.",
    "You executed 62 tool calls (delegate, edit_file). Now give the user a COMPLETE final summary.",
    "Active request: fix the loop\nYou executed 10 tool calls (grep). Answer the active request directly now. Just conclude.",
    "(reached 40-iteration ceiling without a final answer — 40 tool calls executed)",
  ];
  for (const n of nudges) assert.equal(isAgentContinuationNudge(n), true, `nudge missed: ${n.slice(0, 40)}`);
  // Blank is treated as "not a useful topic" so the picker skips it too.
  assert.equal(isAgentContinuationNudge(""), true);
  assert.equal(isAgentContinuationNudge("   "), true);
});

test("isAgentContinuationNudge does NOT swallow genuine user prompts", () => {
  const real = [
    "can you obtain kimi 3 openweight official technical report?",
    "fix the resume bug in the TUI",
    "hi",
    // Lookalike openers that must NOT match the nudge regexes:
    "You executed my script yesterday, thanks", // no "<N> tool calls"
    "The last tool I used was a hammer", // no "`name` FAILED:"
    "You just received output from the vendor", // no backtick-quoted tool name
    "Please stop narrating the steps", // "STOP NARRATING" is not a word-prefix here
  ];
  for (const r of real) assert.equal(isAgentContinuationNudge(r), false, `false positive: ${r}`);
});

test("listSessionsFromDisk topic skips a LEADING nudge to reach the real goal", () => {
  withTempDir((dir) => {
    // A long autonomous session whose transcript OPENS with a kernel continuation
    // nudge (role:"user") before any genuine prompt — the regression that made a
    // resume row read "You just received output from `write_file`…".
    writeConversation(dir, "autonomous", [
      { role: "user", content: "You just received output from `write_file`. If the goal needs more steps, CALL the next tool now." },
      { role: "assistant", content: "calling another tool" },
      { role: "user", content: "refactor the auth middleware to use requests" },
      { role: "assistant", content: "done" },
    ]);
    const s = listSessionsFromDisk().find((i) => i.name === "autonomous");
    assert.ok(s);
    assert.equal(s!.description, "refactor the auth middleware to use requests");
  });
});

test("listSessionsFromDisk topic falls back to the first nudge when there is no real prompt", () => {
  withTempDir((dir) => {
    // Every user turn is a nudge — the row must still be non-blank (fall back to
    // the first user turn), never an empty description.
    writeConversation(dir, "allnudges", [
      { role: "user", content: "STOP NARRATING. You used: glob. The goal is NOT complete." },
      { role: "assistant", content: "…" },
      { role: "user", content: "You executed 5 tool calls (glob). Now give the user a COMPLETE final summary." },
    ]);
    const s = listSessionsFromDisk().find((i) => i.name === "allnudges");
    assert.ok(s);
    assert.equal(s!.description, "STOP NARRATING. You used: glob. The goal is NOT complete.");
  });
});

// ---- pickTopic: topic from the FULL transcript, not the 60-turn projection ----

test("pickTopic skips leading nudges AND packed tool-feedback blobs", () => {
  const topic = pickTopic([
    { role: "user", content: "You just received output from `glob`. If the goal needs more steps, CALL the next tool now." },
    { role: "user", content: "[tool:web_search] web_search failed: RuntimeError" },
    { role: "assistant", content: "[native tool calls: 1]" },
    { role: "user", content: "find the kimi 3 technical report" },
  ]);
  assert.equal(topic, "find the kimi 3 technical report");
});

test("pickTopic falls back to the first user turn when every turn is a nudge/blob", () => {
  const topic = pickTopic([
    { role: "user", content: "[tool:read_file]\nok" },
    { role: "user", content: "STOP NARRATING. You used: glob." },
  ]);
  // First NON-BLANK user turn (the tool blob) is the fallback of last resort.
  assert.equal(topic, "[tool:read_file]\nok");
});

test("pickTopic returns empty string when there are no user turns", () => {
  assert.equal(pickTopic([{ role: "assistant", content: "hello" }]), "");
  assert.equal(pickTopic([]), "");
});

test("loadSessionFromDisk.topic survives a long nudge-heavy transcript", () => {
  // The bug: a long autonomous session opens with its goal at turn 0, then runs
  // 70+ tool iterations. The UI projection keeps only the LAST 60 turns, so a
  // topic derived from `messages` saw nothing but continuation nudges and showed
  // "You just received output from `write_file`…" instead of the real goal.
  // pickTopic reads the FULL transcript, while the projection now removes the
  // rejected assistant+nudge pairs entirely.
  withTempDir((dir) => {
    const turns: Array<{ role: string; content: string }> = [
      { role: "user", content: "find the kimi 3 technical report" },
    ];
    for (let i = 0; i < 70; i++) {
      turns.push({ role: "assistant", content: `working step ${i}` });
      turns.push({ role: "user", content: "You just received output from `read_file`. If the goal needs more steps, CALL the next tool now." });
    }
    writeConversation(dir, "longrun", turns);
    const loaded = loadSessionFromDisk("longrun");
    assert.equal(loaded.turns, 141);
    // The topic is the turn-0 goal…
    assert.equal(loaded.topic, "find the kimi 3 technical report");
    // The projected chat is now clean enough to retain the real opening goal.
    assert.ok(loaded.messages.length <= 61, "projection is capped");
    assert.ok(
      loaded.messages.some((m) => m.text.includes("find the kimi 3 technical report")),
      "the opening goal survives after internal loop turns are removed",
    );
    // And the picker row therefore shows the real goal, not a nudge.
    const row = listSessionsFromDisk().find((i) => i.name === "longrun");
    assert.equal(row!.description, "find the kimi 3 technical report");
  });
});

test("listSessionsFromDisk recency reflects last activity", () => {
  withTempDir((dir) => {
    writeConversation(dir, "recent", [{ role: "user", content: "goal" }]);
    const now = Date.now() / 1000;
    utimesSync(path.join(dir, "recent.json"), now - 2 * 3600, now - 2 * 3600); // 2h ago
    const recent = listSessionsFromDisk().find((i) => i.name === "recent");
    assert.equal(recent!.recency, "2h ago");
  });
});

// --- conversation-file parity with the kernel --------------------------------
// agent/cli.py::_conversation_path is the SOURCE OF TRUTH: the bridge loads
// history from that file and replays it into the model. When this helper
// disagreed, the pane showed one transcript while the model was fed another.
// tests/test_conversation_path_parity.py asserts this SAME table against the
// kernel, so the two implementations cannot drift apart unnoticed.
const KERNEL_CONVERSATION_FILES: Array<[string, string]> = [
  ["tui-default", "tui-default.json"],
  ["sess-20260726-1200", "sess-20260726-1200.json"],
  ["my session", "my_session.json"],
  ["a/b", "a_b.json"],
  ["Feature #7", "Feature__7.json"],
  ["café", "café.json"],
  ["  spaced  ", "__spaced__.json"],
  ["日本語セッション", "日本語セッション.json"],
  ["a--b__c..d", "a--b__c..d.json"],
  ["!!!", "___.json"],
  ["_leading", "_leading.json"],
  ["trailing_", "trailing_.json"],
  ["multi   spaces", "multi___spaces.json"],
];

test("conversation filenames match the kernel byte for byte", () => {
  for (const [session, expected] of KERNEL_CONVERSATION_FILES) {
    assert.equal(path.basename(conversationPath(session)), expected,
      `session ${JSON.stringify(session)} must map to the kernel's file`);
  }
});
