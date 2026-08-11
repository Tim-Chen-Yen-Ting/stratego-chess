import { CENTER_SQUARES, DISTRIBUTION } from '@xiyang/rules'
import type { Carrier, Color, Rank } from '@xiyang/rules'

/**
 * Display data for the client — labels and glyphs, nothing else.
 *
 * The two NORMATIVE tables the UI needs (the §2 piece-count table for the setup
 * tray, and the four §7 centre squares for the board highlight) are re-exported
 * straight from `@xiyang/rules`, never copied. 附錄 B calls the piece counts a
 * tunable parameter: a local copy would silently disagree with the engine the
 * moment anyone tuned it, and the setup screen would then offer a pool that
 * `validateAssignment` rejects. Re-exporting a constant is not "implementing
 * rules" (techspec §7) — no legality, combat or scoring decision happens here.
 */

export { CENTER_SQUARES, DISTRIBUTION }

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
