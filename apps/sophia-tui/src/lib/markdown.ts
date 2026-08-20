/**
 * Dependency-free markdown -> structured-block parser for the transcript.
 *
 * This module never touches Ink/React and never prints anything itself: it
 * turns model-authored markdown text into a plain data tree a component maps
 * to terminal rows. Keeping it pure means every case here — including every
 * adversarial one — is a `node:test` assertion on a plain object, not a
 * screenshot of a render.
 *
 * Why not a "real" CommonMark implementation: a spec-complete parser is
 * hundreds of production rules aimed at HTML output (raw HTML blocks, link
 * reference definitions, footnotes). None of that has a terminal rendering.
 * What matters here is the 20% of the spec assistant replies actually use
 * (headings, emphasis, lists, quotes, fences, links, tables) parsed in a
 * single pass that cannot be tricked into quadratic work or into leaking a
 * raw control sequence — this file optimizes for exactly that, and says so
 * inline wherever the behaviour intentionally diverges from CommonMark.
 */
import { sanitizeTerminalText } from "./chatLayout.js";

// A streamed reply is re-parsed on every frame while it grows, so an
// unbounded single line (or an unbounded document) must not turn into
// unbounded per-frame work. This mirrors the scan caps toolOutput.ts/DiffView.tsx
// already use for the same reason — bound the work, never crash, say so.
const MAX_SOURCE_LENGTH = 256 * 1024;

// ─── Inline model ───────────────────────────────────────────────────────

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

// ─── Block model ────────────────────────────────────────────────────────

export interface ListItem {
  /** 0 = top-level item; each extra 2-space indent step adds 1. */
  depth: number;
  ordered: boolean;
  /** Only set when `ordered` — the number as written (`3.` -> 3). */
  ordinal?: number;
  /** Set only for a GFM task-list item (`- [ ]` / `- [x]`). */
  checked?: boolean;
  inlines: Inline[];
}

export type CodeTokenKind = "keyword" | "string" | "comment" | "number" | "text";

export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; items: ListItem[] }
  | { type: "blockquote"; blocks: Block[] }
  | {
    type: "code";
    /** Raw fence info string, e.g. `python foo=bar` — unparsed, for callers that want it verbatim. */
    info: string;
    /** First whitespace-delimited word of the info string, lowercased (`"python"`). */
    lang: string;
    /** Fence content, without a trailing newline. */
    code: string;
    /**
     * Per-line heuristic syntax highlighting tokens. Always present (possibly
     * all `text`-kind for an unrecognized language) so a caller never has to
     * branch on whether highlighting ran.
     */
    lines: CodeToken[][];
    /**
     * True when the fence is very likely a unified diff (by info string or by
     * content shape). The caller — not this module — owns diff rendering
     * (DiffView.tsx already does that); this only flags the fence so the
     * caller can route `code` there instead of the syntax-highlighted path.
     */
    isDiff: boolean;
    /** The fence never found its closing marker before the input ended. */
    unterminated: boolean;
  }
  | { type: "hr" }
  | {
    type: "table";
    header: Inline[][];
    align: Array<"left" | "right" | "center" | null>;
    rows: Inline[][][];
  };

// ─── Source normalization ───────────────────────────────────────────────

/**
 * Code-point-safe prefix of `input` within `limit` UTF-16 units.
 *
 * Slicing on a raw index can land inside a surrogate pair, turning a valid
 * emoji into a lone low/high surrogate that renders as a broken glyph — the
 * same hazard toolOutput.ts's `clipInput` guards against for tool output.
 */
function clipSource(input: string, limit: number): string {
  if (input.length <= limit) return input;
  let end = Math.max(0, limit);
  const code = input.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return input.slice(0, end);
}

/**
 * CRLF and lone-CR line endings both collapse to `\n` before anything else
 * runs. A model that streams from a Windows-hosted backend (or echoes a
 * pasted Windows file inside a fence) would otherwise leave a trailing `\r`
 * on every line, which some terminals render as an extra blank cursor return.
 */
