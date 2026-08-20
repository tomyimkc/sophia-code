#!/usr/bin/env node
/**
 * Sophia Code TUI — provenance-aware, multi-backend terminal agent.
 * Fullscreen alternate buffer + slash selection fix.
 * canClaimAGI:false.
 */
import React from "react";
import { render } from "ink";
import meow from "meow";
import path from "node:path";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { findRepoRoot, validateBridgeCwd } from "./lib/bridge.js";
import {
  enterFullscreen,
  installFullscreenCleanup,
  leaveFullscreen,
} from "./lib/fullscreen.js";
import { disableMouse, enableMouse } from "./lib/mouse.js";
import { resolveAccessibility, shouldEnableMouse, shouldUseFullscreen } from "./lib/accessibility.js";
import { continueRequested, resolveSessionName } from "./lib/sessionResume.js";
import { listSessionsFromDisk } from "./lib/sessionStore.js";
import { missingCliFlagValue } from "./lib/cliSettings.js";
import type { BridgeEvent } from "./lib/bridge.js";
import { onceExitCode, writeFinishedPayload } from "./lib/once.js";
import {
  conscienceModeFromBridge,
  type ConscienceMode,
} from "./lib/conscienceMode.js";
import {
  parseThinkingVisibility,
  type ThinkingVisibility,
} from "./lib/visibleReasoning.js";

const launchArgv = process.argv.slice(2);
const missingAgiWorkflowValue = (() => {
  const index = launchArgv.findIndex((token) => token === "--agi-workflow");
  if (index < 0) return null;
  const value = launchArgv[index + 1];
  return value == null || value === "--" || value.startsWith("-")
    ? "--agi-workflow"
    : null;
})();
const missingValueFlag =
  missingAgiWorkflowValue || missingCliFlagValue(launchArgv);
if (missingValueFlag) {
  process.stderr.write(
    `sophia-tui: ${missingValueFlag} requires a value; keep the command on one shell line or use ${missingValueFlag}=VALUE\n`,
  );
  process.exit(2);
}

const cli = meow(
  `
  Sophia Code TUI (provenance-aware, multi-backend, fullscreen)

  Usage
    $ sophia
    $ sophia-tui
    $ sophia-tui "fix the tests"
    $ sophia-tui --model zai
    $ sophia-tui --mock
    $ sophia-tui --no-fullscreen
    $ sophia-tui --mouse
    $ sophia-tui --once "fix the tests"

  Options
    --model, -m         Model spec (zai, codex, codex-api, mock, …)
    --mode              logical|precise|balanced|creative|divergent
    --permission, -p    auto|manual|readonly (auto allows non-destructive tools)
    --full-access       explicit alias for auto; destructive commands still confirm
    --session, -s       Session name
    --continue, -c      Resume the most recent session (no picker)
    --cwd               Workspace root
    --theme             dark|light|mono
    --mock              Offline mock model
    --no-fullscreen     Disable alternate-screen fullscreen
    --no-mouse          Disable wheel/click capture (re-enable plain drag-select)
    --once              Exit only after the kernel emits run_finished
    --conscience        off|report|floor|strict final-answer policy
    --thinking          hidden|summary|stream|full (default full; hidden fails closed)
    --agi-workflow      off|auto|on AGI-owned per-node workflow routing
    --workflow          off|auto|on dynamic multi-stage parallel A2A controller
    --workflow-max-stages  Maximum workflow barriers (default 6)
    --workflow-max-agents  Maximum total workflow sub-agents (default 24)
    --finished-out      Write the run_finished JSON to this path instead of stdout
    --help              Show help
    --version           Show version

  Slash
    Type / then characters. ↑↓ select · Tab complete · Enter run.
`,
  {
    importMeta: import.meta,
    flags: {
      model: {
        type: "string",
        shortFlag: "m",
        // Default to "mock" (safe, offline) and let the bridge's state event
        // populate the real model from config.toml/state on startup. We used to
        // default to "qwen3.6-35b" (a vLLM preset), which made the TUI's FIRST
        // run hit port 8000 and Connection-refused before the bridge could
        // correct it — every launch on a box without a vLLM server failed.
        // Override anytime: --model <spec> | /model in-session | SOPHIA_MODEL(_PROVIDER).
        default:
          process.env.SOPHIA_MODEL_PROVIDER ||
          process.env.SOPHIA_MODEL ||
          "mock",
      },
      mode: { type: "string", default: "balanced" },
      permission: { type: "string", shortFlag: "p", default: "manual" },
      fullAccess: { type: "boolean", default: false },
      // No default: a bare launch must get a FRESH session (see
      // lib/sessionResume.resolveSessionName). A fixed default meant every
      // launch reused one growing conversation file, which the bridge then
      // replayed into the model as history.
      session: { type: "string", shortFlag: "s" },
      // Fast path: reopen the most recent session instantly. The
      // flag only records intent; the "which session is newest" disk lookup
      // happens below (needs the conversations dir), and shouldAutoResume sees
      // --continue in argv so the App hydrates that session on startup.
      continue: { type: "boolean", shortFlag: "c", default: false },
      cwd: { type: "string", default: process.cwd() },
      theme: { type: "string", default: process.env.SOPHIA_THEME || "dark" },
      mock: { type: "boolean", default: false },
      fullscreen: { type: "boolean", default: true },
      // Mouse capture (wheel scroll + click-to-collapse) is ON by default —
      // this is what makes the mouse wheel scroll the chat transcript instead
      // of being misread as an ArrowUp that recalls prompt history. Without
      // capture, terminals deliver wheel events as ↑/↓ escape sequences, which
      // the prompt box consumed as history-recall (the "scroll fills my input"
      // bug). With capture on, drag-to-select needs Shift (every mainstream
      // terminal honours that override); pass --no-mouse or SOPHIA_MOUSE=0 to
      // restore plain drag-select at the cost of wheel-as-arrow-keys.
      mouse: { type: "boolean", default: process.env.SOPHIA_MOUSE !== "0" },
      once: {
        type: "boolean",
        default: process.env.SOPHIA_TUI_ONCE === "1",
      },
      conscience: {
        type: "string",
      },
      thinking: {
        type: "string",
      },
      agiWorkflow: {
        type: "string",
      },
      workflow: {
        type: "string",
      },
      workflowMaxStages: { type: "number", default: 6 },
      workflowMaxAgents: { type: "number", default: 24 },
      finishedOut: { type: "string" },
    },
  },
);

