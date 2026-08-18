/**
 * Report tests — the ①/② split, and the row that used to fuse them.
 *
 * §7.1 pays a score out of two sources: ① 吃子得分 (§7.3) in the action phase and
 * ② 佔領計分格 (§7.2) in the settlement phase. The bot report has rows labelled
 * 得分 (points) and rows labelled 佔格 (squares), and the whole content of these
 * tests is that a 佔格 row reads ② ALONE.
 *
 * What was wrong: 平均佔格 was `earned / settlements` — ①+② over a count of this
 * side's own settlements. Two defects in one expression. It called capture
 * points squares, so the figure was unbounded by the board (asserted below: at
 * k = 20 it ran to 6.1 on a four-square 結算格 set, and past the run's own max
 * peak of 3). And ① does not follow the mover — 守方勝 pays the defender and
 * 有煙無傷 pays the survivor, on a ply that side never moved on — so part of the
 * numerator had nothing to do with the denominator at all. These figures are
 * quoted in notebook §9–§16 as square counts.
 *
 * The knobs ship at 0, which made all of this LATENT: at `captureScoreK` and
 * `fizzleBonus` of 0 the ① column is identically zero, `earned` equals
 * `earnedFromSettlement` to the bit, and the old expression and the new one are
 * the same number. `default config: the ①/② split is a no-op` below pins that
 * with exact float equality rather than a tolerance, because it is the guarantee
 * that every existing notebook measurement is still reproducible.
 *
 * Method note on the k > 0 tests: they run the SAME seed at two values of k with
 * 分數線 X pushed out of reach, so §7.5② never fires and the games do not
 * diverge. The stub policies do not read the score, so the two runs are the same
 * corpus of moves and contacts — asserted, not assumed — and any difference in a
 * reported figure is the reporting, not the play. That is what makes "② is
 * invariant under k" a testable claim instead of a plausible one.
 *
 * The stubs are local, per the convention `harness.test.ts` documents: a test
 * that leaned on `contest` or `belief` would fail for two different reasons and
 * tell you neither.
 */

import { describe, expect, it } from 'vitest'
import { captureScore, gameStats, opposite, stateForViewer } from '@xiyang/rules'
import type { Color, Move, ViewerState } from '@xiyang/rules'
import { runMatches } from '../src/harness.js'
import type { Match } from '../src/harness.js'
import { randomAssignment } from '../src/policy.js'
import type { Policy } from '../src/policy.js'
import { aggregate, formatReport } from '../src/report.js'

// ---------------------------------------------------------------------------
// Local stubs — view-only, seeded, and blind to the score
// ---------------------------------------------------------------------------

function legal(view: ViewerState): Move[] {
  // §3④ pass is always legal, so the list is never empty for the side to move.
  return view.legalMoves ?? [{ kind: 'pass' }]
}

const scatter: Policy = {
  name: 'scatter',
  deploy: randomAssignment,
  move: (view, _color, rng) => rng.pick(legal(view)),
}

/** Takes a 結算格 when one is on offer, otherwise plays at random. */
const grabby: Policy = {
  name: 'grabby',
  deploy: randomAssignment,
  move: (view, _color, rng) => {
    const scoring = new Set(view.config.scoringSquares)
    const onto = legal(view).filter((m) => m.kind === 'move' && scoring.has(m.to))
    return rng.pick(onto.length > 0 ? onto : legal(view))
  },
}

const COLORS: readonly Color[] = ['white', 'black']
const SEED = 4242
const GAMES = 20
const MAX_PLIES = 200

/**
 * 分數線 X out of reach.
 *
 * §7.5② ends a game when a side crosses X, so at any k > 0 the extra income
 * would end games sooner and the k = 0 and k > 0 corpora would be different
 * games. With X unreachable the only terminators left — 奪旗, 停滯, the ply cap —
 * are all independent of the score, so k changes what is PAID and nothing about
 * what is PLAYED. `k does not touch the games themselves` asserts exactly that.
 */
const NO_SCORE_WIN = { scoreTarget: 1e9 }

function run(config: Record<string, unknown>): Match[] {
  return runMatches(grabby, scatter, config, SEED, GAMES, MAX_PLIES)
}

function report(matches: readonly Match[]): string {
  return formatReport(aggregate(matches, { seed: SEED, maxPlies: MAX_PLIES }))
}

interface Pool {
  /** ①+② — what the old 平均佔格 numerator was */
  earned: number
  /** ① 吃子得分 alone */
  captures: number
  /** ② 佔領計分格 alone */
  settlement: number
  /** own 結算 — the denominator, unchanged by any of this */
  settlements: number
}

