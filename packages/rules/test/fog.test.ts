/**
 * 戰爭迷霧模式 — targeted attacks on the position-hiding boundary and the §4.2
 * clock-increment change. Gamebook is unchanged by this mode (fogofwar.md §3);
 * everything here is either `redact.ts`'s new `positionVisible` predicate or
 * `game.ts`'s one-line §8 gate.
 *
 * The randomised half lives in `fog-redaction.property.ts` and rides in via
 * the import below, same pattern as `redaction.test.ts` / `redaction.property.ts`.
 */

import './fog-redaction.property.js'

import { describe, expect, it } from 'vitest'
import { applyMove, positionVisible, stateForViewer } from '@xiyang/rules'
import type { GameState, Viewer } from '@xiyang/rules'
import { position } from './helpers.js'

const WHITE: Viewer = { kind: 'player', color: 'white' }
const BLACK: Viewer = { kind: 'player', color: 'black' }
const PUBLIC: Viewer = { kind: 'spectator-public' }
const OMNISCIENT: Viewer = { kind: 'omniscient' }

function idsOf(vs: ReturnType<typeof stateForViewer>): Set<string> {
  return new Set(vs.pieces.map((p) => p.id))
}

describe('戰爭迷霧模式 — position hiding, fogofwar.md §1', () => {
  it('fog off (the default): every piece is disclosed to every viewer, exactly as before', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'h8', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
    ])
    expect(s.config.fogOfWar).toBe(false)
    expect(idsOf(stateForViewer(s, WHITE))).toEqual(new Set(['WK', 'BN']))
  })

  it('an enemy piece outside vision is OMITTED from the payload, not merely rank-redacted', () => {
    const far = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
      ],
      { config: { fogOfWar: true } },
    )
    const vs = stateForViewer(far, WHITE)
    expect(idsOf(vs)).toEqual(new Set(['WK'])) // BN is nowhere in the payload at all
    expect(JSON.stringify(vs)).not.toContain('BN')
    expect(JSON.stringify(vs)).not.toContain('h8')
  })

  it('the same enemy piece reappears once it stands where a friendly piece can see it', () => {
    const near = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b2', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' }, // adjacent to a1
      ],
      { config: { fogOfWar: true } },
    )
    const vs = stateForViewer(near, WHITE)
    expect(idsOf(vs)).toEqual(new Set(['WK', 'BN']))
    // rank stays hidden — position visibility and rank entitlement are
    // independent axes, and this piece has never been 翻明.
    expect(vs.pieces.find((p) => p.id === 'BN')!.rank).toBeNull()
  })

  it('a piece standing on a scoring square is always visible, however far the viewer is (§1.3)', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'd4', color: 'black', carrier: 'queen', rank: 'general', id: 'BQ' }, // a default scoring square
      ],
      { config: { fogOfWar: true } },
    )
    expect(s.config.scoringSquares.includes(s.pieces.find((p) => p.id === 'BQ')!.square!)).toBe(true)
    expect(idsOf(stateForViewer(s, WHITE))).toContain('BQ')
  })

  it('a captured piece is always visible — every contact involves your own piece (§2.1)', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: null, color: 'black', carrier: 'knight', rank: 'general', id: 'BN' }, // off the board
      ],
      { config: { fogOfWar: true } },
    )
    expect(idsOf(stateForViewer(s, WHITE))).toContain('BN')
  })

  it("a viewer's own army is always fully disclosed, regardless of vision", () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        // 'd1', not 'h1': a rook on h1 would have a CLEAR file straight up to
        // h8 (nothing blocks it) and would legitimately see BK standing there
        // — correctly, per the ray rule, but not what this test is after. d1
        // shares neither file nor rank with h8, so neither of WK/WR's vision
        // reaches it.
        { at: 'd1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
      ],
      { config: { fogOfWar: true } },
    )
    // own pieces (WK, WR) are always present; BK is out of vision and correctly absent
    const vs = stateForViewer(s, WHITE)
    expect(idsOf(vs)).toContain('WK')
    expect(idsOf(vs)).toContain('WR')
    expect(idsOf(vs)).not.toContain('BK')
  })

  it('公開觀戰者 sees almost nothing under fog: no vision of its own (§4.3)', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
        { at: 'd4', color: 'black', carrier: 'queen', rank: 'general', id: 'BQ' }, // on a scoring square
      ],
      { config: { fogOfWar: true } },
    )
    const vs = stateForViewer(s, PUBLIC)
    // Neither king is visible to a viewer with no army of its own; the piece
    // standing on a scoring square is the one exception (§1.3).
    expect(idsOf(vs)).toEqual(new Set(['BQ']))
  })

  it('現場觀戰者 still sees EXACTLY what its bound player sees, fog included (§10)', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b2', color: 'black', carrier: 'knight', rank: 'general', id: 'BN1' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
      ],
      { config: { fogOfWar: true } },
    )
    const player = stateForViewer(s, WHITE)
    const spectator = stateForViewer(s, { kind: 'spectator', bound: 'white' })
    expect(JSON.stringify(spectator.pieces)).toBe(JSON.stringify(player.pieces))
  })

  it('the omniscient viewer is unaffected by fog', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
      ],
      { config: { fogOfWar: true } },
    )
    expect(idsOf(stateForViewer(s, OMNISCIENT))).toEqual(new Set(['WK', 'BK']))
  })

  it('終局公開全部兵種 also lifts the position fog — a finished game shows everyone', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
      ],
      { config: { fogOfWar: true }, status: { kind: 'over', result: { kind: 'resign', winner: 'white' } } },
    )
    expect(idsOf(stateForViewer(s, WHITE))).toEqual(new Set(['WK', 'BK']))
    expect(idsOf(stateForViewer(s, PUBLIC))).toEqual(new Set(['WK', 'BK']))
  })

  it('positionVisible itself is the predicate stateForViewer is built on — direct check', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
      ],
      { config: { fogOfWar: true } },
    )
    const far = s.pieces.find((p) => p.id === 'BN')!
    expect(positionVisible(s, WHITE, far)).toBe(false)
    expect(positionVisible(s, BLACK, far)).toBe(true) // own colour
    expect(positionVisible(s, OMNISCIENT, far)).toBe(true)
  })
})