function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

/**
 * Tabs expand to the next 4-column stop, counted in raw characters (not
 * display width) — the same rule CommonMark itself uses for block-structure
 * indentation, so a tab-indented list/quote nests the same depth a
 * space-indented one would.
 */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const spaces = 4 - (col % 4);
      out += " ".repeat(spaces);
      col += spaces;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/**
 * Strip ANSI/C0/C1 control sequences from raw markdown text before a single
 * character of it is classified. This text originates from a model; without
 * this pass a reply that (accidentally or adversarially) contains a raw
 * escape sequence would ride through every downstream `text` node and paint
 * directly onto the user's terminal — reusing chatLayout's sanitizer, which
 * this codebase already treats as the one place that decision is made.
 */
function sanitizeSource(input: string): string {
  return sanitizeTerminalText(input, true);
}

// ─── Inline parsing ─────────────────────────────────────────────────────

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && ASCII_PUNCTUATION.test(ch);
}

/** One `*`/`_`/`~` run found while scanning inline text. */
interface DelimRun {
  char: "*" | "_" | "~";
  /** Index into `flatText` where the run's literal characters live. */
  start: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

/**
 * CommonMark's left/right-flanking rule, simplified to the ASCII punctuation
 * set this terminal renderer cares about. `_` additionally forbids
 * intraword emphasis (`foo_bar_baz` must not italicize "bar") — `*` has no
 * such restriction, matching the spec.
 */
function flankingRun(char: string, before: string | undefined, after: string | undefined): { canOpen: boolean; canClose: boolean } {
  const leftFlanking = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const rightFlanking = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  if (char === "_") {
    return {
      canOpen: leftFlanking && (!rightFlanking || isPunctuation(before)),
      canClose: rightFlanking && (!leftFlanking || isPunctuation(after)),
    };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

/** A flat run of literal text with `*`/`_`/`~` delimiter runs marked out. */
interface InlineScan {
  text: string;
  runs: DelimRun[];
}

function scanDelimiters(text: string): InlineScan {
  const runs: DelimRun[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "*" || ch === "_" || ch === "~") {
      let j = i + 1;
      while (j < text.length && text[j] === ch) j += 1;
      const before = i > 0 ? text[i - 1] : undefined;
      const after = j < text.length ? text[j] : undefined;
      const { canOpen, canClose } = flankingRun(ch, before, after);
      runs.push({ char: ch, start: i, length: j - i, canOpen, canClose });
      i = j;
    } else {
      i += 1;
    }
  }
  return { text, runs };
}

interface OpenDelim {
  run: DelimRun;
  /** How many characters of this run's markers are still unconsumed. */
  remaining: number;
  /** Index into the growing `pieces` array of this opener's placeholder. */
  pieceIndex: number;
}

type Piece =
  | { kind: "text"; text: string }
  | { kind: "open"; run: DelimRun }
  | { kind: "node"; node: Inline };

const NODE_TYPE_FOR: Record<string, "bold" | "italic" | "strike"> = {
  "*2": "bold",
  "_2": "bold",
  "*1": "italic",
  "_1": "italic",
  "~2": "strike",
};

// A run of thousands of identical marker characters (or thousands of
// distinct never-closed openers) is not real prose — it is either garbage or
// an attempt to make this parser build a tower of nested nodes thousands of
// levels deep, which then blows the call stack of anything that walks the
// tree recursively (the renderer, JSON.stringify, this file's own tests).
// Refusing to OPEN past this many simultaneously-unclosed delimiters bounds
// nesting depth regardless of how the adversarial input is shaped (one huge
// run, or many small ones) — legitimate markdown never nests emphasis this
// deep, so the cap is invisible to real replies.
const MAX_OPEN_DELIMITERS = 32;

/**
 * Emphasis/strikethrough over a flat span of text, using a delimiter stack —
 * the same shape CommonMark's own algorithm uses, simplified to two marker
 * widths (1 = italic, 2 = bold; `~` only ever pairs as 2 = strike). A closer
 * matches the NEAREST compatible opener already on the stack (by character;
 * its width is then clamped to whatever both sides actually have left), and
 * anything skipped in between (an opener that never found its own partner)
 * is emitted as the literal characters it always was — which is exactly the
 * guarantee that keeps a lone, unmatched `*` from swallowing the rest of a
 * line: it never becomes a delimiter that "waits" past the paragraph, it is
 * just text.
 */
function parseEmphasis(rawText: string): Inline[] {
  const { text, runs } = scanDelimiters(rawText);
  const pieces: Piece[] = [];
  const stack: OpenDelim[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const last = pieces[pieces.length - 1];
    if (last && last.kind === "text") last.text += value;
    else pieces.push({ kind: "text", text: value });
  };

  for (const run of runs) {
    pushText(text.slice(cursor, run.start));
    cursor = run.start + run.length;
    let remaining = run.length;
    const isTilde = run.char === "~";

    while (remaining > 0) {
      // `~` only ever closes/opens in pairs; a leftover single tilde (an odd
      // run, or the last tilde of one) is literal — there is no "italic
      // tilde" in this renderer's vocabulary.
      const provisional = isTilde ? (remaining >= 2 ? 2 : 0) : Math.min(2, remaining);
      if (provisional === 0) {
        pushText("~".repeat(remaining));
        remaining = 0;
        break;
      }

      let matchedIndex = -1;
      if (run.canClose) {
        for (let k = stack.length - 1; k >= 0; k -= 1) {
          const candidate = stack[k];
          if (candidate.run.char !== run.char) continue;
          if (isTilde && candidate.remaining < 2) continue;
          matchedIndex = k;
          break;
        }
      }

      if (matchedIndex >= 0) {
        const opener = stack[matchedIndex];
        // The opener may have more or less width left than this closer
        // offers (e.g. a `**` opener meeting a lone `*` closer) — only the
        // shared amount actually closes; CommonMark resolves the same case
        // the same way (`**a*` closes as italic, leaving one `*` still open).
        const width = isTilde ? 2 : Math.min(provisional, opener.remaining);
        // Every opener ABOVE the match never found its own partner: it
        // collapses to plain literal text instead of staying a live
        // delimiter that could later eat unrelated content.
        for (let k = stack.length - 1; k > matchedIndex; k -= 1) {
          const dead = stack.pop()!;
          const marker = dead.run.char.repeat(dead.remaining);
          pieces[dead.pieceIndex] = { kind: "text", text: marker };
        }
        stack.pop(); // remove the matched opener itself; it's replaced below

        // Everything pushed AFTER the opener's own placeholder is its
        // content; the placeholder itself (at `pieceIndex`) is replaced
        // in place by the finished node, not swept up as its own child.
        const childPieces = pieces.splice(opener.pieceIndex + 1);
        const nodeKind = NODE_TYPE_FOR[`${run.char}${width}`];
        const node: Inline = {
          type: nodeKind,
          children: piecesToInlines(childPieces),
        };
        pieces[opener.pieceIndex] = { kind: "node", node };
        opener.remaining -= width;
        if (opener.remaining > 0) {
          // Leftover width from the opener's own run (e.g. `***x**` leaves a
          // single `*` behind) re-enters the stack as a fresh, still-open
          // delimiter rather than being lost.
          const reopened: DelimRun = { ...opener.run, length: opener.remaining };
          pieces.push({ kind: "open", run: reopened });
          stack.push({ run: reopened, remaining: opener.remaining, pieceIndex: pieces.length - 1 });
        }
        remaining -= width;
        continue;
      }

      if (run.canOpen && stack.length < MAX_OPEN_DELIMITERS) {
        const marker: DelimRun = { ...run, length: provisional };
        pieces.push({ kind: "open", run: marker });
        stack.push({ run: marker, remaining: provisional, pieceIndex: pieces.length - 1 });
        remaining -= provisional;
        continue;
      }

      // Neither closable against anything open, nor allowed to open another
      // (cap reached), nor a valid opener at all: it was always just
      // punctuation that happens to look like a delimiter.
      pushText(run.char.repeat(provisional));
      remaining -= provisional;
    }
  }
  pushText(text.slice(cursor));

  // Anything still on the stack at the end of the span never closed —
  // literal text, per the same rule.
  while (stack.length) {
    const dead = stack.pop()!;
    pieces[dead.pieceIndex] = { kind: "text", text: dead.run.char.repeat(dead.remaining) };
  }

  return piecesToInlines(pieces);
}

function piecesToInlines(pieces: Piece[]): Inline[] {
  const out: Inline[] = [];
  for (const piece of pieces) {
    if (piece.kind === "node") {
      out.push(piece.node);
    } else if (piece.kind === "open") {
      // Should already have been resolved to text by the caller; defensive
      // fallback keeps this function total instead of dropping content.
      pushMergedText(out, piece.run.char.repeat(piece.run.length));
    } else if (piece.text) {
      pushMergedText(out, piece.text);
    }
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

function pushMergedText(out: Inline[], value: string) {
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += value;
  else out.push({ type: "text", text: value });
}

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Backslash-escapes (`\*`, `\[`, ...) and inline code spans are resolved
 * before emphasis/link scanning ever sees the text — a backtick inside a
 * bold run, or an asterisk inside a code span, must never participate in
 * delimiter matching.
 */
interface Segment {
  kind: "text" | "code";
  text: string;
}

function splitCodeSpans(input: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) segments.push({ kind: "text", text: input.slice(textStart, end) });
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length && ESCAPABLE.test(input[i + 1])) {
      // Escapes are resolved later, per-text-segment, so they stay `text` here.
      i += 2;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (j < input.length && input[j] === "`") j += 1;
      const tickLen = j - i;
      const closeAt = findClosingTicks(input, j, tickLen);
      if (closeAt === -1) {
        // No matching close run anywhere: the backticks were never a code
        // span to begin with — leave them as ordinary text and keep scanning.
        i = j;
        continue;
      }
      flushText(i);
      let content = input.slice(j, closeAt);
      // A single leading+trailing space is stripped when the content isn't
      // ALL spaces, so `` `` `code` `` `` (spaced to allow a literal
      // backtick inside) doesn't render two extra spaces around plain code.
      if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
        content = content.slice(1, -1);
      }
      segments.push({ kind: "code", text: content.replace(/\n/g, " ") });
      i = closeAt + tickLen;
      textStart = i;
      continue;
    }
    i += 1;
  }
  flushText(input.length);
  return segments;
}

