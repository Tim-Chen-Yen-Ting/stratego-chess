/**
 * What has to be true about `belief` before any number it produces is worth
 * reading.
 *
 * The policy's whole claim is that it prices a contact instead of guessing at
 * it, so the tests are about the PRICE, not about the moves it happens to like:
 *
 *   1. it never crashes the 軍旗 into an occupied square (攻略 §9). This is not
 *      "a bad move" — §5.3 and §7④① make it a resignation, and a policy that
 *      does it occasionally would show up in the arena as a mysterious 奪旗 rate.
 *   2. it attacks what the belief says is weaker and declines what it says is
 *      stronger. Without both, the belief is decoration.
 *   3. the two 兵種 exceptions are priced as exceptions: a possible 軍旗 is a WIN
 *      (§7④①, the game ends — it is not a captured piece), and a 工兵 hitting a
 *      爆裂物 is a WIN (§5.4), not the 同歸於盡 every other rank would get.
 *   4. it parks (攻略 §3) — it does not step off income for nothing.
 *   5. it MIXES. A deterministic policy is itself an observable that leaks its
 *      own 兵種 across enough games; the epsilon band is the policy binding
 *      itself where 附錄 A binds only the rules.
 *   6. a seed replays exactly, `beliefFor`'s sampling included.
 */

import { describe, expect, it } from 'vitest'
import {
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
  createGame,
  moveToNotation,
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

import { deriveSeed, makeRng } from '../src/prng.js'
import { playGame, runMatch } from '../src/index.js'
import type { GameOutcome } from '../src/index.js'
import { contestPolicy } from '../src/policies/contest.js'
import { randomPolicy } from '../src/policies/random.js'
import {
  MIXING_BAND_SQUARES,
  beliefPolicy,
  branchOdds,
  classifyContact,
  contactEV,
  economyOf,
  revealsOnWin,
} from '../src/policies/belief.js'
import type { ContactTerms } from '../src/policies/belief.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sq = (name: string): Square => {
  const s = parseSquare(name)
  if (s === null) throw new Error(`not a square: ${name}`)
  return s
}

const PASS: Move = { kind: 'pass' }
const move = (from: string, to: string): Move => ({ kind: 'move', from: sq(from), to: sq(to) })

/** A game with both sides deployed by `belief`, ready to be read as a ViewerState. */
function deployedGame(seed = 1, config?: Partial<GameConfig>): GameState {
  let state = createGame('belief-unit', { clockEnabled: false, ...config })
  for (const color of ['white', 'black'] as const) {
    const rng = makeRng(deriveSeed(seed, `deploy:${color}`))
    const view = stateForViewer(state, { kind: 'player', color })
    state = submitAssignment(state, color, beliefPolicy.deploy(view, color, rng))
  }
  return state
}

interface Placement {
  id: PieceId
  /** relocate it; omitted leaves it where §9 put it */
  square?: Square
  /** overwrite its 兵種 */
  rank?: Rank
  /** 翻明 it (§4.3) — only meaningful for an enemy piece */
  reveal?: boolean
}

/**
 * A position built by hand, as a ViewerState.
 *
 * A policy is a pure function of this payload, so a hand-built one is a
 * legitimate — and far sharper — probe than driving a real game until the
 * position turns up. Every piece stays ON the board unless it is moved: a piece
 * removed while the game continues is public evidence that it was not the 軍旗
 * (notebook §1.3), and a board swept clean would hand the belief sixteen such
 * facts at once and make every scene a lie.
 */
function scene(spec: {
  color: Color
  place: Placement[]
  moves: Move[]
  config?: Partial<GameConfig>
  seed?: number
}): ViewerState {
  const state = deployedGame(spec.seed ?? 1, spec.config)
  const view = stateForViewer(state, { kind: 'player', color: spec.color })
  for (const p of spec.place) {
    const piece = view.pieces.find((x) => x.id === p.id)
    if (!piece) throw new Error(`no piece ${p.id}`)
    if (p.square !== undefined) piece.square = p.square
    if (p.rank !== undefined) piece.rank = p.rank
    if (p.reveal) piece.revealed = true
  }
  view.legalMoves = spec.moves
  return view
}

/** Every move the policy plays from one position over `n` seeds. */
function playsOver(view: ViewerState, color: Color, n: number): Set<string> {
  const seen = new Set<string>()
  for (let seed = 0; seed < n; seed++) {
    seen.add(moveToNotation(beliefPolicy.move(view, color, makeRng(seed))))
  }
  return seen
}

