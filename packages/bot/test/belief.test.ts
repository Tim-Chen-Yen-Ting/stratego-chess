/**
 * The tests that make a belief admissible as evidence.
 *
 * A belief state is the one component of a bot that can be WRONG without ever
 * looking wrong. A policy that reads a hidden 兵種 gets caught by
 * `policy.test.ts`; a policy that quietly believes something the public record
 * does not support just plays a bit better than it should, and every number the
 * arena prints about it is then a number about a different game.
 *
 * So each block below pins one claim that would otherwise be untestable by
 * inspection:
 *
 *   1. what the log SAYS is believed exactly — a 翻明 rank is certainty, and a
 *      loser is confined to the set §1.2 derives, 軍旗 excluded because §7.5①
 *      would have ended the game.
 *   2. 有煙無傷 is read as the two-sided fact it is (§5.4): the survivor is
 *      工兵-or-軍旗 and the piece that lost was the 爆裂物.
 *   3. what the log does NOT say is not believed — a 同歸於盡 carries no 兵種
 *      (§4.3) and must not move anybody's odds except through the shared pool.
 *   4. every particle is a legal deployment, so every marginal is consistent
 *      with THIS game's 數量表 (附錄 B) rather than with the default one.
 *   5. the whole thing replays from a seed, which is what `prng.ts` exists for.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_RANKS,
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
  applyMove,
  createGame,
  parseSquare,
  stateForViewer,
  submitAssignment,
  validateAssignment,
} from '@xiyang/rules'
import type {
  Color,
  GameConfig,
  GameState,
  Move,
  PieceId,
  Rank,
  Square,
  ViewerState,
} from '@xiyang/rules'

import { makeRng } from '../src/prng.js'
import type { Rng } from '../src/prng.js'
import type { Policy } from '../src/policy.js'
import { contestPolicy } from '../src/policies/contest.js'
import { playGame } from '../src/index.js'
import {
  beliefFor,
  contactOdds,
  enemyFacts,
  pBomb,
  pFlag,
  pMutualAgainst,
  pWeakerThan,
  priorBelief,
  sampleEnemyDeployments,
} from '../src/belief.js'
import type { RankBelief } from '../src/belief.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sq(name: string): Square {
  const s = parseSquare(name)
  if (s === null) throw new Error(`not a square: ${name}`)
  return s
}

/**
 * A deployment with named pieces pinned and the rest filled deterministically.
 *
 * Keys are HOME SQUARES ('e2'), because that is what a piece id is made of and
 * because a test that says 「white's e-pawn is the 團長」 reads as the position it
 * sets up. The filler walks `ALL_RANKS` over the remaining ids in sorted order,
 * so a fixture is a pure function of what it pins.
 */
function deployment(
  state: GameState,
  color: Color,
  pinned: Readonly<Record<string, Rank>>,
): Record<PieceId, Rank> {
  const prefix = color === 'white' ? 'w-' : 'b-'
  const ids = state.pieces.filter((p) => p.color === color).map((p) => p.id).sort()
  const remaining = { ...state.config.distribution } as Record<Rank, number>
  const out: Record<PieceId, Rank> = {}

  for (const home of Object.keys(pinned).sort()) {
    const rank = pinned[home]!
    const id = prefix + home
    if (!ids.includes(id)) throw new Error(`fixture: no piece ${id}`)
    out[id] = rank
    remaining[rank] -= 1
    if (remaining[rank] < 0) throw new Error(`fixture: too many ${rank}`)
  }

  const pool: Rank[] = []
  for (const r of ALL_RANKS) for (let n = remaining[r]; n > 0; n--) pool.push(r)
  let i = 0
  for (const id of ids) if (!(id in out)) out[id] = pool[i++]!
  return out
}

interface Pinned {
  white?: Record<string, Rank>
  black?: Record<string, Rank>
}

function game(pinned: Pinned = {}, config?: Partial<GameConfig>): GameState {
  let s = createGame('belief-unit', { clockEnabled: false, ...config })
  s = submitAssignment(s, 'white', deployment(s, 'white', pinned.white ?? {}))
  s = submitAssignment(s, 'black', deployment(s, 'black', pinned.black ?? {}))
  return s
}

/** Drive plies by coordinate notation: 'e2e4', 'O-O', 'pass'. */
function play(state: GameState, ...moves: readonly string[]): GameState {
  let s = state
  for (const m of moves) {
    let move: Move
    if (m === 'pass') move = { kind: 'pass' }
    else if (m === 'O-O') move = { kind: 'castle', side: 'king' }
    else if (m === 'O-O-O') move = { kind: 'castle', side: 'queen' }
    else move = { kind: 'move', from: sq(m.slice(0, 2)), to: sq(m.slice(2, 4)) }
    s = applyMove(s, move)
  }
  return s
}

