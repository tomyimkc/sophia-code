import test from "node:test";
import assert from "node:assert/strict";
import type { ErrorInfo } from "react";
import { ErrorBoundary, formatComponentStack, formatCrashReport } from "./ErrorBoundary.js";

test("formatComponentStack strips the 'in ' prefix and blank lines", () => {
  const stack = "\n    in PromptInput (at App.tsx:120)\n    in App (at index.tsx:10)\n";
  assert.deepEqual(formatComponentStack(stack), [
    "PromptInput (at App.tsx:120)",
    "App (at index.tsx:10)",
  ]);
});

test("formatComponentStack also strips the 'at ' prefix this repo's react-reconciler (18.3.1, via Ink) actually emits", () => {
  // Verified against the live runtime, not assumed from ReactDOM's older
  // "in Component" docs — see the file-level comment on the function.
  const stack = "\n    at Bomb (/repo/src/Bomb.tsx:15:9)\n    at App (/repo/node_modules/ink/src/components/App.tsx:42:15)";
  assert.deepEqual(formatComponentStack(stack), [
    "Bomb (/repo/src/Bomb.tsx:15:9)",
    "App (/repo/node_modules/ink/src/components/App.tsx:42:15)",
  ]);
});

test("crash report names the failing component and how to file it, not a raw V8 stack", () => {
  const err = new Error("workflow reducer received an undefined node id");
  // "at Component (file:line)" is the real componentStack format this repo's
  // React 18.3.1 + Ink reconciler emits (verified live, not the classic
  // ReactDOM "in Component" docs format).
  const report = formatCrashReport(err, "\n    at WorkflowTree (App.tsx:88)", "https://example.test/issues/new");

  assert.ok(report.includes("workflow reducer received an undefined node id"));
  assert.ok(report.includes("in WorkflowTree"));
  // Regression: an earlier version of this report assumed the classic "in "
  // prefix and prepended its own "in ", doubling to "in at WorkflowTree".
  assert.ok(!report.includes("in at WorkflowTree"));
  assert.ok(report.includes("https://example.test/issues/new"));
  // The point of a report over `console.error(err)` is that it does not lead
  // with V8's internal frame format.
  assert.ok(!report.includes("    at "));
});

test("crash report tolerates a thrown non-Error value", () => {
  const report = formatCrashReport("plain string throw", "", "https://example.test/issues/new");
  assert.ok(report.includes("plain string throw"));
});

test("getDerivedStateFromError captures the error for render() to see", () => {
  const err = new Error("boom");
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(err), { error: err });
});

test("componentDidCatch restores the terminal, writes one report, and exits non-zero — exactly once even if re-entered", () => {
  const restoreCalls: number[] = [];
  const reports: string[] = [];
  const exitCodes: number[] = [];

  const boundary = new ErrorBoundary({
    children: null,
    issuesUrl: "https://example.test/issues/new",
    restoreTerminal: () => restoreCalls.push(1),
    writeReport: (report) => reports.push(report),
    exitProcess: (code) => exitCodes.push(code),
  });

  const err = new Error("render exploded");
  const info: ErrorInfo = { componentStack: "\n    in Banner (at App.tsx:5)" };
  boundary.componentDidCatch(err, info);
  // A second (re-entrant) crash must not double-restore, double-print, or
  // report a different exit code than the first.
  boundary.componentDidCatch(new Error("second crash while unwinding"), info);

  assert.deepEqual(restoreCalls, [1]);
  assert.equal(reports.length, 1);
  assert.ok(reports[0].includes("render exploded"));
  assert.deepEqual(exitCodes, [1]);
});

test("componentDidCatch still exits even when restoreTerminal and writeReport both throw", () => {
  const exitCodes: number[] = [];
  const boundary = new ErrorBoundary({
    children: null,
    restoreTerminal: () => {
      throw new Error("stty is gone");
    },
    writeReport: () => {
      throw new Error("stderr is gone");
    },
    exitProcess: (code) => exitCodes.push(code),
  });

  boundary.componentDidCatch(new Error("boom"), { componentStack: "" });
  assert.deepEqual(exitCodes, [1]);
});

test("render() shows children normally and stops rendering the crashed subtree once caught", () => {
  const boundary = new ErrorBoundary({ children: "hello" });
  assert.equal(boundary.render(), "hello");

  // Simulate what getDerivedStateFromError already told React to commit,
  // without pulling in a full Ink/React renderer just to flip local state.
  boundary.state = { error: new Error("boom") };
  assert.equal(boundary.render(), null);
});