/** 100 seeds played both ways round = exactly 200 games. */
const VS_CONTEST: GameOutcome[] = (() => {
  const summary = runMatch({
    seed: 20260816,
    games: 100,
    white: beliefPolicy,
    black: contestPolicy,
    swapColors: true,
    keepGames: true,
  })
  expect(summary.games).toBe(200)
  return summary.outcomes ?? []
})()

function flagIdOf(outcome: GameOutcome, color: Color): PieceId {
  const entry = Object.entries(outcome.deployment[color]).find(([, rank]) => rank === 'flag')
  if (!entry) throw new Error(`no 軍旗 in the ${color} deployment`)
  return entry[0]
}

// ---------------------------------------------------------------------------
// 1. the 軍旗 never crashes into anything — 攻略 §9, §5.3, §7④①
// ---------------------------------------------------------------------------

describe('the 軍旗 never enters an occupied square', () => {
  it('logs no contact by its own flag piece across 200 seeded games', () => {
    let plies = 0
    let flagMoves = 0
    for (const outcome of VS_CONTEST) {
      for (const color of ['white', 'black'] as const) {
        if (outcome.policies[color] !== 'belief') continue
        const flagId = flagIdOf(outcome, color)
        for (const record of outcome.plyRecords) {
          if (record.color !== color) continue
          plies++
          if (record.moverId !== flagId) continue
          flagMoves++
          expect(
            record.contact,
            `${outcome.id} ply ${record.ply} ${record.notation} moved the 軍旗 into a piece`,
          ).toBe(false)
        }
      }
    }
    // The invariant is worthless if the bot barely played, and the games have to
    // contain real fighting or "no flag contact" is a statement about nothing.
    expect(plies).toBeGreaterThan(1000)
    expect(VS_CONTEST.reduce((n, o) => n + o.plyRecords.filter((r) => r.contact).length, 0))
      .toBeGreaterThan(200)

    // Measured at the time of writing: `flagMoves` is 0 — the 軍旗 does not move
    // at all in these games, because 佈署 keeps it off the pawns that march and a
    // quiet 軍旗 move needs a gain it can almost never produce. Which means this
    // test alone is a weak version of the claim, satisfied by a piece that sits
    // still. The next test is the strong version: it puts a free capture in front
    // of the 軍旗 and checks the policy declines it.
    expect(flagMoves).toBeLessThan(plies)
  })

  it('refuses to take even a free piece with the 軍旗', () => {
    // The 軍旗 on c3 with a lone, undefended enemy pawn on d4 — a capture that
    // gains a 結算格 and would be the best move on the board for any other piece.
    // §7④① settles it before any EV is computed: the 軍旗 leaving the board loses
    // the game, and it leaves the board whether it wins or loses the contact.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-c2', square: sq('c3'), rank: 'flag' },
        { id: 'b-d7', square: sq('d4') },
      ],
      moves: [move('c3', 'd4'), move('c3', 'c4'), PASS],
    })
    const played = playsOver(view, 'white', 40)
    expect(played.has('c3d4')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. it attacks weakness and declines strength
// ---------------------------------------------------------------------------

describe('the belief decides the attack', () => {
  it('attacks a piece it is all but certain is weaker', () => {
    // A 翻明 排長 (§4.3 makes it permanent and public) sitting on d4. Our 旅長
    // beats it outright, takes the square, and takes the income off them.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-c2', square: sq('c3'), rank: 'brigade' },
        { id: 'b-d7', square: sq('d4'), rank: 'platoon', reveal: true },
      ],
      moves: [move('c3', 'd4'), move('c3', 'c4'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['c3d4']))
  })

  it('declines the mirror image of that attack when the target is stronger', () => {
    // Same square, same gain, opposite belief: a 翻明 司令 on d4 beats our 排長,
    // and §4.1 says we come off the board without ever entering d4. The square is
    // worth having and is still not worth this.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-c2', square: sq('c3'), rank: 'platoon' },
        { id: 'b-d7', square: sq('d4'), rank: 'commander', reveal: true },
      ],
      moves: [move('c3', 'd4'), move('c3', 'c4'), PASS],
    })
    const played = playsOver(view, 'white', 60)
    expect(played.has('c3d4')).toBe(false)
    expect(played.size).toBeGreaterThan(0)
  })

  it('takes a piece the belief has cornered as the 軍旗, with anything at all', () => {
    // 翻明 fifteen of Black's sixteen pieces. The §2 數量表 is a bijection (§9), so
    // the sixteenth is the 軍旗 — no probability involved, just the pool. A 排長 is
    // the second-weakest 兵種 on the board and it is the right piece to send,
    // because winning ends the game (§7④①) rather than winning a piece.
    const others: Rank[] = [
      'commander', 'general', 'division', 'brigade', 'brigade', 'regiment', 'regiment',
      'battalion', 'battalion', 'company', 'platoon', 'engineer', 'engineer', 'bomb', 'bomb',
    ]
    const blackHomes = [
      'a7', 'b7', 'c7', 'e7', 'f7', 'g7', 'h7',
      'a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8',
    ]
    const place: Placement[] = [
      { id: 'w-c2', square: sq('c3'), rank: 'platoon' },
      { id: 'b-d7', square: sq('d4') }, // the one piece left unrevealed
      ...blackHomes.map((home, i) => ({
        id: `b-${home}`,
        rank: others[i]!,
        reveal: true,
      })),
    ]
    const view = scene({
      color: 'white',
      place,
      moves: [move('c3', 'd4'), move('c3', 'c4'), PASS],
    })
    expect(playsOver(view, 'white', 30)).toEqual(new Set(['c3d4']))
  })
})

