import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import type { SlashCommand } from "../lib/slash.js";
import { allCommands, categoryLabel, commandAcceptsArguments, commandBadges, commandUsage } from "../lib/slash.js";
import { windowFor } from "../lib/pickers.js";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { displayWidth, truncateToWidth } from "../lib/textWidth.js";
import {
  badgeForWidth,
  classifyAvailability,
  didYouMean,
  matchSubsequence,
  shouldShowExample,
  shouldShowUsageHint,
  type MatchRange,
} from "../lib/slashDiscovery.js";

/**
 * Columns eaten by chrome that sits in front of a row's text: the "› "/"  "
 * selection marker (2) plus this component's own border and horizontal
 * padding (2 columns to a side, 4 total). Subtracted from `width` before
 * computing how much room is left for a row's description, so the budget
 * matches what the row's Box can actually render rather than the full
 * terminal width the show/hide thresholds are calibrated against.
 */
const ROW_CHROME_COLUMNS = 6;

export function slashRowBadge(command: SlashCommand): string {
  return commandBadges(command, "tui")[0] || "info";
}

export function slashRowCategory(command: SlashCommand): string {
  return command.help?.category_label || categoryLabel(command.category);
}

export function slashRowUsage(command: SlashCommand): string {
  if (command.name === "resume") return "/resume [session|text]";
  return commandUsage(command);
}

export function slashRowDescription(command: SlashCommand): string {
  if (command.name === "resume") {
    return "Browse or search past sessions by id, topic, or transcript text";
  }
  return command.description;
}

/**
 * The argument shape alone (e.g. "<goal>", "[list|select <name>|<name>]"),
 * with the leading "/name" stripped — the slash column already shows the
 * name, so repeating it in the hint would just eat width without adding
 * information. Empty for a command that takes no arguments at all, so a
 * caller can treat "" as "nothing to show" rather than rendering a hint that
 * says nothing.
 */
export function slashRowArgumentHint(command: SlashCommand): string {
  if (!commandAcceptsArguments(command)) return "";
  const usage = slashRowUsage(command);
  const prefix = command.slash || "/" + command.name;
  const hint = usage.startsWith(prefix) ? usage.slice(prefix.length) : usage;
  return hint.trim();
}

/** The badge text to render at `width` — full word, compact glyph, or null — for one row. */
export function slashRowBadgeText(width: number, command: SlashCommand): string | null {
  return badgeForWidth(width, slashRowBadge(command));
}

/** Whether a row's own argument hint fits at `width` and there is one to show. */
export function slashRowShowsArgumentHint(width: number, command: SlashCommand): boolean {
  return shouldShowUsageHint(width) && !!slashRowArgumentHint(command);
}

/**
 * True when the catalog itself does not back this command with a real local
 * action for the TUI: either it is explicitly unsupported/informational
 * ("catalog-only"), or it hands off to the agent backend and cannot be
 * confirmed to work offline ("backend-dependent"). Only "wired" — a genuine
 * local handler — counts as a sure thing; everything else gets dimmed so a
 * user scanning the list is not led to expect the same result from every row.
 */
export function slashRowNotWired(command: SlashCommand): boolean {
  return classifyAvailability(command, "tui").bucket !== "wired";
}

/**
 * Highlight ranges for the rendered "/name" text, derived from a fuzzy
 * subsequence match of the typed filter against the bare command name and
 * shifted right by the leading slash. Matching against aliases is
 * deliberately skipped here: this row always displays the canonical name, so
 * highlighting characters that only matched a different, unshown alias would
 * point at letters the user never typed. Returns [] (nothing to highlight)
 * once the filter is empty or genuinely does not line up with this name —
 * both are honest "no highlight" outcomes, not errors.
 */
export function slashRowHighlightRanges(command: SlashCommand, filter: string): MatchRange[] {
  const query = (filter || "").trim().toLowerCase().replace(/^\//, "");
  if (!query) return [];
  const match = matchSubsequence(query, command.name);
  if (!match) return [];
  const slash = command.slash || "/" + command.name;
  const offset = slash.length - command.name.length;
  if (offset <= 0) return match.ranges;
  return match.ranges.map((r) => ({ start: r.start + offset, end: r.end + offset }));
}

export interface HighlightSegment {
  text: string;
  matched: boolean;
}

/**
 * Split `text` into matched/unmatched runs from `ranges` so a renderer can
 * give each run its own style without re-deriving the boundaries itself.
 * `ranges` must be sorted and non-overlapping (matchSubsequence's contract) —
 * this does not re-sort them, since re-sorting a caller's already-correct
 * ranges would just hide a bug in whatever produced them.
 */
export function highlightSegments(text: string, ranges: readonly MatchRange[]): HighlightSegment[] {
  if (!ranges.length) return text ? [{ text, matched: false }] : [];
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), matched: false });
    segments.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });
  return segments;
}