function viewOf(state: GameState, color: Color): ViewerState {
  return stateForViewer(state, { kind: 'player', color })
}

function belief(view: ViewerState, color: Color, seed: number, opts = {}): Map<PieceId, RankBelief> {
  return beliefFor(view, color, makeRng(seed), opts)
}

function rowOf(b: Map<PieceId, RankBelief>, id: PieceId): RankBelief {
  const row = b.get(id)
  if (!row) throw new Error(`no belief for ${id}`)
  return row
}

function support(row: RankBelief): Rank[] {
  return ALL_RANKS.filter((r) => row[r] > 0)
}

function sum(row: RankBelief): number {
  return ALL_RANKS.reduce((n, r) => n + row[r], 0)
}

/** A hand-written belief, for testing the readers without a sampler in the way. */
function mk(parts: Partial<Record<Rank, number>>): RankBelief {
  const out = {} as Record<Rank, number>
  for (const r of ALL_RANKS) out[r] = parts[r] ?? 0
  return out
}

const EXACT = 1e-9

// ---------------------------------------------------------------------------
// 1. What the log says
// ---------------------------------------------------------------------------

describe('翻明 is certainty (§4.3)', () => {
  // 1.e4 d5 2.exd5 — white's e-pawn is the 團長(5), black's d-pawn the 營長(6),
  // so the attacker wins and is 永久翻明.
  const state = play(
    game({ white: { e2: 'regiment', h1: 'flag' }, black: { d7: 'battalion', h8: 'flag' } }),
    'e2e4', 'd7d5', 'e4d5',
  )

  it('sets the announced rank to probability 1 and everything else to 0', () => {
    const row = rowOf(belief(viewOf(state, 'black'), 'black', 11), 'w-e2')
    expect(row.regiment).toBeCloseTo(1, 12)
    expect(support(row)).toEqual(['regiment'])
    expect(sum(row)).toBeCloseTo(1, 12)
  })

  it('says so in the candidate set too, not only in the sample', () => {
    const facts = enemyFacts(viewOf(state, 'black'), 'black')
    expect(facts.get('w-e2')?.disclosed).toBe('regiment')
    expect(facts.get('w-e2')?.allowed).toEqual(['regiment'])
  })

  it('leaves every other enemy piece uncertain — a reveal is about one piece', () => {
    const b = belief(viewOf(state, 'black'), 'black', 11)
    const others = [...b.keys()].filter((id) => id !== 'w-e2')
    expect(others).toHaveLength(15)
    for (const id of others) expect(support(rowOf(b, id)).length).toBeGreaterThan(1)
  })
})

