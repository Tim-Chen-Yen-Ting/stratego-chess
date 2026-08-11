/**
 * §3 移動 — carrier-layer generation, and every chess assumption this game
 * deliberately breaks.
 *
 *   ①  no check, no checkmate; the king is an ordinary carrier
 *   ②  castling is unconditional apart from three positional tests
 *   ③  no legal move ⇒ skip the turn; NOT stalemate
 *   ④  pass is always legal
 *   ⑤  no insufficient-material draw — king vs king is a normal position
 *   ⑥  no threefold repetition, no 50-move rule
 *
 * Plus a perft-style count over hand-computed positions.
 */

import { describe, expect, it } from 'vitest'
import { applyMove } from '../src/game.js'
import { hasAnyPieceMove, legalMoves, moveToNotation, parseMoveNotation } from '../src/moves.js'
import { createGame, defaultAssignment, submitAssignment } from '../src/setup.js'
import type { GameState, Move } from '../src/types.js'
import { PASS, mv, pieceById, position, sq } from './helpers.js'

/** The §9 opening with both assignments in, i.e. a game that is actually live. */
function openingGame(): GameState {
  let s = createGame('opening')
  s = submitAssignment(s, 'white', defaultAssignment('white', s))
  s = submitAssignment(s, 'black', defaultAssignment('black', s))
  return s
}

