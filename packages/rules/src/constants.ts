/**
 * Constants. Normative block copied verbatim from techspec_v01.md §3.
 *
 * Everything below the verbatim block is engine-internal support data
 * (display names, the deterministic default assignment order) and is not
 * part of the normative contract.
 */

import type { Carrier, Color, GameConfig, Rank, Square } from './types.js'

// ---------------------------------------------------------------------------
// Normative — techspec §3 "Constants (constants.ts)"
// ---------------------------------------------------------------------------

/** Lower number beats higher number. 'bomb' is absent — it has no rank. */
export const RANK_ORDER: Record<Exclude<Rank, 'bomb'>, number> = {
  commander: 1, general: 2, division: 3, brigade: 4, regiment: 5,
  battalion: 6, company: 7, platoon: 8, engineer: 9, flag: 10,
}

export const DISTRIBUTION: Record<Rank, number> = {
  commander: 1, general: 1, division: 1, brigade: 2, regiment: 2,
  battalion: 2, company: 1, platoon: 1, engineer: 2, flag: 1, bomb: 2,
}  // sums to 16

/** d4, e4, d5, e5 */
export const CENTER_SQUARES: Square[] = [27, 28, 35, 36]

export const DEFAULT_CONFIG: GameConfig = {
  scoreTarget: 40, noProgressTurns: 30, komi: 0.5,
  clockInitialMs: 900_000, clockIncrementMs: 10_000,
  setupTimeoutMs: 180_000, clockEnabled: true,
}

// ---------------------------------------------------------------------------
// Support data
// ---------------------------------------------------------------------------

/** Every rank, in descending strength order. 'bomb' last — it has no rank. */
export const ALL_RANKS: Rank[] = [
  'commander', 'general', 'division', 'brigade', 'regiment',
  'battalion', 'company', 'platoon', 'engineer', 'flag', 'bomb',
]

export const ALL_COLORS: Color[] = ['white', 'black']

/** 兵種 display names, gamebook §2. */
export const RANK_NAMES_ZH: Record<Rank, string> = {
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

/** 載體 display names, gamebook §1. */
export const CARRIER_NAMES_ZH: Record<Carrier, string> = {
  pawn: '兵',
  knight: '馬',
  bishop: '象',
  rook: '車',
  queen: '后',
  king: '王',
}

/** Single-letter carrier codes used by the text board and by log notation. */
export const CARRIER_LETTER: Record<Carrier, string> = {
  pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K',
}

/**
 * Ranks immune to 爆裂物, in both directions (gamebook §5, 附錄 A(a)).
 * BOTH must be immune: immunity for only one of them would name the piece.
 */
export const BOMB_IMMUNE: readonly Rank[] = ['engineer', 'flag']

/**
 * Deterministic universal fallback assignment (§0 setup timeout), keyed by the
 * starting square *from the owner's own perspective* — i.e. white's a1/a2 row
 * maps to black's a8/a7 row, so both colours get the mirror-image default.
 *
 * Counts match DISTRIBUTION exactly; `validateAssignment` is run over the
 * result in tests.
 */
export const DEFAULT_ASSIGNMENT_BY_HOME_SQUARE: Record<string, Rank> = {
  // back rank
  a1: 'flag',
  b1: 'bomb',
  c1: 'brigade',
  d1: 'commander',
  e1: 'general',
  f1: 'brigade',
  g1: 'bomb',
  h1: 'division',
  // pawn rank
  a2: 'engineer',
  b2: 'regiment',
  c2: 'battalion',
  d2: 'company',
  e2: 'platoon',
  f2: 'battalion',
  g2: 'regiment',
  h2: 'engineer',
}
