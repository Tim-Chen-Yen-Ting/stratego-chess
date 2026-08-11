/**
 * §7 勝負條件 ② 計分 · ③ 停滯 · ④ 超時 · ⑤ 認輸.
 *
 *   「先達 X = 40 分者獲勝。若雙方於同一次結算同時越過 X，分數高者獲勝
 *     （因貼目，不可能相等）。」
 *   「連續 N = 30 個完整回合內，未發生任何吃子，且雙方皆未得分，則遊戲結束，
 *     分數高者獲勝。任何一次吃子或任何一分得分，計數歸零。」
 */

import { describe, expect, it } from 'vitest'
import { applyMove, flagFall, resign } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import { createGame, defaultAssignment, submitAssignment } from '../src/setup.js'
import type { GameState, Move } from '../src/types.js'
import { mv, position } from './helpers.js'

describe('§7② 計分 — first to X wins', () => {
  const before = position(
    [
      { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
    ],
    { config: { scoreTarget: 3 } },
  )

  it('ends the moment the target is reached exactly', () => {
    const p1 = applyMove(before, mv('a1', 'b1'))
    expect(p1.score.white).toBe(1)
    expect(p1.status).toEqual({ kind: 'playing' })

    const p2 = applyMove(p1, mv('a8', 'b8'))
    expect(p2.score.white).toBe(2)
    expect(p2.status).toEqual({ kind: 'playing' })

    const p3 = applyMove(p2, mv('b1', 'a1'))
    expect(p3.score.white).toBe(3)
    expect(p3.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
    expect(legalMoves(p3, 'black')).toEqual([])
  })
})

describe('§7② 同一次結算同時越過 X — 分數高者獲勝', () => {
  /** All four 中央格 held, two apiece, so both sides cross on the same ply. */
  function contested(score: { white: number; black: number }): GameState {
    return position(
      [
        { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'W1' },
        { at: 'e4', color: 'white', carrier: 'knight', rank: 'division', id: 'W2' },
        { at: 'd5', color: 'black', carrier: 'knight', rank: 'brigade', id: 'B1' },
        { at: 'e5', color: 'black', carrier: 'knight', rank: 'regiment', id: 'B2' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
      ],
      { score, config: { scoreTarget: 40 } },
    )
  }

  it('gives it to black when black ends higher', () => {
    const s = applyMove(contested({ white: 38, black: 38.5 }), mv('a1', 'b1'))
    expect(s.score).toEqual({ white: 40, black: 40.5 })
    expect(s.score.white).toBeGreaterThanOrEqual(40)
    expect(s.score.black).toBeGreaterThanOrEqual(40)
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })
  })

  it('gives it to white when white ends higher', () => {
    const s = applyMove(contested({ white: 39, black: 38.5 }), mv('a1', 'b1'))
    expect(s.score).toEqual({ white: 41, black: 40.5 })
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
  })

  it('never produces an equal score — 貼目 消滅平局', () => {
    for (const w of [36, 37, 38, 39]) {
      const s = applyMove(contested({ white: w, black: w + 0.5 }), mv('a1', 'b1'))
      expect(s.score.white).not.toBe(s.score.black)
    }
  })
})

describe('§7② 貼目 — the score can never tie in a real game', () => {
  /** Deterministic pseudo-random walk from the §9 opening. */
  it('keeps white integral and black half-integral for a whole game', () => {
    let s = createGame('parity', { scoreTarget: 10_000, noProgressTurns: 10_000 })
    s = submitAssignment(s, 'white', defaultAssignment('white', s))
    s = submitAssignment(s, 'black', defaultAssignment('black', s))

    let seed = 0x2f6e2b1
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }

    for (let i = 0; i < 80 && s.status.kind === 'playing'; i++) {
      const moves: Move[] = legalMoves(s, s.toMove)
      expect(moves.length).toBeGreaterThan(0)
      s = applyMove(s, moves[next(moves.length)]!)
      expect(s.score.white % 1).toBe(0)
      expect(s.score.black % 1).toBe(0.5)
      expect(s.score.white).not.toBe(s.score.black)
    }
  })
})

