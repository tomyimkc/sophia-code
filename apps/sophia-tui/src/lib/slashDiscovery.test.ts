import test from "node:test";
import assert from "node:assert/strict";

import {
  argumentCandidates,
  badgeForWidth,
  classifyAvailability,
  completeArgument,
  compactBadgeGlyph,
  didYouMean,
  firstRunSuggestions,
  fuzzyRankCommands,
  groupByCategory,
  layoutRow,
  matchSubsequence,
  shouldShowExample,
  shouldShowUsageHint,
  USAGE_HINT_MIN_WIDTH,
  FULL_BADGE_MIN_WIDTH,
  type DiscoveryCommand,
} from "./slashDiscovery.js";

// Minimal fixture catalog covering the shapes real slash-commands.json rows
// take (static choices, dynamic value types, prompt-kind commands, an
// unsupported stub) without depending on the generated file, so these tests
// stay stable across catalog regeneration.
function cmd(overrides: Partial<DiscoveryCommand> & { name: string }): DiscoveryCommand {
  return {
    slash: `/${overrides.name}`,
    aliases: [],
    category: "session",
    description: `${overrides.name} description`,
    kind: "local",
    support_state: "supported",
    execution_state: "implemented_local",
    client_execution: { tui: { execution_state: "implemented_local", handler: "runLocalSlash" } },
    ...overrides,
  };
}

const FIXTURE: DiscoveryCommand[] = [
  cmd({ name: "clear", category: "session", aliases: ["cls"] }),
  cmd({
    name: "resume",
    category: "session",
    arguments: { min_args: 0, positionals: [{ name: "session", value_type: "session", choices: [] }] },
  }),
  cmd({
    name: "model",
    category: "settings",
    arguments: { min_args: 0, positionals: [{ name: "spec", value_type: "model", choices: [] }] },
  }),
  cmd({
    name: "mode",
    category: "settings",
    arguments: {
      min_args: 0,
      positionals: [{ name: "mode", value_type: "string", choices: ["logical", "precise", "balanced"] }],
    },
  }),
  cmd({
    name: "review",
    category: "quality",
    kind: "prompt",
    execution_state: "prompt",
    client_execution: { tui: { execution_state: "prompt", handler: "" } },
  }),
  cmd({
    name: "ide",
    category: "ide",
    support_state: "unsupported",
    execution_state: "unsupported",
    client_execution: { tui: { execution_state: "unsupported", handler: "" } },
  }),
  cmd({
    name: "help",
    category: "meta",
    arguments: { min_args: 0, positionals: [] },
  }),
];

const CATEGORIES = [
  { id: "session", label: "Sessions" },
  { id: "settings", label: "Model & control" },
  { id: "quality", label: "Review" },
  { id: "meta", label: "Help" },
  // "ide" deliberately omitted to exercise the unknown-category fallback.
];

// ---------------------------------------------------------------------------
// matchSubsequence / fuzzyRankCommands
// ---------------------------------------------------------------------------

test("matchSubsequence: exact match scores far above any partial match", () => {
  const exact = matchSubsequence("resume", "resume");
  const partial = matchSubsequence("rsm", "resume");
  assert.ok(exact);
  assert.ok(partial);
  assert.ok(exact!.score > partial!.score);
  assert.deepEqual(exact!.ranges, [{ start: 0, end: 6 }]);
});

test("matchSubsequence: contiguous run outscores a scattered subsequence of the same length", () => {
  const contiguous = matchSubsequence("mod", "model");
  const scattered = matchSubsequence("mdl", "model");
  assert.ok(contiguous);
  assert.ok(scattered);
  assert.ok(contiguous!.score > scattered!.score);
});

test("matchSubsequence: prefix match outscores a mid-string match of equal character count", () => {
  const prefix = matchSubsequence("res", "resume");
  const midString = matchSubsequence("sum", "resume");
  assert.ok(prefix);
  assert.ok(midString);
  assert.ok(prefix!.score > midString!.score);
});

test("matchSubsequence: characters out of order do not match", () => {
  assert.equal(matchSubsequence("emures", "resume"), null);
});

