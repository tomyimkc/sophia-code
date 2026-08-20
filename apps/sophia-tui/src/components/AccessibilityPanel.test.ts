import test from "node:test";
import assert from "node:assert/strict";

import {
  accessibilityPanelBorderStyle,
  accessibilityPanelLayout,
  accessibilityPanelRows,
  accessibilityPanelSummary,
  accessibilityPanelTheme,
  accessibilityRowPrefix,
} from "./AccessibilityPanel.js";
import { detectTerminalCapabilities } from "../lib/terminalCapabilities.js";
import { resolveTheme } from "../lib/theme.js";

function capabilities(env: NodeJS.ProcessEnv = {}, columns = 100) {
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

test("panel layout collapses details and capability summary at stable width breakpoints", () => {
  assert.deepEqual(accessibilityPanelLayout(47), {
    widthClass: "narrow",
    showDetails: false,
    showCapabilitySummary: false,
    innerWidth: 43,
  });
  assert.equal(accessibilityPanelLayout(48).widthClass, "compact");
  assert.equal(accessibilityPanelLayout(48).showDetails, false);
  assert.equal(accessibilityPanelLayout(80).showDetails, true);
  assert.equal(accessibilityPanelLayout(120).widthClass, "wide");
});

test("rows state preferences and capabilities in words rather than colour alone", () => {
  const rows = accessibilityPanelRows(
    capabilities({
      SOPHIA_REDUCED_MOTION: "1",
      SOPHIA_TERMINAL_CAPABILITIES: "osc52,notify-osc9",
    }),
  );
  assert.deepEqual(
    rows.slice(0, 3).map((row) => [row.key, row.value, row.editable]),
    [
      ["screenReader", "off", true],
      ["reducedMotion", "on", true],
      ["lowColor", "off", true],
    ],
  );
  assert.equal(rows.find((row) => row.key === "clipboard")?.value, "available");
  assert.equal(rows.find((row) => row.key === "notifications")?.value, "osc9");
  for (const row of rows) assert.ok(row.detail.length > 0);
});

test("screen-reader mode removes borders, decorative glyphs, and all theme colour", () => {
  const caps = capabilities({ SOPHIA_SCREEN_READER: "1" });
  const theme = accessibilityPanelTheme(resolveTheme("dark", {}), caps);
  assert.equal(accessibilityPanelBorderStyle(caps), undefined);
  assert.equal(accessibilityRowPrefix(true, caps), "Selected: ");
  assert.equal(accessibilityPanelSummary(caps).environment.includes("·"), false);
  for (const [key, value] of Object.entries(theme)) {
    if (key !== "name") assert.equal(value, "", `${key} must be colourless`);
  }
});

test("low-colour mode flattens semantic roles and ASCII fallback stays explicit", () => {
  const caps = capabilities({ SOPHIA_LOW_COLOR: "1", SOPHIA_UNICODE: "0" });
  const theme = accessibilityPanelTheme(resolveTheme("dark", {}), caps);
  assert.equal(theme.success, theme.text);
  assert.equal(theme.warn, theme.text);
  assert.equal(theme.error, theme.text);
  assert.equal(accessibilityRowPrefix(true, caps), "> ");
  assert.equal(accessibilityPanelBorderStyle(caps), "round");
  assert.match(accessibilityPanelSummary(caps).capabilities, / \| /);
});
