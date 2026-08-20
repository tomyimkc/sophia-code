import React from "react";
import { Box, Text } from "ink";

import {
  accessibleTheme,
  type AccessibilityPrefs,
} from "../lib/accessibility.js";
import { useAccessibility } from "../lib/AccessibilityContext.js";
import type { Theme } from "../lib/theme.js";
import {
  approvalRequestFromLegacy,
  legacyApprovalChoices,
  type ApprovalChoice,
  type PermissionRequest,
  type ToolRisk,
} from "../lib/toolState.js";
import { formatToolArgs, sanitizeToolText } from "../lib/toolOutput.js";
import { truncateToWidth } from "../lib/textWidth.js";
import { wrapTextLines } from "../lib/chatLayout.js";
import { buildDiffPreview, DiffView, type DiffPreview } from "./DiffView.js";

/**
 * Kept well under a typical 24-row terminal so the choices line — the one
 * thing an operator must be able to see to act at all — never scrolls off
 * screen behind a long diff. The kernel already caps a diff at 200 lines /
 * 4000 chars (agent/diff_preview.py) before it ever reaches this dialog;
 * this second, tighter cap is about the height of the *prompt*, not the
 * safety of the diff text itself.
 */
const MAX_DIALOG_DIFF_LINES = 8;

/** Same reasoning as MAX_DIALOG_DIFF_LINES, applied to a wrapped command block. */
const MAX_DIALOG_COMMAND_LINES = 6;

/**
 * Mirrors agent/agent_tools.py's `_COMMAND_LIKE_ARG_NAMES`: the argument
 * names a bash-style (or bash-shaped plugin) tool call conventionally uses
 * to carry the literal command/query text an operator needs to read in full
 * before approving it. Deliberately excludes write_file/edit_file's
 * path/content/old/new for the same reason the kernel list does — those
 * hold a file's literal content, not a command to run.
 */
const COMMAND_LIKE_ARG_NAMES = ["command", "cmd", "sql", "query", "script", "shell"];

export interface PermissionDialogViewModel {
  request: PermissionRequest;
  choices: readonly ApprovalChoice[];
  toolLine: string;
  cwdLine: string;
  previewLine: string;
  choicesLine: string;
  /** Kernel-authoritative "safe"|"write"|"exec" when supplied, else the client guess. */
  riskLabel: string;
  destructive: boolean;
  destructiveLine: string;
  /** Non-null only when a real diff was supplied and bounded for this dialog's height. */
  diffPreview: DiffPreview | null;
  /** Wrapped, un-truncated command text for a bash-style tool; empty when none applies. */
  commandLines: string[];
  commandOmittedLines: number;
  /** Non-empty only when the caller wired onAlwaysAllowTool and no choice already offers it. */
  alwaysAllowLine: string;
}

export function permissionBorderStyle(
  prefs: AccessibilityPrefs,
): "round" | undefined {
  return prefs.screenReader ? undefined : "round";
}

function scopeLabel(choice: ApprovalChoice): string {
  if (choice.scope.kind === "call") return choice.label;
  if (choice.scope.kind === "tool") return `${choice.label} (${choice.scope.tool})`;
  if (choice.scope.kind === "cwd") return `${choice.label} (${choice.scope.cwd})`;
  return choice.label;
}

function extractCommandText(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of COMMAND_LIKE_ARG_NAMES) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * Word-wrap the exact command text to `width` columns, bounded to `maxLines`
 * with an explicit omitted-line count — never a hard single-line cut. Newlines
 * in the source (e.g. a heredoc) are preserved rather than collapsed, so what
 * an operator reads is the real command shape, not a flattened approximation.
 */
export function wrapCommandForDialog(
  command: string,
  width: number,
  maxLines: number = MAX_DIALOG_COMMAND_LINES,
): { lines: string[]; omittedLines: number } {
  const safe = sanitizeToolText(command, true, 8_192);
  const wrapped = wrapTextLines(safe, Math.max(8, width));
  if (wrapped.length <= maxLines) return { lines: wrapped, omittedLines: 0 };
  return { lines: wrapped.slice(0, maxLines), omittedLines: wrapped.length - maxLines };
}

