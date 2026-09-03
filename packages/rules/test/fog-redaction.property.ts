/**
 * 戰爭迷霧模式 property tests — fogofwar.md §1, §1.3, §4.3.
 *
 * `redaction.property.ts` proves the RANK boundary by three independent
 * methods over a corpus of non-fog games (that corpus never sets
 * `fogOfWar: true`, so none of it is touched by this file). This file proves
 * the POSITION boundary fog adds on top: an enemy piece a viewer's own army
 * cannot currently see must be ABSENT from `stateForViewer`'s payload, not
 * merely rank-redacted — `ViewerState.pieces` under fog can therefore be
 * shorter than `GameState.pieces`, so every check here matches pieces by
 * `id`, never by array index (unlike the rank suites, which can rely on the
 * two arrays staying the same length).
 *
 * Registered into `fog.test.ts` the same way `redaction.property.ts` rides
 * into `redaction.test.ts` — vitest's `include` glob only collects
 * `*.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  applyMove,
  createGame,
  entitledToRank,
  legalMoves,
  positionVisible,
  stateForViewer,
  submitAssignment,
} from '@xiyang/rules'
import type { Color, GameConfig, GameState, PieceId, Rank, Viewer, ViewerState } from '@xiyang/rules'
import { ALL_VIEWERS, mulberry32, viewerLabel, type Rng } from './redaction.property.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pick<T>(xs: readonly T[], rng: Rng): T {
  return xs[Math.floor(rng() * xs.length) % xs.length]!
}

/** A fog-enabled game, both sides deployed with a fixed (non-random) assignment. */
export function startedFogGame(id: string, config: Partial<GameConfig> = {}): GameState {
  const fresh = createGame(id, { ...config, fogOfWar: true })
  const own = (color: Color) => {
    const out: Record<PieceId, Rank> = {}
    // deterministic bijection: the default placeholder table is already a
    // legal assignment for the standard distribution, so just read it back.
    for (const p of fresh.pieces) if (p.color === color) out[p.id] = p.rank
    return out
  }
  return submitAssignment(submitAssignment(fresh, 'white', own('white')), 'black', own('black'))
}

export interface FogCorpusEntry {
  label: string
  state: GameState
}

/** Random legal play from a fog opening, sampled at intervals. */
export function buildFogCorpus(opts: { games: number; maxPlies: number; seed: number }): FogCorpusEntry[] {
  const rng = mulberry32(opts.seed)
  const out: FogCorpusEntry[] = []

  for (let g = 0; g < opts.games; g++) {
    let s = startedFogGame(`fog-${g}`)
    out.push({ label: `fog-${g}/ply${s.ply}`, state: s })

    for (let i = 0; i < opts.maxPlies && s.status.kind === 'playing'; i++) {
      s = applyMove(s, pick(legalMoves(s, s.toMove), rng))
      if (i % 3 === 0 || s.status.kind === 'over') out.push({ label: `fog-${g}/ply${s.ply}`, state: s })
    }
  }
  return out
}

const CORPUS = buildFogCorpus({ games: 40, maxPlies: 50, seed: 0xf09 })

// ---------------------------------------------------------------------------
// Helpers — everything matched by id, never by array index
// ---------------------------------------------------------------------------

/** ids `positionVisible` says `v` may know exist, right now. */
function positionEntitledIds(s: GameState, v: Viewer): Set<PieceId> {
  const ids = new Set<PieceId>()
  for (const p of s.pieces) if (positionVisible(s, v, p)) ids.add(p.id)
  return ids
}

/**
 * The `stateForViewer` payload's own piece-id set must equal exactly the set
 * `positionVisible` computes — checked both directions, so a piece present
 * without entitlement AND a piece entitled but missing both fail.
 */
function positionSetViolations(s: GameState, v: Viewer, vs: ViewerState): string[] {
  const entitled = positionEntitledIds(s, v)
  const present = new Set(vs.pieces.map((p) => p.id))
  const bad: string[] = []
  for (const id of present) if (!entitled.has(id)) bad.push(`${id} present but not position-entitled`)
  for (const id of entitled) if (!present.has(id)) bad.push(`${id} position-entitled but missing`)
  return bad
}

/**
 * Rank disclosure, re-checked by id on top of the new position filter — a
 * regression guard that filtering pieces out did not also disturb which
 * SURVIVING pieces' ranks are shown, independent of the (index-based)
 * `redaction.property.ts` suites, which this shorter array would desync.
 */
function fogRankViolations(s: GameState, v: Viewer, vs: ViewerState): string[] {
  const bad: string[] = []
  for (const vp of vs.pieces) {
    const sp = s.pieces.find((p) => p.id === vp.id)
    if (!sp) { bad.push(`${vp.id}: no matching authoritative piece`); continue }
    const shouldSeeRank = entitledToRank(s, v, sp)
    if (shouldSeeRank && vp.rank === null) bad.push(`${vp.id}: entitled to rank but got null`)
    if (!shouldSeeRank && vp.rank !== null) bad.push(`${vp.id}: rank ${vp.rank} leaked, not entitled`)
  }
  return bad
}