// ---------------------------------------------------------------------------
// 3. the two exceptions, priced as exceptions
// ---------------------------------------------------------------------------

/** Neutral terms: one square gained, an enemy piece worth 2, our own worth 5. */
const TERMS: ContactTerms = {
  squareGain: 1,
  denial: 0,
  attackerValue: 5,
  attackerSquares: 0,
  revealCost: 3,
  winValue: 100,
  tradeAppetite: 1,
  valueOf: () => 2,
}

describe('a possible 軍旗 is a win, not a captured piece (§7④①)', () => {
  it('classifies it apart from an ordinary win and prices it at the win value', () => {
    expect(classifyContact('brigade', 'flag')).toBe('flag-win')
    expect(classifyContact('brigade', 'platoon')).toBe('win')
    // 工兵 is the weakest 兵種 that still beats the 軍旗 — and 排長 winning proves
    // it took a 工兵, never the flag, because that game would have ended (§1.2).
    expect(classifyContact('engineer', 'flag')).toBe('flag-win')

    expect(branchOdds('brigade', { flag: 1 })).toEqual({ win: 0, flagWin: 1, lose: 0, mutual: 0 })
    expect(contactEV('brigade', { flag: 1 }, TERMS)).toBe(TERMS.winValue)
    // The same contact against an ordinary weaker piece is worth the square plus
    // the piece minus the 翻明 (§4.3) — nothing like ending the game.
    expect(contactEV('brigade', { platoon: 1 }, TERMS)).toBe(1 + 2 - 3)
  })

  it('carries the flag mass linearly out of the win bucket', () => {
    const half = contactEV('brigade', { flag: 0.5, platoon: 0.5 }, TERMS)
    expect(half).toBeCloseTo(0.5 * 100 + 0.5 * (1 + 2 - 3), 10)
  })
})

