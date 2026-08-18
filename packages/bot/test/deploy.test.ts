/**
 * What `informedDeployment` has to be true for.
 *
 * 佈署 is half the game and the half that cannot be revised: §9 assigns all 16
 * 兵種 before the first ply, and nothing afterwards moves a 兵種 from one 載體 to
 * another. A deployment bug is therefore not a bug that shows up as a bad move —
 * it shows up as a scoring rate, and gets written down as a finding.
 *
 * The module is CONSTRAINED RANDOMISATION, so the claims come in two kinds and
 * both have to hold at once:
 *
 *   CONSTRAINTS — the bans and the systems, asserted on every single sample:
 *     1. always LEGAL, for every 附錄 B 數量表 (the 偵察兵 preset deals four 工兵 and
 *        高階雙份 moves the pairs up the ladder; a bot reading the module constant
 *        instead of `view.config.distribution` would have every deployment
 *        refused and every game in that experiment would fail to start);
 *     2. 軍旗 never on the queen (notebook §2.1) — a queen 軍旗 is bought with one
 *        爆裂物, so a policy that deploys them measures 「what happens when you
 *        hand the opponent your 軍旗」;
 *     3. 爆裂物 never on a rook (notebook §2.3) — the finding that came from
 *        watching real games rather than from reasoning;
 *     4. 旅長 on d/e and 工兵 on c/f whenever the table leaves them free
 *        (notebook §2.3c — a system, not a preference).
 *
 *   RANDOMISATION — the other half, and the reason a doctrine is stated as sets
 *   rather than as an order:
 *     5. it REPLAYS (same seed, same army, byte for byte) and yet two seeds give
 *        two armies. A fixed deployment publishes the army (§9 「固定值等同公開該方
 *        全軍」) and notebook §1.3 says the 軍旗 is found by ELIMINATION, so a
 *        deterministic placement hands over the answer before ply 1.
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
import { pawnReachesScoring, scoringSet } from '../src/policy.js'
import type { Policy } from '../src/policy.js'
import { greedyPolicy } from '../src/policies/greedy.js'
import { playGame } from '../src/index.js'
import {
  DEFAULT_DOCTRINE,
  allowedCarriers,
  informedDeployment,
  makeInformedDeploy,
  slotFor,
} from '../src/deploy.js'
import type { DeploymentOptions, DoctrineSlot } from '../src/deploy.js'

// ---------------------------------------------------------------------------
// The sweep: every 數量表 preset × every 結算格 preset × both seats
// ---------------------------------------------------------------------------

const COLORS: readonly Color[] = ['white', 'black']

/**
 * Seeds per (setting, seat). Half the claims below are DISTRIBUTIONAL — 「prefers
 * a knight」 is a statement about a share, not about any one deployment — and a
 * share estimated from too few draws is a coin toss dressed as an assertion.
 *
 * At 400 seeds × 2 seats a share near ½ carries a standard error of ~1.8 points,
 * so the 軍旗's designed 8-point lead over the quiet pawn sits about 4σ clear of
 * a tie. At 200 it sat inside 2σ and the suite failed on the arithmetic of small
 * numbers rather than on anything about the doctrine. The whole sweep is 4800
 * deployments and still runs in about a second.
 */
const SEEDS = 400
const FILES = 'abcdefgh'

interface Setting {
  name: string
  config: Partial<GameConfig>
}

/**
 * Both 附錄 B axes a deployment can possibly depend on.
 *
 * The 數量表 decides WHAT is being placed (偵察兵 deals four 工兵, which is the only
 * table that reaches the 工兵 b/g reserve set; 高階雙份 asks for four 軍長/師長
 * against two bishops, which is the only table that forces the fallback) and the
 * 結算格 shape decides which pawns are about to march, i.e. which pawns are 「quiet」
 * enough to carry the 軍旗. Both are read from `view.config`, so both belong in
 * the sweep — a hard-coded table would pass on exactly one row of this list.
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
  /** id → file letter a..h */
  file: ReadonlyMap<PieceId, string>
  /** ids of own pawns that can step onto a 結算格 on ply 1 */
  marching: ReadonlySet<PieceId>
}

