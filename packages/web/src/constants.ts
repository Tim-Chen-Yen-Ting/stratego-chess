import {
  CENTER_SQUARES,
  DEFAULT_CONFIG,
  DISTRIBUTION,
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  PIECES_PER_SIDE,
  SCORING_WIDE_8,
  checkDistribution,
  distributionTotal,
} from '@xiyang/rules'
import type { Carrier, Color, GameConfig, Rank, RankDistribution, Square } from '@xiyang/rules'

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

export { CENTER_SQUARES, DISTRIBUTION, PIECES_PER_SIDE, checkDistribution, distributionTotal }

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
 * settles after every ply, crediting the side that just moved (§7).
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

/**
 * A 計分區 the Create screen offers.
 *
 * There is deliberately NO score-target multiplier field here: X is a number the
 * creator sets, not one a preset applies behind their back. That is a decision
 * about the FORM, not a claim that one X suits both areas — it does not.
 *
 * Settlement credits only the side that just moved (§7.1), so each side banks
 * once per full turn on either area, but it banks every square it HOLDS: about
 * two on 中央四格 and about four here. A settlement therefore pays roughly double
 * on the wide area and the same X is a much shorter game — at X=40, n=300 bot
 * games average 35.5 手 on 中央四格 against 22.0 手 on 側翼八格 (《對局筆記》§9.3,
 * mechanism in §10.2). 附錄 B lists X as 中央四格 40, 側翼八格 待定, so
 * `DEFAULT_CONFIG.scoreTarget` is the CENTRE area's number and the wide area has
 * none yet; near 80 would match the length. Create.tsx says this in words under
 * the 目標分數 X field — if that ever moves back into data, it is a per-area
 * DEFAULT for the creator to override, never a silent multiplier.
 */
export interface ScoringAreaPreset {
  id: ScoringAreaId
  label: string
  squares: readonly Square[]
}

/** The presets the Create screen offers. Order is display order. */
export const SCORING_AREA_IDS: readonly ScoringAreaId[] = ['center', 'wide']