describe('工兵 versus 爆裂物 is a win, not a 同歸於盡 (§5.4)', () => {
  it('wins for 工兵 and 軍旗, ties for everyone else', () => {
    expect(classifyContact('engineer', 'bomb')).toBe('win')
    expect(classifyContact('flag', 'bomb')).toBe('win')
    expect(classifyContact('brigade', 'bomb')).toBe('mutual')
    expect(classifyContact('commander', 'bomb')).toBe('mutual')
    // The other direction of the same immunity: the 爆裂物 attacks and loses
    // alone — 有煙無傷, the survivor untouched and on its square.
    expect(classifyContact('bomb', 'engineer')).toBe('lose')
    expect(classifyContact('bomb', 'brigade')).toBe('mutual')

    expect(branchOdds('engineer', { bomb: 1 })).toEqual({ win: 1, flagWin: 0, lose: 0, mutual: 0 })
    expect(branchOdds('brigade', { bomb: 1 })).toEqual({ win: 0, flagWin: 0, lose: 0, mutual: 1 })
  })

  it('charges no 翻明 for it — the one win in the game that publishes nothing', () => {
    expect(revealsOnWin('engineer', 'bomb')).toBe(false)
    expect(revealsOnWin('flag', 'bomb')).toBe(false)
    expect(revealsOnWin('brigade', 'platoon')).toBe(true)
    // Square plus piece, with the reveal cost NOT deducted (§5.4 / 附錄 A(c)).
    expect(contactEV('engineer', { bomb: 1 }, TERMS)).toBe(1 + 2)
    // …and a 旅團-level attacker on the same belief gets the trade instead: it
    // gives up its own value and takes the bomb's, and never enters the square.
    expect(contactEV('brigade', { bomb: 1 }, TERMS)).toBe(0 + 2 - 5)
  })

  it('sends the 工兵 at a piece it believes is a 爆裂物', () => {
    // A piece that has just fizzled is not something a ViewerState can be talked
    // into, so this scene makes the point the other way: our 工兵 against a 翻明
    // 爆裂物 on a 結算格. Any other 兵種 would trade itself for it; 工兵 evicts it
    // for free and takes the square (§5.4 攻方勝 → 工兵佔據目標格).
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-c2', square: sq('c3'), rank: 'engineer' },
        { id: 'b-d7', square: sq('d4'), rank: 'bomb', reveal: true },
      ],
      moves: [move('c3', 'd4'), move('c3', 'c4'), PASS],
    })
    expect(playsOver(view, 'white', 30)).toEqual(new Set(['c3d4']))
  })
})

// ---------------------------------------------------------------------------
// 4. 攻略 §3 — park, don't march
// ---------------------------------------------------------------------------