describe('a piece we beat is confined to (R, 工兵], 軍旗 excluded (§1.2)', () => {
  const state = play(
    game({ white: { e2: 'regiment', h1: 'flag' }, black: { d7: 'battalion', h8: 'flag' } }),
    'e2e4', 'd7d5', 'e4d5',
  )
  const row = rowOf(belief(viewOf(state, 'white'), 'white', 12), 'b-d7')

  it('gives zero to 團長 and to everything above it', () => {
    for (const r of ['commander', 'general', 'division', 'brigade', 'regiment'] as Rank[]) {
      expect(row[r], r).toBe(0)
    }
  })

  it('gives zero to 軍旗 — taking it would have ended the game (§7.5①)', () => {
    expect(row.flag).toBe(0)
  })

  it('gives zero to 爆裂物 — a 爆裂物 never loses a rank duel (§4.3, §5.1)', () => {
    expect(row.bomb).toBe(0)
  })

  it('records BOTH 軍旗 exclusions, which overlap but are different rules', () => {
    // §1.2's exclusion (「若是軍旗，遊戲已於階段①結束」) and §1.3's general one
    // (「己方任何一顆棋子陣亡而遊戲繼續，該子必定不是軍旗」) reach the same verdict
    // here, because the loser of a decisive contact is always removed. They are
    // kept apart anyway: the second applies to 同歸於盡 too, where the first has
    // nothing to say, and a test that only saw the intersection would let either
    // one rot unnoticed.
    const reasons = enemyFacts(viewOf(state, 'white'), 'white').get('b-d7')?.reasons ?? []
    expect(reasons.some((r) => r.includes('翻明 regiment'))).toBe(true)
    expect(reasons.some((r) => r.includes('§7.5①'))).toBe(true)
    expect(reasons.some((r) => r.startsWith('contradiction'))).toBe(false)
  })

  it('spreads the whole mass over exactly the four 兵種 that are left', () => {
    expect(support(row)).toEqual(['battalion', 'company', 'platoon', 'engineer'])
    expect(sum(row)).toBeCloseTo(1, 12)
  })

  it('constrains the ATTACKER when the defender is the one that won (§4.1)', () => {
    // 1.e4 d5 2.a3 dxe4 — black walks its 旅長 into white's 司令 and loses. The
    // announcement names the DEFENDER's rank, so the piece to narrow is the
    // mover; narrowing the defender instead would be invisible (a 翻明 piece is
    // pinned by its disclosed rank anyway) and would leave the real loser
    // unconstrained.
    const state = play(
      game({ white: { e2: 'commander', h1: 'flag' }, black: { d7: 'brigade', h8: 'flag' } }),
      'e2e4', 'd7d5', 'a2a3', 'd5e4',
    )
    const view = viewOf(state, 'white')
    expect(view.log[3]?.combat?.outcome).toEqual({ kind: 'defender-wins', winnerRank: 'commander' })
    const facts = enemyFacts(view, 'white')
    expect(facts.get('b-d7')?.allowed).toEqual([
      'general', 'division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'engineer',
    ])
    const row = rowOf(belief(view, 'white', 14), 'b-d7')
    expect(row.commander).toBe(0)
    expect(row.flag).toBe(0)
    expect(row.bomb).toBe(0)
    expect(sum(row)).toBeCloseTo(1, 12)
    // the winner is 翻明 on its own square (§4.1: the loser never entered it)
    expect(rowOf(belief(viewOf(state, 'black'), 'black', 14), 'w-e2').commander).toBeCloseTo(1, 12)
  })

  it('reads the same set off an en passant, whose 接觸格 is not the 目的格 (§4.2)', () => {
    // 1.e4 a6 2.e5 d5 3.exd6 e.p. — the victim stands on d5, the attacker lands
    // on d6, and a replay that followed the destination square would lose the
    // piece entirely.
    const ep = play(
      game({ white: { e2: 'commander', h1: 'flag' }, black: { d7: 'platoon', h8: 'flag' } }),
      'e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6',
    )
    const view = viewOf(ep, 'white')
    const facts = enemyFacts(view, 'white')
    // everything below 司令(1) except 軍旗 and 爆裂物
    expect(facts.get('b-d7')?.allowed).toEqual([
      'general', 'division', 'brigade', 'regiment', 'battalion', 'company', 'platoon', 'engineer',
    ])
    const after = rowOf(belief(view, 'white', 13), 'b-d7')
    expect(after.commander).toBe(0)
    expect(after.flag).toBe(0)
    expect(after.bomb).toBe(0)
    expect(sum(after)).toBeCloseTo(1, 12)
    // and the winner ended up on d6, not on d5
    expect(view.pieces.find((p) => p.id === 'w-e2')?.square).toBe(sq('d6'))
  })
})

// ---------------------------------------------------------------------------
// 2. 有煙無傷 — the one event that still names a 爆裂物 (§4.3, §5.4)
// ---------------------------------------------------------------------------

describe('有煙無傷 (§5.4)', () => {
  // white's e-pawn is a 爆裂物, black's d-pawn a 工兵: the bomb alone is lost and
  // nobody is 翻明.
  const state = play(
    game({ white: { e2: 'bomb', h1: 'flag' }, black: { d7: 'engineer', h8: 'flag' } }),
    'e2e4', 'd7d5', 'e4d5',
  )

  it('confines the survivor to 工兵 or 軍旗, and to nothing else', () => {
    const row = rowOf(belief(viewOf(state, 'white'), 'white', 21), 'b-d7')
    expect(support(row)).toEqual(['engineer', 'flag'])
    expect(row.engineer + row.flag).toBeCloseTo(1, 12)
  })

  it('pins the piece that lost to 爆裂物 — the other half of the same event', () => {
    const row = rowOf(belief(viewOf(state, 'black'), 'black', 22), 'w-e2')
    expect(support(row)).toEqual(['bomb'])
    expect(row.bomb).toBeCloseTo(1, 12)
  })

  it('leaves the survivor standing, so the not-軍旗 rule does not apply to it', () => {
    const facts = enemyFacts(viewOf(state, 'white'), 'white')
    expect(facts.get('b-d7')?.square).toBe(sq('d5'))
    expect(facts.get('b-d7')?.allowed).toEqual(['engineer', 'flag'])
  })

  it('is the ambiguity 附錄 A(a) promises: neither branch is ruled out', () => {
    const row = rowOf(belief(viewOf(state, 'white'), 'white', 23, { behavioural: false }), 'b-d7')
    expect(row.engineer).toBeGreaterThan(0.1)
    expect(row.flag).toBeGreaterThan(0.1)
  })
})

// ---------------------------------------------------------------------------
// 3. What the log does NOT say
// ---------------------------------------------------------------------------

