import { describe, expect, it } from 'vitest'
import {
  applyMove,
  carrierMoves,
  createGame,
  defaultAssignment,
  legalMoves,
  stateForViewer,
  submitAssignment,
} from '@xiyang/rules'
import type { Color, GameState, Move, Rank, ViewerState } from '@xiyang/rules'
import {
  makeLookaheadCache,
  needsReplyAnalysis,
  replyRisk,
  squareSafety,
  viewAfter,
  type BeliefLookup,
} from '../src/lookahead.js'

/**
 * Tests for `lookahead.ts`.
 *
 * Written after the fact: the agent that wrote the module died before writing
 * its tests, leaving 53KB of code the policy layer had already started building
 * on. These pin the claims the policy actually relies on.
 *
 * The module's whole reason for existing is that it does NOT re-implement how
 * pieces move — it constructs the position after a move and asks
 * `carrierMoves` / `reachableSquares` from the engine. The first test below is
 * therefore the important one: it checks the module agrees with the engine
 * rather than merely being self-consistent.
 */

const SQ = (name: string): number =>
  'abcdefgh'.indexOf(name[0]!) + (Number(name[1]) - 1) * 8

const nameOf = (sq: number): string => `${'abcdefgh'[sq % 8]}${Math.floor(sq / 8) + 1}`

const moveNamed = (s: GameState, color: Color, want: string): Move => {
  const found = legalMoves(s, color).find(
    (m) => m.kind === 'move' && `${nameOf(m.from)}${nameOf(m.to)}` === want,
  )
  if (!found) throw new Error(`no legal move ${want} for ${color}`)
  return found
}

function started(id: string): GameState {
  let s = createGame(id, { clockEnabled: false })
  s = submitAssignment(s, 'white', defaultAssignment('white', s))
  s = submitAssignment(s, 'black', defaultAssignment('black', s))
  return s
}

const viewFor = (s: GameState, color: Color): ViewerState =>
  stateForViewer(s, { kind: 'player', color })

/** A belief that is certain about one piece and flat about everything else. */
function beliefSaying(fixed: Record<string, Rank>): BeliefLookup {
  return (id) => {
    const rank = fixed[id]
    if (rank !== undefined) return { [rank]: 1 }
    return { engineer: 0.5, brigade: 0.5 }
  }
}

const FLAT: BeliefLookup = () => ({ engineer: 0.5, brigade: 0.5 })

// ---------------------------------------------------------------------------

describe('viewAfter — the position it reasons about is the engine\'s', () => {
  it('reproduces exactly what applyMove produces, for both sides\' move lists', () => {
    const bad: string[] = []
    let s = started('after')
    for (let i = 0; i < 18 && s.status.kind === 'playing'; i++) {
      const mover = s.toMove
      const ms = legalMoves(s, mover).filter((m) => m.kind !== 'pass')
      if (ms.length === 0) break
      const move = ms[i % ms.length]!

      const probe = viewAfter(viewFor(s, mover), mover, move)
      const truth = applyMove(s, move)
      if (probe === null) {
        bad.push(`ply ${s.ply}: viewAfter returned null for a legal move`)
      } else {
        // the thing the module actually uses it for: what the OPPONENT can do next
        const derived = carrierMoves(probe, truth.toMove).map((m) => JSON.stringify(m)).sort()
        const actual = legalMoves(truth, truth.toMove).map((m) => JSON.stringify(m)).sort()
        if (JSON.stringify(derived) !== JSON.stringify(actual)) {
          bad.push(`ply ${s.ply}: reply list disagrees with the engine`)
        }
      }
      s = truth
    }
    expect(bad.slice(0, 3)).toEqual([])
  })
})

