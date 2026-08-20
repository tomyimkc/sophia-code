import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAccessibility,
  shouldUseFullscreen,
  shouldEnableMouse,
  spinnerFrame,
  announce,
  accessibleTheme,
} from "./accessibility.js";

const NO_ENV = {} as NodeJS.ProcessEnv;

test("screen-reader mode is reachable by flag and by env", () => {
  assert.equal(resolveAccessibility(["--ax-screen-reader"], NO_ENV).screenReader, true);
  assert.equal(resolveAccessibility(["--screen-reader"], NO_ENV).screenReader, true);
  assert.equal(
    resolveAccessibility([], { SOPHIA_SCREEN_READER: "1" } as NodeJS.ProcessEnv).screenReader,
    true,
  );
  // An env var matters more than a flag here: this gets set once in a profile,
  // not typed per invocation.
  assert.equal(
    resolveAccessibility([], { SOPHIA_ACCESSIBLE: "true" } as NodeJS.ProcessEnv).screenReader,
    true,
  );
  assert.equal(resolveAccessibility([], NO_ENV).screenReader, false);
});

test("screen-reader mode implies reduced motion, but not the reverse", () => {
  assert.equal(resolveAccessibility(["--ax-screen-reader"], NO_ENV).reducedMotion, true);
  const motionOnly = resolveAccessibility(["--reduced-motion"], NO_ENV);
  assert.equal(motionOnly.reducedMotion, true);
  // Wanting a still UI does not imply using a screen reader.
  assert.equal(motionOnly.screenReader, false);
});

test("the alternate screen and mouse tracking are suppressed for a reader", () => {
  const ax = resolveAccessibility(["--ax-screen-reader"], NO_ENV);
  // The alt buffer hides output from the reader's buffer entirely, so it must
  // be off even when the caller would otherwise turn it on.
  assert.equal(shouldUseFullscreen(ax, true), false);
  assert.equal(shouldEnableMouse(ax, true), false);

  const normal = resolveAccessibility([], NO_ENV);
  assert.equal(shouldUseFullscreen(normal, true), true);
  assert.equal(shouldEnableMouse(normal, true), true);
  // ...and it never turns them ON against the caller's wishes.
  assert.equal(shouldUseFullscreen(normal, false), false);
});

test("spinners hold still under reduced motion", () => {
  const still = resolveAccessibility(["--reduced-motion"], NO_ENV);
  const frames = ["|", "/", "-", "\\"];
  const rendered = [0, 1, 2, 3, 4].map((t) => spinnerFrame(still, frames, t));
  assert.equal(new Set(rendered).size, 1, "a still spinner must not change between ticks");
  // A fixed glyph, not "", so the line's shape stays stable and a reader is not
  // told the line changed.
  assert.equal(rendered[0], "*");

  const moving = resolveAccessibility([], NO_ENV);
  assert.equal(spinnerFrame(moving, frames, 0), "|");
  assert.equal(spinnerFrame(moving, frames, 1), "/");
  assert.equal(spinnerFrame(moving, frames, 5), "/");
});

test("announce produces a flat sentence, since readers announce text not layout", () => {
  assert.equal(announce("blocked", "hard prohibition"), "blocked: hard prohibition");
  assert.equal(announce("checked"), "checked");
  assert.equal(announce(" running ", "  "), "running");
});

test("an empty frame list does not crash the spinner", () => {
  assert.equal(spinnerFrame(resolveAccessibility([], NO_ENV), [], 3), "");
});

test("screen-reader mode strips theme colour even without NO_COLOR set", () => {
  // resolveTheme() (lib/theme.ts) only mutes colour for an explicit NO_COLOR /
  // TERM=dumb / --theme mono — it never looks at the screen-reader flag, so a
  // component that trusts the theme prop alone would still emit colour here.
  const theme = { name: "dark", text: "whiteBright", dim: "gray", accent: "yellow", error: "red" };
  const reader = resolveAccessibility(["--ax-screen-reader"], NO_ENV);
  const muted = accessibleTheme(theme, reader);
  assert.equal(muted.accent, "");
  assert.equal(muted.error, "");
  assert.equal(muted.dim, "");
  assert.equal(muted.text, "");
  assert.equal(muted.name, "dark", "identity fields are not a colour channel");
});

test("accessibleTheme leaves colour alone outside screen-reader mode", () => {
  const theme = { name: "dark", accent: "yellow" };
  // reduced-motion-only (not screen-reader) must not touch colour: the two
  // preferences are deliberately separable (see the ladder test above).
  const motionOnly = resolveAccessibility(["--reduced-motion"], NO_ENV);
  assert.deepEqual(accessibleTheme(theme, motionOnly), theme);

  const normal = resolveAccessibility([], NO_ENV);
  assert.deepEqual(accessibleTheme(theme, normal), theme);
});
