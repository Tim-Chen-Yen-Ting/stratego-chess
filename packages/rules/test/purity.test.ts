/**
 * techspec §4 note 10: `applyMove` is pure — never mutate the input state.
 *
 * A rules engine that mutates in place cannot be re-run, replayed, or safely
 * shared between a socket handler and a clock timer, so this is checked for
 * every branch that touches the board.
 */

import { describe, expect, it } from 'vitest'
import { applyMove, flagFall, resign, tickClock } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import { createGame, defaultAssignment, submitAssignment } from '../src/setup.js'
import { stateForViewer } from '../src/redact.js'
import type { GameState, Move } from '../src/types.js'
import { PASS, mv, position, snapshot } from './helpers.js'

interface Case {
  label: string
  build: () => GameState
  move: Move
}

const CASES: Case[] = [
  {
    label: 'quiet move',
    build: () =>
      position([
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ]),
    move: mv('b1', 'a1'),
  },
  {
    label: 'attacker-wins capture',
    build: () =>
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: 'W' },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'company', id: 'B' },
      ]),
    move: mv('b2', 'b7'),
  },
  {
    label: 'defender-wins capture',
    build: () =>
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'company', id: 'W' },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'general', id: 'B' },
      ]),
    move: mv('b2', 'b7'),
  },
  {
    label: '同階雙亡',
    build: () =>
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'brigade', id: 'W' },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'brigade', id: 'B' },
      ]),
    move: mv('b2', 'b7'),
  },
  {
    label: '爆裂物 fizzle',
    build: () =>
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'engineer', id: 'W' },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'bomb', id: 'B' },
      ]),
    move: mv('b2', 'b7'),
  },
  {
    label: 'castle',
    build: () =>
      position([
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
      ]),
    move: { kind: 'castle', side: 'king' },
  },
  {
    label: 'promotion',
    build: () =>
      position([
        { at: 'a7', color: 'white', carrier: 'pawn', rank: 'battalion', id: 'WP', hasMoved: true },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      ]),
    move: mv('a7', 'a8', 'rook'),
  },
  {
    label: '奪旗 (game-ending)',
    build: () =>
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: 'W' },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'flag', id: 'B' },
      ]),
    move: mv('b2', 'b7'),
  },
  {
    label: 'pass',
    build: () =>
      position([
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
      ]),
    move: PASS,
  },
]

describe('applyMove is pure', () => {
  it.each(CASES)('$label leaves the input state untouched', ({ build, move }) => {
    const before = build()
    const frozen = snapshot(before)
    applyMove(before, move)
    expect(before).toEqual(frozen)
  })

  it.each(CASES)('$label shares no mutable structure with the input', ({ build, move }) => {
    const before = build()
    const after = applyMove(before, move)

    expect(after).not.toBe(before)
    expect(after.pieces).not.toBe(before.pieces)
    expect(after.score).not.toBe(before.score)
    expect(after.log).not.toBe(before.log)
    expect(after.clockMs).not.toBe(before.clockMs)
    expect(after.config).not.toBe(before.config)
    expect(after.status).not.toBe(before.status)
    for (const p of after.pieces) {
      expect(before.pieces).not.toContain(p)
    }
  })

  it('survives the result being scribbled on afterwards', () => {
    const before = CASES[1]!.build()
    const frozen = snapshot(before)
    const after = applyMove(before, CASES[1]!.move)

    after.pieces[0]!.square = 63
    after.pieces[0]!.revealed = true
    after.pieces[0]!.rank = 'bomb'
    after.score.white = 999
    after.clockMs.black = 1
    after.config.komi = 99
    after.log.push(after.log[0]!)

    expect(before).toEqual(frozen)
  })

  it('stays pure across a whole game', () => {
    let s = createGame('pure', { scoreTarget: 10_000, noProgressTurns: 10_000 })
    s = submitAssignment(s, 'white', defaultAssignment('white', s))
    s = submitAssignment(s, 'black', defaultAssignment('black', s))

    let seed = 987654321
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }

    for (let i = 0; i < 60 && s.status.kind === 'playing'; i++) {
      const frozen = snapshot(s)
      const moves = legalMoves(s, s.toMove)
      expect(s).toEqual(frozen)                       // legalMoves is read-only
      const nextState = applyMove(s, moves[next(moves.length)]!)
      expect(s).toEqual(frozen)                       // applyMove is read-only
      stateForViewer(s, { kind: 'player', color: 'white' })
      expect(s).toEqual(frozen)                       // stateForViewer is read-only
      s = nextState
    }
  })
})

describe('the other state transitions are pure too', () => {
  const live = (): GameState =>
    position([
      { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'b8', color: 'black', carrier: 'king', rank: 'general', id: 'BK' },
    ])

  it('resign does not mutate', () => {
    const s = live()
    const frozen = snapshot(s)
    const out = resign(s, 'white')
    expect(s).toEqual(frozen)
    expect(out.pieces).not.toBe(s.pieces)
  })

  it('flagFall does not mutate', () => {
    const s = live()
    const frozen = snapshot(s)
    const out = flagFall(s, 'white')
    expect(s).toEqual(frozen)
    expect(out.clockMs).not.toBe(s.clockMs)
  })

  it('tickClock does not mutate and floors at zero', () => {
    const s = live()
    const frozen = snapshot(s)
    const out = tickClock(s, 'white', s.clockMs.white + 5_000)
    expect(s).toEqual(frozen)
    expect(out.clockMs.white).toBe(0)
  })

  it('submitAssignment does not mutate', () => {
    const s = createGame('g')
    const frozen = snapshot(s)
    submitAssignment(s, 'white', defaultAssignment('white', s))
    expect(s).toEqual(frozen)
  })
})