/**
 * The message (and, when found, the corrected slash) for an empty match
 * list. Kept pure and separate from rendering so the typo-recovery path is
 * testable without Ink — `matches` is empty by the time a caller reaches
 * this, so the only source left for a guess is the full catalog, not
 * whatever narrow candidate set produced zero hits.
 */
export function slashNoMatchMessage(filter: string): { text: string; guessSlash: string | null } {
  const guess = didYouMean(allCommands(), filter || "");
  if (!guess) return { text: `No command matches “${filter}”.`, guessSlash: null };
  const guessSlash = guess.command.slash || "/" + guess.command.name;
  return { text: `No command matches “${filter}”. Did you mean ${guessSlash}?`, guessSlash };
}

export function slashSuggestBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

function HighlightedName({
  text,
  ranges,
  color,
  matchColor,
  bold,
}: {
  text: string;
  ranges: MatchRange[];
  color: string;
  matchColor: string;
  bold?: boolean;
}): React.ReactElement {
  if (!ranges.length) {
    return (
      <Text color={color} bold={bold}>
        {text}
      </Text>
    );
  }
  return (
    <Text color={color} bold={bold}>
      {highlightSegments(text, ranges).map((seg, i) =>
        seg.matched ? (
          <Text key={i} color={matchColor} bold>
            {seg.text}
          </Text>
        ) : (
          seg.text
        ),
      )}
    </Text>
  );
}

/**
 * Scrollable slash-command list. Window height scales with terminal size
 * so a tall window shows more commands without overflowing a short one.
 *
 * Navigation is WRAP-around (Up at the first row goes to the last row and
 * vice versa), matching every other picker in this app — see
 * pickers.ts:moveSelection, the shared rule App.tsx's arrow-key handlers
 * apply before this component ever sees the resulting `selected` index.
 *
 * `matches` arrives already ranked (App.tsx's rankSlashMatches) and
 * `selected` is a plain index into that array that the caller's Up/Down
 * handlers step with wraparound arithmetic over `matches.length` — this
 * component does not reorder `matches` for display, even though a full
 * regroup-by-category would look tidier for the "browse everything" state
 * (an untyped "/"). Reordering here would desync the highlighted row from
 * the index the caller's key handlers actually move, since those handlers
 * have no idea this component redrew the list in a different order —
 * pressing Down would visibly jump to an unrelated row instead of the next
 * one. Category headers are shown instead wherever the given order actually
 * changes category, which needs no coordination with the caller and never
 * disagrees with what Up/Down do.
 */