function findClosingTicks(input: string, from: number, tickLen: number): number {
  let i = from;
  while (i < input.length) {
    if (input[i] === "`") {
      let j = i;
      while (j < input.length && input[j] === "`") j += 1;
      if (j - i === tickLen) return i;
      i = j;
    } else {
      i += 1;
    }
  }
  return -1;
}

function unescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      out += text[i + 1];
      i += 1;
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * `[text](href)` links. Link text is parsed recursively for emphasis (and
 * further code spans), but never for a nested link — CommonMark forbids
 * links-in-links, and honoring that keeps `[a [b](c) d](e)` from producing
 * two overlapping hrefs over the same words.
 */
function parseLinksAndEmphasis(input: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plainStart = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) out.push(...parseEmphasis(unescape(input.slice(plainStart, end))));
  };
  while (i < input.length) {
    if (input[i] === "\\" && i + 1 < input.length && ESCAPABLE.test(input[i + 1])) {
      i += 2;
      continue;
    }
    if (input[i] === "[") {
      const closeBracket = findLinkClose(input, i + 1);
      if (closeBracket !== -1 && input[closeBracket + 1] === "(") {
        const closeParen = findParenClose(input, closeBracket + 2);
        if (closeParen !== -1) {
          flushPlain(i);
          const label = input.slice(i + 1, closeBracket);
          const hrefRaw = input.slice(closeBracket + 2, closeParen);
          const href = unescape(hrefRaw.split(/\s+/, 1)[0] || "");
          out.push({ type: "link", href, children: parseEmphasis(unescape(label)) });
          i = closeParen + 1;
          plainStart = i;
          continue;
        }
      }
    }
    i += 1;
  }
  flushPlain(input.length);
  return out.length ? out : [{ type: "text", text: "" }];
}

