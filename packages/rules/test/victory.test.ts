/**
 * §7 勝負條件 ② 計分 · ③ 停滯 · ④ 超時 · ⑤ 認輸.
 *
 *   「先達 X = 40 分者獲勝。若雙方於同一次結算同時越過 X，分數高者獲勝
 *     （因貼目，不可能相等）。」
 *   「連續 N = 30 個完整回合內，未發生任何吃子，且雙方皆未得分，則遊戲結束，
 *     分數高者獲勝。任何一次吃子或任何一分得分，計數歸零。」
 *
 * 先達 X is asked at the CLOSE OF A TURN — after the second player's ply, never
 * after the first player's. White moves first, so asking it after every
 * settlement stopped the game on ply 2m-1 the instant white crossed, with
 * black's m-th move unplayed: white won having had one more move than black.
 * Measured over 300 bot games that is 55/45 on 中央四格 and 68/32 on
 * 中央＋側翼八格, and it is worth exactly one settlement's income — the same
 * number a komi sweep called the "fair" 貼目, which is the same edge priced
 * rather than removed. Deferring the question removes it: whenever it is now
 * asked, both sides have played the same number of moves. That is also what
 * turns 「同時越過 X」 from a defensive clause into the ordinary case.
 *
 * 奪旗 (§7.4①) is untouched. It is decided in the ACTION sub-step and ends the
 * game where it stands, mid-turn or not.
 */

import { describe, expect, it } from 'vitest'
import { applyMove, flagFall, resign } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import { createGame, defaultAssignment, submitAssignment } from '../src/setup.js'
import type { Color, GameState, Move } from '../src/types.js'
import { mv, position } from './helpers.js'

/**
 * How many plies `color` has actually played, read off the public log.
 *
 * The whole point of testing X at the close of a turn is that this number is
 * equal for both sides at every score-decided ending, so every one of them
 * asserts it.
 */
function pliesPlayed(s: GameState, color: Color): number {
  return s.log.filter((e) => e.color === color).length
}

