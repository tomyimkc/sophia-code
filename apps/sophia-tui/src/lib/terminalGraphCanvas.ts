import {
  displayWidth,
  graphemeWidth,
  graphemes,
  truncateToWidth,
} from "./textWidth.js";

/**
 * A layout-independent, cell-addressed renderer for terminal flow diagrams.
 *
 * Scene coordinates are integer terminal cells. `viewport.x` / `viewport.y`
 * select the world-space crop origin, while positive `panX` / `panY` translate
 * scene content right/down inside that crop.
 */

export interface GraphPoint {
  x: number;
  y: number;
}

export type GraphBlockTone =
  | "neutral"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "dim"
  | (string & {});

export interface GraphBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  detail?: string;
  status?: string;
  tone?: GraphBlockTone;
  selected?: boolean;
  live?: boolean;
  planned?: boolean;
}

/**
 * Transparent compound boundary painted behind routes and child blocks. Its
 * border may identify the semantic parent while the interior remains empty.
 */
export interface GraphFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  tone?: GraphBlockTone | GraphEdgeTone;
  dashed?: boolean;
  /** Semantic parent selected when the operator clicks the frame border. */
  nodeId?: string;
  selected?: boolean;
}

export type RoutedEdgeKind =
  | "solid"
  | "dashed"
  | "dotted"
  | "planned"
  | (string & {});

export type GraphEdgeTone =
  | "edge"
  | "edge-dim"
  | "edge-label"
  | "edge-structure"
  | "edge-progress"
  | "edge-queued"
  | "edge-live"
  | "edge-success"
  | "edge-handoff"
  | "edge-retry"
  | "edge-warning"
  | "edge-danger";

export interface RoutedEdge {
  id: string;
  points: readonly GraphPoint[];
  kind: RoutedEdgeKind;
  label?: string;
  /** Semantic colour role. Shape/label still carry meaning when colour is off. */
  tone?: GraphEdgeTone;
  /** Defaults to `tone`; override only when a label needs a distinct role. */
  labelTone?: GraphEdgeTone;
  dashed?: boolean;
  arrow?: boolean;
}

export interface TerminalGraphScene {
  frames?: readonly GraphFrame[];
  blocks: readonly GraphBlock[];
  edges: readonly RoutedEdge[];
}

export interface TerminalGraphViewport {
  width: number;
  height: number;
  x?: number;
  y?: number;
  panX?: number;
  panY?: number;
}

export interface ResolvedTerminalGraphViewport {
  width: number;
  height: number;
  x: number;
  y: number;
  panX: number;
  panY: number;
}

export type TerminalGraphCellTone =
  | GraphBlockTone
  | GraphEdgeTone
  | null;

export interface TerminalGraphCell {
  /** One terminal glyph, or "" for the continuation cell of a wide glyph. */
  glyph: string;
  tone: TerminalGraphCellTone;
  nodeId: string | null;
}

export interface TerminalGraphRow {
  text: string;
  cells: TerminalGraphCell[];
  segments: TerminalGraphSegment[];
}

export interface TerminalGraphSegment {
  text: string;
  tone: TerminalGraphCellTone;
  nodeId: string | null;
}

export interface TerminalGraphCanvasResult {
  /** Fixed-height rows whose display width equals `viewport.width`. */
  lines: string[];
  /** Cell-level output for Ink renderers that want to apply their own colour. */
  cells: TerminalGraphCell[][];
  /** The same cells grouped with their plain-text row. */
  rows: TerminalGraphRow[];
  /** Node/group id for visible block or frame-border cells. */
  hitMap: Array<Array<string | null>>;
  viewport: ResolvedTerminalGraphViewport;
}

export type TerminalGraphBlock = GraphBlock;
export type TerminalGraphEdge = RoutedEdge;
export type TerminalGraphRenderResult = TerminalGraphCanvasResult;

const UP = 1;
const RIGHT = 2;
const DOWN = 4;
const LEFT = 8;

type BorderGlyphs = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
};

const SINGLE_BORDER: BorderGlyphs = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
};

const DOUBLE_BORDER: BorderGlyphs = {
  topLeft: "╔",
  topRight: "╗",
  bottomLeft: "╚",
  bottomRight: "╝",
  horizontal: "═",
  vertical: "║",
};