/** Nearest unescaped `]` that isn't itself opening a nested `[...]`. */
function findLinkClose(input: string, from: number): number {
  let depth = 0;
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === "\\") {
      i += 1;
      continue;
    }
    if (input[i] === "[") depth += 1;
    else if (input[i] === "]") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function findParenClose(input: string, from: number): number {
  let depth = 0;
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === "\\") {
      i += 1;
      continue;
    }
    if (input[i] === "(") depth += 1;
    else if (input[i] === ")") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Full inline parse: code spans first (opaque), then links, then emphasis.
 *
 * Sanitized here too, not only in `parseMarkdown`'s document entry point —
 * this function is exported and a caller may feed it a raw fragment
 * directly (a streamed partial line, a single list-item's text) without
 * ever going through the block-level pass, and an ANSI escape must never
 * reach a `text`/`code` node from ANY entry point into this module.
 */
export function parseInline(text: string): Inline[] {
  const segments = splitCodeSpans(sanitizeSource(normalizeNewlines(String(text ?? ""))));
  const out: Inline[] = [];
  for (const segment of segments) {
    if (segment.kind === "code") {
      out.push({ type: "code", text: segment.text });
    } else {
      out.push(...parseLinksAndEmphasis(segment.text));
    }
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

// ─── Diff detection ─────────────────────────────────────────────────────

/**
 * Cheap unified-diff signature check for a fenced block, independent of
 * DiffView.tsx's own `isUnifiedDiff` — this module stays dependency-free
 * (no Ink/React import chain) and DiffView.tsx remains the single place that
 * actually renders a diff. A caller sees `isDiff` and hands `code` to that
 * existing renderer instead of the syntax-highlighted code path; this
 * function's only job is the routing signal.
 */
function looksLikeDiff(info: string, code: string): boolean {
  const lang = info.trim().split(/\s+/, 1)[0]?.toLowerCase() || "";
  if (lang === "diff" || lang === "patch") return true;
  if (/(^|\n)diff --git /.test(code)) return true;
  if (/(^|\n)@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(code)) return true;
  return /(^|\n)--- [^\n]*\n\+\+\+ [^\n]*/.test(code);
}

// ─── Code tokenizer (heuristic, generic) ───────────────────────────────

/**
 * Heuristic, generic syntax highlighting.
 *
 * This is NOT a grammar per language — it is one small per-line scanner that
 * recognizes the vocabulary shared by most curly-brace and script languages
 * (line/block comments, quoted strings, decimal numbers, a curated keyword
 * list) and colors those consistently. Anything it doesn't recognize (an
 * unlisted language, or content inside a language it can't confidently
 * scan) still comes back as valid `text`-kind tokens — never wrong syntax
 * highlighting, at worst none.
 *
 * State (an open block comment or triple-quoted string) carries across
 * lines WITHIN one fenced block, because those genuinely span lines in real
 * source; it never carries across separate `tokenizeCode` calls.
 */
interface LangConfig {
  keywords: ReadonlySet<string>;
  lineComments: readonly string[];
  blockComment?: readonly [string, string];
  quotes: readonly string[];
  tripleQuotes?: readonly string[];
}

const JS_KEYWORDS = new Set([
  "await", "async", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "interface", "let", "new", "null",
  "of", "return", "static", "super", "switch", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "var", "void", "while", "yield", "enum", "implements",
  "namespace", "readonly", "private", "public", "protected", "as", "from",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "false", "finally", "for", "from", "global", "if", "import",
  "in", "is", "lambda", "none", "nonlocal", "not", "or", "pass", "raise", "return", "self",
  "true", "try", "while", "with", "yield",
]);

const SH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
  "function", "in", "return", "local", "export", "readonly", "shift", "break", "continue",
  "echo", "exit", "set", "unset", "trap",
]);

const LANG_CONFIGS: Record<string, LangConfig> = {
  javascript: { keywords: JS_KEYWORDS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] },
  typescript: { keywords: JS_KEYWORDS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] },
  jsx: { keywords: JS_KEYWORDS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] },
  tsx: { keywords: JS_KEYWORDS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] },
  json: { keywords: new Set(["true", "false", "null"]), lineComments: [], quotes: ['"'] },
  python: {
    keywords: PY_KEYWORDS,
    lineComments: ["#"],
    quotes: ['"', "'"],
    tripleQuotes: ['"""', "'''"],
  },
  bash: { keywords: SH_KEYWORDS, lineComments: ["#"], quotes: ['"', "'"] },
  shell: { keywords: SH_KEYWORDS, lineComments: ["#"], quotes: ['"', "'"] },
  sh: { keywords: SH_KEYWORDS, lineComments: ["#"], quotes: ['"', "'"] },
};

