import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNotificationToastViewModel,
  notificationToastBorderStyle,
} from "./NotificationToast.js";
import { detectTerminalCapabilities } from "../lib/terminalCapabilities.js";

function capabilities(columns: number, env: NodeJS.ProcessEnv = {}) {
  return detectTerminalCapabilities({
    platform: "linux",
    isTTY: true,
    columns,
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      ...env,
    },
  });
}

const notification = {
  kind: "warning" as const,
  title: "Provider unavailable",
  body: "The saved API connection closed; choose retry or another provider.",
};

test("narrow and compact toasts collapse into one bounded line", () => {
  for (const width of [40, 72]) {
    const model = buildNotificationToastViewModel(
      notification,
      capabilities(width),
      width,
    );
    assert.equal(model.showBodyLine, false);
    assert.equal(model.body, "");
    assert.ok(model.title.length > 0);
    assert.match(model.announcement, /^Notification: Provider unavailable\./);
  }
});

test("standard-width toast preserves a separate body line", () => {
  const model = buildNotificationToastViewModel(
    notification,
    capabilities(100),
    100,
  );
  assert.equal(model.marker, "⚠");
  assert.equal(model.title, "Provider unavailable");
  assert.equal(model.showBodyLine, true);
  assert.match(model.body, /^The saved API connection/);
  assert.equal(model.borderStyle, "round");
});

test("ASCII terminals use textual markers rather than depending on Unicode", () => {
  const caps = capabilities(100, { SOPHIA_UNICODE: "0" });
  const warning = buildNotificationToastViewModel(notification, caps, 100);
  const success = buildNotificationToastViewModel(
    { kind: "success", title: "Done" },
    caps,
    100,
  );
  assert.equal(warning.marker, "[!]");
  assert.equal(success.marker, "[OK]");

  const compact = buildNotificationToastViewModel(notification, capabilities(72, {
    SOPHIA_UNICODE: "0",
  }), 72);
  assert.equal(compact.title.includes("—"), false);
  assert.match(compact.title, / - /);
});

test("screen-reader toast is borderless, still, and announced in plain words", () => {
  const caps = capabilities(100, { SOPHIA_SCREEN_READER: "1" });
  const model = buildNotificationToastViewModel(notification, caps, 100);
  assert.equal(notificationToastBorderStyle(caps), undefined);
  assert.equal(model.borderStyle, undefined);
  assert.equal(model.marker, "Notification:");
  assert.equal(
    model.announcement,
    "Notification: Provider unavailable. The saved API connection closed; choose retry or another provider.",
  );
});

test("toast text strips terminal controls before presentation", () => {
  const model = buildNotificationToastViewModel(
    {
      kind: "error",
      title: "\x1b[31mProxy down\x1b[0m",
      body: "Retry\x07 manually",
    },
    capabilities(100),
    100,
  );
  assert.equal(model.title, "Proxy down");
  assert.equal(model.body, "Retry manually");
  assert.equal(model.announcement.includes("\x1b"), false);
  assert.equal(model.announcement.includes("\x07"), false);
});
