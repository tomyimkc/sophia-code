/**
 * Slash-picker discoverability helpers.
 *
 * Pure functions only: fuzzy ranking with highlight ranges, typo recovery
 * ("did you mean"), category grouping, argument completion, an availability
 * classifier, width-aware layout budgets, and a catalog-derived first-run
 * list. Nothing here renders, touches the bridge, or owns a clock — a caller
 * wires these into the picker component and App.tsx.
 *
 * Deliberately duck-typed against the catalog shape rather than importing
 * `SlashCommand` from ./slash.js: that file (and App.tsx / SlashSuggest.tsx)
 * are edited by other work in parallel with this one, so a hard import here
 * would make an unrelated rename or field change over there a silent break
 * over here. Any real `SlashCommand` already satisfies `DiscoveryCommand`
 * structurally — callers pass catalog rows straight through, no adapter
 * needed.
 */
import { displayWidth } from "./textWidth.js";

export interface DiscoveryArgumentPositional {
  name: string;
  value_type: string;
  required?: boolean;
  choices?: string[];
  rest?: boolean;
}

export interface DiscoveryArguments {
  usage?: string;
  min_args?: number;
  max_args?: number | null;
  positionals?: DiscoveryArgumentPositional[];
  examples?: string[];
}

export interface DiscoveryClientExecution {
  execution_state?: string;
  handler?: string;
}

export interface DiscoveryCommand {
  name: string;
  slash?: string;
  aliases?: string[];
  category?: string;
  description?: string;
  kind?: string;
  support_state?: string;
  execution_state?: string;
  client_execution?: Record<string, DiscoveryClientExecution | undefined>;
  arguments?: DiscoveryArguments;
}

/** Strip a leading "/" and normalize case; a query is compared bare, never with its slash. */
function normalizeQuery(query: string): string {
  const trimmed = (query || "").trim().toLowerCase();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

// ---------------------------------------------------------------------------
// Fuzzy subsequence ranking with highlight ranges
// ---------------------------------------------------------------------------

export interface MatchRange {
  /** Inclusive start index into the matched name/alias. */
  start: number;
  /** Exclusive end index into the matched name/alias. */
  end: number;
}

export interface SubsequenceMatch {
  score: number;
  ranges: MatchRange[];
}

const WORD_BOUNDARY_CHARS = new Set(["-", "_", " ", "/", ":"]);
const EXACT_MATCH_BONUS = 1_000;
const BASE_CHAR_SCORE = 10;
const CONTIGUOUS_BONUS = 15;
const WORD_START_BONUS = 20;
const GAP_PENALTY = 2;

function isWordStart(target: string, index: number): boolean {
  return index <= 0 || WORD_BOUNDARY_CHARS.has(target[index - 1]);
}

function toRanges(indices: number[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const idx of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === idx) {
      last.end = idx + 1;
    } else {
      ranges.push({ start: idx, end: idx + 1 });
    }
  }
  return ranges;
}

/**
 * Best-alignment subsequence match of `query` inside `target` (both compared
 * case-insensitively), or null when `query`'s characters do not all appear
 * in `target` in order.
 *
 * A DP over (query index, target index) rather than a greedy left-to-right
 * scan: greedy matching latches onto the FIRST occurrence of each query
 * character, which favors scattered matches over a tighter, more obviously-
 * intended run later in the string (e.g. querying "el" against "keybindings"
 * greedily grabs the wrong 'e'). The table is bounded by
 * query.length * target.length, and slash-command names are short (rarely
 * over ~20 characters) and queries are typed one keystroke at a time, so this
 * stays well under a millisecond even scored across a few hundred commands.
 */