describe('同歸於盡 carries no 兵種 (§4.3)', () => {
  // The same three plies, twice: once ending in an equal-兵種 trade, once in a
  // quiet move. Both sides' 旅長 meet on d5.
  const traded = play(
    game({ white: { e2: 'brigade', h1: 'flag' }, black: { d7: 'brigade', h8: 'flag' } }),
    'e2e4', 'd7d5', 'e4d5',
  )
  const quiet = play(
    game({ white: { e2: 'brigade', h1: 'flag' }, black: { d7: 'brigade', h8: 'flag' } }),
    'e2e4', 'd7d5', 'a2a3',
  )

  const opts = { behavioural: false, samples: 6000 }
  const after = rowOf(belief(viewOf(traded, 'white'), 'white', 31, opts), 'b-e7')
  const before = rowOf(belief(viewOf(quiet, 'white'), 'white', 31, opts), 'b-e7')

  it('announces nothing, so the loser keeps every 兵種 except 軍旗', () => {
    const facts = enemyFacts(viewOf(traded, 'white'), 'white')
    expect(facts.get('b-d7')?.allowed).toEqual(ALL_RANKS.filter((r) => r !== 'flag'))
  })

  it('moves no surviving piece\'s odds except through the shared pool', () => {
    // The ONLY thing that may change for a bystander is its share of the 軍旗:
    // a piece that left the board while the game continued cannot be the 軍旗
    // (§7.5①, notebook §1.3), so that mass concentrates on the survivors. Nothing
    // else may move — conditioned on "not the 軍旗", the distribution is
    // identical before and after, which is what 「announces nothing」 means.
    for (const r of ALL_RANKS) {
      if (r === 'flag') continue
      const a = after[r] / (1 - after.flag)
      const b = before[r] / (1 - before.flag)
      expect(Math.abs(a - b), `${r}: ${a} vs ${b}`).toBeLessThan(0.02)
    }
  })

  it('does not single anybody out — every unconstrained piece stays exchangeable', () => {
    const b = belief(viewOf(traded, 'white'), 'white', 32, opts)
    const live = [...b.keys()].filter((id) => id !== 'b-d7')
    expect(live).toHaveLength(15)
    for (const id of live) {
      for (const r of ALL_RANKS) {
        expect(Math.abs(rowOf(b, id)[r] - after[r]), `${id} ${r}`).toBeLessThan(0.03)
      }
    }
  })

  it('still tightens the survivors through the pool, which is the whole effect', () => {
    // Two pieces are gone from the 軍旗 hunt, so each survivor's share of it
    // rises from 1/16 to 1/15. This is notebook §1.3 in a number.
    expect(before.flag).toBeCloseTo(1 / 16, 1)
    expect(after.flag).toBeGreaterThan(before.flag)
    expect(Math.abs(after.flag - 1 / 15)).toBeLessThan(0.02)
  })
})

// ---------------------------------------------------------------------------
// 4. Every particle is a legal deployment
// ---------------------------------------------------------------------------

describe('the sampler only ever draws legal armies (§9)', () => {
  const fixtures: [string, GameState][] = [
    ['opening', game()],
    ['after a reveal', play(
      game({ white: { e2: 'regiment', h1: 'flag' }, black: { d7: 'battalion', h8: 'flag' } }),
      'e2e4', 'd7d5', 'e4d5',
    )],
    ['after a 有煙無傷', play(
      game({ white: { e2: 'bomb', h1: 'flag' }, black: { d7: 'engineer', h8: 'flag' } }),
      'e2e4', 'd7d5', 'e4d5',
    )],
    ['under 偵察兵 on 側翼八格', play(
      game(
        { white: { e2: 'platoon', h1: 'flag' }, black: { d7: 'engineer', h8: 'flag' } },
        { distribution: DISTRIBUTION_SCOUTS, scoringSquares: SCORING_WIDE_8 },
      ),
      'e2e4', 'd7d5', 'e4d5',
    )],
  ]

  for (const [name, state] of fixtures) {
    it(`validates every particle — ${name}`, () => {
      const view = viewOf(state, 'white')
      const drawn = sampleEnemyDeployments(view, 'white', makeRng(41), { samples: 60 })
      expect(drawn.samples.length).toBe(60)
      // A legal game never leaves the first rung of the relaxation ladder.
      expect(drawn.relaxation).toBe('none')
      for (const { assignment } of drawn.samples) {
        const record: Record<PieceId, Rank> = {}
        for (const [id, rank] of assignment) record[id] = rank
        expect(validateAssignment(record, 'black', state), name).toBeNull()
      }
    })

    it(`sums each 兵種 across the enemy army to its configured count — ${name}`, () => {
      const view = viewOf(state, 'white')
      const b = belief(view, 'white', 42, { samples: 400 })
      expect(b.size).toBe(16)
      for (const r of ALL_RANKS) {
        let total = 0
        for (const row of b.values()) total += row[r]
        expect(total, `${name} ${r}`).toBeCloseTo(view.config.distribution[r], 9)
      }
      // and every row is a distribution
      for (const row of b.values()) expect(sum(row)).toBeCloseTo(1, 9)
    })
  }

  it('reads 附錄 B rather than the default table — 偵察兵 has four 工兵', () => {
    const state = game({}, { distribution: DISTRIBUTION_SCOUTS })
    const view = viewOf(state, 'white')
    const b = belief(view, 'white', 43, { behavioural: false, samples: 4000 })
    let engineers = 0
    for (const row of b.values()) engineers += row.engineer
    expect(engineers).toBeCloseTo(4, 9)
    expect(priorBelief(view).engineer).toBeCloseTo(4 / 16, 12)
  })
})