test("matchSubsequence: returns null rather than throwing on empty strings", () => {
  assert.equal(matchSubsequence("", "resume"), null);
  assert.equal(matchSubsequence("r", ""), null);
});

test("fuzzyRankCommands: exact name ranks first over every fuzzy match", () => {
  const ranked = fuzzyRankCommands(FIXTURE, "mode");
  assert.equal(ranked[0]?.command.name, "mode");
});

test("fuzzyRankCommands: matches an alias, not just the canonical name", () => {
  const ranked = fuzzyRankCommands(FIXTURE, "cls");
  assert.ok(ranked.some((r) => r.command.name === "clear" && r.matchedOn === "cls"));
});

test("fuzzyRankCommands: returns highlight ranges usable for rendering", () => {
  const ranked = fuzzyRankCommands(FIXTURE, "res");
  const resume = ranked.find((r) => r.command.name === "resume");
  assert.ok(resume);
  assert.deepEqual(resume!.ranges, [{ start: 0, end: 3 }]);
});

test("fuzzyRankCommands: empty query yields no matches, and nothing throws on an empty catalog", () => {
  assert.deepEqual(fuzzyRankCommands(FIXTURE, ""), []);
  assert.deepEqual(fuzzyRankCommands([], "resume"), []);
  assert.deepEqual(fuzzyRankCommands([], ""), []);
});

// ---------------------------------------------------------------------------
// didYouMean
// ---------------------------------------------------------------------------

test("didYouMean: corrects a transposed-letter typo", () => {
  const guess = didYouMean(FIXTURE, "/reusme");
  assert.ok(guess);
  assert.equal(guess!.command.name, "resume");
});

test("didYouMean: corrects a missing-letter typo", () => {
  const withHelp = [...FIXTURE, cmd({ name: "status", category: "meta" })];
  const guess = didYouMean(withHelp, "/staus");
  assert.ok(guess);
  assert.equal(guess!.command.name, "status");
});

test("didYouMean: corrects a second real transposition case (mdoel -> model)", () => {
  const guess = didYouMean(FIXTURE, "/mdoel");
  assert.ok(guess);
  assert.equal(guess!.command.name, "model");
});

test("didYouMean: gibberish returns null instead of a bad guess", () => {
  assert.equal(didYouMean(FIXTURE, "/xyzzy"), null);
});

test("didYouMean: an ambiguous tie between two different commands returns null", () => {
  const tied = [cmd({ name: "abcd", category: "session" }), cmd({ name: "abce", category: "session" })];
  // "abcf" is distance 1 from both "abcd" and "abce" -- neither guess is more
  // justified than the other, so this must not silently pick one.
  assert.equal(didYouMean(tied, "/abcf"), null);
});

test("didYouMean: a same-distance tie between a command's own name and its own alias is not ambiguous", () => {
  // "abcdg" is distance 1 from BOTH "abcde" (the name) and "abcdf" (the
  // alias) of the SAME command -- unlike the two-different-commands tie
  // above, this must resolve, not return null.
  const withAlias = [cmd({ name: "abcde", category: "session", aliases: ["abcdf"] })];
  const guess = didYouMean(withAlias, "/abcdg");
  assert.ok(guess);
  assert.equal(guess!.command.name, "abcde");
});

test("didYouMean: empty query and empty catalog do not throw", () => {
  assert.equal(didYouMean(FIXTURE, ""), null);
  assert.equal(didYouMean([], "/resume"), null);
});

// ---------------------------------------------------------------------------
// groupByCategory
// ---------------------------------------------------------------------------

test("groupByCategory: orders groups by the catalog's own category metadata, not alphabetically or by first appearance", () => {
  const groups = groupByCategory(FIXTURE, CATEGORIES);
  const ids = groups.map((g) => g.id);
  assert.deepEqual(ids.slice(0, 4), ["session", "settings", "quality", "meta"]);
});