export function matchSubsequence(query: string, target: string): SubsequenceMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q || !t) return null;
  if (q === t) {
    return { score: EXACT_MATCH_BONUS + t.length * BASE_CHAR_SCORE, ranges: [{ start: 0, end: t.length }] };
  }
  const qn = q.length;
  const tn = t.length;
  if (qn > tn) return null;

  const NEG = Number.NEGATIVE_INFINITY;
  // dp[i][j]: best score aligning q[0..=i] such that q[i] lands at target
  // index j. back[i][j] records the previous match's target index for
  // backtracking the winning alignment into highlight ranges.
  const dp: number[][] = Array.from({ length: qn }, () => new Array(tn).fill(NEG));
  const back: number[][] = Array.from({ length: qn }, () => new Array(tn).fill(-1));

  for (let j = 0; j < tn; j++) {
    if (t[j] !== q[0]) continue;
    dp[0][j] = BASE_CHAR_SCORE + (isWordStart(t, j) ? WORD_START_BONUS : 0);
  }
  for (let i = 1; i < qn; i++) {
    for (let j = i; j < tn; j++) {
      if (t[j] !== q[i]) continue;
      let best = NEG;
      let bestPrev = -1;
      for (let jp = i - 1; jp < j; jp++) {
        if (dp[i - 1][jp] === NEG) continue;
        const gap = j - jp - 1;
        const contiguous = gap === 0;
        const candidate =
          dp[i - 1][jp] +
          BASE_CHAR_SCORE +
          (contiguous ? CONTIGUOUS_BONUS : -GAP_PENALTY * gap) +
          (!contiguous && isWordStart(t, j) ? WORD_START_BONUS : 0);
        if (candidate > best) {
          best = candidate;
          bestPrev = jp;
        }
      }
      dp[i][j] = best;
      back[i][j] = bestPrev;
    }
  }

  let bestJ = -1;
  let bestScore = NEG;
  for (let j = 0; j < tn; j++) {
    if (dp[qn - 1][j] > bestScore) {
      bestScore = dp[qn - 1][j];
      bestJ = j;
    }
  }
  if (bestJ === -1) return null;

  const indices = new Array<number>(qn);
  let i = qn - 1;
  let j = bestJ;
  while (i >= 0) {
    indices[i] = j;
    j = back[i][j];
    i--;
  }
  return { score: bestScore, ranges: toRanges(indices) };
}

export interface FuzzyMatch<T> {
  command: T;
  score: number;
  /** The name or alias that actually scored (may differ from command.name). */
  matchedOn: string;
  ranges: MatchRange[];
}

/**
 * Rank `commands` against `query` by best subsequence match across each
 * command's name and aliases. Exact name/alias matches win outright (see the
 * flat EXACT_MATCH_BONUS above every reachable subsequence score); among
 * subsequence matches, contiguous runs and matches anchored at a word start
 * beat scattered ones. Commands with no valid subsequence alignment are
 * dropped, not scored zero — an empty result means "nothing fuzzy-matches",
 * distinct from "everything matched equally badly".
 */
export function fuzzyRankCommands<T extends DiscoveryCommand>(commands: T[], query: string): FuzzyMatch<T>[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const results: FuzzyMatch<T>[] = [];
  for (const command of commands) {
    const names = [command.name, ...(command.aliases || [])];
    let best: SubsequenceMatch | null = null;
    let bestName = "";
    for (const name of names) {
      const match = matchSubsequence(q, name);
      if (match && (!best || match.score > best.score)) {
        best = match;
        bestName = name;
      }
    }
    if (best) results.push({ command, score: best.score, matchedOn: bestName, ranges: best.ranges });
  }
  results.sort(
    (a, b) => b.score - a.score || a.matchedOn.length - b.matchedOn.length || a.matchedOn.localeCompare(b.matchedOn),
  );
  return results;
}

// ---------------------------------------------------------------------------
// "Did you mean" — bounded, transposition-aware edit distance
// ---------------------------------------------------------------------------

/**
 * Restricted (optimal-string-alignment) Damerau-Levenshtein distance: insert,
 * delete, substitute, or swap one pair of ADJACENT characters, each costing
 * one edit. Plain Levenshtein charges a transposed pair TWO edits (two
 * substitutions, or a delete+insert), which pushes the single most common
 * typo shape ("reusme" for "resume", "mdoel" for "model") outside any bound
 * tight enough to still reject gibberish. Counting it as one edit is what
 * lets a bound of 1-2 catch real typos without also matching unrelated words.
 */
function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        d[i - 1][j] + 1, // delete
        d[i][j - 1] + 1, // insert
        d[i - 1][j - 1] + cost, // substitute
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2][j - 2] + cost); // adjacent transposition
      }
      d[i][j] = value;
    }
  }
  return d[al][bl];
}

/**
 * How many edits a name of this length may be away from the typed query and
 * still count as "the same word, fat-fingered". Short names get the tight
 * bound: a 2-3 letter alias one edit from a dozen other short words would
 * turn "did you mean" into noise. Longer names can absorb a second edit
 * (e.g. a transposition AND a dropped letter) before the guess stops being
 * obviously the intended command.
 */
function maxTypoDistance(nameLength: number): number {
  return nameLength <= 4 ? 1 : 2;
}

export interface DidYouMeanMatch<T> {
  command: T;
  matchedOn: string;
  distance: number;
}

