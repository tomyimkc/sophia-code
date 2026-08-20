import type { BridgeEvent } from "./bridge.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function payload(event: BridgeEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : {};
}

export function bridgeEventRunId(event: BridgeEvent): string {
  const nested = payload(event);
  return text(event.runId) || text(nested.runId) || text(nested.run_id);
}

export function explicitBridgeSession(event: BridgeEvent): string {
  const nested = payload(event);
  return (
    text(event.session)
    || text(event.sessionId)
    || text(nested.session)
    || text(nested.sessionId)
    || text(nested.session_id)
  );
}

/**
 * Resolve the owning conversation before dispatching a process-scoped bridge
 * event into the active-session flow reducer.
 *
 * The bridge listener intentionally lives for the whole TUI process. A
 * run-to-session ledger therefore outlives React renders and keeps late events
 * from an old run attached to their original session, where the reducer can
 * reject them after /new, /resume, /fork, or /archive.
 */
export function sessionForFlowEvent(
  event: BridgeEvent,
  activeSession: string,
  runSessions: Map<string, string>,
): string {
  const explicit = explicitBridgeSession(event);
  const runId = bridgeEventRunId(event);
  const remembered = runId ? runSessions.get(runId) || "" : "";
  const resolved = explicit || remembered || activeSession;
  if (runId && resolved) {
    runSessions.set(runId, resolved);
    if (runSessions.size > 256) {
      const oldest = runSessions.keys().next().value;
      if (oldest) runSessions.delete(oldest);
    }
  }
  return resolved;
}

export function retargetFlowRunSessions(
  runSessions: Map<string, string>,
  fromSession: string,
  toSession: string,
): void {
  if (!fromSession || !toSession || fromSession === toSession) return;
  for (const [runId, session] of runSessions) {
    if (session === fromSession) runSessions.set(runId, toSession);
  }
}