describe('§7③ 停滯 — the no-progress counter', () => {
  /** Kings only, 中央格 empty: nothing can score and nothing can be captured. */
  function kingsOnly(n: number): GameState {
    return position(
      [
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ],
      { config: { noProgressTurns: n } },
    )
  }

  it('counts FULL TURNS, not plies', () => {
    let s = kingsOnly(10)
    s = applyMove(s, mv('b1', 'a1'))       // ply 1, white
    expect(s.noProgressTurns).toBe(0)
    s = applyMove(s, mv('b8', 'a8'))       // ply 2, black — turn 1 closes
    expect(s.noProgressTurns).toBe(1)
    s = applyMove(s, mv('a1', 'b1'))       // ply 3
    expect(s.noProgressTurns).toBe(1)
    s = applyMove(s, mv('a8', 'b8'))       // ply 4 — turn 2 closes
    expect(s.noProgressTurns).toBe(2)
  })

  it('ends the game at N with 分數高者獲勝 (black, on 貼目 alone)', () => {
    let s = kingsOnly(2)
    s = applyMove(s, mv('b1', 'a1'))
    s = applyMove(s, mv('b8', 'a8'))
    expect(s.status).toEqual({ kind: 'playing' })
    s = applyMove(s, mv('a1', 'b1'))
    s = applyMove(s, mv('a8', 'b8'))
    expect(s.noProgressTurns).toBe(2)
    expect(s.score).toEqual({ white: 0, black: 0.5 })
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'no-progress', winner: 'black' } })
  })

  it('awards it to white when white is ahead on points', () => {
    // White banks two points from d4, then withdraws so the centre empties.
    let s = position(
      [
        { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ],
      { config: { noProgressTurns: 2, scoreTarget: 1000 } },
    )
    s = applyMove(s, mv('b1', 'a1'))       // ply 1: white scores → counter 0
    s = applyMove(s, mv('b8', 'a8'))       // ply 2: white scores → counter 0
    expect(s.score).toEqual({ white: 2, black: 0.5 })
    expect(s.noProgressTurns).toBe(0)

    s = applyMove(s, mv('d4', 'b5'))       // ply 3: knight leaves the centre
    expect(s.score).toEqual({ white: 2, black: 0.5 })
    s = applyMove(s, mv('a8', 'b8'))       // ply 4 — first quiet turn closes
    expect(s.noProgressTurns).toBe(1)
    s = applyMove(s, mv('a1', 'b1'))       // ply 5
    s = applyMove(s, mv('b8', 'a8'))       // ply 6 — second quiet turn closes
    expect(s.noProgressTurns).toBe(2)
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'no-progress', winner: 'white' } })
  })

  it('resets to zero on 任何一次吃子', () => {
    let s = position(
      [
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WR' },
        { at: 'h8', color: 'black', carrier: 'rook', rank: 'company', id: 'BR' },
      ],
      { config: { noProgressTurns: 10 } },
    )
    s = applyMove(s, mv('b1', 'a1'))
    s = applyMove(s, mv('b8', 'a8'))
    s = applyMove(s, mv('a1', 'b1'))
    s = applyMove(s, mv('a8', 'b8'))
    expect(s.noProgressTurns).toBe(2)

    s = applyMove(s, mv('h1', 'h8'))       // ply 5: a capture
    expect(s.noProgressTurns).toBe(0)

    // The half-turn straddling the capture must not close a no-progress turn.
    s = applyMove(s, mv('b8', 'a8'))       // ply 6
    expect(s.noProgressTurns).toBe(0)
    s = applyMove(s, mv('b1', 'a1'))       // ply 7
    expect(s.noProgressTurns).toBe(0)
    s = applyMove(s, mv('a8', 'b8'))       // ply 8 — first clean turn since
    expect(s.noProgressTurns).toBe(1)
  })

  it('resets to zero on 任何一分得分, with no capture involved', () => {
    let s = position(
      [
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
        { at: 'c2', color: 'white', carrier: 'knight', rank: 'division', id: 'WN' },
      ],
      { config: { noProgressTurns: 10, scoreTarget: 1000 } },
    )
    s = applyMove(s, mv('b1', 'a1'))
    s = applyMove(s, mv('b8', 'a8'))
    expect(s.noProgressTurns).toBe(1)

    s = applyMove(s, mv('c2', 'd4'))       // ply 3: white takes a 中央格
    expect(s.score).toEqual({ white: 1, black: 0.5 })
    expect(s.log[s.log.length - 1]!.combat).toBeUndefined()
    expect(s.noProgressTurns).toBe(0)
  })

  it('a pass does not by itself reset the counter', () => {
    let s = kingsOnly(10)
    s = applyMove(s, { kind: 'pass' })
    s = applyMove(s, { kind: 'pass' })
    expect(s.noProgressTurns).toBe(1)
  })

  it('advances through 強制 pass turns as well', () => {
    // §7③ defines the counter purely as "no 吃子 and no 得分"; a 強制 pass has
    // neither, so it advances. (§3③'s 不計次 is about not penalising the skipped
    // player — it does not exempt the turn from the stagnation guard.)
    let s = position(
      [
        { at: 'a2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { config: { noProgressTurns: 2 } },
    )
    expect(legalMoves(s, 'white')).toEqual([{ kind: 'pass' }])

    s = applyMove(s, { kind: 'pass' })     // ply 1, 強制
    s = applyMove(s, mv('b8', 'a8'))       // ply 2
    expect(s.noProgressTurns).toBe(1)
    s = applyMove(s, { kind: 'pass' })     // ply 3, 強制
    s = applyMove(s, mv('a8', 'b8'))       // ply 4
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'no-progress', winner: 'black' } })
  })
})

describe('§7④ 超時 and ⑤ 認輸', () => {
  const live = position([
    { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
  ])

  it('resignation hands the game to the opponent', () => {
    expect(resign(live, 'white').status).toEqual({
      kind: 'over',
      result: { kind: 'resign', winner: 'black' },
    })
    expect(resign(live, 'black').status).toEqual({
      kind: 'over',
      result: { kind: 'resign', winner: 'white' },
    })
  })

  it('resignation is available during setup (§7⑤ 隨時可認輸)', () => {
    const s = createGame('g')
    expect(s.status.kind).toBe('setup')
    expect(resign(s, 'black').status).toEqual({
      kind: 'over',
      result: { kind: 'resign', winner: 'white' },
    })
  })

  it('a flagged clock loses and is zeroed', () => {
    const s = flagFall(live, 'white')
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'timeout', winner: 'black' } })
    expect(s.clockMs.white).toBe(0)
    expect(s.clockMs.black).toBe(live.clockMs.black)
  })

  it('neither termination reopens a finished game', () => {
    const over = resign(live, 'white')
    expect(resign(over, 'black')).toBe(over)
    expect(flagFall(over, 'black')).toBe(over)
  })
})

describe('§3⑤⑥ — the draws that do NOT exist', () => {
  it('has no draw result other than flag-both', () => {
    // Result is a closed union; the only 和局 the gamebook admits is 雙方軍旗同時離場.
    const s = applyMove(
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'flag', id: 'W' },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'flag', id: 'B' },
      ]),
      mv('b2', 'b7'),
    )
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag-both' } })
  })
})