const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  py3: "python",
  zsh: "shell",
};

// Any language this scanner doesn't have a curated keyword list for still
// gets generic comment/string/number recognition — "generic" is the point,
// not "off". Only the keyword set is empty.
const GENERIC_CONFIG: LangConfig = {
  keywords: new Set(),
  lineComments: ["//", "#"],
  quotes: ['"', "'", "`"],
};

function resolveLangConfig(lang: string): LangConfig {
  const key = LANG_ALIASES[lang] || lang;
  return LANG_CONFIGS[key] || GENERIC_CONFIG;
}

interface TokenizerState {
  inBlockComment: boolean;
  inTripleQuote: string | null;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function tokenizeLine(line: string, config: LangConfig, state: TokenizerState): CodeToken[] {
  const tokens: CodeToken[] = [];
  const push = (kind: CodeTokenKind, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };

  let i = 0;
  const n = line.length;

  if (state.inTripleQuote) {
    const close = line.indexOf(state.inTripleQuote);
    if (close === -1) {
      push("string", line);
      return tokens;
    }
    push("string", line.slice(0, close + state.inTripleQuote.length));
    i = close + state.inTripleQuote.length;
    state.inTripleQuote = null;
  } else if (state.inBlockComment && config.blockComment) {
    const close = line.indexOf(config.blockComment[1]);
    if (close === -1) {
      push("comment", line);
      return tokens;
    }
    push("comment", line.slice(0, close + config.blockComment[1].length));
    i = close + config.blockComment[1].length;
    state.inBlockComment = false;
  }

  while (i < n) {
    const rest = line.slice(i);

    const lineComment = config.lineComments.find((marker) => rest.startsWith(marker));
    if (lineComment) {
      push("comment", rest);
      i = n;
      continue;
    }

    if (config.blockComment && rest.startsWith(config.blockComment[0])) {
      const close = line.indexOf(config.blockComment[1], i + config.blockComment[0].length);
      if (close === -1) {
        push("comment", rest);
        state.inBlockComment = true;
        i = n;
        continue;
      }
      push("comment", line.slice(i, close + config.blockComment[1].length));
      i = close + config.blockComment[1].length;
      continue;
    }

    const tripleQuote = config.tripleQuotes?.find((q) => rest.startsWith(q));
    if (tripleQuote) {
      const close = line.indexOf(tripleQuote, i + tripleQuote.length);
      if (close === -1) {
        push("string", rest);
        state.inTripleQuote = tripleQuote;
        i = n;
        continue;
      }
      push("string", line.slice(i, close + tripleQuote.length));
      i = close + tripleQuote.length;
      continue;
    }

    const quote = config.quotes.find((q) => line[i] === q);
    if (quote) {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      push("string", line.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }

    const ch = line[i];
    if (isDigit(ch) || (ch === "." && isDigit(line[i + 1] || ""))) {
      let j = i;
      while (j < n && /[0-9a-fA-Fx._]/.test(line[j])) j += 1;
      push("number", line.slice(i, j));
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(line[j])) j += 1;
      const word = line.slice(i, j);
      push(config.keywords.has(word.toLowerCase()) ? "keyword" : "text", word);
      i = j;
      continue;
    }

    push("text", ch);
    i += 1;
  }

  return tokens;
}

/**
 * Highlight every line of a fenced code block. Exported standalone (not only
 * reachable via `parseMarkdown`) so a raw tool-output code block can reuse
 * the same heuristic highlighting outside a markdown document.
 */
export function tokenizeCode(code: string, lang: string): CodeToken[][] {
  const config = resolveLangConfig(lang.trim().toLowerCase());
  const state: TokenizerState = { inBlockComment: false, inTripleQuote: null };
  return code.split("\n").map((line) => tokenizeLine(line, config, state));
}

// ─── Block parsing ──────────────────────────────────────────────────────

function isThematicBreak(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  const first = trimmed[0];
  if (first !== "-" && first !== "_" && first !== "*") return false;
  let markers = 0;
  for (const ch of trimmed) {
    if (ch === " ") continue;
    if (ch !== first) return false;
    markers += 1;
  }
  return markers >= 3;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const ATX_TRAILING_HASHES = /(^|\s)#+\s*$/;

function parseAtxHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const match = ATX_HEADING.exec(line);
  if (!match) return null;
  const level = match[1].length as 1 | 2 | 3 | 4 | 5 | 6;
  let text = match[2] || "";
  text = text.replace(ATX_TRAILING_HASHES, "$1").trimEnd();
  return { level, text };
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;

const LIST_MARKER = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const TASK_MARKER = /^\[([ xX])\]\s+(.*)$/;

const BLOCKQUOTE_LINE = /^ {0,3}> ?(.*)$/;

function splitLines(source: string): string[] {
  return source.split("\n");
}

/** True when `line` has no non-space content. */
function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += trimmed[i];
  }
  cells.push(current.trim());
  return cells;
}

