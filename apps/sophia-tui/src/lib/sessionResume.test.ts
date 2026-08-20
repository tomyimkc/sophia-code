import test from "node:test";
import assert from "node:assert/strict";
import { shouldAutoResume, sessionExplicitlyRequested, continueRequested, resolveSessionName } from "./sessionResume.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

test("a bare launch does NOT resume — this is the bug the first fix missed", () => {
  // The first attempt gated on `!!session`, but --session is declared with
  // default:"tui-default", so the parsed flag is always truthy and the guard
  // never fired. Every launch kept inheriting the previous transcript.
  assert.equal(shouldAutoResume([], NO_ENV), false);
  assert.equal(shouldAutoResume(["--model", "mock"], NO_ENV), false);
});

test("a session name that came from the DEFAULT is not a request to resume", () => {
  // Reproduces the exact shape of the bug: the value exists, but the user never
  // asked for it.
  const parsedFlags = { session: "tui-default" };
  assert.equal(parsedFlags.session.length > 0, true, "value is truthy...");
  assert.equal(shouldAutoResume([], NO_ENV), false, "...but that must not mean resume");
});

test("an explicit --session/-s does resume, in every spelling", () => {
  for (const argv of [
    ["--session", "work"],
    ["-s", "work"],
    ["--session=work"],
    ["-s=work"],
    ["--model", "mock", "--session", "work"],
  ]) {
    assert.equal(shouldAutoResume(argv, NO_ENV), true, `should resume for ${JSON.stringify(argv)}`);
  }
});

test("ambient SOPHIA_RESUME cannot turn a bare launch into an implicit resume", () => {
  assert.equal(shouldAutoResume([], { SOPHIA_RESUME: "1" } as NodeJS.ProcessEnv), false);
  assert.equal(shouldAutoResume([], { SOPHIA_RESUME: "true" } as NodeJS.ProcessEnv), false);
  assert.equal(shouldAutoResume([], { SOPHIA_RESUME: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(shouldAutoResume([], { SOPHIA_RESUME: "" } as NodeJS.ProcessEnv), false);
});

test("a flag that merely looks similar does not count", () => {
  assert.equal(sessionExplicitlyRequested(["--sessions"]), false);
  assert.equal(sessionExplicitlyRequested(["--no-session"]), false);
  assert.equal(sessionExplicitlyRequested(["--show-session-id"]), false);
});

test("a bare launch gets a FRESH session, not the shared one", () => {
  // The bug the user hit: session defaulted to the fixed name "tui-default", so
  // every launch reused one growing conversation file that the bridge replayed
  // into the model as history. A new session must not inherit old turns.
  const name = resolveSessionName(
    [],
    NO_ENV,
    undefined,
    new Date(2026, 6, 26, 9, 5, 3),
    "abc123",
  );
  assert.equal(name, "sess-20260726-090503-abc123");
  assert.notEqual(name, "tui-default");
});

test("an explicit --session still selects that session", () => {
  assert.equal(resolveSessionName(["--session", "work"], NO_ENV, "work"), "work");
});

test("SOPHIA_RESUME does not opt back into the shared persistent session", () => {
  assert.equal(
    resolveSessionName(
      [],
      { SOPHIA_RESUME: "1" } as NodeJS.ProcessEnv,
      undefined,
      new Date(2026, 6, 26, 9, 5, 3),
      "abc123",
    ),
    "sess-20260726-090503-abc123",
  );
});

test("two bare launches in the same second do not collide", () => {
  const now = new Date(2026, 6, 26, 9, 5, 3);
  const a = resolveSessionName([], NO_ENV, undefined, now, "first");
  const b = resolveSessionName([], NO_ENV, undefined, now, "second");
  assert.notEqual(a, b);
});

// ---- --continue/-c: reopen the most recent Sophia session ----

test("continueRequested recognizes --continue and -c in every position", () => {
  for (const argv of [
    ["--continue"],
    ["-c"],
    ["--continue=true"],
    ["--model", "mock", "--continue"],
    ["-c", "--mock"],
  ]) {
    assert.equal(continueRequested(argv), true, `should detect continue for ${JSON.stringify(argv)}`);
  }
});

test("continueRequested does not fire on lookalike flags", () => {
  assert.equal(continueRequested(["--continuation"]), false);
  assert.equal(continueRequested(["--no-continue"]), false);
  assert.equal(continueRequested(["-continue"]), false); // single dash is not --continue
  assert.equal(continueRequested([]), false);
});

test("--continue implies auto-resume (so the App hydrates the continued session)", () => {
  assert.equal(shouldAutoResume(["--continue"], NO_ENV), true);
  assert.equal(shouldAutoResume(["-c"], NO_ENV), true);
  // A bare launch still does NOT resume — continue is an explicit act.
  assert.equal(shouldAutoResume([], NO_ENV), false);
});

test("--continue with no saved session still starts a fresh empty session", () => {
  assert.equal(
    resolveSessionName(
      ["--continue"],
      NO_ENV,
      undefined,
      new Date(2026, 6, 26, 9, 5, 3),
      "empty",
    ),
    "sess-20260726-090503-empty",
  );
});
