/**
 * React context for accessibility preferences.
 *
 * index.tsx already resolves argv/env once via resolveAccessibility() and
 * uses the result for fullscreen/mouse decisions, but nothing threaded that
 * value down to the components that render spinners, borders, and colour —
 * they had no way to read it short of new props on every one of them, which
 * would mean editing App.tsx's component tree to pass it through.
 *
 * argv and env are fixed for the life of the process, so resolving once at
 * module load and using that as the context's *default* value (not just an
 * initial one) means every consumer gets the real CLI-resolved preference
 * even though nothing mounts an <AccessibilityProvider> above it — that is
 * React's documented default-value fallback, not a workaround. A provider is
 * exported too, for tests (or a future App.tsx wiring pass) that want to
 * override the resolved prefs for a subtree.
 */
import React, { createContext, useContext, type ReactNode } from "react";
import { resolveAccessibility, type AccessibilityPrefs } from "./accessibility.js";

const processPrefs: AccessibilityPrefs = resolveAccessibility(process.argv.slice(2), process.env);

const AccessibilityContext = createContext<AccessibilityPrefs>(processPrefs);

export function AccessibilityProvider({
  prefs,
  children,
}: {
  /** Override for tests; omit to use the process-resolved prefs. */
  prefs?: AccessibilityPrefs;
  children: ReactNode;
}): React.ReactElement {
  return (
    <AccessibilityContext.Provider value={prefs ?? processPrefs}>
      {children}
    </AccessibilityContext.Provider>
  );
}

/** Read the resolved accessibility preferences from context (or process argv/env). */
export function useAccessibility(): AccessibilityPrefs {
  return useContext(AccessibilityContext);
}
