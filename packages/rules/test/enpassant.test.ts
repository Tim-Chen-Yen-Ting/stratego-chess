/**
 * §3 / §4 En passant — 「全遊戲唯一『接觸格』與『目的格』不同的吃法」.
 *
 * The whole point of these tests is that 接觸格 ≠ 目的格:
 *   - the defender stands on a5,
 *   - the attacker aims at a6,
 * so a winning attacker must end on a6 while the piece it removed came off a5,
 * and a losing attacker must leave a6 EMPTY.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { applyMove } from '../src/game.js'
import { enPassantInfo, legalMoves } from '../src/moves.js'
import type { GameState, Rank } from '../src/types.js'
import { PASS, at, isEmpty, lastEvent, mv, pieceById, position, rankSeenBy, sq } from './helpers.js'

const WP = 'WP' // white pawn on b5, the en-passant capturer
const BP = 'BP' // black pawn on a7 → a5, the victim
const WK = 'WK'
const BK = 'BK'

/**
 * b5/a7 rather than the d/e files on purpose: a5, a6 and b5 are all outside the
 * 中央格 set, so §7 settlement cannot perturb what these tests measure.
 */
function opening(whiteRank: Rank, blackRank: Rank): GameState {
  return position(
    [
      { at: 'b5', color: 'white', carrier: 'pawn', rank: whiteRank, id: WP, hasMoved: true },
      { at: 'a7', color: 'black', carrier: 'pawn', rank: blackRank, id: BP },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: WK },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: BK },
    ],
    { toMove: 'black', ply: 2 },
  )
}

/** Black double-steps a7→a5, leaving white a one-ply en-passant window. */
function afterDoubleStep(whiteRank: Rank, blackRank: Rank): GameState {
  return applyMove(opening(whiteRank, blackRank), mv('a7', 'a5'))
}

describe('§3 en passant — availability', () => {
  let s: GameState

  beforeEach(() => {
    s = afterDoubleStep('general', 'company')
  })

  it('offers b5xa6 immediately after the double step', () => {
    expect(enPassantInfo(s)).not.toBeNull()
    expect(enPassantInfo(s)?.skipped).toBe(sq('a6'))
    expect(enPassantInfo(s)?.victim.id).toBe(BP)
    expect(legalMoves(s, 'white')).toContainEqual(mv('b5', 'a6'))
  })

  it('closes the window after any other ply, including a pass', () => {
    const afterPass = applyMove(s, PASS)             // white passes, ply 3
    const afterBlack = applyMove(afterPass, mv('h8', 'g8'))
    expect(enPassantInfo(afterBlack)).toBeNull()
    expect(legalMoves(afterBlack, 'white')).not.toContainEqual(mv('b5', 'a6'))
  })

  it('is not offered for a single-step pawn move', () => {
    const single = applyMove(opening('general', 'company'), mv('a7', 'a6'))
    expect(enPassantInfo(single)).toBeNull()
  })
})

describe('§4 en passant — 攻方勝', () => {
  const s = applyMove(afterDoubleStep('general', 'company'), mv('b5', 'a6'))

  it('lands the attacker on the SKIPPED square, not on the defender square', () => {
    expect(pieceById(s, WP).square).toBe(sq('a6'))
    expect(at(s, 'a6')?.id).toBe(WP)
  })

  it('removes the captured pawn from a DIFFERENT square (a5)', () => {
    expect(pieceById(s, BP).square).toBeNull()
    expect(isEmpty(s, 'a5')).toBe(true)
    expect(isEmpty(s, 'b5')).toBe(true)
  })

  it('logs 接觸格 a5 and survivor square a6 as distinct squares', () => {
    const c = lastEvent(s).combat!
    expect(c).toEqual({
      outcome: { kind: 'attacker-wins', winnerRank: 'general' },
      attackerSquare: sq('b5'),
      defenderSquare: sq('a5'),
      survivorSquare: sq('a6'),
    })
    expect(c.defenderSquare).not.toBe(c.survivorSquare)
  })

  it('翻明s the winner only', () => {
    expect(pieceById(s, WP).revealed).toBe(true)
    expect(rankSeenBy(s, 'black', WP)).toBe('general')
    expect(rankSeenBy(s, 'white', BP)).toBeNull()
  })
})

