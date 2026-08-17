/**
 * What `informedDeployment` has to be true for.
 *
 * Deployment is half the game and the half that cannot be revised: §9 assigns
 * all 16 兵種 before the first ply, and nothing afterwards moves a 兵種 from one
 * 載體 to another. A deployment bug is therefore not a bug that shows up as a bad
 * move — it shows up as a scoring rate, and gets written down as a finding.
 *
 * Five claims are load-bearing, and every one of them is a claim the arena would
 * otherwise silently mis-measure:
 *
 *   1. it is always LEGAL, for every 附錄 B 數量表 — the 偵察兵 preset deals four
 *      工兵 and 高階雙份 moves the pairs up the ladder, so a bot that read the
 *      module constant instead of `view.config.distribution` would have every
 *      deployment refused and every game in that experiment would fail to start.
 *   2. the 軍旗 is never on the queen (notebook §2.1). A queen 軍旗 is bought with
 *      one 爆裂物, so a policy that deploys them is measuring 「what happens when
 *      you hand the opponent your 軍旗」, not 「what happens when you hide it」.
 *   3. no 爆裂物 on a rook (notebook §2.3). The one finding in the notebook that
 *      came from watching real games rather than from reasoning.
 *   4. it is RANDOM within those rules (§9 「固定值等同公開該方全軍」). A doctrine
 *      applied deterministically is a doctrine the opponent can read off a single
 *      previous game, which is worse than uniform random.
 *   5. it REPLAYS. Same seed, same army, byte for byte — otherwise a surprising
 *      game cannot be reopened, which is the whole reason this package exists.
 */

import { describe, expect, it } from 'vitest'
import {
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  SCORING_CENTRE_4,
  SCORING_WIDE_8,
  createGame,
  stateForViewer,
  startingSlot,
  validateAssignment,
} from '@xiyang/rules'
import type {
  Carrier,
  Color,
  GameConfig,
  GameState,
  PieceId,
  Rank,
  ViewerState,
} from '@xiyang/rules'

import { deriveSeed, makeRng } from '../src/prng.js'
import { pawnReachesScoring, randomAssignment, scoringSet } from '../src/policy.js'
import type { Policy } from '../src/policy.js'
import { greedyPolicy } from '../src/policies/greedy.js'
import { playGame } from '../src/index.js'
import {
  BOMB_WEIGHTS,
  COMMANDER_WEIGHTS,
  ENGINEER_WEIGHTS,
  FLAG_WEIGHTS,
  informedDeployment,
  makeInformedDeploy,
} from '../src/deploy.js'

// ---------------------------------------------------------------------------
// The sweep: every 數量表 preset × every 結算格 preset × both seats
// ---------------------------------------------------------------------------

const COLORS: readonly Color[] = ['white', 'black']
const SEEDS = 200

interface Setting {
  name: string
  config: Partial<GameConfig>
}

/**
 * Both 附錄 B axes that a deployment can possibly depend on.
 *
 * The 數量表 decides WHAT is being placed (偵察兵 deals four 工兵, 高階雙份 moves
 * the pairs up the ladder) and the 結算格 shape decides which pawns are about to
 * march (中央四格 puts two in play, 側翼八格 four). Both are read from
 * `view.config`, so both belong in the sweep — a hard-coded table would pass on
 * exactly one row of this list.
 */
const SETTINGS: readonly Setting[] = [
  { name: 'standard · centre4', config: {} },
  { name: 'standard · wide8', config: { scoringSquares: SCORING_WIDE_8 } },
  { name: 'scouts · centre4', config: { distribution: DISTRIBUTION_SCOUTS } },
  {
    name: 'scouts · wide8',
    config: { distribution: DISTRIBUTION_SCOUTS, scoringSquares: SCORING_WIDE_8 },
  },
  { name: 'top-heavy · centre4', config: { distribution: DISTRIBUTION_TOP_HEAVY } },
  {
    name: 'top-heavy · wide8',
    config: { distribution: DISTRIBUTION_TOP_HEAVY, scoringSquares: SCORING_WIDE_8 },
  },
]

/** One deployment, plus the public facts a test needs to judge it. */
interface Sample {
  setting: string
  color: Color
  seed: number
  assignment: Record<PieceId, Rank>
  /** id → 載體, from the harness's own state (public either way, §1) */
  carrier: ReadonlyMap<PieceId, Carrier>
  /** id → file index 0..7 */
  file: ReadonlyMap<PieceId, number>
  /** ids of own pawns that can step onto a 結算格 on ply 1 */
  marching: ReadonlySet<PieceId>
}