const TABLE_DELIMITER_ROW = /^\s*:?-{1,}:?\s*$/;

function isTableDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => TABLE_DELIMITER_ROW.test(cell));
}

function delimiterAlign(cell: string): "left" | "right" | "center" | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/**
 * Parse a markdown document into a flat list of top-level blocks.
 *
 * Blocks are checked in the same priority order CommonMark's block phase
 * uses (fence > thematic break > heading > blockquote > list > table >
 * paragraph) so, e.g., a bare `---` is a divider rather than a 1-item list
 * or a leftover bold delimiter.
 */
export function parseMarkdown(source: string): Block[] {
  const bounded = clipSource(String(source ?? ""), MAX_SOURCE_LENGTH);
  const truncated = bounded.length < String(source ?? "").length;
  const normalized = sanitizeSource(normalizeNewlines(bounded));
  const lines = splitLines(normalized).map(expandTabs);
  const blocks = parseBlocks(lines);
  if (truncated) {
    blocks.push({
      type: "paragraph",
      inlines: [{ type: "text", text: "… message truncated (too long to render in full)" }],
    });
  }
  return blocks;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fenceMatch = FENCE_OPEN.exec(line);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const info = fenceMatch[3] || "";
      const bodyLines: string[] = [];
      let j = i + 1;
      let unterminated = true;
      for (; j < n; j += 1) {
        const closeMatch = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]);
        if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
          unterminated = false;
          j += 1;
          break;
        }
        bodyLines.push(lines[j]);
      }
      const code = bodyLines.join("\n");
      const lang = info.trim().split(/\s+/, 1)[0]?.toLowerCase() || "";
      blocks.push({
        type: "code",
        info,
        lang,
        code,
        lines: tokenizeCode(code, lang),
        isDiff: looksLikeDiff(info, code),
        unterminated,
      });
      i = j;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = parseAtxHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, inlines: parseInline(heading.text) });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE_LINE.test(line)) {
      const quoted: string[] = [];
      let j = i;
      for (; j < n; j += 1) {
        const match = BLOCKQUOTE_LINE.exec(lines[j]);
        if (!match) {
          // A blank line ends the quote unless the next non-blank line is
          // itself still quoted (a "loose" multi-paragraph blockquote).
          if (isBlank(lines[j]) && j + 1 < n && BLOCKQUOTE_LINE.test(lines[j + 1])) {
            quoted.push("");
            continue;
          }
          break;
        }
        quoted.push(match[1]);
      }
      blocks.push({ type: "blockquote", blocks: parseBlocks(quoted) });
      i = j;
      continue;
    }

    const table = tryParseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    if (LIST_MARKER.test(line)) {
      const items: ListItem[] = [];
      let j = i;
      while (j < n) {
        if (isBlank(lines[j])) {
          // A blank line continues the SAME list only if another item
          // follows; otherwise it ends the list here (the blank itself is
          // consumed by the outer loop's own blank-line skip).
          if (j + 1 < n && LIST_MARKER.test(lines[j + 1])) {
            j += 1;
            continue;
          }
          break;
        }
        const match = LIST_MARKER.exec(lines[j]);
        if (!match) break;
        const [, indent, bullet, ordinalStr, rest] = match;
        const depth = Math.min(6, Math.floor(indent.length / 2));
        const ordered = bullet === undefined;
        const task = TASK_MARKER.exec(rest);
        const itemText = task ? task[2] : rest;
        items.push({
          depth,
          ordered,
          ...(ordered ? { ordinal: Number(ordinalStr) } : {}),
          ...(task ? { checked: task[1].toLowerCase() === "x" } : {}),
          inlines: parseInline(itemText),
        });
        j += 1;
      }
      blocks.push({ type: "list", items });
      i = j;
      continue;
    }

    // Paragraph: swallow contiguous plain lines, reflowing them into one
    // block of prose. A line that would itself start a different block type
    // ends the paragraph instead of being absorbed into it.
    const paragraphLines: string[] = [line];
    let j = i + 1;
    while (
      j < n &&
      !isBlank(lines[j]) &&
      !FENCE_OPEN.test(lines[j]) &&
      !isThematicBreak(lines[j]) &&
      !parseAtxHeading(lines[j]) &&
      !BLOCKQUOTE_LINE.test(lines[j]) &&
      !LIST_MARKER.test(lines[j])
    ) {
      paragraphLines.push(lines[j]);
      j += 1;
    }
    blocks.push({ type: "paragraph", inlines: parseInline(paragraphLines.join(" ").trim()) });
    i = j;
  }

  return blocks;
}

function tryParseTable(lines: string[], start: number): { block: Block; next: number } | null {
  const headerLine = lines[start];
  if (!headerLine.includes("|")) return null;
  const delimiterLine = lines[start + 1];
  if (delimiterLine === undefined || !isTableDelimiterRow(delimiterLine)) return null;

  const headerCells = splitTableRow(headerLine);
  const align = splitTableRow(delimiterLine).map(delimiterAlign);
  const rows: Inline[][][] = [];
  let j = start + 2;
  for (; j < lines.length; j += 1) {
    if (isBlank(lines[j]) || !lines[j].includes("|")) break;
    rows.push(splitTableRow(lines[j]).map((cell) => parseInline(cell)));
  }

  return {
    block: {
      type: "table",
      header: headerCells.map((cell) => parseInline(cell)),
      align,
      rows,
    },
    next: j,
  };
}