describe('§4 en passant — 攻方敗', () => {
  const s = applyMove(afterDoubleStep('company', 'general'), mv('b5', 'a6'))

  it('removes the attacker from its ORIGIN (b5)', () => {
    expect(pieceById(s, WP).square).toBeNull()
    expect(isEmpty(s, 'b5')).toBe(true)
  })

  it('leaves the surviving pawn on a5, untouched', () => {
    expect(pieceById(s, BP).square).toBe(sq('a5'))
    expect(at(s, 'a5')?.id).toBe(BP)
  })

  it('leaves the SKIPPED square a6 empty — the attacker never entered it', () => {
    expect(isEmpty(s, 'a6')).toBe(true)
  })

  it('reports the defender square as the survivor square', () => {
    expect(lastEvent(s).combat).toEqual({
      outcome: { kind: 'defender-wins', winnerRank: 'general' },
      attackerSquare: sq('b5'),
      defenderSquare: sq('a5'),
      survivorSquare: sq('a5'),
    })
  })

  it('翻明s the defending winner only', () => {
    expect(rankSeenBy(s, 'white', BP)).toBe('general')
    expect(rankSeenBy(s, 'black', WP)).toBeNull()
  })
})

describe('§4 en passant — 同階雙亡', () => {
  const s = applyMove(afterDoubleStep('brigade', 'brigade'), mv('b5', 'a6'))

  it('removes both and leaves BOTH a5 and the skipped a6 empty', () => {
    expect(pieceById(s, WP).square).toBeNull()
    expect(pieceById(s, BP).square).toBeNull()
    expect(isEmpty(s, 'a5')).toBe(true)
    expect(isEmpty(s, 'a6')).toBe(true)
    expect(isEmpty(s, 'b5')).toBe(true)
  })

  it('announces mutual-rank with no survivor square', () => {
    expect(lastEvent(s).combat).toEqual({
      outcome: { kind: 'mutual-rank', rank: 'brigade' },
      attackerSquare: sq('b5'),
      defenderSquare: sq('a5'),
      survivorSquare: null,
    })
    expect(rankSeenBy(s, 'white', BP)).toBe('brigade')
    expect(rankSeenBy(s, 'black', WP)).toBe('brigade')
  })
})

describe('§5 en passant — 爆裂物 rules apply unchanged (「一般吃法與 en passant 皆同」)', () => {
  it('工兵 taking a 爆裂物 en passant advances to the skipped square, unrevealed', () => {
    const s = applyMove(afterDoubleStep('engineer', 'bomb'), mv('b5', 'a6'))
    expect(pieceById(s, WP).square).toBe(sq('a6'))
    expect(pieceById(s, BP).square).toBeNull()
    expect(isEmpty(s, 'a5')).toBe(true)
    expect(lastEvent(s).combat).toEqual({
      outcome: { kind: 'fizzle', survivorColor: 'white' },
      attackerSquare: sq('b5'),
      defenderSquare: sq('a5'),
      survivorSquare: sq('a6'),
    })
    expect(pieceById(s, WP).revealed).toBe(false)
    expect(rankSeenBy(s, 'black', WP)).toBeNull()
  })

  it('a 爆裂物 taking a 工兵 en passant removes only itself; a6 stays empty', () => {
    const s = applyMove(afterDoubleStep('bomb', 'engineer'), mv('b5', 'a6'))
    expect(pieceById(s, WP).square).toBeNull()
    expect(pieceById(s, BP).square).toBe(sq('a5'))
    expect(isEmpty(s, 'a6')).toBe(true)
    expect(isEmpty(s, 'b5')).toBe(true)
    expect(lastEvent(s).combat).toEqual({
      outcome: { kind: 'fizzle', survivorColor: 'black' },
      attackerSquare: sq('b5'),
      defenderSquare: sq('a5'),
      survivorSquare: sq('a5'),
    })
    expect(rankSeenBy(s, 'white', BP)).toBeNull()
  })

  it('a 軍旗 taken en passant ends the game for its owner (§7①)', () => {
    const s = applyMove(afterDoubleStep('general', 'flag'), mv('b5', 'a6'))
    expect(pieceById(s, BP).square).toBeNull()
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })
  })
})