export function SlashSuggest({
  theme,
  matches,
  selected,
  filter,
  width,
  maxVisible = 12,
}: {
  theme: Theme;
  matches: SlashCommand[];
  selected: number;
  filter?: string;
  width: number;
  /** How many rows of commands to show (derived from available height). */
  maxVisible?: number;
}): React.ReactElement | null {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const borderStyle = slashSuggestBorderStyle(ax);

  // Hooks must run every render regardless of `matches.length` (rules of
  // hooks) — the empty-list bail-out below happens only in the JSX return.
  // windowFor also clamps `selected` into range, so a stale index from the
  // single render tick between a filter keystroke and the caller's
  // selection-reset effect can't point at a row this component neither
  // shows nor highlights.
  const { start, end, index } = useMemo(
    () => windowFor(matches.length, selected, maxVisible),
    [matches.length, selected, maxVisible],
  );

  if (!matches.length) {
    // Typing something that matches nothing is exactly when a user most
    // needs feedback — silently rendering nothing (the old behaviour) reads
    // as "the menu vanished," not "you have a typo." App.tsx currently only
    // mounts this component while `matches.length > 0`, so this branch does
    // not run yet; see the integration note that ships alongside this file.
    const { text } = slashNoMatchMessage(filter || "/");
    return (
      <Box
        flexDirection="column"
        borderStyle={borderStyle}
        borderColor={t.accent}
        paddingX={1}
        marginBottom={0}
        width={width}
        flexShrink={0}
      >
        <Text color={t.accent} bold wrap="truncate-end">
          Sophia commands
        </Text>
        <Text color={t.warn} wrap="wrap">
          {text}
        </Text>
        <Text color={t.dim} wrap="truncate-end">
          Tab complete · Esc clear · keep typing to search
        </Text>
      </Box>
    );
  }

  const visible = matches.slice(start, end);
  const moreAbove = start > 0;
  const moreBelow = end < matches.length;
  const slashPad = width >= 80 ? 20 : width >= 60 ? 16 : 14;

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={t.accent}
      paddingX={1}
      marginBottom={0}
      width={width}
      flexShrink={0}
    >
      <Text color={t.accent} bold wrap="truncate-end">
        Sophia commands
        {filter && filter !== "/" ? `  matching “${filter}”` : "  (all)"}
        <Text color={t.dim}>
          {"  "}
          {index + 1}/{matches.length}
        </Text>
      </Text>
      {/* Tab and Enter are NOT interchangeable: Tab only completes the
          highlighted command into the input line (App.tsx:onSlashTab ->
          completeSlashSelection, no submit); Enter selects it
          (App.tsx:onSlashEnterSelect -> chooseSlashSubmission). The line
          deliberately says "select", not "run": info and unavailable entries
          do not execute an action, and their badges make that visible. */}
      <Text color={t.dim} wrap="truncate-end">
        ↑↓ choose · Tab complete · Enter select · type to filter · Esc clear
      </Text>
      {moreAbove ? (
        <Text color={t.dim}>  ↑ {start} more above…</Text>
      ) : null}
      {visible.map((c, vi) => {
        const i = start + vi;
        const active = i === index;
        const prevCategory = vi > 0 ? visible[vi - 1].category : null;
        const showHeader = vi === 0 || c.category !== prevCategory;
        const notWired = slashRowNotWired(c);
        const badge = slashRowBadge(c);
        const badgeText = badgeForWidth(width, badge);
        const argHint = slashRowArgumentHint(c);
        const nameDisplay = c.slash || "/" + c.name;
        // A hint is variable-length per command ("<goal>" vs. "[list|select
        // <name>|<name>]") — padding the name to a fixed column AND showing a
        // hint would put a wall of blank space between them instead of a
        // single separating space. Column alignment only applies to rows that
        // aren't also showing a hint. shouldShowUsageHint/badgeForWidth are
        // deliberately called with the full `width`, not a chrome-adjusted
        // one: USAGE_HINT_MIN_WIDTH/FULL_BADGE_MIN_WIDTH are already
        // calibrated against the outer terminal width (see their own doc
        // comments), so re-deriving a smaller width here would make a hint
        // or badge disappear earlier than the caller's own contract expects.
        const willShowHint = shouldShowUsageHint(width) && !!argHint;
        const nameForRow = willShowHint ? nameDisplay : nameDisplay.padEnd(slashPad);
        const hintSuffix = willShowHint ? ` ${argHint} ` : "";
        const badgeSuffix = badgeText ? `  [${badgeText}]` : "";
        // The row's real text budget is `width` minus chrome the gating
        // functions above don't need to know about but that genuinely
        // consumes columns before a row's own content starts: the "› "/"  "
        // selection marker plus this component's own border and horizontal
        // padding. Truncating the description against the raw `width`
        // instead of this narrower budget let a wide hint+badge combination
        // overflow the row's actual box width — which didn't crash, but did
        // silently swallow whichever character Yoga's flex-shrink happened
        // to land on, including once the separating space in front of the
        // description.
        const rowBudget = Math.max(10, width - ROW_CHROME_COLUMNS);
        const reserved = displayWidth(nameForRow) + displayWidth(hintSuffix) + displayWidth(badgeSuffix);
        const description = slashRowDescription(c);
        const desc = truncateToWidth(description, Math.max(4, rowBudget - reserved));
        const ranges = slashRowHighlightRanges(c, filter || "");
        const example = c.arguments?.examples?.[0];
        return (
          <Box key={c.name + i} flexDirection="column">
            {showHeader ? (
              <Text color={t.accent} wrap="truncate-end">
                {slashRowCategory(c)}
              </Text>
            ) : null}
            <Box width={Math.max(20, width - 4)}>
              <Text color={active ? t.accent : t.dim}>
                {active ? "› " : "  "}
              </Text>
              <HighlightedName
                text={nameForRow}
                ranges={ranges}
                color={active ? t.accent : notWired ? t.dim : t.tool}
                matchColor={t.accent}
                bold={active}
              />
              {hintSuffix ? <Text color={t.dim}>{hintSuffix}</Text> : null}
              <Text color={t.dim} wrap="truncate-end">
                {desc}
              </Text>
              {badgeSuffix ? (
                <Text color={badge === "unavailable" ? t.warn : t.dim}>{badgeSuffix}</Text>
              ) : null}
            </Box>
            {active && shouldShowExample(width) && example ? (
              <Text color={t.dim} wrap="truncate-end">
                {"    "}e.g. {example}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {moreBelow ? (
        <Text color={t.dim}>
          {"  "}↓ {matches.length - end} more below…
        </Text>
      ) : null}
    </Box>
  );
}