describe('§3④ pass is always legal', () => {
  it('is offered in the opening position', () => {
    expect(legalMoves(openingGame(), 'white')).toContainEqual(PASS)
  })

  it('is offered when the side to move is completely blocked', () => {
    const blocked = position([
      { at: 'a2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
      { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
    ])
    expect(legalMoves(blocked, 'white')).toEqual([PASS])
    expect(hasAnyPieceMove(blocked, 'white')).toBe(false)
  })

  it('is offered to a bare king', () => {
    const bare = position([
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
    ])
    expect(legalMoves(bare, 'white')).toContainEqual(PASS)
    expect(legalMoves(bare, 'black')).toContainEqual(PASS)
  })

  it('is the last entry of every generated list', () => {
    const s = openingGame()
    for (const color of ['white', 'black'] as const) {
      const moves = legalMoves(s, color)
      expect(moves[moves.length - 1]).toEqual(PASS)
      expect(moves.filter((m) => m.kind === 'pass')).toHaveLength(1)
    }
  })
})

describe('§3③ no legal move ⇒ skip the turn, 遊戲繼續', () => {
  const blocked = position([
    { at: 'a2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
    { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
    { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
  ])

  it('is not a draw and not a loss — the game simply continues', () => {
    const s = applyMove(blocked, PASS)
    expect(s.status).toEqual({ kind: 'playing' })
    expect(s.toMove).toBe('black')
    expect(s.ply).toBe(2)
  })
})

describe('§3⑤ no insufficient-material draw', () => {
  it('king vs king is a completely normal PLAYING position', () => {
    const bare = position([
      { at: 'd4', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'e6', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
    ])
    expect(bare.status).toEqual({ kind: 'playing' })
    let s: GameState = bare
    for (const m of [mv('d4', 'd3'), mv('e6', 'e7'), mv('d3', 'd4'), mv('e7', 'e6')]) {
      s = applyMove(s, m)
      expect(s.status).toEqual({ kind: 'playing' })
    }
    // §3⑥ — and repeating the position four times over is not a draw either.
    expect(s.status).toEqual({ kind: 'playing' })
  })

  it('king vs king where either king may itself BE the 軍旗 (§3⑤ 的原文例子)', () => {
    const bare = position([
      { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'WK' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
    ])
    const s = applyMove(bare, mv('a1', 'b1'))
    expect(s.status).toEqual({ kind: 'playing' })
    expect(legalMoves(s, 'black').length).toBeGreaterThan(1)
  })

  it('king vs king still scores the centre — 雙方皆可進中央收分', () => {
    const s = applyMove(
      position([
        { at: 'd3', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ]),
      mv('d3', 'd4'),
    )
    expect(s.score).toEqual({ white: 1, black: 0.5 })
  })
})

describe('§3① king 無特殊地位 — no check filter anywhere', () => {
  it('lets a king walk onto an attacked square', () => {
    const s = position([
      { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'd8', color: 'black', carrier: 'rook', rank: 'general', id: 'BR' },
    ])
    // d1 is on the black rook's file. In chess this is illegal; here it is not.
    expect(legalMoves(s, 'white')).toContainEqual(mv('e1', 'd1'))
    expect(applyMove(s, mv('e1', 'd1')).status).toEqual({ kind: 'playing' })
  })

  it('does not restrict a pinned piece', () => {
    const s = position([
      { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'e2', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
      { at: 'e8', color: 'black', carrier: 'rook', rank: 'division', id: 'BR' },
    ])
    expect(legalMoves(s, 'white')).toContainEqual(mv('e2', 'g3'))
  })
})

describe('§3② 王車易位 — unconditional apart from three positional tests', () => {
  function home(extra: Parameters<typeof position>[0] = [], toMove: 'white' | 'black' = 'white'): GameState {
    return position(
      [
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WRH' },
        { at: 'e8', color: 'black', carrier: 'king', rank: 'brigade', id: 'BK' },
        { at: 'a8', color: 'black', carrier: 'rook', rank: 'regiment', id: 'BRA' },
        { at: 'h8', color: 'black', carrier: 'rook', rank: 'battalion', id: 'BRH' },
        ...extra,
      ],
      { toMove },
    )
  }

  it('offers both sides when king and rooks are home, unmoved, and unobstructed', () => {
    const moves = legalMoves(home(), 'white')
    expect(moves).toContainEqual({ kind: 'castle', side: 'king' })
    expect(moves).toContainEqual({ kind: 'castle', side: 'queen' })
  })

  it('relocates king and rook, sets hasMoved on both, and touches nothing else', () => {
    const s = applyMove(home(), { kind: 'castle', side: 'king' })
    expect(pieceById(s, 'WK').square).toBe(sq('g1'))
    expect(pieceById(s, 'WRH').square).toBe(sq('f1'))
    expect(pieceById(s, 'WK').hasMoved).toBe(true)
    expect(pieceById(s, 'WRH').hasMoved).toBe(true)
    expect(pieceById(s, 'WRA').square).toBe(sq('a1'))
    expect(s.log[0]!.move).toEqual({ kind: 'castle', side: 'king' })
    expect(s.log[0]!.combat).toBeUndefined()
  })

  it('queen-side puts the king on c1 and the rook on d1', () => {
    const s = applyMove(home(), { kind: 'castle', side: 'queen' })
    expect(pieceById(s, 'WK').square).toBe(sq('c1'))
    expect(pieceById(s, 'WRA').square).toBe(sq('d1'))
  })

  it('works for black: e8→g8 / h8→f8 and e8→c8 / a8→d8', () => {
    const k = applyMove(home([], 'black'), { kind: 'castle', side: 'king' })
    expect(pieceById(k, 'BK').square).toBe(sq('g8'))
    expect(pieceById(k, 'BRH').square).toBe(sq('f8'))

    const q = applyMove(home([], 'black'), { kind: 'castle', side: 'queen' })
    expect(pieceById(q, 'BK').square).toBe(sq('c8'))
    expect(pieceById(q, 'BRA').square).toBe(sq('d8'))
  })

  it('條件 3: a piece between king and rook forbids that side only', () => {
    const s = home([{ at: 'f1', color: 'white', carrier: 'bishop', rank: 'company', id: 'WB' }])
    expect(legalMoves(s, 'white')).not.toContainEqual({ kind: 'castle', side: 'king' })
    expect(legalMoves(s, 'white')).toContainEqual({ kind: 'castle', side: 'queen' })
  })

  it('條件 3: an ENEMY piece between also blocks — 「兩者之間無子」', () => {
    const s = home([{ at: 'g1', color: 'black', carrier: 'knight', rank: 'company', id: 'BN' }])
    expect(legalMoves(s, 'white')).not.toContainEqual({ kind: 'castle', side: 'king' })
    expect(legalMoves(s, 'white')).toContainEqual({ kind: 'castle', side: 'queen' })
  })

  it('條件 3: b1 counts as between for the queen side', () => {
    const s = home([{ at: 'b1', color: 'white', carrier: 'knight', rank: 'company', id: 'WN' }])
    expect(legalMoves(s, 'white')).not.toContainEqual({ kind: 'castle', side: 'queen' })
    expect(legalMoves(s, 'white')).toContainEqual({ kind: 'castle', side: 'king' })
  })

  it('條件 2: a moved rook forbids that side only', () => {
    const s = position(
      [
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WRH', hasMoved: true },
      ],
      { toMove: 'white' },
    )
    expect(legalMoves(s, 'white')).not.toContainEqual({ kind: 'castle', side: 'king' })
    expect(legalMoves(s, 'white')).toContainEqual({ kind: 'castle', side: 'queen' })
  })

  it('條件 2: a moved king forbids both sides', () => {
    const s = position(
      [
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK', hasMoved: true },
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WRH' },
      ],
      { toMove: 'white' },
    )
    expect(legalMoves(s, 'white').filter((m) => m.kind === 'castle')).toEqual([])
  })

  it('條件 1: a king that is not standing on e1 cannot castle', () => {
    const s = position(
      [
        { at: 'd1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WRH' },
      ],
      { toMove: 'white' },
    )
    expect(s.pieces.every((p) => !p.hasMoved)).toBe(true)
    expect(legalMoves(s, 'white').filter((m) => m.kind === 'castle')).toEqual([])
  })

  it('IGNORES the three check-dependent chess preconditions', () => {
    // e1 "in check", f1 and g1 both "attacked". All three are irrelevant here.
    const s = home([
      { at: 'e7', color: 'black', carrier: 'rook', rank: 'company', id: 'X1' },
      { at: 'f7', color: 'black', carrier: 'rook', rank: 'platoon', id: 'X2' },
      { at: 'g7', color: 'black', carrier: 'rook', rank: 'engineer', id: 'X3' },
    ])
    expect(legalMoves(s, 'white')).toContainEqual({ kind: 'castle', side: 'king' })
    expect(applyMove(s, { kind: 'castle', side: 'king' }).status).toEqual({ kind: 'playing' })
  })
})

describe('§8 讀秒 increments', () => {
  const live = position([
    { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
    { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
  ])
  const inc = live.config.clockIncrementMs

  it('grants the increment on a completed move', () => {
    const s = applyMove(live, mv('b1', 'a1'))
    expect(s.clockMs.white).toBe(live.clockMs.white + inc)
    expect(s.clockMs.black).toBe(live.clockMs.black)
  })

  it('grants the increment on a castle', () => {
    const s = applyMove(
      position([
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
      ]),
      { kind: 'castle', side: 'king' },
    )
    expect(s.clockMs.white).toBe(live.clockMs.white + inc)
  })

  it('does NOT grant it on a 主動 pass', () => {
    const s = applyMove(live, PASS)
    expect(s.clockMs.white).toBe(live.clockMs.white)
  })

  it('DOES grant it on a 強制 pass (no legal move exists)', () => {
    const blocked = position([
      { at: 'a2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
      { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
    ])
    const s = applyMove(blocked, PASS)
    expect(s.clockMs.white).toBe(blocked.clockMs.white + inc)
  })

  it('skips the clock entirely when clockEnabled is false', () => {
    const off = position(
      [
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ],
      { config: { clockEnabled: false } },
    )
    expect(applyMove(off, mv('b1', 'a1')).clockMs).toEqual(off.clockMs)
  })
})

describe('applyMove rejects illegal input', () => {
  const s = position([
    { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
    { at: 'a2', color: 'white', carrier: 'pawn', rank: 'division', id: 'WP' },
    { at: 'h8', color: 'black', carrier: 'king', rank: 'brigade', id: 'BK' },
  ])

  it('refuses to capture your own piece', () => {
    expect(legalMoves(s, 'white')).not.toContainEqual(mv('a1', 'a2'))
    expect(() => applyMove(s, mv('a1', 'a2'))).toThrow(/illegal move/)
  })

  it('refuses a move from an empty square', () => {
    expect(() => applyMove(s, mv('d4', 'd5'))).toThrow(/illegal move/)
  })

  it("refuses to move the opponent's piece", () => {
    expect(() => applyMove(s, mv('h8', 'g8'))).toThrow(/illegal move/)
  })

  it('refuses a null move', () => {
    expect(() => applyMove(s, mv('a1', 'a1'))).toThrow(/illegal move/)
  })

  it('refuses a castle that is not available', () => {
    expect(() => applyMove(s, { kind: 'castle', side: 'king' })).toThrow(/illegal move/)
  })

  it('refuses any move while the game is not playing', () => {
    expect(() => applyMove(createGame('g'), PASS)).toThrow(/not accepting moves/)
    expect(legalMoves(createGame('g'), 'white')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// perft-style counts over hand-computed positions
// ---------------------------------------------------------------------------

interface Perft {
  label: string
  build: () => GameState
  white: number
  black?: number
}

const PERFTS: Perft[] = [
  {
    // 8 pawns × 2 + 2 knights × 2 = 20 piece moves, no castling (pieces between).
    label: '§9 opening position: 20 piece moves + pass',
    build: openingGame,
    white: 21,
    black: 21,
  },
  {
    // King on d4 has all 8 neighbours; king on h8 has g8, g7, h7.
    label: 'two lone kings, d4 and h8',
    build: () =>
      position([
        { at: 'd4', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ]),
    white: 9,
    black: 4,
  },
  {
    // Corner knight: b3 and c2 only.
    label: 'knight on a1',
    build: () =>
      position([
        { at: 'a1', color: 'white', carrier: 'knight', rank: 'commander', id: 'WN' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ]),
    white: 3,
  },
  {
    // 7 along the file + 7 along the rank.
    label: 'rook on d4, open board',
    build: () =>
      position([
        { at: 'd4', color: 'white', carrier: 'rook', rank: 'commander', id: 'WR' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ]),
    white: 15,
  },
  {
    // up d5+d6(capture)=2, down 3, right 4, left 3 = 12.
    label: 'rook on d4 with an enemy knight on d6',
    build: () =>
      position([
        { at: 'd4', color: 'white', carrier: 'rook', rank: 'commander', id: 'WR' },
        { at: 'd6', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ]),
    white: 13,
  },
  {
    // king 5 + Ra1 10 + Rh1 9 = 24 piece moves, + 2 castles + pass.
    label: 'castling shell: king e1, rooks a1/h1',
    build: () =>
      position([
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WRH' },
        { at: 'd8', color: 'black', carrier: 'king', rank: 'brigade', id: 'BK' },
      ]),
    white: 27,
  },
  {
    // a7a8 × 4 promotions + a7xb8 × 4 promotions.
    label: 'pawn on a7 with an enemy rook on b8',
    build: () =>
      position([
        { at: 'a7', color: 'white', carrier: 'pawn', rank: 'commander', id: 'WP', hasMoved: true },
        { at: 'b8', color: 'black', carrier: 'rook', rank: 'general', id: 'BR' },
        { at: 'h4', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ]),
    white: 9,
  },
  {
    // A pawn may never capture straight ahead, so a blocker kills both steps.
    label: 'pawn e2 blocked head-on by an enemy on e3',
    build: () =>
      position([
        { at: 'e2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'e3', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
      ]),
    white: 1,
  },
  {
    // The double step needs BOTH squares empty; e3 survives.
    label: 'pawn e2 with an enemy on e4',
    build: () =>
      position([
        { at: 'e2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'e4', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
      ]),
    white: 2,
  },
  {
    // e3, e4, xd3, xf3.
    label: 'pawn e2 with enemies on d3 and f3',
    build: () =>
      position([
        { at: 'e2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'd3', color: 'black', carrier: 'knight', rank: 'division', id: 'B1' },
        { at: 'f3', color: 'black', carrier: 'knight', rank: 'brigade', id: 'B2' },
      ]),
    white: 5,
  },
  {
    // Pawn blocked head-on, no capture available: pass is the entire move list.
    label: 'fully blocked side to move',
    build: () =>
      position([
        { at: 'a2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ]),
    white: 1,
  },
]

describe('perft-style move counts', () => {
  it.each(PERFTS)('$label', ({ build, white, black }) => {
    const s = build()
    expect(legalMoves(s, 'white')).toHaveLength(white)
    if (black !== undefined) expect(legalMoves(s, 'black')).toHaveLength(black)
  })

  it('en passant window: pawn b5 (b6, b5xa6 e.p.) + king h1 (3) + pass = 6', () => {
    const before = position(
      [
        { at: 'b5', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP', hasMoved: true },
        { at: 'a7', color: 'black', carrier: 'pawn', rank: 'company', id: 'BP' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ],
      { toMove: 'black', ply: 2 },
    )
    const s = applyMove(before, mv('a7', 'a5'))
    expect(legalMoves(s, 'white')).toHaveLength(6)
    expect(legalMoves(s, 'white')).toContainEqual(mv('b5', 'a6'))
    expect(legalMoves(s, 'white')).toContainEqual(mv('b5', 'b6'))
  })

  it('every generated move is accepted by applyMove', () => {
    const s = openingGame()
    for (const m of legalMoves(s, 'white') as Move[]) {
      expect(() => applyMove(s, m)).not.toThrow()
    }
  })

  it('the opening position offers no castling', () => {
    expect(legalMoves(openingGame(), 'white').filter((m) => m.kind === 'castle')).toEqual([])
  })

  it('a pawn cannot capture straight ahead nor step diagonally onto an empty square', () => {
    const s = position([
      { at: 'e2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
      { at: 'e3', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
    ])
    expect(legalMoves(s, 'white')).not.toContainEqual(mv('e2', 'e3'))
    expect(legalMoves(s, 'white')).not.toContainEqual(mv('e2', 'd3'))
    expect(legalMoves(s, 'white')).not.toContainEqual(mv('e2', 'f3'))
  })
})

describe('techspec §6 move notation round-trips', () => {
  it('renders the documented forms', () => {
    expect(moveToNotation(mv('e2', 'e4'))).toBe('e2e4')
    expect(moveToNotation(mv('e7', 'e8', 'queen'))).toBe('e7e8q')
    expect(moveToNotation(mv('e7', 'e8', 'knight'))).toBe('e7e8n')
    expect(moveToNotation({ kind: 'castle', side: 'king' })).toBe('O-O')
    expect(moveToNotation({ kind: 'castle', side: 'queen' })).toBe('O-O-O')
    expect(moveToNotation(PASS)).toBe('pass')
  })

  it('parses back every legal move of several positions', () => {
    const positions = [
      openingGame(),
      position([
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WRA' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'division', id: 'WRH' },
      ]),
      position([
        { at: 'a7', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP', hasMoved: true },
        { at: 'b8', color: 'black', carrier: 'rook', rank: 'division', id: 'BR' },
      ]),
    ]
    for (const s of positions) {
      for (const m of legalMoves(s, 'white')) {
        expect(parseMoveNotation(moveToNotation(m))).toEqual(m)
      }
    }
  })

  it('returns null on anything unparseable', () => {
    for (const bad of ['', 'e2', 'e2e', 'z9z9', 'e2e4k', 'castle', 'e2-e4']) {
      expect(parseMoveNotation(bad)).toBeNull()
    }
  })
})
