import test from "node:test";
import assert from "node:assert/strict";
import {
  hitTestNode,
  hitTestNodeAtWorld,
  renderTerminalGraphCanvas,
  terminalCellWidth,
  truncateTerminalText,
  viewportCellToWorld,
  worldToViewportCell,
  type TerminalGraphScene,
} from "./terminalGraphCanvas.js";

test("renders selected blocks last with double borders, clipped detail, and node tones", () => {
  const result = renderTerminalGraphCanvas(
    {
      edges: [
        {
          id: "behind",
          kind: "solid",
          points: [{ x: -2, y: 2 }, { x: 16, y: 2 }],
        },
      ],
      blocks: [
        {
          id: "selected",
          x: 0,
          y: 0,
          width: 14,
          height: 5,
          title: "A very long block title",
          detail: "detail payload overflow",
          status: "running status overflow",
          tone: "danger",
          selected: true,
        },
      ],
    },
    { width: 14, height: 5 },
  );

  assert.equal(result.lines[0], "╔════════════╗");
  assert.equal(result.lines[4], "╚════════════╝");
  assert.match(result.lines[1]!, /^║ .+…║$/);
  assert.match(result.lines[2]!, /^║ detail .+…║$/);
  assert.match(result.lines[3]!, /^║ running .+…║$/);
  assert.ok(result.lines.every((line) => terminalCellWidth(line) === 14));
  assert.ok(
    result.cells.flat().every(
      (cell) => cell.nodeId === "selected" && cell.tone === "accent",
    ),
  );
  assert.deepEqual(result.rows[0]!.segments, [
    {
      text: "╔════════════╗",
      tone: "accent",
      nodeId: "selected",
    },
  ]);
});

test("uses dashed planned borders and live heavy borders", () => {
  const planned = renderTerminalGraphCanvas(
    {
      edges: [],
      blocks: [
        {
          id: "planned",
          x: 0,
          y: 0,
          width: 8,
          height: 3,
          title: "planned",
          planned: true,
        },
      ],
    },
    { width: 8, height: 3 },
  );
  assert.equal(planned.lines[0], "┌┄┄┄┄┄┄┐");
  assert.equal(planned.lines[1]?.at(0), "┆");
  assert.equal(planned.lines[1]?.at(-1), "┆");
  assert.equal(planned.lines[2], "└┄┄┄┄┄┄┘");
  assert.ok(planned.cells.flat().every((cell) => cell.tone === "dim"));

  const live = renderTerminalGraphCanvas(
    {
      edges: [],
      blocks: [
        {
          id: "live",
          x: 0,
          y: 0,
          width: 6,
          height: 3,
          title: "run",
          live: true,
        },
      ],
    },
    { width: 6, height: 3 },
  );
  assert.equal(live.lines[0], "┏━━━━┓");
  assert.equal(live.lines[2], "┗━━━━┛");
  assert.ok(live.cells.flat().every((cell) => cell.tone === "success"));
});

test("renders selectable transparent process borders behind independently selectable children", () => {
  const result = renderTerminalGraphCanvas(
    {
      frames: [
        {
          id: "process-frame:p1",
          x: 0,
          y: 0,
          width: 18,
          height: 7,
          label: "Process P1",
          tone: "edge-structure",
          nodeId: "process:p1",
        },
      ],
      edges: [
        {
          id: "input",
          kind: "solid",
          points: [{ x: 0, y: 3 }, { x: 3, y: 3 }],
        },
      ],
      blocks: [
        {
          id: "child",
          x: 3,
          y: 2,
          width: 10,
          height: 3,
          title: "workflow",
        },
      ],
    },
    { width: 18, height: 7 },
  );

  assert.match(result.lines[0] || "", /^┌─Process P1─/);
  assert.equal(hitTestNode(result, 0, 0), "process:p1");
  assert.equal(hitTestNode(result, 1, 1), null, "frame interior stays transparent");
  assert.equal(
    hitTestNode(result, 4, 3),
    "child",
    "child hit cells override the parent frame",
  );
  assert.equal(result.lines[3]?.at(0), "─", "the input route connects through the frame boundary");
  assert.equal(result.cells[0]?.[2]?.tone, "edge-structure");
});

test("merges orthogonal crossings deterministically and lets solid routes win tone", () => {
  const horizontal = {
    id: "horizontal",
    kind: "solid",
    arrow: false,
    points: [{ x: 0, y: 2 }, { x: 6, y: 2 }],
  } as const;
  const vertical = {
    id: "vertical",
    kind: "planned",
    arrow: false,
    points: [{ x: 3, y: 0 }, { x: 3, y: 4 }],
  } as const;

  const first = renderTerminalGraphCanvas(
    { blocks: [], edges: [horizontal, vertical] },
    { width: 7, height: 5 },
  );
  const reversed = renderTerminalGraphCanvas(
    { blocks: [], edges: [vertical, horizontal] },
    { width: 7, height: 5 },
  );

  assert.deepEqual(reversed, first);
  assert.equal(first.lines[0], "   ┆   ");
  assert.equal(first.lines[2], "───┼───");
  assert.equal(first.lines[4], "   ┆   ");
  assert.equal(first.cells[2]?.[3]?.tone, "edge");
  assert.equal(first.cells[1]?.[3]?.tone, "edge-dim");
});

