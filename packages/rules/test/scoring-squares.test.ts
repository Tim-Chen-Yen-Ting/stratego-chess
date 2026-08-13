/**
 * §7 ② 結算階段 — WHICH squares score.
 *
 *   「D4 / E4 / D5 / E5 四格，每有一顆己方棋子佔領則得 1 分。」
 *
 * 附錄 B lists the board's tunables and says they 「必須為設定值，不得寫死」.
 * The scoring shape is now one of them: `config.scoringSquares`, defaulting to
 * the gamebook's four 中央格. A playtest said the centre-only board funnels the
 * whole game into four squares and leaves the flanks dead, so `SCORING_WIDE_8`
 * exists to be tried — which only means anything if the engine reads the config
 * everywhere and the default game is untouched.
 *
 * Four things are checked here:
 *   1. the presets map to the right squares, asserted BY NAME;
 *   2. settlement pays on a wide-8 flank square that is not a 中央格;
 *   3. a default game scores exactly what the pre-change engine scored;
 *   4. §7③ still keys off "no capture and no point", under either preset.
 */

import { describe, expect, it } from 'vitest'
import { squareName } from '../src/board.js'
import {
  CENTER_SQUARES,
  DEFAULT_CONFIG,
  DISTRIBUTION,
  SCORING_CENTRE_4,
  SCORING_WIDE_8,
} from '../src/constants.js'
import { applyMove, scoringPoints, scoringSquares } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import { stateForViewer } from '../src/redact.js'
import { renderForLLM } from '../src/render/text.js'
import { createGame, submitAssignment } from '../src/setup.js'
import type {
  Color,
  GameConfig,
  GameState,
  Move,
  PieceId,
  Rank,
  Square,
} from '../src/types.js'
import { lastEvent, mv, position, sq } from './helpers.js'

/**
 * The literal indices the engine carried before the shape became a setting.
 * Kept here, hard-coded, as the oracle for "nothing about a default game
 * changed" — if the default preset ever drifts off these four squares, every
 * score in every default game silently changes, and this array is what notices.
 */
const OLD_CENTER_SQUARES: readonly Square[] = [27, 28, 35, 36]

// ---------------------------------------------------------------------------
// 1. Preset index mapping — by NAME
// ---------------------------------------------------------------------------

