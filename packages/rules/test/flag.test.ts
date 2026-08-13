/**
 * 軍旗 — §5 and §7①.
 *
 *   「軍旗以任何方式離開棋盤，該方立即判負（含被吃、主動撞擊他子、與敵方軍旗
 *     同歸於盡）。」
 *   「升變與王車易位不構成離開棋盤。」
 *   「奪旗判定於此階段（①行動階段）即時觸發，觸發即結束遊戲。」
 */

import { describe, expect, it } from 'vitest'
import { applyMove } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import type { GameState, Rank } from '../src/types.js'
import { PASS, lastEvent, mv, pieceById, position, sq } from './helpers.js'

const W = 'W'
const B = 'B'

/** White rook b2 vs black rook b7, one slide apart. */
function duel(whiteRank: Rank, blackRank: Rank, extra: Parameters<typeof position>[0] = []): GameState {
  return position(
    [
      { at: 'b2', color: 'white', carrier: 'rook', rank: whiteRank, id: W },
      { at: 'b7', color: 'black', carrier: 'rook', rank: blackRank, id: B },
      ...extra,
    ],
    { toMove: 'white' },
  )
}

describe('§7① 奪旗 — instant loss', () => {
  it('loses instantly when the 軍旗 is captured', () => {
    const s = applyMove(duel('general', 'flag'), mv('b2', 'b7'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })
    expect(pieceById(s, B).square).toBeNull()
  })

  it('loses instantly on 自殺 — moving your own 軍旗 into a stronger piece', () => {
    const s = applyMove(duel('flag', 'general'), mv('b2', 'b7'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
    expect(pieceById(s, W).square).toBeNull()
    // §4: the losing attacker came off its ORIGIN, and the defender never moved.
    expect(pieceById(s, B).square).toBe(sq('b7'))
  })

  it('is a DRAW when both 軍旗 leave together — the only draw in the game', () => {
    const s = applyMove(duel('flag', 'flag'), mv('b2', 'b7'))
    // The announcement says only that both pieces went. That the two were 軍旗
    // is公開 by the result itself (§7① ends the game), not by the outcome — and
    // the outcome must stay opaque, or every OTHER 同歸於盡 becomes readable too.
    expect(lastEvent(s).combat?.outcome).toEqual({ kind: 'mutual-destruction' })
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag-both' } })
    expect(pieceById(s, W).square).toBeNull()
    expect(pieceById(s, B).square).toBeNull()
  })

  it('does NOT fire when the 軍旗 survives a 爆裂物 (§5 免疫，雙向)', () => {
    const attacked = applyMove(duel('bomb', 'flag'), mv('b2', 'b7'))
    expect(attacked.status).toEqual({ kind: 'playing' })
    expect(pieceById(attacked, B).square).toBe(sq('b7'))

    const attacking = applyMove(duel('flag', 'bomb'), mv('b2', 'b7'))
    expect(attacking.status).toEqual({ kind: 'playing' })
    expect(pieceById(attacking, W).square).toBe(sq('b7'))
  })

  it('ends the game hard: no further move is accepted, and no move is legal', () => {
    const s = applyMove(duel('general', 'flag'), mv('b2', 'b7'))
    expect(() => applyMove(s, PASS)).toThrow()
    expect(legalMoves(s, 'white')).toEqual([])
    expect(legalMoves(s, 'black')).toEqual([])
  })
})

describe('§7① 奪旗 resolves in ① 行動階段, BEFORE ② 結算階段', () => {
  const before = duel('general', 'flag', [
    { at: 'e4', color: 'white', carrier: 'queen', rank: 'commander', id: 'WQ' },
    { at: 'd5', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
  ])
  const after = applyMove(before, mv('b2', 'b7'))

  it('scores nothing for this ply even though both sides hold 中央格', () => {
    expect(before.score).toEqual({ white: 0, black: 0.5 })
    expect(after.score).toEqual({ white: 0, black: 0.5 })
    expect(lastEvent(after).scoreAfter).toEqual({ white: 0, black: 0.5 })
  })

  it('still records the combat that ended it', () => {
    expect(lastEvent(after).combat?.outcome).toEqual({
      kind: 'attacker-wins',
      winnerRank: 'general',
    })
  })
})

describe('§5 升變與王車易位不構成離開棋盤', () => {
  /** e1/a1/h1 all home, nothing between. Black has its own 軍旗, untouched. */
  function castlingHome(kingRank: Rank, aRookRank: Rank, hRookRank: Rank): GameState {
    return position(
      [
        { at: 'e1', color: 'white', carrier: 'king', rank: kingRank, id: 'WK' },
        { at: 'a1', color: 'white', carrier: 'rook', rank: aRookRank, id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: hRookRank, id: 'WRH' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
      ],
      { toMove: 'white' },
    )
  }

  it('king-side castling with a 軍旗 rook keeps the game alive', () => {
    const s = applyMove(castlingHome('commander', 'general', 'flag'), { kind: 'castle', side: 'king' })
    expect(s.status).toEqual({ kind: 'playing' })
    expect(pieceById(s, 'WK').square).toBe(sq('g1'))
    expect(pieceById(s, 'WRH').square).toBe(sq('f1'))
    expect(pieceById(s, 'WRH').rank).toBe('flag')
    expect(pieceById(s, 'WRH').revealed).toBe(false)
    expect(lastEvent(s).combat).toBeUndefined()
  })

  it('queen-side castling with a 軍旗 rook keeps the game alive', () => {
    const s = applyMove(castlingHome('commander', 'flag', 'general'), { kind: 'castle', side: 'queen' })
    expect(s.status).toEqual({ kind: 'playing' })
    expect(pieceById(s, 'WK').square).toBe(sq('c1'))
    expect(pieceById(s, 'WRA').square).toBe(sq('d1'))
    expect(pieceById(s, 'WRA').rank).toBe('flag')
  })

  it('castling with a 軍旗 KING keeps the game alive (§1 軍旗可放在任何載體)', () => {
    const s = applyMove(castlingHome('flag', 'general', 'division'), { kind: 'castle', side: 'king' })
    expect(s.status).toEqual({ kind: 'playing' })
    expect(pieceById(s, 'WK').square).toBe(sq('g1'))
    expect(pieceById(s, 'WK').rank).toBe('flag')
  })

  it('a 軍旗 pawn promoting is not 離開棋盤 either', () => {
    const before = position(
      [
        { at: 'a7', color: 'white', carrier: 'pawn', rank: 'flag', id: 'WP', hasMoved: true },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
      ],
      { toMove: 'white' },
    )
    const s = applyMove(before, mv('a7', 'a8', 'queen'))
    expect(s.status).toEqual({ kind: 'playing' })
    expect(pieceById(s, 'WP').rank).toBe('flag')
    expect(pieceById(s, 'WP').carrier).toBe('queen')
  })
})

describe('§3① king 無特殊地位 — capturing a king is an ordinary contact', () => {
  it('capturing the enemy king does not end the game; only 軍旗 does', () => {
    const before = position(
      [
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: W },
        { at: 'b7', color: 'black', carrier: 'king', rank: 'company', id: B },
        { at: 'h8', color: 'black', carrier: 'rook', rank: 'flag', id: 'BFLAG' },
      ],
      { toMove: 'white' },
    )
    const s = applyMove(before, mv('b2', 'b7'))
    expect(pieceById(s, B).square).toBeNull()
    expect(s.status).toEqual({ kind: 'playing' })
  })

  it('a king can lose the contact like any other carrier', () => {
    const before = position(
      [
        { at: 'b6', color: 'white', carrier: 'king', rank: 'platoon', id: W },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'general', id: B },
      ],
      { toMove: 'white' },
    )
    const s = applyMove(before, mv('b6', 'b7'))
    expect(pieceById(s, W).square).toBeNull()
    expect(pieceById(s, B).square).toBe(sq('b7'))
    expect(s.status).toEqual({ kind: 'playing' })
  })
})