const HEAVY_BORDER: BorderGlyphs = {
  topLeft: "┏",
  topRight: "┓",
  bottomLeft: "┗",
  bottomRight: "┛",
  horizontal: "━",
  vertical: "┃",
};

const DASHED_BORDER: BorderGlyphs = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "┄",
  vertical: "┆",
};

function finiteInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function finiteSize(value: number): number {
  return Math.max(0, finiteInteger(value));
}

function resolveViewport(
  viewport: TerminalGraphViewport,
): ResolvedTerminalGraphViewport {
  return {
    width: finiteSize(viewport.width),
    height: finiteSize(viewport.height),
    x: finiteInteger(viewport.x ?? 0),
    y: finiteInteger(viewport.y ?? 0),
    panX: finiteInteger(viewport.panX ?? 0),
    panY: finiteInteger(viewport.panY ?? 0),
  };
}

function cleanText(value: string | undefined): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function glyphWidth(glyph: string): number {
  return graphemeWidth(glyph);
}

export function terminalCellWidth(text: string): number {
  return displayWidth(text);
}

export function truncateTerminalText(text: string, maxCells: number): string {
  const clean = cleanText(text);
  const limit = finiteSize(maxCells);
  return truncateToWidth(clean, limit);
}

function normalizePoint(point: GraphPoint): GraphPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: Math.trunc(point.x), y: Math.trunc(point.y) };
}

function samePoint(left: GraphPoint, right: GraphPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

/**
 * Diagonal point pairs are made orthogonal deterministically: horizontal
 * first, then vertical. Already-routed point lists are preserved.
 */
function orthogonalPoints(points: readonly GraphPoint[]): GraphPoint[] {
  const route: GraphPoint[] = [];
  for (const rawPoint of points) {
    const point = normalizePoint(rawPoint);
    if (!point) continue;
    const previous = route.at(-1);
    if (!previous) {
      route.push(point);
      continue;
    }
    if (samePoint(previous, point)) continue;
    if (previous.x !== point.x && previous.y !== point.y) {
      route.push({ x: point.x, y: previous.y });
    }
    if (!samePoint(route.at(-1)!, point)) route.push(point);
  }
  return route;
}

function isDashedEdge(edge: RoutedEdge): boolean {
  return (
    edge.dashed === true ||
    /(?:^|[-_\s])(dash|dashed|dim|dot|dotted|plan|planned)(?:$|[-_\s])/i.test(edge.kind)
  );
}

function isDottedEdge(edge: RoutedEdge): boolean {
  return /(?:^|[-_\s])(dot|dotted)(?:$|[-_\s])/i.test(edge.kind);
}

const EDGE_TONE_PRIORITY: Readonly<Record<GraphEdgeTone, number>> = {
  "edge": 10,
  "edge-dim": 5,
  "edge-label": 15,
  "edge-structure": 20,
  "edge-progress": 30,
  "edge-handoff": 35,
  "edge-retry": 40,
  "edge-queued": 50,
  "edge-success": 60,
  "edge-live": 70,
  "edge-warning": 80,
  "edge-danger": 90,
};

function preferredEdgeTone(
  current: GraphEdgeTone | null,
  incoming: GraphEdgeTone,
): GraphEdgeTone {
  if (!current) return incoming;
  const priorityDelta =
    EDGE_TONE_PRIORITY[incoming] - EDGE_TONE_PRIORITY[current];
  if (priorityDelta !== 0) return priorityDelta > 0 ? incoming : current;
  return incoming.localeCompare(current) < 0 ? incoming : current;
}

function edgeArrowGlyph(route: readonly GraphPoint[]): string {
  const end = route.at(-1);
  if (!end) return "";
  for (let index = route.length - 2; index >= 0; index -= 1) {
    const previous = route[index];
    if (!previous || samePoint(previous, end)) continue;
    if (previous.x < end.x) return "▶";
    if (previous.x > end.x) return "◀";
    if (previous.y < end.y) return "▼";
    if (previous.y > end.y) return "▲";
  }
  return "•";
}

function glyphForMask(
  mask: number,
  lineStyle: "solid" | "dashed" | "dotted",
): string {
  if (lineStyle === "dotted") {
    if ((mask & (LEFT | RIGHT)) !== 0 && (mask & (UP | DOWN)) === 0) return "┈";
    if ((mask & (UP | DOWN)) !== 0 && (mask & (LEFT | RIGHT)) === 0) return "┊";
  }
  if (lineStyle === "dashed") {
    if ((mask & (LEFT | RIGHT)) !== 0 && (mask & (UP | DOWN)) === 0) return "┄";
    if ((mask & (UP | DOWN)) !== 0 && (mask & (LEFT | RIGHT)) === 0) return "┆";
  }

  switch (mask) {
    case LEFT:
    case RIGHT:
    case LEFT | RIGHT:
      return "─";
    case UP:
    case DOWN:
    case UP | DOWN:
      return "│";
    case RIGHT | DOWN:
      return "┌";
    case LEFT | DOWN:
      return "┐";
    case RIGHT | UP:
      return "└";
    case LEFT | UP:
      return "┘";
    case LEFT | RIGHT | DOWN:
      return "┬";
    case LEFT | RIGHT | UP:
      return "┴";
    case UP | DOWN | RIGHT:
      return "├";
    case UP | DOWN | LEFT:
      return "┤";
    case UP | RIGHT | DOWN | LEFT:
      return "┼";
    default:
      return "•";
  }
}

function blockBorder(block: GraphBlock): BorderGlyphs {
  if (block.selected) return DOUBLE_BORDER;
  if (block.planned || block.tone?.toLowerCase() === "dim") return DASHED_BORDER;
  if (block.live) return HEAVY_BORDER;
  return SINGLE_BORDER;
}

function blockMarker(block: GraphBlock): string {
  if (block.live) return "●";
  if (block.planned) return "◌";
  switch (block.tone?.toLowerCase()) {
    case "accent":
      return "◆";
    case "info":
      return "i";
    case "success":
      return "✓";
    case "warning":
      return "!";
    case "danger":
      return "×";
    case "dim":
      return "·";
    default:
      return "";
  }
}

function blockCellTone(block: GraphBlock): GraphBlockTone {
  if (block.selected) return "accent";
  if (block.tone) return block.tone;
  if (block.planned) return "dim";
  if (block.live) return "success";
  return "neutral";
}

function blockTextLines(block: GraphBlock, rows: number): string[] {
  if (rows <= 0) return [];
  const marker = blockMarker(block);
  const title = cleanText(block.title);
  const titleLine = marker ? `${marker} ${title}` : title;
  const subtitle = cleanText(block.subtitle);
  const detail = cleanText(block.detail);
  const status = cleanText(block.status);
  const details = [subtitle, detail].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );

  if (rows === 1) return [titleLine];
  if (rows === 2) {
    const summary = [status, ...details].filter(Boolean).join(" · ");
    return summary ? [titleLine, summary] : [titleLine];
  }

  const output = [titleLine];
  const detailBudget = Math.max(0, rows - 1 - (status ? 1 : 0));
  output.push(...details.slice(0, detailBudget));
  if (status && output.length < rows) output.push(status);
  output.push(...details.slice(detailBudget, detailBudget + Math.max(0, rows - output.length)));
  return output.slice(0, rows);
}

