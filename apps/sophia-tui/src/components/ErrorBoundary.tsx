import React from "react";
import { leaveFullscreen } from "../lib/fullscreen.js";
import { disableMouse } from "../lib/mouse.js";

/**
 * Grep for componentDidCatch/ErrorBoundary/getDerivedStateFromError across
 * this package returned nothing before this file: a render-time exception in
 * ANY component tore down the whole Ink app with no React-level containment.
 *
 * This does NOT duplicate src/lib/fullscreen.ts's uncaughtException handler
 * (installFullscreenCleanup), which already guarantees the alt screen is left
 * and the cursor is shown for exceptions React never sees (thrown outside
 * render, e.g. in a setTimeout or a bridge callback). What that handler
 * cannot do is see the REACT component stack, or hold the process open long
 * enough to print something a user can act on before exiting — a render
 * throw unwinds through React's reconciler first, and without a boundary all
 * the generic handler gets is a bare JS Error, which it dumps with
 * `console.error(err)`. This boundary is the only place that can attach the
 * "which component broke" context and turn it into a report a non-engineer
 * can use to file a bug, before handing off to the same terminal-restore
 * primitives fullscreen.ts already proved correct.
 */

const DEFAULT_ISSUES_URL = "https://github.com/tomyimkc/sophia-agi/issues/new";

/**
 * React's componentStack is a `\n`-joined, one-frame-per-line blob. The
 * per-frame prefix is NOT stable across React/renderer versions — classic
 * ReactDOM uses "in Component (at file:line)", but this repo's react-reconciler
 * (18.3.1, driven through Ink) emits "at Component (file:line)" instead, as
 * verified against the actual runtime rather than assumed from older docs.
 * Stripping either prefix here — and re-adding exactly one "in " at the call
 * site — keeps the report's wording stable even if a dependency bump changes
 * which prefix React emits.
 */
export function formatComponentStack(componentStack: string): string[] {
  return componentStack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:in|at)\s+/, ""));
}

/**
 * The human-readable crash report. Leads with the error and which component
 * produced it (the two facts a bug report actually needs), not a raw
 * multi-frame Node stack trace — that's still recoverable from `error.stack`
 * by anyone who wants it, but it is not what we lead with here.
 */
export function formatCrashReport(error: unknown, componentStack: string, issuesUrl: string = DEFAULT_ISSUES_URL): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const frames = formatComponentStack(componentStack);

  const lines = ["", "Sophia hit an unexpected error and had to stop this session.", "", `  ${name}: ${message}`, ""];
  if (frames.length > 0) {
    lines.push("While rendering:");
    for (const frame of frames) lines.push(`  in ${frame}`);
    lines.push("");
  }
  lines.push(
    "This is a bug, not something you did — please file it (include the two",
    "lines above) at:",
    `  ${issuesUrl}`,
    "",
  );
  return lines.join("\n");
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Seams for testing; production defaults restore the real terminal and exit the real process. */
  restoreTerminal?: () => void;
  writeReport?: (report: string) => void;
  exitProcess?: (code: number) => void;
  issuesUrl?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function defaultRestoreTerminal(): void {
  leaveFullscreen();
  disableMouse();
}

function defaultWriteReport(report: string): void {
  process.stderr.write(report);
}

function defaultExitProcess(code: number): void {
  process.exit(code);
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };
  // componentDidCatch is not guaranteed exactly-once by React (a second error
  // thrown while unwinding the first can re-enter it); the restore+report+exit
  // sequence below must run at most once or the report and exit code could
  // interleave garbage from two crashes.
  private reported = false;

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    if (this.reported) return;
    this.reported = true;

    const restoreTerminal = this.props.restoreTerminal ?? defaultRestoreTerminal;
    const writeReport = this.props.writeReport ?? defaultWriteReport;
    const exitProcess = this.props.exitProcess ?? defaultExitProcess;
    const issuesUrl = this.props.issuesUrl ?? DEFAULT_ISSUES_URL;

    // Best-effort, in order: a broken terminal must never suppress the report,
    // and a broken report must never suppress the exit.
    try {
      restoreTerminal();
    } catch {
      /* terminal state is already unknown; nothing to escalate to */
    }
    try {
      writeReport(formatCrashReport(error, errorInfo.componentStack ?? "", issuesUrl));
    } catch {
      /* stderr itself failed; the exit code below is the only signal left */
    }

    // Deliberately always exit rather than try to keep the session alive.
    // This is a single root boundary around the entire app (index.tsx wraps
    // just <App/>, not per-feature subtrees), so there is no smaller,
    // known-good fallback UI to fall back to — "recovering" here would mean
    // blindly re-mounting <App/> on top of state (bridge connection, raw
    // mode, WorkflowState reducers) we already know produced a crash once.
    // On a TTY this process owns exclusively, a silent retry loop that keeps
    // re-crashing is strictly worse than a session that stops cleanly: it can
    // spam or corrupt the screen with no way for the user to tell what's
    // happening, whereas a deterministic non-zero exit hands control straight
    // back to their shell so they can just restart.
    exitProcess(1);
  }

  render(): React.ReactNode {
    // Terminal restoration and the report both happen outside Ink's own
    // write path (see componentDidCatch), and the process exits synchronously
    // right after — there is nothing left worth painting through Ink here,
    // and attempting to render fallback content risks racing the direct
    // stdout/stderr writes above with whatever frame Ink is mid-flushing.
    if (this.state.error) return null;
    return this.props.children;
  }
}
