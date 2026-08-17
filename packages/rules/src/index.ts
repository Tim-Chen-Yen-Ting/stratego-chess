/**
 * @xiyang/rules — public surface. Re-exports only; no logic lives here.
 *
 * The contract is techspec_v01.md §4. Everything a consumer needs:
 *
 *   createGame · validateAssignment · defaultAssignment · submitAssignment
 *   legalMoves · applyMove · resign · flagFall
 *   stateForViewer   ← the ONLY sanctioned way to serialise state
 *   renderForLLM
 */

// ---------- types (§3) ----------
export type {
  Carrier,
  CombatOutcome,
  Color,
  GameConfig,
  GameEvent,
  GameState,
  GameStatus,
  Move,
  Piece,
  PieceId,
  Rank,
  RankDistribution,
  Result,
  Square,
  Viewer,
  ViewerPiece,
  ViewerState,
} from './types.js'

// ---------- constants (§3) ----------
// 兵種數量配置 is a 附錄 B tunable: `DISTRIBUTION_*` are PRESETS to configure a
// game with, and `DISTRIBUTION` is the default one. Anything that validates,
// counts or explains a deployment reads `config.distribution`.
export { carrierMoves, reachableSquares } from './publicmoves.js'

export {
  ALL_COLORS,
  ALL_RANKS,
  BOMB_IMMUNE,
  CARRIER_LETTER,
  CARRIER_NAMES_ZH,
  CENTER_SQUARES,
  DEFAULT_ASSIGNMENT_BY_HOME_SQUARE,
  DEFAULT_CONFIG,
  DISTRIBUTION,
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  PIECES_PER_SIDE,
  RANK_NAMES_ZH,
  RANK_ORDER,
  SCORING_CENTRE_4,
  SCORING_WIDE_8,
  checkDistribution,
  distributionTotal,
} from './constants.js'

// ---------- board helpers ----------
export {
  FILES,
  RANKS,
  buildOccupancy,
  castlePlan,
  fileOf,
  forwardDir,
  inBounds,
  makeSquare,
  onBoard,
  opposite,
  parseSquare,
  pawnDoubleStepRank,
  pawnHomeRank,
  pieceAt,
  promotionRank,
  rankOf,
  squareName,
} from './board.js'
export type { CastlePlan, Occupancy } from './board.js'

// ---------- setup (§9) ----------
export {
  STARTING_LAYOUT,
  createGame,
  defaultAssignment,
  defaultRankByHomeKey,
  homeKeySquare,
  startingSlot,
  submitAssignment,
  validateAssignment,
} from './setup.js'
export type { StartingSlot } from './setup.js'

// ---------- setup codes (§9) — the ONE implementation of the 16-char format ----------
// The alphabet is fixed; the required COUNTS are per game, so the four
// `setupCode*` functions take a distribution. The `SETUP_CODE_*` constants are
// the default preset's values, for display code with no game in hand.
export {
  SETUP_CODE_ALPHABET,
  SETUP_CODE_COMBINATIONS,
  SETUP_CODE_EXAMPLE,
  SETUP_CODE_LEGEND,
  SETUP_CODE_LENGTH,
  decodeSetupCode,
  encodeSetupCode,
  setupCodeCombinations,
  setupCodeCountsText,
  setupCodeExample,
  setupCodeLegend,
  setupCodeLength,
  setupCodeSlots,
} from './setupcode.js'
export type { SetupCodeLegendEntry, SetupCodeResult, SetupCodeSource } from './setupcode.js'

// ---------- moves (§3) ----------
export {
  PROMOTION_CHOICES,
  enPassantInfo,
  generatePieceMoves,
  hasAnyPieceMove,
  legalMoves,
  matchMove,
  moveToNotation,
  parseMoveNotation,
} from './moves.js'
export type { EnPassantInfo, PromotionCarrier, ResolvedMove } from './moves.js'

// ---------- combat (§4, §5) ----------
export { isBombImmune, rankOrder, resolveCombat, resolvePieceCombat } from './combat.js'
export type { CombatResolution } from './combat.js'

// ---------- game loop (§4, §6, §7, §8) ----------
// `scoringPoints` / `scoringSquares` take the game's config; `centerPoints` /
// `centerSquares` are their deprecated former names.
export {
  applyMove,
  centerPoints,
  centerSquares,
  flagFall,
  isGameOver,
  resign,
  scoringPoints,
  scoringSquares,
  tickClock,
} from './game.js'

// ---------- redaction (§10) — THE security boundary ----------
export { entitledToRank, stateForViewer, viewerColor } from './redact.js'

// ---------- rendering (§6) ----------
export { renderForLLM, renderRulesForLLM } from './render/text.js'
export type { RenderOptions } from './render/text.js'

// ---------- 棋譜 export (§10 紀錄給，解算不給) ----------
// Pure functions over a ViewerState, so the server can reuse them as-is.
export { exportJson, exportMarkdown, gameStats } from './render/record.js'
export type {
  BombsLost,
  Deployment,
  DeploymentPiece,
  GameStats,
  MutualDestruction,
  ObjectiveMoves,
  PeakHold,
  PieceRun,
  RecordJson,
  RecordMoveJson,
  SideStats,
  ZeroRun,
} from './render/record.js'
