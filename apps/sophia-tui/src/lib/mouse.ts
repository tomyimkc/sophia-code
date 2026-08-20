/** Terminal mouse tracking and chunk-safe report decoding. */
export type MouseKind =
  | "click"
  | "release"
  | "move"
  | "wheel_up"
  | "wheel_down"
  | "wheel_left"
  | "wheel_right"
  | "drag";
export interface MouseEvent { kind: MouseKind; button: number; x: number; y: number; shift: boolean; meta: boolean; ctrl: boolean; }
export interface DecodedTerminalInput { text: string; events: MouseEvent[]; mouse: boolean; }

export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
const MAX_PENDING = 4096;
let mouseOn = false;

function wheelKind(button: number): MouseKind {
  switch (button) {
    case 0: return "wheel_up";
    case 1: return "wheel_down";
    case 2: return "wheel_left";
    default: return "wheel_right";
  }
}

function eventFromSgr(cb: number, x: number, y: number, final: string): MouseEvent {
  const wheel = cb & 64;
  const button = cb & 3;
  return {
    kind: wheel
      ? wheelKind(button)
      : final === "m"
        ? "release"
        : cb & 32
          ? button === 3
            ? "move"
            : "drag"
          : "click",
    button,
    x,
    y,
    shift: !!(cb & 4),
    meta: !!(cb & 8),
    ctrl: !!(cb & 16),
  };
}

/**
 * Decode terminal mouse reports without allowing split protocol tails into text.
 * Ink removes a leading Escape before invoking useInput, so application-mouse
 * mode also accepts the resulting `[<...M` form observed in real terminals.
 */
export class TerminalInputDecoder {
  private pending = "";

  reset(): void {
    this.pending = "";
  }

  feed(raw: string, acceptBareSgr = false): DecodedTerminalInput {
    let data = (this.pending + raw).slice(-MAX_PENDING);
    this.pending = "";
    let text = "";
    const events: MouseEvent[] = [];
    let mouse = false;

    while (data) {
      const match = /\x1b\[<|\x9b<|\x1b\[M|\[</.exec(data);
      if (!match) {
        if (
          acceptBareSgr &&
          (data === "[" || data === "\x1b" || data === "\x1b[" || data === "\x9b")
        ) {
          this.pending = data;
          break;
        }
        text += data;
        break;
      }
      text += data.slice(0, match.index);
      const start = match[0];
      const sequence = data.slice(match.index);

      if (start === "[<" && !acceptBareSgr) {
        text += start;
        data = sequence.slice(start.length);
        continue;
      }

      if (start === "\x1b[M") {
        if (sequence.length < 6) {
          this.pending = sequence;
          mouse = true;
          break;
        }
        // X10 reports contain three encoded bytes after ESC[M. Consume them so
        // legacy fallback can never become prompt text; SGR is used for events.
        data = sequence.slice(6);
        mouse = true;
        continue;
      }

      const complete = /^(?:\x1b\[<|\x9b<|\[<)(\d+);(\d+);(\d+)([Mm])/.exec(sequence);
      if (complete) {
        events.push(eventFromSgr(Number(complete[1]), Number(complete[2]), Number(complete[3]), complete[4]));
        data = sequence.slice(complete[0].length);
        mouse = true;
        continue;
      }

      if (/^(?:\x1b\[<|\x9b<|\[<)[\d;]*$/.test(sequence)) {
        this.pending = sequence;
        mouse = true;
        break;
      }

      // It is not a syntactically valid report. Preserve it as literal input;
      // the caller's general terminal sanitizer still removes real ANSI control.
      text += sequence;
      break;
    }

    return { text, events, mouse };
  }
}

export function enableMouse(stream: NodeJS.WriteStream = process.stdout): void {
  if (!stream.isTTY || mouseOn) return;
  try {
    stream.write(ENABLE_MOUSE);
    mouseOn = true;
  } catch {}
}

export function disableMouse(stream: NodeJS.WriteStream = process.stdout): void {
  if (!mouseOn) return;
  try { stream.write(DISABLE_MOUSE); } catch {}
  mouseOn = false;
}
