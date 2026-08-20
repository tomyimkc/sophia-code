import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../lib/theme.js";
import type { SessionListItem } from "../lib/sessionStore.js";
import { sanitizeTerminalText } from "../lib/chatLayout.js";
import { truncateToWidth } from "../lib/textWidth.js";
import { windowFor } from "../lib/pickers.js";

/**
 * The human title for a session row: its topic (first genuine user message),
 * falling back to the last user preview, then the bare id — so a row is never
 * blank. Whitespace is collapsed because transcripts wrap prompts across lines.
 * Pure + exported so the contract is unit-tested without rendering Ink.
 */
export function sessionRowTitle(row: SessionListItem): string {
  return sanitizeTerminalText(row.description || row.lastPreview || row.id, true)
    .replace(/\s+/g, " ").trim() || sanitizeTerminalText(row.id, true).replace(/\s+/g, " ").trim();
}

/** Right-hand meta for a row: turn count + recency, e.g. "177 turns · 2h ago". */
export function sessionRowMeta(row: SessionListItem): string {
  return `${row.turns} turn${row.turns === 1 ? "" : "s"} · ${row.recency}`;
}

/** Why a content-search result matched, kept to one terminal row. */
export function sessionRowMatch(row: SessionListItem): string {
  if (!row.match) return "";
  const label = ({
    id: "session id",
    title: "title",
    topic: "topic",
    "last-user": "latest prompt",
    user: "user",
    assistant: "assistant",
    tool: "tool",
    system: "system",
  } as const)[row.match.field];
  const count = row.match.occurrences > 1 ? ` · ${row.match.occurrences} hits` : "";
  return `${label} · ${sanitizeTerminalText(row.match.preview, true).replace(/\s+/g, " ").trim()}${count}`;
}

export function sessionBrowserCopy(count: number, query?: string, totalMatches = count): {
  title: string;
  detail: string;
  empty: string;
} {
  const normalizedQuery = Array.from(sanitizeTerminalText(String(query || ""), true)
    .replace(/\s+/g, " ").trim()).slice(0, 80).join("");
  if (!normalizedQuery) {
    return {
      title: "Resume a session",
      detail: `${count} saved · ↑↓ select · Enter resume · Esc cancel`,
      empty: "No saved sessions yet — run something and it will show up here.",
    };
  }
  const countLabel = totalMatches > count
    ? `Top ${count} of ${totalMatches} matches`
    : `${count} match${count === 1 ? "" : "es"}`;
  return {
    title: "Search sessions",
    detail: `${countLabel} for “${normalizedQuery}” · ↑↓ select · Enter resume · Esc cancel`,
    empty: `No saved sessions match “${normalizedQuery}”.`,
  };
}

export function sessionBrowserInnerWidth(width: number): number {
  return Math.max(1, Math.floor(Number.isFinite(width) ? width : 1) - 2);
}

export function sessionBrowserCompactMode(height: number, headerLines = 0): boolean {
  if (!Number.isFinite(height)) return true;
  const headers = Math.max(0, Math.floor(Number.isFinite(headerLines) ? headerLines : 0));
  const effective = Math.floor(height) - headers - (headers > 0 ? 1 : 0);
  return effective < 9;
}

export function sessionBrowserShowMeta(width: number): boolean {
  return Number.isFinite(width) && width >= 48;
}

/**
 * The run-status header /status draws above the session list: what the harness
 * is doing right now (model/effort/mode), under what permission, in which
 * session and working directory. `effort` is the already-formatted label. Pure
 * + exported so the contract is unit-tested without rendering Ink, matching
 * sessionRowTitle/sessionRowMeta above.
 */
export function statusHeaderLines(parts: {
  model: string;
  effort: string;
  mode: string;
  permission: string;
  session: string;
  cwd: string;
}): string[] {
  return [
    `model=${parts.model}  effort=${parts.effort}  mode=${parts.mode}`,
    `permission=${parts.permission}  session=${parts.session}`,
    `cwd=${parts.cwd}`,
  ];
}

/**
 * Sophia session browser. Lists
 * past sessions: topic on the left, "N turns · recency" on the right, the
 * current session flagged, the cursor row marked with ›. Windowed with the
 * shared pickers.ts:windowFor math so a long history scrolls ("N more
 * above/below") instead of overflowing the terminal.
 *
 * PRESENTATION ONLY — ↑↓/Enter/Esc are owned by App.tsx and routed through
 * PromptInput's stable handleInput (onModalInput) plus a raw-stdin Enter
 * backup, exactly like the model/effort OptionPicker. Driving input from a
 * useInput here (or from App's inline global useInput) made Ink drop the
 * keystroke after every ↑↓ — PTYs coalesce a final arrow+Enter into one read
 * ("\x1b[B\r") and Ink parses only the first key, so the Enter vanished and you
 * could open the browser but never resume. The modal-picker path doesn't lose
 * it, so this component just draws `rows` with `selected` highlighted.
 */
