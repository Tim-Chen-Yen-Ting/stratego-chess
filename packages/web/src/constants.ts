import { CENTER_SQUARES, DEFAULT_CONFIG, DISTRIBUTION, SCORING_WIDE_8 } from '@xiyang/rules'
import type { Carrier, Color, GameConfig, Rank, Square } from '@xiyang/rules'

/**
 * Display data for the client — labels and glyphs, nothing else.
 *
 * The two NORMATIVE tables the UI needs (the §2 piece-count table for the setup
 * tray, and the §7 scoring squares behind the board highlight) come straight
 * from `@xiyang/rules`, never copied. 附錄 B calls the piece counts a tunable
 * parameter: a local copy would silently disagree with the engine the moment
 * anyone tuned it, and the setup screen would then offer a pool that
 * `validateAssignment` rejects. Re-exporting a constant is not "implementing
 * rules" (techspec §7) — no legality, combat or scoring decision happens here.
 */

export { CENTER_SQUARES, DISTRIBUTION }

// ---------------------------------------------------------------------------
// 計分區 (gamebook §7, 附錄 B)
// ---------------------------------------------------------------------------

/**
 * 附錄 B lists the scoring area among the tunables, so it is a property of the
 * GAME, not of the build: `config.scoringSquares` is what actually scores, and
 * anything that PAINTS the scoring area must read it from there. A module
 * constant would keep highlighting d4 e4 d5 e5 on a board where a4 and h5 also
 * score — the UI would then be lying about the rules in force.
 *
 * The parameter is widened because `config.scoringSquares` is newer than some
 * of the payloads that may arrive: a state from a server that predates the
 * field falls back to the engine's four, which is exactly what such a server is
 * scoring. This reads a config field; it does not decide one. The server still
 * settles every ply (techspec §7).
 */
export type ScoringConfig = GameConfig & { readonly scoringSquares?: readonly Square[] }

/**
 * Returns the SAME array reference on every call for a given config, so this is
 * safe inside a zustand selector (a fresh array each render would break the
 * snapshot-stability contract).
 */
export function scoringSquaresOf(config: ScoringConfig): readonly Square[] {
  // Fall back only when the field is ABSENT. A game deliberately configured with
  // an empty list scores nowhere, and painting the centre four would be a lie —
  // the LLM renderer already states the empty case honestly.
  return config.scoringSquares ?? CENTER_SQUARES
}

export type ScoringAreaId = 'center' | 'wide'

// The rules package builds SCORING_WIDE_8 from square NAMES precisely because an
// off-by-one in these indices is invisible and would corrupt every score. Import
// it rather than restating the numbers here.

export interface ScoringAreaPreset {
  id: ScoringAreaId
  label: string
  squares: readonly Square[]
  /**
   * Multiplier on the default 目標分數 X. Twice the scoring area accrues points
   * at roughly twice the rate, so the default finish line moves with it; 附錄 B
   * calls X the length of the game, and this keeps that length comparable. It
   * is only a DEFAULT — the player may type anything over it.
   */
  scoreTargetFactor: number
}

/** The presets the Create screen offers. Order is display order. */
export const SCORING_AREA_IDS: readonly ScoringAreaId[] = ['center', 'wide']

export const SCORING_AREAS: Record<ScoringAreaId, ScoringAreaPreset> = {
  center: {
    id: 'center',
    label: '中央四格',
    squares: scoringSquaresOf(DEFAULT_CONFIG),
    scoreTargetFactor: 1,
  },
  wide: {
    id: 'wide',
    label: '中央＋側翼八格',
    squares: SCORING_WIDE_8,
    scoreTargetFactor: 2,
  },
}

/** Tray / display order: rank 1 down to 10, then the rankless bomb. */
export const RANKS_IN_ORDER: readonly Rank[] = [
  'commander',
  'general',
  'division',
  'brigade',
  'regiment',
  'battalion',
  'company',
  'platoon',
  'engineer',
  'flag',
  'bomb',
]

export const RANK_LABEL: Record<Rank, string> = {
  commander: '司令',
  general: '軍長',
  division: '師長',
  brigade: '旅長',
  regiment: '團長',
  battalion: '營長',
  company: '連長',
  platoon: '排長',
  engineer: '工兵',
  flag: '軍旗',
  bomb: '爆裂物',
}

/** Shown next to the label so the pecking order is readable at a glance. */
export const RANK_NUMBER_LABEL: Record<Rank, string> = {
  commander: '1',
  general: '2',
  division: '3',
  brigade: '4',
  regiment: '5',
  battalion: '6',
  company: '7',
  platoon: '8',
  engineer: '9',
  flag: '10',
  bomb: '＝',
}

export const CARRIER_LABEL: Record<Carrier, string> = {
  pawn: '兵 pawn',
  knight: '馬 knight',
  bishop: '象 bishop',
  rook: '車 rook',
  queen: '后 queen',
  king: '王 king',
}

/** Solid Unicode chess glyphs for both colours; colour comes from CSS. */
export const CARRIER_GLYPH: Record<Carrier, string> = {
  king: '♚',
  queen: '♛',
  rook: '♜',
  bishop: '♝',
  knight: '♞',
  pawn: '♟',
}

export const COLOR_LABEL: Record<Color, string> = {
  white: '白',
  black: '黑',
}

export const PROMOTION_CHOICES: readonly Exclude<Carrier, 'pawn' | 'king'>[] = [
  'queen',
  'rook',
  'bishop',
  'knight',
]
