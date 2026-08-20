import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  buildOscNotification,
  dispatchTerminalNotification,
  notificationAnnouncement,
  planNotification,
  resolveNotificationSettings,
  sanitizeNotificationText,
  truncateTerminalText,
} from "./notifications.js";
import { detectTerminalCapabilities } from "./terminalCapabilities.js";

function capabilities(overrides: NodeJS.ProcessEnv = {}) {
  return detectTerminalCapabilities({
    platform: "linux",
    isTTY: true,
    columns: 100,
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      ...overrides,
    },
  });
}

const request = {
  kind: "success" as const,
  title: "Run finished",
  body: "All checks passed",
};

test("notifications are off by default even when the terminal is capable", () => {
  const plan = planNotification(
    request,
    capabilities({ SOPHIA_NOTIFICATION_OSC: "9" }),
  );
  assert.equal(plan.channel, "none");
  assert.equal(plan.reason, "disabled");
  assert.equal(plan.sequence, null);
  assert.equal(plan.showToast, false);
});

test("explicit OSC mode still requires a detected OSC capability", () => {
  const settings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    channel: "osc" as const,
  };
  const unavailable = planNotification(request, capabilities(), settings, { now: 100 });
  assert.equal(unavailable.channel, "toast");
  assert.equal(unavailable.reason, "capability-fallback");
  assert.equal(unavailable.sequence, null);

  const available = planNotification(
    request,
    capabilities({ SOPHIA_NOTIFICATION_OSC: "777" }),
    settings,
    { now: 100 },
  );
  assert.equal(available.channel, "osc");
  assert.equal(available.reason, "osc");
  assert.match(available.sequence ?? "", /^\x1b\]777;notify;/);
});

test("bell emission requires both an enabled setting and bell capability", () => {
  const settings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    channel: "bell" as const,
  };
  const allowed = planNotification(request, capabilities(), settings, { now: 100 });
  assert.equal(allowed.sequence, "\x07");

  const blocked = planNotification(
    request,
    capabilities({ SOPHIA_BELL: "0" }),
    settings,
    { now: 100 },
  );
  assert.equal(blocked.channel, "toast");
  assert.equal(blocked.sequence, null);
});

test("screen-reader mode suppresses external effects unless separately opted in", () => {
  const caps = capabilities({
    SOPHIA_SCREEN_READER: "1",
    SOPHIA_NOTIFICATION_OSC: "9",
  });
  const settings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    channel: "auto" as const,
  };
  const safe = planNotification(request, caps, settings, { now: 100 });
  assert.equal(safe.channel, "toast");
  assert.equal(safe.reason, "screen-reader-fallback");
  assert.equal(safe.sequence, null);

  const optedIn = planNotification(
    request,
    caps,
    { ...settings, allowExternalInScreenReader: true },
    { now: 100 },
  );
  assert.equal(optedIn.channel, "osc");
});

test("focused and rate-limited notifications do not produce a toast or terminal effect", () => {
  const settings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    channel: "auto" as const,
  };
  const focused = planNotification(request, capabilities(), settings, {
    focused: true,
    now: 10_000,
  });
  assert.equal(focused.reason, "focused");
  assert.equal(focused.showToast, false);

  const limited = planNotification(request, capabilities(), settings, {
    now: 10_000,
    lastDeliveredAt: 8_000,
  });
  assert.equal(limited.reason, "rate-limited");
  assert.equal(limited.deliveredAt, null);
});

test("OSC payloads strip controls, bidi overrides, and extra field delimiters", () => {
  const dangerous = {
    kind: "warning" as const,
    title: "Title;\x1b]9;injected\x07",
    body: "body\u202e;tail\nnext",
  };
  const sequence = buildOscNotification("osc777", dangerous, 100);
  assert.equal((sequence.match(/\x1b/g) ?? []).length, 1, "only the wrapper ESC remains");
  assert.equal((sequence.match(/\x07/g) ?? []).length, 1, "only the wrapper BEL remains");
  assert.equal(sequence.includes("\u202e"), false);
  assert.match(sequence, /^\x1b\]777;notify;Title,;body,tail next\x07$/);
  assert.equal(sequence.includes("injected"), false, "nested OSC content is removed, not replayed");
});

test("sanitizing and width truncation are deterministic for multiline and wide Unicode text", () => {
  assert.equal(sanitizeNotificationText("  one\n two\tthree  "), "one two three");
  assert.equal(truncateTerminalText("abc界def", 6), "abc界…");
  assert.equal(truncateTerminalText("abcdef", 3, "..."), "...");
  assert.equal(truncateTerminalText("abcdef", 0), "");
});

test("settings remain off without an explicit notification mode", () => {
  assert.deepEqual(
    resolveNotificationSettings({}),
    { ...DEFAULT_NOTIFICATION_SETTINGS },
  );
  const enabled = resolveNotificationSettings({
    SOPHIA_NOTIFICATION_MODE: "auto",
    SOPHIA_NOTIFICATION_INTERVAL_MS: "250",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.channel, "auto");
  assert.equal(enabled.minimumIntervalMs, 250);
});

test("dispatch is injected, bounded to planned sequences, and failure-safe", () => {
  const writes: string[] = [];
  const result = dispatchTerminalNotification(
    {
      request,
      channel: "bell",
      reason: "bell",
      showToast: true,
      sequence: "\x07",
      deliveredAt: 1,
    },
    {
      isTTY: true,
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      },
    },
  );
  assert.deepEqual(writes, ["\x07"]);
  assert.equal(result.wrote, true);

  const failed = dispatchTerminalNotification(
    {
      request,
      channel: "bell",
      reason: "bell",
      showToast: true,
      sequence: "\x07",
      deliveredAt: 1,
    },
    {
      isTTY: true,
      write() {
        throw new Error("closed");
      },
    },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.wrote, false);
});

test("screen-reader announcement always states the event in plain text", () => {
  assert.equal(
    notificationAnnouncement({ kind: "error", title: "Proxy down", body: "Retry manually" }),
    "Notification: Proxy down. Retry manually",
  );
});