const perm = cli.flags.fullAccess ? "auto" : (cli.flags.permission || "manual").toLowerCase();
if (!["manual", "approve", "readonly", "auto"].includes(perm)) {
  process.stderr.write("Invalid --permission; expected auto, manual, or readonly\n");
  process.exit(2);
}
const permission: "manual" | "auto" | "readonly" =
  perm === "approve" ? "manual" : (perm as "manual" | "auto" | "readonly");

const model = cli.flags.mock
  ? "mock"
  : String(
      cli.flags.model ||
        process.env.SOPHIA_MODEL_PROVIDER ||
        process.env.SOPHIA_MODEL ||
        "mock",
    );
const initialPrompt = cli.input.join(" ").trim() || undefined;
const conscienceRaw =
  cli.flags.conscience ?? process.env.SOPHIA_CONSCIENCE_MODE ?? "off";
const conscienceMode = conscienceModeFromBridge(conscienceRaw);
if (!conscienceMode) {
  process.stderr.write(
    "Invalid --conscience; expected off, report, floor, or strict\n",
  );
  process.exit(2);
}
const thinkingVisibility = cli.flags.thinking == null
  ? undefined
  : parseThinkingVisibility(cli.flags.thinking);
if (cli.flags.thinking != null && !thinkingVisibility) {
  process.stderr.write(
    "Invalid --thinking; expected hidden, summary, stream, or full\n",
  );
  process.exit(2);
}
const agiWorkflowRaw =
  cli.flags.agiWorkflow ?? process.env.SOPHIA_AGI_WORKFLOW_MODE;
const agiWorkflowMode = agiWorkflowRaw == null
  ? undefined
  : String(agiWorkflowRaw).trim().toLowerCase();
if (
  agiWorkflowMode !== undefined
  && !["off", "auto", "on"].includes(agiWorkflowMode)
) {
  process.stderr.write(
    "Invalid --agi-workflow; expected off, auto, or on\n",
  );
  process.exit(2);
}
const agiWorkflowOwned =
  launchArgv.some(
    (token) =>
      token === "--agi-workflow" || token.startsWith("--agi-workflow="),
  )
  || Boolean((process.env.SOPHIA_AGI_WORKFLOW_MODE || "").trim());
const workflowRaw =
  cli.flags.workflow ?? process.env.SOPHIA_WORKFLOW_MODE;
const workflowMode = workflowRaw == null
  ? undefined
  : String(workflowRaw).trim().toLowerCase();
if (
  workflowMode !== undefined
  && !["off", "auto", "on"].includes(workflowMode)
) {
  process.stderr.write("Invalid --workflow; expected off, auto, or on\n");
  process.exit(2);
}
if (!process.stdin.isTTY) {
  process.stderr.write(
    "sophia-tui: interactive terminal input is required; use SOPHIA_UI=python for piped or headless input\n",
  );
  process.exit(2);
}
const repoRoot = findRepoRoot();
const requestedCwd = path.resolve(String(cli.flags.cwd || process.cwd()));
const cwd = (() => {
  try {
    return validateBridgeCwd(repoRoot, requestedCwd);
  } catch {
    process.stderr.write(`Invalid --cwd or not a directory; using ${repoRoot}\n`);
    return repoRoot;
  }
})();

// Accessibility preferences come first: they can only ever REMOVE visual
// chrome, so resolving them up front keeps the decisions below honest.
const ax = resolveAccessibility(process.argv.slice(2), process.env);