describe('replyRisk — does the square survive their answer', () => {
  it('a square nothing can reach reports pHoldsAfterReply 1', () => {
    const s = started('safe')
    const move = moveNamed(s, 'white', 'd2d4')
    const risk = replyRisk(viewFor(s, 'white'), 'white', FLAT, move)
    expect(risk.analysed).toBe(true)
    expect(risk.attackers).toHaveLength(0)
    expect(risk.pHoldsAfterReply).toBe(1)
    expect(risk.worst).toBeNull()
  })

  it('a square a known-stronger enemy can retake reports a low hold', () => {
    // white pawn to d4, black pawn on e5 can answer exd4 — and the belief says
    // that pawn is a 司令, which beats anything.
    let s = started('retake')
    s = applyMove(s, moveNamed(s, 'white', 'e2e4'))
    s = applyMove(s, moveNamed(s, 'black', 'e7e5'))

    const attacker = s.pieces.find((p) => p.square === SQ('e5'))
    expect(attacker).toBeDefined()

    const move = moveNamed(s, 'white', 'd2d4')
    const belief = beliefSaying({ [attacker!.id]: 'commander' })
    const risk = replyRisk(viewFor(s, 'white'), 'white', belief, move)

    expect(risk.analysed).toBe(true)
    expect(risk.attackers.length).toBeGreaterThan(0)
    expect(risk.pHoldsAfterReply).toBeLessThan(0.5)
    expect(risk.worst).not.toBeNull()
    expect(risk.why.length).toBeGreaterThan(0)
  })

  it('the SAME square is safer when the belief says the attacker is weak', () => {
    let s = started('weak')
    s = applyMove(s, moveNamed(s, 'white', 'e2e4'))
    s = applyMove(s, moveNamed(s, 'black', 'e7e5'))
    const attacker = s.pieces.find((p) => p.square === SQ('e5'))!
    const move = moveNamed(s, 'white', 'd2d4')

    const strong = replyRisk(
      viewFor(s, 'white'), 'white', beliefSaying({ [attacker.id]: 'commander' }), move,
      { cache: makeLookaheadCache() },
    )
    const weak = replyRisk(
      viewFor(s, 'white'), 'white', beliefSaying({ [attacker.id]: 'flag' }), move,
      { cache: makeLookaheadCache() },
    )

    // identical geometry, opposite belief: the module must be reading the belief,
    // not just counting attackers. This is what stops it playing worst-case and
    // contesting nothing.
    expect(weak.pHoldsAfterReply).toBeGreaterThan(strong.pHoldsAfterReply)
  })

  it('is deterministic — the same inputs give the same answer', () => {
    const s = started('det')
    const move = moveNamed(s, 'white', 'd2d4')
    const a = replyRisk(viewFor(s, 'white'), 'white', FLAT, move, { cache: makeLookaheadCache() })
    const b = replyRisk(viewFor(s, 'white'), 'white', FLAT, move, { cache: makeLookaheadCache() })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('a pass is never reported as an exposed move', () => {
    const s = started('pass')
    const risk = replyRisk(viewFor(s, 'white'), 'white', FLAT, { kind: 'pass' })
    expect(risk.mover).toBeNull()
    expect(risk.square).toBeNull()
  })

  it('the gate skips moves that touch no 結算格, and says so', () => {
    const s = started('gate')
    const quiet = moveNamed(s, 'white', 'a2a3')
    expect(needsReplyAnalysis(viewFor(s, 'white'), 'white', quiet, {})).toBe(false)
    const risk = replyRisk(viewFor(s, 'white'), 'white', FLAT, quiet)
    // neutral numbers, but flagged as NOT ASKED rather than safe
    expect(risk.analysed).toBe(false)
    expect(risk.pHoldsAfterReply).toBe(1)
  })
})

describe('squareSafety — §15.1, can the 軍旗 stand here', () => {
  it('reports unreachable for a square nothing can touch', () => {
    const s = started('unreach')
    const safety = squareSafety(viewFor(s, 'white'), 'white', FLAT, SQ('d4'), 1)
    expect(safety.square).toBe(SQ('d4'))
    expect(safety.attackers).toHaveLength(0)
    expect(safety.pHolds1).toBe(1)
    expect(safety.unreachable).toBe(true)
  })

  it('reports reachable once an enemy pawn attacks it', () => {
    let s = started('reach')
    s = applyMove(s, moveNamed(s, 'white', 'd2d4'))
    s = applyMove(s, moveNamed(s, 'black', 'e7e5'))
    // black's e5 pawn attacks d4
    const safety = squareSafety(viewFor(s, 'white'), 'white', FLAT, SQ('d4'), 1)
    expect(safety.attackers.length).toBeGreaterThan(0)
    expect(safety.unreachable).toBe(false)
    expect(safety.pHolds1).toBeLessThan(1)
  })

  it('a two-ply horizon is never MORE optimistic than one ply', () => {
    let s = started('horizon')
    s = applyMove(s, moveNamed(s, 'white', 'd2d4'))
    s = applyMove(s, moveNamed(s, 'black', 'g8f6'))
    const one = squareSafety(viewFor(s, 'white'), 'white', FLAT, SQ('e4'), 1,
      { cache: makeLookaheadCache() })
    const two = squareSafety(viewFor(s, 'white'), 'white', FLAT, SQ('e4'), 2,
      { cache: makeLookaheadCache() })
    expect(two.pHolds).toBeLessThanOrEqual(one.pHolds)
    expect(two.plies).toBe(2)
  })

  it('knows when the occupant is our 軍旗 — the §7.5① stake', () => {
    const s = started('flag')
    const flag = s.pieces.find((p) => p.color === 'white' && p.rank === 'flag')!
    expect(flag.square).not.toBeNull()
    const safety = squareSafety(viewFor(s, 'white'), 'white', FLAT, flag.square!, 1)
    expect(safety.isFlag).toBe(true)
    expect(safety.occupant).toBe(flag.id)
  })

  it('answers for a hypothetical arrival on an empty square', () => {
    const s = started('hypo')
    const safety = squareSafety(viewFor(s, 'white'), 'white', FLAT, SQ('e4'), 1)
    expect(safety.hypothetical).toBe(true)
    expect(safety.occupant).toBeNull()
  })
})

describe('no hidden information reaches it', () => {
  it('a redacted view is all it ever gets, and enemy ranks are absent from it', () => {
    const s = started('leak')
    const view = viewFor(s, 'white')
    const enemyWithRank = view.pieces.filter((p) => p.color === 'black' && p.rank !== null)
    // nothing black is 翻明 at ply 1, so the input carries no enemy 兵種 at all
    expect(enemyWithRank).toHaveLength(0)

    // and the module's answers are unchanged when black's hidden ranks rotate
    const blacks = s.pieces.filter((p) => p.color === 'black')
    const rotated: GameState = {
      ...s,
      pieces: s.pieces.map((p) => {
        if (p.color !== 'black') return p
        const i = blacks.findIndex((b) => b.id === p.id)
        return { ...p, rank: blacks[(i + 1) % blacks.length]!.rank }
      }),
    }
    const move = moveNamed(s, 'white', 'd2d4')
    const before = replyRisk(view, 'white', FLAT, move, { cache: makeLookaheadCache() })
    const after = replyRisk(viewFor(rotated, 'white'), 'white', FLAT, move,
      { cache: makeLookaheadCache() })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })
})
