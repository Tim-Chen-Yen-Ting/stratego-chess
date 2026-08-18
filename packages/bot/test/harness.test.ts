/**
 * Harness tests.
 *
 * Three of these are the contract the harness was commissioned under:
 *   · a fixed seed reproduces byte-identical aggregate output
 *   · an illegal move from a policy throws, and is never quietly a pass
 *   · maxPlies terminates rather than hanging
 *
 * The rest guard the two things that make the numbers mean anything: that a
 * policy is handed a ViewerState and nothing else, and that the 同階雙亡 counter
 * — which no log can produce (gamebook v04 §4.3) — agrees with the log wherever
 * the log can still check it.
 *
 * Most policies here are LOCAL stubs. The harness has to be testable without the
 * shipped policies: a test that needed them would fail for two different reasons
 * and tell you neither. One integration test at the end drives the real ones.
 */

import { describe, expect, it } from 'vitest'
import { DISTRIBUTION_SCOUTS, SCORING_WIDE_8 } from '@xiyang/rules'
import type { Color, Move, PieceId, Rank, ViewerState } from '@xiyang/rules'
import {
  IllegalDeploymentError,
  IllegalMoveError,
  matchSeedFor,
  runMatch,
  runMatches,
} from '../src/harness.js'
import { aggregate, formatReport } from '../src/report.js'
import { deriveSeed, makeRng } from '../src/prng.js'
import { randomAssignment } from '../src/policy.js'
import type { Policy } from '../src/policy.js'
import { POLICIES } from '../src/index.js'
import { UsageError, parseArgs, policyNamed, run } from '../src/cli.js'

// ---------------------------------------------------------------------------
// Stub policies — view-only, seeded, deterministic
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

const passer: Policy = {
  name: 'passer',
  deploy: randomAssignment,
  move: () => ({ kind: 'pass' }),
}

// ---------------------------------------------------------------------------

describe('determinism', () => {
  const seed = 20250811

  function report(runSeed: number): string {
    const matches = runMatches(grabby, scatter, {}, runSeed, 8, 120)
    return formatReport(aggregate(matches, { seed: runSeed, maxPlies: 120 }))
  }

  it('reproduces byte-identical aggregate output from a fixed seed', () => {
    expect(report(seed)).toBe(report(seed))
  })

  it('produces different output from a different seed', () => {
    // Otherwise the test above would pass on a formatter that prints constants.
    expect(report(seed)).not.toBe(report(seed + 1))
  })

  it('replays a single match from the seed the run reported', () => {
    const matches = runMatches(grabby, scatter, {}, seed, 5, 120)
    const third = matches[2]!
    expect(third.result.seed).toBe(matchSeedFor(seed, 2))
    const alone = runMatch(grabby, scatter, {}, third.result.seed, 120)
    expect(alone.result.plies).toBe(third.result.plies)
    expect(alone.result.outcome).toEqual(third.result.outcome)
    expect(alone.state.log).toEqual(third.state.log)
  })

  it('numbers a match the same way however long the run is', () => {
    // A 10-game run must be the first 10 games of a 1000-game run, or shortening
    // a run to debug it resamples the thing you were debugging.
    const short = runMatches(scatter, scatter, {}, 3, 2, 60)
    const long = runMatches(scatter, scatter, {}, 3, 5, 60)
    expect(short.map((m) => m.result.seed)).toEqual(long.slice(0, 2).map((m) => m.result.seed))
    expect(short[1]!.state.log).toEqual(long[1]!.state.log)
  })

  it('gives each side a stream the other side cannot shift', () => {
    // Black's dice must not depend on how many draws White took, or a comparison
    // that changes one policy has silently changed both (notebook §6.6).
    const black = makeRng(deriveSeed(99, 'move:black'))
    const whiteHeavy = makeRng(deriveSeed(99, 'move:white'))
    whiteHeavy.next()
    whiteHeavy.next()
    expect(black.next()).toBe(makeRng(deriveSeed(99, 'move:black')).next())
  })
})

