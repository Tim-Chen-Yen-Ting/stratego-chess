/**
 * The tests that make the arena's numbers admissible.
 *
 * Four claims are load-bearing, and each one is here because a violation of it
 * would not look like a bug — it would look like a finding:
 *
 *   1. the greedy instrument never initiates a capture. If it did, its scoring
 *      rate would be contaminated by combat luck, which is the one variable
 *      notebook §6.6 says has already caused two conclusions to be reversed.
 *   2. it never moves its 軍旗. A flag that wanders loses games (§7①) and the
 *      loss would be read as a weakness of the scoring strategy.
 *   3. a seed replays exactly. A surprising game that cannot be reopened is an
 *      anecdote, and anecdotes are what this package exists to replace.
 *   4. a policy cannot reach a hidden 兵種. Self-play statistics from a peeking
 *      bot describe a perfect-information variant nobody plays.
 */

import { describe, expect, it } from 'vitest'
import {
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
  applyMove,
  createGame,
  legalMoves,
  moveToNotation,
  stateForViewer,
  submitAssignment,
  validateAssignment,
} from '@xiyang/rules'
import type { Color, GameState, Move, PieceId, Square, ViewerState } from '@xiyang/rules'

import { deriveSeed, makeRng } from '../src/prng.js'
import type { Rng } from '../src/prng.js'
import { shapeOfMove } from '../src/policy.js'
import type { Policy } from '../src/policy.js'
import { greedyPolicy } from '../src/policies/greedy.js'
import { randomPolicy } from '../src/policies/random.js'
import { playGame, runMatch } from '../src/index.js'
import type { GameOutcome } from '../src/index.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A game with both sides deployed by `greedy`, ready for hand-driven plies. */
function deployedGame(seed = 1, config?: Parameters<typeof createGame>[1]): GameState {
  let state = createGame('unit', { clockEnabled: false, ...config })
  for (const color of ['white', 'black'] as const) {
    const rng = makeRng(deriveSeed(seed, `deploy:${color}`))
    const view = stateForViewer(state, { kind: 'player', color })
    state = submitAssignment(state, color, greedyPolicy.deploy(view, color, rng))
  }
  return state
}

function drive(state: GameState, moves: readonly [Square, Square][]): GameState {
  let s = state
  for (const [from, to] of moves) s = applyMove(s, { kind: 'move', from, to })
  return s
}

function flagIdOf(outcome: GameOutcome, color: Color): PieceId {
  const entry = Object.entries(outcome.deployment[color]).find(([, rank]) => rank === 'flag')
  if (!entry) throw new Error(`no 軍旗 in the ${color} deployment`)
  return entry[0]
}

/** 100 seeds played both ways round = exactly 200 games. */
function twoHundredGames(black: Policy, seed: number): GameOutcome[] {
  const summary = runMatch({
    seed,
    games: 100,
    white: greedyPolicy,
    black,
    swapColors: true,
    keepGames: true,
  })
  expect(summary.games).toBe(200)
  return summary.outcomes ?? []
}

const VS_RANDOM = twoHundredGames(randomPolicy, 4242)

// ---------------------------------------------------------------------------
// 1. never initiates a capture
// ---------------------------------------------------------------------------

describe('greedy never initiates a capture', () => {
  it('makes no contact on any of its own plies across 200 seeded games', () => {
    let greedyPlies = 0
    for (const outcome of VS_RANDOM) {
      for (const record of outcome.plyRecords) {
        if (outcome.policies[record.color] !== 'greedy') continue
        greedyPlies++
        expect(record.contact, `${outcome.id} ply ${record.ply} ${record.notation}`).toBe(false)
      }
    }
    // The invariant is worthless if the bot barely moved; assert it actually played.
    expect(greedyPlies).toBeGreaterThan(1000)
  })

  it('produces a contact-free game when both sides are greedy', () => {
    const summary = runMatch({
      seed: 7,
      games: 100,
      white: greedyPolicy,
      black: greedyPolicy,
      swapColors: true,
    })
    expect(summary.games).toBe(200)
    expect(summary.contacts.total).toBe(0)
    expect(summary.byPolicy.greedy?.capturesInitiated).toBe(0)
  })

  it('refuses en passant, whose victim is not on the destination square', () => {
    // 1.e4 a6 2.e5 d5 — black's double step exposes the only capture in the game
    // whose 接觸格 differs from its 目的格 (§4.2). A destination-square test would
    // wave it through.
    const state = drive(deployedGame(), [[12, 28], [48, 40], [28, 36], [51, 35]])
    const view = stateForViewer(state, { kind: 'player', color: 'white' })
    const ep: Move = { kind: 'move', from: 36, to: 43 }
    expect(legalMoves(state, 'white').some((m) => moveToNotation(m) === 'e5d6')).toBe(true)

    const shape = shapeOfMove(view, 'white', ep)
    expect(shape).not.toBeNull()
    expect(shape?.contact?.square).toBe(35)      // the victim stands on d5, not d6
    expect(shape?.contact?.color).toBe('black')

    const chosen = greedyPolicy.move(view, 'white', makeRng(1))
    expect(moveToNotation(chosen)).not.toBe('e5d6')
  })
})

