import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInline,
  parseMarkdown,
  tokenizeCode,
  type Block,
  type CodeToken,
  type Inline,
} from "./markdown.js";

function flattenText(inlines: Inline[]): string {
  return inlines
    .map((node) => {
      if (node.type === "text" || node.type === "code") return node.text;
      if (node.type === "link") return flattenText(node.children);
      return flattenText(node.children);
    })
    .join("");
}

function firstBlock(source: string): Block {
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1, `expected exactly one block, got ${blocks.length}: ${JSON.stringify(blocks)}`);
  return blocks[0];
}

// ─── Headings ───────────────────────────────────────────────────────────

test("ATX heading classifies by level and strips the leading hashes", () => {
  const h1 = firstBlock("# H1");
  assert.equal(h1.type, "heading");
  assert.equal((h1 as { level: number }).level, 1);
  assert.equal(flattenText((h1 as { inlines: Inline[] }).inlines), "H1");

  const h3 = firstBlock("### Section Three");
  assert.equal((h3 as { level: number }).level, 3);
  assert.equal(flattenText((h3 as { inlines: Inline[] }).inlines), "Section Three");
});

test("a closing run of hashes on an ATX heading is stripped, not rendered", () => {
  const h2 = firstBlock("## Title ##");
  assert.equal((h2 as { level: number }).level, 2);
  assert.equal(flattenText((h2 as { inlines: Inline[] }).inlines), "Title");
});

test("a hash with no following space is not a heading at all", () => {
  const block = firstBlock("#nothashheading");
  assert.equal(block.type, "paragraph");
});

// ─── Emphasis / strikethrough ───────────────────────────────────────────

test("bold and italic produce styled spans with no literal asterisks left over", () => {
  const inlines = parseInline("**bold** and *italic*");
  assert.deepEqual(inlines, [
    { type: "bold", children: [{ type: "text", text: "bold" }] },
    { type: "text", text: " and " },
    { type: "italic", children: [{ type: "text", text: "italic" }] },
  ]);
  const flat = flattenText(inlines);
  assert.equal(flat.includes("*"), false);
});

test("underscore bold/italic behave the same as asterisk, without intraword emphasis", () => {
  const inlines = parseInline("__bold__ and _italic_ but not_this_one");
  assert.deepEqual(inlines[0], { type: "bold", children: [{ type: "text", text: "bold" }] });
  assert.deepEqual(inlines[2], { type: "italic", children: [{ type: "text", text: "italic" }] });
  const last = inlines[inlines.length - 1];
  assert.equal(last.type, "text");
  assert.match((last as { text: string }).text, /not_this_one/);
});

test("strikethrough requires a double tilde; a lone tilde is literal", () => {
  const struck = parseInline("~~gone~~");
  assert.deepEqual(struck, [{ type: "strike", children: [{ type: "text", text: "gone" }] }]);

  const lone = parseInline("a ~ b");
  assert.equal(flattenText(lone), "a ~ b");
});

test("nested emphasis: bold wrapping an inner italic span", () => {
  const inlines = parseInline("**bold *and italic* text**");
  assert.equal(inlines.length, 1);
  const bold = inlines[0];
  assert.equal(bold.type, "bold");
  const children = (bold as { children: Inline[] }).children;
  assert.equal(children[0].type, "text");
  assert.equal((children[0] as { text: string }).text, "bold ");
  assert.equal(children[1].type, "italic");
  assert.equal(flattenText([children[1]]), "and italic");
  assert.equal(children[2].type, "text");
  assert.equal((children[2] as { text: string }).text, " text");
});

test("triple-star runs nest bold outside italic, CommonMark-style", () => {
  const inlines = parseInline("***word***");
  assert.equal(inlines.length, 1);
  assert.equal(inlines[0].type, "bold");
  const inner = (inlines[0] as { children: Inline[] }).children;
  assert.equal(inner.length, 1);
  assert.equal(inner[0].type, "italic");
  assert.equal(flattenText(inner), "word");
});

// ─── The core robustness guarantee: unmatched delimiters never swallow ──

test("a lone unmatched asterisk stays literal and does not swallow the rest of the line", () => {
  const inlines = parseInline("price is * not a bullet, just text with * two lone stars");
  assert.equal(flattenText(inlines), "price is * not a bullet, just text with * two lone stars");
  // Nothing should have been promoted to bold/italic/strike/code/link.
  assert.ok(inlines.every((node) => node.type === "text"));
});