interface Fixture {
  setting: Setting
  state: GameState
  views: Record<Color, ViewerState>
  carrier: ReadonlyMap<PieceId, Carrier>
  file: ReadonlyMap<PieceId, number>
  marching: Record<Color, ReadonlySet<PieceId>>
}

function fixture(setting: Setting): Fixture {
  const state = createGame(`deploy-${setting.name}`, { clockEnabled: false, ...setting.config })
  const views = {
    white: stateForViewer(state, { kind: 'player', color: 'white' }),
    black: stateForViewer(state, { kind: 'player', color: 'black' }),
  }
  const carrier = new Map<PieceId, Carrier>(state.pieces.map((p) => [p.id, p.carrier]))
  const file = new Map<PieceId, number>(
    state.pieces.map((p) => [p.id, p.square === null ? -1 : p.square & 7]),
  )
  const scoring = scoringSet(views.white)
  const marching = {} as Record<Color, ReadonlySet<PieceId>>
  for (const color of COLORS) {
    marching[color] = new Set(
      views[color].pieces
        .filter((p) => p.color === color && pawnReachesScoring(p, scoring))
        .map((p) => p.id),
    )
  }
  return { setting, state, views, carrier, file, marching }
}

const FIXTURES: readonly Fixture[] = SETTINGS.map(fixture)

/** Every deployment in the sweep. Deterministic, so these are fixed data. */
const SAMPLES: readonly Sample[] = FIXTURES.flatMap((f) =>
  COLORS.flatMap((color) =>
    Array.from({ length: SEEDS }, (_unused, seed) => ({
      setting: f.setting.name,
      color,
      seed,
      assignment: informedDeployment(f.views[color], color, makeRng(seed)),
      carrier: f.carrier,
      file: f.file,
      marching: f.marching[color],
    })),
  ),
)

/** The piece ids carrying a given 兵種 in one deployment. */
function idsOf(sample: Sample, rank: Rank): PieceId[] {
  return Object.entries(sample.assignment)
    .filter(([, r]) => r === rank)
    .map(([id]) => id)
    .sort()
}

/** The 載體 carrying a given 兵種 in one deployment. */
function carriersOf(sample: Sample, rank: Rank): Carrier[] {
  return idsOf(sample, rank).map((id) => sample.carrier.get(id)!)
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return counts
}

function share(counts: ReadonlyMap<string, number>, key: string, total: number): number {
  return (counts.get(key) ?? 0) / total
}

/** Smallest file gap between any two hosts of one 兵種; Infinity when there are fewer than two. */
function minFileGap(sample: Sample, rank: Rank): number {
  const files = idsOf(sample, rank).map((id) => sample.file.get(id)!)
  let gap = Infinity
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      gap = Math.min(gap, Math.abs(files[i]! - files[j]!))
    }
  }
  return gap
}

it('the sweep covers what it claims to', () => {
  expect(SAMPLES).toHaveLength(SETTINGS.length * COLORS.length * SEEDS)
  // 附錄 B really is varying underneath: three tables, two board shapes.
  expect(FIXTURES[0]!.state.config.distribution).toEqual(DISTRIBUTION_STANDARD)
  expect(FIXTURES[2]!.state.config.distribution.engineer).toBe(4)
  expect(FIXTURES[4]!.state.config.distribution.general).toBe(2)
  expect(FIXTURES[0]!.state.config.scoringSquares).toEqual(SCORING_CENTRE_4)
  expect(FIXTURES[1]!.state.config.scoringSquares).toEqual(SCORING_WIDE_8)
  // and the 結算格 shape really does change which pawns are "about to march"
  expect(FIXTURES[0]!.marching.white.size).toBe(2)   // d2 e2
  expect(FIXTURES[1]!.marching.white.size).toBe(4)   // a2 d2 e2 h2
  expect(FIXTURES[1]!.marching.black.size).toBe(4)   // a7 d7 e7 h7
})

// ---------------------------------------------------------------------------
// 1. always legal, on every 附錄 B 數量表
// ---------------------------------------------------------------------------