// Fullscreen unless --no-fullscreen or SOPHIA_NO_FULLSCREEN=1 or non-TTY —
// and never in screen-reader mode, where the alternate buffer would hide all
// output from the reader's buffer.
const wantFs = shouldUseFullscreen(
  ax,
  cli.flags.fullscreen !== false &&
    process.env.SOPHIA_NO_FULLSCREEN !== "1" &&
    !!process.stdout.isTTY,
);

const cleanupFs = installFullscreenCleanup(disableMouse);
if (wantFs) enterFullscreen();
// Mouse tracking is ON by default so the wheel scrolls the chat transcript
// (a wheel event decodes as a mouse event, which PromptInput ignores and the
// App scroll handler consumes — see PromptInput's `decoded.mouse` early-return).
// The cost is that native drag-select needs Shift; pass --no-mouse /
// SOPHIA_MOUSE=0 to restore plain drag-select (wheel then degrades to ↑/↓ and
// the empty-input keyboard fallback in App.tsx scrolls instead).
//
// Still forced off for a screen reader: tracking emits escape noise it reads out.
const mouseMode = shouldEnableMouse(ax, !!cli.flags.mouse && !!process.stdin.isTTY);
if (mouseMode) enableMouse();

// Resolve the launch session. --continue/-c reopens the MOST RECENT session from
// disk (fast path, no picker); when there is nothing to continue
// yet it falls back to the normal fresh/resolved name. continueRequested(argv)
// — not just cli.flags.continue — is what App's module-level AUTO_RESUME checks,
// so the two stay in step and the App hydrates whichever session we pick here.
const sessionName = (() => {
  if (cli.flags.continue || continueRequested(launchArgv)) {
    const recent = listSessionsFromDisk(1)[0];
    if (recent) return recent.id;
  }
  return resolveSessionName(launchArgv, process.env, cli.flags.session);
})();

let terminalPayload: BridgeEvent | null = null;
let instance: ReturnType<typeof render>;
const onRunFinished = (payload: BridgeEvent) => {
  if (!cli.flags.once || terminalPayload) return;
  terminalPayload = payload;
  instance.unmount();
};

instance = render(
  // Ink has no error containment of its own: a render-time throw in any
  // descendant otherwise tears down the whole app with no explanation and no
  // component context. ErrorBoundary restores the terminal and prints a
  // readable report before exiting non-zero; see its file-level comment for
  // why it always exits rather than trying to keep the session alive.
  <ErrorBoundary>
    <App
      model={model}
      mode={String(cli.flags.mode || "balanced")}
      permission={permission}
      session={sessionName}
      cwd={cwd}
      themeName={String(cli.flags.theme || "dark")}
      mock={!!cli.flags.mock}
      initialPrompt={initialPrompt}
      mouseMode={mouseMode}
      conscienceMode={conscienceMode as ConscienceMode}
      thinkingVisibility={thinkingVisibility as ThinkingVisibility | undefined}
      agiWorkflowMode={
        agiWorkflowMode as "off" | "auto" | "on" | undefined
      }
      agiWorkflowOwned={agiWorkflowOwned}
      workflowMode={
        workflowMode as "off" | "auto" | "on" | undefined
      }
      workflowMaxStages={Math.max(1, Math.floor(Number(cli.flags.workflowMaxStages) || 6))}
      workflowMaxAgents={Math.max(2, Math.floor(Number(cli.flags.workflowMaxAgents) || 24))}
      once={!!cli.flags.once}
      onRunFinished={onRunFinished}
    />
  </ErrorBoundary>,
  {
    exitOnCtrlC: false, // we handle Ctrl+C to leave fullscreen cleanly
    patchConsole: true,
    // Ink 6 line-level diffing keeps the fixed-height viewport responsive.
    // MessageList now supplies an exact top AND bottom row slice; feeding the
    // renderer an oversized slice used to trigger Yoga shrink/overlap and
    // looked like incremental-render corruption even though the malformed
    // frame already existed before the terminal diff. `concurrent` remains
    // deliberately disabled.
    incrementalRendering: true,
  },
);

const teardown = () => {
  disableMouse();
  if (wantFs) leaveFullscreen();
  cleanupFs();
};

// Mouse reporting and the alternate screen are ours alone, so releasing them
// here is both correct and idempotent. Exact termios is deliberately NOT trusted
// to this point: Ink resolves waitUntilExit before its reconciler finishes
// unmounting, and that unmount re-applies raw mode afterwards. No in-process
// hook can be guaranteed to be the last writer, so bin/sophia restores the
// saved snapshot after this whole process has exited. The exit-hook restore in
// installFullscreenCleanup remains the fallback for direct `node dist/index.js`
// launches that have no such parent.
instance.waitUntilExit().then(
  () => {
    teardown();
    if (cli.flags.once && terminalPayload) {
      writeFinishedPayload(terminalPayload, cli.flags.finishedOut);
      process.exitCode = onceExitCode(terminalPayload);
    }
  },
  teardown,
);
