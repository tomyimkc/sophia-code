import test from "node:test";
import assert from "node:assert/strict";

import { parseInline } from "../lib/markdown.js";
import { diffPreviewLineCount } from "./DiffView.js";
import {
  buildMarkdownLayout,
  estimateMarkdownLines,
  flattenInlines,
  renderMarkdownRows,
  wrapMarkdownRuns,
  type MarkdownRun,
} from "./MarkdownText.js";
import { resolveTheme } from "../lib/theme.js";

const theme = resolveTheme("dark", {} as NodeJS.ProcessEnv);

function plainRuns(text: string): MarkdownRun[] {
  return flattenInlines(parseInline(text));
}

function textOf(runs: readonly MarkdownRun[]): string {
  return runs.map((r) => r.text).join("");
}

// React.ReactElement's `props` is typed `unknown` by design (it is generic
// over the element's component type, which these plain-object assertions
// have no reason to know) — this test file only ever reads a couple of
// fields off it, so a narrow, local cast is honest about that instead of
// widening the whole test file with `any`.
function propsOf(el: { props: unknown }): Record<string, unknown> {
  return el.props as Record<string, unknown>;
}

// ─── flattenInlines ─────────────────────────────────────────────────────

test("flattenInlines merges adjacent plain-text runs and tags bold/italic/code", () => {
  const runs = plainRuns("plain **bold** and `code`");
  assert.equal(textOf(runs), "plain bold and code");
  const bold = runs.find((r) => r.text === "bold");
  assert.ok(bold?.bold);
  const code = runs.find((r) => r.text === "code");
  assert.ok(code?.code);
});

test("a link's href becomes its own trailing, dimmed run — never folded into the visible text", () => {
  const runs = flattenInlines(parseInline("see [the docs](https://example.com/x)"));
  const linkRun = runs.find((r) => r.link);
  assert.equal(linkRun?.text, "the docs");
  const hrefRun = runs.find((r) => r.href);
  assert.equal(hrefRun?.text, " (https://example.com/x)");
  assert.equal(hrefRun?.link, false, "the href note itself is not styled as link text");
});

// ─── wrapMarkdownRuns ───────────────────────────────────────────────────

test("wrapMarkdownRuns never splits a word across lines and never returns zero lines", () => {
  const runs = plainRuns("the quick brown fox jumps over the lazy dog");
  const wrapped = wrapMarkdownRuns(runs, 10);
  assert.ok(wrapped.length > 1, "should have wrapped across multiple rows at width 10");
  for (const line of wrapped) {
    const width = line.reduce((sum, r) => sum + r.text.length, 0);
    assert.ok(width <= 10, `line "${textOf(line)}" (${width} cols) must fit width 10`);
  }
  // Each wrap point WAS a space in the source — joining wrapped lines back
  // together with a single space (not "") reconstitutes the original text,
  // proving no word was dropped, duplicated, or fused across the wrap.
  assert.equal(wrapped.map(textOf).join(" "), "the quick brown fox jumps over the lazy dog");
});

test("wrapMarkdownRuns of empty runs still returns exactly one (empty) line", () => {
  const wrapped = wrapMarkdownRuns([], 40);
  assert.equal(wrapped.length, 1);
  assert.deepEqual(wrapped[0], []);
});

test("a single word wider than the whole width is hard-split, not left to overflow", () => {
  const runs = plainRuns("supercalifragilisticexpialidocious");
  const wrapped = wrapMarkdownRuns(runs, 8);
  assert.ok(wrapped.length >= 4);
  for (const line of wrapped) {
    const width = line.reduce((sum, r) => sum + r.text.length, 0);
    assert.ok(width <= 8);
  }
});

test("style boundaries do not introduce a space that was never in the source", () => {
  const runs = flattenInlines(parseInline("**bold**italic text stays glued"));
  const wrapped = wrapMarkdownRuns(runs, 200);
  assert.equal(wrapped.length, 1);
  assert.equal(textOf(wrapped[0]), "bolditalic text stays glued");
});

// ─── buildMarkdownLayout / estimateMarkdownLines: the shared-source-of-truth invariant ──

function totalRenderedRows(text: string, width: number): number {
  return renderMarkdownRows(text, width, theme).length;
}

for (const [name, text] of [
  ["a single short paragraph", "hello world"],
  ["a heading followed by a paragraph", "# Title\nSome body text here."],
  ["an unordered list", "- one\n- two\n- three"],
  ["an ordered + nested list", "1. first\n2. second\n   - nested one\n   - nested two"],
  ["a task list", "- [ ] todo\n- [x] done"],
  ["a blockquote", "> quoted line one\n> quoted line two"],
  ["a nested blockquote", "> outer\n> > inner"],
  ["a fenced code block", "```js\nconst x = 1;\nconsole.log(x);\n```"],
  ["a thematic break", "above\n\n---\n\nbelow"],
  ["a table", "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |"],
  ["long prose that must wrap", "word ".repeat(60)],
] as const) {
  test(`estimateMarkdownLines matches renderMarkdownRows's actual row count: ${name}`, () => {
    for (const width of [20, 40, 80]) {
      assert.equal(
        estimateMarkdownLines(text, width),
        totalRenderedRows(text, width),
        `row count must agree at width ${width}`,
      );
    }
  });
}