describe('§7② 計分 — X is tested at the close of a turn, not mid-turn', () => {
  const before = position(
    [
      { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
    ],
    { config: { scoreTarget: 3 } },
  )

  it('does NOT end when white crosses X on its own ply — black still gets its reply', () => {
    // §7 settles after every ply but credits ONLY the mover, so white's knight
    // on d4 pays on white's plies and on no others. Three points therefore take
    // three WHITE plies — ply 1, 3, 5 — not three plies.
    const p1 = applyMove(before, mv('a1', 'b1'))
    expect(p1.score.white).toBe(1)
    expect(p1.status).toEqual({ kind: 'playing' })

    // black's settlement credits black, who holds nothing: white's total is
    // untouched by the opponent's ply.
    const p2 = applyMove(p1, mv('a8', 'b8'))
    expect(p2.score.white).toBe(1)
    expect(p2.score.black).toBe(before.config.komi)
    expect(p2.status).toEqual({ kind: 'playing' })

    const p3 = applyMove(p2, mv('b1', 'a1'))
    expect(p3.score.white).toBe(2)
    expect(p3.status).toEqual({ kind: 'playing' })

    const p4 = applyMove(p3, mv('b8', 'a8'))
    expect(p4.score.white).toBe(2)
    expect(p4.status).toEqual({ kind: 'playing' })

    // Ply 5: white is AT the target. The old rule stopped here and gave white the
    // game — on a turn black had not been allowed to finish. It must not.
    const p5 = applyMove(p4, mv('a1', 'b1'))
    expect(p5.score.white).toBe(3)
    expect(p5.score.white).toBeGreaterThanOrEqual(before.config.scoreTarget)
    expect(p5.status).toEqual({ kind: 'playing' })
    expect(legalMoves(p5, 'black').length, 'black must still be allowed to answer')
      .toBeGreaterThan(0)

    // Ply 6 closes the turn, and only now is the target read. White is over it,
    // black is not, so white wins — one black move later than it used to.
    const p6 = applyMove(p5, mv('a8', 'b8'))
    expect(p6.score).toEqual({ white: 3, black: 0.5 })
    expect(p6.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
    expect(legalMoves(p6, 'white')).toEqual([])
    expect(pliesPlayed(p6, 'white')).toBe(pliesPlayed(p6, 'black'))
  })

  it('ends immediately when BLACK crosses X, because that ply completes the turn', () => {
    const blackScores = position(
      [
        { at: 'd5', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
      ],
      { score: { white: 0, black: 1.5 }, config: { scoreTarget: 3 } },
    )

    const p1 = applyMove(blackScores, mv('a1', 'b1'))
    expect(p1.score).toEqual({ white: 0, black: 1.5 })
    const p2 = applyMove(p1, mv('a8', 'b8'))
    expect(p2.score).toEqual({ white: 0, black: 2.5 })
    expect(p2.status).toEqual({ kind: 'playing' })

    const p3 = applyMove(p2, mv('b1', 'a1'))
    expect(p3.status).toEqual({ kind: 'playing' })

    // Black is the SECOND player, so black's own settlement closes the turn:
    // there is no half-turn owing to anybody and the game stops on the spot.
    const p4 = applyMove(p3, mv('b8', 'a8'))
    expect(p4.score).toEqual({ white: 0, black: 3.5 })
    expect(p4.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })
    expect(p4.log).toHaveLength(4)
    expect(legalMoves(p4, 'white')).toEqual([])
    expect(pliesPlayed(p4, 'white')).toBe(pliesPlayed(p4, 'black'))
  })
})

describe('§7② 同一次回合內雙方同時越過 X — 分數高者獲勝', () => {
  /** All four 中央格 held, two apiece: white banks its pair on white's ply and
   *  black banks its pair on the reply, so a turn can carry BOTH sides over X. */
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

  /**
   * The premise, unchanged: a settlement moves exactly ONE score. White's two
   * 結算格 pay on white's ply and black's two sit idle until black's.
   *
   * What changed is the consequence. While X was read after every settlement,
   * 「雙方同時越過 X」 was unreachable — white's crossing ended the game before
   * black could answer it. Reading X once per turn puts black's settlement back
   * inside the same decision, so both sides really can be over the line when the
   * question is asked, and the tie-break below is live code, not a defensive one.
   */
  it('moves exactly one score per settlement, even with both sides holding two', () => {
    const before = contested({ white: 10, black: 10.5 })
    const w = applyMove(before, mv('a1', 'b1'))
    expect(w.score).toEqual({ white: 12, black: 10.5 })

    const b = applyMove(w, mv('a8', 'b8'))
    expect(b.score).toEqual({ white: 12, black: 12.5 })
  })

  it('gives it to black when black replies over the line and ends higher', () => {
    const before = contested({ white: 38, black: 38.5 })

    // White's pair carries white to exactly X. Under the old rule this was the
    // end of the game and a white win; now it is half a turn.
    const w = applyMove(before, mv('a1', 'b1'))
    expect(w.score).toEqual({ white: 40, black: 38.5 })
    expect(w.status).toEqual({ kind: 'playing' })

    // Black's own pair carries black over it too, in the same turn.
    const b = applyMove(w, mv('a8', 'b8'))
    expect(b.score).toEqual({ white: 40, black: 40.5 })
    expect(b.score.white).toBeGreaterThanOrEqual(40)
    expect(b.score.black).toBeGreaterThanOrEqual(40)
    expect(b.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })
    expect(pliesPlayed(b, 'white')).toBe(pliesPlayed(b, 'black'))
  })

  it('gives it to white when white ends higher', () => {
    const w = applyMove(contested({ white: 39, black: 38.5 }), mv('a1', 'b1'))
    expect(w.score).toEqual({ white: 41, black: 38.5 })
    expect(w.status).toEqual({ kind: 'playing' })

    const b = applyMove(w, mv('a8', 'b8'))
    expect(b.score).toEqual({ white: 41, black: 40.5 })
    expect(b.score.white).toBeGreaterThanOrEqual(40)
    expect(b.score.black).toBeGreaterThanOrEqual(40)
    expect(b.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
    expect(pliesPlayed(b, 'white')).toBe(pliesPlayed(b, 'black'))
  })

  it('still awards a lone crosser — the reply only has to be allowed to happen', () => {
    const w = applyMove(contested({ white: 38, black: 30.5 }), mv('a1', 'b1'))
    expect(w.score.white).toBe(40)
    expect(w.status).toEqual({ kind: 'playing' })

    const b = applyMove(w, mv('a8', 'b8'))
    expect(b.score).toEqual({ white: 40, black: 32.5 })
    expect(b.score.black).toBeLessThan(40)
    expect(b.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
    expect(pliesPlayed(b, 'white')).toBe(pliesPlayed(b, 'black'))
  })

  it('never produces an equal score — 貼目 消滅平局', () => {
    for (const w of [36, 37, 38, 39]) {
      const white = applyMove(contested({ white: w, black: w + 0.5 }), mv('a1', 'b1'))
      expect(white.score.white).not.toBe(white.score.black)
      const both = applyMove(white, mv('a8', 'b8'))
      expect(both.score.white).not.toBe(both.score.black)
    }
  })
})

describe('§7.4① 奪旗 — still ends the game the instant it fires', () => {
  it('ends on white\'s ply, mid-turn, and black never replies', () => {
    const before = position(
      [
        { at: 'd1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
        { at: 'd4', color: 'black', carrier: 'knight', rank: 'flag', id: 'BF' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { score: { white: 39, black: 0.5 }, config: { scoreTarget: 40 } },
    )

    const s = applyMove(before, mv('d1', 'd4'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })
    expect(legalMoves(s, 'black')).toEqual([])

    // ① precedes ②: the settlement never ran at all, so white's new d4 is
    // unpaid. Deferring the SCORE test to the close of the turn says nothing
    // about 奪旗, which is not a scoring condition and does not wait for anyone.
    expect(s.score).toEqual({ white: 39, black: 0.5 })
    expect(pliesPlayed(s, 'white')).toBe(1)
    expect(pliesPlayed(s, 'black')).toBe(0)
  })

  it('lets black take the game on the very turn white crossed X', () => {
    const before = position(
      [
        { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
        { at: 'h4', color: 'white', carrier: 'rook', rank: 'flag', id: 'WF' },
        { at: 'h8', color: 'black', carrier: 'rook', rank: 'division', id: 'BR' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
      ],
      { score: { white: 39, black: 0.5 }, config: { scoreTarget: 40 } },
    )

    const w = applyMove(before, mv('a1', 'b1'))
    expect(w.score.white).toBe(40)                  // white is at X…
    expect(w.status).toEqual({ kind: 'playing' })   // …and the turn is not over

    // This is the move the old rule took away from black. Played, it wins.
    const b = applyMove(w, mv('h8', 'h4'))
    expect(b.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
    expect(b.score.white).toBeGreaterThanOrEqual(40)
    expect(pliesPlayed(b, 'white')).toBe(pliesPlayed(b, 'black'))
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
    s = applyMove(s, mv('b1', 'a1'))       // ply 1: white settles, +1 → counter 0
    s = applyMove(s, mv('b8', 'a8'))       // ply 2: black settles, +0 — but ply 1
    //                                     //   scored, so the turn is not quiet
    expect(s.score).toEqual({ white: 1, black: 0.5 })
    expect(s.noProgressTurns).toBe(0)

    s = applyMove(s, mv('d4', 'b5'))       // ply 3: knight leaves the centre, so
    //                                     //   white's own settlement pays 0
    expect(s.score).toEqual({ white: 1, black: 0.5 })
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

  it('a crossing not yet read is not a win — §7④⑤ are untouched by it', () => {
    // The state §7.4② deliberately does NOT model: white is over X, but the turn
    // has not closed, so the target has not been read. There is no 'pending win'
    // to honour — X is either met when the question is asked or it is not — and
    // the two terminations that do not come from a move must not be able to see
    // one. A 'pending win' status is exactly what would make these two award the
    // game to white instead.
    const crossed = applyMove(
      position(
        [
          { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
          { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
          { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
        ],
        { score: { white: 39, black: 0.5 }, config: { scoreTarget: 40 } },
      ),
      mv('a1', 'b1'),
    )
    expect(crossed.score.white).toBe(40)
    expect(crossed.status).toEqual({ kind: 'playing' })

    expect(resign(crossed, 'white').status).toEqual({
      kind: 'over',
      result: { kind: 'resign', winner: 'black' },
    })
    expect(flagFall(crossed, 'white').status).toEqual({
      kind: 'over',
      result: { kind: 'timeout', winner: 'black' },
    })
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
