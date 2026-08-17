/**
 * §7 ② 結算階段 — 計分格結算.
 *
 *   「每一手（ply）結束後皆執行結算，且只有剛行動的一方計分。」
 *   「每有一顆己方棋子佔領一個計分格則得 1 分。」
 *   「棋子若在①被吃掉，該手不計入其佔領分。」
 *   「計分不區分兵種。」
 *   「黑方開局即得 0.5 分，白方 0 分。」
 *
 * Mover-only settlement is the whole subject of this file. Score BOTH sides
 * every ply and white is structurally ahead: a square white takes on move m is
 * counted from ply 2m-1, black's mirror-image square only from ply 2m, so white
 * banks one extra settlement for EVERY acquiring move, all game. Settle once per
 * full turn instead and the counting evens out but the exposure does not —
 * white's placement can be evicted before it is ever counted, black's never can.
 *
 * Crediting the mover alone is neutral on both axes, and the symmetry block at
 * the bottom of this file is the test that says so. Without it a regression to
 * either of the other two rules is invisible: every other test here would still
 * pass with white quietly a point ahead per acquisition.
 *
 * Level income is still not a level game, though — white reaches any given total
 * half a turn earlier simply by moving first. That one belongs to §7.4② rather
 * than to settlement (X is read only at the close of a turn, never mid-turn), and
 * the last block in this file pins the two rules together: a mirror game is where
 * the difference between them is visible with nothing else in play.
 */

import { describe, expect, it } from 'vitest'
import { applyMove } from '../src/game.js'
import { createGame } from '../src/setup.js'
import { CENTER_SQUARES, DEFAULT_CONFIG } from '../src/constants.js'
import type { Color, GameState, Rank } from '../src/types.js'
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

