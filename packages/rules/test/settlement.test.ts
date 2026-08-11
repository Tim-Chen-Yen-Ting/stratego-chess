/**
 * §7 ② 結算階段 — 中央計分.
 *
 *   「每一手結束後皆執行結算，且雙方同時計分。D4 / E4 / D5 / E5 四格，
 *     每有一顆己方棋子佔領則得 1 分。」
 *   「棋子若在①被吃掉，該手不計入其佔領分。」
 *   「計分不區分兵種。」
 *   「黑方開局即得 0.5 分，白方 0 分。」
 */

import { describe, expect, it } from 'vitest'
import { applyMove } from '../src/game.js'
import { createGame } from '../src/setup.js'
import { CENTER_SQUARES } from '../src/constants.js'
import type { Rank } from '../src/types.js'
import { PASS, lastEvent, mv, pieceById, position, sq } from './helpers.js'

describe('§7 貼目 — black starts at komi', () => {
  it('credits black komi before a single move is played', () => {
    expect(createGame('g').score).toEqual({ white: 0, black: 0.5 })
  })

  it('honours a configured komi (附錄 B: 可調為 1.5 或 2.5)', () => {
    expect(createGame('g', { komi: 2.5 }).score).toEqual({ white: 0, black: 2.5 })
    expect(createGame('g', { komi: 0 }).score).toEqual({ white: 0, black: 0 })
  })
})

describe('§7 中央格 are exactly d4 / e4 / d5 / e5', () => {
  it('matches the four squares by name', () => {
    expect([...CENTER_SQUARES].sort((a, b) => a - b)).toEqual(
      [sq('d4'), sq('e4'), sq('d5'), sq('e5')].sort((a, b) => a - b),
    )
  })

  it('scores nothing for squares merely adjacent to the centre', () => {
    const before = position([
      { at: 'd3', color: 'white', carrier: 'knight', rank: 'general', id: 'N1' },
      { at: 'c4', color: 'white', carrier: 'knight', rank: 'division', id: 'N2' },
      { at: 'e6', color: 'black', carrier: 'knight', rank: 'brigade', id: 'N3' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    ])
    const s = applyMove(before, mv('a1', 'b1'))
    expect(s.score).toEqual({ white: 0, black: 0.5 })
  })
})

describe('§7 both players score EVERY ply', () => {
  const before = position([
    { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
    { at: 'e5', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
    { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
  ])

  it('credits both sides on white ply AND on black ply', () => {
    const p1 = applyMove(before, mv('a1', 'b1'))
    expect(p1.score).toEqual({ white: 1, black: 1.5 })
    expect(lastEvent(p1).scoreAfter).toEqual({ white: 1, black: 1.5 })

    const p2 = applyMove(p1, mv('a8', 'b8'))
    expect(p2.score).toEqual({ white: 2, black: 2.5 })

    const p3 = applyMove(p2, mv('b1', 'a1'))
    expect(p3.score).toEqual({ white: 3, black: 3.5 })
    // 「一顆固守中央格的棋子，每一完整回合（雙方各一手）得 2 分」
    expect(p3.score.white - p1.score.white).toBe(2)
  })

  it('settles after a pass too (§3④「pass 為一次完整的行動階段，其後照常進入結算階段」)', () => {
    const s = applyMove(before, PASS)
    expect(s.score).toEqual({ white: 1, black: 1.5 })
  })

  it('pays 1 point per occupied 中央格, up to four', () => {
    const four = position([
      { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'A' },
      { at: 'e4', color: 'white', carrier: 'knight', rank: 'division', id: 'B' },
      { at: 'd5', color: 'white', carrier: 'bishop', rank: 'brigade', id: 'C' },
      { at: 'e5', color: 'white', carrier: 'bishop', rank: 'regiment', id: 'D' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    ])
    expect(applyMove(four, mv('a1', 'b1')).score).toEqual({ white: 4, black: 0.5 })
  })
})

describe('§7 計分不區分兵種', () => {
  it.each(['commander', 'engineer', 'flag', 'bomb'] as Rank[])(
    'a %s on d4 scores exactly the same 1 point',
    (rank) => {
      const before = position([
        { at: 'd4', color: 'white', carrier: 'knight', rank, id: 'X' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'general', id: 'WK' },
      ])
      expect(applyMove(before, mv('a1', 'b1')).score).toEqual({ white: 1, black: 0.5 })
    },
  )
})

describe('§7 「棋子若在①被吃掉，該手不計入其佔領分」', () => {
  it('the captured centre piece scores nothing; the arriving attacker does', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
      { at: 'd5', color: 'black', carrier: 'knight', rank: 'company', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd5'))
    expect(pieceById(s, 'BN').square).toBeNull()
    expect(pieceById(s, 'WR').square).toBe(sq('d5'))
    expect(s.score).toEqual({ white: 1, black: 0.5 })
    expect(lastEvent(s).scoreAfter).toEqual({ white: 1, black: 0.5 })
  })

  it('a LOSING attacker scores nothing and the defender keeps its centre point', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'company', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(pieceById(s, 'WR').square).toBeNull()
    expect(pieceById(s, 'BN').square).toBe(sq('d4'))
    expect(s.score).toEqual({ white: 0, black: 1.5 })
  })

  it('同階雙亡 on a centre square pays nobody', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'brigade', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'brigade', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(s.score).toEqual({ white: 0, black: 0.5 })
  })

  it('a 爆裂物 detonating on a centre square pays nobody', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'bomb', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'commander', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(s.score).toEqual({ white: 0, black: 0.5 })
  })

  it('a 工兵 that survives a 爆裂物 on a centre square DOES score it', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'engineer', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'bomb', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(pieceById(s, 'WR').square).toBe(sq('d4'))
    expect(s.score).toEqual({ white: 1, black: 0.5 })
  })
})

describe('§7 the log carries the running score for every ply', () => {
  it('records scoreAfter on each entry, in order', () => {
    const before = position([
      { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
    ])
    let s = before
    s = applyMove(s, mv('a1', 'b1'))
    s = applyMove(s, mv('a8', 'b8'))
    s = applyMove(s, mv('b1', 'a1'))
    expect(s.log.map((e) => e.scoreAfter)).toEqual([
      { white: 1, black: 0.5 },
      { white: 2, black: 0.5 },
      { white: 3, black: 0.5 },
    ])
    expect(s.log.map((e) => e.ply)).toEqual([1, 2, 3])
    expect(s.log.map((e) => e.color)).toEqual(['white', 'black', 'white'])
  })
})