describe('it parks on income (攻略 §3)', () => {
  it('passes rather than step off a 結算格 for nothing', () => {
    // A rook on d4 with two ways to leave: onto another 結算格 (a swap, net zero)
    // and onto an empty file (a loss). A pass still settles (§7.1), so standing
    // still banks the square and every alternative is strictly worse.
    const view = scene({
      color: 'white',
      place: [{ id: 'w-a1', square: sq('d4'), rank: 'brigade' }],
      moves: [move('d4', 'd5'), move('d4', 'a4'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['pass']))
  })

  it('prices a 結算格 off X, the score and the rate — never off a constant', () => {
    const fresh = stateForViewer(deployedGame(), { kind: 'player', color: 'white' })
    const opening = economyOf(fresh, 'white')
    // Nobody is scoring yet, so nothing but the 停滯 fuse (§7④③, N) bounds the game.
    expect(opening.square).toBe(fresh.config.noProgressTurns)

    // Two squares held, 30 of 40 banked: five settlements left, so a square is
    // worth five points — not the thirty it was worth in the opening.
    const late = stateForViewer(deployedGame(), { kind: 'player', color: 'white' })
    late.score = { white: 30, black: 0.5 }
    late.pieces.find((p) => p.id === 'w-d2')!.square = sq('d4')
    late.pieces.find((p) => p.id === 'w-e2')!.square = sq('e4')
    const endgame = economyOf(late, 'white')
    expect(endgame.ourRate).toBe(2)
    expect(endgame.square).toBe(5)
    expect(endgame.square).toBeLessThan(opening.square)

    // And it collapses further when the OPPONENT is about to cross X: the game
    // ends when either side gets there (§7④②), however far we still have to go.
    const theirs = stateForViewer(deployedGame(), { kind: 'player', color: 'white' })
    theirs.score = { white: 0, black: 38.5 }
    theirs.pieces.find((p) => p.id === 'b-d7')!.square = sq('d5')
    expect(economyOf(theirs, 'white').square).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 5. the mixed strategy
// ---------------------------------------------------------------------------

describe('it mixes inside the epsilon band, and only inside it', () => {
  it('spreads over moves whose EV differs by less than the band', () => {
    // Nothing gains a square here, so every candidate is worth only its walk
    // towards one — a fraction of a 結算格, inside the band. A pure argmax would
    // publish one of them every time, and 「the bot advanced the c-pawn」 would be
    // an observation about which 兵種 it is holding.
    const view = scene({
      color: 'white',
      place: [],
      moves: [move('c2', 'c3'), move('c2', 'c4'), PASS],
    })
    const played = playsOver(view, 'white', 60)
    expect(played.size).toBeGreaterThan(1)
    // The band is 0.08 of a square and the walk is worth 0.05, so doing nothing
    // is inside it too — the policy is not merely breaking exact ties.
    expect(MIXING_BAND_SQUARES).toBeGreaterThan(0)
    expect(played.has('pass')).toBe(true)
  })

  it('never mixes in a move that is dominated by more than the band', () => {
    // The same walk, now against a move that takes a 結算格 outright: a whole
    // square against a twentieth of one. The band is not an excuse to play badly.
    const view = scene({
      color: 'white',
      place: [],
      moves: [move('d2', 'd4'), move('c2', 'c3'), move('a2', 'a3'), PASS],
    })
    expect(playsOver(view, 'white', 60)).toEqual(new Set(['d2d4']))
  })
})

// ---------------------------------------------------------------------------
// 6. determinism
// ---------------------------------------------------------------------------

describe('determinism, sampling included', () => {
  it('replays a seed byte for byte', () => {
    const run = (seed: number): GameOutcome =>
      playGame({ seed, white: beliefPolicy, black: beliefPolicy })
    const a = run(4242)
    const b = run(4242)
    expect(b.deployment).toEqual(a.deployment)
    expect(b.plyRecords).toEqual(a.plyRecords)
    expect(b.score).toEqual(a.score)
    expect(b.result).toEqual(a.result)
    expect(JSON.stringify(b.final)).toBe(JSON.stringify(a.final))
  })

  it('replays a mixed match, where the belief is sampled every ply', () => {
    const opts = { seed: 77, games: 6, white: beliefPolicy, black: randomPolicy, swapColors: true }
    expect(JSON.stringify(runMatch(opts))).toBe(JSON.stringify(runMatch(opts)))
  })

  it('produces a different game from a different seed — the stream is really threaded', () => {
    const a = playGame({ seed: 1, white: beliefPolicy, black: contestPolicy })
    const b = playGame({ seed: 2, white: beliefPolicy, black: contestPolicy })
    expect(JSON.stringify(b.plyRecords)).not.toBe(JSON.stringify(a.plyRecords))
  })

  it('makes the same move twice from the same position and seed', () => {
    const view = stateForViewer(deployedGame(9), { kind: 'player', color: 'white' })
    const first = moveToNotation(beliefPolicy.move(view, 'white', makeRng(5)))
    const second = moveToNotation(beliefPolicy.move(view, 'white', makeRng(5)))
    expect(second).toBe(first)
  })
})

// ---------------------------------------------------------------------------
// 佈署 (§9) and the arena at large
// ---------------------------------------------------------------------------

describe('it plays by the rules', () => {
  it('deploys a legal bijection onto whatever 數量表 the game was created with', () => {
    for (const config of [
      undefined,
      { distribution: DISTRIBUTION_SCOUTS },
      { scoringSquares: SCORING_WIDE_8 },
    ]) {
      const state = createGame('belief-deploy', { clockEnabled: false, ...config })
      for (let seed = 0; seed < 24; seed++) {
        for (const color of ['white', 'black'] as const) {
          const view = stateForViewer(state, { kind: 'player', color })
          const assignment = beliefPolicy.deploy(view, color, makeRng(seed))
          expect(validateAssignment(assignment, color, state), `${color} ${seed}`).toBeNull()
        }
      }
    }
  })

  it('does not deploy the same army every game', () => {
    // §9 makes the timeout fallback random because a fixed deployment 「等同公開
    // 該方全軍」. The same argument applies to a bot: a memorable army is a
    // published one.
    const state = createGame('belief-deploy', { clockEnabled: false })
    const view = stateForViewer(state, { kind: 'player', color: 'white' })
    const seen = new Set<string>()
    for (let seed = 0; seed < 24; seed++) {
      seen.add(JSON.stringify(beliefPolicy.deploy(view, 'white', makeRng(seed))))
    }
    expect(seen.size).toBeGreaterThan(4)
  })

  it('only ever plays a move from view.legalMoves, over a whole match', () => {
    // `playGame` throws on an illegal move, so 200 completed games IS the
    // assertion; this states it rather than leaving it implicit.
    for (const outcome of VS_CONTEST) {
      expect(outcome.plies).toBeGreaterThan(0)
      expect(outcome.result === null ? outcome.truncated : true).toBe(true)
    }
    expect(VS_CONTEST.filter((o) => o.truncated)).toHaveLength(0)
  })
})
