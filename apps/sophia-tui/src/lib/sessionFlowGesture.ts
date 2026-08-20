import type { MouseEvent } from "./mouse.js";

export type SessionFlowWheelGesture =
  | {
      kind: "pan";
      dx: number;
      dy: number;
    }
  | {
      kind: "zoom";
      step: -1 | 1;
    };

export interface SessionFlowWheelGestureOptions {
  horizontalPanCells?: number;
  verticalPanCells?: number;
}

function finiteCells(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * Translate terminal wheel reports into CAD-style canvas gestures.
 *
 * macOS terminals expose two-finger scrolling through the standard SGR wheel
 * directions. A terminal may encode a pinch/modified scroll as Ctrl or Meta
 * plus vertical wheel reports; those reports become pointer-anchored semantic
 * zoom. Horizontal reports pan directly, and Shift+vertical remains the
 * portable horizontal fallback.
 */
export function sessionFlowWheelGesture(
  event: Pick<MouseEvent, "kind" | "shift" | "meta" | "ctrl">,
  options: SessionFlowWheelGestureOptions = {},
): SessionFlowWheelGesture | null {
  const horizontalPanCells = finiteCells(options.horizontalPanCells, 6);
  const verticalPanCells = finiteCells(options.verticalPanCells, 3);
  const verticalDirection =
    event.kind === "wheel_up"
      ? 1
      : event.kind === "wheel_down"
        ? -1
        : 0;
  const horizontalDirection =
    event.kind === "wheel_left"
      ? 1
      : event.kind === "wheel_right"
        ? -1
        : 0;

  if ((event.ctrl || event.meta) && verticalDirection !== 0) {
    return {
      kind: "zoom",
      step: verticalDirection > 0 ? 1 : -1,
    };
  }
  if (verticalDirection === 0 && horizontalDirection === 0) return null;
  return {
    kind: "pan",
    dx:
      horizontalDirection * horizontalPanCells
      + (event.shift ? verticalDirection * horizontalPanCells : 0),
    dy: event.shift ? 0 : verticalDirection * verticalPanCells,
  };
}
