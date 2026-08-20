/** Alternate-screen fullscreen and exact terminal cleanup. */
import { spawnSync } from "node:child_process";

const ENTER_ALT = "\x1b[?1049h", LEAVE_ALT = "\x1b[?1049l", CLEAR = "\x1b[2J\x1b[H", HIDE_CURSOR = "\x1b[?25l", SHOW_CURSOR = "\x1b[?25h";
let active = false;

export function enterFullscreen(stream: NodeJS.WriteStream = process.stdout): void { if (!stream.isTTY || active) return; try { stream.write(ENTER_ALT + CLEAR + HIDE_CURSOR); active = true; } catch {} }
export function leaveFullscreen(stream: NodeJS.WriteStream = process.stdout): void { if (!active) return; try { stream.write(SHOW_CURSOR + LEAVE_ALT); } catch {} active = false; }
export function isFullscreen(): boolean { return active; }

/** stty -g is the kernel's complete tty snapshot; Ink's raw-mode restore is not sufficient on every platform. */
function saveTerminalAttrs(): string | null {
  if (!process.stdin.isTTY) return null;
  const result = spawnSync("stty", ["-g"], { stdio: [0, "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.toString().trim() : null;
}
function restoreTerminalAttrs(saved: string | null): void {
  // Ink may have unref'ed stdin by the time this runs, making isTTY an
  // unreliable guard even though fd 0 still names the controlling tty.
  if (!saved) return;
  spawnSync("stty", [saved], { stdio: [0, "ignore", "ignore"] });
}

export function installFullscreenCleanup(beforeLeave: () => void = () => undefined): () => void {
  const savedAttrs = saveTerminalAttrs();
  let cleaned = false;
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true;
      try { beforeLeave(); } catch {}
      leaveFullscreen();
    }
    try { if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
    // Ink may restore raw mode after waitUntilExit resolves. Repeat the exact
    // saved snapshot on the process exit boundary as the final writer.
    restoreTerminalAttrs(savedAttrs);
  };
  const onSignal = (code: number) => { cleanup(); process.exit(code); };
  const onError = (err: Error) => { cleanup(); console.error(err); process.exit(1); };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on("exit", cleanup);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onError);
  return () => {
    cleanup();
    // Keep the exit hook installed: Ink can perform a final raw-mode restore
    // after waitUntilExit resolves, so exit is the last exact-restore boundary.
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onError);
  };
}
