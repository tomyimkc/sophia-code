import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { displayWidth, graphemes } from "../components/PromptInput.js";

export interface TerminalSize {
  columns: number;
  rows: number;
  /** Usable content width after horizontal padding (paddingX=1 → −2). */
  contentWidth: number;
}

const MIN_COLS = 40;
const MIN_ROWS = 12;
const PAD_X = 1; // matches App paddingX

/**
 * Live terminal dimensions. Ink's stdout snapshot is static unless we
 * subscribe to `resize` — without this, expanding the window leaves the
 * layout stuck at the launch size.
 */
export function useTerminalSize(padX: number = PAD_X): TerminalSize {
  const { stdout } = useStdout();

  const read = (): TerminalSize => {
    const rawColumns = Number(stdout?.columns ?? process.stdout?.columns ?? 80);
    const rawRows = Number(stdout?.rows ?? process.stdout?.rows ?? 24);
    const columns = Math.max(MIN_COLS, Number.isFinite(rawColumns) && rawColumns > 0 ? rawColumns : 80);
    const rows = Math.max(MIN_ROWS, Number.isFinite(rawRows) && rawRows > 0 ? rawRows : 24);
    const contentWidth = Math.max(20, columns - padX * 2);
    return { columns, rows, contentWidth };
  };

  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    const onResize = () => setSize(read());
    // Node WriteStream emits 'resize' when the TTY is resized.
    stdout?.on?.("resize", onResize);
    process.stdout?.on?.("resize", onResize);
    // Some terminals only fire on process.stdout; re-sync once after mount.
    onResize();
    return () => {
      stdout?.off?.("resize", onResize);
      process.stdout?.off?.("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-bind when stream identity changes
  }, [stdout]);

  return size;
}

/** Horizontal rule that always spans the current content width. */
export function hr(width: number, ch = "─"): string {
  return ch.repeat(Math.max(8, width));
}

/**
 * Truncate a path / status string to fit width, keeping the useful tail.
 * Slices by grapheme cluster, not UTF-16 code unit: a raw `.slice()` on a
 * string containing an astral character (most emoji are surrogate pairs) or
 * a combining/ZWJ sequence can cut it in half, leaving a lone surrogate that
 * renders as a broken glyph. Confirmed via direct repro on an emoji cwd/status.
 */
export function ellipsizeEnd(s: string, max: number): string {
  if (max <= 1) return "…";
  const units = graphemes(s);
  if (units.length <= max) return s;
  if (max <= 2) return units.slice(0, max).join("");
  return "…" + units.slice(-(max - 1)).join("");
}

/**
 * Shorten a model spec to fit `budget` columns, preferring a meaningful
 * basename over a mid-string ellipsis.
 *
 * A full on-disk path like `mlx:/Users/tom/Models/mlx/Qwen3.6-35B-A3B-4bit`
 * is mostly directory noise in a persistent status row — the leaf segment is
 * what actually distinguishes one loaded model from another day to day.
 * Basename-first shortening is a generic terminal convention for preserving
 * identity under a tight width budget. Falls through to `ellipsizeEnd` only
 * when even the basename alone
 * doesn't fit — and leaves non-path specs (`mock`, `zai`, `codex-api`, a bare
 * `Opus`-style display name) untouched whenever they already fit `budget`.
 */
export function modelDisplayName(model: string, budget: number): string {
  if (!model) return model;
  if (displayWidth(model) <= budget) return model;
  // A local endpoint spec — "vllm:<model>@http://127.0.0.1:8000/v1" — is the one
  // shape where the basename rule picks exactly the wrong segment: the leaf of
  // the BASE URL is the API version, so the status row read "v1" and the
  // operator could not tell which local model was answering. Everything after
  // the first '@' is an endpoint, never an identity, so drop it before applying
  // the path rule (a model id never contains '@').
  const identity = model.includes("@") ? model.slice(0, model.indexOf("@")) : model;
  if (identity !== model && displayWidth(identity) <= budget) return identity;
  const parts = identity.split(/[\\/]+/).filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : identity;
  if (base !== model && displayWidth(base) <= budget) return base;
  return ellipsizeEnd(base, budget);
}
