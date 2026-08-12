import type { Carrier, CombatOutcome, Color, GameEvent, Move, Result, Square } from '@xiyang/rules'
import { CARRIER_LABEL, COLOR_LABEL, RANK_LABEL } from './constants.js'

/**
 * Pure presentation helpers. Coordinate arithmetic only — nothing here decides
 * legality, combat or scoring. Every combat sentence below is a restatement of
 * the public announcement the server already put in the event (gamebook §4
 * 翻明總表); no inference is performed and no candidate set is ever computed
 * (gamebook §10 — 紀錄給，解算不給).
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

export function colorLabel(color: Color): string {
  return `${COLOR_LABEL[color]}方`
}

/**
 * @param promoted what the pawn ACTUALLY promoted to (`GameEvent.promoted`),
 *   not what the move requested. A pawn that loses or ties on the 8th rank is
 *   removed and does not promote (gamebook §6), yet `move.promote` still carries
 *   the choice that was submitted — so rendering from the move claims a
 *   promotion the engine correctly denied. Seen live: a 司令 pawn tying against
 *   the enemy 司令 on d1 logged as `e2×d1＝后` with both pieces gone.
 */
export function moveText(move: Move, madeContact: boolean, promoted?: Carrier): string {
  switch (move.kind) {
    case 'pass':
      return 'pass（跳過）'
    case 'castle':
      return move.side === 'king' ? 'O-O（王翼易位）' : 'O-O-O（后翼易位）'
    case 'move': {
      const sep = madeContact ? '×' : '–'
      const promo = promoted ? `＝${CARRIER_LABEL[promoted].split(' ')[0]}` : ''
      return `${squareName(move.from)}${sep}${squareName(move.to)}${promo}`
    }
  }
}

/** Restates the public announcement carried in the event. No inference. */
export function combatText(outcome: CombatOutcome, attacker: Color): string {
  switch (outcome.kind) {
    case 'attacker-wins':
      return `攻方（${colorLabel(attacker)}）獲勝，永久翻明為 ${RANK_LABEL[outcome.winnerRank]}；守方移除，兵種不公開`
    case 'defender-wins':
      return `守方（${colorLabel(other(attacker))}）獲勝，永久翻明為 ${RANK_LABEL[outcome.winnerRank]}；攻方由原格移除，兵種不公開`
    case 'mutual-rank':
      return `同階雙亡 — 雙方皆為 ${RANK_LABEL[outcome.rank]}，同時移除`
    case 'bomb-detonate':
      return `爆裂物引爆（${colorLabel(outcome.bombColor)}）— 雙方移除；對方兵種不公開`
    case 'bomb-vs-bomb':
      return '爆裂物 vs 爆裂物 — 雙方皆為爆裂物，同時移除'
    case 'fizzle':
      return `有煙無傷 — ${colorLabel(outcome.survivorColor)}該子為 工兵 或 軍旗；爆裂物移除`
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
 *   8黑（團長） d4xd5（團長）   同階雙亡
 *   9白（爆裂物）e2xe4          白's bomb detonated; the victim stays hidden
 *  10黑（工兵/軍旗）h7xg5（爆裂物） 有煙無傷 — the bomb died, the survivor is one of two
 *
 * A rank never appears here unless the server actually announced it, so this
 * stays a restatement of the record and never becomes a solver (gamebook §10).
 */
export interface CombatTags {
  /** shown next to the side that moved */
  mover: string | null
  /** shown next to the destination square */
  target: string | null
}

const EITHER = '工兵/軍旗'
const BOMB = RANK_LABEL.bomb

export function combatTags(outcome: CombatOutcome, mover: Color): CombatTags {
  switch (outcome.kind) {
    case 'attacker-wins':
      return { mover: RANK_LABEL[outcome.winnerRank], target: null }
    case 'defender-wins':
      return { mover: null, target: RANK_LABEL[outcome.winnerRank] }
    case 'mutual-rank':
      return { mover: RANK_LABEL[outcome.rank], target: RANK_LABEL[outcome.rank] }
    case 'bomb-vs-bomb':
      return { mover: BOMB, target: BOMB }
    case 'bomb-detonate':
      // only the bomb is announced; the piece it took stays hidden (§4 翻明總表)
      return outcome.bombColor === mover
        ? { mover: BOMB, target: null }
        : { mover: null, target: BOMB }
    case 'fizzle':
      // the dead piece was necessarily a bomb; the survivor is narrowed to two,
      // and deliberately no further — that ambiguity is the point (附錄 A(a))
      return outcome.survivorColor === mover
        ? { mover: EITHER, target: BOMB }
        : { mover: BOMB, target: EITHER }
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

export function eventLine(ev: GameEvent): EventLine {
  const contact = ev.combat != null
  return {
    ply: ev.ply,
    color: ev.color,
    move: moveText(ev.move, contact, ev.promoted),
    combat: ev.combat ? combatText(ev.combat.outcome, ev.color) : null,
    tags: ev.combat ? combatTags(ev.combat.outcome, ev.color) : { mover: null, target: null },
    enPassant:
      ev.combat != null && ev.move.kind === 'move' && ev.combat.defenderSquare !== ev.move.to,
    promoted: ev.promoted ? `升變為 ${CARRIER_LABEL[ev.promoted].split(' ')[0]}` : null,
    score: `${ev.scoreAfter.white} – ${ev.scoreAfter.black}`,
  }
}

export function resultText(result: Result): string {
  switch (result.kind) {
    case 'flag':
      return `奪旗 — ${colorLabel(result.winner)}獲勝（對方軍旗離場）`
    case 'flag-both':
      return '雙方軍旗同時離場 — 和局'
    case 'score':
      return `達到分數線 — ${colorLabel(result.winner)}獲勝`
    case 'no-progress':
      return `停滯回合用盡 — 分數高者 ${colorLabel(result.winner)}獲勝`
    case 'timeout':
      return `超時 — ${colorLabel(result.winner)}獲勝`
    case 'resign':
      return `認輸 — ${colorLabel(result.winner)}獲勝`
  }
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