/**
 * The single best typo-corrected guess for a query that matched nothing
 * else, or null. Null covers two cases on purpose: no candidate is close
 * enough (gibberish like "/xyzzy"), or two DIFFERENT commands tie for
 * closest (an ambiguous guess is worse than an honest "nothing found" —
 * the caller should not silently pick one of two equally-plausible corrections).
 */
export function didYouMean<T extends DiscoveryCommand>(commands: T[], query: string): DidYouMeanMatch<T> | null {
  const q = normalizeQuery(query);
  if (!q) return null;
  let best: DidYouMeanMatch<T> | null = null;
  let ambiguous = false;
  for (const command of commands) {
    for (const name of [command.name, ...(command.aliases || [])]) {
      const target = name.toLowerCase();
      const distance = damerauLevenshtein(q, target);
      if (distance === 0 || distance > maxTypoDistance(target.length)) continue;
      if (!best || distance < best.distance) {
        best = { command, matchedOn: name, distance };
        ambiguous = false;
      } else if (distance === best.distance && command !== best.command) {
        ambiguous = true;
      }
    }
  }
  return ambiguous ? null : best;
}

// ---------------------------------------------------------------------------
// Category grouping, derived from the catalog's own category metadata
// ---------------------------------------------------------------------------

export interface CategoryMeta {
  id: string;
  label: string;
  description?: string;
}

export interface CommandGroup<T> {
  id: string;
  label: string;
  description?: string;
  commands: T[];
}

const UNKNOWN_CATEGORY_LABEL = "Other";

/**
 * Group `commands` by `command.category`, ordered and labeled by
 * `categories` (the catalog's own `category_metadata`, generated from
 * agent/slash_catalog.py) rather than a hardcoded id/label list here — a
 * category renamed or added on the Python side shows up correctly with no
 * change needed in this file. A category id present on a command but absent
 * from `categories` (stale generated data, or a client that trimmed the
 * metadata) still surfaces its commands under one honest "Other" group
 * instead of silently dropping them from /help.
 */
export function groupByCategory<T extends DiscoveryCommand>(commands: T[], categories: CategoryMeta[]): CommandGroup<T>[] {
  const byId = new Map<string, T[]>();
  for (const command of commands) {
    const id = command.category || "";
    const bucket = byId.get(id);
    if (bucket) bucket.push(command);
    else byId.set(id, [command]);
  }
  const groups: CommandGroup<T>[] = [];
  for (const meta of categories) {
    const bucket = byId.get(meta.id);
    if (!bucket || !bucket.length) continue;
    groups.push({ id: meta.id, label: meta.label, description: meta.description, commands: bucket });
    byId.delete(meta.id);
  }
  for (const [id, bucket] of byId) {
    if (!bucket.length) continue;
    groups.push({ id: id || "other", label: UNKNOWN_CATEGORY_LABEL, commands: bucket });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Argument completion, sourced from catalog choices or caller-supplied context
// ---------------------------------------------------------------------------

export interface ArgumentCompletionContext {
  models?: string[];
  sessions?: string[];
  themes?: string[];
  modes?: string[];
  permissions?: string[];
}

/** Positional `value_type`s that name a dynamic, runtime-only candidate list. */
const DYNAMIC_CONTEXT_BY_VALUE_TYPE: Partial<Record<string, keyof ArgumentCompletionContext>> = {
  model: "models",
  session: "sessions",
};

/** Fallback lookup by positional name for enumerable args whose value_type is a generic "string". */
const DYNAMIC_CONTEXT_BY_POSITIONAL_NAME: Partial<Record<string, keyof ArgumentCompletionContext>> = {
  theme: "themes",
  mode: "modes",
  permission: "permissions",
};

/**
 * The full candidate list for a command's first (and, in this catalog, only
 * ever meaningfully completable) positional argument. Static choices baked
 * into the catalog (mode/theme/permission/effort/…) always win when present
 * — they are the source of truth for that argument. Otherwise, for the
 * handful of value types the catalog itself cannot enumerate ahead of time
 * (a model alias, a saved session name), the caller-supplied context fills
 * in. Anything else (a free-text path, a run id, a message selector) has no
 * honest candidate list, so this returns empty rather than inventing one.
 */
export function argumentCandidates<T extends DiscoveryCommand>(command: T, context: ArgumentCompletionContext = {}): string[] {
  const positional = command.arguments?.positionals?.[0];
  if (!positional) return [];
  if (positional.choices && positional.choices.length) return [...positional.choices];
  const key = DYNAMIC_CONTEXT_BY_VALUE_TYPE[positional.value_type] ?? DYNAMIC_CONTEXT_BY_POSITIONAL_NAME[positional.name];
  if (!key) return [];
  return [...(context[key] || [])];
}

/**
 * Candidates for a command's argument that also match `partial` (the text
 * typed so far after the command name). Prefix matches are returned before
 * substring matches so the most likely completion stays first even when the
 * caller renders only the top few.
 */
export function completeArgument<T extends DiscoveryCommand>(
  command: T,
  partial: string,
  context: ArgumentCompletionContext = {},
): string[] {
  const candidates = argumentCandidates(command, context);
  const needle = (partial || "").trim().toLowerCase();
  if (!needle) return candidates;
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower.startsWith(needle)) prefix.push(candidate);
    else if (lower.includes(needle)) substring.push(candidate);
  }
  return [...prefix, ...substring];
}

