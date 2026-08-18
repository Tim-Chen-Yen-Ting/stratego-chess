import { describe, expect, it } from 'vitest'
import {
  applyMove,
  createGame,
  defaultAssignment,
  legalMoves,
  replayGame,
  resign,
  stateForViewer,
  submitAssignment,
} from '../src/index.js'
import type { Color, GameState, Move, Viewer, ViewerState } from '../src/index.js'

/**
 * `replayGame` rebuilds a finished game from its own log.
 *
 * The claim that matters is the information one: a PLAYER-perspective frame must
 * show what that side knew AT THAT PLY, never the finished game's full
 * disclosure. A replay that leaks the answer key is worse than no replay,
 * because it looks authoritative.
 */

const OMNI: Viewer = { kind: 'omniscient' }
const asWhite: Viewer = { kind: 'replay-player', color: 'white' }
const asBlack: Viewer = { kind: 'replay-player', color: 'black' }

function started(id: string, config?: Parameters<typeof createGame>[1]): GameState {
  let s = createGame(id, { clockEnabled: false, ...config })
  s = submitAssignment(s, 'white', defaultAssignment('white', s))
  s = submitAssignment(s, 'black', defaultAssignment('black', s))
  return s
}

/** Walk until the game ends on its own, or the ply budget runs out. */
function playOut(s: GameState, budget: number, seed: number): GameState {
  let state = s
  let r = seed >>> 0
  for (let i = 0; i < budget && state.status.kind === 'playing'; i++) {
    const ms: Move[] = legalMoves(state, state.toMove).filter((m) => m.kind !== 'pass')
    if (ms.length === 0) break
    r = (r * 1664525 + 1013904223) >>> 0
    state = applyMove(state, ms[r % ms.length]!)
  }
  return state
}

/** A finished game with contacts in it, so 翻明 actually happens. */
function finished(id: string, seed: number): GameState {
  const played = playOut(started(id), 60, seed)
  return played.status.kind === 'over' ? played : resign(played, 'black')
}

const publicPart = (vs: ViewerState) =>
  JSON.stringify({
    pieces: vs.pieces.map((p) => ({ ...p, rank: null })),
    score: vs.score,
    log: vs.log,
    status: vs.status,
    toMove: vs.toMove,
    ply: vs.ply,
  })

describe('replayGame — shape', () => {
  it('gives one frame per position: the opening plus one per ply', () => {
    const g = finished('shape', 11)
    const view = stateForViewer(g, OMNI)
    const frames = replayGame(view, OMNI)
    expect(frames).toHaveLength(view.log.length + 1)
  })

  it('every frame\'s score matches what the log recorded for that ply', () => {
    const g = finished('score', 23)
    const view = stateForViewer(g, OMNI)
    const frames = replayGame(view, OMNI)
    view.log.forEach((e, i) => {
      expect(frames[i + 1]!.score, `ply ${e.ply}`).toEqual(e.scoreAfter)
    })
  })

  it('the last frame reproduces the input under 全知', () => {
    const g = finished('last', 31)
    const view = stateForViewer(g, OMNI)
    const frames = replayGame(view, OMNI)
    expect(publicPart(frames[frames.length - 1]!)).toBe(publicPart(view))
    expect(frames[frames.length - 1]!.pieces).toEqual(view.pieces)
  })

  it('refuses an unfinished game rather than inventing one', () => {
    const s = playOut(started('live'), 8, 5)
    expect(s.status.kind).toBe('playing')
    expect(replayGame(stateForViewer(s, { kind: 'player', color: 'white' }), OMNI)).toEqual([])
  })
})