// ---------------------------------------------------------------------------
// 5. The public replay — squares back into pieces
// ---------------------------------------------------------------------------

describe('the log replay identifies pieces without reading a 兵種', () => {
  it('tracks 王車易位, which relocates two carriers in one move (§3②)', () => {
    const state = play(
      game({ white: { a1: 'flag' }, black: { h8: 'flag' } }),
      'e2e4', 'a7a6', 'g1f3', 'b7b6', 'f1c4', 'c7c6', 'O-O',
    )
    const facts = enemyFacts(viewOf(state, 'black'), 'black')
    expect(facts.get('w-e1')?.square).toBe(sq('g1'))
    expect(facts.get('w-h1')?.square).toBe(sq('f1'))
    // Both count as having moved. This asks 「did it sit still」 for the 軍旗
    // prior, not 「how many moves were made」 — a castled rook has not sat still.
    expect(facts.get('w-e1')?.movesMade).toBe(1)
    expect(facts.get('w-h1')?.movesMade).toBe(1)
    expect(facts.get('w-b1')?.movesMade).toBe(0)
  })

  it('records what a piece did, not what it is', () => {
    const state = play(game({ black: { h8: 'flag' } }), 'a2a3', 'd7d5', 'a3a4', 'd5d4')
    const facts = enemyFacts(viewOf(state, 'white'), 'white')
    const dPawn = facts.get('b-d7')!
    expect(dPawn.movesMade).toBe(2)
    expect(dPawn.lastMovedPly).toBe(4)
    expect(dPawn.maxAdvance).toBe(3)
    // d5 is a 中央四格 結算格; d4 is too, so it has held one all along.
    expect(dPawn.everOnScoringSquare).toBe(true)
    const quiet = facts.get('b-a8')!
    expect(quiet.movesMade).toBe(0)
    expect(quiet.lastMovedPly).toBeNull()
    expect(quiet.maxAdvance).toBe(0)
    expect(quiet.everOnScoringSquare).toBe(false)
    // the 載體 a 兵種 was CHOSEN on, which 升變 would otherwise overwrite (§1, §6)
    expect(facts.get('b-d8')?.deployedAs).toBe('queen')
    expect(dPawn.deployedAs).toBe('pawn')
  })
})

// ---------------------------------------------------------------------------
// 6. The behavioural prior — switchable, and therefore measurable
// ---------------------------------------------------------------------------