// ---------------------------------------------------------------------------
// Availability classifier
// ---------------------------------------------------------------------------

export type AvailabilityBucket = "wired" | "backend-dependent" | "catalog-only";

export interface AvailabilityClassification {
  bucket: AvailabilityBucket;
  /**
   * False when the catalog's own fields disagreed with each other (e.g.
   * `implemented_local` with no named handler) and this had to fall back to
   * the more conservative bucket rather than trust the claim. A caller can
   * use this to skip a confident-looking badge style for an uncertain read.
   */
  certain: boolean;
  reason: string;
}

/**
 * Same per-client execution_state fallback chain as slash.ts's
 * clientExecutionFor, deliberately re-implemented rather than imported (see
 * the file header) — the catalog crosses the Python/TS boundary, so a
 * command missing its per-client entry is treated as absent data, not a bug.
 */
function clientStateFor(command: DiscoveryCommand, client: string): DiscoveryClientExecution {
  const declared = command.client_execution?.[client];
  if (declared) return declared;
  const state =
    command.execution_state ||
    (command.support_state === "unsupported" ? "unsupported" : command.kind === "prompt" ? "prompt" : "info");
  return { execution_state: state, handler: "" };
}

/**
 * Classify a command's real-world availability from what the catalog
 * actually carries, for the given client:
 *   - "wired": a local handler runs it directly in this client.
 *   - "backend-dependent": it hands a formatted prompt to the agent/model
 *     backend — the catalog can confirm THAT it dispatches, but not whether
 *     the backend is reachable when it does, so this is never reported as
 *     "wired".
 *   - "catalog-only": listed and described, but no action happens locally
 *     for this client (either genuinely unsupported, or purely informational
 *     text).
 * When the catalog's own fields are internally inconsistent — claiming
 * `implemented_local` with no handler named for this client — this trusts
 * the missing evidence over the claim and returns the conservative bucket
 * with `certain: false`, rather than showing a "wired" badge nothing backs up.
 */
export function classifyAvailability<T extends DiscoveryCommand>(command: T, client = "tui"): AvailabilityClassification {
  const { execution_state: state, handler } = clientStateFor(command, client);
  if (state === "prompt") {
    return {
      bucket: "backend-dependent",
      certain: true,
      reason:
        "Sends a formatted prompt to the agent backend; whether it actually runs depends on that backend being reachable, which this static catalog cannot know.",
    };
  }
  if (state === "implemented_local") {
    if (handler) {
      return { bucket: "wired", certain: true, reason: `Handled locally by ${handler}.` };
    }
    return {
      bucket: "catalog-only",
      certain: false,
      reason: "Catalog marks this implemented_local but named no handler for this client.",
    };
  }
  return {
    bucket: "catalog-only",
    certain: true,
    reason: state === "unsupported" ? "Listed but not implemented for this client." : "Informational text only; no local action is taken.",
  };
}

// ---------------------------------------------------------------------------
// Width-aware layout budgets
// ---------------------------------------------------------------------------

/**
 * Below this content width, a usage hint (and any example after it) has
 * nowhere to go without crowding out the command list itself. Set to 78, not
 * the picker's true 80-column target, because the picker box's own border and
 * padding consume a few columns before "80 columns of terminal" becomes
 * "usable content columns" — the previous threshold of 82 could never fire on
 * the single most common terminal width (80 columns), which was the actual
 * complaint.
 */
export const USAGE_HINT_MIN_WIDTH = 78;

/** Below this content width, a full-text availability badge (e.g. "[local]") doesn't fit next to a description worth reading. */
export const FULL_BADGE_MIN_WIDTH = 58;

export function shouldShowUsageHint(width: number): boolean {
  return width >= USAGE_HINT_MIN_WIDTH;
}