/**
 * Pool the per-game figures independently of `aggregate`, straight off
 * `gameStats`, so a test is not checking the report against itself. This is the
 * 全知者 view of §10.1 for statistics only, exactly as `report.ts` uses it.
 */
function pool(matches: readonly Match[]): Record<Color, Pool> {
  const out: Record<Color, Pool> = {
    white: { earned: 0, captures: 0, settlement: 0, settlements: 0 },
    black: { earned: 0, captures: 0, settlement: 0, settlements: 0 },
  }
  for (const match of matches) {
    const stats = gameStats(stateForViewer(match.state, { kind: 'omniscient' }))
    for (const color of COLORS) {
      const s = stats.sides[color]
      out[color].earned += s.earned
      out[color].captures += s.earnedFromCaptures
      out[color].settlement += s.earnedFromSettlement
      out[color].settlements += s.settlements
    }
  }
  return out
}

/** Every move and every announced contact, in order — the corpus fingerprint. */
function trajectory(matches: readonly Match[]): string {
  return matches
    .map((m) => m.state.log
      .map((e) => `${e.ply}${e.color}${JSON.stringify(e.move ?? null)}${JSON.stringify(e.combat ?? null)}`)
      .join('|'))
    .join('#')
}

// ---------------------------------------------------------------------------

describe('default config: the ①/② split is a no-op', () => {
  const matches = run({})
  const agg = aggregate(matches, { seed: SEED, maxPlies: MAX_PLIES })
  const pooled = pool(matches)

  it('pays nothing out of ①, so 佔格 and 得分 are the same number', () => {
    for (const color of COLORS) {
      expect(agg.config.captureScoreK).toBe(0)
      expect(agg.config.fizzleBonus).toBe(0)
      // Exact, not close: `captureScore` multiplies by k = 0 and returns a
      // literal 0 for 有煙無傷, so ② is `earned` minus an exact zero.
      expect(pooled[color].captures).toBe(0)
      expect(pooled[color].settlement).toBe(pooled[color].earned)
      expect(agg.sides[color].captureIncome).toBe(0)
      expect(agg.sides[color].capturePerPly).toBe(0)
    }
  })

  it('prints 平均佔格 bit-for-bit as the fused expression did', () => {
    // THE byte-identity guarantee. `meanSquaresHeld` changed from
    // `earned / settlements` to `earnedFromSettlement / settlements`; this
    // asserts the two are the same float at the shipped default, which is what
    // makes every notebook figure taken at k = 0 still reproducible. `toBe` on
    // purpose — a tolerance here would let a real drift through as noise.
    for (const color of COLORS) {
      const fused = pooled[color].earned / pooled[color].settlements
      expect(pooled[color].settlements).toBeGreaterThan(0)
      expect(agg.sides[color].meanSquaresHeld).toBe(fused)
    }
  })

  it('adds no rows and no caveat to the printed report', () => {
    const text = report(matches)
    expect(text).not.toContain('capture income')
    expect(text).not.toContain('capture/ply')
    expect(text).not.toContain('IS LIVE')
    // the row it is about is still there, and still the only 佔格 mean
    expect(text).toContain('平均佔格 mean squares/結算')
  })
})