describe('the behavioural prior (notebook §2.1)', () => {
  const opening = game()
  const view = viewOf(opening, 'white')

  it('is exactly the flat 數量表 prior when switched off', () => {
    const b = belief(view, 'white', 51, { behavioural: false, samples: 5000 })
    const prior = priorBelief(view)
    for (const row of b.values()) {
      for (const r of ALL_RANKS) {
        expect(Math.abs(row[r] - prior[r]), r).toBeLessThan(0.02)
      }
    }
  })

  it('down-weights 軍旗 on a queen — 「queen 旗最脆弱，不是最強」 (§2.1, 攻略 §9)', () => {
    const on = belief(view, 'white', 52, { samples: 5000 })
    const off = belief(view, 'white', 52, { behavioural: false, samples: 5000 })
    const queen = pFlag(rowOf(on, 'b-d8'))
    const knight = pFlag(rowOf(on, 'b-b8'))
    expect(queen).toBeGreaterThan(0)
    expect(queen).toBeLessThan(knight * 0.6)
    // …and the same two pieces are indistinguishable with the prior switched off,
    // which is what makes the difference above attributable to the prior alone.
    expect(Math.abs(pFlag(rowOf(off, 'b-d8')) - pFlag(rowOf(off, 'b-b8')))).toBeLessThan(0.02)
  })

  it('down-weights 工兵 on a queen for the same reason (§2.1)', () => {
    const on = belief(view, 'white', 53, { samples: 5000 })
    expect(rowOf(on, 'b-d8').engineer).toBeLessThan(rowOf(on, 'b-b8').engineer * 0.7)
  })

  it('down-weights 軍旗 on a piece that has marched onto a 結算格', () => {
    // 1.a3 d5 — black's d-pawn is standing on d5, a 中央四格 結算格. Nobody parks
    // the one piece that cannot afford a fight on the square the opponent is
    // coming for (攻略 §4之二).
    const state = play(game(), 'a2a3', 'd7d5')
    const v = viewOf(state, 'white')
    const on = belief(v, 'white', 54, { samples: 5000 })
    const off = belief(v, 'white', 54, { behavioural: false, samples: 5000 })
    expect(pFlag(rowOf(on, 'b-d7'))).toBeLessThan(pFlag(rowOf(on, 'b-a8')))
    expect(Math.abs(pFlag(rowOf(off, 'b-d7')) - pFlag(rowOf(off, 'b-a8')))).toBeLessThan(0.02)
  })

  it('rewards a piece that has sat still, and more the longer it sits', () => {
    // Two positions with the same evidence and different amounts of elapsed
    // silence: a rook that has not moved after twenty turns is a better 軍旗
    // candidate than one that has not moved after one.
    const early = viewOf(play(game(), 'a2a3', 'a7a6'), 'white')
    const shuffles: string[] = []
    for (let i = 0; i < 10; i++) shuffles.push('b1c3', 'b8c6', 'c3b1', 'c6b8')
    const late = viewOf(play(game(), 'a2a3', 'a7a6', ...shuffles), 'white')
    const opts = { samples: 5000 }
    expect(pFlag(rowOf(belief(late, 'white', 55, opts), 'b-h8')))
      .toBeGreaterThan(pFlag(rowOf(belief(early, 'white', 55, opts), 'b-h8')))
  })

  it('never breaks the 數量表 — a weighted average of legal armies is still legal', () => {
    const b = belief(view, 'white', 56, { samples: 2000 })
    for (const r of ALL_RANKS) {
      let total = 0
      for (const row of b.values()) total += row[r]
      expect(total, r).toBeCloseTo(view.config.distribution[r], 9)
    }
  })

  it('survives a configuration that zeroes everything it touches', () => {
    const b = belief(view, 'white', 57, {
      samples: 200,
      weights: { flagOnQueen: 0, engineerOnQueen: 0, flagUnmovedMax: 0, flagOnScoringSquare: 0 },
    })
    for (const row of b.values()) {
      for (const r of ALL_RANKS) expect(Number.isFinite(row[r]), r).toBe(true)
      expect(sum(row)).toBeCloseTo(1, 9)
    }
  })

  it('cannot resurrect a 兵種 the log has ruled out', () => {
    // The prior is a weight on consistent particles, never a source of them: no
    // setting of it can put mass on a rank the public record excludes.
    const state = play(
      game({ white: { e2: 'bomb', h1: 'flag' }, black: { d7: 'engineer', h8: 'flag' } }),
      'e2e4', 'd7d5', 'e4d5',
    )
    const row = rowOf(belief(viewOf(state, 'white'), 'white', 58, {
      weights: { flagOnScoringSquare: 1000, flagUnmovedMax: 1000 },
    }), 'b-d7')
    expect(support(row)).toEqual(['engineer', 'flag'])
  })
})

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const state = play(
    game({ white: { e2: 'regiment', h1: 'flag' }, black: { d7: 'battalion', h8: 'flag' } }),
    'e2e4', 'd7d5', 'e4d5',
  )
  const view = viewOf(state, 'white')
  const dump = (b: Map<PieceId, RankBelief>): string =>
    JSON.stringify([...b.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1)))

  it('the same seed produces the same belief, byte for byte', () => {
    expect(dump(belief(view, 'white', 4242))).toBe(dump(belief(view, 'white', 4242)))
  })

  it('a different seed produces a different one — the rng is really threaded', () => {
    expect(dump(belief(view, 'white', 1))).not.toBe(dump(belief(view, 'white', 2)))
  })

  it('advances the caller\'s stream rather than owning one', () => {
    const rng: Rng = makeRng(7)
    const before = rng.draws()
    beliefFor(view, 'white', rng, { samples: 10 })
    expect(rng.draws()).toBeGreaterThan(before)
  })

  it('calls no ambient randomness — two streams at one seed agree', () => {
    const a = beliefFor(view, 'white', makeRng(9), { samples: 50 })
    const b = beliefFor(view, 'white', makeRng(9), { samples: 50 })
    expect(dump(a)).toBe(dump(b))
  })
})