describe('replayGame — the information rule', () => {
  it('a 翻明 rank appears in the frame it was announced, not before', () => {
    // find a game where black reveals something mid-game
    let view: ViewerState | null = null
    let revealPly = -1
    for (let seed = 1; seed <= 40 && view === null; seed++) {
      const g = finished(`rev${seed}`, seed * 977)
      const v = stateForViewer(g, OMNI)
      const idx = v.log.findIndex(
        (e) =>
          e.combat !== undefined &&
          (e.combat.outcome.kind === 'attacker-wins' || e.combat.outcome.kind === 'defender-wins'),
      )
      // want the reveal to belong to BLACK, so白's replay is the one under test
      if (idx >= 0 && idx + 1 < v.log.length) {
        const e = v.log[idx]!
        const revealer: Color =
          e.combat!.outcome.kind === 'attacker-wins' ? e.color : e.color === 'white' ? 'black' : 'white'
        if (revealer === 'black') {
          view = v
          revealPly = idx
        }
      }
    }
    expect(view, 'no suitable game found').not.toBeNull()

    const frames = replayGame(view!, asWhite)
    // the piece black revealed on that ply
    const before = frames[revealPly]!
    const after = frames[revealPly + 1]!

    const newlyKnown = after.pieces.filter((p) => {
      if (p.color !== 'black' || p.rank === null) return false
      const was = before.pieces.find((q) => q.id === p.id)
      return was !== undefined && was.rank === null
    })
    expect(newlyKnown.length, 'the reveal should surface exactly at its own ply').toBeGreaterThan(0)
  })

  it('never shows an enemy rank the log had not yet announced', () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 12; seed++) {
      const view = stateForViewer(finished(`leak${seed}`, seed * 613), OMNI)
      for (const [viewer, mine] of [[asWhite, 'white'], [asBlack, 'black']] as const) {
        const frames = replayGame(view, viewer)
        // the last frame is 終局 and opens everything by §10.5 — exclude it
        for (let i = 0; i < frames.length - 1; i++) {
          const announced = new Set<string>()
          for (let j = 0; j < i; j++) {
            const c = view.log[j]?.combat
            if (c === undefined) continue
            if (c.outcome.kind === 'attacker-wins' || c.outcome.kind === 'defender-wins') {
              // some piece of the winning side became known; count it loosely
              announced.add(`${j}`)
            }
          }
          const shown = frames[i]!.pieces.filter((p) => p.color !== mine && p.rank !== null)
          if (shown.length > announced.size) {
            bad.push(`seed ${seed} ${mine} frame ${i}: ${shown.length} shown, ${announced.size} announced`)
          }
        }
      }
    }
    expect(bad.slice(0, 3)).toEqual([])
  })

  it('both players\' replays agree on every public fact and differ only in ranks', () => {
    const view = stateForViewer(finished('agree', 77), OMNI)
    const w = replayGame(view, asWhite)
    const b = replayGame(view, asBlack)
    expect(w).toHaveLength(b.length)

    let differing = 0
    for (let i = 0; i < w.length; i++) {
      expect(publicPart(w[i]!), `frame ${i}`).toBe(publicPart(b[i]!))
      w[i]!.pieces.forEach((p, j) => {
        if (p.rank !== b[i]!.pieces[j]!.rank) differing++
      })
    }
    // non-vacuous: the two really do disagree about ranks somewhere
    expect(differing).toBeGreaterThan(0)
  })
})

describe('replayGame — what the log cannot carry', () => {
  it('a resigned game still opens every 兵種 on its last frame (§10.5)', () => {
    // resign writes NO log entry, so replaying the log alone leaves the final
    // position `playing` — and entitledToRank would then hide ranks the viewer
    // is entitled to. Measured at 17/32 before this was handled.
    const played = playOut(started('resigned'), 20, 909)
    const over = resign(played, 'black')
    expect(over.status.kind).toBe('over')

    const view = stateForViewer(over, OMNI)
    const frames = replayGame(view, asWhite)
    const last = frames[frames.length - 1]!

    expect(last.status.kind).toBe('over')
    expect(last.pieces.every((p) => p.rank !== null)).toBe(true)
    expect(last.pieces.filter((p) => p.rank !== null)).toHaveLength(32)
  })

  it('holds the clock constant instead of inventing a per-ply reading', () => {
    // GameEvent records no timing, and applyMove only ADDS increment — so a
    // naive replay's clocks climb rather than fall. Every frame carries the
    // final reading; a consumer must not present it as stepping.
    const g = finished('clock', 4242, )
    const view = stateForViewer(g, OMNI)
    const frames = replayGame(view, OMNI)
    for (const f of frames) {
      expect(f.clockMs).toEqual(view.clockMs)
    }
  })
})
