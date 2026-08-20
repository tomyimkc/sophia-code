import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import {
  LOAD_HEIGHT,
  coalesceRuns,
  makeLoadAnim,
  type Cell,
  type Frame,
  type Row,
} from "../lib/anims/index.js";

export const AMBIENT_INTERVAL_MS = 160;
export const AMBIENT_PATTERN_ID = "sine-sheet";

export function ambientIntervalEnabled(prefs: AccessibilityPrefs): boolean {
  return !prefs.screenReader && !prefs.reducedMotion;
}

function ambientCell(cell: Cell, x: number, y: number, frame: number): Cell {
  const energy = Math.max(cell.r, cell.g, cell.b) / 255;
  // Coprime spatial coefficients prevent a whole contour row from lighting
  // at once; the field reads as sparse depth instead of a dotted separator.
  const movingMask = (x * 5 + y * 11 + Math.floor(frame / 2) * 7) % 23;
  const visible =
    cell.ch !== " "
    && energy > 0.18
    && (movingMask === 0 || (movingMask === 1 && energy > 0.72));
  if (!visible) return { ch: " ", r: 5, g: 9, b: 12 };
  const lift = energy > 0.72 ? 0.14 : 0.09;
  return {
    ch: energy > 0.72 ? "·" : ".",
    r: Math.round(cell.r * lift),
    g: Math.round(cell.g * lift),
    b: Math.round(cell.b * lift),
    bold: false,
  };
}

/**
 * Tile the existing production 3D field through an arbitrary pane height,
 * then thin/dim it into a backdrop. Every output cell remains deterministic
 * and defined; no fake progress signal or random source is introduced.
 */
export function ambientBackdropSnapshot({
  frame,
  width,
  height,
  patternId = AMBIENT_PATTERN_ID,
}: {
  frame: number;
  width: number;
  height: number;
  patternId?: string;
}): Frame {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const anim = makeLoadAnim(patternId) ?? makeLoadAnim(AMBIENT_PATTERN_ID);
  if (!anim) {
    return Array.from({ length: safeHeight }, () =>
      Array.from({ length: safeWidth }, () => ({ ch: " ", r: 5, g: 9, b: 12 })),
    );
  }
  const source = anim.render(frame, safeWidth, "ambient");
  const drift = Math.floor(frame / 5);
  return Array.from({ length: safeHeight }, (_, y) => {
    const sourceRow = source[(y + drift) % Math.max(1, LOAD_HEIGHT)] ?? [];
    return Array.from({ length: safeWidth }, (_, x) =>
      ambientCell(
        sourceRow[x] ?? { ch: " ", r: 5, g: 9, b: 12 },
        x,
        y,
        frame,
      ),
    );
  });
}

function AmbientRow({ row }: { row: Row }): React.ReactElement {
  return (
    <Text wrap="truncate-end">
      {coalesceRuns(row).map((run, index) => (
        <Text key={`${index}-${run.color}`} color={run.color}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Absolute decorative layer. Because it is painted before pane content, real
 * chat/panel glyphs overwrite it while otherwise-unused cells retain depth.
 */
export function AmbientBackdrop({
  width,
  height,
  patternId = AMBIENT_PATTERN_ID,
}: {
  width: number;
  height: number;
  patternId?: string;
}): React.ReactElement | null {
  const ax = useAccessibility();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!ambientIntervalEnabled(ax)) return;
    const id = setInterval(() => setFrame((value) => value + 1), AMBIENT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ax.reducedMotion, ax.screenReader]);

  const rows = useMemo(
    () => ambientBackdropSnapshot({ frame, width, height, patternId }),
    [frame, height, patternId, width],
  );
  if (ax.screenReader) return null;
  return (
    <Box
      position="absolute"
      width={Math.max(1, width)}
      height={Math.max(1, height)}
      flexDirection="column"
      overflow="hidden"
    >
      {rows.map((row, index) => (
        <AmbientRow key={index} row={row} />
      ))}
    </Box>
  );
}
