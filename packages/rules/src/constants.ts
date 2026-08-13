/**
 * Constants. Normative block copied verbatim from techspec_v01.md §3.
 *
 * Everything below the verbatim block is engine-internal support data
 * (display names, the deterministic default assignment order) and is not
 * part of the normative contract.
 */

import { parseSquare } from './board.js'
import type {
  Carrier,
  Color,
  GameConfig,
  Rank,
  RankDistribution,
  Square,
} from './types.js'

// ---------------------------------------------------------------------------
// Normative — techspec §3 "Constants (constants.ts)"
// ---------------------------------------------------------------------------

/** Lower number beats higher number. 'bomb' is absent — it has no rank. */
export const RANK_ORDER: Record<Exclude<Rank, 'bomb'>, number> = {
  commander: 1, general: 2, division: 3, brigade: 4, regiment: 5,
  battalion: 6, company: 7, platoon: 8, engineer: 9, flag: 10,
}

/**
 * Every rank, in descending strength order. 'bomb' last — it has no rank.
 *
 * Declared here rather than with the other support data because the 數量配置
 * builder below iterates it: a table that is MISSING a 兵種 has to fail as
 * loudly as one whose numbers are wrong, and only a total list of the ranks
 * that exist can notice an absent key.
 */
export const ALL_RANKS: Rank[] = [
  'commander', 'general', 'division', 'brigade', 'regiment',
  'battalion', 'company', 'platoon', 'engineer', 'flag', 'bomb',
]

// ---------------------------------------------------------------------------
// 兵種數量配置 presets (§2, 附錄 B)
//
// Each preset is a NAMED table over the whole `Rank` union, so `Record<Rank,
// number>` makes it exhaustive at compile time — a 兵種 left out, or invented,
// fails the build rather than producing a 15-piece army at run time. What the
// type cannot check is the sum, so `distributionOf` checks it on the way in and
// every preset below is therefore proven to be 16 before the module finishes
// loading. Import order alone will surface a bad edit.
// ---------------------------------------------------------------------------

/** 每方 16 子 (§2 合計). A 兵種 distribution must sum to exactly this. */
export const PIECES_PER_SIDE = 16

/** The total of a 兵種 table. Uses ALL_RANKS, so a missing key reads as NaN. */
export function distributionTotal(d: RankDistribution): number {
  let total = 0
  for (const rank of ALL_RANKS) total += d[rank]
  return total
}

/**
 * What is wrong with a 兵種 table, or null when nothing is.
 *
 * Anything that accepts a distribution from outside this module — `createGame`
 * with a caller's config, a table parsed off a wire — runs this first. The sum
 * is the load-bearing part: a code is one character per piece and a deployment
 * is a bijection onto this table (§9), so a table summing to anything but 16
 * produces a format nothing can satisfy and an error message that blames the
 * player for it.
 */
export function checkDistribution(d: RankDistribution): string | null {
  for (const rank of ALL_RANKS) {
    const n = d[rank]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return `${rank}: expected a non-negative integer, got ${String(n)}`
    }
  }
  const total = distributionTotal(d)
  if (total !== PIECES_PER_SIDE) {
    return `sums to ${total}, must be exactly ${PIECES_PER_SIDE} (§2 合計)`
  }
  return null
}

/** Freeze a named table into a preset, refusing one that is not a legal §2 table. */
function distributionOf(name: string, table: Record<Rank, number>): RankDistribution {
  const problem = checkDistribution(table)
  if (problem !== null) throw new Error(`兵種 distribution ${name}: ${problem}`)
  return Object.freeze({ ...table })
}

/**
 * The gamebook §2 table. 司令1 軍長1 師長1 旅長2 團長2 營長2 連長1 排長1 工兵2
 * 軍旗1 爆裂物2 — the default every game gets unless its config says otherwise.
 */
export const DISTRIBUTION_STANDARD: RankDistribution = distributionOf('STANDARD', {
  commander: 1, general: 1, division: 1, brigade: 2, regiment: 2,
  battalion: 2, company: 1, platoon: 1, engineer: 2, flag: 1, bomb: 2,
})

/**
 * 工兵4 — one 團長 and one 營長 moved onto 工兵 (notebook §4.5).
 *
 * Four playtests produced ZERO 有煙無傷, i.e. 附錄 A(a) — the joint 工兵/軍旗
 * immunity the whole hidden layer is built on — has never fired in play. The
 * hypothesis is that 工兵2 = 爆裂物2 leaves both 工兵 earmarked against the two
 * 爆裂物, so neither is ever spent scouting: 「工兵的數量就是你能安全試探的次數」.
 * With four, two are spendable.
 *
 * Costs, per the same note: 工兵4＋軍旗1 is five pieces that essentially cannot
 * fight (31% of the army), and 有煙無傷 narrows the survivor to one of FIVE
 * pieces instead of three, so the 軍旗 gets harder to hunt.
 */
