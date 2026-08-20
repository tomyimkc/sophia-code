import { graphemes } from "./textWidth.js";
import { type ComposerState, reduceComposer } from "./composer.js";

export type GhostHintSource = "slash" | "attachment" | "history" | "custom";
export type GhostHintScope = "document" | "line" | "token";

export interface GhostHintCandidate {
  /** Complete candidate text for the selected scope, not merely the suffix. */
  value: string;
  source?: GhostHintSource;
  /** Higher wins. Defaults to zero. */
  priority?: number;
  /** Exact-case matching is the safe default. */
  caseSensitive?: boolean;
  /** Defaults to document. */
  scope?: GhostHintScope;
}

export interface GhostHint {
  value: string;
  suffix: string;
  source: GhostHintSource;
  priority: number;
  scope: GhostHintScope;
  /** Grapheme offset where the matched query starts. */
  replaceFrom: number;
  /** Grapheme offset where the suffix should be inserted. */
  insertAt: number;
}

function sourceRank(source: GhostHintSource): number {
  // Explicit syntax wins over remembered prose when all other fields tie.
  switch (source) {
    case "slash": return 0;
    case "attachment": return 1;
    case "history": return 2;
    case "custom": return 3;
  }
}

function queryStart(units: readonly string[], cursor: number, scope: GhostHintScope): number {
  if (scope === "document") return 0;
  let start = cursor;
  while (start > 0 && units[start - 1] !== "\n") start -= 1;
  if (scope === "line") return start;
  while (start < cursor && /\s/u.test(units[start])) start += 1;
  let tokenStart = cursor;
  while (tokenStart > start && !/\s/u.test(units[tokenStart - 1])) tokenStart -= 1;
  return tokenStart;
}

function codePointCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Select an inline hint without depending on candidate arrival order.
 *
 * The same text + candidate SET always produces the same answer: priority
 * descending, explicit-source rank, shortest added suffix, then code-point
 * lexical order. This prevents async providers from making the ghost text
 * flicker between equally plausible completions.
 */
export function selectGhostHint(
  text: string,
  cursor: number,
  candidates: readonly GhostHintCandidate[],
): GhostHint | null {
  const units = graphemes(text.replace(/\r\n?/g, "\n"));
  const caret = Math.max(0, Math.min(cursor, units.length));
  const eligible: GhostHint[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const value = candidate.value.replace(/\r\n?/g, "\n");
    if (!value) continue;
    const scope = candidate.scope ?? "document";
    const from = queryStart(units, caret, scope);
    const query = units.slice(from, caret).join("");
    if (!query) continue;
    const haystack = candidate.caseSensitive === false ? value.toLowerCase() : value;
    const needle = candidate.caseSensitive === false ? query.toLowerCase() : query;
    if (!haystack.startsWith(needle) || value === query) continue;
    const suffix = graphemes(value).slice(graphemes(query).length).join("");
    if (!suffix || suffix.includes("\n")) continue;
    const source = candidate.source ?? "custom";
    const priority = candidate.priority ?? 0;
    const key = `${scope}\u0000${from}\u0000${source}\u0000${priority}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({
      value,
      suffix,
      source,
      priority,
      scope,
      replaceFrom: from,
      insertAt: caret,
    });
  }

  eligible.sort((a, b) =>
    b.priority - a.priority
    || sourceRank(a.source) - sourceRank(b.source)
    || graphemes(a.suffix).length - graphemes(b.suffix).length
    || codePointCompare(a.value, b.value)
  );
  return eligible[0] ?? null;
}

export function acceptGhostHint(state: ComposerState, hint: GhostHint | null): ComposerState {
  if (!hint || state.cursor !== hint.insertAt) return state;
  return reduceComposer(state, { type: "insert", text: hint.suffix });
}