/** An example is extra detail hung off the usage hint line; showing it without the hint has nothing to attach to. */
export function shouldShowExample(width: number): boolean {
  return shouldShowUsageHint(width);
}

const BADGE_GLYPHS: Record<string, string> = {
  local: "L",
  agent: "A",
  info: "I",
  unavailable: "U",
  candidate: "C",
  "sophia-native": "S",
  "legacy-alias": "!",
};

/**
 * A 1-2 character stand-in for a full badge word, used when there isn't room
 * for the word itself. This is the ONLY availability signal visible at a
 * narrow width, so an ambiguous glyph here is worse than no glyph — known
 * badge values get a hand-picked letter; anything else falls back to its own
 * first letter rather than disappearing.
 */
export function compactBadgeGlyph(badge: string): string {
  return BADGE_GLYPHS[badge] || badge.slice(0, 1).toUpperCase() || "?";
}

/** The badge text to render at `width`: the full word at or above FULL_BADGE_MIN_WIDTH, a compact glyph below it, or null when there is no badge to show. */
export function badgeForWidth(width: number, badge: string | undefined | null): string | null {
  if (!badge) return null;
  return width >= FULL_BADGE_MIN_WIDTH ? badge : compactBadgeGlyph(badge);
}

export interface RowLayoutParts {
  name: string;
  usage?: string;
  example?: string;
  badge?: string;
}

export interface RowLayout {
  showUsageHint: boolean;
  showExample: boolean;
  /** What to render for the badge at this width — full word, compact glyph, or null. */
  badgeText: string | null;
  /** Remaining columns for the description after the name, badge, hint, and their separators. Never negative. */
  descriptionBudget: number;
}

const ROW_SEPARATOR_COLUMNS = 1;

/**
 * Full per-row layout decision at a given content `width`: whether the usage
 * hint and example fit, what form the badge takes, and how many columns are
 * left for the description once everything else that must stay visible has
 * claimed its space. Callers that already track their own width tiers can
 * use the smaller helpers above directly; this is the one-call version for a
 * row renderer.
 */
export function layoutRow(width: number, parts: RowLayoutParts): RowLayout {
  const w = Math.max(0, Math.floor(width));
  const showUsageHint = shouldShowUsageHint(w) && !!parts.usage;
  const showExample = showUsageHint && !!parts.example;
  const badgeText = badgeForWidth(w, parts.badge);

  let used = displayWidth(parts.name) + ROW_SEPARATOR_COLUMNS;
  if (badgeText) used += displayWidth(badgeText) + ROW_SEPARATOR_COLUMNS;
  if (showUsageHint && parts.usage) used += displayWidth(parts.usage) + ROW_SEPARATOR_COLUMNS;
  if (showExample && parts.example) used += displayWidth(parts.example) + ROW_SEPARATOR_COLUMNS;

  return {
    showUsageHint,
    showExample,
    badgeText,
    descriptionBudget: Math.max(0, w - used),
  };
}

// ---------------------------------------------------------------------------
// First-run suggestions
// ---------------------------------------------------------------------------

/**
 * A short, deterministic "try these first" list for a new user, derived
 * entirely from catalog signals rather than a hardcoded command list that
 * would silently rot as commands are added, renamed, or retired:
 *   - only commands actually wired locally for `client` (classifyAvailability
 *     bucket "wired") — never suggest a dead end as someone's first action;
 *   - one per category, walked in the catalog's own category order, so the
 *     list samples breadth (session, settings, help, …) instead of five
 *     variants of the same idea;
 *   - within a category, prefer a command that takes no required argument
 *     (arguments.min_args ?? 0 === 0) so it is safe to just run, falling back
 *     to any wired command in that category only if every wired command
 *     there requires one.
 */
export function firstRunSuggestions<T extends DiscoveryCommand>(
  commands: T[],
  categories: CategoryMeta[],
  limit = 5,
): T[] {
  if (!commands.length || limit <= 0) return [];
  const groups = groupByCategory(commands, categories);
  const picked: T[] = [];
  const used = new Set<T>();

  const sweep = (requireNoArgs: boolean) => {
    for (const group of groups) {
      if (picked.length >= limit) return;
      const candidate = group.commands.find(
        (c) =>
          !used.has(c) &&
          classifyAvailability(c, "tui").bucket === "wired" &&
          (!requireNoArgs || (c.arguments?.min_args ?? 0) === 0),
      );
      if (candidate) {
        picked.push(candidate);
        used.add(candidate);
      }
    }
  };

  sweep(true);
  if (picked.length < limit) sweep(false);
  return picked.slice(0, limit);
}
