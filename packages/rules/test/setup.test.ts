/**
 * §9 起始配置 and §1 雙層身分.
 *
 *   「載體配置採西洋棋標準開局。」
 *   「指派為一對一，且必須恰好用完 §2 的數量表。」
 *   「任何兵種可搭載於任何載體。軍旗可放在 queen 上，爆裂物可放在 pawn 上，
 *     司令可放在 pawn 上。」
 */

import { describe, expect, it } from 'vitest'
import { DISTRIBUTION, RANK_ORDER } from '../src/constants.js'
import { squareName } from '../src/board.js'
import { createGame, defaultAssignment, submitAssignment, validateAssignment } from '../src/setup.js'
import type { Carrier, PieceId, Rank } from '../src/types.js'

/** A legal white assignment that deliberately violates every chess intuition. */
const WEIRD_WHITE: Record<PieceId, Rank> = {
  'w-d1': 'flag',        // 軍旗 on the queen
  'w-a2': 'bomb',        // 爆裂物 on a pawn
  'w-b2': 'commander',   // 司令 on a pawn
  'w-a1': 'general',
  'w-b1': 'division',
  'w-c1': 'brigade',
  'w-e1': 'brigade',
  'w-f1': 'regiment',
  'w-g1': 'regiment',
  'w-h1': 'battalion',
  'w-c2': 'battalion',
  'w-d2': 'company',
  'w-e2': 'platoon',
  'w-f2': 'engineer',
  'w-g2': 'engineer',
  'w-h2': 'bomb',
}

describe('§2 數量配置', () => {
  it('sums to 16', () => {
    expect(Object.values(DISTRIBUTION).reduce((a, b) => a + b, 0)).toBe(16)
  })

  it('orders 司令 highest and 軍旗 lowest, with 爆裂物 outside the ladder', () => {
    expect(RANK_ORDER.commander).toBe(1)
    expect(RANK_ORDER.flag).toBe(10)
    expect(Math.max(...Object.values(RANK_ORDER))).toBe(RANK_ORDER.flag)
    expect('bomb' in RANK_ORDER).toBe(false)
  })
})

describe('§9 the carrier layer is the standard chess opening', () => {
  const s = createGame('g')

  it('puts 32 pieces on the board in the standard arrangement', () => {
    expect(s.pieces).toHaveLength(32)
    const carrierAt = (name: string): Carrier | undefined =>
      s.pieces.find((p) => p.square !== null && squareName(p.square) === name)?.carrier
    expect(['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1'].map(carrierAt)).toEqual([
      'rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook',
    ])
    expect(['a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8'].map(carrierAt)).toEqual([
      'rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook',
    ])
    expect(s.pieces.filter((p) => p.carrier === 'pawn')).toHaveLength(16)
  })

  it('starts white to move, nothing revealed, nothing moved (§9 擲幣決定執白，白方先行)', () => {
    expect(s.toMove).toBe('white')
    expect(s.ply).toBe(1)
    expect(s.pieces.every((p) => !p.revealed && !p.hasMoved && p.square !== null)).toBe(true)
    expect(s.status).toEqual({ kind: 'setup', submitted: { white: false, black: false } })
  })
})

describe('§9 validateAssignment — 一對一 bijection onto DISTRIBUTION', () => {
  const s = createGame('g')

  it('accepts the deterministic default for both colours', () => {
    expect(validateAssignment(defaultAssignment('white', s), 'white', s)).toBeNull()
    expect(validateAssignment(defaultAssignment('black', s), 'black', s)).toBeNull()
  })

  it('mirrors the default across colours (both get the same home-square layout)', () => {
    expect(defaultAssignment('white', s)['w-a1']).toBe(defaultAssignment('black', s)['b-a8'])
    expect(defaultAssignment('white', s)['w-a2']).toBe(defaultAssignment('black', s)['b-a7'])
  })

  it('accepts 軍旗 on a queen, 爆裂物 on a pawn, 司令 on a pawn (§1 無耦合)', () => {
    expect(validateAssignment(WEIRD_WHITE, 'white', s)).toBeNull()
  })

  it('rejects a missing piece', () => {
    const bad = { ...WEIRD_WHITE }
    delete bad['w-h2']
    expect(validateAssignment(bad, 'white', s)).toMatch(/missing assignment/)
  })

  it('rejects an id belonging to the other colour', () => {
    const bad: Record<PieceId, Rank> = { ...WEIRD_WHITE, 'b-a8': 'flag' }
    expect(validateAssignment(bad, 'white', s)).toMatch(/unknown piece id/)
  })

  it('rejects a count that does not match DISTRIBUTION', () => {
    const bad: Record<PieceId, Rank> = { ...WEIRD_WHITE, 'w-h2': 'flag' } // two 軍旗
    expect(validateAssignment(bad, 'white', s)).toMatch(/rank flag/)
  })

  it('rejects an unknown rank', () => {
    const bad = { ...WEIRD_WHITE, 'w-h2': 'colonel' as Rank }
    expect(validateAssignment(bad, 'white', s)).not.toBeNull()
  })
})

describe('§9 submitAssignment — 同時且互不可見', () => {
  const s = createGame('g')

  it('stays in setup until both sides are in', () => {
    const one = submitAssignment(s, 'white', WEIRD_WHITE)
    expect(one.status).toEqual({ kind: 'setup', submitted: { white: true, black: false } })

    const two = submitAssignment(one, 'black', defaultAssignment('black', one))
    expect(two.status).toEqual({ kind: 'playing' })
  })

  it('writes the 兵種 layer onto the right pieces and leaves the other colour alone', () => {
    const one = submitAssignment(s, 'white', WEIRD_WHITE)
    expect(one.pieces.find((p) => p.id === 'w-d1')!.rank).toBe('flag')
    expect(one.pieces.find((p) => p.id === 'w-d1')!.carrier).toBe('queen')
    expect(one.pieces.find((p) => p.id === 'w-b2')!.rank).toBe('commander')
    expect(one.pieces.find((p) => p.id === 'w-b2')!.carrier).toBe('pawn')
    const blackBefore = s.pieces.filter((p) => p.color === 'black').map((p) => p.rank)
    const blackAfter = one.pieces.filter((p) => p.color === 'black').map((p) => p.rank)
    expect(blackAfter).toEqual(blackBefore)
  })

  it('refuses a second submission from the same colour', () => {
    const one = submitAssignment(s, 'white', WEIRD_WHITE)
    expect(() => submitAssignment(one, 'white', WEIRD_WHITE)).toThrow(/already submitted/)
  })

  it('refuses an invalid assignment', () => {
    const bad: Record<PieceId, Rank> = { ...WEIRD_WHITE, 'w-h2': 'flag' }
    expect(() => submitAssignment(s, 'white', bad)).toThrow(/invalid assignment/)
  })

  it('refuses any assignment once play has started', () => {
    let live = submitAssignment(s, 'white', WEIRD_WHITE)
    live = submitAssignment(live, 'black', defaultAssignment('black', live))
    expect(() => submitAssignment(live, 'white', WEIRD_WHITE)).toThrow(/only accepted during setup/)
  })
})