describe('the engine accepts it', () => {
  it('passes validateAssignment for every preset, seat and seed', () => {
    for (const f of FIXTURES) {
      for (const color of COLORS) {
        for (let seed = 0; seed < SEEDS; seed++) {
          const a = informedDeployment(f.views[color], color, makeRng(seed))
          expect(
            validateAssignment(a, color, f.state),
            `${f.setting.name} ${color} seed ${seed}`,
          ).toBeNull()
        }
      }
    }
  })

  it('reads the 數量表 off the config rather than a constant', () => {
    // The 偵察兵 table is the one that catches a hard-coded DISTRIBUTION_STANDARD:
    // four 工兵 where the default has two, paid for out of 團長 and 營長.
    for (const sample of SAMPLES.filter((s) => s.setting.startsWith('scouts'))) {
      expect(idsOf(sample, 'engineer')).toHaveLength(4)
      expect(idsOf(sample, 'regiment')).toHaveLength(1)
    }
    for (const sample of SAMPLES.filter((s) => s.setting.startsWith('top-heavy'))) {
      expect(idsOf(sample, 'general')).toHaveLength(2)
      expect(idsOf(sample, 'division')).toHaveLength(2)
    }
    for (const sample of SAMPLES.filter((s) => s.setting.startsWith('standard'))) {
      expect(idsOf(sample, 'engineer')).toHaveLength(2)
    }
  })

  it('assigns every own piece exactly once and no enemy piece at all', () => {
    for (const f of FIXTURES) {
      for (const color of COLORS) {
        const own = f.state.pieces.filter((p) => p.color === color).map((p) => p.id).sort()
        const a = informedDeployment(f.views[color], color, makeRng(7))
        expect(Object.keys(a).sort()).toEqual(own)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. the 軍旗 bans (攻略 §9, notebook §2.1)
// ---------------------------------------------------------------------------

describe('軍旗 placement', () => {
  it('never puts the 軍旗 on the queen', () => {
    for (const sample of SAMPLES) {
      expect(
        carriersOf(sample, 'flag'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).not.toContain('queen')
    }
  })

  it('never puts the 軍旗 on a pawn that can step onto a 結算格 this ply', () => {
    // Dropping the 軍旗 on the pawn that was about to take a 結算格 costs that
    // square for the whole game — the flag must not move (§5.3, §7①), so the
    // square is simply never taken.
    for (const sample of SAMPLES) {
      for (const id of idsOf(sample, 'flag')) {
        expect(
          sample.marching.has(id),
          `${sample.setting} ${sample.color} seed ${sample.seed}: 軍旗 on ${id}`,
        ).toBe(false)
      }
    }
  })

  it('prefers a knight, and does not make it a certainty', () => {
    // notebook §2.2 wants the knight; §9 forbids ANY placement being predictable.
    // Both at once means "modal", not "always".
    for (const f of FIXTURES) {
      const rows = SAMPLES.filter((s) => s.setting === f.setting.name)
      const counts = tally(rows.flatMap((s) => carriersOf(s, 'flag')))
      const total = rows.length
      const knight = share(counts, 'knight', total)

      expect(counts.get('queen'), f.setting.name).toBeUndefined()
      expect(knight, f.setting.name).toBeGreaterThan(0.2)
      // Prefers is not "always". A deployment doctrine that always picks the same
      // carrier publishes the 軍旗 as surely as a fixed assignment does (§9).
      expect(knight, f.setting.name).toBeLessThan(0.6)
      for (const other of ['pawn', 'bishop', 'rook', 'king'] as const) {
        expect(knight, `${f.setting.name}: knight vs ${other}`)
          .toBeGreaterThan(share(counts, other, total))
      }
      // and every non-queen carrier is used at least sometimes
      expect([...counts.keys()].sort()).toEqual(['bishop', 'king', 'knight', 'pawn', 'rook'])
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 爆裂物 deliverability (攻略 §5, notebook §2.3)
// ---------------------------------------------------------------------------

describe('爆裂物 placement', () => {
  it('never puts a 爆裂物 on a rook', () => {
    for (const sample of SAMPLES) {
      expect(
        carriersOf(sample, 'bomb'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).not.toContain('rook')
    }
  })

  it('keeps them on the carriers that can actually deliver one', () => {
    // §2.3's table: pawn and knight are the two 高早期可送達性 rows. The bishop tail
    // exists so that "it is on a pawn or a knight" is not a free deduction.
    for (const f of FIXTURES) {
      const rows = SAMPLES.filter((s) => s.setting === f.setting.name)
      const carriers = rows.flatMap((s) => carriersOf(s, 'bomb'))
      const counts = tally(carriers)
      expect(counts.get('rook'), f.setting.name).toBeUndefined()
      expect(counts.get('queen'), f.setting.name).toBeUndefined()
      const deliverable = (counts.get('pawn') ?? 0) + (counts.get('knight') ?? 0)
      expect(deliverable / carriers.length, f.setting.name).toBeGreaterThan(0.9)
      // both of the good carriers get real use, not a token share
      expect(share(counts, 'knight', carriers.length), f.setting.name).toBeGreaterThan(0.05)
    }
  })

  it('never stacks the two 爆裂物 on one file', () => {
    // §2.3b: both playtest failures were a correct answer that could not travel.
    // Two 爆裂物 on the same file are one answer with a spare.
    for (const sample of SAMPLES) {
      expect(
        minFileGap(sample, 'bomb'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).toBeGreaterThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. 工兵 spread (攻略 §8, notebook §4.5)
// ---------------------------------------------------------------------------

describe('工兵 placement', () => {
  it('never puts two 工兵 on the same file', () => {
    // 「你有幾顆工兵，就等於你能安全猜幾次」 — a probe is worth the part of the board
    // it can reach, so two on one file are one probe with a spare.
    for (const sample of SAMPLES) {
      expect(
        minFileGap(sample, 'engineer'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).toBeGreaterThanOrEqual(1)
    }
  })

  it('spreads them further than a uniform deployment does', () => {
    // The control: `randomAssignment` on the same seeds and the same board. This
    // is the quantity notebook §9.5 says has never been measured — 「佈署為均勻
    // 隨機——真人不會」 — so the test is a comparison, not a threshold.
    for (const f of FIXTURES) {
      const gaps = (make: (color: Color, seed: number) => Record<PieceId, Rank>): number => {
        let total = 0
        let n = 0
        for (const color of COLORS) {
          for (let seed = 0; seed < SEEDS; seed++) {
            const sample: Sample = {
              setting: f.setting.name,
              color,
              seed,
              assignment: make(color, seed),
              carrier: f.carrier,
              file: f.file,
              marching: f.marching[color],
            }
            const gap = minFileGap(sample, 'engineer')
            if (gap !== Infinity) {
              total += gap
              n++
            }
          }
        }
        return total / Math.max(1, n)
      }

      const informed = gaps((color, seed) =>
        informedDeployment(f.views[color], color, makeRng(seed)))
      const uniform = gaps((color, seed) => randomAssignment(f.views[color], color, makeRng(seed)))
      expect(informed, `${f.setting.name}: informed ${informed} vs uniform ${uniform}`)
        .toBeGreaterThan(uniform)
    }
  })

  it('rides carriers that can walk a probe somewhere, and never the queen', () => {
    for (const f of FIXTURES) {
      const rows = SAMPLES.filter((s) => s.setting === f.setting.name)
      const carriers = rows.flatMap((s) => carriersOf(s, 'engineer'))
      const counts = tally(carriers)
      // §2.1: a 工兵 on a queen is the wasted placement that makes a queen 軍旗
      // readable. A side that would never make it must never make it.
      expect(counts.get('queen'), f.setting.name).toBeUndefined()
      expect(share(counts, 'pawn', carriers.length), f.setting.name).toBeGreaterThan(0.5)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. 司令 (攻略 §7, notebook §2.4)
// ---------------------------------------------------------------------------

describe('司令 placement', () => {
  it('leans towards the queen — the carrier that can execute the mirror trade', () => {
    // 「攜帶你司令的那顆載體，同時也是你對付對方司令的答案。」 A lean, not a habit:
    // it is the most stereotyped placement in the game, so the queen is the modal
    // carrier and still a minority.
    for (const f of FIXTURES) {
      const rows = SAMPLES.filter((s) => s.setting === f.setting.name)
      const carriers = rows.flatMap((s) => carriersOf(s, 'commander'))
      const counts = tally(carriers)
      const queen = share(counts, 'queen', carriers.length)
      // one queen against two rooks, two bishops, two knights and eight pawns
      expect(queen, f.setting.name).toBeGreaterThan(0.15)
      expect(queen, f.setting.name).toBeLessThan(0.5)
      for (const other of ['rook', 'bishop', 'knight', 'king', 'pawn'] as const) {
        expect(queen, `${f.setting.name}: queen vs ${other}`)
          .toBeGreaterThan(share(counts, other, carriers.length))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 6. random within the rules (§9), and reproducible (the arena's whole premise)
// ---------------------------------------------------------------------------

describe('randomness and determinism', () => {
  it('gives the same deployment for the same seed', () => {
    for (const f of FIXTURES) {
      for (const color of COLORS) {
        for (const seed of [0, 1, 42, 20260816]) {
          const a = informedDeployment(f.views[color], color, makeRng(seed))
          const b = informedDeployment(f.views[color], color, makeRng(seed))
          expect(b, `${f.setting.name} ${color} seed ${seed}`).toEqual(a)
        }
      }
    }
  })

  it('gives different deployments for two different seeds', () => {
    const view = FIXTURES[0]!.views.white
    const a = informedDeployment(view, 'white', makeRng(1))
    const b = informedDeployment(view, 'white', makeRng(2))
    expect(b).not.toEqual(a)
    // …and it is not merely the two chosen seeds. A doctrine that collapses onto
    // a handful of armies is a §9 violation with extra steps.
    const distinct = new Set(
      Array.from({ length: SEEDS }, (_unused, seed) =>
        JSON.stringify(informedDeployment(view, 'white', makeRng(seed)))),
    )
    expect(distinct.size).toBe(SEEDS)
  })

  it('gives the two seats different armies from one master seed', () => {
    // How the harness actually calls it: one derived stream per side (§6.6, one
    // variable at a time). The seats must not mirror each other.
    const f = FIXTURES[0]!
    const deployments = COLORS.map((color) =>
      informedDeployment(f.views[color], color, makeRng(deriveSeed(99, `deploy:${color}`))))
    const ranksByHome = deployments.map((a) =>
      Object.entries(a).map(([id, rank]) => `${id.slice(2)}=${rank}`).sort().join(','))
    expect(ranksByHome[0]).not.toBe(ranksByHome[1])
  })

  it('draws only from the Rng it was handed', () => {
    // Two streams at the same position produce the same army even though they
    // were built from different seeds — i.e. nothing is reading a clock, a
    // counter or Math.random behind the caller's back.
    const view = FIXTURES[0]!.views.white
    const one = makeRng(deriveSeed(5, 'a'))
    const two = makeRng(deriveSeed(5, 'a'))
    expect(informedDeployment(view, 'white', one)).toEqual(informedDeployment(view, 'white', two))
    expect(one.draws()).toBe(two.draws())
    expect(one.draws()).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 7. it looks at the public 載體層 of its OWN side and nothing else
// ---------------------------------------------------------------------------

describe('the lens', () => {
  it('does not depend on the order view.pieces arrives in', () => {
    // Candidate lists are sorted by piece id before any draw. Without that, the
    // same seed would deploy differently against a host that serialises the
    // payload in another order, and a saved seed would stop being a replay.
    const f = FIXTURES[0]!
    const shuffledView: ViewerState = {
      ...f.views.white,
      pieces: [...f.views.white.pieces].reverse(),
    }
    expect(informedDeployment(shuffledView, 'white', makeRng(3)))
      .toEqual(informedDeployment(f.views.white, 'white', makeRng(3)))
  })

  it('ignores the opponent half of the payload entirely', () => {
    const f = FIXTURES[0]!
    const tampered: ViewerState = {
      ...f.views.white,
      pieces: f.views.white.pieces.map((p) =>
        p.color === 'white' ? p : { ...p, carrier: 'queen' as Carrier, square: null }),
    }
    expect(informedDeployment(tampered, 'white', makeRng(3)))
      .toEqual(informedDeployment(f.views.white, 'white', makeRng(3)))
  })

  it('needs no 兵種 at all, which is all it is given during 佈署', () => {
    // §10.1 「佈署前不公開」: every rank in the setup payload is null, including
    // the caller's own. Blanking them explicitly proves nothing here reads one.
    const f = FIXTURES[0]!
    expect(f.views.white.pieces.every((p) => p.rank === null)).toBe(true)
    const blanked: ViewerState = {
      ...f.views.white,
      pieces: f.views.white.pieces.map((p) => ({ ...p, rank: null })),
    }
    expect(informedDeployment(blanked, 'white', makeRng(3)))
      .toEqual(informedDeployment(f.views.white, 'white', makeRng(3)))
  })
})

// ---------------------------------------------------------------------------
// 8. the doctrine tables and the A/B switch
// ---------------------------------------------------------------------------

describe('doctrine', () => {
  it('states its bans as zero weights, where a reader can see them', () => {
    expect(FLAG_WEIGHTS.queen).toBe(0)          // notebook §2.1
    expect(BOMB_WEIGHTS.rook).toBe(0)           // notebook §2.3
    expect(ENGINEER_WEIGHTS.queen).toBe(0)      // notebook §2.1, the other direction
    // and the preferences the bans exist to protect
    expect(FLAG_WEIGHTS.knight).toBeGreaterThan(FLAG_WEIGHTS.pawn)
    expect(BOMB_WEIGHTS.pawn).toBeGreaterThan(BOMB_WEIGHTS.bishop)
    expect(BOMB_WEIGHTS.knight).toBeGreaterThan(BOMB_WEIGHTS.bishop)
    expect(COMMANDER_WEIGHTS.queen).toBeGreaterThan(COMMANDER_WEIGHTS.pawn)
  })

  it('turns off one rule at a time, leaving the rest standing', () => {
    // notebook §6.6: 「兩局之間同時改變了三件事」. Measuring what the 軍旗 rule is
    // worth means changing the 軍旗 rule and nothing else.
    const f = FIXTURES[0]!
    const view = f.views.white
    const carrierOfFlag = (opts: Parameters<typeof informedDeployment>[3], seed: number): Carrier =>
      f.carrier.get(
        Object.entries(informedDeployment(view, 'white', makeRng(seed), opts))
          .find(([, r]) => r === 'flag')![0],
      )!
    const carriersOfBombs = (opts: Parameters<typeof informedDeployment>[3], seed: number): Carrier[] =>
      Object.entries(informedDeployment(view, 'white', makeRng(seed), opts))
        .filter(([, r]) => r === 'bomb')
        .map(([id]) => f.carrier.get(id)!)

    const seeds = Array.from({ length: SEEDS }, (_unused, i) => i)

    // flag doctrine off → the queen 軍旗 that §2.1 forbids does turn up
    const flagOff = { doctrine: { flag: false } } as const
    expect(seeds.some((s) => carrierOfFlag(flagOff, s) === 'queen')).toBe(true)
    expect(seeds.every((s) => !carriersOfBombs(flagOff, s).includes('rook'))).toBe(true)

    // bomb doctrine off → the rook 爆裂物 that §2.3 forbids does turn up
    const bombOff = { doctrine: { bomb: false } } as const
    expect(seeds.some((s) => carriersOfBombs(bombOff, s).includes('rook'))).toBe(true)
    expect(seeds.every((s) => carrierOfFlag(bombOff, s) !== 'queen')).toBe(true)

    // and every variant is still a legal deployment
    for (const opts of [flagOff, bombOff, { doctrine: { engineer: false, commander: false } }]) {
      for (const seed of seeds.slice(0, 40)) {
        expect(validateAssignment(informedDeployment(view, 'white', makeRng(seed), opts), 'white', f.state))
          .toBeNull()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 9. it drops into the harness as a Policy
// ---------------------------------------------------------------------------

describe('as a policy', () => {
  const informedGreedy: Policy = {
    name: 'informed-greedy',
    deploy: makeInformedDeploy(),
    move: greedyPolicy.move,
  }

  it('plays a whole game the harness accepts, and replays it', () => {
    const a = playGame({ seed: 20260816, white: informedGreedy, black: greedyPolicy })
    const b = playGame({ seed: 20260816, white: informedGreedy, black: greedyPolicy })
    expect(b.deployment).toEqual(a.deployment)
    expect(b.plyRecords).toEqual(a.plyRecords)
    expect(a.plies).toBeGreaterThan(0)
    expect(a.result).not.toBeNull()
  })

  it('holds its bans over full games on both boards and both seats', () => {
    // The carrier is read from `startingSlot`, i.e. the position 佈署 actually
    // happened in. Reading it off the final board would be wrong: 升變 changes the
    // 載體層 and not the 兵種層 (§1, §6), so a promoted pawn is a queen that was
    // never deployed as one.
    let checked = 0
    for (const config of [{}, { scoringSquares: SCORING_WIDE_8 }]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        for (const seat of COLORS) {
          const outcome = playGame({
            seed,
            white: seat === 'white' ? informedGreedy : greedyPolicy,
            black: seat === 'black' ? informedGreedy : greedyPolicy,
            config,
          })
          for (const [id, rank] of Object.entries(outcome.deployment[seat])) {
            const carrier = startingSlot(id)?.carrier
            expect(carrier, id).toBeDefined()
            if (rank === 'flag') expect(carrier, `${seed} ${seat} ${id}`).not.toBe('queen')
            if (rank === 'bomb') expect(carrier, `${seed} ${seat} ${id}`).not.toBe('rook')
            checked++
          }
        }
      }
    }
    expect(checked).toBe(2 * 5 * 2 * 16)
  })
})