export const DISTRIBUTION_SCOUTS: RankDistribution = distributionOf('SCOUTS', {
  commander: 1, general: 1, division: 1, brigade: 2, regiment: 1,
  battalion: 1, company: 1, platoon: 1, engineer: 4, flag: 1, bomb: 2,
})

/**
 * Doubles moved up the ladder onto the ranks nobody risks (notebook §4.4).
 *
 * 軍長2 師長2 with 團長1 營長1: the pairs sit on 兵種 that mostly stay home, and
 * the mid ranks that actually collide become single, which should cut the
 * EXPENSIVE 同階雙亡 that drives the §4.2 snowball — 「把雙份放在多半留守的高階，
 * 讓真正互撞的中階變成單份」.
 */
export const DISTRIBUTION_TOP_HEAVY: RankDistribution = distributionOf('TOP_HEAVY', {
  commander: 1, general: 2, division: 2, brigade: 2, regiment: 1,
  battalion: 1, company: 1, platoon: 1, engineer: 2, flag: 1, bomb: 2,
})

/**
 * The §2 table.
 *
 * @deprecated Alias of `DISTRIBUTION_STANDARD`, kept so existing importers keep
 * working. It is the DEFAULT preset, not "the 兵種 counts" — a game may be
 * configured with any table (附錄 B), so anything that validates, counts,
 * renders or explains a deployment must read `config.distribution` instead.
 */
export const DISTRIBUTION: RankDistribution = DISTRIBUTION_STANDARD

// ---------------------------------------------------------------------------
// 結算格 presets (§7 ②, 附錄 B)
//
// Built from square NAMES, never from literal indices. The name→index mapping
// is the one place where a mistake is invisible: an off-by-one produces no
// error, no crash and no odd-looking board — the game simply scores the wrong
// four squares for the rest of its life, and every score in it is wrong.
// `test/scoring-squares.test.ts` asserts the mapping back out by name.
// ---------------------------------------------------------------------------

function squaresNamed(...names: readonly string[]): readonly Square[] {
  return Object.freeze(
    names.map((n) => {
      const sq = parseSquare(n)
      if (sq === null) throw new Error(`constants: not a square name: ${n}`)
      return sq
    }),
  )
}

/** 中央四格 d4 e4 d5 e5 — the gamebook §7 default. `[27, 28, 35, 36]`. */
export const SCORING_CENTRE_4: readonly Square[] = squaresNamed('d4', 'e4', 'd5', 'e5')

/**
 * The centre four PLUS the a/h flanks on the same two ranks: a4 h4 a5 h5
 * (`[24, 31, 32, 39]`). A playtest shape — the centre-only board funnels every
 * piece into four squares and leaves the flanks dead, so the wide board is here
 * to be tried, not because it is better. Set it via `createGame`'s config.
 *
 * **Suggested X: 40 — the same as 中央四格, NOT double it.** Doubling was right
 * when both sides settled every ply; under mover-only settlement (§7) a piece
 * holding a square banks 1 point per full turn on any board, so eight squares
 * raise the CEILING of a turn's income, not its rate. Anything that offers this
 * preset should offer `DEFAULT_CONFIG.scoreTarget` with it, unscaled.
 */
export const SCORING_WIDE_8: readonly Square[] = Object.freeze([
  ...SCORING_CENTRE_4,
  ...squaresNamed('a4', 'h4', 'a5', 'h5'),
])

/**
 * d4, e4, d5, e5.
 *
 * @deprecated Alias of `SCORING_CENTRE_4`, kept so existing importers keep
 * working. It is the DEFAULT preset, not "the scoring squares" — a game may be
 * configured with any shape, so anything that scores, highlights or describes
 * the board must read `config.scoringSquares` instead.
 */
export const CENTER_SQUARES: readonly Square[] = SCORING_CENTRE_4

/**
 * X = 40 for every 結算格 preset, 貼目 = 0.5.
 *
 * A settlement credits only the mover (§7), so the scoring rate is one bank per
 * side per full turn whatever the board shape — 40 is the same match length on
 * 中央四格 and on 側翼八格, and neither preset scales it. 貼目 is here solely to
 * make an exact tie impossible; it compensates for no first-move advantage,
 * because mover-only settlement leaves none to compensate for.
 */
export const DEFAULT_CONFIG: GameConfig = {
  scoreTarget: 40, noProgressTurns: 30, komi: 0.5,
  scoringSquares: SCORING_CENTRE_4,
  distribution: DISTRIBUTION_STANDARD,
  clockInitialMs: 900_000, clockIncrementMs: 10_000,
  setupTimeoutMs: 180_000, clockEnabled: true,
}

// ---------------------------------------------------------------------------
// Support data
// ---------------------------------------------------------------------------

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
 * Counts match DISTRIBUTION_STANDARD exactly. It is a SEED, not the answer: a
 * game whose 數量配置 is not the standard table cannot use it as it stands, so
 * `defaultRankByHomeKey` keeps every slot this table can still afford and fills
 * the rest from what the game's own distribution has left over.
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