test("groupByCategory: a category id missing from the metadata still surfaces its commands, under a fallback group", () => {
  const groups = groupByCategory(FIXTURE, CATEGORIES);
  const other = groups.find((g) => g.commands.some((c) => c.name === "ide"));
  assert.ok(other, "the /ide command must not be silently dropped");
  assert.equal(other!.label, "Other");
});

test("groupByCategory: an empty command list produces no groups and does not throw", () => {
  assert.deepEqual(groupByCategory([], CATEGORIES), []);
});

test("groupByCategory: with no category metadata at all, commands still separate by their own category id under the fallback label, rather than collapsing into one undifferentiated bucket", () => {
  const groups = groupByCategory(FIXTURE, []);
  const total = groups.reduce((sum, g) => sum + g.commands.length, 0);
  assert.equal(total, FIXTURE.length);
  assert.ok(groups.every((g) => g.label === "Other"));
  // FIXTURE spans 5 distinct category ids (session, settings, quality, ide, meta).
  assert.equal(groups.length, 5);
});

// ---------------------------------------------------------------------------
// argumentCandidates / completeArgument
// ---------------------------------------------------------------------------

test("argumentCandidates: static catalog choices are returned as-is", () => {
  const mode = FIXTURE.find((c) => c.name === "mode")!;
  assert.deepEqual(argumentCandidates(mode), ["logical", "precise", "balanced"]);
});

test("argumentCandidates: a dynamic value_type pulls from the caller-supplied context", () => {
  const model = FIXTURE.find((c) => c.name === "model")!;
  assert.deepEqual(argumentCandidates(model, { models: ["omlx", "vllm"] }), ["omlx", "vllm"]);
  const resume = FIXTURE.find((c) => c.name === "resume")!;
  assert.deepEqual(argumentCandidates(resume, { sessions: ["tui-default"] }), ["tui-default"]);
});

test("argumentCandidates: a command with no completable argument returns an empty list, not a guess", () => {
  const clear = FIXTURE.find((c) => c.name === "clear")!;
  assert.deepEqual(argumentCandidates(clear), []);
  const model = FIXTURE.find((c) => c.name === "model")!;
  // No models supplied in context: honestly empty rather than fabricated.
  assert.deepEqual(argumentCandidates(model, {}), []);
});

test("completeArgument: prefix matches sort ahead of substring-only matches", () => {
  const mode = FIXTURE.find((c) => c.name === "mode")!;
  assert.deepEqual(completeArgument(mode, "p"), ["precise"]);
  const model = FIXTURE.find((c) => c.name === "model")!;
  const result = completeArgument(model, "l", { models: ["logical-model", "omlx", "mlx"] });
  assert.deepEqual(result, ["logical-model", "omlx", "mlx"]);
});

test("completeArgument: an empty partial returns the full candidate list", () => {
  const mode = FIXTURE.find((c) => c.name === "mode")!;
  assert.deepEqual(completeArgument(mode, ""), ["logical", "precise", "balanced"]);
});

// ---------------------------------------------------------------------------
// classifyAvailability
// ---------------------------------------------------------------------------

test("classifyAvailability: a local handler is wired", () => {
  const clear = FIXTURE.find((c) => c.name === "clear")!;
  const result = classifyAvailability(clear, "tui");
  assert.equal(result.bucket, "wired");
  assert.equal(result.certain, true);
});

test("classifyAvailability: a prompt-kind command is backend-dependent, never wired", () => {
  const review = FIXTURE.find((c) => c.name === "review")!;
  const result = classifyAvailability(review, "tui");
  assert.equal(result.bucket, "backend-dependent");
});

test("classifyAvailability: an unsupported command is catalog-only", () => {
  const ide = FIXTURE.find((c) => c.name === "ide")!;
  const result = classifyAvailability(ide, "tui");
  assert.equal(result.bucket, "catalog-only");
  assert.equal(result.certain, true);
});

test("classifyAvailability: implemented_local with no handler named is downgraded, not trusted", () => {
  const inconsistent = cmd({
    name: "broken",
    execution_state: "implemented_local",
    client_execution: { tui: { execution_state: "implemented_local", handler: "" } },
  });
  const result = classifyAvailability(inconsistent, "tui");
  assert.equal(result.bucket, "catalog-only");
  assert.equal(result.certain, false);
});

