import { describe, expect, it } from 'vitest'
import {
  createGame,
  defaultAssignment,
  stateForViewer,
  submitAssignment,
} from '../src/index.js'
import type { Color, Viewer } from '../src/index.js'

/**
 * A side that has not deployed still carries the deterministic placeholder
 * assignment inside GameState. That placeholder is publicly predictable, so
 * reporting it as that player's 兵種 would hand anyone entitled to that side's
 * view a fabricated army dressed as fact (gamebook §10).
 *
 * The guard lives in `entitledToRank`, so it has to hold for EVERY consumer,
 * not just the ones that remembered to check `submitted`.
 */
describe('undeployed ranks are never disclosed during setup', () => {
  const viewersFor = (color: Color): Viewer[] => [
    { kind: 'player', color },
    { kind: 'spectator', bound: color },
    { kind: 'replay-player', color },
  ]

  it('hides a side that has not deployed, from every viewer bound to it', () => {
    const s = createGame('t1')
    for (const color of ['white', 'black'] as const) {
      for (const viewer of viewersFor(color)) {
        const view = stateForViewer(s, viewer)
        const own = view.pieces.filter((p) => p.color === color)
        expect(own).toHaveLength(16)
        expect(own.every((p) => p.rank === null)).toBe(true)
      }
    }
  })

  it('discloses that side the moment it deploys, and only that side', () => {
    let s = createGame('t2')
    s = submitAssignment(s, 'white', defaultAssignment('white', s))

    const asWhite = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(asWhite.pieces.filter((p) => p.color === 'white' && p.rank !== null)).toHaveLength(16)

    // black has still not deployed — its own player must not see the placeholder
    const asBlack = stateForViewer(s, { kind: 'player', color: 'black' })
    expect(asBlack.pieces.filter((p) => p.color === 'black' && p.rank !== null)).toHaveLength(0)

    // and neither side ever sees the other
    expect(asWhite.pieces.filter((p) => p.color === 'black' && p.rank !== null)).toHaveLength(0)
    expect(asBlack.pieces.filter((p) => p.color === 'white' && p.rank !== null)).toHaveLength(0)
  })

  it('still discloses normally once both sides deploy and play starts', () => {
    let s = createGame('t3')
    s = submitAssignment(s, 'white', defaultAssignment('white', s))
    s = submitAssignment(s, 'black', defaultAssignment('black', s))
    expect(s.status.kind).toBe('playing')

    const asWhite = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(asWhite.pieces.filter((p) => p.color === 'white' && p.rank !== null)).toHaveLength(16)
    expect(asWhite.pieces.filter((p) => p.color === 'black' && p.rank !== null)).toHaveLength(0)
  })

  it('leaks nothing through a serialised payload during setup', () => {
    const s = createGame('t4')
    // §2 count table lifted out — its keys are rank identifiers but it names
    // nobody and is identical for every viewer (see redaction.property.ts)
    const vs = stateForViewer(s, { kind: 'spectator', bound: 'white' })
    const raw = JSON.stringify({ ...vs, config: { ...vs.config, distribution: {} } })
    for (const rank of ['commander', 'flag', 'bomb', 'engineer', 'platoon']) {
      expect(raw).not.toContain(rank)
    }
  })

  it('omniscient replay still sees everything, setup included', () => {
    const s = createGame('t5')
    const view = stateForViewer(s, { kind: 'replay-omniscient' })
    expect(view.pieces.every((p) => p.rank !== null)).toBe(true)
  })
})
