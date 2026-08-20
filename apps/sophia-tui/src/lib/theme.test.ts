import test from "node:test";
import assert from "node:assert/strict";
import { resolveTheme, colorDisabled } from "./theme.js";

test("NO_COLOR selects the mono theme regardless of a themed preference", () => {
  // NO_COLOR is an accessibility signal, so it must beat SOPHIA_THEME.
  const theme = resolveTheme("dark", { NO_COLOR: "1", SOPHIA_THEME: "dark" } as NodeJS.ProcessEnv);
  assert.equal(theme.name, "mono");
});

test("mono emits no colour at all, rather than literal white", () => {
  // Ink writes an ANSI code for "white", which is invisible on a light
  // background; an empty value writes nothing. The Python CLI already did this.
  const theme = resolveTheme("mono", {} as NodeJS.ProcessEnv);
  for (const [role, value] of Object.entries(theme)) {
    if (role === "name") continue;
    assert.equal(value, "", `mono.${role} should be empty, got ${JSON.stringify(value)}`);
  }
});

test("TERM=dumb disables colour", () => {
  assert.equal(resolveTheme("dark", { TERM: "dumb" } as NodeJS.ProcessEnv).name, "mono");
});

test("an empty NO_COLOR does not disable colour", () => {
  // The convention keys on presence-and-non-empty; an empty value is not a request.
  assert.equal(colorDisabled({ NO_COLOR: "" } as NodeJS.ProcessEnv), false);
  assert.equal(resolveTheme("dark", { NO_COLOR: "" } as NodeJS.ProcessEnv).name, "dark");
});

test("normal theme selection still works when colour is enabled", () => {
  assert.equal(resolveTheme("light", {} as NodeJS.ProcessEnv).name, "light");
  assert.equal(resolveTheme(null, { SOPHIA_THEME: "light" } as NodeJS.ProcessEnv).name, "light");
  assert.equal(resolveTheme(null, {} as NodeJS.ProcessEnv).name, "dark");
});