test("classifyAvailability: a client with no declared per-client entry falls back to the top-level fields", () => {
  const noClientEntry = cmd({ name: "fallback", execution_state: "info", client_execution: {} });
  const result = classifyAvailability(noClientEntry, "tui");
  assert.equal(result.bucket, "catalog-only");
});

// ---------------------------------------------------------------------------
// Width-aware layout
// ---------------------------------------------------------------------------

test("badgeForWidth: full text at or above the threshold, a compact glyph below it", () => {
  assert.equal(badgeForWidth(FULL_BADGE_MIN_WIDTH, "local"), "local");
  assert.equal(badgeForWidth(FULL_BADGE_MIN_WIDTH - 1, "local"), "L");
  assert.equal(badgeForWidth(1, "unavailable"), "U");
});

test("badgeForWidth: no badge value means no badge at any width", () => {
  assert.equal(badgeForWidth(200, undefined), null);
  assert.equal(badgeForWidth(200, ""), null);
});

test("compactBadgeGlyph: unknown badge text still degrades to a letter, not nothing", () => {
  assert.equal(compactBadgeGlyph("mystery"), "M");
  assert.equal(compactBadgeGlyph(""), "?");
});

test("shouldShowUsageHint / shouldShowExample: visible at the default 80-column terminal", () => {
  // The picker box's border + padding eat a few columns before "80" becomes
  // usable content width, so this must hold at something at-or-below 80, not
  // only at exactly 80.
  assert.ok(USAGE_HINT_MIN_WIDTH <= 80);
  assert.equal(shouldShowUsageHint(80), true);
  assert.equal(shouldShowExample(80), true);
  assert.equal(shouldShowUsageHint(USAGE_HINT_MIN_WIDTH - 1), false);
});

test("layoutRow: badges survive a narrow width budget instead of disappearing", () => {
  const wide = layoutRow(80, { name: "/resume", usage: "/resume [session]", example: "/resume tui-default", badge: "local" });
  assert.equal(wide.showUsageHint, true);
  assert.equal(wide.showExample, true);
  assert.equal(wide.badgeText, "local");
  assert.ok(wide.descriptionBudget > 0);

  const narrow = layoutRow(45, { name: "/resume", usage: "/resume [session]", example: "/resume tui-default", badge: "local" });
  assert.equal(narrow.showUsageHint, false);
  assert.equal(narrow.badgeText, "L");
  assert.ok(narrow.descriptionBudget >= 0);
});

test("layoutRow: never returns a negative description budget, even at width 0", () => {
  const result = layoutRow(0, { name: "/a-very-long-command-name", badge: "unavailable" });
  assert.equal(result.descriptionBudget, 0);
});

// ---------------------------------------------------------------------------
// firstRunSuggestions
// ---------------------------------------------------------------------------

test("firstRunSuggestions: only wired commands are suggested, never a dead end", () => {
  const suggestions = firstRunSuggestions(FIXTURE, CATEGORIES, 10);
  assert.ok(suggestions.every((c) => classifyAvailability(c, "tui").bucket === "wired"));
  assert.ok(!suggestions.some((c) => c.name === "ide" || c.name === "review"));
});

test("firstRunSuggestions: samples across categories in the catalog's declared order before repeating one", () => {
  const suggestions = firstRunSuggestions(FIXTURE, CATEGORIES, 3);
  const categories = suggestions.map((c) => c.category);
  assert.deepEqual(categories, ["session", "settings", "meta"]);
});

test("firstRunSuggestions: respects the limit and never throws on an empty catalog", () => {
  assert.equal(firstRunSuggestions(FIXTURE, CATEGORIES, 2).length, 2);
  assert.deepEqual(firstRunSuggestions([], CATEGORIES, 5), []);
  assert.deepEqual(firstRunSuggestions(FIXTURE, CATEGORIES, 0), []);
});
