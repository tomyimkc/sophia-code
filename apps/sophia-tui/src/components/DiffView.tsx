import React from "react";
import { Box, Text } from "ink";

import { accessibleTheme } from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import type { Theme } from "../lib/theme.js";
import { sanitizeToolText } from "../lib/toolOutput.js";
import { truncateToWidth } from "../lib/textWidth.js";
import { MatrixText } from "./MatrixText.js";

export type DiffLineKind = "file" | "hunk" | "add" | "remove" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffPreview {
  lines: DiffLine[];
  files: number;
  additions: number;
  deletions: number;
  omittedLines: number;
  truncated: boolean;
  statsComplete: boolean;
}

export interface DiffPreviewOptions {
  maxLines?: number;
  maxFiles?: number;
  maxHunks?: number;
  maxColumns?: number;
  scanLimit?: number;
}

const DEFAULT_SCAN_LIMIT = 256 * 1024;

export function isUnifiedDiff(input: unknown): boolean {
  const prefix = sanitizeToolText(input, true, 8_192);
  return (
    /(^|\n)diff --git /.test(prefix) ||
    /(^|\n)@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(prefix) ||
    (/(^|\n)--- [^\n]+/.test(prefix) && /(^|\n)\+\+\+ [^\n]+/.test(prefix))
  );
}

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith(" ") || line === "") return "context";
  return "meta";
}

/**
 * Parse only a bounded prefix of a unified diff. Stats are explicitly marked
 * incomplete if the input exceeded the scan cap; the UI never fabricates full
 * addition/deletion totals from a partial scan.
 */
export function buildDiffPreview(
  input: unknown,
  options: DiffPreviewOptions = {},
): DiffPreview {
  const raw = String(input ?? "");
  const scanLimit = Math.max(1_024, options.scanLimit ?? DEFAULT_SCAN_LIMIT);
  const scannedAll = raw.length <= scanLimit;
  const safe = sanitizeToolText(raw, true, scanLimit);
  const sourceLines = safe.split("\n");
  const maxLines = Math.max(1, options.maxLines ?? 24);
  const maxFiles = Math.max(1, options.maxFiles ?? 6);
  const maxHunks = Math.max(1, options.maxHunks ?? 12);
  const maxColumns = Math.max(16, options.maxColumns ?? 180);

  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  let currentFile = "";
  const files = new Set<string>();
  const lines: DiffLine[] = [];
  let skippedByBounds = 0;

  for (const line of sourceLines) {
    const kind = classifyLine(line);
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match?.[2] || line;
      files.add(currentFile);
    } else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      currentFile = line.replace(/^\+\+\+\s+(?:b\/)?/, "");
      files.add(currentFile);
    }
    if (kind === "hunk") hunks += 1;
    if (kind === "add") additions += 1;
    if (kind === "remove") deletions += 1;

    const withinStructuralBounds =
      files.size <= maxFiles &&
      hunks <= maxHunks;
    if (!withinStructuralBounds || lines.length >= maxLines) {
      skippedByBounds += 1;
      continue;
    }
    lines.push({
      kind,
      text: truncateToWidth(line, maxColumns),
    });
  }

  const unscannedTail = scannedAll ? 0 : 1;
  const omittedLines = skippedByBounds + unscannedTail;
  return {
    lines,
    files: files.size,
    additions,
    deletions,
    omittedLines,
    truncated: omittedLines > 0,
    statsComplete: scannedAll,
  };
}

export function diffPreviewLineCount(preview: DiffPreview): number {
  return 1 + preview.lines.length + (preview.truncated ? 1 : 0);
}

function lineColor(kind: DiffLineKind, theme: Theme): string {
  if (kind === "add") return theme.success;
  if (kind === "remove") return theme.error;
  if (kind === "hunk" || kind === "file") return theme.accent;
  return theme.dim;
}

export function DiffView({
  diff,
  preview: suppliedPreview,
  theme,
  width,
  maxLines = 24,
  topClip = 0,
  bottomClip = 0,
  selected = false,
  animateOnMount = false,
}: {
  diff?: string;
  preview?: DiffPreview;
  theme: Theme;
  width: number;
  maxLines?: number;
  topClip?: number;
  bottomClip?: number;
  selected?: boolean;
  /** Reveal only genuinely new/live diffs; resumed history stays still. */
  animateOnMount?: boolean;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const preview =
    suppliedPreview ??
    buildDiffPreview(diff ?? "", {
      maxLines,
      maxColumns: Math.max(16, width - 4),
    });
  const statsQualifier = preview.statsComplete ? "" : " scanned";
  const statsText =
    `diff · ${preview.files} file${preview.files === 1 ? "" : "s"}`
    + ` · +${preview.additions} -${preview.deletions}${statsQualifier}`;
  const rows: React.ReactElement[] = [
    <Text key="stats" color={t.accent} wrap="truncate-end" inverse={selected}>
      <MatrixText text={statsText} animateOnMount={animateOnMount} seed={401} />
    </Text>,
    ...preview.lines.map((line, index) => (
      <Text
        key={`${index}:${line.kind}`}
        color={lineColor(line.kind, t)}
        wrap="truncate-end"
        inverse={selected}
      >
        <MatrixText
          text={line.text || " "}
          animateOnMount={animateOnMount}
          seed={419 + index}
        />
      </Text>
    )),
    ...(preview.truncated
      ? [
        <Text key="bounded" color={t.dim} wrap="truncate-end" inverse={selected}>
          <MatrixText
            text={`… bounded diff preview · ${preview.omittedLines} or more line${
              preview.omittedLines === 1 ? "" : "s"
            } omitted`}
            animateOnMount={animateOnMount}
            seed={503}
          />
        </Text>,
      ]
      : []),
  ];

  return (
    <Box flexDirection="column" width={width}>
      {rows.slice(
        Math.max(0, topClip),
        Math.max(Math.max(0, topClip), rows.length - Math.max(0, bottomClip)),
      )}
    </Box>
  );
}
