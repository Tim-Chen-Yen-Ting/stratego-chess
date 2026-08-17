import { describe, expect, it } from 'vitest'
import {
  applyMove,
  carrierMoves,
  createGame,
  defaultAssignment,
  legalMoves,
  reachableSquares,
  stateForViewer,
  submitAssignment,
} from '../src/index.js'
import type { Color, GameState, Move, Viewer, ViewerState } from '../src/index.js'

/**
 * The claim this module rests on: move legality never touches the 兵種 layer
 * (gamebook §1, 附錄 A), so a redacted ViewerState already contains everything
 * move generation needs — for BOTH sides, not just the viewer's own.
 *
 * The test is therefore equality, not plausibility: for every position and every
 * viewer, `carrierMoves(view, color)` must equal `legalMoves(state, color)`
 * exactly, including the opponent's moves that `ViewerState.legalMoves` never
 * carries. Anything less would mean the module is a second, drifting copy of the
 * movement rules — which is precisely what it exists to prevent.
 */

const KEY = (m: Move): string =>
  m.kind === 'pass'
    ? 'pass'
    : m.kind === 'castle'
      ? `castle:${m.side}`
      : `${m.from}-${m.to}${m.promote ?? ''}`

const sorted = (ms: readonly Move[]): string[] => ms.map(KEY).sort()

function started(id: string): GameState {
  let s = createGame(id)
  s = submitAssignment(s, 'white', defaultAssignment('white', s))
  s = submitAssignment(s, 'black', defaultAssignment('black', s))
  return s
}

/** A cheap deterministic walk, so the corpus covers real mid-game shapes. */
function walk(s: GameState, plies: number, seed: number): GameState[] {
  const seen: GameState[] = [s]
  let state = s
  let r = seed >>> 0
  for (let i = 0; i < plies; i++) {
    if (state.status.kind !== 'playing') break
    const ms = legalMoves(state, state.toMove).filter((m) => m.kind !== 'pass')
    if (ms.length === 0) break
    r = (r * 1664525 + 1013904223) >>> 0
    state = applyMove(state, ms[r % ms.length]!)
    seen.push(state)
  }
  return seen
}

const VIEWERS: Viewer[] = [
  { kind: 'player', color: 'white' },
  { kind: 'player', color: 'black' },
  { kind: 'spectator', bound: 'white' },
  { kind: 'spectator-public' },
]

describe('carrierMoves — public information is enough to generate moves', () => {
  it('matches the authoritative generator for BOTH colours, from every viewer', () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 12; seed++) {
      for (const state of walk(started(`pm${seed}`), 40, seed * 7919)) {
        if (state.status.kind !== 'playing') continue
        for (const viewer of VIEWERS) {
          const view = stateForViewer(state, viewer)
          for (const color of ['white', 'black'] as Color[]) {
            const truth = sorted(legalMoves(state, color))
            const derived = sorted(carrierMoves(view, color))
            if (JSON.stringify(truth) !== JSON.stringify(derived)) {
              bad.push(`seed ${seed} ply ${state.ply} ${viewer.kind} ${color}`)
            }
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('agrees with the viewer\'s own legalMoves when one is present', () => {
    const s = started('own')
    const view = stateForViewer(s, { kind: 'player', color: s.toMove })
    expect(view.legalMoves).toBeDefined()
    expect(sorted(view.legalMoves!)).toEqual(sorted(carrierMoves(view, s.toMove)))
  })

  it('gives the OPPONENT\'s moves, which ViewerState never carries', () => {
    const s = started('opp')
    const me = s.toMove
    const them: Color = me === 'white' ? 'black' : 'white'
    const view = stateForViewer(s, { kind: 'player', color: me })

    // the payload has ours and only ours…
    expect(view.legalMoves).toBeDefined()
    expect(sorted(view.legalMoves!)).not.toEqual(sorted(carrierMoves(view, them)))
    // …and the derived list is exactly the truth for theirs
    expect(sorted(carrierMoves(view, them))).toEqual(sorted(legalMoves(s, them)))
  })

  it('is blind to 兵種 — permuting hidden ranks never moves the output', () => {
    const s = started('perm')
    const view = stateForViewer(s, { kind: 'player', color: 'white' })
    const before = sorted(carrierMoves(view, 'black'))

    // rotate black's ranks among themselves; legality must not notice
    const blacks = s.pieces.filter((p) => p.color === 'black')
    const rotated: GameState = {
      ...s,
      pieces: s.pieces.map((p) => {
        if (p.color !== 'black') return p
        const i = blacks.findIndex((b) => b.id === p.id)
        return { ...p, rank: blacks[(i + 1) % blacks.length]!.rank }
      }),
    }
    const after = sorted(carrierMoves(stateForViewer(rotated, { kind: 'player', color: 'white' }), 'black'))
    expect(after).toEqual(before)
  })

  it('tracks castling rights through the log, including a castle itself', () => {
    let s = started('castle')
    // clear b1/c1/d1 so white may castle queenside, then do it
    const path = ['b1c3', 'b8c6', 'c1e3', 'c8e6', 'd1d3', 'd8d6']
    const nm = (m: Move): string =>
      m.kind === 'move'
        ? `${'abcdefgh'[m.from % 8]}${Math.floor(m.from / 8) + 1}${'abcdefgh'[m.to % 8]}${Math.floor(m.to / 8) + 1}`
        : ''
    for (const want of path) {
      const m = legalMoves(s, s.toMove).find((x) => x.kind === 'move' && nm(x) === want)
      if (!m) break
      s = applyMove(s, m)
    }
    const view = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(sorted(carrierMoves(view, 'white'))).toEqual(sorted(legalMoves(s, 'white')))

    const castle = legalMoves(s, 'white').find((m) => m.kind === 'castle')
    if (castle) {
      const after = applyMove(s, castle)
      const v2 = stateForViewer(after, { kind: 'player', color: 'black' })
      // rights are gone afterwards, and the derived list must know it
      expect(sorted(carrierMoves(v2, 'white'))).toEqual(sorted(legalMoves(after, 'white')))
      expect(carrierMoves(v2, 'white').some((m) => m.kind === 'castle')).toBe(false)
    }
  })

  it('returns nothing once the game is over', () => {
    const s = started('over')
    const view = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(carrierMoves({ ...view, status: { kind: 'over', result: { kind: 'resign', winner: 'black' } } } as ViewerState, 'white')).toEqual([])
  })
})

describe('reachableSquares', () => {
  it('lists who can step onto each square, and agrees with carrierMoves', () => {
    const s = started('reach')
    const view = stateForViewer(s, { kind: 'player', color: 'white' })
    const reach = reachableSquares(view, 'black')

    const fromMoves = new Map<number, number>()
    for (const m of carrierMoves(view, 'black')) {
      if (m.kind !== 'move') continue
      fromMoves.set(m.to, (fromMoves.get(m.to) ?? 0) + 1)
    }
    for (const [sq, entries] of reach) {
      expect(entries.length, `square ${sq}`).toBe(fromMoves.get(sq))
    }
    expect(reach.size).toBe(fromMoves.size)
  })
})