/**
 * An alternate world differing ONLY in where currently-invisible enemy
 * pieces stand, permuted among each other's squares. This is the position
 * analogue of `redaction.property.ts`'s `permuteHiddenRanks`: since it is a
 * ROTATION among the same set of squares, the occupied-square SET (all that
 * ray-blocking vision cares about) is unchanged, so this cannot smuggle a
 * previously-hidden square into the viewer's own vision or move a piece onto
 * a scoring square — every rotated piece stays exactly as hidden as it was.
 * Captured pieces (`square === null`) are excluded — there is nowhere legal
 * to rotate them to.
 */
export function permuteHiddenPositions(s: GameState, v: Viewer): { state: GameState; changed: boolean } {
  const entitled = positionEntitledIds(s, v)
  const hidden = s.pieces
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !entitled.has(p.id) && p.square !== null)

  if (hidden.length < 2) return { state: s, changed: false }

  const squares = hidden.map(({ p }) => p.square!)
  const rotated = [...squares.slice(1), squares[0]!]
  const nextSquare = new Map<number, number>()
  hidden.forEach(({ i }, k) => nextSquare.set(i, rotated[k]!))

  let changed = false
  const pieces = s.pieces.map((p, i) => {
    const next = nextSquare.get(i)
    if (next === undefined || next === p.square) return { ...p }
    changed = true
    return { ...p, square: next }
  })
  return { state: { ...s, pieces }, changed }
}

// ===========================================================================
// Suites
// ===========================================================================

describe('迷霧遮蔽層 property — corpus', () => {
  it('covers setup-free playing and finished fog games with genuinely hidden pieces', () => {
    expect(CORPUS.length).toBeGreaterThan(80)
    const anyHidden = CORPUS.some(({ state }) =>
      state.pieces.some((p) => !positionVisible(state, { kind: 'player', color: 'white' }, p) && p.square !== null),
    )
    expect(anyHidden).toBe(true)
  })
})

describe('迷霧遮蔽層 property — A. the payload lists exactly the position-entitled ids', () => {
  for (const v of ALL_VIEWERS) {
    it(`stateForViewer(...).pieces matches positionVisible exactly — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const vs = stateForViewer(state, v)
        for (const problem of positionSetViolations(state, v, vs)) bad.push(`[${label}] ${problem}`)
      }
      expect(bad.slice(0, 12)).toEqual([])
    })
  }
})

describe('迷霧遮蔽層 property — B. rank disclosure survives the position filter', () => {
  for (const v of ALL_VIEWERS) {
    it(`surviving pieces still show ranks per entitledToRank, by id — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const vs = stateForViewer(state, v)
        for (const problem of fogRankViolations(state, v, vs)) bad.push(`[${label}] ${problem}`)
      }
      expect(bad.slice(0, 12)).toEqual([])
    })
  }
})

describe('迷霧遮蔽層 property — C. hidden positions are indistinguishable', () => {
  for (const v of ALL_VIEWERS) {
    it(`permuting invisible enemy squares leaves the payload byte-identical — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      let exercised = 0

      for (const { label, state } of CORPUS) {
        const { state: alt, changed } = permuteHiddenPositions(state, v)
        if (!changed) continue
        exercised++

        const a = JSON.stringify(stateForViewer(state, v))
        const b = JSON.stringify(stateForViewer(alt, v))
        if (a !== b) bad.push(`[${label}] ${viewerLabel(v)} view varies with a hidden piece's position`)
      }

      expect(bad.slice(0, 6)).toEqual([])
      // omniscient never has anything hidden to permute; every other viewer
      // must have been exercised on a real slice of the corpus.
      if (v.kind !== 'omniscient') expect(exercised).toBeGreaterThan(10)
    })
  }
})

describe('迷霧遮蔽層 property — D. fog off is a no-op on the position boundary', () => {
  it('a non-fog game discloses every on-board piece to every viewer\'s position filter', () => {
    // fogOfWar defaults false; positionVisible must be vacuously true for
    // every piece regardless of viewer, so createGame()'s ordinary corpus
    // (exercised at length by redaction.property.ts) is unaffected by this
    // whole feature existing.
    const s = startedFogGame('inert', {})
    const nonFog: GameState = { ...s, config: { ...s.config, fogOfWar: false } }
    for (const v of ALL_VIEWERS) {
      for (const p of nonFog.pieces) expect(positionVisible(nonFog, v, p)).toBe(true)
      expect(stateForViewer(nonFog, v).pieces).toHaveLength(nonFog.pieces.length)
    }
  })
})