describe('§7 計分格 default is exactly d4 / e4 / d5 / e5', () => {
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

describe('§7 settlement runs every ply and credits ONLY the mover', () => {
  const before = position([
    { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
    { at: 'e5', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
    { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
  ])

  it('pays the side that just moved and leaves the opponent untouched', () => {
    // White's ply. Black is sitting on e5 the whole time and is paid nothing
    // for it here — black banks e5 on black's own ply, not on white's.
    const p1 = applyMove(before, mv('a1', 'b1'))
    expect(p1.score).toEqual({ white: 1, black: 0.5 })
    expect(lastEvent(p1).scoreAfter).toEqual({ white: 1, black: 0.5 })

    // Black's ply. Now black is paid for e5, and white's d4 pays nothing.
    const p2 = applyMove(p1, mv('a8', 'b8'))
    expect(p2.score).toEqual({ white: 1, black: 1.5 })

    const p3 = applyMove(p2, mv('b1', 'a1'))
    expect(p3.score).toEqual({ white: 2, black: 1.5 })

    const p4 = applyMove(p3, mv('b8', 'a8'))
    expect(p4.score).toEqual({ white: 2, black: 2.5 })
  })

  it('pays a parked piece 1 point per FULL TURN, not 2', () => {
    const p1 = applyMove(before, mv('a1', 'b1'))
    const p2 = applyMove(p1, mv('a8', 'b8'))
    const p3 = applyMove(p2, mv('b1', 'a1'))
    const p4 = applyMove(p3, mv('b8', 'a8'))

    // One white piece held one 計分格 for the whole of two full turns.
    expect(p3.score.white - p1.score.white).toBe(1)
    expect(p4.score.black - p2.score.black).toBe(1)
    expect(p4.score.white).toBe(2)
    expect(p4.score.black - before.config.komi).toBe(2)
  })

  it('settles after a pass too — the passer is the mover (§3④)', () => {
    const s = applyMove(before, PASS)
    expect(s.score).toEqual({ white: 1, black: 0.5 })

    // …and black's pass pays black, not white.
    const t = applyMove(s, PASS)
    expect(t.score).toEqual({ white: 1, black: 1.5 })
  })

  it('pays 1 point per occupied 計分格, up to four', () => {
    const four = position([
      { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'A' },
      { at: 'e4', color: 'white', carrier: 'knight', rank: 'division', id: 'B' },
      { at: 'd5', color: 'white', carrier: 'bishop', rank: 'brigade', id: 'C' },
      { at: 'e5', color: 'white', carrier: 'bishop', rank: 'regiment', id: 'D' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    ])
    expect(applyMove(four, mv('a1', 'b1')).score).toEqual({ white: 4, black: 0.5 })
  })

  it('exactly one side\'s score can move per ply, and it is the mover\'s', () => {
    const start = position([
      { at: 'd4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
      { at: 'd5', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
    ])
    let s = start
    for (const m of [
      mv('a1', 'b1'), mv('a8', 'b8'),
      mv('b1', 'c1'), mv('b8', 'c8'),
      mv('c1', 'b1'), mv('c8', 'b8'),
    ]) {
      s = applyMove(s, m)
    }

    let prev = { white: 0, black: start.config.komi }
    for (const e of s.log) {
      const idle: Color = e.color === 'white' ? 'black' : 'white'
      expect(e.scoreAfter[idle], `ply ${e.ply}: ${idle} moved without moving`).toBe(prev[idle])
      expect(e.scoreAfter[e.color], `ply ${e.ply}: mover was not paid`).toBe(prev[e.color] + 1)
      prev = e.scoreAfter
    }
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

  it('a LOSING attacker scores nothing, and the defender banks d4 on its OWN ply', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'company', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(pieceById(s, 'WR').square).toBeNull()
    expect(pieceById(s, 'BN').square).toBe(sq('d4'))
    // White's settlement: white holds nothing. Black's surviving d4 piece is
    // NOT paid here — it is paid one ply later, when black moves.
    expect(s.score).toEqual({ white: 0, black: 0.5 })

    const t = applyMove(s, PASS)
    expect(t.score).toEqual({ white: 0, black: 1.5 })
  })

  it('同歸於盡 on a 計分格 pays nobody', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'brigade', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'brigade', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(s.score).toEqual({ white: 0, black: 0.5 })
  })

  it('a 爆裂物 taking a 計分格 piece with it pays nobody', () => {
    const before = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'bomb', id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: 'commander', id: 'BN' },
    ])
    const s = applyMove(before, mv('d1', 'd4'))
    expect(s.score).toEqual({ white: 0, black: 0.5 })
  })

  it('a 工兵 that survives a 爆裂物 on a 計分格 DOES score it', () => {
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
      { white: 1, black: 0.5 },   // white banks d4
      { white: 1, black: 0.5 },   // black moved and holds nothing
      { white: 2, black: 0.5 },   // white banks d4 again
    ])
    expect(s.log.map((e) => e.ply)).toEqual([1, 2, 3])
    expect(s.log.map((e) => e.color)).toEqual(['white', 'black', 'white'])
  })
})

// ---------------------------------------------------------------------------
// SYMMETRY — the point of mover-only settlement
// ---------------------------------------------------------------------------

/** 'd2' → 'd7'. Reflects a square across the horizontal midline. */
function mirrorSquare(nm: string): string {
  const file = nm[0]!
  const rank = Number(nm[1])
  if (!Number.isInteger(rank) || rank < 1 || rank > 8) {
    throw new Error(`test fixture: bad square name ${nm}`)
  }
  return `${file}${9 - rank}`
}

/**
 * A mirror-image opening: every white man has a black counterpart on the
 * reflected square, carrying the SAME 兵種 — so nothing but the colour and the
 * move order differs between the two sides.
 *
 * `scoreTarget` defaults to the config default, which the five-move script below
 * never comes near; the §7.4② block at the bottom lowers it on purpose so the
 * line is crossed inside the script.
 */
function mirrorGame(komi: number, scoreTarget: number = DEFAULT_CONFIG.scoreTarget): GameState {
  const white: { at: string; carrier: 'pawn' | 'knight' | 'bishop'; rank: Rank }[] = [
    { at: 'd2', carrier: 'pawn', rank: 'engineer' },
    { at: 'e2', carrier: 'pawn', rank: 'platoon' },
    { at: 'g1', carrier: 'knight', rank: 'brigade' },
    { at: 'b1', carrier: 'knight', rank: 'bomb' },
    { at: 'f1', carrier: 'bishop', rank: 'commander' },
    { at: 'a1', carrier: 'knight', rank: 'flag' },
  ]
  return position(
    white.flatMap((p, i) => [
      { at: p.at, color: 'white' as const, carrier: p.carrier, rank: p.rank, id: `W${i}` },
      {
        at: mirrorSquare(p.at),
        color: 'black' as const,
        carrier: p.carrier,
        rank: p.rank,
        id: `B${i}`,
      },
    ]),
    { config: { komi, scoreTarget } },
  )
}

/** White's script; black answers each one with its reflection. */
const MIRROR_SCRIPT: [string, string][] = [
  ['d2', 'd4'],   // takes a 計分格
  ['e2', 'e4'],   // takes a second one
  ['g1', 'f3'],   // holds both, no acquisition
  ['b1', 'c3'],
  ['f1', 'c4'],
]

/** Play white's script and black's mirror of it, alternately. */
function playMirror(komi: number): GameState {
  let s = mirrorGame(komi)
  for (const [from, to] of MIRROR_SCRIPT) {
    s = applyMove(s, mv(from, to))
    s = applyMove(s, mv(mirrorSquare(from), mirrorSquare(to)))
  }
  return s
}

describe('§7 symmetry — a mirror-image game scores dead level', () => {
  it('ends level when 貼目 is 0', () => {
    const s = playMirror(0)
    expect(s.score.white).toBe(s.score.black)
    expect(s.score).toEqual({ white: 9, black: 9 })
  })

  it('is level after EVERY full turn, not just at the end', () => {
    let s = mirrorGame(0)
    for (const [from, to] of MIRROR_SCRIPT) {
      s = applyMove(s, mv(from, to))
      expect(s.score.white, 'white is ahead mid-turn — that is the point of moving first')
        .toBeGreaterThanOrEqual(s.score.black)
      s = applyMove(s, mv(mirrorSquare(from), mirrorSquare(to)))
      expect(s.score.white, `unequal after white's ${from}${to} and its mirror`)
        .toBe(s.score.black)
    }
  })

  it('reproduces the four-ply worked example exactly', () => {
    // Two squares each, taken in mirror image, one ply apart:
    //   scoring both sides per ply  1-0 → 2-1 → 4-2 → 6-4   white +2
    //   mover only                  1-0 → 1-1 → 3-1 → 3-3   level
    let s = mirrorGame(0)
    for (const [from, to] of MIRROR_SCRIPT.slice(0, 2)) {
      s = applyMove(s, mv(from, to))
      s = applyMove(s, mv(mirrorSquare(from), mirrorSquare(to)))
    }
    expect(s.log.map((e) => e.scoreAfter)).toEqual([
      { white: 1, black: 0 },
      { white: 1, black: 1 },
      { white: 3, black: 1 },
      { white: 3, black: 3 },
    ])
  })

  it('leaves 貼目 as the ONLY asymmetry under the default config', () => {
    const s = playMirror(0.5)
    expect(s.score.black - s.score.white).toBe(s.config.komi)
    // Same board, same script — the whole difference is the half point black
    // was handed at ply 0, whose only job is making a tie impossible.
    expect(s.score.white).toBe(playMirror(0).score.white)
  })
})

describe('§7 symmetry — equal EXPOSURE, not just equal counting', () => {
  /**
   * Settling once per FULL TURN would also equalise the counting, and would
   * still be wrong: white's acquisition could be evicted before it was ever
   * counted, black's never could. Mover-only banks each side once before the
   * opponent can reply, so the same manoeuvre pays the same to either colour.
   *
   * Both halves below: take a 計分格 with a piece that the opponent can then
   * capture, and count what the manoeuvre earned before it was evicted.
   */
  it('pays white and black identically for a square held for exactly one ply', () => {
    // White takes d4 on ply 1; black evicts on ply 2.
    const whiteFirst = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'company', id: 'WR' },
      { at: 'd8', color: 'black', carrier: 'rook', rank: 'general', id: 'BR' },
    ], { config: { komi: 0 } })
    const w1 = applyMove(whiteFirst, mv('d1', 'd4'))
    expect(w1.score).toEqual({ white: 1, black: 0 })
    const w2 = applyMove(w1, mv('d8', 'd4'))
    expect(pieceById(w2, 'WR').square).toBeNull()
    const whiteEarned = w2.score.white - whiteFirst.score.white

    // Black takes d5 on ply 2; white evicts on ply 3. Same manoeuvre, mirrored,
    // one ply later — the position white is structurally ahead in under any
    // per-ply-both-sides rule.
    const blackSecond = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
      { at: 'd8', color: 'black', carrier: 'rook', rank: 'company', id: 'BR' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    ], { config: { komi: 0 } })
    const b1 = applyMove(blackSecond, mv('a1', 'b1'))
    expect(b1.score).toEqual({ white: 0, black: 0 })
    const b2 = applyMove(b1, mv('d8', 'd5'))
    expect(b2.score).toEqual({ white: 0, black: 1 })
    const b3 = applyMove(b2, mv('d1', 'd5'))
    expect(pieceById(b3, 'BR').square).toBeNull()
    const blackEarned = b3.score.black - blackSecond.score.black

    expect(whiteEarned).toBe(1)
    expect(blackEarned).toBe(1)
    expect(whiteEarned).toBe(blackEarned)
  })
})

