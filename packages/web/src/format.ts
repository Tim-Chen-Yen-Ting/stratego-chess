import type { Carrier, CombatOutcome, Color, GameEvent, Move, Result, Square } from '@xiyang/rules'
import { CARRIER_LABEL, COLOR_LABEL, RANK_LABEL } from './constants.js'
import type { Lang } from './i18n.js'

/**
 * Pure presentation helpers. Coordinate arithmetic only — nothing here decides
 * legality, combat or scoring. Every combat sentence below is a restatement of
 * the public announcement the server already put in the event (gamebook §4
 * 翻明總表); no inference is performed and no candidate set is ever computed
 * (gamebook §10 — 紀錄給，解算不給).
 *
 * Every function below takes `lang` explicitly rather than reading it from
 * context — these are pure functions called from render code and from
 * `EventLine`/log-building code that isn't itself a component, so there's no
 * hook to reach for; the caller already has `lang` from `useLang()` and passes
 * it down like any other rendering input.
 */

const FILES = 'abcdefgh'

/** 0..63 with a1 = 0, h1 = 7, a8 = 56, h8 = 63 (techspec §3). */
export function squareName(sq: Square): string {
  return `${FILES[sq % 8]}${Math.floor(sq / 8) + 1}`
}

export function fileOf(sq: Square): number {
  return sq % 8
}

export function rankOf(sq: Square): number {
  return Math.floor(sq / 8)
}

/** a1 is a dark square. */
export function isDarkSquare(sq: Square): boolean {
  return (fileOf(sq) + rankOf(sq)) % 2 === 0
}

export function other(color: Color): Color {
  return color === 'white' ? 'black' : 'white'
}

const SIDE_SUFFIX: Record<Lang, string> = { zh: '方', en: '' }

export function colorLabel(color: Color, lang: Lang): string {
  return `${COLOR_LABEL[lang][color]}${SIDE_SUFFIX[lang]}`
}

const CASTLE_TEXT: Record<Lang, { pass: string; kingside: string; queenside: string }> = {
  zh: { pass: 'pass（跳過）', kingside: 'O-O（王翼易位）', queenside: 'O-O-O（后翼易位）' },
  en: { pass: 'pass', kingside: 'O-O (kingside castle)', queenside: 'O-O-O (queenside castle)' },
}

/**
 * @param promoted what the pawn ACTUALLY promoted to (`GameEvent.promoted`),
 *   not what the move requested. A pawn that loses or ties on the 8th rank is
 *   removed and does not promote (gamebook §6), yet `move.promote` still carries
 *   the choice that was submitted — so rendering from the move claims a
 *   promotion the engine correctly denied. Seen live: a 司令 pawn tying against
 *   the enemy 司令 on d1 logged as `e2×d1＝后` with both pieces gone.
 */
export function moveText(move: Move, madeContact: boolean, lang: Lang, promoted?: Carrier): string {
  switch (move.kind) {
    case 'pass':
      return CASTLE_TEXT[lang].pass
    case 'castle':
      return move.side === 'king' ? CASTLE_TEXT[lang].kingside : CASTLE_TEXT[lang].queenside
    case 'move': {
      const sep = madeContact ? '×' : '–'
      const promo = promoted ? `＝${CARRIER_LABEL[lang][promoted].split(' ')[0]}` : ''
      return `${squareName(move.from)}${sep}${squareName(move.to)}${promo}`
    }
  }
}

const COMBAT_TEXT = {
  zh: {
    attackerWins: (attacker: string, rank: string) =>
      `攻方（${attacker}）獲勝，永久翻明為 ${rank}；守方移除，兵種不公開`,
    defenderWins: (defender: string, rank: string) =>
      `守方（${defender}）獲勝，永久翻明為 ${rank}；攻方由原格移除，兵種不公開`,
    // The sentence has to spell the ambiguity out. A player who reads this as
    // the old 同階雙亡 concludes the other piece shared their own 階級 — the
    // exact false inference the single announcement exists to prevent.
    mutual: '雙方同時移除 — 可能是同階雙亡，也可能是爆裂物；兩者的公告完全相同，無從分辨。雙方兵種皆不公開',
    fizzle: (survivor: string) => `有煙無傷 — ${survivor}該子為 工兵 或 軍旗；爆裂物移除`,
  },
  en: {
    attackerWins: (attacker: string, rank: string) =>
      `Attacker (${attacker}) wins, permanently revealed as ${rank}; defender removed, its rank stays secret`,
    defenderWins: (defender: string, rank: string) =>
      `Defender (${defender}) wins, permanently revealed as ${rank}; attacker removed from its own square, its rank stays secret`,
    mutual: 'Both pieces removed simultaneously — could be an equal-rank tie or a bomb; the two announcements are identical and can’t be told apart. Neither rank is disclosed.',
    fizzle: (survivor: string) => `Fizzle (no harm, no foul) — ${survivor}’s piece was an Engineer or the Flag; the bomb is gone`,
  },
} as const

/** Restates the public announcement carried in the event. No inference. */
export function combatText(outcome: CombatOutcome, attacker: Color, lang: Lang): string {
  const T = COMBAT_TEXT[lang]
  switch (outcome.kind) {
    case 'attacker-wins':
      return T.attackerWins(colorLabel(attacker, lang), RANK_LABEL[lang][outcome.winnerRank])
    case 'defender-wins':
      return T.defenderWins(colorLabel(other(attacker), lang), RANK_LABEL[lang][outcome.winnerRank])
    case 'mutual-destruction':
      return T.mutual
    case 'fizzle':
      return T.fizzle(colorLabel(outcome.survivorColor, lang))
  }
}