test("an opening bold marker with no closer anywhere renders as literal text", () => {
  const inlines = parseInline("this **never closes and the rest of the paragraph stays plain text");
  assert.equal(
    flattenText(inlines),
    "this **never closes and the rest of the paragraph stays plain text",
  );
  assert.ok(inlines.every((node) => node.type === "text"));
});

test("an opener skipped by a nearer match collapses to literal text instead of leaking", () => {
  // The first '*' can never find a partner (the only two remaining stars
  // pair with each other), so it must render as a literal character, not as
  // an italic span stretching across unrelated bold text.
  const inlines = parseInline("*a **b** c");
  assert.equal(flattenText(inlines), "*a b c");
  const bold = inlines.find((node) => node.type === "bold");
  assert.ok(bold);
  assert.equal(flattenText([bold as Inline]), "b");
});

// ─── Inline code ────────────────────────────────────────────────────────

test("inline code spans are opaque: emphasis markers inside are not parsed", () => {
  const inlines = parseInline("run `*not bold*` please");
  assert.deepEqual(inlines, [
    { type: "text", text: "run " },
    { type: "code", text: "*not bold*" },
    { type: "text", text: " please" },
  ]);
});

test("an unterminated backtick run is not a code span and stays literal", () => {
  const inlines = parseInline("a single ` backtick with no partner");
  assert.equal(flattenText(inlines), "a single ` backtick with no partner");
  assert.ok(inlines.every((node) => node.type === "text"));
});

// ─── Links ──────────────────────────────────────────────────────────────

test("links capture both text and href, with inner emphasis still applied", () => {
  const inlines = parseInline("see [the *docs*](https://example.com/path) now");
  const link = inlines.find((node) => node.type === "link") as Extract<Inline, { type: "link" }>;
  assert.ok(link);
  assert.equal(link.href, "https://example.com/path");
  assert.equal(flattenText(link.children), "the docs");
  assert.equal(link.children[1].type, "italic");
});

test("a malformed link (no closing paren) is left as literal brackets, not consumed", () => {
  const inlines = parseInline("this [looks like a link](but never closes");
  assert.equal(flattenText(inlines), "this [looks like a link](but never closes");
  assert.equal(inlines.some((node) => node.type === "link"), false);
});

test("links do not nest: a bracket inside link text is not itself a link", () => {
  const inlines = parseInline("[outer [inner](x)](y)");
  const links = inlines.filter((node) => node.type === "link");
  assert.equal(links.length, 1);
  assert.equal((links[0] as Extract<Inline, { type: "link" }>).href, "y");
});

// ─── Lists ──────────────────────────────────────────────────────────────

test("unordered list items are captured with nesting depth", () => {
  const block = firstBlock("- top\n  - nested\n    - deeper\n- back to top");
  assert.equal(block.type, "list");
  const items = (block as { items: Array<{ depth: number; ordered: boolean }> }).items;
  assert.deepEqual(
    items.map((i) => i.depth),
    [0, 1, 2, 0],
  );
  assert.ok(items.every((i) => !i.ordered));
});

test("ordered list items keep their written ordinal", () => {
  const block = firstBlock("3. third\n4. fourth\n5. fifth");
  assert.equal(block.type, "list");
  const items = (block as { items: Array<{ ordinal?: number }> }).items;
  assert.deepEqual(items.map((i) => i.ordinal), [3, 4, 5]);
});

test("a GFM task-list item captures its checked state", () => {
  const block = firstBlock("- [ ] todo\n- [x] done\n- [X] also done");
  const items = (block as { items: Array<{ checked?: boolean; inlines: Inline[] }> }).items;
  assert.deepEqual(
    items.map((i) => i.checked),
    [false, true, true],
  );
  assert.equal(flattenText(items[0].inlines), "todo");
});

// ─── Blockquotes ────────────────────────────────────────────────────────

test("a blockquote's content is parsed recursively as nested blocks", () => {
  const block = firstBlock("> a quoted paragraph\n> across two lines");
  assert.equal(block.type, "blockquote");
  const inner = (block as { blocks: Block[] }).blocks;
  assert.equal(inner.length, 1);
  assert.equal(inner[0].type, "paragraph");
  assert.equal(flattenText((inner[0] as { inlines: Inline[] }).inlines), "a quoted paragraph across two lines");
});

test("nested blockquotes (> >) produce a blockquote inside a blockquote", () => {
  const block = firstBlock("> outer\n> > inner");
  assert.equal(block.type, "blockquote");
  const inner = (block as { blocks: Block[] }).blocks;
  const nested = inner.find((b) => b.type === "blockquote");
  assert.ok(nested, "expected a nested blockquote block");
});

// ─── Horizontal rule ────────────────────────────────────────────────────