interface Fixture {
  setting: Setting
  state: GameState
  views: Record<Color, ViewerState>
  carrier: ReadonlyMap<PieceId, Carrier>
  file: ReadonlyMap<PieceId, string>
  marching: Record<Color, ReadonlySet<PieceId>>
}

function fixture(setting: Setting): Fixture {
  const state = createGame(`deploy-${setting.name}`, { clockEnabled: false, ...setting.config })
  const views = {
    white: stateForViewer(state, { kind: 'player', color: 'white' }),
    black: stateForViewer(state, { kind: 'player', color: 'black' }),
  }
  const carrier = new Map<PieceId, Carrier>(state.pieces.map((p) => [p.id, p.carrier]))
  const file = new Map<PieceId, string>(
    state.pieces.map((p) => [p.id, p.square === null ? '?' : FILES[p.square & 7]!]),
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

function sampleOf(f: Fixture, color: Color, seed: number, opts?: DeploymentOptions): Sample {
  return {
    setting: f.setting.name,
    color,
    seed,
    assignment: informedDeployment(f.views[color], color, makeRng(seed), opts),
    carrier: f.carrier,
    file: f.file,
    marching: f.marching[color],
  }
}

/** Every deployment in the sweep. Deterministic, so these are fixed data. */
const SAMPLES: readonly Sample[] = FIXTURES.flatMap((f) =>
  COLORS.flatMap((color) => Array.from({ length: SEEDS }, (_unused, seed) => sampleOf(f, color, seed))),
)

function rowsFor(f: Fixture): readonly Sample[] {
  return SAMPLES.filter((s) => s.setting === f.setting.name)
}

/** The piece ids carrying a given 兵種 in one deployment. */
function idsOf(sample: Sample, ...ranks: readonly Rank[]): PieceId[] {
  return Object.entries(sample.assignment)
    .filter(([, r]) => ranks.includes(r))
    .map(([id]) => id)
    .sort()
}

/** The 載體 carrying a given 兵種 in one deployment. */
function carriersOf(sample: Sample, ...ranks: readonly Rank[]): Carrier[] {
  return idsOf(sample, ...ranks).map((id) => sample.carrier.get(id)!)
}

/** The files a given 兵種 stands on, sorted — 'cf' reads as a system at a glance. */
function filesOf(sample: Sample, ...ranks: readonly Rank[]): string {
  return idsOf(sample, ...ranks)
    .map((id) => sample.file.get(id)!)
    .sort()
    .join('')
}

/** Hosts of `ranks` that are pawns standing on one of `files`. */
function onFiles(sample: Sample, files: string, ...ranks: readonly Rank[]): number {
  return idsOf(sample, ...ranks).filter(
    (id) => sample.carrier.get(id) === 'pawn' && files.includes(sample.file.get(id)!),
  ).length
}

function countOn(sample: Sample, carrier: Carrier, ...ranks: readonly Rank[]): number {
  return carriersOf(sample, ...ranks).filter((c) => c === carrier).length
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return counts
}

function share(counts: ReadonlyMap<string, number>, key: string, total: number): number {
  return (counts.get(key) ?? 0) / total
}

/** Carrier distribution of one 兵種 over a whole fixture, as shares. */
function carrierShares(f: Fixture, ...ranks: readonly Rank[]): {
  counts: ReadonlyMap<string, number>
  total: number
  shareOf: (carrier: Carrier) => number
} {
  const carriers = rowsFor(f).flatMap((s) => carriersOf(s, ...ranks))
  const counts = tally(carriers)
  return {
    counts,
    total: carriers.length,
    shareOf: (carrier: Carrier) => share(counts, carrier, carriers.length),
  }
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
// 2. 軍旗 (notebook §1.3, §2.1, §2.2, §2.3c)
// ---------------------------------------------------------------------------

describe('軍旗 placement', () => {
  it('never puts the 軍旗 on the queen', () => {
    // §2.1: 工兵 on a queen is a waste nobody commits, so a 有煙無傷 on a queen
    // names the 軍旗 almost outright — the opponent buys it for one 爆裂物.
    for (const sample of SAMPLES) {
      expect(
        carriersOf(sample, 'flag'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).not.toContain('queen')
    }
  })

  it('rides only the three carriers the doctrine allows', () => {
    for (const sample of SAMPLES) {
      for (const carrier of carriersOf(sample, 'flag')) {
        expect(
          ['knight', 'pawn', 'rook'],
          `${sample.setting} ${sample.color} seed ${sample.seed}: 軍旗 on ${carrier}`,
        ).toContain(carrier)
      }
    }
  })

  it('never puts the 軍旗 on a pawn this deployment is sending at a 結算格', () => {
    // A 軍旗 that moves into anything loses the game outright (§7.5①), so the pawn
    // it rides must be one with no job: parking it on the pawn that was about to
    // take a 結算格 forfeits that square for the whole game.
    for (const sample of SAMPLES) {
      for (const id of idsOf(sample, 'flag')) {
        expect(
          sample.marching.has(id),
          `${sample.setting} ${sample.color} seed ${sample.seed}: 軍旗 on ${id}`,
        ).toBe(false)
      }
    }
  })

  it('prefers a knight without ever making it a certainty', () => {
    // §2.2/§2.3c want the knight; §9 forbids ANY placement being predictable.
    // Both at once means "modal", not "always".
    for (const f of FIXTURES) {
      const { shareOf, counts } = carrierShares(f, 'flag')
      expect(counts.get('queen'), f.setting.name).toBeUndefined()
      expect(shareOf('knight'), f.setting.name).toBeGreaterThan(0.35)
      expect(shareOf('knight'), f.setting.name).toBeLessThan(0.9)
      for (const other of ['pawn', 'rook'] as const) {
        expect(shareOf('knight'), `${f.setting.name}: knight vs ${other}`)
          .toBeGreaterThan(shareOf(other))
      }
      // every allowed carrier is genuinely in use, not a rounding error
      expect(shareOf('rook'), f.setting.name).toBeGreaterThan(0.02)
    }
  })

  it('keeps that preference after 爆裂物 has taken its knights', () => {
    // The preference above is a claim about the OUTPUT, and the 軍旗 does not draw
    // into an empty board: 爆裂物 resolves first and wants knights too (share 3 of
    // 11, twice over), so it takes BOTH of them often enough to matter — and in
    // those deployments the 軍旗's preferred set does not exist at all.
    //
    // This is the assertion that catches a doctrine tuned in isolation. At the
    // shares this file first carried (6:4:1 was 5:4:1) the erosion below was
    // enough to put the quiet pawn AHEAD of the knight overall while the table
    // still read 「prefers a knight」 — true of the numbers in the slot, false of
    // the armies it produced.
    for (const f of FIXTURES) {
      const rows = rowsFor(f)
      const starved = rows.filter((s) => countOn(s, 'knight', 'bomb') === 2)
      const free = rows.filter((s) => countOn(s, 'knight', 'bomb') < 2)

      // it really does happen, and it really is a minority
      expect(starved.length / rows.length, f.setting.name).toBeGreaterThan(0.03)
      expect(starved.length / rows.length, f.setting.name).toBeLessThan(0.2)

      // when the knights are gone the 軍旗 takes what is left — never the queen
      for (const s of starved) {
        expect(['pawn', 'rook'], `${f.setting.name} seed ${s.seed}`)
          .toContain(carriersOf(s, 'flag')[0]!)
      }

      // and when they are not, the knight is a clear majority of the set draw,
      // which is what leaves a margin over the pawn once the starved rows are
      // averaged back in
      const knights = free.filter((s) => carriersOf(s, 'flag')[0] === 'knight').length
      expect(knights / free.length, f.setting.name).toBeGreaterThan(0.5)
    }
  })

  it('uses the quiet pawns the board shape leaves it', () => {
    // 中央四格 marches d/e, so a/b/g/h are quiet; 側翼八格 marches a/d/e/h, so only
    // b/g are — and under 偵察兵 the four 工兵 have already taken b and g, which is
    // why that one row of the sweep has no pawn 軍旗 at all. The 結算格 shape is a
    // 附錄 B tunable, so this has to follow it rather than a constant.
    const pawnFiles = (name: string): Set<string> => {
      const files = new Set<string>()
      for (const s of SAMPLES.filter((x) => x.setting === name)) {
        for (const id of idsOf(s, 'flag')) {
          if (s.carrier.get(id) === 'pawn') files.add(s.file.get(id)!)
        }
      }
      return files
    }
    expect([...pawnFiles('standard · centre4')].sort()).toEqual(['a', 'b', 'g', 'h'])
    expect([...pawnFiles('standard · wide8')].sort()).toEqual(['b', 'g'])
    expect([...pawnFiles('scouts · wide8')].sort()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. 爆裂物 (notebook §2.3, §2.3d — starting proximity, not mobility)
// ---------------------------------------------------------------------------

describe('爆裂物 placement', () => {
  it('never puts a 爆裂物 on a rook', () => {
    // §2.3: far from ranks 4-5, blocked by its own pawns, and measured at about
    // one placement in twenty across the archive. 「打得贏」不等於「打得到」.
    for (const sample of SAMPLES) {
      expect(
        carriersOf(sample, 'bomb'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).not.toContain('rook')
    }
  })

  it('keeps every 爆裂物 on a carrier that starts near ranks 4-5', () => {
    // The allowed set is a claim about DISTANCE: king (one step behind the centre
    // pawns), the d/e pawns themselves, knight, bishop, queen. The king is in it
    // despite being the least mobile piece on the board, which is the whole point
    // of the §2.3 rewrite.
    for (const sample of SAMPLES) {
      for (const id of idsOf(sample, 'bomb')) {
        const carrier = sample.carrier.get(id)!
        expect(
          ['king', 'knight', 'bishop', 'queen', 'pawn'],
          `${sample.setting} seed ${sample.seed}: 爆裂物 on ${carrier}`,
        ).toContain(carrier)
        // a pawn 爆裂物 is the 結算格 squatter of §2.3d, so it is a CENTRE pawn
        if (carrier === 'pawn') {
          expect('de', `${sample.setting} seed ${sample.seed}: 爆裂物 on ${id}`)
            .toContain(sample.file.get(id)!)
        }
      }
    }
  })

  it('spreads over all five allowed carriers, king and knight leading', () => {
    for (const f of FIXTURES) {
      const { shareOf, counts } = carrierShares(f, 'bomb')
      expect(counts.get('rook'), f.setting.name).toBeUndefined()
      for (const carrier of ['king', 'knight', 'bishop', 'queen', 'pawn'] as const) {
        expect(shareOf(carrier), `${f.setting.name}: ${carrier}`).toBeGreaterThan(0.02)
      }
      // 「king 是最好的爆裂物載體之一」 and the knight jumps the unopened pawn line;
      // the queen is the tail, because it is expensive and 司令 wants it (§2.4).
      expect(shareOf('king'), f.setting.name).toBeGreaterThan(shareOf('queen'))
      expect(shareOf('knight'), f.setting.name).toBeGreaterThan(shareOf('queen'))
    }
  })
})

// ---------------------------------------------------------------------------
// 4. the c/f–d/e system (notebook §2.3c — 「一套完整的開局系統」)
// ---------------------------------------------------------------------------

describe('旅長 and 工兵 are one system', () => {
  it('puts 工兵 on c/f, and the 偵察兵 extras on b/g', () => {
    // Pawns capture diagonally: c attacks b/d and f attacks e/g, i.e. straight at
    // the enemy d/e pawns, which is where 爆裂物 like to sit — and 工兵 is the only
    // piece that can safely poke them (§5.4 immunity, both directions).
    for (const sample of SAMPLES) {
      const wanted = sample.setting.startsWith('scouts') ? 'bcfg' : 'cf'
      expect(
        filesOf(sample, 'engineer'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).toBe(wanted)
      expect(new Set(carriersOf(sample, 'engineer'))).toEqual(new Set(['pawn']))
    }
  })

  it('puts 旅長 on d/e whenever a 爆裂物 has not already taken the square', () => {
    // 「旅長佔 d/e 打正面，工兵在 c/f 待命拆對面的 d/e」. The only thing that displaces a
    // 旅長 from the centre is the §2.3d 爆裂物 squatter, which is deliberate — and
    // it is exact: nothing else in the doctrine ever touches d or e.
    for (const sample of SAMPLES) {
      const brigades = idsOf(sample, 'brigade').length
      const free = 2 - onFiles(sample, 'de', 'bomb')
      expect(
        onFiles(sample, 'de', 'brigade'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).toBe(Math.min(brigades, free))
    }
  })

  it('leaves the centre contested rather than readable', () => {
    // Both plans have to be live or the d4 pawn is a free read. Measured over the
    // sweep: 旅長 usually, 爆裂物 often enough to have to be checked.
    for (const f of FIXTURES) {
      const rows = rowsFor(f)
      const squatted = rows.filter((s) => onFiles(s, 'de', 'bomb') > 0).length / rows.length
      expect(squatted, f.setting.name).toBeGreaterThan(0.1)
      expect(squatted, f.setting.name).toBeLessThan(0.6)
    }
  })

  it('never puts a 工兵 on the queen', () => {
    // §2.1, the other direction: a side that would never waste a 工兵 on a queen
    // must not put its 軍旗 there either, or the ban above leaks.
    for (const sample of SAMPLES) {
      expect(carriersOf(sample, 'engineer'), sample.setting).not.toContain('queen')
    }
  })
})

// ---------------------------------------------------------------------------
// 5. 司令 (notebook §2.4 the mirror trade, §2.3d the rampage)
// ---------------------------------------------------------------------------

describe('司令 placement', () => {
  it('rides the queen or a pawn, and nothing else', () => {
    for (const sample of SAMPLES) {
      for (const carrier of carriersOf(sample, 'commander')) {
        expect(['queen', 'pawn'], `${sample.setting} seed ${sample.seed}`).toContain(carrier)
      }
    }
  })

  it('leans to the queen — the carrier that can execute the mirror trade', () => {
    // 「攜帶你司令的那顆載體，同時也是你對付對方司令的答案。」 A lean, not a habit: it is
    // the most stereotyped placement in the game, and the pawn 司令 is what §2.3d
    // calls the hardest thing to face.
    for (const f of FIXTURES) {
      const { shareOf } = carrierShares(f, 'commander')
      expect(shareOf('queen'), f.setting.name).toBeGreaterThan(shareOf('pawn'))
      expect(shareOf('queen'), f.setting.name).toBeLessThan(0.75)
      expect(shareOf('pawn'), f.setting.name).toBeGreaterThan(0.2)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. 軍長・師長 (notebook §2.3c — 高階需要射程), and graceful degradation
// ---------------------------------------------------------------------------

describe('軍長・師長 placement', () => {
  it('takes the bishops the 爆裂物 left, and degrades quietly when there are none', () => {
    // Two bishops, one argument. 高階雙份 asks for four of these ranks, so two of
    // them must land elsewhere — that is the fallback doing its job, and the only
    // hard requirement is that the deployment stays legal (asserted above).
    for (const sample of SAMPLES) {
      const wanted = idsOf(sample, 'general', 'division').length
      const free = 2 - countOn(sample, 'bishop', 'bomb')
      expect(
        countOn(sample, 'bishop', 'general', 'division'),
        `${sample.setting} ${sample.color} seed ${sample.seed}`,
      ).toBe(Math.min(wanted, free))
    }
  })

  it('draws which bishop carries 軍長 rather than fixing it', () => {
    // No argument distinguishes 軍長 from 師長, so a convention here would be free
    // information: 「c1 is the 軍長」 is one deduction the opponent should not get.
    const f = FIXTURES[0]!
    const seen = new Set<string>()
    for (let seed = 0; seed < SEEDS; seed++) {
      seen.add(filesOf(sampleOf(f, 'white', seed), 'general'))
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// 7. randomisation (§9) and replay (the arena's whole premise)
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

  it('lands the 軍旗 on at least two distinct carriers across 50 seeds', () => {
    // THE point of the randomisation, in one assertion. Notebook §1.3: the 軍旗 is
    // found by elimination, so a doctrine that always reaches the same carrier has
    // published it — and 攻略 §9 says a fixed configuration 「等同公開該方全軍」.
    for (const f of FIXTURES) {
      for (const color of COLORS) {
        const carriers = new Set(
          Array.from({ length: 50 }, (_unused, seed) => carriersOf(sampleOf(f, color, seed), 'flag')[0]),
        )
        expect(carriers.size, `${f.setting.name} ${color}: ${[...carriers].join('/')}`)
          .toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('gives different deployments for two different seeds', () => {
    const f = FIXTURES[0]!
    const a = informedDeployment(f.views.white, 'white', makeRng(1))
    const b = informedDeployment(f.views.white, 'white', makeRng(2))
    expect(b).not.toEqual(a)
    // …and it is not merely the two chosen seeds. A doctrine that collapses onto
    // a handful of armies is a §9 violation with extra steps. Constraints DO cost
    // variety — 工兵 are pinned to c/f by design — so this is a floor, not 100%.
    const distinct = new Set(
      Array.from({ length: SEEDS }, (_unused, seed) =>
        JSON.stringify(informedDeployment(f.views.white, 'white', makeRng(seed)))),
    )
    expect(distinct.size).toBeGreaterThan(SEEDS * 0.9)
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
// 8. it looks at the public 載體層 of its OWN side and nothing else
// ---------------------------------------------------------------------------

describe('the lens', () => {
  it('does not depend on the order view.pieces arrives in', () => {
    // Candidate lists are built in piece-id order before any draw. Without that,
    // the same seed would deploy differently against a host that serialises the
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
// 9. the doctrine object: readable, switchable, replaceable
// ---------------------------------------------------------------------------

describe('doctrine', () => {
  it('states its bans structurally, where a reader can see them', () => {
    // The old shape stated a ban as a zero weight. A set-based doctrine states it
    // as ABSENCE, which is stronger: there is no draw that could produce it.
    const flag = slotFor('flag')!
    const bomb = slotFor('bomb')!
    expect(allowedCarriers(flag).sort()).toEqual(['knight', 'pawn', 'rook'])
    expect(allowedCarriers(bomb).sort()).toEqual(['bishop', 'king', 'knight', 'pawn', 'queen'])
    expect(allowedCarriers(slotFor('brigade')!)).toEqual(['pawn'])
    expect(allowedCarriers(slotFor('engineer')!)).toEqual(['pawn'])
    expect(allowedCarriers(slotFor('commander')!).sort()).toEqual(['pawn', 'queen'])
    expect(allowedCarriers(slotFor('staff')!)).toEqual(['bishop'])

    // and the guards that also cover the fallback path
    expect(flag.never).toContain('queen')
    expect(bomb.never).toContain('rook')
    // §5.3 「軍旗以任何方式離開棋盤，該方立即判負」: it cannot capture to contest a
    // square and loses outright if captured, so marching it at a 結算格 — the one
    // square both sides are guaranteed to fight over — is not a preference to be
    // relaxed when the sets run out.
    expect(flag.neverMarching).toBe(true)
    for (const slot of DEFAULT_DOCTRINE) {
      if (slot.key !== 'flag') expect(slot.neverMarching, slot.key).toBeUndefined()
    }
    for (const slot of DEFAULT_DOCTRINE) {
      for (const carrier of slot.never ?? []) {
        expect(allowedCarriers(slot), `${slot.key} bans ${carrier} but allows it`)
          .not.toContain(carrier)
      }
      // every set is a legal weight and says why it exists
      for (const set of slot.sets) {
        expect(Number.isInteger(set.share) && set.share >= 0, `${slot.key}: ${set.why}`).toBe(true)
        expect(set.why.length).toBeGreaterThan(0)
      }
    }

    // the 工兵 system, as data: c/f first, b/g held in reserve for 偵察兵
    expect(slotFor('engineer')!.sets.map((s) => [s.files, s.share]))
      .toEqual([['cf', 1], ['bg', 0]])
    // 軍旗 prefers the knight without excluding the quiet pawn
    expect(flag.sets[0]!.carriers).toEqual(['knight'])
    expect(flag.sets[0]!.share).toBeGreaterThan(flag.sets[1]!.share)
    expect(flag.sets[1]!.quiet).toBe(true)
  })

  it('turns off one rule at a time, leaving the rest standing', () => {
    // notebook §6.6: 「兩局之間同時改變了三件事」. Measuring what the 軍旗 rule is
    // worth means changing the 軍旗 rule and nothing else.
    const f = FIXTURES[0]!
    const seeds = Array.from({ length: SEEDS }, (_unused, i) => i)
    const samples = (opts: DeploymentOptions): Sample[] =>
      seeds.map((seed) => sampleOf(f, 'white', seed, opts))

    // 軍旗 doctrine off → the queen 軍旗 that §2.1 forbids does turn up
    const flagOff = samples({ doctrine: { flag: false } })
    expect(flagOff.some((s) => carriersOf(s, 'flag').includes('queen'))).toBe(true)
    expect(flagOff.every((s) => !carriersOf(s, 'bomb').includes('rook'))).toBe(true)
    expect(flagOff.every((s) => filesOf(s, 'engineer') === 'cf')).toBe(true)

    // 爆裂物 doctrine off → the rook 爆裂物 that §2.3 forbids does turn up
    const bombOff = samples({ doctrine: { bomb: false } })
    expect(bombOff.some((s) => carriersOf(s, 'bomb').includes('rook'))).toBe(true)
    expect(bombOff.every((s) => !carriersOf(s, 'flag').includes('queen'))).toBe(true)

    // 工兵 doctrine off → they leave c/f (this is the switch belief.ts actually
    // uses: it evicts with a real 階級 instead of squatting with an immune one)
    const engineerOff = samples({ doctrine: { engineer: false } })
    expect(engineerOff.some((s) => filesOf(s, 'engineer') !== 'cf')).toBe(true)
    expect(engineerOff.every((s) => !carriersOf(s, 'flag').includes('queen'))).toBe(true)

    // everything off is just a uniform deal, and still a legal one
    const allOff: DeploymentOptions = {
      doctrine: { bomb: false, brigade: false, engineer: false, flag: false, commander: false, staff: false },
    }
    for (const opts of [{ doctrine: { flag: false } }, { doctrine: { bomb: false } }, allOff]) {
      for (const seed of seeds.slice(0, 40)) {
        expect(validateAssignment(
          informedDeployment(f.views.white, 'white', makeRng(seed), opts), 'white', f.state,
        )).toBeNull()
      }
    }
  })

  it('accepts a rival doctrine as data', () => {
    // The point of exposing the table: a different deployment system is a value,
    // not a code change, so it can be put in the arena against this one.
    const contrarian: readonly DoctrineSlot[] = [
      {
        key: 'flag',
        ranks: ['flag'],
        never: ['queen'],
        sets: [{ carriers: ['rook'], share: 1, why: 'test: 王車易位 relocates it in one ply' }],
      },
    ]
    const f = FIXTURES[0]!
    for (let seed = 0; seed < 40; seed++) {
      const a = informedDeployment(f.views.white, 'white', makeRng(seed), { rules: contrarian })
      expect(validateAssignment(a, 'white', f.state)).toBeNull()
      const flagId = Object.entries(a).find(([, r]) => r === 'flag')![0]
      expect(f.carrier.get(flagId)).toBe('rook')
    }
  })

  it('degrades to a legal placement instead of throwing when a set cannot be met', () => {
    // A slot whose sets are unsatisfiable on this table must not take the game
    // down with it — and the `never` guard has to survive the degradation, which
    // is the one thing a plain "fall back to uniform" would lose.
    const impossible: readonly DoctrineSlot[] = [
      {
        key: 'flag',
        ranks: ['flag'],
        never: ['queen'],
        neverMarching: true,
        // no king ever stands on the a file at 佈署 time
        sets: [{ carriers: ['king'], files: 'a', share: 1, why: 'test: unsatisfiable' }],
      },
      {
        key: 'staff',
        ranks: ['general', 'division'],
        sets: [{ carriers: [], share: 1, why: 'test: empty set' }],
      },
    ]
    const f = FIXTURES[4]!   // top-heavy: four 軍長/師長 to place through an empty set
    for (const color of COLORS) {
      for (let seed = 0; seed < 60; seed++) {
        const a = informedDeployment(f.views[color], color, makeRng(seed), { rules: impossible })
        expect(validateAssignment(a, color, f.state), `${color} seed ${seed}`).toBeNull()
        const flagId = Object.entries(a).find(([, r]) => r === 'flag')![0]
        expect(f.carrier.get(flagId), `${color} seed ${seed}`).not.toBe('queen')
        // `neverMarching` survives too, and it has to: a 軍旗 walking at a 結算格
        // cannot capture to hold it (§5.3) and loses the game the moment anything
        // captures it. An unsatisfiable set is no reason to accept that.
        expect(f.marching[color].has(flagId), `${color} seed ${seed}`).toBe(false)
      }
    }
  })

  it('drops the marching guard only when a table leaves nothing else', () => {
    // Legality outranks every guard: an assignment the engine refuses is not a
    // game. With every non-marching piece consumed before the 軍旗 draws, the
    // fallback must still return something rather than throw or return null.
    const hostile: readonly DoctrineSlot[] = [
      // eat all four quiet carriers on 側翼八格 first (a/d/e/h march, so the four
      // remaining pawns plus every piece must go somewhere)…
      {
        key: 'staff',
        ranks: ['general', 'division', 'brigade', 'regiment', 'battalion', 'company',
          'platoon', 'engineer', 'commander', 'bomb'],
        sets: [{ carriers: ['knight', 'bishop', 'rook', 'queen', 'king'], share: 1, why: 'test: eat the pieces' }],
      },
      {
        key: 'flag',
        ranks: ['flag'],
        never: [],
        neverMarching: true,
        sets: [{ carriers: ['knight'], share: 1, why: 'test: unsatisfiable by then' }],
      },
    ]
    const f = FIXTURES[1]!   // standard · wide8
    for (const color of COLORS) {
      for (let seed = 0; seed < 40; seed++) {
        const a = informedDeployment(f.views[color], color, makeRng(seed), { rules: hostile })
        expect(validateAssignment(a, color, f.state), `${color} seed ${seed}`).toBeNull()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 10. it drops into the harness as a Policy
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

// ---------------------------------------------------------------------------
// 11. what the doctrine actually produces (measurement, not assertion)
// ---------------------------------------------------------------------------

it('MEASURE', () => {
  for (const f of FIXTURES) {
    const lines: string[] = []
    for (const ranks of [['flag'], ['bomb'], ['commander'], ['engineer'], ['brigade'], ['general', 'division']] as Rank[][]) {
      const { counts, total } = carrierShares(f, ...ranks)
      const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${(n / total * 100).toFixed(0)}%`)
      lines.push(`${ranks.join('/')}: ${parts.join(', ')}`)
    }
    // eslint-disable-next-line no-console
    console.log(`\n${f.setting.name}\n  ${lines.join('\n  ')}`)
  }
})