/**
 * The compact log tags. POSITION carries the meaning: a tag beside the mover is
 * about the piece that moved, a tag beside the destination is about the piece
 * that was standing there. That is enough to read every outcome without a
 * sentence, because who-was-revealed is exactly what the sentence used to say.
 *
 *   6黑（軍長） f6xf5          attacker won and is now 翻明 as 軍長
 *   7白　　　　 e4xf5（軍長）   defender won; the attacker is gone
 *   8黑　　　　 d4xd5          both pieces removed; NOTHING is announced
 *   9白（工兵/軍旗）g4xh5（爆裂物） 有煙無傷 — the bomb died, the survivor is one of two
 *
 * A rank never appears here unless the server actually announced it, so this
 * stays a restatement of the record and never becomes a solver (gamebook §10).
 * Line 8 is why 'mutual-destruction' carries no tags at ALL: a tag on either
 * side would be a claim about a specific piece, and the announcement makes no
 * such claim — it does not even say whether the trade was 同階 or a 爆裂物.
 * The empty pair is the honest rendering, and it is also the readable one: a
 * contact with neither tag is precisely a mutual destruction, and both pieces
 * leaving the board is on the board itself.
 */
export interface CombatTags {
  /** shown next to the side that moved */
  mover: string | null
  /** shown next to the destination square */
  target: string | null
}

export function combatTags(outcome: CombatOutcome, mover: Color, lang: Lang): CombatTags {
  const either = lang === 'zh' ? '工兵/軍旗' : 'Engineer/Flag'
  const bomb = RANK_LABEL[lang].bomb
  switch (outcome.kind) {
    case 'attacker-wins':
      return { mover: RANK_LABEL[lang][outcome.winnerRank], target: null }
    case 'defender-wins':
      return { mover: null, target: RANK_LABEL[lang][outcome.winnerRank] }
    case 'mutual-destruction':
      // 同階雙亡 and 爆裂物 now share one announcement that names neither side.
      // Tagging is positional, so any tag here would name one of the two pieces
      // — and there is nothing to name. Both went; that is the whole record.
      return { mover: null, target: null }
    case 'fizzle':
      // the dead piece was necessarily a bomb; the survivor is narrowed to two,
      // and deliberately no further — that ambiguity is the point (附錄 A(a))
      return outcome.survivorColor === mover
        ? { mover: either, target: bomb }
        : { mover: bomb, target: either }
  }
}

export interface EventLine {
  ply: number
  color: Color
  /** the move in coordinate notation */
  move: string
  /** the public combat announcement, if the move made contact — tooltip only */
  combat: string | null
  /** compact inline tags; see combatTags */
  tags: CombatTags
  /** true when the contact square differs from the destination (en passant) */
  enPassant: boolean
  promoted: string | null
  score: string
}

const PROMOTED_TEXT: Record<Lang, (carrier: string) => string> = {
  zh: (carrier) => `升變為 ${carrier}`,
  en: (carrier) => `promoted to ${carrier}`,
}

export function eventLine(ev: GameEvent, lang: Lang): EventLine {
  const contact = ev.combat != null
  return {
    ply: ev.ply,
    color: ev.color,
    move: moveText(ev.move, contact, lang, ev.promoted),
    combat: ev.combat ? combatText(ev.combat.outcome, ev.color, lang) : null,
    tags: ev.combat ? combatTags(ev.combat.outcome, ev.color, lang) : { mover: null, target: null },
    enPassant:
      ev.combat != null && ev.move.kind === 'move' && ev.combat.defenderSquare !== ev.move.to,
    promoted: ev.promoted ? PROMOTED_TEXT[lang](CARRIER_LABEL[lang][ev.promoted].split(' ')[0]!) : null,
    score: `${ev.scoreAfter.white} – ${ev.scoreAfter.black}`,
  }
}

const RESULT_TEXT: Record<Lang, Record<Result['kind'], (winner: string) => string>> = {
  zh: {
    flag: (w) => `奪旗 — ${w}獲勝（對方軍旗離場）`,
    'flag-both': () => '雙方軍旗同時離場 — 和局',
    score: (w) => `達到分數線 — ${w}獲勝`,
    'no-progress': (w) => `停滯回合用盡 — 分數高者 ${w}獲勝`,
    timeout: (w) => `超時 — ${w}獲勝`,
    resign: (w) => `認輸 — ${w}獲勝`,
  },
  en: {
    flag: (w) => `Flag captured — ${w} wins (the other side's flag left the board)`,
    'flag-both': () => 'Both flags left the board simultaneously — draw',
    score: (w) => `Score target reached — ${w} wins`,
    'no-progress': (w) => `No-progress limit reached — ${w} wins on points`,
    timeout: (w) => `Timeout — ${w} wins`,
    resign: (w) => `Resignation — ${w} wins`,
  },
}

export function resultText(result: Result, lang: Lang): string {
  const T = RESULT_TEXT[lang][result.kind]
  return result.kind === 'flag-both' ? T('') : T(colorLabel(result.winner, lang))
}

export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms)
  const tenths = Math.floor(clamped / 100)
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor(tenths / 10) % 60
  const pad = seconds < 10 ? '0' : ''
  if (clamped < 20_000) return `${minutes}:${pad}${seconds}.${tenths % 10}`
  return `${minutes}:${pad}${seconds}`
}

export function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/** mm:ss for the setup countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}