test("three or more of the same rule character on their own line is a horizontal rule", () => {
  assert.equal(firstBlock("---").type, "hr");
  assert.equal(firstBlock("***").type, "hr");
  assert.equal(firstBlock("- - -").type, "hr");
  assert.equal(firstBlock("___").type, "hr");
});

test("a horizontal rule line is not mistaken for a leftover bold delimiter", () => {
  const blocks = parseMarkdown("text\n\n***\n\nmore text");
  assert.equal(blocks.some((b) => b.type === "hr"), true);
  for (const b of blocks) {
    if (b.type === "paragraph") assert.equal(flattenText(b.inlines).includes("*"), false);
  }
});

// ─── Tables ─────────────────────────────────────────────────────────────

test("a GFM table parses header, alignment, and body rows", () => {
  const block = firstBlock("| A | B |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |");
  assert.equal(block.type, "table");
  const table = block as Extract<Block, { type: "table" }>;
  assert.equal(table.header.length, 2);
  assert.equal(flattenText(table.header[0]), "A");
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
  assert.equal(flattenText(table.rows[0][1]), "2");
});

test("a table row missing a delimiter row is just a paragraph, not a table", () => {
  const block = firstBlock("| A | B |\nplain text with a pipe |");
  assert.equal(block.type, "paragraph");
});

// ─── Fenced code blocks ─────────────────────────────────────────────────

test("a fenced code block captures the info string / language and content verbatim", () => {
  const block = firstBlock("```python\ndef f():\n    return 1\n```");
  assert.equal(block.type, "code");
  const code = block as Extract<Block, { type: "code" }>;
  assert.equal(code.lang, "python");
  assert.equal(code.info, "python");
  assert.equal(code.code, "def f():\n    return 1");
  assert.equal(code.unterminated, false);
});

test("a python fence colors 'def' as a keyword", () => {
  const block = firstBlock("```python\ndef f():\n    return 1\n```");
  const code = block as Extract<Block, { type: "code" }>;
  const firstLineTokens = code.lines[0];
  const defToken = firstLineTokens.find((t) => t.text === "def");
  assert.ok(defToken, "expected a 'def' token on the first line");
  assert.equal(defToken!.kind, "keyword");
});

test("an unterminated fence still captures everything to the end of input, flagged", () => {
  const block = firstBlock("```python\ndef f():\n    return 1");
  assert.equal(block.type, "code");
  const code = block as Extract<Block, { type: "code" }>;
  assert.equal(code.unterminated, true);
  assert.equal(code.code, "def f():\n    return 1");
});

test("a fenced block whose info string says diff is flagged for DiffView routing", () => {
  const block = firstBlock("```diff\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n```");
  assert.equal(block.type, "code");
  const code = block as Extract<Block, { type: "code" }>;
  assert.equal(code.isDiff, true);
  // The raw text is exposed untouched — the caller (which owns DiffView) is
  // the one that runs buildDiffPreview/<DiffView> on it, not this module.
  assert.match(code.code, /^--- a\/file\.txt/);
});

test("a fenced block whose CONTENT looks like a diff is flagged even without an info string", () => {
  const block = firstBlock("```\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n```");
  const code = block as Extract<Block, { type: "code" }>;
  assert.equal(code.isDiff, true);
});

test("an ordinary code fence is not misdetected as a diff", () => {
  const block = firstBlock("```js\nconst a = 1 - 2;\n```");
  const code = block as Extract<Block, { type: "code" }>;
  assert.equal(code.isDiff, false);
});

test("standalone tokenizeCode highlights comments, strings, and numbers generically", () => {
  const lines = tokenizeCode('const x = 42; // a comment\nconst s = "hi";', "javascript");
  assert.equal(lines.length, 2);
  const firstLine = lines[0];
  assert.ok(firstLine.some((t) => t.kind === "keyword" && t.text === "const"));
  assert.ok(firstLine.some((t) => t.kind === "number" && t.text === "42"));
  assert.ok(firstLine.some((t) => t.kind === "comment" && t.text.includes("a comment")));
  const secondLine = lines[1];
  assert.ok(secondLine.some((t) => t.kind === "string" && t.text === '"hi"'));
});

test("a multi-line block comment carries its state across lines within one fence", () => {
  const lines = tokenizeCode("/* start\nstill inside\nend */\ncode();", "typescript");
  assert.equal(lines[0].every((t) => t.kind === "comment"), true);
  assert.equal(lines[1].every((t) => t.kind === "comment"), true);
  assert.ok(lines[2].some((t) => t.kind === "comment"));
  assert.ok(lines[3].some((t) => t.kind === "text" || t.kind === "keyword"));
});