describe('§7.4② symmetry — equal MOVES at the moment X is read', () => {
  /**
   * Settlement symmetry is only half of it. Even with the income dead level, the
   * side that moves first reaches any given total half a turn earlier — so a
   * target read after every settlement stops the game on a turn black was never
   * allowed to finish, and white wins on one extra move.
   *
   * The mirror game shows it with nothing else in play: identical armies on
   * reflected squares, black answering every white move with its reflection.
   * Put X where white's fourth settlement lands and the two rules disagree about
   * a game in which neither side has done anything the other did not do:
   *
   *   read after every settlement   stop at ply 7,  7 : 5.5  → white
   *   read at the close of the turn  stop at ply 8,  7 : 7.5  → black, on 貼目
   *
   * Only the second survives the question "how many moves has each side had?" —
   * four apiece, rather than four against three.
   */
  it('does not stop on white\'s crossing ply; black\'s reflection takes the turn', () => {
    let s = mirrorGame(0.5, 7)
    for (const [from, to] of MIRROR_SCRIPT.slice(0, 3)) {
      s = applyMove(s, mv(from, to))
      s = applyMove(s, mv(mirrorSquare(from), mirrorSquare(to)))
    }
    expect(s.score).toEqual({ white: 5, black: 5.5 })
    expect(s.status).toEqual({ kind: 'playing' })

    const [from, to] = MIRROR_SCRIPT[3]!
    const w = applyMove(s, mv(from, to))
    expect(w.score).toEqual({ white: 7, black: 5.5 })
    expect(w.score.white).toBeGreaterThanOrEqual(w.config.scoreTarget)
    expect(w.status, 'white crossed X on its own ply — the turn is not over')
      .toEqual({ kind: 'playing' })

    const b = applyMove(w, mv(mirrorSquare(from), mirrorSquare(to)))
    expect(b.score).toEqual({ white: 7, black: 7.5 })
    expect(b.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })

    expect(b.log.filter((e) => e.color === 'white')).toHaveLength(4)
    expect(b.log.filter((e) => e.color === 'black')).toHaveLength(4)
  })

  /**
   * 貼目 = 0 is a 附錄 B knob, and it is the one setting that can produce the tie
   * §7.4② says cannot happen — reading X per turn is what makes a perfect mirror
   * arrive at it. The fallback must stay deterministic rather than award the game
   * to whoever happened to move.
   */
  it('falls back to black on an exact tie, which only 貼目 = 0 can produce', () => {
    let s = mirrorGame(0, 7)
    for (const [from, to] of MIRROR_SCRIPT.slice(0, 4)) {
      s = applyMove(s, mv(from, to))
      s = applyMove(s, mv(mirrorSquare(from), mirrorSquare(to)))
    }
    expect(s.score).toEqual({ white: 7, black: 7 })
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })
  })
})