test("renders semantic dotted structure without arrows and status-colored execution", () => {
  const result = renderTerminalGraphCanvas(
    {
      blocks: [],
      edges: [
        {
          id: "structure",
          kind: "dotted",
          tone: "edge-structure",
          arrow: false,
          points: [
            { x: 0, y: 0 },
            { x: 6, y: 0 },
          ],
        },
        {
          id: "live",
          kind: "solid",
          tone: "edge-live",
          points: [
            { x: 0, y: 2 },
            { x: 6, y: 2 },
          ],
        },
      ],
    },
    { width: 7, height: 3 },
  );

  assert.equal(result.lines[0], "┈┈┈┈┈┈┈");
  assert.equal(result.lines[0]?.includes("▶"), false);
  assert.equal(result.cells[0]?.[3]?.tone, "edge-structure");
  assert.equal(result.lines[2]?.at(-1), "▶");
  assert.equal(result.cells[2]?.[3]?.tone, "edge-live");
  assert.equal(result.cells[2]?.[6]?.tone, "edge-live");
});

test("semantic edge crossings choose the highest-severity tone deterministically", () => {
  const live = {
    id: "live",
    kind: "solid",
    tone: "edge-live",
    arrow: false,
    points: [
      { x: 0, y: 2 },
      { x: 6, y: 2 },
    ],
  } as const;
  const failed = {
    id: "failed",
    kind: "dashed",
    tone: "edge-danger",
    arrow: false,
    points: [
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ],
  } as const;

  const first = renderTerminalGraphCanvas(
    { blocks: [], edges: [live, failed] },
    { width: 7, height: 5 },
  );
  const reversed = renderTerminalGraphCanvas(
    { blocks: [], edges: [failed, live] },
    { width: 7, height: 5 },
  );

  assert.deepEqual(reversed, first);
  assert.equal(first.cells[2]?.[3]?.tone, "edge-danger");
  assert.equal(first.cells[2]?.[2]?.tone, "edge-live");
});

test("normalizes diagonal route points to horizontal-first bends and arrowheads", () => {
  const result = renderTerminalGraphCanvas(
    {
      blocks: [],
      edges: [
        {
          id: "diagonal-input",
          kind: "solid",
          points: [{ x: 0, y: 0 }, { x: 3, y: 2 }],
        },
      ],
    },
    { width: 4, height: 3 },
  );

  assert.deepEqual(result.lines, [
    "───┐",
    "   │",
    "   ▼",
  ]);
});

test("blocks occlude edges and expose per-cell viewport and world hit testing", () => {
  const result = renderTerminalGraphCanvas(
    {
      edges: [
        {
          id: "flow",
          kind: "solid",
          points: [{ x: 0, y: 2 }, { x: 10, y: 2 }],
        },
      ],
      blocks: [
        {
          id: "node-a",
          x: 3,
          y: 1,
          width: 5,
          height: 3,
          title: "A",
        },
      ],
    },
    { width: 11, height: 5 },
  );

  assert.equal(result.lines[2]?.at(3), "│");
  assert.equal(result.lines[2]?.at(7), "│");
  assert.equal(result.lines[2]?.at(10), "▶");
  assert.equal(hitTestNode(result, 4, 2), "node-a");
  assert.equal(hitTestNode(result, 3, 1), "node-a");
  assert.equal(hitTestNode(result, 1, 2), null);
  assert.equal(hitTestNode(result, -1, 2), null);
  assert.equal(hitTestNodeAtWorld(result, 4, 2), "node-a");
  assert.equal(result.cells[2]?.[4]?.nodeId, "node-a");
});

test("clips and pans world coordinates without changing fixed viewport dimensions", () => {
  const viewport = {
    width: 5,
    height: 3,
    x: 4,
    y: 2,
    panX: 1,
    panY: 0,
  };
  const scene: TerminalGraphScene = {
    edges: [],
    blocks: [
      {
        id: "panned",
        x: 5,
        y: 3,
        width: 6,
        height: 3,
        title: "node",
      },
    ],
  };
  const result = renderTerminalGraphCanvas(scene, viewport);

  assert.deepEqual(worldToViewportCell(viewport, { x: 5, y: 3 }), { x: 2, y: 1 });
  assert.deepEqual(viewportCellToWorld(viewport, { x: 2, y: 1 }), { x: 5, y: 3 });
  assert.equal(result.lines[1], "  ┌──");
  assert.equal(hitTestNode(result, 2, 1), "panned");
  assert.equal(hitTestNodeAtWorld(result, 5, 3), "panned");
  assert.equal(result.lines.length, 3);
  assert.ok(result.lines.every((line) => terminalCellWidth(line) === 5));
});

test("clips CJK and joined emoji text on grapheme-safe terminal cell boundaries", () => {
  assert.equal(truncateTerminalText("哲學流程", 5), "哲學…");
  assert.equal(terminalCellWidth("A👨‍👩‍👧‍👦B"), 4);

  const result = renderTerminalGraphCanvas(
    {
      edges: [],
      blocks: [
        {
          id: "wide",
          x: 0,
          y: 0,
          width: 8,
          height: 3,
          title: "哲學流程",
        },
      ],
    },
    { width: 8, height: 3 },
  );

  assert.ok(result.lines.every((line) => terminalCellWidth(line) === 8));
  assert.match(result.lines[1]!, /哲學…/);
  assert.equal(hitTestNode(result, 6, 1), "wide");
});
