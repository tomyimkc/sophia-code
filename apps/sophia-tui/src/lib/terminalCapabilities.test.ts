import test from "node:test";
import assert from "node:assert/strict";

import {
  detectTerminalCapabilities,
  detectTerminalPlatform,
  resolveTerminalAccessibility,
  terminalWidthClass,
} from "./terminalCapabilities.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

test("platform detection covers macOS, Windows, Linux, and unknown hosts", () => {
  assert.equal(detectTerminalPlatform("darwin", EMPTY_ENV), "macos");
  assert.equal(detectTerminalPlatform("win32", EMPTY_ENV), "windows");
  assert.equal(detectTerminalPlatform("linux", EMPTY_ENV), "linux");
  assert.equal(detectTerminalPlatform("aix", EMPTY_ENV), "other");
});

test("environment clues provide a deterministic platform fallback", () => {
  assert.equal(detectTerminalPlatform("unknown", { OSTYPE: "darwin23" }), "macos");
  assert.equal(detectTerminalPlatform("unknown", { OS: "Windows_NT" }), "windows");
  assert.equal(detectTerminalPlatform("unknown", { WSL_DISTRO_NAME: "Ubuntu" }), "linux");
});

test("width breakpoints have stable inclusive boundaries", () => {
  assert.equal(terminalWidthClass(47), "narrow");
  assert.equal(terminalWidthClass(48), "compact");
  assert.equal(terminalWidthClass(79), "compact");
  assert.equal(terminalWidthClass(80), "standard");
  assert.equal(terminalWidthClass(119), "standard");
  assert.equal(terminalWidthClass(120), "wide");
  assert.equal(terminalWidthClass(Number.NaN), "standard");
});

test("generic environment declarations enable optional protocols without terminal-brand tables", () => {
  const capabilities = detectTerminalCapabilities({
    platform: "linux",
    isTTY: true,
    columns: 132,
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      COLORTERM: "truecolor",
      SOPHIA_TERMINAL_CAPABILITIES: "hyperlinks,osc52,sgr-mouse,notify-osc777",
    },
  });

  assert.equal(capabilities.platform, "linux");
  assert.equal(capabilities.widthClass, "wide");
  assert.equal(capabilities.colorLevel, "truecolor");
  assert.equal(capabilities.unicode, true);
  assert.equal(capabilities.hyperlinks, true);
  assert.equal(capabilities.clipboard, true);
  assert.equal(capabilities.mouse, true);
  assert.equal(capabilities.notifications, true);
  assert.equal(capabilities.notificationProtocol, "osc777");
});

test("uncertain OSC protocols stay off unless explicitly declared", () => {
  const capabilities = detectTerminalCapabilities({
    platform: "darwin",
    isTTY: true,
    env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
  });
  assert.equal(capabilities.hyperlinks, false);
  assert.equal(capabilities.clipboard, false);
  assert.equal(capabilities.notifications, false);
  assert.equal(capabilities.notificationProtocol, null);
  assert.equal(capabilities.mouse, true, "generic SGR mouse is available on a usable TTY");
  assert.equal(capabilities.bell, true);
});

test("non-TTY and dumb-terminal probes fail closed for interactive features", () => {
  for (const probe of [
    { isTTY: false, env: { TERM: "xterm-256color", SOPHIA_TERMINAL_CAPABILITIES: "all" } },
    { isTTY: true, env: { TERM: "dumb", SOPHIA_TERMINAL_CAPABILITIES: "mouse,osc52,notify-osc9" } },
  ]) {
    const capabilities = detectTerminalCapabilities({
      platform: "linux",
      columns: 80,
      ...probe,
    });
    assert.equal(capabilities.color, false);
    assert.equal(capabilities.unicode, false);
    assert.equal(capabilities.mouse, false);
    assert.equal(capabilities.clipboard, false);
    assert.equal(capabilities.notifications, false);
    assert.equal(capabilities.bell, false);
  }
});

test("screen-reader mode removes animated, colour, unicode, hyperlink, and mouse chrome", () => {
  const capabilities = detectTerminalCapabilities({
    platform: "linux",
    isTTY: true,
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      SOPHIA_SCREEN_READER: "1",
      SOPHIA_TERMINAL_CAPABILITIES: "hyperlinks,osc52,notify-osc9",
    },
  });
  assert.deepEqual(capabilities.accessibility, {
    screenReader: true,
    reducedMotion: true,
    lowColor: true,
  });
  assert.equal(capabilities.colorLevel, "none");
  assert.equal(capabilities.unicode, false);
  assert.equal(capabilities.hyperlinks, false);
  assert.equal(capabilities.mouse, false);
  assert.equal(capabilities.clipboard, true, "clipboard remains available as an explicit user action");
});

test("low-colour caps truecolor while reduced motion remains independently configurable", () => {
  const accessibility = resolveTerminalAccessibility(
    {
      SOPHIA_LOW_COLOR: "yes",
      SOPHIA_REDUCED_MOTION: "on",
    },
    {},
  );
  assert.deepEqual(accessibility, {
    screenReader: false,
    reducedMotion: true,
    lowColor: true,
  });

  const capabilities = detectTerminalCapabilities({
    platform: "macos",
    isTTY: true,
    env: {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      SOPHIA_LOW_COLOR: "1",
    },
  });
  assert.equal(capabilities.colorLevel, "ansi16");
  assert.equal(capabilities.color, true);
});

test("Windows unicode detection is conservative but explicitly overridable", () => {
  const conservative = detectTerminalCapabilities({
    platform: "win32",
    isTTY: true,
    env: { TERM: "xterm" },
  });
  assert.equal(conservative.platform, "windows");
  assert.equal(conservative.unicode, false);

  const declared = detectTerminalCapabilities({
    platform: "win32",
    isTTY: true,
    env: { TERM: "xterm", SOPHIA_UNICODE: "1" },
  });
  assert.equal(declared.unicode, true);
});

test("explicit false declarations win over inferred defaults", () => {
  const capabilities = detectTerminalCapabilities({
    platform: "linux",
    isTTY: true,
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      SOPHIA_MOUSE: "0",
      SOPHIA_BELL: "off",
      SOPHIA_TERMINAL_CAPABILITIES: "mouse,bell",
    },
  });
  assert.equal(capabilities.mouse, false);
  assert.equal(capabilities.bell, false);
});