export const SCORING_AREAS: Record<ScoringAreaId, ScoringAreaPreset> = {
  center: {
    id: 'center',
    label: '中央四格',
    squares: scoringSquaresOf(DEFAULT_CONFIG),
  },
  wide: {
    id: 'wide',
    label: '中央＋側翼八格',
    squares: SCORING_WIDE_8,
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

// ---------------------------------------------------------------------------
// 兵種數量配置 (gamebook §2, 附錄 B)
// ---------------------------------------------------------------------------

/**
 * 附錄 B lists the piece counts among the tunables, exactly like the scoring
 * squares above, so the counts are a property of the GAME and not of the build.
 * Anything that PRINTS a count — the rank card, the setup pool — must read
 * `config.distribution`, because a card that says 工兵×2 in a game dealt 工兵×4
 * is not a card, it is a wrong answer with the rulebook's authority behind it.
 *
 * Widened for the same reason as `ScoringConfig`: a payload from a server that
 * predates the field carries no `distribution`, and that server is dealing the
 * §2 table — which is what the fallback returns. Reading a config field is not
 * deciding one; `validateAssignment` on the server remains the authority.
 */
export type DistributionConfig = GameConfig & { readonly distribution?: RankDistribution }

/**
 * Returns the SAME object reference on every call for a given config (either the
 * config's own table or the module constant), so this is safe inside a zustand
 * selector — a freshly built object each render would break snapshot stability.
 */
export function distributionOf(config: DistributionConfig): RankDistribution {
  return config.distribution ?? DISTRIBUTION
}

/**
 * One rank's count, for display.
 *
 * NaN rather than 0 for anything that is not a finite number: a table off the
 * wire can be missing a key, and a chip reading ×0 is a confident wrong answer
 * while ×NaN is visibly broken. The 合計 row reaches the same verdict by the
 * engine's own arithmetic (`distributionTotal` sums over ALL_RANKS), so the two
 * never disagree.
 */
export function countOf(distribution: RankDistribution, rank: Rank): number {
  const raw: unknown = distribution[rank]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN
}

export type DistributionId = 'standard' | 'scouts' | 'top-heavy'

export interface DistributionPreset {
  id: DistributionId
  label: string
  /** WHAT it is — the one-phrase difference from the §2 table. */
  what: string
  /** WHAT IT IS FOR — the reason a playtester would pick it. */
  why: string
  /** The honest small print: what picking it costs, and that it is untested. */
  note: string
  counts: RankDistribution
}

/** Display order of the picker. */
export const DISTRIBUTION_IDS: readonly DistributionId[] = ['standard', 'scouts', 'top-heavy']

/**
 * The numbers are the rules package's; only the prose is local. Both variants
 * are 【猜測】 in the notebook, not findings, and the copy says so — a player who
 * picks one is running an experiment and should know it.
 *
 * 合計 16 is not assumed here. The rules package proves each preset sums to 16
 * before this module finishes loading (a bad table throws on import), and the
 * Create screen runs `checkDistribution` again on the exact object it is about
 * to put on the wire — the table that crosses the wire is the one that has to be
 * playable, and a preset can be retuned in a package this one only imports.
 */
export const DISTRIBUTIONS: Record<DistributionId, DistributionPreset> = {
  standard: {
    id: 'standard',
    label: '標準',
    what: '規則書 §2 的原表',
    why: '對照組。四局實測都在這張表上打完，變體的每個數字只有跟它比才有意義。',
    note: '沒有要測什麼就用這個。',
    counts: DISTRIBUTION_STANDARD,
  },
  scouts: {
    id: 'scouts',
    label: '偵察兵',
    what: '工兵4，挪用一團長一營長',
    why: '為了讓「有煙無傷」真的發生——四局零次。工兵只有在多於對手的爆裂物時才值得花掉：工兵的數量就是你能安全試探的次數。',
    note: '筆記 §4.5，未實測。代價：工兵4＋軍旗1＝五顆基本上打不了的棋，且有煙無傷的候選從 3 個變 5 個，軍旗更難獵殺。',
    counts: DISTRIBUTION_SCOUTS,
  },
  'top-heavy': {
    id: 'top-heavy',
    label: '高階雙份',
    what: '雙份移到多半留守的高階',
    why: '為了讓真正互撞的中階變成單份，減少昂貴的等價交換——同階雙亡有利於分數領先方，而被迫製造它的是落後方。',
    note: '筆記 §4.4，未實測。高階不再唯一，同階雙亡因此可能發生在更貴的棋上。',
    counts: DISTRIBUTION_TOP_HEAVY,
  },
}

/** True when a table is rank-for-rank the §2 one. */
export function isStandardDistribution(distribution: RankDistribution): boolean {
  return RANKS_IN_ORDER.every((rank) => countOf(distribution, rank) === countOf(DISTRIBUTION, rank))
}

/** Which preset a table IS, or null when it matches none of them. */
export function matchDistribution(distribution: RankDistribution): DistributionId | null {
  for (const id of DISTRIBUTION_IDS) {
    const counts = DISTRIBUTIONS[id].counts
    if (RANKS_IN_ORDER.every((rank) => countOf(counts, rank) === countOf(distribution, rank))) {
      return id
    }
  }
  return null
}

/** Name for a table in running text. A game may be configured off-preset. */
export function distributionName(distribution: RankDistribution): string {
  const id = matchDistribution(distribution)
  return id === null ? '自訂' : DISTRIBUTIONS[id].label
}

/** The ranks whose count differs from the §2 table, in display order. */
export function distributionDiff(
  distribution: RankDistribution,
): { rank: Rank; count: number; standard: number }[] {
  return RANKS_IN_ORDER.flatMap((rank) => {
    const count = countOf(distribution, rank)
    const standard = countOf(DISTRIBUTION, rank)
    return count === standard ? [] : [{ rank, count, standard }]
  })
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