/**
 * The kernel's own coarse risk category ("safe"/"write"/"exec", from the
 * tool's registered ToolSpec) is authoritative — it did not come from
 * guessing over the call's rendered arguments the way `inferToolRisk` does.
 * `inferToolRisk`'s five-level guess stays the fallback for a caller that
 * never receives a kernel risk at all (agent/cli.py, or an older bridge).
 */
export function resolveDisplayRisk(guessed: ToolRisk, kernelRisk?: string): string {
  const trimmed = (kernelRisk ?? "").trim().toLowerCase();
  return trimmed || guessed;
}

function riskColor(risk: string, theme: Theme): string {
  if (risk === "critical" || risk === "high" || risk === "exec") return theme.error;
  if (risk === "medium" || risk === "write") return theme.warn;
  if (risk === "low" || risk === "safe") return theme.success;
  return theme.dim;
}

function choicesOfferToolScope(choices: readonly ApprovalChoice[]): boolean {
  return choices.some((choice) => choice.scope.kind === "tool");
}

/**
 * A short, additive hint offered only when the caller wired a real
 * onAlwaysAllowTool callback AND the supplied choices don't already carry a
 * tool-scoped entry (scopedApprovalChoices' own "allow tool for session")
 * — showing both would tell the operator two different keys do the same
 * thing.
 */
function alwaysAllowLineFor(
  tool: string,
  hasCallback: boolean,
  choices: readonly ApprovalChoice[],
): string {
  if (!hasCallback || choicesOfferToolScope(choices)) return "";
  return `[a] always allow ${tool} for this session`;
}

/**
 * Whether a raw keypress should trigger the session-scoped "always allow
 * this tool" action advertised by `alwaysAllowLine`. A pure predicate
 * rather than a bound handler: this component never owns stdin (see
 * SessionBrowser.tsx's note on why a modal-style panel here stays
 * presentation-only — a second `useInput` in a picture like this one has
 * previously dropped a coalesced PTY keystroke), so the actual dispatch has
 * to live in whatever owns the real input loop today.
 */
export function isAlwaysAllowToolKey(inputKey: string, hasAlwaysAllowHint: boolean): boolean {
  return hasAlwaysAllowHint && inputKey.toLowerCase() === "a";
}

export function buildPermissionDialogViewModel(args: {
  tool: string;
  preview: string;
  width: number;
  request?: PermissionRequest;
  choices?: readonly ApprovalChoice[];
  diff?: string;
  risk?: string;
  destructive?: boolean;
  onAlwaysAllowTool?: (tool: string) => void;
}): PermissionDialogViewModel {
  const request = args.request ?? approvalRequestFromLegacy({
    tool: args.tool,
    preview: args.preview,
  });
  const choices = args.choices ?? legacyApprovalChoices(request);
  const bodyWidth = Math.max(16, args.width - 4);
  const riskLabel = resolveDisplayRisk(request.risk, args.risk);
  const destructive = Boolean(args.destructive);
  const toolLine = truncateToWidth(
    `${sanitizeToolText(request.tool, false, 256)} · risk ${riskLabel}`,
    bodyWidth,
  );
  const cwdLine = request.cwd
    ? truncateToWidth(`cwd · ${sanitizeToolText(request.cwd, false, 2_048)}`, bodyWidth)
    : "";
  const previewSource = request.args ?? request.preview;
  const preview = formatToolArgs(previewSource, Math.max(16, bodyWidth - 10));
  const previewLine = truncateToWidth(
    `${request.reason ? `${sanitizeToolText(request.reason, false, 512)} · ` : ""}${preview || "(no arguments)"}`,
    bodyWidth,
  );
  const choicesLine = truncateToWidth(
    choices.map((choice) => `[${sanitizeToolText(choice.key, false, 8)}] ${sanitizeToolText(scopeLabel(choice), false, 512)}`).join(" · "),
    bodyWidth,
  );
  const diffText = sanitizeToolText(args.diff ?? "", true, 8_192).trim();
  const diffPreview = diffText
    ? buildDiffPreview(diffText, { maxLines: MAX_DIALOG_DIFF_LINES, maxColumns: Math.max(16, bodyWidth - 2) })
    : null;
  const rawCommand = diffPreview ? "" : extractCommandText(request.args);
  const { lines: commandLines, omittedLines: commandOmittedLines } = rawCommand
    ? wrapCommandForDialog(rawCommand, Math.max(16, bodyWidth - 2))
    : { lines: [] as string[], omittedLines: 0 };
  const destructiveLine = destructive
    ? "DESTRUCTIVE — this cannot be undone. Read carefully before choosing allow."
    : "";
  const alwaysAllowLine = alwaysAllowLineFor(request.tool, Boolean(args.onAlwaysAllowTool), choices);
  return {
    request,
    choices,
    toolLine,
    cwdLine,
    previewLine,
    choicesLine,
    riskLabel,
    destructive,
    destructiveLine,
    diffPreview,
    commandLines,
    commandOmittedLines,
    alwaysAllowLine,
  };
}

