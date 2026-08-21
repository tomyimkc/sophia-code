import test from "node:test";
import assert from "node:assert/strict";

import {
  pythonArgv,
  pythonCommandLine,
  probePythonLaunch,
  pythonLaunchCandidates,
  resetPythonLaunchCache,
  resolvePythonLaunch,
} from "./pythonResolver.js";

test("explicit SOPHIA_PYTHON wins without probing and is returned alone", () => {
  const candidates = pythonLaunchCandidates({ SOPHIA_PYTHON: "/venv/bin/python" }, "linux");
  assert.deepEqual(candidates, [
    { command: "/venv/bin/python", preArgs: [], source: "SOPHIA_PYTHON" },
  ]);
  const probed = probePythonLaunch(candidates, () => {
    throw new Error("explicit interpreter must never be probed");
  });
  assert.equal(probed, null);
});

test("PYTHON env is honored after SOPHIA_PYTHON", () => {
  assert.deepEqual(
    pythonLaunchCandidates({ SOPHIA_PYTHON: "", PYTHON: "custom-python" }, "darwin"),
    [{ command: "custom-python", preArgs: [], source: "PYTHON" }],
  );
});

test("POSIX default stays python3 with no preArgs", () => {
  assert.deepEqual(pythonLaunchCandidates({}, "darwin"), [
    { command: "python3", preArgs: [], source: "platform-default" },
  ]);
  assert.deepEqual(pythonLaunchCandidates(undefined, "linux"), [
    { command: "python3", preArgs: [], source: "platform-default" },
  ]);
  resetPythonLaunchCache();
  const launch = resolvePythonLaunch({}, "linux");
  assert.equal(launch.command, "python3");
  assert.equal(launch.probed, undefined);
});

test("win32 default offers python then the py launcher with -3", () => {
  assert.deepEqual(pythonLaunchCandidates({}, "win32"), [
    { command: "python", preArgs: [], source: "platform-default" },
    { command: "py", preArgs: ["-3"], source: "platform-default" },
  ]);
});

test("win32 probe rejects the Microsoft Store stub and falls back to py", () => {
  const attempts: Array<{ command: string; args: readonly string[] }> = [];
  const launch = probePythonLaunch(
    pythonLaunchCandidates({}, "win32"),
    (command, args) => {
      attempts.push({ command, args });
      if (command === "python") {
        return { status: 9009, stderr: "Python was not found; run without arguments to install from the Microsoft Store..." };
      }
      return { status: 0, stdout: "Python 3.12.10\n" };
    },
  );
  assert.equal(launch?.command, "py");
  assert.deepEqual(launch?.preArgs, ["-3"]);
  assert.equal(launch?.probed, true);
  assert.equal(launch?.version, "Python 3.12.10");
  // The probe must include the launcher selection args so `py -3 --version`
  // targets a real interpreter, not an unversioned default.
  assert.deepEqual(attempts[1], { command: "py", args: ["-3", "--version"] });
});

test("win32 probe returns null when every candidate fails or is missing", () => {
  assert.equal(
    probePythonLaunch(pythonLaunchCandidates({}, "win32"), (command) =>
      command === "python"
        ? { status: null, error: new Error("spawn python ENOENT") }
        : { status: 1, stderr: "no py launcher" },
    ),
    null,
  );
});

test("win32 resolution memoises the probed default per interpreter set", () => {
  resetPythonLaunchCache();
  const first = resolvePythonLaunch({}, "win32");
  const second = resolvePythonLaunch({}, "win32");
  // Same object reference: the second resolve reused the memoised probe
  // instead of spawning `--version` again.
  assert.equal(first, second);
  assert.equal(first.source, "platform-default");
  resetPythonLaunchCache();
  const third = resolvePythonLaunch({}, "win32");
  assert.notEqual(first, third);
  resetPythonLaunchCache();
});

test("pythonArgv places launcher selection args before module args", () => {
  assert.deepEqual(
    pythonArgv({ command: "py", preArgs: ["-3"], source: "PYTHON" }, ["-P", "-m", "agent.code_bridge"]),
    ["py", "-3", "-P", "-m", "agent.code_bridge"],
  );
});

test("pythonCommandLine renders copyable command text and quotes spaced paths", () => {
  assert.equal(
    pythonCommandLine(
      { command: "python3", preArgs: [], source: "platform-default" },
      ["-m", "agent.arc_campaign", "status", "--json"],
    ),
    "python3 -m agent.arc_campaign status --json",
  );
  assert.equal(
    pythonCommandLine(
      { command: "py", preArgs: ["-3"], source: "platform-default" },
      ["-m", "agent.arc_campaign", "status", "--json"],
    ),
    "py -3 -m agent.arc_campaign status --json",
  );
  assert.equal(
    pythonCommandLine(
      { command: "C:\\Program Files\\Python312\\python.exe", preArgs: [], source: "SOPHIA_PYTHON" },
      ["--version"],
    ),
    '"C:\\Program Files\\Python312\\python.exe" --version',
  );
});
