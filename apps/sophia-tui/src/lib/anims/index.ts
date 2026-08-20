/**
 * Pure animation package (handoff §5): the only index the Ink
 * LoadingIndicator (and the browser demo's transpiled copy) imports from.
 * Everything here is React/Ink-free, timer-free and deterministic.
 */
export type { Cell, Frame, Row, AnimInstance, AnimFactory } from "./types.js";
export { LINE_HEIGHT, LOAD_HEIGHT } from "./types.js";
export {
  MATRIX_GLYPHS,
  SHADE,
  glyph,
  shade,
  light,
  clamp01,
  spaceCell,
  emptyFrame,
  cellColor,
  coalesceRuns,
  LIVE_TOKEN_RGB,
  STABLE_TEXT_RGB,
  type CellRun,
} from "./cells.js";
export {
  LIFE,
  LOCK_BASE,
  renderMatrixDecode,
  renderDecode,
  DECODE_STYLES,
  DECODE_STYLE_IDS,
  DEFAULT_DECODE_STYLE,
  tokenize,
  EMPTY_FRONTIER,
  advanceFrontier,
  tickFrontier,
  shimmerLabel,
  matrixStream,
  shimmerCursor,
  type FrontierState,
  type DecodeStyle,
} from "./line.js";
export {
  LOAD_ANIMS,
  LOAD_ANIM_IDS,
  DEFAULT_LOAD_ANIM,
  DEFAULT_FIELD_ANIM,
  makeLoadAnim,
} from "./load3d.js";
export {
  selectAnim,
  TOOL_LOAD_THRESHOLD_SEC,
  STARTING_LOAD_THRESHOLD_SEC,
  LOAD_FIELD_ESCALATION_SEC,
  type AnimJob,
  type AnimSelection,
} from "./select.js";
export {
  MATRIX_REVEAL_CHURN_DELAY_MS,
  MATRIX_REVEAL_MIN_PRESENTATION_TPS,
  MATRIX_REVEAL_MAX_PRESENTATION_TPS,
  MATRIX_REVEAL_MIN_COMMIT_TICKS,
  MATRIX_REVEAL_MAX_COMMIT_TICKS,
  MATRIX_REVEAL_CURSOR_TAIL,
  MATRIX_REVEAL_MIN_BURST,
  MATRIX_REVEAL_MAX_BURST,
  MATRIX_REVEAL_COLOR,
  MATRIX_REVEAL_PENDING_FRAME,
  commonGraphemePrefix,
  matrixRevealFramesRequired,
  matrixRevealFramesBySegment,
  matrixRevealDelayMs,
  matrixRevealCommitTicks,
  matrixRevealBurstSize,
  createMatrixRevealState,
  syncMatrixRevealState,
  advanceMatrixRevealState,
  matrixRevealCells,
  matrixRevealRuns,
  type MatrixRevealCell,
  type MatrixRevealRun,
  type MatrixRevealState,
} from "./reveal.js";
