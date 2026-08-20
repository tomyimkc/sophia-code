import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import { accessibleTheme, type AccessibilityPrefs } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import { windowFor } from "../lib/pickers.js";
import { matchSubsequence, type MatchRange } from "../lib/slashDiscovery.js";

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  kind?: "group" | "option";
  groupId?: import("../lib/pickers.js").ModelGroupId;
  expanded?: boolean;
  optionCount?: number;
}

export function optionPickerBorderStyle(prefs: AccessibilityPrefs): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

/**
 * Highlight ranges for `option.label` against a typed filter, or [] once the
 * filter is empty or does not line up with this label — both are honest
 * "nothing to highlight" outcomes, not errors. Matching is against the label
 * only (what is actually rendered), never `value` — highlighting characters
 * a user cannot see would be worse than not highlighting at all.
 */
export function matchPickerOption(option: Pick<PickerOption, "label">, query: string | undefined): MatchRange[] {
  const q = (query || "").trim();
  if (!q) return [];
  const match = matchSubsequence(q, option.label);
  return match ? match.ranges : [];
}

/** Whether any selectable option's label fuzzy-matches `query` — the honest test for "nothing found" vs. "query not applied yet". */
export function anyPickerOptionMatches(options: readonly Pick<PickerOption, "label">[], query: string | undefined): boolean {
  if (!(query || "").trim()) return true;
  return options.some((option) => matchPickerOption(option, query).length > 0);
}

/** The empty-state message for a filter that matched nothing, distinct from "there are no options at all" (see the zero-option branch below). */
export function pickerNoMatchMessage(query: string): string {
  return `No options match “${query}”.`;
}

export interface OptionLabelSegment {
  text: string;
  matched: boolean;
}

/**
 * Split `text` into matched/unmatched runs from `ranges` so a renderer can
 * style each run without re-deriving the boundaries. `ranges` must already
 * be sorted and non-overlapping (matchSubsequence's contract).
 */
export function splitOptionLabel(text: string, ranges: readonly MatchRange[]): OptionLabelSegment[] {
  if (!ranges.length) return text ? [{ text, matched: false }] : [];
  const segments: OptionLabelSegment[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), matched: false });
    segments.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });
  return segments;
}

function HighlightedLabel({
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
      {splitOptionLabel(text, ranges).map((seg, i) =>
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
 * Full-width arrow-key picker for Sophia settings.
 * Window height and label padding scale with terminal size.
 *
 * Navigation is WRAP-around (Up at the first row goes to the last row and
 * vice versa), matching the slash-command menu — see
 * pickers.ts:moveSelection, the shared rule App.tsx's arrow-key handlers
 * apply before this component ever sees the resulting `selected` index.
 *
 * `filterQuery` is optional and purely presentational here: this component
 * does not filter or reorder `options` itself, because `selected` is a plain
 * index into `options` that the caller's key handlers step with wraparound
 * arithmetic (moveSelection(picker.selected, delta, opts.length)) — hiding
 * rows here without the caller also re-deriving `options`/`selected` around
 * the same filter would desync the highlighted row from what Up/Down
 * actually move across. Pass `filterQuery` once the caller is ready to
 * recompute `options` (and reset `selected`) from it on every keystroke;
 * until then, omitting the prop keeps this identical to the unfiltered list.
 */
export function OptionPicker({
  theme,
  title,
  options,
  selected,
  current,
  width,
  maxVisible = 14,
  filterQuery,
}: {
  theme: Theme;
  title: string;
  options: PickerOption[];
  selected: number;
  current?: string;
  width: number;
  maxVisible?: number;
  /** Current type-to-filter text, already applied to `options` by the caller. Omit to keep the plain, unfiltered picker. */
  filterQuery?: string;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const borderStyle = optionPickerBorderStyle(ax);

  // windowFor clamps `selected` into range, so a stale/out-of-range index
  // (or the NaN a `% 0` upstream can produce — see moveSelection's doc
  // comment) never highlights nothing or throws.
  const { start, end, index } = useMemo(
    () => windowFor(options.length, selected, maxVisible),
    [options.length, selected, maxVisible],
  );

  const hasFilter = filterQuery !== undefined && filterQuery.trim() !== "";

  if (!options.length) {
    // A zero-option picker is reachable today two different ways: /resume
    // with no saved sessions yet (nothing to filter — say so plainly), or a
    // filter that matched nothing (say what was typed, so the fix is
    // "backspace" rather than "why is this menu empty").
    const message = hasFilter ? pickerNoMatchMessage(filterQuery as string) : "No options available";
    return (
      <Box
        flexDirection="column"
        borderStyle={borderStyle}
        borderColor={t.accent}
        paddingX={1}
        marginY={0}
        width={width}
        flexShrink={0}
      >
        <Text color={t.accent} bold>
          {title}
        </Text>
        <Text color={t.dim}>{message} · Esc to cancel</Text>
      </Box>
    );
  }

  const visible = options.slice(start, end);
  const labelPad = width >= 80 ? 18 : width >= 60 ? 16 : 12;
  const hintBudget = Math.max(8, width - labelPad - 12);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={t.accent}
      paddingX={1}
      marginY={0}
      width={width}
      flexShrink={0}
    >
      <Text color={t.accent} bold>
        {title}
        <Text color={t.dim}>
          {"  "}
          {index + 1}/{options.length}
        </Text>
      </Text>
      <Text color={t.dim}>
        {options.some((option) => option.kind === "group")
          ? "↑↓ move · Enter expand/select · Esc cancel"
          : "↑↓ move · Enter select · Esc cancel"}
      </Text>
      {filterQuery !== undefined ? (
        <Text color={t.dim} wrap="truncate-end">
          filter: {filterQuery || "(type to filter)"}
        </Text>
      ) : null}
      {start > 0 ? <Text color={t.dim}>  ↑ {start} more above…</Text> : null}
      {visible.map((opt, vi) => {
        const i = start + vi;
        const active = i === index;
        const isGroup = opt.kind === "group";
        const isCurrent = !isGroup && current === opt.value;
        const prefix = isGroup ? `${opt.expanded ? "▾" : "▸"} ` : "  ";
        const ranges = matchPickerOption(opt, filterQuery);
        const hint =
          opt.hint && opt.hint.length > hintBudget
            ? opt.hint.slice(0, hintBudget - 1) + "…"
            : opt.hint;
        return (
          <Box key={opt.value} width={Math.max(20, width - 4)}>
            <Text color={active ? t.accent : t.dim}>
              {active ? "› " : "  "}
            </Text>
            <Text color={active ? t.accent : isGroup ? t.accent : t.text} bold={active || isGroup}>
              {prefix}
            </Text>
            <HighlightedLabel
              text={opt.label.padEnd(Math.max(0, labelPad - prefix.length))}
              ranges={ranges}
              color={active ? t.accent : isGroup ? t.accent : t.text}
              matchColor={t.accent}
              bold={active || isGroup}
            />
            {hint && width >= 48 ? (
              <Text color={t.dim} wrap="truncate-end">
                {" "}
                {hint}
              </Text>
            ) : null}
            {isCurrent ? (
              <Text color={t.success}>  ← current</Text>
            ) : null}
          </Box>
        );
      })}
      {end < options.length ? (
        <Text color={t.dim}>
          {"  "}↓ {options.length - end} more below…
        </Text>
      ) : null}
    </Box>
  );
}
