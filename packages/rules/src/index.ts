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
  Result,
  Square,
  Viewer,
  ViewerPiece,
  ViewerState,
} from './types.js'

// ---------- constants (§3) ----------
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
  RANK_NAMES_ZH,
  RANK_ORDER,
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
  homeKeySquare,
  startingSlot,
  submitAssignment,
  validateAssignment,
} from './setup.js'
export type { StartingSlot } from './setup.js'

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
export {
  applyMove,
  centerPoints,
  centerSquares,
  flagFall,
  isGameOver,
  resign,
  tickClock,
} from './game.js'

// ---------- redaction (§10) — THE security boundary ----------
export { entitledToRank, stateForViewer, viewerColor } from './redact.js'

// ---------- rendering (§6) ----------
export { renderForLLM, renderRulesForLLM } from './render/text.js'
export type { RenderOptions } from './render/text.js'