function routeMidpoint(route: readonly GraphPoint[]): GraphPoint | null {
  if (route.length === 0) return null;
  if (route.length === 1) return route[0] ?? null;

  let total = 0;
  const lengths: number[] = [];
  for (let index = 1; index < route.length; index += 1) {
    const previous = route[index - 1]!;
    const point = route[index]!;
    const length = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return route[0] ?? null;

  const target = total / 2;
  let traversed = 0;
  for (let index = 1; index < route.length; index += 1) {
    const previous = route[index - 1]!;
    const point = route[index]!;
    const length = lengths[index - 1]!;
    if (traversed + length < target) {
      traversed += length;
      continue;
    }
    const offset = Math.round(target - traversed);
    if (previous.x !== point.x) {
      return {
        x: previous.x + Math.sign(point.x - previous.x) * offset,
        y: previous.y,
      };
    }
    return {
      x: previous.x,
      y: previous.y + Math.sign(point.y - previous.y) * offset,
    };
  }
  return route.at(-1) ?? null;
}

export function worldToViewportCell(
  viewport: TerminalGraphViewport | ResolvedTerminalGraphViewport,
  point: GraphPoint,
): GraphPoint {
  const resolved = resolveViewport(viewport);
  return {
    x: finiteInteger(point.x) - resolved.x + resolved.panX,
    y: finiteInteger(point.y) - resolved.y + resolved.panY,
  };
}

export function viewportCellToWorld(
  viewport: TerminalGraphViewport | ResolvedTerminalGraphViewport,
  point: GraphPoint,
): GraphPoint {
  const resolved = resolveViewport(viewport);
  return {
    x: finiteInteger(point.x) + resolved.x - resolved.panX,
    y: finiteInteger(point.y) + resolved.y - resolved.panY,
  };
}

export function hitTestNode(
  result: Pick<TerminalGraphCanvasResult, "hitMap">,
  x: number,
  y: number,
): string | null {
  const cellX = finiteInteger(x, -1);
  const cellY = finiteInteger(y, -1);
  if (cellX < 0 || cellY < 0) return null;
  return result.hitMap[cellY]?.[cellX] ?? null;
}

export function hitTestNodeAtWorld(
  result: Pick<TerminalGraphCanvasResult, "hitMap" | "viewport">,
  worldX: number,
  worldY: number,
): string | null {
  const cell = worldToViewportCell(result.viewport, { x: worldX, y: worldY });
  return hitTestNode(result, cell.x, cell.y);
}

export const nodeIdAt = hitTestNode;
export const hitTestTerminalGraph = hitTestNode;
export const hitTestCanvas = hitTestNode;

export function renderTerminalGraphCanvas(
  scene: TerminalGraphScene,
  viewport: TerminalGraphViewport,
): TerminalGraphCanvasResult {
  const resolved = resolveViewport(viewport);
  const glyphs = Array.from(
    { length: resolved.height },
    () => Array<string>(resolved.width).fill(" "),
  );
  const hitMap = Array.from(
    { length: resolved.height },
    () => Array<string | null>(resolved.width).fill(null),
  );
  const tones = Array.from(
    { length: resolved.height },
    () => Array<TerminalGraphCellTone>(resolved.width).fill(null),
  );
  const edgeMasks = Array.from(
    { length: resolved.height },
    () => new Uint8Array(resolved.width),
  );
  // 0 = none, 1 = dotted only, 2 = at least one dashed edge, 3 = solid.
  const edgeStyles = Array.from(
    { length: resolved.height },
    () => new Uint8Array(resolved.width),
  );
  const edgeTones = Array.from(
    { length: resolved.height },
    () => Array<GraphEdgeTone | null>(resolved.width).fill(null),
  );

  const screenPoint = (point: GraphPoint): GraphPoint =>
    worldToViewportCell(resolved, point);

  const visible = (x: number, y: number): boolean =>
    x >= 0 && x < resolved.width && y >= 0 && y < resolved.height;

  const setGlyph = (
    x: number,
    y: number,
    glyph: string,
    tone?: TerminalGraphCellTone,
  ): void => {
    if (!visible(x, y)) return;

    const eraseGlyphAt = (cellX: number): void => {
      if (!visible(cellX, y)) return;
      if (glyphs[y]![cellX] === "" && cellX > 0) {
        glyphs[y]![cellX - 1] = " ";
        tones[y]![cellX - 1] = null;
        glyphs[y]![cellX] = " ";
        tones[y]![cellX] = null;
        return;
      }
      if (
        glyphWidth(glyphs[y]![cellX] ?? "") === 2 &&
        cellX + 1 < resolved.width &&
        glyphs[y]![cellX + 1] === ""
      ) {
        glyphs[y]![cellX] = " ";
        tones[y]![cellX] = null;
        glyphs[y]![cellX + 1] = " ";
        tones[y]![cellX + 1] = null;
        return;
      }
      glyphs[y]![cellX] = " ";
      tones[y]![cellX] = null;
    };

    const width = glyphWidth(glyph);
    if (width === 2) {
      if (x + 1 >= resolved.width) return;
      const firstTone = tone === undefined ? tones[y]![x] : tone;
      const secondTone = tone === undefined
        ? (tones[y]![x + 1] ?? firstTone)
        : tone;
      eraseGlyphAt(x);
      eraseGlyphAt(x + 1);
      glyphs[y]![x] = glyph;
      glyphs[y]![x + 1] = "";
      tones[y]![x] = firstTone;
      tones[y]![x + 1] = secondTone;
      return;
    }
    const inheritedTone = tone === undefined ? tones[y]![x] : tone;
    eraseGlyphAt(x);
    glyphs[y]![x] = glyph;
    tones[y]![x] = inheritedTone;
  };

  const setWorldGlyph = (
    x: number,
    y: number,
    glyph: string,
    tone?: TerminalGraphCellTone,
    nodeId?: string,
  ): void => {
    const screen = screenPoint({ x, y });
    setGlyph(screen.x, screen.y, glyph, tone);
    if (nodeId && visible(screen.x, screen.y)) {
      hitMap[screen.y]![screen.x] = nodeId;
    }
  };

  const writeText = (
    screenX: number,
    screenY: number,
    text: string,
    maxCells: number,
    tone?: TerminalGraphCellTone,
  ): void => {
    if (screenY < 0 || screenY >= resolved.height || maxCells <= 0) return;
    const fitted = truncateTerminalText(text, maxCells);
    let cursor = screenX;
    for (const glyph of graphemes(fitted)) {
      const width = glyphWidth(glyph);
      if (width === 0) {
        const previous = cursor - 1;
        if (visible(previous, screenY)) glyphs[screenY]![previous] += glyph;
        continue;
      }
      if (cursor >= screenX + maxCells) break;
      if (cursor + width > screenX + maxCells) break;
      if (cursor + width > 0 && cursor < resolved.width) {
        if (width === 1) {
          setGlyph(cursor, screenY, glyph, tone);
        } else if (cursor >= 0 && cursor + 1 < resolved.width) {
          setGlyph(cursor, screenY, glyph, tone);
        }
      }
      cursor += width;
    }
  };

  const addEdgeMask = (
    worldX: number,
    worldY: number,
    mask: number,
    lineStyle: "solid" | "dashed" | "dotted",
    tone: GraphEdgeTone,
  ): void => {
    const screen = screenPoint({ x: worldX, y: worldY });
    if (!visible(screen.x, screen.y)) return;
    edgeMasks[screen.y]![screen.x] |= mask;
    const stylePriority =
      lineStyle === "solid" ? 3 : lineStyle === "dashed" ? 2 : 1;
    edgeStyles[screen.y]![screen.x] = Math.max(
      edgeStyles[screen.y]![screen.x]!,
      stylePriority,
    );
    edgeTones[screen.y]![screen.x] = preferredEdgeTone(
      edgeTones[screen.y]![screen.x]!,
      tone,
    );
  };

  // Compound frames are intentionally transparent and painted first. Their
  // border selects the semantic process parent, while child blocks paint last
  // and retain their own hit cells without an opaque parent occluding them.
  for (const frame of scene.frames ?? []) {
    const frameX = finiteInteger(frame.x);
    const frameY = finiteInteger(frame.y);
    const frameWidth = finiteSize(frame.width);
    const frameHeight = finiteSize(frame.height);
    if (frameWidth === 0 || frameHeight === 0) continue;
    const tone = frame.tone ?? "edge-structure";
    const border = frame.selected
      ? DOUBLE_BORDER
      : frame.dashed
        ? DASHED_BORDER
        : SINGLE_BORDER;
    if (frameWidth === 1 && frameHeight === 1) {
      setWorldGlyph(frameX, frameY, "□", tone, frame.nodeId);
      continue;
    }
    if (frameHeight === 1) {
      for (let offset = 0; offset < frameWidth; offset += 1) {
        setWorldGlyph(
          frameX + offset,
          frameY,
          offset === 0
            ? border.topLeft
            : offset === frameWidth - 1
              ? border.topRight
              : border.horizontal,
          tone,
          frame.nodeId,
        );
      }
      continue;
    }
    if (frameWidth === 1) {
      for (let offset = 0; offset < frameHeight; offset += 1) {
        setWorldGlyph(
          frameX,
          frameY + offset,
          offset === 0
            ? border.topLeft
            : offset === frameHeight - 1
              ? border.bottomLeft
              : border.vertical,
          tone,
          frame.nodeId,
        );
      }
      continue;
    }
    for (let offset = 0; offset < frameWidth; offset += 1) {
      setWorldGlyph(
        frameX + offset,
        frameY,
        offset === 0
          ? border.topLeft
          : offset === frameWidth - 1
            ? border.topRight
            : border.horizontal,
        tone,
        frame.nodeId,
      );
      setWorldGlyph(
        frameX + offset,
        frameY + frameHeight - 1,
        offset === 0
          ? border.bottomLeft
          : offset === frameWidth - 1
            ? border.bottomRight
            : border.horizontal,
        tone,
        frame.nodeId,
      );
    }
    for (let offset = 1; offset < frameHeight - 1; offset += 1) {
      setWorldGlyph(
        frameX,
        frameY + offset,
        border.vertical,
        tone,
        frame.nodeId,
      );
      setWorldGlyph(
        frameX + frameWidth - 1,
        frameY + offset,
        border.vertical,
        tone,
        frame.nodeId,
      );
    }
    const labelBudget = Math.max(0, frameWidth - 4);
    if (labelBudget > 0 && cleanText(frame.label)) {
      const screen = screenPoint({ x: frameX + 2, y: frameY });
      writeText(
        screen.x,
        screen.y,
        ` ${cleanText(frame.label)} `,
        labelBudget,
        tone,
      );
    }
  }

  const routes = new Map<string, GraphPoint[]>();
  for (const edge of scene.edges ?? []) {
    const route = orthogonalPoints(edge.points ?? []);
    routes.set(edge.id, route);
    const dashed = isDashedEdge(edge);
    const lineStyle = isDottedEdge(edge)
      ? "dotted"
      : dashed
        ? "dashed"
        : "solid";
    const tone = edge.tone ?? (dashed ? "edge-dim" : "edge");
    for (let index = 1; index < route.length; index += 1) {
      const start = route[index - 1]!;
      const end = route[index]!;
      if (start.y === end.y) {
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const firstVisibleWorldX = resolved.x - resolved.panX;
        const lastVisibleWorldX = firstVisibleWorldX + resolved.width - 1;
        const from = Math.max(minX, firstVisibleWorldX);
        const to = Math.min(maxX, lastVisibleWorldX);
        for (let x = from; x <= to; x += 1) {
          let mask = 0;
          if (x > minX) mask |= LEFT;
          if (x < maxX) mask |= RIGHT;
          addEdgeMask(x, start.y, mask, lineStyle, tone);
        }
      } else if (start.x === end.x) {
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);
        const firstVisibleWorldY = resolved.y - resolved.panY;
        const lastVisibleWorldY = firstVisibleWorldY + resolved.height - 1;
        const from = Math.max(minY, firstVisibleWorldY);
        const to = Math.min(maxY, lastVisibleWorldY);
        for (let y = from; y <= to; y += 1) {
          let mask = 0;
          if (y > minY) mask |= UP;
          if (y < maxY) mask |= DOWN;
          addEdgeMask(start.x, y, mask, lineStyle, tone);
        }
      }
    }
  }

  for (let y = 0; y < resolved.height; y += 1) {
    for (let x = 0; x < resolved.width; x += 1) {
      const mask = edgeMasks[y]![x]!;
      if (mask === 0) continue;
      const stylePriority = edgeStyles[y]![x]!;
      const lineStyle =
        stylePriority === 3
          ? "solid"
          : stylePriority === 2
            ? "dashed"
            : "dotted";
      setGlyph(
        x,
        y,
        glyphForMask(mask, lineStyle),
        edgeTones[y]![x] ??
          (lineStyle === "solid" ? "edge" : "edge-dim"),
      );
    }
  }

  // Edge labels float over routes; terminal arrowheads are restored afterward.
  for (const edge of scene.edges ?? []) {
    const label = cleanText(edge.label);
    if (!label) continue;
    const midpoint = routeMidpoint(routes.get(edge.id) ?? []);
    if (!midpoint) continue;
    const text = ` ${label} `;
    const width = terminalCellWidth(text);
    const screen = screenPoint(midpoint);
    const startX = screen.x - Math.floor(width / 2);
    writeText(
      startX,
      screen.y,
      text,
      width,
      edge.labelTone ?? edge.tone ?? "edge-label",
    );
  }

  for (const edge of scene.edges ?? []) {
    if (edge.arrow === false) continue;
    const route = routes.get(edge.id) ?? [];
    const end = route.at(-1);
    if (!end) continue;
    const screen = screenPoint(end);
    setGlyph(
      screen.x,
      screen.y,
      edgeArrowGlyph(route),
      edge.tone ?? (isDashedEdge(edge) ? "edge-dim" : "edge"),
    );
  }

  // Blocks are deliberately rendered last so they occlude routed edges.
  for (const block of scene.blocks ?? []) {
    const blockX = finiteInteger(block.x);
    const blockY = finiteInteger(block.y);
    const blockWidth = finiteSize(block.width);
    const blockHeight = finiteSize(block.height);
    if (blockWidth === 0 || blockHeight === 0) continue;
    const cellTone = blockCellTone(block);

    const firstVisibleWorldX = resolved.x - resolved.panX;
    const firstVisibleWorldY = resolved.y - resolved.panY;
    const lastVisibleWorldX = firstVisibleWorldX + resolved.width - 1;
    const lastVisibleWorldY = firstVisibleWorldY + resolved.height - 1;
    const fillFromX = Math.max(blockX, firstVisibleWorldX);
    const fillToX = Math.min(blockX + blockWidth - 1, lastVisibleWorldX);
    const fillFromY = Math.max(blockY, firstVisibleWorldY);
    const fillToY = Math.min(blockY + blockHeight - 1, lastVisibleWorldY);

    for (let worldY = fillFromY; worldY <= fillToY; worldY += 1) {
      for (let worldX = fillFromX; worldX <= fillToX; worldX += 1) {
        const screen = screenPoint({ x: worldX, y: worldY });
        setGlyph(screen.x, screen.y, " ", cellTone);
        hitMap[screen.y]![screen.x] = block.id;
      }
    }

    const border = blockBorder(block);
    if (blockWidth === 1 && blockHeight === 1) {
      setWorldGlyph(blockX, blockY, block.selected ? "╬" : block.planned ? "┄" : "□");
      continue;
    }
    if (blockHeight === 1) {
      for (let offset = 0; offset < blockWidth; offset += 1) {
        const glyph = offset === 0
          ? border.topLeft
          : offset === blockWidth - 1
            ? border.topRight
            : border.horizontal;
        setWorldGlyph(blockX + offset, blockY, glyph);
      }
      continue;
    }
    if (blockWidth === 1) {
      for (let offset = 0; offset < blockHeight; offset += 1) {
        const glyph = offset === 0
          ? border.topLeft
          : offset === blockHeight - 1
            ? border.bottomLeft
            : border.vertical;
        setWorldGlyph(blockX, blockY + offset, glyph);
      }
      continue;
    }

    for (let offset = 0; offset < blockWidth; offset += 1) {
      setWorldGlyph(
        blockX + offset,
        blockY,
        offset === 0
          ? border.topLeft
          : offset === blockWidth - 1
            ? border.topRight
            : border.horizontal,
      );
      setWorldGlyph(
        blockX + offset,
        blockY + blockHeight - 1,
        offset === 0
          ? border.bottomLeft
          : offset === blockWidth - 1
            ? border.bottomRight
            : border.horizontal,
      );
    }
    for (let offset = 1; offset < blockHeight - 1; offset += 1) {
      setWorldGlyph(blockX, blockY + offset, border.vertical);
      setWorldGlyph(blockX + blockWidth - 1, blockY + offset, border.vertical);
    }

    const innerWidth = blockWidth - 2;
    const innerRows = blockHeight - 2;
    const textLines = blockTextLines(block, innerRows);
    const textInset = innerWidth >= 3 ? 1 : 0;
    for (let index = 0; index < textLines.length; index += 1) {
      const line = textLines[index]!;
      const screen = screenPoint({
        x: blockX + 1 + textInset,
        y: blockY + 1 + index,
      });
      writeText(screen.x, screen.y, line, innerWidth - textInset);
    }
  }

  const lines = glyphs.map((row) => row.join(""));
  const cells = glyphs.map((row, y) =>
    row.map((glyph, x) => ({
      glyph,
      tone: tones[y]![x]!,
      nodeId: hitMap[y]![x]!,
    })),
  );
  const rows = lines.map((text, index) => {
    const rowCells = cells[index]!;
    const segments: TerminalGraphSegment[] = [];
    for (const cell of rowCells) {
      const previous = segments.at(-1);
      if (previous && previous.tone === cell.tone && previous.nodeId === cell.nodeId) {
        previous.text += cell.glyph;
      } else {
        segments.push({
          text: cell.glyph,
          tone: cell.tone,
          nodeId: cell.nodeId,
        });
      }
    }
    return {
      text,
      cells: rowCells,
      segments,
    };
  });

  return {
    lines,
    cells,
    rows,
    hitMap,
    viewport: resolved,
  };
}

export const renderTerminalGraph = renderTerminalGraphCanvas;