// ---------------------------------------------------------------------------
// 8. Reading a belief
// ---------------------------------------------------------------------------

describe('the small questions a policy asks', () => {
  const b = mk({ commander: 0.1, regiment: 0.3, engineer: 0.2, flag: 0.1, bomb: 0.3 })

  it('pWeakerThan is the §1.2 ladder mass — 軍旗 in, 爆裂物 out', () => {
    expect(pWeakerThan(b, 'regiment')).toBeCloseTo(0.3, 12)   // 工兵 + 軍旗
    expect(pWeakerThan(b, 'commander')).toBeCloseTo(0.6, 12)  // everything but 司令/爆裂物
    expect(pWeakerThan(b, 'flag')).toBeCloseTo(0, 12)
    // 爆裂物 has no 階級 (§2), so nothing is weaker than it
    expect(pWeakerThan(b, 'bomb')).toBe(0)
  })

  it('pBomb and pFlag read the two 兵種 a policy plans around', () => {
    expect(pBomb(b)).toBeCloseTo(0.3, 12)
    expect(pFlag(b)).toBeCloseTo(0.1, 12)
  })

  it('contactOdds resolves through the engine, so §5.4 comes out right', () => {
    const asRegiment = contactOdds(b, 'regiment')
    expect(asRegiment.win).toBeCloseTo(0.3, 12)     // 工兵 + 軍旗
    expect(asRegiment.mutual).toBeCloseTo(0.6, 12)  // the other 團長 + 爆裂物
    expect(asRegiment.lose).toBeCloseTo(0.1, 12)    // 司令

    // 工兵 BEATS a 爆裂物 (§5.4), which is exactly where a re-implemented combat
    // table would disagree with the engine.
    const asEngineer = contactOdds(b, 'engineer')
    expect(asEngineer.win).toBeCloseTo(0.4, 12)     // 軍旗 + 爆裂物
    expect(asEngineer.mutual).toBeCloseTo(0.2, 12)  // the other 工兵
    expect(asEngineer.lose).toBeCloseTo(0.4, 12)    // 司令 + 團長

    // a 爆裂物 wins nothing at all
    const asBomb = contactOdds(b, 'bomb')
    expect(asBomb.win).toBe(0)
    expect(asBomb.mutual).toBeCloseTo(0.7, 12)
    expect(asBomb.lose).toBeCloseTo(0.3, 12)        // 工兵 + 軍旗
  })

  it('always partitions the probability', () => {
    for (const r of ALL_RANKS) {
      const odds = contactOdds(b, r)
      expect(odds.win + odds.mutual + odds.lose).toBeCloseTo(1, 12)
      expect(pMutualAgainst(b, r)).toBeCloseTo(odds.mutual, 12)
    }
  })

  it('reads a real belief without arithmetic drift', () => {
    const state = play(
      game({ white: { e2: 'regiment', h1: 'flag' }, black: { d7: 'battalion', h8: 'flag' } }),
      'e2e4', 'd7d5', 'e4d5',
    )
    const row = rowOf(belief(viewOf(state, 'white'), 'white', 61), 'b-d7')
    // We beat it with the 團長, so a second 團長 attack cannot lose and cannot tie.
    const odds = contactOdds(row, 'regiment')
    expect(odds.lose).toBe(0)
    expect(odds.mutual).toBe(0)
    expect(odds.win).toBeCloseTo(1, 9)
    expect(pWeakerThan(row, 'regiment')).toBeCloseTo(1, 9)
    expect(pBomb(row)).toBe(0)
    expect(pFlag(row)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 9. The boundary
// ---------------------------------------------------------------------------

describe('a belief is built from public information alone', () => {
  it('is identical for a player and for the 公開觀戰者, minus that side\'s own army', () => {
    // §10.1 makes 公開觀戰者 the strictest viewer in the system: it holds nobody's
    // private 兵種. If a belief about black differs between white's view and the
    // public one, white's view leaked something into it.
    const state = play(
      game({ white: { e2: 'regiment', h1: 'flag' }, black: { d7: 'battalion', h8: 'flag' } }),
      'e2e4', 'd7d5', 'e4d5',
    )
    const player = beliefFor(viewOf(state, 'white'), 'white', makeRng(71), { samples: 300 })
    const publicView = stateForViewer(state, { kind: 'spectator-public' })
    const spectator = beliefFor(publicView, 'white', makeRng(71), { samples: 300 })
    const dump = (b: Map<PieceId, RankBelief>): string =>
      JSON.stringify([...b.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1)))
    expect(dump(spectator)).toBe(dump(player))
  })

  it('holds no opinion before anyone has deployed (§9, §10.1)', () => {
    const fresh = createGame('belief-setup', { clockEnabled: false })
    const view = stateForViewer(fresh, { kind: 'player', color: 'white' })
    expect(view.status.kind).toBe('setup')
    const b = beliefFor(view, 'white', makeRng(72), { behavioural: false, samples: 3000 })
    const prior = priorBelief(view)
    for (const row of b.values()) {
      for (const r of ALL_RANKS) expect(Math.abs(row[r] - prior[r]), r).toBeLessThan(0.02)
    }
  })

  it('is exact at 終局, where §10.5 opens every 兵種', () => {
    // Resign rather than play it out: the point is the status, not the ending.
    const state = play(game({ black: { h8: 'flag' } }), 'e2e4', 'd7d5')
    const over = { ...state, status: { kind: 'over', result: { kind: 'resign', winner: 'white' } } } as GameState
    const b = beliefFor(viewOf(over, 'white'), 'white', makeRng(73), { samples: 20 })
    for (const [id, row] of b) {
      const truth = over.pieces.find((p) => p.id === id)!.rank
      expect(row[truth], id).toBeCloseTo(1, 12)
      expect(support(row), id).toEqual([truth])
    }
  })

  it('never excludes the truth, over real self-play', () => {
    // THE test. Every other one checks that a stated rule was implemented; this
    // one checks that the rules are true. A belief is wrong in the way that
    // matters when it rules out something that was actually the case, so: play
    // real games between a policy that fights (`contest` — notebook §9.3 clocks
    // it at ~0.3 contacts per ply), snapshot the redacted view at every ply, and
    // afterwards check each enemy piece's candidate set against the deployment
    // the harness recorded. A single over-tight inference shows up immediately.
    const captured: { ply: number; view: ViewerState; color: Color }[] = []
    const spy = (inner: Policy): Policy => ({
      name: inner.name,
      deploy: inner.deploy,
      move(view, color, rng) {
        captured.push({ ply: view.ply, view, color })
        return inner.move(view, color, rng)
      },
    })

    const wrong: string[] = []
    const illegal: string[] = []
    const relaxed: string[] = []
    let checks = 0
    let contacts = 0

    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      captured.length = 0
      const outcome = playGame({ seed, white: spy(contestPolicy), black: spy(contestPolicy) })
      contacts += outcome.stats.contacts

      for (const { ply, view, color } of captured) {
        const truth = outcome.deployment[color === 'white' ? 'black' : 'white']
        const facts = enemyFacts(view, color)
        for (const [id, f] of facts) {
          checks++
          const real = truth[id]
          if (real !== undefined && !f.allowed.includes(real)) {
            wrong.push(`seed ${seed} ply ${ply} ${id}:真 ${real} not in [${f.allowed.join(',')}]`)
          }
        }

        // The sampler, on a sixth of the plies — enough coverage for a dead-end
        // to surface, cheap enough to leave in the suite.
        if (ply % 6 !== 1) continue
        const drawn = sampleEnemyDeployments(view, color, makeRng(ply * 31 + seed), { samples: 20 })
        if (drawn.relaxation !== 'none') relaxed.push(`seed ${seed} ply ${ply}: ${drawn.relaxation}`)
        for (const { assignment } of drawn.samples) {
          const counts = {} as Record<Rank, number>
          for (const r of ALL_RANKS) counts[r] = 0
          for (const rank of assignment.values()) counts[rank] += 1
          for (const r of ALL_RANKS) {
            if (counts[r] !== view.config.distribution[r]) {
              illegal.push(`seed ${seed} ply ${ply}: ${r} ${counts[r]}≠${view.config.distribution[r]}`)
            }
          }
        }
      }
    }

    expect(wrong.slice(0, 5)).toEqual([])
    expect(illegal.slice(0, 5)).toEqual([])
    expect(relaxed.slice(0, 5)).toEqual([])
    // The assertions above are worthless if nothing happened; these say it did.
    expect(contacts).toBeGreaterThan(10)
    expect(checks).toBeGreaterThan(2000)
  })

  it('never produces a negative or non-finite probability', () => {
    const state = play(
      game({ white: { e2: 'bomb', h1: 'flag' }, black: { d7: 'engineer', h8: 'flag' } }),
      'e2e4', 'd7d5', 'e4d5',
    )
    for (const seed of [1, 2, 3, 4, 5]) {
      const b = belief(viewOf(state, 'white'), 'white', seed, { samples: 120 })
      for (const row of b.values()) {
        for (const r of ALL_RANKS) {
          expect(Number.isFinite(row[r])).toBe(true)
          expect(row[r]).toBeGreaterThanOrEqual(-EXACT)
        }
      }
    }
  })
})