describe('preset index mapping', () => {
  it('SCORING_CENTRE_4 is d4 e4 d5 e5, by name and by index', () => {
    expect(SCORING_CENTRE_4.map(squareName)).toEqual(['d4', 'e4', 'd5', 'e5'])
    expect([...SCORING_CENTRE_4]).toEqual([sq('d4'), sq('e4'), sq('d5'), sq('e5')])
    // the techspec §3 literals, spelled out: a1 = 0, so d4 = 3*8+3.
    expect([...SCORING_CENTRE_4]).toEqual([27, 28, 35, 36])
  })

  it('SCORING_WIDE_8 is those four PLUS a4 h4 a5 h5, by name and by index', () => {
    expect(SCORING_WIDE_8.map(squareName)).toEqual([
      'd4', 'e4', 'd5', 'e5', 'a4', 'h4', 'a5', 'h5',
    ])
    expect([...SCORING_WIDE_8]).toEqual([
      sq('d4'), sq('e4'), sq('d5'), sq('e5'), sq('a4'), sq('h4'), sq('a5'), sq('h5'),
    ])
    expect([...SCORING_WIDE_8].sort((a, b) => a - b)).toEqual([24, 27, 28, 31, 32, 35, 36, 39])
  })

  it('the wide preset contains the centre preset and adds exactly four squares', () => {
    const wide = new Set(SCORING_WIDE_8)
    expect(wide.size).toBe(8)
    for (const s of SCORING_CENTRE_4) expect(wide.has(s)).toBe(true)
    const added = SCORING_WIDE_8.filter((s) => !SCORING_CENTRE_4.includes(s))
    expect(added.map(squareName).sort()).toEqual(['a4', 'a5', 'h4', 'h5'])
    expect([...added].sort((a, b) => a - b)).toEqual([24, 31, 32, 39])
  })

  it('every preset square round-trips through its own name', () => {
    for (const preset of [SCORING_CENTRE_4, SCORING_WIDE_8]) {
      for (const s of preset) {
        expect(sq(squareName(s))).toBe(s)
      }
    }
  })

  it('CENTER_SQUARES is an alias of SCORING_CENTRE_4', () => {
    expect([...CENTER_SQUARES]).toEqual([...SCORING_CENTRE_4])
    expect(CENTER_SQUARES).toBe(SCORING_CENTRE_4)
  })

  it('DEFAULT_CONFIG keeps the gamebook four', () => {
    expect([...DEFAULT_CONFIG.scoringSquares]).toEqual([...SCORING_CENTRE_4])
    expect([...createGame('g').config.scoringSquares]).toEqual([...OLD_CENTER_SQUARES])
  })

  it('a preset is frozen — nobody can retune a running game by mutating a constant', () => {
    expect(Object.isFrozen(SCORING_CENTRE_4)).toBe(true)
    expect(Object.isFrozen(SCORING_WIDE_8)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Settlement pays on a wide-8 square that is NOT a 中央格
// ---------------------------------------------------------------------------

const WIDE: Partial<GameConfig> = { scoringSquares: SCORING_WIDE_8 }

/** One white piece parked on `at`, plus two kings so both sides can tempo. */
function parked(at: string, config?: Partial<GameConfig>): GameState {
  return position(
    [
      { at, color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
    ],
    config ? { config } : {},
  )
}

describe('§7 settlement reads config.scoringSquares', () => {
  it.each(['a4', 'h4', 'a5', 'h5'])(
    'a piece on the flank square %s scores under wide-8 and scores nothing by default',
    (flank) => {
      expect(applyMove(parked(flank, WIDE), mv('a1', 'b1')).score)
        .toEqual({ white: 1, black: 0.5 })
      expect(applyMove(parked(flank), mv('a1', 'b1')).score)
        .toEqual({ white: 0, black: 0.5 })
    },
  )

  it.each(['d4', 'e4', 'd5', 'e5'])(
    'the centre square %s still scores under wide-8 — the wide board ADDS squares',
    (centre) => {
      expect(applyMove(parked(centre, WIDE), mv('a1', 'b1')).score)
        .toEqual({ white: 1, black: 0.5 })
    },
  )

  it('pays 1 point per occupied square, centre and flank alike, up to eight', () => {
    const all = position(
      [
        ...SCORING_WIDE_8.map((square, i) => ({
          at: squareName(square),
          color: 'white' as Color,
          carrier: 'knight' as const,
          rank: 'general' as Rank,
          id: `W${i}`,
        })),
        { at: 'a1', color: 'white' as Color, carrier: 'king' as const, rank: 'commander' as Rank, id: 'WK' },
      ],
      { config: WIDE },
    )
    expect(applyMove(all, mv('a1', 'b1')).score).toEqual({ white: 8, black: 0.5 })
    // the same board scored by the default engine: only the four 中央格 pay.
    const sameBoardCentreOnly = { ...all, config: { ...all.config, scoringSquares: SCORING_CENTRE_4 } }
    expect(applyMove(sameBoardCentreOnly, mv('a1', 'b1')).score).toEqual({ white: 4, black: 0.5 })
  })

  it('both sides settle on the wide board, every ply (§7)', () => {
    const s0 = position(
      [
        { at: 'a4', color: 'white', carrier: 'knight', rank: 'general', id: 'WN' },
        { at: 'h5', color: 'black', carrier: 'knight', rank: 'division', id: 'BN' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
      ],
      { config: WIDE },
    )
    const p1 = applyMove(s0, mv('a1', 'b1'))
    expect(p1.score).toEqual({ white: 1, black: 1.5 })
    const p2 = applyMove(p1, mv('a8', 'b8'))
    expect(p2.score).toEqual({ white: 2, black: 2.5 })
    expect(lastEvent(p2).scoreAfter).toEqual({ white: 2, black: 2.5 })
  })

  it('「棋子若在①被吃掉，該手不計入其佔領分」 holds on a flank square too', () => {
    const before = position(
      [
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
        { at: 'a4', color: 'black', carrier: 'knight', rank: 'company', id: 'BN' },
      ],
      { config: WIDE },
    )
    const s = applyMove(before, mv('a1', 'a4'))
    expect(s.score).toEqual({ white: 1, black: 0.5 })
  })

  it('scoringPoints counts PIECES, so a repeated square cannot pay twice', () => {
    const pieces = parked('a4', WIDE).pieces
    expect(scoringPoints(pieces, 'white', [sq('a4'), sq('a4')])).toBe(1)
    expect(scoringPoints(pieces, 'white', [])).toBe(0)
  })

  it('scoringSquares() reports the game it is asked about, not a constant', () => {
    expect(scoringSquares(createGame('d')).map(squareName)).toEqual(['d4', 'e4', 'd5', 'e5'])
    expect(scoringSquares(createGame('w', WIDE)).map(squareName))
      .toEqual(SCORING_WIDE_8.map(squareName))
    // a fresh mutable copy: the caller cannot reach into the config
    const copy = scoringSquares(createGame('d'))
    copy.push(0)
    expect(createGame('d').config.scoringSquares).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// 3. A default game scores exactly what it scored before the change
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

function randomAssignment(color: Color, s: GameState, rnd: () => number): Record<PieceId, Rank> {
  const pool: Rank[] = []
  for (const [rank, n] of Object.entries(DISTRIBUTION) as [Rank, number][]) {
    for (let i = 0; i < n; i++) pool.push(rank)
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  const out: Record<PieceId, Rank> = {}
  s.pieces.filter((p) => p.color === color).forEach((p, i) => { out[p.id] = pool[i]! })
  return out
}

/**
 * A whole game, deterministic in `seed`. Move choice depends only on the seed
 * and on `legalMoves`, which reads the carrier layer alone — so two traces run
 * with the same seed differ only where the CONFIG makes them differ.
 */
function trace(seed: number, maxPlies: number, config?: Partial<GameConfig>): GameState[] {
  const rnd = rng(seed)
  let s = createGame('trace', config)
  s = submitAssignment(s, 'white', randomAssignment('white', s, rnd))
  s = submitAssignment(s, 'black', randomAssignment('black', s, rnd))

  const states: GameState[] = [s]
  while (s.status.kind === 'playing' && states.length <= maxPlies) {
    const options = legalMoves(s, s.toMove).filter((m) => m.kind !== 'pass')
    const move: Move = options.length > 0
      ? options[Math.floor(rnd() * options.length)]!
      : { kind: 'pass' }
    s = applyMove(s, move)
    states.push(s)
  }
  return states
}

/** The pre-change settlement, transcribed: +1 per own piece on 27/28/35/36. */
function oldCentrePoints(s: GameState, color: Color): number {
  return s.pieces.filter(
    (p) => p.color === color && p.square !== null && OLD_CENTER_SQUARES.includes(p.square),
  ).length
}

describe('a default game is unchanged', () => {
  it.each([1, 2, 3, 4, 5])(
    'seed %i: every ply pays exactly what the hard-coded centre four paid',
    (seed) => {
      const states = trace(seed, 120)
      expect(states.length).toBeGreaterThan(20)

      for (let i = 1; i < states.length; i++) {
        const before = states[i - 1]!
        const after = states[i]!
        // §7①: 奪旗 ends the game inside ① and settlement never runs.
        const flagEnded = after.status.kind === 'over'
          && (after.status.result.kind === 'flag' || after.status.result.kind === 'flag-both')
        const paid = flagEnded
          ? { white: 0, black: 0 }
          : { white: oldCentrePoints(after, 'white'), black: oldCentrePoints(after, 'black') }

        expect(after.score).toEqual({
          white: before.score.white + paid.white,
          black: before.score.black + paid.black,
        })
        expect(lastEvent(after).scoreAfter).toEqual(after.score)
      }
    },
  )

  it.each([1, 2, 3])(
    'seed %i: a game explicitly configured with the OLD literal indices is state-for-state identical',
    (seed) => {
      const byDefault = trace(seed, 80)
      const byLiteral = trace(seed, 80, { scoringSquares: [27, 28, 35, 36] })
      expect(byLiteral.length).toBe(byDefault.length)
      for (let i = 0; i < byDefault.length; i++) {
        expect(byLiteral[i]).toEqual(byDefault[i])
      }
    },
  )

  it('the default board pays nothing for the wide-8 flank squares', () => {
    for (const flank of ['a4', 'h4', 'a5', 'h5']) {
      expect(applyMove(parked(flank), mv('a1', 'b1')).score).toEqual({ white: 0, black: 0.5 })
    }
  })
})

// ---------------------------------------------------------------------------
// 4. §7③ 停滯 — still "no capture AND no point", under either preset
// ---------------------------------------------------------------------------

/** White king a1↔b1, black king a8↔b8: full turns that capture nothing. */
const SHUFFLE: Move[] = [mv('a1', 'b1'), mv('a8', 'b8'), mv('b1', 'a1'), mv('b8', 'a8')]

function shuffle(s0: GameState, turns: number): GameState {
  let s = s0
  for (let i = 0; i < turns * 2; i++) {
    if (s.status.kind !== 'playing') break
    s = applyMove(s, SHUFFLE[i % SHUFFLE.length]!)
  }
  return s
}

describe('§7③ 停滯 keys off "no capture and no point", under either preset', () => {
  it('an idle board advances the counter once per FULL turn, under both presets', () => {
    for (const config of [undefined, WIDE]) {
      const idle = position(
        [
          { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
          { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
        ],
        config ? { config } : {},
      )
      expect(shuffle(idle, 1).noProgressTurns).toBe(1)
      expect(shuffle(idle, 3).noProgressTurns).toBe(3)
      expect(shuffle(idle, 3).score).toEqual({ white: 0, black: 0.5 })
    }
  })

  it('a piece on a4 stops the counter under wide-8 and does NOT under the default', () => {
    const pieces = [
      { at: 'a4' as const, color: 'white' as Color, carrier: 'knight' as const, rank: 'general' as Rank, id: 'WN' },
      { at: 'a1' as const, color: 'white' as Color, carrier: 'king' as const, rank: 'commander' as Rank, id: 'WK' },
      { at: 'a8' as const, color: 'black' as Color, carrier: 'king' as const, rank: 'battalion' as Rank, id: 'BK' },
    ]

    // wide-8: a4 pays white a point every ply, so 「雙方皆未得分」 is false.
    const wide = shuffle(position(pieces, { config: WIDE }), 5)
    expect(wide.noProgressTurns).toBe(0)
    expect(wide.score.white).toBe(10)

    // default: a4 is an ordinary square. Nobody scores, so the counter runs.
    const centre = shuffle(position(pieces), 5)
    expect(centre.noProgressTurns).toBe(5)
    expect(centre.score).toEqual({ white: 0, black: 0.5 })
  })

  it('a single point resets a running counter, on a flank square under wide-8', () => {
    const s0 = position(
      [
        { at: 'a3', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
      ],
      { config: WIDE },
    )
    let s = s0
    s = applyMove(s, mv('h1', 'g1'))
    s = applyMove(s, mv('a8', 'b8'))
    expect(s.noProgressTurns).toBe(1)
    expect(s.score).toEqual({ white: 0, black: 0.5 })

    s = applyMove(s, mv('a3', 'a4'))     // steps onto a wide-8 square: +1 white
    expect(s.score).toEqual({ white: 1, black: 0.5 })
    expect(s.noProgressTurns).toBe(0)
  })

  it('a capture still zeroes the counter on the wide board', () => {
    const s0 = position(
      [
        { at: 'b1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
        { at: 'b7', color: 'black', carrier: 'knight', rank: 'company', id: 'BN' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'brigade', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
      ],
      { config: WIDE, noProgressTurns: 4 },
    )
    const s = applyMove(s0, mv('b1', 'b7'))
    expect(lastEvent(s).combat).toBeDefined()
    expect(s.noProgressTurns).toBe(0)
  })

  it('reaching N ends the game on score, under either preset', () => {
    for (const shape of [SCORING_CENTRE_4, SCORING_WIDE_8]) {
      const idle = position(
        [
          { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
          { at: 'a8', color: 'black', carrier: 'king', rank: 'battalion', id: 'BK' },
        ],
        { config: { scoringSquares: shape, noProgressTurns: 2 } },
      )
      const s = shuffle(idle, 2)
      expect(s.status).toEqual({
        kind: 'over',
        // 「分數高者獲勝」 — with nobody scoring, komi decides it.
        result: { kind: 'no-progress', winner: 'black' },
      })
    }
  })
})

// ---------------------------------------------------------------------------
// The LLM view must name the squares of the game it is rendering
// ---------------------------------------------------------------------------

const RENDER_OPTS = { baseUrl: 'https://example.test', token: 'tok' }

function scoringBlock(s: GameState): string {
  const text = renderForLLM(stateForViewer(s, { kind: 'player', color: 'white' }), RENDER_OPTS)
  const lines = text.split(String.fromCharCode(10))
  const start = lines.findIndex((l) => l.startsWith('Scoring squares'))
  expect(start).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((l, i) => i > start && l.trim() === '')
  return lines.slice(start, end).join('|')
}

describe('renderForLLM names the actual scoring squares', () => {
  it('a default game is told the four 中央格', () => {
    for (const n of ['d4', 'e4', 'd5', 'e5']) expect(scoringBlock(parked('d4'))).toContain(n)
    expect(scoringBlock(parked('d4'))).toContain('of 4')
  })

  it('a wide-8 game is told all eight, flanks included', () => {
    for (const n of ['d4', 'e4', 'd5', 'e5', 'a4', 'h4', 'a5', 'h5'])
      expect(scoringBlock(parked('a4', WIDE))).toContain(n)
    expect(scoringBlock(parked('a4', WIDE))).toContain('of 8')
  })

  it('marks an unoccupied scoring square EMPTY and counts them', () => {
    // The actionable half. In a real LLM-vs-LLM game a5 sat empty for 26 plies
    // with a one-move pawn push available and never got taken — the view named
    // the squares but never said which were free.
    const b = scoringBlock(parked('d4', WIDE))
    expect(b).toContain('d4 White')
    expect(b).toContain('e4 EMPTY')
    expect(b).toContain('You hold 1 of 8')
    expect(b).toContain('7 EMPTY')
  })

  it('a custom shape is named too — the render never falls back to the default', () => {
    const odd = parked('b2', { scoringSquares: [sq('b2'), sq('g7')] })
    expect(scoringBlock(odd)).toContain('b2')
    expect(scoringBlock(odd)).toContain('g7')
    expect(scoringBlock(odd)).not.toContain('d4')
  })
})
