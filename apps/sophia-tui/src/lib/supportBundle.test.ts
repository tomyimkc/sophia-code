import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LOCAL_ONLY_SESSION_POLICY } from "./sessionStore.js";
import type { SessionIndexEntry } from "./sessionIndex.js";
import { generateSupportBundle, writeSupportBundle } from "./supportBundle.js";

test("support bundles exclude status text that can contain private prompt fragments", () => {
  const privatePhrase = "private alpha planning phrase";
  const bundle = generateSupportBundle(
    {
      diagnostics: {
        bridgeReady: true,
        status: `searching local sessions for ${privatePhrase}`,
      },
    },
    { homeDir: "/home/tester", cwd: "/workspace/project" },
  );
  assert.doesNotMatch(JSON.stringify(bundle), new RegExp(privatePhrase));
  assert.deepEqual(
    (bundle.diagnostics as { status?: unknown }).status,
    { excluded: true },
  );
});

function fixturePaths(): { homeDir: string; cwd: string } {
  const homeDir = path.resolve(tmpdir(), "sophia-support-home");
  return { homeDir, cwd: path.join(homeDir, "workspace") };
}

function indexEntry(paths: { homeDir: string; cwd: string }, secret: string): SessionIndexEntry {
  return {
    id: "session-1",
    name: "session-1",
    title: "Local session",
    path: path.join(paths.homeDir, ".sophia", "session-1.json"),
    turns: 2,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: 1,
    description: `prompt excerpt that must be omitted ${secret}`,
    lastPreview: `assistant preview that must be omitted ${secret}`,
    tags: ["local"],
    archived: false,
    checkpointCount: 0,
    storagePolicy: { ...LOCAL_ONLY_SESSION_POLICY },
  };
}

test("default bundle omits transcript excerpts and redacts synthetic secrets and paths", () => {
  const paths = fixturePaths();
  const secret = "sk-proj-support-bundle-secret-123456";
  const ordinaryPrompt = "inspect the private deployment plan";
  const bundle = generateSupportBundle(
    {
      config: {
        api_key: secret,
        configPath: path.join(paths.cwd, "config.toml"),
      },
      diagnostics: {
        message: `authorization=Bearer ${secret}\u0007`,
      },
      sessionIndex: [indexEntry(paths, secret)],
      sessions: [{
        id: "session-1",
        path: path.join(paths.homeDir, ".sophia", "session-1.json"),
        transcript: [
          { role: "user", content: `${ordinaryPrompt} ${secret}` },
          { role: "assistant", content: `answer from ${paths.cwd}` },
        ],
      }],
      logs: [
        { message: "old log is trimmed" },
        { message: `token=${secret} path=${paths.cwd}\u001b[31m` },
      ],
    },
    {
      now: new Date("2026-07-31T01:02:03.000Z"),
      homeDir: paths.homeDir,
      cwd: paths.cwd,
      maxLogs: 1,
    },
  );

  const encoded = JSON.stringify(bundle);
  const session = bundle.sessions[0] as {
    transcript: { excluded: boolean; turns: number };
  };
  const config = bundle.config as { api_key: string; configPath: string };

  assert.equal(bundle.generatedAt, "2026-07-31T01:02:03.000Z");
  assert.equal(bundle.localOnly, true);
  assert.equal(bundle.candidateOnly, true);
  assert.equal(bundle.canClaimAGI, false);
  assert.equal(bundle.privacy.transcriptBodiesIncluded, false);
  assert.equal(bundle.privacy.transcriptBodiesDefault, false);
  assert.ok(bundle.privacy.redactionCount > 0);
  assert.ok(bundle.privacy.omittedTranscriptBodies >= 2);
  assert.deepEqual(session.transcript, { excluded: true, turns: 2 });
  assert.equal(config.api_key, "[REDACTED]");
  assert.equal(config.configPath, `<cwd>${path.sep}config.toml`);
  assert.equal(bundle.logs.length, 1);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes(paths.cwd), false);
  assert.equal(encoded.includes(paths.homeDir), false);
  assert.equal(encoded.includes(ordinaryPrompt), false);
  assert.equal(encoded.includes("prompt excerpt that must be omitted"), false);
  assert.equal(encoded.includes("assistant preview that must be omitted"), false);
  assert.equal(encoded.includes("\u0007"), false);
  assert.equal(encoded.includes("\u001b"), false);
});

test("explicit transcript inclusion still redacts credentials and local paths", () => {
  const paths = fixturePaths();
  const secret = "sk-support-transcript-secret-123456";
  const ordinaryPrompt = "ordinary transcript body retained by explicit opt-in";
  const bundle = generateSupportBundle(
    {
      sessions: [{
        id: "session-2",
        transcript: [{
          role: "user",
          content: `${ordinaryPrompt}; token=${secret}; file=${path.join(paths.cwd, "notes.md")}`,
        }],
      }],
    },
    {
      includeTranscriptBodies: true,
      homeDir: paths.homeDir,
      cwd: paths.cwd,
    },
  );

  const encoded = JSON.stringify(bundle);
  const session = bundle.sessions[0] as {
    transcript: Array<{ role: string; content: string }>;
  };
  assert.equal(bundle.privacy.transcriptBodiesIncluded, true);
  assert.equal(session.transcript[0].role, "user");
  assert.match(session.transcript[0].content, /ordinary transcript body retained/);
  assert.match(session.transcript[0].content, /token=\[REDACTED\]/);
  assert.match(session.transcript[0].content, /<cwd>/);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes(paths.cwd), false);
});

test("filesystem roots are not used as global path-redaction needles", () => {
  const root = path.parse(path.resolve(path.sep)).root;
  const detail = `url=https://example.test/a/b file=${path.join(root, "workspace", "notes.md")}`;
  const bundle = generateSupportBundle(
    { diagnostics: { detail } },
    { homeDir: root, cwd: root },
  );
  const diagnostics = bundle.diagnostics as { detail: string };

  assert.equal(diagnostics.detail, detail);
  assert.equal(diagnostics.detail.includes("<cwd>"), false);
  assert.equal(diagnostics.detail.includes("~"), false);
});

test("writeSupportBundle persists the same redacted local-only object", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sophia-support-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const destination = path.join(dir, "support.json");
  const secret = "sk-support-file-secret-123456";

  const bundle = writeSupportBundle(
    destination,
    { logs: [{ authorization: `Bearer ${secret}` }] },
    { now: new Date("2026-07-31T02:03:04.000Z"), homeDir: dir, cwd: dir },
  );
  const persisted = JSON.parse(readFileSync(destination, "utf8"));

  assert.deepEqual(persisted, bundle);
  assert.equal(JSON.stringify(persisted).includes(secret), false);
  assert.equal(persisted.localOnly, true);
  assert.equal(persisted.canClaimAGI, false);
  if (process.platform !== "win32") {
    assert.equal(statSync(destination).mode & 0o777, 0o600);
  }
});