describe('k > 0: 平均佔格 is ② alone', () => {
  const plain = run({ ...NO_SCORE_WIN })
  const paid = run({ ...NO_SCORE_WIN, captureScoreK: 20, fizzleBonus: 1 })

  it('k does not touch the games themselves — same seed, same corpus', () => {
    // Without this the comparison below would be between two different sets of
    // games and would prove nothing about the reporting.
    expect(trajectory(paid)).toBe(trajectory(plain))
    for (const match of paid) {
      expect(match.state.config.captureScoreK).toBe(20)
      expect(match.state.config.fizzleBonus).toBe(1)
    }
    const contacts = plain.reduce((n, m) => n + m.result.duels.contacts, 0)
    expect(contacts).toBeGreaterThan(0)
  })

  it('reports the identical 佔格 figures at k = 0 and k = 20', () => {
    const a = aggregate(plain, { seed: SEED, maxPlies: MAX_PLIES })
    const b = aggregate(paid, { seed: SEED, maxPlies: MAX_PLIES })
    for (const color of COLORS) {
      // Same games, same squares stood on — so a figure that claims to count
      // squares MUST NOT MOVE when the price of a capture changes. This is the
      // assertion the old code failed: 平均佔格 tracked k linearly.
      expect(b.sides[color].meanSquaresHeld).toBe(a.sides[color].meanSquaresHeld)
      expect(b.sides[color].meanPeakHeld).toBe(a.sides[color].meanPeakHeld)
      expect(b.sides[color].maxPeakHeld).toBe(a.sides[color].maxPeakHeld)
      // …while the 得分 rows, which are ①+② and say so, do move.
      expect(b.sides[color].captureIncome).toBeGreaterThan(0)
      expect(b.sides[color].earnedPerPly).not.toBe(a.sides[color].earnedPerPly)
    }
  })

  it('stays bounded by the board, where the fused figure did not', () => {
    const agg = aggregate(paid, { seed: SEED, maxPlies: MAX_PLIES })
    const pooled = pool(paid)
    const squares = agg.config.scoringSquares.length
    for (const color of COLORS) {
      const side = agg.sides[color]
      const mean = side.meanSquaresHeld!
      // §7.5② credits +1 per own piece on a 結算格, so a settlement's ② cannot
      // exceed the number of 結算格, and a mean over settlements cannot either.
      expect(mean).toBeLessThanOrEqual(squares)
      // Nor can the mean of a series exceed that series' maximum.
      expect(mean).toBeLessThanOrEqual(side.maxPeakHeld)

      // The old expression violates both, on this very corpus.
      const fused = pooled[color].earned / pooled[color].settlements
      expect(fused).toBeGreaterThan(squares)
      expect(fused).toBeGreaterThan(side.maxPeakHeld)
    }
  })

  it('splits without losing anything — ① + ② adds back to earned', () => {
    const agg = aggregate(paid, { seed: SEED, maxPlies: MAX_PLIES })
    const pooled = pool(paid)
    for (const color of COLORS) {
      expect(pooled[color].captures + pooled[color].settlement)
        .toBeCloseTo(pooled[color].earned, 9)
      expect(agg.sides[color].captureIncome).toBe(pooled[color].captures)
      expect(agg.sides[color].meanSquaresHeld)
        .toBe(pooled[color].settlement / pooled[color].settlements)
    }
  })

  it('keeps ① out of a per-own-結算 denominator, because ① is not mover-only', () => {
    // The claim the report makes in prose, checked against the engine's own
    // pricing function on the public announcement: there are plies whose capture
    // payment goes to the side that did NOT move. Income like that has no
    // business being divided by the payee's own settlement count.
    let toNonMover = 0
    for (const match of paid) {
      for (const e of match.state.log) {
        if (!e.combat) continue
        const pay = captureScore(e.combat.outcome, e.color, match.state.config)
        if (pay[opposite(e.color)] > 0) toNonMover++
      }
    }
    expect(toNonMover).toBeGreaterThan(0)

    const agg = aggregate(paid, { seed: SEED, maxPlies: MAX_PLIES })
    for (const color of COLORS) {
      // ① is pooled over GAME LENGTH; that is the only denominator it shares
      // with its numerator.
      expect(agg.sides[color].capturePerPly)
        .toBeCloseTo(agg.sides[color].captureIncome / agg.plies.total, 12)
    }
  })
})

describe('the k > 0 caveat says what the code does', () => {
  const text = report(run({ ...NO_SCORE_WIN, captureScoreK: 20, fizzleBonus: 1 }))

  it('prints the ① rows and the caveat only when a knob is live', () => {
    expect(text).toContain('吃子得分 capture income')
    expect(text).toContain('吃子得分 capture/ply')
    expect(text).toContain('§7.3 吃子得分 IS LIVE (k 20, 有煙無傷 1)')
  })

  /*
   * INVERTED. The caveat used to assert that `record.ts`「reads the whole per-ply
   * delta as 佔格 (`const held = Math.round(inc)`)」and therefore that 最高同時佔格
   * 「can exceed the number of 結算格 on the board」and that 「none of them is a
   * square count any more」.
   *
   * All three statements are now false and the new assertions are the strict
   * ones. `sideStats` takes its 佔格 series off `income[i].settlement[color]` —
   * the ② column — so the peak was already ②-only and correct; the row that
   * actually fused the sources was this file's own 平均佔格, which the caveat did
   * not mention. A warning that describes the wrong defect is worse than none:
   * it is printed to exactly the person running a k sweep, and it pointed them
   * away from the one number that was wrong.
   */
  it('no longer blames record.ts for a fusion it does not do', () => {
    expect(text).not.toContain('Math.round(inc)')
    expect(text).not.toContain('none of them is a square count')
    expect(text).not.toContain('can exceed the number of 結算格')
    expect(text).toContain('income[i].settlement[color]')
  })
})