/**
 * Backward-compatible with App.tsx's {tool, preview, width} contract.
 *
 * The optional diff/risk/destructive/onAlwaysAllowTool props let a caller
 * that already has the kernel's richer approval_request fields (diff, risk,
 * destructive — see agent/code_bridge.py's approval_request event) surface
 * them here instead of the bounded one-line preview. None of them are
 * required, so the existing App.tsx render site keeps compiling and
 * behaving exactly as before until it is updated to pass them.
 */
export function PermissionDialog({
  theme,
  tool,
  preview,
  width,
  request,
  choices,
  diff,
  risk,
  destructive,
  onAlwaysAllowTool,
}: {
  theme: Theme;
  tool: string;
  preview: string;
  width: number;
  request?: PermissionRequest;
  choices?: readonly ApprovalChoice[];
  diff?: string;
  risk?: string;
  destructive?: boolean;
  onAlwaysAllowTool?: (tool: string) => void;
}): React.ReactElement {
  const ax = useAccessibility();
  const t = accessibleTheme(theme, ax);
  const model = buildPermissionDialogViewModel({
    tool,
    preview,
    width,
    request,
    choices,
    diff,
    risk,
    destructive,
    onAlwaysAllowTool,
  });
  const bodyWidth = Math.max(16, width - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle={permissionBorderStyle(ax)}
      borderColor={model.destructive ? t.error : t.warn}
      paddingX={1}
      width={width}
      flexShrink={0}
    >
      <Text color={t.warn} bold wrap="truncate-end">
        Permission required · review scope before allowing
      </Text>
      <Text color={riskColor(model.riskLabel, t)} bold wrap="truncate-end">
        {model.toolLine}
      </Text>
      {model.destructiveLine ? (
        <Text color={t.error} bold wrap="truncate-end">
          {model.destructiveLine}
        </Text>
      ) : null}
      {model.cwdLine ? (
        <Text color={t.dim} wrap="truncate-end">
          {model.cwdLine}
        </Text>
      ) : null}
      {model.diffPreview ? (
        <DiffView preview={model.diffPreview} theme={theme} width={bodyWidth} />
      ) : model.commandLines.length > 0 ? (
        <Box flexDirection="column">
          <Text color={t.dim} wrap="truncate-end">cmd ·</Text>
          {model.commandLines.map((line, index) => (
            <Text key={index} color={t.text} wrap="truncate-end">
              {line}
            </Text>
          ))}
          {model.commandOmittedLines > 0 ? (
            <Text color={t.dim} wrap="truncate-end">
              … {model.commandOmittedLines} more line{model.commandOmittedLines === 1 ? "" : "s"} not shown
            </Text>
          ) : null}
        </Box>
      ) : (
        <Text color={t.dim} wrap="truncate-end">
          args · {model.previewLine}
        </Text>
      )}
      {model.alwaysAllowLine ? (
        <Text color={t.dim} wrap="truncate-end">
          {model.alwaysAllowLine}
        </Text>
      ) : null}
      <Text color={t.text} wrap="truncate-end">
        {model.choicesLine}
      </Text>
    </Box>
  );
}