test("an unrecognized language still tokenizes generically instead of throwing", () => {
  const lines = tokenizeCode('# a comment\nvalue = "quoted"', "some-made-up-lang");
  assert.ok(lines[0].some((t) => t.kind === "comment"));
  assert.ok(lines[1].some((t) => t.kind === "string"));
});

test("json highlights its literal keywords without a general-purpose keyword list", () => {
  const lines = tokenizeCode('{"ok": true, "n": null}', "json");
  const flat = lines[0];
  assert.ok(flat.some((t) => t.kind === "keyword" && t.text === "true"));
  assert.ok(flat.some((t) => t.kind === "keyword" && t.text === "null"));
});

// ─── Adversarial robustness ─────────────────────────────────────────────

test("embedded ANSI escapes cannot survive into any inline text node", () => {
  const withEscapes = "plain \x1b[31mred\x1b[0m and \x1b]52;c;AAAA\x07 osc text";
  const inlines = parseInline(withEscapes);
  const flat = flattenText(inlines);
  assert.equal(flat.includes("\x1b"), false);
  assert.equal(flat.includes("\x07"), false);
});

test("embedded ANSI escapes cannot survive a full document parse, including inside a fence", () => {
  const source = [
    "# \x1b[1mHeading\x1b[0m",
    "",
    "para \x1b[31mtext\x1b[0m here",
    "",
    "```js",
    "\x1b[32mconst x = 1;\x1b[0m",
    "```",
  ].join("\n");
  const blocks = parseMarkdown(source);
  const serialized = JSON.stringify(blocks);
  assert.equal(serialized.includes("\\u001b"), false);
  assert.equal(serialized.includes("\x1b"), false);
});

test("CRLF and lone-CR line endings are normalized before block parsing", () => {
  const blocks = parseMarkdown("# Title\r\n\r\npara one\r\npara two\r");
  assert.equal(blocks[0].type, "heading");
  assert.equal(flattenText((blocks[0] as { inlines: Inline[] }).inlines), "Title");
  const paragraph = blocks.find((b) => b.type === "paragraph") as Extract<Block, { type: "paragraph" }>;
  assert.equal(flattenText(paragraph.inlines), "para one para two");
});

test("tabs expand instead of collapsing list/quote structure", () => {
  const block = firstBlock("- top\n\t- indented via tab");
  assert.equal(block.type, "list");
  const items = (block as { items: Array<{ depth: number }> }).items;
  assert.equal(items[0].depth, 0);
  assert.ok(items[1].depth >= 1);
});

test("a very long single line parses without hanging and preserves its text", () => {
  const long = "a".repeat(200_000) + " *b* " + "c".repeat(1000);
  const start = Date.now();
  const blocks = parseMarkdown(long);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2_000, `parsing a long line took too long: ${elapsed}ms`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
});

test("a pathological run of thousands of asterisks does not hang or crash", () => {
  const pathological = "*".repeat(50_000) + "text" + "*".repeat(50_000);
  const start = Date.now();
  const inlines = parseInline(pathological);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2_000, `pathological delimiter run took too long: ${elapsed}ms`);
  assert.ok(flattenText(inlines).includes("text"));
});

test("an over-long document is bounded rather than fully scanned, and says so", () => {
  const huge = "x".repeat(1_000_000);
  const blocks = parseMarkdown(huge);
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "paragraph");
  assert.match(flattenText((last as { inlines: Inline[] }).inlines), /truncated/);
});

test("zero-width and combining characters survive parsing without breaking emphasis", () => {
  // U+200B zero-width space, U+200D zero-width joiner (as used inside ZWJ
  // emoji families), and a combining acute accent (U+0301).
  const tricky = "**bo​ld** with é and a family \u{1F468}‍\u{1F469}‍\u{1F467}";
  const inlines = parseInline(tricky);
  assert.equal(inlines[0].type, "bold");
  assert.equal(flattenText(inlines).includes("\u{1F468}‍\u{1F469}‍\u{1F467}"), true);
});

test("a code fence whose language is missing still returns a valid (uncolored) token grid", () => {
  const block = firstBlock("```\nsome raw content\nline two\n```");
  const code = block as Extract<Block, { type: "code" }>;
  assert.equal(code.lang, "");
  assert.equal(code.lines.length, 2);
  assert.ok(code.lines.every((line) => line.every((t) => typeof t.text === "string")));
});

test("parseMarkdown never throws on an empty string or whitespace-only input", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n   "), []);
});