describe('§8 增秒 under fog — fogofwar.md §4.2', () => {
  /** White's lone pawn has no legal piece move; black cannot reach it either. */
  function blockedPosition(fogOfWar: boolean): GameState {
    return position(
      [
        { at: 'a2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { config: { fogOfWar, clockEnabled: true } },
    )
  }

  it('a forced pass still grants the increment when fog is off (unchanged behaviour)', () => {
    const before = blockedPosition(false)
    const after = applyMove(before, { kind: 'pass' })
    expect(after.clockMs.white).toBe(before.clockMs.white + before.config.clockIncrementMs)
  })

  it('a forced pass grants NO increment under fog — the opponent cannot verify it (§4.2)', () => {
    const before = blockedPosition(true)
    const after = applyMove(before, { kind: 'pass' })
    expect(after.clockMs.white).toBe(before.clockMs.white)
  })

  it('a voluntary pass still grants nothing, fog or not (unchanged)', () => {
    const openBoard = position(
      [
        { at: 'e2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { config: { fogOfWar: true, clockEnabled: true } },
    )
    const after = applyMove(openBoard, { kind: 'pass' })
    expect(after.clockMs.white).toBe(openBoard.clockMs.white)
  })

  it('a completed move still grants the increment under fog (only the PASS rule changed)', () => {
    const s = position(
      [
        { at: 'e2', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { config: { fogOfWar: true, clockEnabled: true } },
    )
    const after = applyMove(s, { kind: 'move', from: s.pieces[0]!.square!, to: s.pieces[0]!.square! + 8 })
    expect(after.clockMs.white).toBe(s.clockMs.white + s.config.clockIncrementMs)
  })
})