test("a unified diff fence routes to DiffView's own row count, not line-per-source-line", () => {
  const diff = [
    "```diff",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "```",
  ].join("\n");
  const units = buildMarkdownLayout(diff, 80);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "diff");
  if (units[0].kind !== "diff") return;
  assert.equal(estimateMarkdownLines(diff, 80), diffPreviewLineCount(units[0].preview));
  // The diff embed is ONE Ink element (a Box wrapping DiffView) that itself
  // paints `diffPreviewLineCount` rows internally — array length here is
  // rightly 1, not 6; MessageList's height math relies on
  // `estimateMarkdownLines`, checked above, not on this array's length.
  const rendered = renderMarkdownRows(diff, 80, theme);
  assert.equal(rendered.length, 1);
  // Splitting a clip across the embedded DiffView must hand it the
  // REMAINING clip, the same way ToolCard splits topClip/bottomClip across
  // its own header rows and embedded DiffView.
  const clippedRendered = renderMarkdownRows(diff, 80, theme, { topClip: 2, bottomClip: 1 });
  assert.equal(clippedRendered.length, 1);
  const diffViewProps = propsOf(propsOf(clippedRendered[0]).children as { props: unknown });
  assert.equal(diffViewProps.topClip, 2);
  assert.equal(diffViewProps.bottomClip, 1);
});

test("a diff fence nested inside a blockquote falls back to plain code rows (documented scope limit)", () => {
  const quoted = "> ```diff\n> --- a/f.ts\n> +++ b/f.ts\n> @@ -1 +1 @@\n> -old\n> +new\n> ```";
  const units = buildMarkdownLayout(quoted, 80);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "rows");
  if (units[0].kind !== "rows") return;
  assert.ok(units[0].rows.every((row) => row.kind === "code"));
  assert.ok(units[0].rows.every((row) => row.prefix.startsWith("> ")));
});

// ─── list/quote prefixes ────────────────────────────────────────────────

test("unordered, ordered and task list items each get a distinct, legible marker", () => {
  const unordered = buildMarkdownLayout("- item", 80)[0];
  const ordered = buildMarkdownLayout("3. item", 80)[0];
  const task = buildMarkdownLayout("- [x] item", 80)[0];
  assert.equal(unordered.kind, "rows");
  assert.equal(ordered.kind, "rows");
  assert.equal(task.kind, "rows");
  if (unordered.kind !== "rows" || ordered.kind !== "rows" || task.kind !== "rows") return;
  assert.match(unordered.rows[0].prefix, /•/);
  assert.equal(ordered.rows[0].prefix, "3. ");
  assert.equal(task.rows[0].prefix, "☑ ");
});

test("a nested blockquote composes one gutter per nesting level", () => {
  const units = buildMarkdownLayout("> outer\n> > inner", 80);
  assert.equal(units.length, 1);
  const unit = units[0];
  assert.equal(unit.kind, "rows");
  if (unit.kind !== "rows") return;
  assert.equal(unit.rows[0].prefix, "> ");
  assert.equal(unit.rows[1].prefix, "> > ");
});

// ─── table layout always fits the width budget ─────────────────────────

test("a table's rendered lines never exceed the requested width, even with long cell content", () => {
  const wide = "| name | description |\n| - | - |\n| x | " + "a very long description ".repeat(10) + " |";
  for (const width of [24, 40, 80]) {
    const units = buildMarkdownLayout(wide, width);
    const unit = units[0];
    assert.equal(unit.kind, "rows");
    if (unit.kind !== "rows") continue;
    for (const row of unit.rows) {
      for (const run of row.runs) {
        assert.ok(run.text.length <= width, `"${run.text}" (${run.text.length}) must fit width ${width}`);
      }
    }
  }
});

// ─── rendering: clipping and accessibility ──────────────────────────────

test("renderMarkdownRows honors topClip/bottomClip like ToolCard/DiffView's row-range contract", () => {
  const text = Array.from({ length: 10 }, (_, i) => `- item ${i}`).join("\n");
  const width = 40;
  const total = estimateMarkdownLines(text, width);
  assert.equal(total, 10);
  const clipped = renderMarkdownRows(text, width, theme, { topClip: 3, bottomClip: 2 });
  assert.equal(clipped.length, total - 3 - 2);
});

test("matrix rendering mounts wrapped markdown rows only when the frontier reaches them", () => {
  const text = "alpha beta gamma delta epsilon zeta eta theta";
  const width = 16;
  const total = estimateMarkdownLines(text, width);
  assert.ok(total > 1);

  const firstFrame = renderMarkdownRows(text, width, theme, {
    matrix: {
      previousText: "",
      frame: 0,
      churnFrame: 1,
    },
  });
  assert.equal(
    firstFrame.length,
    1,
    "future wrapped rows must not be mounted before the first line fills",
  );

  const settled = renderMarkdownRows(text, width, theme, {
    matrix: {
      previousText: "",
      frame: 10_000,
      churnFrame: 10_000,
    },
  });
  assert.equal(settled.length, total);
});

test("a thematic break renders a short spoken form in screen-reader mode, without changing row count", () => {
  const text = "above\n\n---\n\nbelow";
  const width = 80;
  const normal = renderMarkdownRows(text, width, theme, { screenReader: false });
  const accessible = renderMarkdownRows(text, width, theme, { screenReader: true });
  assert.equal(normal.length, accessible.length, "screen-reader mode must not change the row count");
  const hrNormal = normal.find((el) => {
    const children = propsOf(el).children;
    return typeof children === "string" && children.startsWith("─");
  });
  const hrAccessible = accessible.find((el) => propsOf(el).children === "---");
  assert.ok(hrNormal, "graphical mode draws a full divider line");
  assert.ok(hrAccessible, "screen-reader mode says a short literal '---' instead of a wall of box-drawing glyphs");
});
