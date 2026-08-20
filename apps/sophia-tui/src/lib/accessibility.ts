/**
 * Accessibility mode for the Sophia TUI.
 *
 * A full-screen TUI is close to unusable with a screen reader: the alternate
 * screen buffer hides output from the reader's buffer entirely, box-drawing
 * chrome is announced character by character, spinners re-announce on every
 * frame, and mouse tracking emits escape noise. The fix is not to describe the
 * visual layout better — it is to stop drawing one.
 *
 * When accessible mode is on the TUI must:
 *   - stay on the normal screen (no alternate buffer), so output lands in the
 *     terminal's real scrollback where a reader can navigate it
 *   - emit no colour (see resolveTheme; colour conveys nothing to a reader and
 *     ANSI noise is read aloud by some configurations)
 *   - draw no borders or decorative chrome
 *   - hold still: no spinners, no progress animation (also honours the
 *     reduced-motion preference, which helps vestibular sensitivity too)
 *   - leave mouse tracking off
 *
 * Reduced motion is deliberately separable: wanting a still UI is common and
 * does not imply using a screen reader.
 */

export interface AccessibilityPrefs {
  /** Flat, reader-friendly output: no alt screen, no chrome, no animation. */
  screenReader: boolean;
  /** No spinners or animated progress. Implied by screenReader. */
  reducedMotion: boolean;
}

function flagOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve preferences from CLI argv and the environment.
 *
 * Both a flag and an env var are supported because a screen-reader user
 * configures this once in a shell profile, not per invocation.
 */
export function resolveAccessibility(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): AccessibilityPrefs {
  const screenReader =
    argv.includes("--ax-screen-reader") ||
    argv.includes("--screen-reader") ||
    flagOn(env.SOPHIA_SCREEN_READER) ||
    flagOn(env.SOPHIA_ACCESSIBLE);

  const reducedMotion =
    screenReader ||
    argv.includes("--reduced-motion") ||
    flagOn(env.SOPHIA_REDUCED_MOTION) ||
    // Widely used by other terminal tooling; honour it rather than inventing
    // a Sophia-only spelling.
    flagOn(env.NO_MOTION);

  return { screenReader, reducedMotion };
}

/** Alternate screen is suppressed in screen-reader mode. */
export function shouldUseFullscreen(prefs: AccessibilityPrefs, otherwise: boolean): boolean {
  return prefs.screenReader ? false : otherwise;
}

/** Mouse tracking is suppressed in screen-reader mode. */
export function shouldEnableMouse(prefs: AccessibilityPrefs, otherwise: boolean): boolean {
  return prefs.screenReader ? false : otherwise;
}

/**
 * A still frame for a spinner.
 *
 * Returning a fixed glyph rather than "" keeps the line's shape stable, so a
 * reader is not told the line changed on every tick.
 */
export function spinnerFrame(prefs: AccessibilityPrefs, frames: readonly string[], tick: number): string {
  if (prefs.reducedMotion) return "*";
  if (frames.length === 0) return "";
  return frames[tick % frames.length];
}

/**
 * Announce a state change as a flat sentence.
 *
 * Screen readers announce text, not layout, so state that a sighted user reads
 * from position or colour has to be said explicitly.
 */
export function announce(label: string, detail?: string): string {
  const head = label.trim();
  const tail = (detail || "").trim();
  return tail ? `${head}: ${tail}` : head;
}

/**
 * Strip colour from a theme when screen-reader mode is on, regardless of
 * which --theme (or NO_COLOR) the caller happened to pick.
 *
 * resolveTheme() (lib/theme.ts) only goes mono for an explicit NO_COLOR /
 * TERM=dumb / --theme mono — it has no idea --ax-screen-reader was passed, so
 * a user who sets only the screen-reader flag still gets a themed (coloured)
 * UI today. Components call this at render time instead of trusting the theme
 * prop to already be colourless, so "screen-reader mode emits no colour" is
 * true even when the caller forgot NO_COLOR.
 */
export function accessibleTheme<T extends object>(theme: T, prefs: AccessibilityPrefs): T {
  if (!prefs.screenReader) return theme;
  // Cast to a plain string map for the mutation: Theme (lib/theme.ts) has no
  // index signature, so it cannot satisfy a `Record<string, string>` type
  // parameter, but every field on it (and on the fixtures the tests build) is
  // in fact a string.
  const muted = { ...theme } as Record<string, string>;
  for (const key of Object.keys(muted)) {
    if (key !== "name") muted[key] = "";
  }
  return muted as T;
}