describe('an illegal move is a hard error', () => {
  it('throws when a policy returns a move the engine rejects', () => {
    const cheater: Policy = {
      name: 'cheater',
      deploy: randomAssignment,
      // a1→h8 is not a rook move, at ply 1 or ever
      move: () => ({ kind: 'move', from: 0, to: 63 }),
    }
    expect(() => runMatch(cheater, scatter, {}, 1, 50)).toThrow(IllegalMoveError)
    expect(() => runMatch(cheater, scatter, {}, 1, 50)).toThrow(/illegal move at ply 1/)
  })

  it('throws rather than passing when a policy returns nothing at all', () => {
    const empty: Policy = {
      name: 'empty',
      deploy: randomAssignment,
      move: () => undefined as unknown as Move,
    }
    let thrown: unknown = null
    try {
      runMatch(empty, scatter, {}, 2, 50)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(IllegalMoveError)
    // the failure must name the policy — a run of 1000 games has to say WHICH
    expect((thrown as IllegalMoveError).policy).toBe('empty')
    expect((thrown as IllegalMoveError).color).toBe('white')
  })

  it('throws when a policy returns an illegal deployment', () => {
    const sloppy: Policy = {
      name: 'sloppy',
      deploy: () => ({} as Record<PieceId, Rank>),
      move: (view, _color, rng) => rng.pick(legal(view)),
    }
    expect(() => runMatch(sloppy, scatter, {}, 3, 50)).toThrow(IllegalDeploymentError)
    expect(() => runMatch(sloppy, scatter, {}, 3, 50)).toThrow(/sloppy/)
  })
})

describe('maxPlies', () => {
  it('terminates a game that would otherwise never end', () => {
    // N is raised so 停滯 cannot end it first: the cap must be what stops it.
    const match = runMatch(passer, passer, { noProgressTurns: 10_000 }, 5, 12)
    expect(match.result.plies).toBe(12)
    expect(match.result.outcome.kind).toBe('max-plies')
    expect(match.result.outcome.winner).toBeNull()
    expect(match.result.unfinished).toBe(true)
    expect(match.state.status.kind).toBe('playing')
  })

  it('counts a capped game in the report without calling it a win', () => {
    const matches = runMatches(passer, passer, { noProgressTurns: 10_000 }, 6, 3, 8)
    const agg = aggregate(matches, { seed: 6, maxPlies: 8 })
    expect(agg.unfinished).toBe(3)
    expect(agg.decided).toBe(0)
    expect(agg.sides.white.wins).toBe(0)
    expect(agg.sides.black.wins).toBe(0)
    expect(formatReport(agg)).toContain('未終局 hit maxPlies')
  })

  it('refuses a nonsense cap instead of looping', () => {
    expect(() => runMatch(scatter, scatter, {}, 1, 0)).toThrow(/maxPlies/)
  })
})

describe('a policy sees a ViewerState and nothing else', () => {
  it('never hands over a hidden 兵種, a private field, or the opponent\'s army', () => {
    const seen: ViewerState[] = []
    const spy: Policy = {
      name: 'spy',
      deploy: (view, color, rng) => {
        seen.push(view)
        return randomAssignment(view, color, rng)
      },
      move: (view, _color, rng) => {
        seen.push(view)
        return rng.pick(legal(view))
      },
    }

    runMatch(spy, spy, {}, 7, 80)
    expect(seen.length).toBeGreaterThan(10)

    let hiddenEnemies = 0
    let setupViews = 0
    for (const view of seen) {
      expect(view.viewer.kind).toBe('player')
      const me = view.viewer.kind === 'player' ? view.viewer.color : null

      if (view.status.kind === 'setup') {
        setupViews++
        // §9 佈署前不公開 — nobody has submitted, so not even one's own army
        // exists yet: a placeholder must never be reported as a deployment.
        for (const piece of view.pieces) expect(piece.rank).toBeNull()
      }

      for (const piece of view.pieces) {
        // ViewerPiece carries no `hasMoved`: a spread of Piece would have
        // brought `rank` across with it.
        expect('hasMoved' in piece).toBe(false)
        if (piece.color === me) continue
        if (!piece.revealed) {
          expect(piece.rank).toBeNull()
          hiddenEnemies++
        }
      }
    }

    expect(setupViews).toBe(2)
    expect(hiddenEnemies).toBeGreaterThan(0)
  })

  it('hands the side to move its own ranks and its own legal moves', () => {
    let checked = 0
    const spy: Policy = {
      name: 'spy',
      deploy: randomAssignment,
      move: (view, color, rng) => {
        expect(view.toMove).toBe(color)
        expect(view.viewer).toEqual({ kind: 'player', color })
        expect(view.legalMoves).toBeDefined()
        const own = view.pieces.filter((p) => p.color === color)
        expect(own.length).toBe(16)
        expect(own.every((p) => p.rank !== null)).toBe(true)
        checked++
        return rng.pick(legal(view))
      },
    }
    runMatch(spy, scatter, {}, 8, 40)
    expect(checked).toBeGreaterThan(0)
  })

  it('deploys both sides from the same pre-submission state (§9 同時)', () => {
    const submitted: Record<Color, boolean>[] = []
    const watcher: Policy = {
      name: 'watcher',
      deploy: (view, color, rng) => {
        if (view.status.kind === 'setup') submitted.push({ ...view.status.submitted })
        return randomAssignment(view, color, rng)
      },
      move: (view, _color, rng) => rng.pick(legal(view)),
    }
    runMatch(watcher, watcher, {}, 9, 4)
    // Black must not be able to see that White has already deployed.
    expect(submitted).toEqual([
      { white: false, black: false },
      { white: false, black: false },
    ])
  })
})

describe('contact instrumentation', () => {
  it('splits 同歸於盡 into the three cases the log cannot tell apart', () => {
    const matches = runMatches(grabby, scatter, {}, 99, 12, 200)

    let contacts = 0
    for (const match of matches) {
      const log = match.state.log
      const announcedMutual = log.filter((e) => e.combat?.outcome.kind === 'mutual-destruction').length
      const announcedFizzle = log.filter((e) => e.combat?.outcome.kind === 'fizzle').length
      const withCombat = log.filter((e) => e.combat !== undefined).length
      const duels = match.result.duels

      expect(duels.contacts).toBe(withCombat)
      expect(duels.fizzles).toBe(announcedFizzle)
      // the whole point: these three arrive as ONE announcement
      expect(duels.rankTies + duels.bombDetonations + duels.bombVsBomb).toBe(announcedMutual)
      expect(duels.rankDuels).toBe(duels.rankTies + duels.rankDecisive)
      expect(duels.rankDuels + duels.bombDetonations + duels.bombVsBomb + duels.fizzles)
        .toBe(duels.contacts)

      contacts += withCombat
    }

    expect(contacts).toBeGreaterThan(0)
  })

  it('reports the pooled tie rate over rank duels, not over all contacts', () => {
    const matches = runMatches(grabby, scatter, {}, 101, 10, 200)
    const agg = aggregate(matches, { seed: 101, maxPlies: 200 })
    const c = agg.contacts
    expect(c.rankDuels).toBeLessThanOrEqual(c.total)
    if (c.rankDuels > 0) expect(c.tieRate).toBeCloseTo(c.rankTies / c.rankDuels, 12)
    expect(c.announcedMutual).toBe(c.rankTies + c.bombDetonations + c.bombVsBomb)
    expect(c.perPly).toBeCloseTo(c.total / agg.plies.total, 12)
  })
})

describe('config is threaded, not assumed', () => {
  it('plays and labels the board and 兵種 table it was given', () => {
    const matches = runMatches(scatter, scatter, {
      scoringSquares: SCORING_WIDE_8,
      distribution: DISTRIBUTION_SCOUTS,
      scoreTarget: 12,
      noProgressTurns: 12,
    }, 4, 4, 150)

    for (const match of matches) {
      expect(match.state.config.scoringSquares).toEqual([...SCORING_WIDE_8])
      expect(match.state.config.distribution.engineer).toBe(4)
    }

    const text = formatReport(aggregate(matches, { seed: 4, maxPlies: 150 }))
    expect(text).toContain('wide8')
    expect(text).toContain('scouts')
    expect(text).toContain('X 12')
  })

  it('turns the clock off by default, so 超時 is structurally impossible', () => {
    const match = runMatch(scatter, scatter, {}, 12, 40)
    expect(match.state.config.clockEnabled).toBe(false)
    expect(match.result.outcome.kind).not.toBe('timeout')
  })

  it('deploys at random, not from the fixed §9 fallback', () => {
    const armyOf = (seed: number): string =>
      runMatch(scatter, scatter, {}, seed, 2)
        .state.pieces.filter((p) => p.color === 'white')
        .map((p) => p.rank)
        .join(',')
    expect(armyOf(15)).not.toBe(armyOf(16))
  })
})

describe('the shipped policies', () => {
  it('drives the real registry end to end', () => {
    const matches = runMatches(POLICIES.greedy!, POLICIES.random!, {}, 42, 4, 200)
    const agg = aggregate(matches, { seed: 42, maxPlies: 200 })
    expect(agg.games).toBe(4)
    expect(agg.sides.white.name).toBe('greedy')
    expect(agg.sides.black.name).toBe('random')
    expect(formatReport(agg)).toContain('white greedy · black random')
  })
})

describe('the command line', () => {
  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseArgs(['--sqaures', 'wide8'])).toThrow(UsageError)
    expect(() => parseArgs(['--games'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--games', 'lots'])).toThrow(/integer/)
    expect(() => parseArgs(['--squares', 'diagonal'])).toThrow(/unknown preset/)
    expect(() => parseArgs(['1000'])).toThrow(/unexpected argument/)
    expect(() => policyNamed('psychic')).toThrow(/unknown policy/)
  })

  it('parses the documented flags, in either spelling', () => {
    const options = parseArgs(
      ['--white', 'greedy', '--black=random', '--games', '250', '--seed', '9',
        '--squares', 'wide8', '--dist', 'scouts', '--x', '60', '--n', '20', '--max-plies', '500'],
    )
    expect(options).toMatchObject({ white: 'greedy', black: 'random', games: 250, seed: 9, maxPlies: 500 })
    expect(options.config.scoringSquares).toEqual([...SCORING_WIDE_8])
    expect(options.config.distribution).toBe(DISTRIBUTION_SCOUTS)
    expect(options.config.scoreTarget).toBe(60)
    expect(options.config.noProgressTurns).toBe(20)
  })

  it('defaults to a run that is reproducible and small enough to read', () => {
    const options = parseArgs([])
    expect(options).toMatchObject({ white: 'random', black: 'random', games: 100, seed: 1 })
    expect(options.config).toEqual({})
  })
})

/**
 * §7.3's two knobs, end to end.
 *
 * The failure this guards against is the one CLAUDE.md §5 records: a flag that
 * parses, compiles and is never reachable — `belief` was registered in the CLI
 * while absent from the browser, and four games were written up under the wrong
 * opponent's name. So the assertions below do not stop at `parseArgs`. The
 * report's config line is read back off `state.config` (the ENGINE's config,
 * after `createGame`), which means a flag that were accepted and then dropped on
 * the way to `runMatches` would print its default and fail here.
 *
 * The knobs ship at 0 and the harness passes no value of its own, so a run that
 * names neither is byte-identical to what every notebook measurement was taken
 * against — that is asserted too, in both directions.
 */
describe('§7.3 吃子得分 is settable and recorded', () => {
  it('parses --k and --fizzle in either spelling', () => {
    const options = parseArgs(['--k', '2', '--fizzle=1'])
    expect(options.config.captureScoreK).toBe(2)
    expect(options.config.fizzleBonus).toBe(1)
  })

  /*
   * INVERTED. This test used to assert 「decimals included」 — `--k 2.5` parsing
   * to 2.5 — on the reasoning that a sweep which can only step in whole points
   * cannot find a fractional optimum.
   *
   * That reasoning was wrong, and the new assertion is the strict one. §7.4's
   * 「貼目為非整數，故分數永不相等」 holds only while 貼目 is the ONLY non-integer
   * source of points, so 附錄 B now requires k and 有煙無傷獎勵 to be whole
   * numbers. At k = 0.5 a 司令 win pays exactly 貼目, both columns can land on
   * the same number, and `leader()` hands the game to black on a comparison
   * rather than on a rule — in a game the rulebook says cannot be tied.
   *
   * A fractional value must therefore be REFUSED, not rounded: rounding would
   * label the run with a k it did not play, which is the same trustworthiness
   * failure the test below is about.
   */
  it('refuses a fractional k or 有煙無傷獎勵 — 附錄 B requires whole numbers', () => {
    expect(() => parseArgs(['--k', '2.5'])).toThrow(UsageError)
    expect(() => parseArgs(['--k', '2.5'])).toThrow(/integer/)
    expect(() => parseArgs(['--fizzle=1.5'])).toThrow(/integer/)
  })

  it('refuses a value that does not parse, rather than falling back to 0', () => {
    // A silent fallback would label a k=0 run as the k it was asked for, and the
    // whole point of this tool is that the label is trustworthy.
    expect(() => parseArgs(['--k', 'lots'])).toThrow(UsageError)
    expect(() => parseArgs(['--k', 'lots'])).toThrow(/expected an integer/)
    expect(() => parseArgs(['--fizzle', ''])).toThrow(/expected an integer/)
    expect(() => parseArgs(['--k'])).toThrow(/needs a value/)
  })

  it('leaves the config untouched when neither flag is named', () => {
    // Not "sets them to 0": the engine's DEFAULT_CONFIG owns the default, and the
    // CLI must not pin a 附錄 B value that a sweep may one day fix elsewhere.
    const options = parseArgs(['--games', '10'])
    expect('captureScoreK' in options.config).toBe(false)
    expect('fizzleBonus' in options.config).toBe(false)
  })

  it('reaches the engine, and the report says which values produced the run', () => {
    const text = run(['--white', 'greedy', '--black', 'random', '--games', '3',
      '--seed', '77', '--max-plies', '200', '--k', '5', '--fizzle', '2'])
    expect(text).toContain('吃子 k 5 · 有煙無傷 2')
    // the caveat only earns its place when a knob is live
    expect(text).toContain('§7.3 吃子得分 IS LIVE')
  })

  it('prints the zeros and no caveat when the knobs are left alone', () => {
    const text = run(['--white', 'greedy', '--black', 'random', '--games', '3',
      '--seed', '77', '--max-plies', '200'])
    expect(text).toContain('吃子 k 0 · 有煙無傷 0')
    expect(text).not.toContain('IS LIVE')
  })

  it('changes the measured run — and the run it changes is not contact-free', () => {
    // Without the contact assertion this comparison could pass vacuously on a
    // corpus where nothing ever met, which would prove only that two identical
    // strings differ somewhere in the header.
    const plain = runMatches(grabby, scatter, {}, 99, 12, 200)
    const paid = runMatches(grabby, scatter, { captureScoreK: 5, fizzleBonus: 2 }, 99, 12, 200)

    const contacts = plain.reduce((n, m) => n + m.result.duels.contacts, 0)
    expect(contacts).toBeGreaterThan(0)

    for (const match of paid) {
      expect(match.state.config.captureScoreK).toBe(5)
      expect(match.state.config.fizzleBonus).toBe(2)
    }
    for (const match of plain) {
      // the harness adds nothing of its own — the engine default stands
      expect(match.state.config.captureScoreK).toBe(0)
      expect(match.state.config.fizzleBonus).toBe(0)
    }

    const report = (m: typeof plain): string =>
      formatReport(aggregate(m, { seed: 99, maxPlies: 200 }))
    expect(report(paid)).not.toBe(report(plain))
  })
})