// ---------------------------------------------------------------------------
// 2. never moves its 軍旗
// ---------------------------------------------------------------------------

describe('greedy never moves its 軍旗', () => {
  it('never logs a ply whose mover is its own flag piece, across 200 seeded games', () => {
    for (const outcome of VS_RANDOM) {
      for (const color of ['white', 'black'] as const) {
        if (outcome.policies[color] !== 'greedy') continue
        const flagId = flagIdOf(outcome, color)
        for (const record of outcome.plyRecords) {
          if (record.color !== color) continue
          expect(record.moverId, `${outcome.id} ply ${record.ply}`).not.toBe(flagId)
        }
      }
    }
  })

  it('leaves the flag on its deployment square unless the opponent takes it', () => {
    for (const outcome of VS_RANDOM) {
      for (const color of ['white', 'black'] as const) {
        if (outcome.policies[color] !== 'greedy') continue
        const flagId = flagIdOf(outcome, color)
        const start = outcome.final.pieces.find((p) => p.id === flagId)
        expect(start, flagId).toBeDefined()
        // Ids are `w-e2` — the starting square is in the id, and 軍旗 never
        // promotes anywhere it could change it.
        const home = flagId.slice(2)
        const square = start?.square
        // Either still home, or captured (§7① ends the game) — never elsewhere.
        if (square !== null && square !== undefined) {
          const name = 'abcdefgh'[square & 7]! + String((square >> 3) + 1)
          expect(name, `${outcome.id} ${color} flag`).toBe(home)
        }
      }
    }
  })

  it('would rather give up a scoring square than march the flag', () => {
    // Deploy the 軍旗 onto white's d-pawn by hand, then check d2d4 is off the
    // table while e2e4 — the mirror move on a piece that is not the flag — is not.
    let state = createGame('flag-unit', { clockEnabled: false })
    const ids = state.pieces.filter((p) => p.color === 'white').map((p) => p.id).sort()
    const rng = makeRng(99)
    const whiteView = stateForViewer(state, { kind: 'player', color: 'white' })
    const base = greedyPolicy.deploy(whiteView, 'white', rng)
    const flagHolder = Object.entries(base).find(([, r]) => r === 'flag')![0]
    const swapped = { ...base, [flagHolder]: base['w-d2']!, 'w-d2': 'flag' as const }
    expect(ids).toContain('w-d2')
    expect(validateAssignment(swapped, 'white', state)).toBeNull()

    state = submitAssignment(state, 'white', swapped)
    const blackView = stateForViewer(state, { kind: 'player', color: 'black' })
    state = submitAssignment(state, 'black', greedyPolicy.deploy(blackView, 'black', makeRng(5)))

    const view = stateForViewer(state, { kind: 'player', color: 'white' })
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(moveToNotation(greedyPolicy.move(view, 'white', makeRng(i))))
    expect(seen.has('d2d4')).toBe(false)
    expect(seen.has('e2e4')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. a seed replays exactly
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const run = (seed: number): GameOutcome =>
    playGame({ seed, white: greedyPolicy, black: randomPolicy })

  it('two runs of one seed produce identical game logs', () => {
    const a = run(20260816)
    const b = run(20260816)
    expect(b.plyRecords).toEqual(a.plyRecords)
    expect(b.deployment).toEqual(a.deployment)
    expect(b.score).toEqual(a.score)
    expect(b.result).toEqual(a.result)
    expect(JSON.stringify(b.final)).toBe(JSON.stringify(a.final))
  })

  it('two runs of one match summary are identical', () => {
    const opts = { seed: 11, games: 12, white: greedyPolicy, black: randomPolicy, swapColors: true }
    expect(JSON.stringify(runMatch(opts))).toBe(JSON.stringify(runMatch(opts)))
  })

  it('a different seed produces a different game — the seed is really threaded', () => {
    const a = run(1)
    const b = run(2)
    expect(JSON.stringify(b.plyRecords)).not.toBe(JSON.stringify(a.plyRecords))
  })

  it('changing one side leaves the other side\'s stream alone', () => {
    // The §6.6 requirement, mechanised: with per-side streams, White's first
    // tie-break draw cannot depend on who is sitting opposite.
    const rngA = makeRng(deriveSeed(555, 'move:white'))
    const rngB = makeRng(deriveSeed(555, 'move:white'))
    expect(rngA.next()).toBe(rngB.next())
    expect(deriveSeed(555, 'move:white')).not.toBe(deriveSeed(555, 'move:black'))
  })

  it('the prng is a pure function of its seed', () => {
    const draw = (seed: number): number[] => {
      const rng = makeRng(seed)
      return Array.from({ length: 8 }, () => rng.next())
    }
    expect(draw(3)).toEqual(draw(3))
    expect(draw(3)).not.toEqual(draw(4))
    for (const x of draw(3)) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
    const rng = makeRng(3)
    rng.next()
    rng.next()
    expect(rng.draws()).toBe(2)
    // A clone resumes from where the original stands, so the two streams stay
    // in step — that is what makes `state()` enough to reopen a run mid-game.
    const cloned = rng.clone()
    expect(cloned.state()).toBe(rng.state())
    expect(cloned.next()).toBe(rng.next())
  })

  it('shuffled returns a permutation and never mutates its input', () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8]
    const frozen = [...source]
    const out = makeRng(12).shuffled(source)
    expect(source).toEqual(frozen)
    expect([...out].sort((a, b) => a - b)).toEqual(frozen)
  })
})

// ---------------------------------------------------------------------------
// 4. a policy cannot reach a hidden 兵種
// ---------------------------------------------------------------------------

interface Capture {
  phase: 'deploy' | 'move'
  color: Color
  view: ViewerState
}

function spyOn(inner: Policy, sink: Capture[]): Policy {
  return {
    name: inner.name,
    deploy(view, color, rng) {
      sink.push({ phase: 'deploy', color, view })
      return inner.deploy(view, color, rng)
    },
    move(view, color, rng) {
      sink.push({ phase: 'move', color, view })
      return inner.move(view, color, rng)
    },
  }
}

/** Exactly the fields techspec §3 puts on a ViewerState. Anything else is a leak. */
const VIEWER_STATE_FIELDS = new Set([
  'id', 'pieces', 'toMove', 'ply', 'score', 'log', 'clockMs', 'noProgressTurns',
  'status', 'config', 'viewer', 'legalMoves', 'setupDeadlineMs',
])
const VIEWER_PIECE_FIELDS = ['carrier', 'color', 'id', 'rank', 'revealed', 'square']

describe('a policy sees a ViewerState and nothing else', () => {
  const captures: Capture[] = []
  const outcome = playGame({
    seed: 31337,
    white: spyOn(greedyPolicy, captures),
    black: spyOn(randomPolicy, captures),
  })

  it('captured something worth checking', () => {
    expect(captures.length).toBeGreaterThan(10)
    expect(captures.filter((c) => c.phase === 'deploy')).toHaveLength(2)
    expect(outcome.plies).toBeGreaterThan(0)
  })

  it('nulls every rank the viewer is not entitled to', () => {
    for (const { phase, color, view } of captures) {
      for (const piece of view.pieces) {
        const entitled =
          view.status.kind === 'over'
          || piece.revealed
          || (piece.color === color
            && (view.status.kind === 'playing'
              || (view.status.kind === 'setup' && view.status.submitted[color])))
        if (!entitled) {
          expect(piece.rank, `${phase} ${color} ${piece.id}`).toBeNull()
        }
      }
    }
  })

  it('shows no enemy rank beyond the ones 翻明 has published', () => {
    for (const { color, view } of captures) {
      if (view.status.kind !== 'playing') continue
      const enemy = view.pieces.filter((p) => p.color !== color)
      const disclosed = enemy.filter((p) => p.rank !== null).map((p) => p.id).sort()
      const revealed = enemy.filter((p) => p.revealed).map((p) => p.id).sort()
      expect(disclosed).toEqual(revealed)
    }
  })

  it('does disclose the policy\'s own army once it is deployed', () => {
    for (const { color, view } of captures) {
      if (view.status.kind !== 'playing') continue
      for (const piece of view.pieces.filter((p) => p.color === color)) {
        expect(piece.rank, piece.id).not.toBeNull()
      }
    }
    // …and withholds it during 佈署, when nobody has submitted: the engine's
    // placeholder ranks are not that player's army and must not be reported as
    // though they were.
    for (const { phase, view } of captures.filter((c) => c.phase === 'deploy')) {
      expect(phase).toBe('deploy')
      expect(view.pieces.every((p) => p.rank === null)).toBe(true)
    }
  })

  it('carries no field beyond the ViewerState contract', () => {
    for (const { view } of captures) {
      for (const key of Object.keys(view)) expect(VIEWER_STATE_FIELDS.has(key), key).toBe(true)
      for (const piece of view.pieces) {
        expect(Object.keys(piece).sort()).toEqual(VIEWER_PIECE_FIELDS)
      }
    }
  })

  it('hands a move list only to the side on turn, and only while playing', () => {
    for (const { phase, color, view } of captures) {
      if (phase === 'deploy') {
        expect(view.legalMoves).toBeUndefined()
        continue
      }
      expect(view.status.kind).toBe('playing')
      expect(view.toMove).toBe(color)
      expect(view.legalMoves).toBeDefined()
    }
  })

  it('gives a policy no way to write back into the game', () => {
    // A vandal that plays a normal move and then scribbles all over its copy of
    // the payload. `stateForViewer` deep-copies, so the game must be byte-identical
    // to one played by the same policies without the vandalism.
    const vandalise = (view: ViewerState): void => {
      for (const piece of view.pieces) {
        piece.square = null
        piece.rank = 'commander'
        piece.revealed = true
      }
      view.score.white = 999
      view.score.black = -999
      view.toMove = 'white'
      view.ply = -1
      view.noProgressTurns = 9999
      view.log.length = 0
      ;(view.config.scoringSquares as Square[]).push(0)
      view.config.scoreTarget = 1
    }
    const sabotage = (inner: Policy): Policy => ({
      name: inner.name,
      deploy(view, color, rng) {
        const out = inner.deploy(view, color, rng)
        vandalise(view)
        return out
      },
      move(view, color, rng) {
        const out = inner.move(view, color, rng)
        vandalise(view)
        return out
      },
    })

    const clean = playGame({ seed: 8, white: greedyPolicy, black: randomPolicy })
    const vandal = playGame({
      seed: 8,
      white: sabotage(greedyPolicy),
      black: sabotage(randomPolicy),
    })
    expect(vandal.plyRecords).toEqual(clean.plyRecords)
    expect(vandal.score).toEqual(clean.score)
    expect(vandal.result).toEqual(clean.result)
  })
})

// ---------------------------------------------------------------------------
// The policies themselves
// ---------------------------------------------------------------------------

describe('policies play by the rules', () => {
  it('both deploy a valid bijection onto the game\'s own 數量表', () => {
    for (const config of [undefined, { distribution: DISTRIBUTION_SCOUTS }]) {
      const state = createGame('deploy-check', { clockEnabled: false, ...config })
      for (let seed = 0; seed < 40; seed++) {
        for (const color of ['white', 'black'] as const) {
          const view = stateForViewer(state, { kind: 'player', color })
          for (const policy of [greedyPolicy, randomPolicy]) {
            const a = policy.deploy(view, color, makeRng(seed))
            expect(validateAssignment(a, color, state), `${policy.name} ${color} ${seed}`).toBeNull()
          }
        }
      }
    }
  })

  it('random only ever returns a move from view.legalMoves', () => {
    const state = deployedGame(3)
    const view = stateForViewer(state, { kind: 'player', color: 'white' })
    const legal = new Set((view.legalMoves ?? []).map(moveToNotation))
    expect(legal.size).toBeGreaterThan(1)
    const rng: Rng = makeRng(77)
    for (let i = 0; i < 500; i++) {
      expect(legal.has(moveToNotation(randomPolicy.move(view, 'white', rng)))).toBe(true)
    }
  })

  it('greedy takes an unheld 結算格 and then stands still', () => {
    // Both sides grab the two 結算格 they can reach in one step, then pass
    // forever: nothing else improves the position, and a pass still settles
    // (§7.1), so standing still banks the full holding.
    const outcome = playGame({ seed: 2, white: greedyPolicy, black: greedyPolicy, maxPlies: 12 })
    const first4 = outcome.plyRecords.slice(0, 4).map((r) => r.notation).sort()
    expect(first4).toEqual(['d2d4', 'd7d5', 'e2e4', 'e7e5'])
    for (const record of outcome.plyRecords.slice(4)) {
      expect(record.notation).toBe('pass')
      expect(record.moverId).toBeNull()
    }
  })

  it('greedy reaches the flank 結算格 when the config puts them in play', () => {
    // 附錄 B: the board shape is a setting. The bot reads
    // `view.config.scoringSquares`, so 側翼八格 needs no code change — and
    // notebook §3.3b's question about the flanks becomes a one-flag experiment.
    //
    // Asserted as properties, not as a move list: on the wide board the four
    // flank squares are contestable (see the next test), so which pieces get
    // there in which order is a race, and pinning the moves would be pinning the
    // tie-break dice.
    const outcome = playGame({
      seed: 2,
      white: greedyPolicy,
      black: greedyPolicy,
      config: { scoringSquares: SCORING_WIDE_8 },
    })
    expect(outcome.result?.kind).toBe('score')
    for (const color of ['white', 'black'] as const) {
      expect(outcome.stats.sides[color].objectiveMoves.ratio).toBe(1)
    }
    expect(outcome.stats.sides.white.peakSquaresHeld.count).toBeGreaterThanOrEqual(4)
    const moved = outcome.plyRecords.filter((r) => r.notation !== 'pass').length
    expect(moved).toBeGreaterThanOrEqual(7)
    // Once both sides have taken what they can reach, the rest is passes: a pass
    // settles (§7.1), so standing still is strictly better than stepping off.
    const tail = outcome.plyRecords.slice(-4)
    expect(tail.every((r) => r.notation === 'pass')).toBe(true)
  })

  it('takes an enemy flank square when the enemy has not claimed it yet', () => {
    // A behaviour nobody wrote and the arena found: on 側翼八格 the e-pawn's
    // departure opens d1–h5, and White's QUEEN reaches Black's h5 before Black's
    // h-pawn does. Black is held to three squares for the rest of the game.
    //
    // This is notebook §3.3b's 「側翼格放大強者」 as a mechanism rather than an
    // impression: the wide board does not merely pay the leader more, it hands
    // the side that moves first a way to take income off the other side.
    const outcome = playGame({
      seed: 3731512740,
      white: greedyPolicy,
      black: greedyPolicy,
      config: { scoringSquares: SCORING_WIDE_8 },
    })
    expect(outcome.plyRecords.slice(0, 5).map((r) => r.notation))
      .toEqual(['h2h4', 'd7d5', 'e2e4', 'e7e5', 'd1h5'])
    expect(outcome.stats.sides.white.peakSquaresHeld.count).toBe(5)
    expect(outcome.stats.sides.black.peakSquaresHeld.count).toBe(3)
    expect(outcome.winner).toBe('white')
  })

  it('greedy never vacates a 結算格 it holds', () => {
    for (const outcome of VS_RANDOM.slice(0, 40)) {
      for (const color of ['white', 'black'] as const) {
        if (outcome.policies[color] !== 'greedy') continue
        // Every greedy move landed on a scoring square (objRt = 1) and none of
        // them started on one, so the holding is monotone until the opponent
        // takes a piece off it.
        expect(outcome.stats.sides[color].objectiveMoves.ratio ?? 1).toBe(1)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The arena itself
// ---------------------------------------------------------------------------

describe('the harness', () => {
  it('rejects an illegal deployment and names the policy', () => {
    const cheat: Policy = {
      name: 'cheat',
      deploy: () => ({ 'w-a1': 'commander' }),
      move: () => ({ kind: 'pass' }),
    }
    expect(() => playGame({ seed: 1, white: cheat, black: randomPolicy }))
      .toThrow(/policy 'cheat' deployed white illegally/)
  })

  it('rejects an illegal move', () => {
    const cheat: Policy = {
      name: 'teleport',
      deploy: (view, color, rng) => randomPolicy.deploy(view, color, rng),
      move: () => ({ kind: 'move', from: 0, to: 63 }),
    }
    expect(() => playGame({ seed: 1, white: cheat, black: randomPolicy })).toThrow(/illegal move/)
  })

  it('reports a truncation instead of hiding it', () => {
    const outcome = playGame({ seed: 5, white: greedyPolicy, black: greedyPolicy, maxPlies: 6 })
    expect(outcome.truncated).toBe(true)
    expect(outcome.result).toBeNull()
    expect(outcome.winner).toBeNull()
    expect(outcome.plies).toBe(6)
  })

  it('aggregates by seat and by policy over the same games', () => {
    const summary = runMatch({
      seed: 3, games: 20, white: greedyPolicy, black: randomPolicy, swapColors: true,
    })
    expect(summary.games).toBe(40)
    expect(summary.byColor.white.games + summary.byColor.black.games).toBe(80)
    expect(summary.byPolicy.greedy!.games).toBe(40)
    expect(summary.byPolicy.random!.games).toBe(40)
    expect(summary.byPolicy.greedy!.wins + summary.byPolicy.random!.wins)
      .toBe(40 - (summary.resultKinds['flag-both'] ?? 0) - (summary.resultKinds['unfinished'] ?? 0))
  })
})