export function SessionBrowser({
  theme,
  rows,
  selected,
  current,
  width,
  height,
  header,
  query,
  totalMatches,
}: {
  theme: Theme;
  rows: SessionListItem[];
  selected: number;
  current?: string;
  width: number;
  height: number;
  /** Optional dim lines drawn above the title — /status uses them for the
   * run-status header. Each line claims one row of the scrollable window. */
  header?: string[];
  /** Non-empty only for an explicit local full-transcript search. */
  query?: string;
  /** Full result count when rows is a capped top-N search projection. */
  totalMatches?: number;
}): React.ReactElement {
  const headerLines = header ?? [];
  const copy = sessionBrowserCopy(rows.length, query, totalMatches ?? rows.length);
  const searchMode = !!String(query || "").trim();
  const compact = sessionBrowserCompactMode(height, headerLines.length);
  // Header (title + blank) and footer (help + more-indicator slack) claim a few
  // lines; everything else is the scrollable window. Clamp so a very short
  // terminal still shows a usable list rather than a negative window. Any
  // /status header lines claim one row each too. Search rows use a second line
  // for match evidence, so halve their window rather than overflowing.
  const availableRows = height - (searchMode ? 7 : 6) - headerLines.length;
  const maxVisible = compact
    ? 1
    : searchMode
      ? Math.max(1, Math.floor(availableRows / 2))
      : Math.max(3, availableRows);
  const { start, end, index } = useMemo(
    () => windowFor(rows.length, selected, maxVisible),
    [rows.length, selected, maxVisible],
  );
  const innerWidth = sessionBrowserInnerWidth(width);
  const paddingX = width >= 4 ? 1 : 0;

  if (!rows.length) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={paddingX} justifyContent="center">
        <Text color={theme.accent} bold wrap="truncate-end">{truncateToWidth(copy.title, innerWidth)}</Text>
        {height >= 2 ? (
          <Text color={theme.dim} wrap="truncate-end">{truncateToWidth(copy.empty, innerWidth)}</Text>
        ) : null}
        {height >= 3 ? <Text color={theme.dim} wrap="truncate-end">{truncateToWidth("Esc to go back.", innerWidth)}</Text> : null}
      </Box>
    );
  }

  const visible = rows.slice(start, end);
  if (compact) {
    const row = rows[index] || rows[0];
    const title = `${searchMode ? "Search · " : ""}${index + 1}/${rows.length} · ${sessionRowTitle(row)}`;
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={paddingX}>
        <Text color={theme.accent} bold wrap="truncate-end">
          {truncateToWidth(`› ${title}`, innerWidth)}
        </Text>
        {row.match && height >= 2 ? (
          <Text color={theme.text} wrap="truncate-end">
            {truncateToWidth(`↳ ${sessionRowMatch(row)}`, innerWidth)}
          </Text>
        ) : null}
        {height >= 3 ? (
          <Text color={theme.dim} wrap="truncate-end">
            {truncateToWidth("Enter resume · Esc cancel", innerWidth)}
          </Text>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={paddingX}>
      {headerLines.length > 0 ? (
        <Box flexDirection="column">
          {headerLines.map((line, i) => (
            <Text key={i} color={theme.dim} wrap="truncate-end">
              {line}
            </Text>
          ))}
          <Box height={1} />
        </Box>
      ) : null}
      {searchMode ? (
        <Box flexDirection="column" width={innerWidth}>
          <Text color={theme.accent} bold>{copy.title}</Text>
          <Text color={theme.dim} wrap="truncate-end">{truncateToWidth(copy.detail, innerWidth)}</Text>
        </Box>
      ) : (
        <Box width={innerWidth}>
          <Text color={theme.accent} bold>{copy.title}</Text>
          <Text color={theme.dim} wrap="truncate-end">
            {"  "}{truncateToWidth(copy.detail, Math.max(1, innerWidth - copy.title.length - 2))}
          </Text>
        </Box>
      )}
      <Box height={1} />
      {start > 0 ? <Text color={theme.dim}>  ↑ {start} more above…</Text> : null}
      <Box flexDirection="column">
        {visible.map((row, vi) => {
          const i = start + vi;
          const active = i === index;
          const isCurrent = current === row.id;
          const title = sessionRowTitle(row);
          const meta = sessionRowMeta(row);
          // Highlight with accent colour + bold + the › marker (OptionPicker's
          // recipe). Works in mono/NO_COLOR too: accent "" → default colour, and
          // the › marker + bold still mark the cursor row.
          const titleColor = active ? theme.accent : theme.text;
          return (
            <Box key={row.id} width={innerWidth} flexDirection="column">
              <Box width={innerWidth} justifyContent="space-between">
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={titleColor} bold={active} wrap="truncate-end">
                    {(active ? "› " : "  ") + title + (isCurrent ? "  ● current" : "")}
                  </Text>
                </Box>
                {sessionBrowserShowMeta(innerWidth) ? <Box flexShrink={0}>
                  <Text color={active ? theme.accent : theme.dim}> {meta}</Text>
                </Box> : null}
              </Box>
              {row.match ? (
                <Text color={active ? theme.text : theme.dim} wrap="truncate-end">
                  {`  ↳ ${sessionRowMatch(row)}`}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {end < rows.length ? <Text color={theme.dim}>  ↓ {rows.length - end} more below…</Text> : null}
      <Box height={1} />
      <Text color={theme.dim} wrap="truncate-end">
        Enter restores the highlighted session's full history · Esc returns without changing anything
      </Text>
    </Box>
  );
}
