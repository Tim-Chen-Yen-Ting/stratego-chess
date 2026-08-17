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
 *   5. it WALKS to a 結算格 it does not hold, with the piece that can get there.
 *      This is the one that failed acceptance (notebook §10.3, 「持有的格子少
 *      19%」) and the one whose regression would be silent — a bot that wanders
 *      still plays legal, plausible-looking chess.
 *   6. it MIXES. A deterministic policy is itself an observable that leaks its
 *      own 兵種 across enough games; the epsilon band is the policy binding
 *      itself where 附錄 A binds only the rules. And it mixes over TIES: the band
 *      must never be wide enough to swallow a decision — see 5.
 *   7. a seed replays exactly, `beliefFor`'s sampling included.
 *   8. it notices that its own 軍旗 is being hunted (§5.3). Game 10 is the whole
 *      argument: 白方 39–35.5, one settlement from X, 軍旗 unmoved on d1, d-file
 *      empty, Black's rook on d5, and thirteen consecutive passes. Every other
 *      loss in this game is a bad trade; that one is the game (notebook §13.3).
 */

import { describe, expect, it } from 'vitest'
import {
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
  applyMove,
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
  ARRIVAL_WEIGHT,
  FLAG_FLIGHT_SHARE,
  FLAG_LOSS_WEIGHT,
  FLAG_THREAT_DECAY,
  FLAG_THREAT_HORIZON,
  MIXING_BAND_SQUARES,
  beliefNoFlagDefencePolicy,
  beliefPolicy,
  branchOdds,
  classifyContact,
  contactEV,
  economyOf,
  flagThreat,
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

/**
 * Put this side's 軍旗 on a named carrier, swapping ranks with wherever §9 dealt
 * it so the 數量表 still holds. The 軍旗's carrier is the whole subject of these
 * scenes — game 10's sat on the queen — and a random deployment will not oblige.
 */
function flagOn(view: ViewerState, color: Color, id: PieceId): ViewerState {
  const target = view.pieces.find((p) => p.id === id)
  if (!target) throw new Error(`no piece ${id}`)
  const holder = view.pieces.find((p) => p.color === color && p.rank === 'flag')
  if (!holder) throw new Error(`no 軍旗 for ${color}`)
  if (holder.id === id) return view
  holder.rank = target.rank
  target.rank = 'flag'
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
// 5. the walk — 攻略 §2, and the bug notebook §10.3 measured
// ---------------------------------------------------------------------------

/*
 * §10.3: 「它持有的格子少 19%」 against a bot with no valuation at all. The cause
 * was not the contact arithmetic — every EV weight in the file was swept and none
 * of them moved the result. It was that a 結算格 the policy did not already stand
 * on was priced as a TIE-BREAK: `APPROACH_WEIGHT` is a gradient, so every piece
 * that could take one step towards the centre scored identically, and the whole
 * signal was narrower than the mixing band, so the choice — including whether to
 * move at all — came out of the dice.
 *
 * These three tests are that bug, in the three shapes it had.
 */

describe('it walks the piece that can actually get there (攻略 §2)', () => {
  it('prefers a step taken close to the square over the same step taken far away', () => {
    // Two rooks on the fourth rank, both one step from making one step of
    // progress. g4–f4 ends ONE square from e4; a4–b4 ends TWO from d4. Identical
    // 「progress」, and under a pure gradient identical value — which is how the
    // policy used to shuffle the far piece while the near one stood still.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-a1', square: sq('a4') },
        { id: 'w-h1', square: sq('g4') },
      ],
      moves: [move('g4', 'f4'), move('a4', 'b4'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['g4f4']))
  })

  it('does not pass while an empty 結算格 is walkable', () => {
    // The measured failure, isolated: holding nothing, with d4 empty and a piece
    // two steps away, the old weights drew `pass` out of the band about half the
    // time. A pass settles (§7.1) — for zero, forever, which is the one thing
    // 攻略 §1 says never to accept.
    const view = scene({
      color: 'white',
      place: [{ id: 'w-a1', square: sq('a4') }],
      moves: [move('a4', 'b4'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['a4b4']))
  })

  it('keeps the band narrower than one step of the walk it has to decide', () => {
    // The structural statement of the same thing, so it cannot regress by
    // retuning either number alone. One step taken from two squares out is worth
    // ARRIVAL_WEIGHT × (1/2 − 1/3) of a 結算格; if the band is wider than that,
    // the arrival term decides nothing and the policy is a coin again.
    const oneStepIn = ARRIVAL_WEIGHT * (1 / 2 - 1 / 3)
    expect(MIXING_BAND_SQUARES).toBeLessThan(oneStepIn)
    expect(MIXING_BAND_SQUARES).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. the mixed strategy
// ---------------------------------------------------------------------------

describe('it mixes inside the epsilon band, and only inside it', () => {
  it('spreads over moves whose EV differs by less than the band', () => {
    // A genuine tie: two rooks mirrored about the centre file, each taking the
    // same step towards the nearest 結算格. Nothing distinguishes them, so a pure
    // argmax would publish one of them every time and 「the bot moved the a-rook」
    // would be an observation about which 兵種 it is holding.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-a1', square: sq('a4') },
        { id: 'w-h1', square: sq('h4') },
      ],
      moves: [move('a4', 'b4'), move('h4', 'g4'), PASS],
    })
    const played = playsOver(view, 'white', 60)
    expect(played).toEqual(new Set(['a4b4', 'h4g4']))
    // …and the band mixes TIES, not decisions: standing still is dominated by
    // more than one band and never enters the pool.
    expect(played.has('pass')).toBe(false)
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

  it('still mixes often enough over REAL positions to be a mixed strategy', () => {
    // The band was narrowed from 0.08 to 0.02 of a 結算格, which is a real
    // reduction in how much this policy hides, so this is the floor under it.
    // Hand-built scenes cannot answer the question — the leak 附錄 A is about is a
    // property of the positions the bot actually reaches, so these are replayed.
    let positions = 0
    let mixed = 0
    for (let game = 0; game < 8; game++) {
      const seed = 90210 + game
      let state = deployedGame(seed)
      const rng: Record<Color, ReturnType<typeof makeRng>> = {
        white: makeRng(deriveSeed(seed, 'move:white')),
        black: makeRng(deriveSeed(seed, 'move:black')),
      }
      while (state.status.kind === 'playing' && state.log.length < 60) {
        const color = state.toMove
        const view = stateForViewer(state, { kind: 'player', color })
        if (color === 'white') {
          const seen = new Set<string>()
          for (let s = 0; s < 8; s++) {
            seen.add(moveToNotation(beliefPolicy.move(view, 'white', makeRng(s))))
          }
          positions++
          if (seen.size > 1) mixed++
        }
        const policy = color === 'white' ? beliefPolicy : contestPolicy
        state = applyMove(state, policy.move(view, color, rng[color]))
      }
    }
    expect(positions).toBeGreaterThan(100)
    // Measured at the time of writing over 40 games: 38% of 中央四格 positions draw
    // from a pool of more than one move, and 8% are a forced pass. The bar is set
    // well under that — it is here to catch a collapse to argmax, not to pin a
    // number that legitimate retuning would move.
    expect(mixed / positions).toBeGreaterThan(0.15)
  })
})

// ---------------------------------------------------------------------------
// 8. 軍旗 defence — §5.3, and the game it cost (notebook §13)
// ---------------------------------------------------------------------------

/**
 * Game 10, ply 77, as White saw it.
 *
 *   h2 白兵 · g7 白車 · f6 黑馬(軍旗) · e4 白王 · d5 黑車 · d1 白后(軍旗)
 *   b3 白兵 · a2 黑兵 · a1 白車            白 39 – 黑 35.5, 白 one settlement from X
 *
 * Rebuilt from the pieces that mattered rather than emptied down to nine: a piece
 * removed while the game continues is public proof it was not the 軍旗 (§1.3), so
 * sweeping the board would hand the belief two dozen facts at once. What the real
 * position actually was, for this decision, is three things — the 軍旗 on d1, an
 * empty d-file, and a rook on d5 — and those are exact here.
 */
function gameTen(moves: Move[]): ViewerState {
  const view = scene({
    color: 'white',
    place: [
      { id: 'w-d2', square: sq('c3') }, // the d-file, empty for the whole game
      { id: 'w-e1', square: sq('e4') }, // the 結算格 白 was collecting on
      { id: 'b-a8', square: sq('d5') }, // 「全場唯一能直線衝到 d1 的棋子」
    ],
    moves,
  })
  flagOn(view, 'white', 'w-d1')
  view.score = { white: 39, black: 35.5 }
  return view
}

/** The three blocks and the one flight available in that position. */
const BLOCKS = ['b1d2', 'c1d2', 'e4d4']
const FLIGHT = 'd1e1'

/**
 * Ply 77's actual choice — nine pieces, and nothing on the board that gains.
 *
 * Every alternative here is a move 攻略 §3 refuses on its own: `e4d4` and `e4e5`
 * step off the 結算格 白 is being paid for without improving the holding, and both
 * 軍旗 moves gain nothing. So the park filter returns null for all four and `pass`
 * is the only move left with a score — which is precisely why the bot passed
 * thirteen times while a rook stared down the file at its 軍旗.
 *
 * Measured on this list: with the defence off the policy plays `pass` on 40 of 40
 * seeds. `e4d4` is the move that was there all along — it blocks the file AND
 * keeps the income, and it is the one the park filter was refusing.
 */
const GAME_TEN_ENDGAME: Move[] = [
  move('e4', 'd4'),
  move('e4', 'e5'),
  move('d1', 'e1'),
  move('d1', 'd2'),
  PASS,
]

/** The same position with the pieces §9 had not yet moved, so blocks compete. */
const GAME_TEN_MOVES: Move[] = [
  move('e4', 'd4'), // king: blocks the file AND keeps the income
  move('e4', 'e5'), // king: swaps one 結算格 for another, blocks nothing
  move('b1', 'd2'), // knight: blocks
  move('c1', 'd2'), // bishop: blocks
  move('d1', 'e1'), // 軍旗: off the file
  move('d1', 'd2'), // 軍旗: still on the file — a move that answers nothing
  move('g1', 'f3'),
  move('h2', 'h4'),
  PASS,
]

describe('it asks whether anything can reach its 軍旗 (§5.3)', () => {
  it('reads the game-10 line off the carrier layer alone', () => {
    const report = flagThreat(gameTen(GAME_TEN_MOVES), 'white')
    expect(report.flagSquare).toBe(sq('d1'))
    expect(report.immediate).toBe(true)
    expect(report.plies).toBe(1)
    expect(report.nearest?.from).toBe(sq('d5'))
    expect(report.nearest?.carrier).toBe('rook')
    // The blocking squares, which is the other half of what a report is FOR:
    // 「任何一手防守都能贏：把某顆棋放到 d2」.
    expect(report.nearest?.line).toEqual([sq('d4'), sq('d3'), sq('d2')])
  })

  it('does NOT pass — the move that lost the game', () => {
    // 攻略 §3 refuses every one of the alternatives, which is how `pass` won the
    // comparison thirteen times in a row. §5.3 has to beat 攻略 §3 here, and the
    // move it reaches for is the one that satisfies both: the king steps to d4,
    // blocking the file and standing on a 結算格 the whole time.
    const played = playsOver(gameTen(GAME_TEN_ENDGAME), 'white', 40)
    expect(played.has('pass')).toBe(false)
    expect(played.has('d1d2')).toBe(false) // fleeing ALONG the line answers nothing
    expect(played).toEqual(new Set(['e4d4']))
  })

  it('leaves every other position exactly where it was', () => {
    // The park filter is overridden by a live threat and by nothing else: strip
    // the rook off d5 and the same four moves are refused again, `pass` included
    // in the pool as the only thing that scores. If this ever failed, the defence
    // would be buying its win rate by making the bot restless — which is the
    // §11.4 bug with a new name.
    const quiet = gameTen(GAME_TEN_ENDGAME)
    quiet.pieces.find((p) => p.id === 'b-a8')!.square = sq('a8')
    expect(flagThreat(quiet, 'white').immediate).toBe(false)
    expect(playsOver(quiet, 'white', 40)).toEqual(new Set(['pass']))
  })

  it('prefers a block to running the 軍旗 — 附錄 A at the policy layer', () => {
    // Both answers are on the board. 「A bot that only ever moves a piece when
    // that piece is the 軍旗 has announced which piece it is」, so the block has to
    // win whenever there is one, and the flight has to stay available for when
    // there is not (the next test).
    const played = playsOver(gameTen(GAME_TEN_MOVES), 'white', 40)
    expect(played.has(FLIGHT)).toBe(false)
    expect([...played].every((m) => BLOCKS.includes(m))).toBe(true)
    // …and it does not always send the same piece, which is the point of it.
    expect(played.size).toBeGreaterThan(1)
  })

  it('runs the 軍旗 when running is the only answer', () => {
    // Same position with every blocker taken away: now nothing can step onto the
    // d-file, and 「離開」 is what is left. It has to be worth playing, or the
    // discount that makes blocking cheaper has quietly banned the flight too.
    const played = playsOver(gameTen([move('d1', 'e1'), move('h2', 'h4'), PASS]), 'white', 40)
    expect(played).toEqual(new Set([FLIGHT]))
  })

  it('replays the same defence from the same seed', () => {
    const view = gameTen(GAME_TEN_MOVES)
    const once = moveToNotation(beliefPolicy.move(view, 'white', makeRng(11)))
    const twice = moveToNotation(beliefPolicy.move(view, 'white', makeRng(11)))
    expect(twice).toBe(once)
  })
})

describe('an immediate threat outranks income (§5.3 vs 攻略 §1)', () => {
  /** 軍旗 on d1, rook on d6 with the file clear, and a free 結算格 on e5. */
  function hunted(moves: Move[]): ViewerState {
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-d2', square: sq('c3') }, // clear the d-file
        { id: 'w-a1', square: sq('a5') }, // a rook one slide from an empty e5
        { id: 'b-a8', square: sq('d6') },
      ],
      moves,
    })
    return flagOn(view, 'white', 'w-d1')
  }

  it('blocks instead of taking a free 結算格', () => {
    // 攻略 §1 says income is a rate and a free 結算格 is the best thing on most
    // boards. §5.3 says the 軍旗 leaving is the end of the game. The whole fix is
    // that the second one wins: `FLAG_LOSS_WEIGHT × winValue` against one square.
    const view = hunted([move('a5', 'e5'), move('b1', 'd2'), move('h2', 'h4'), PASS])
    expect(flagThreat(view, 'white').immediate).toBe(true)
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['b1d2']))
  })

  it('will not grab a 結算格 with the hunted 軍旗 itself', () => {
    // d5 is a 結算格 and the 軍旗 can reach it — and the rook on d6 takes it there.
    // A gain is not a defence, and this is the move a bot that only priced income
    // would find.
    const view = hunted([move('d1', 'd5'), move('b1', 'd2'), PASS])
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['b1d2']))
  })

  it('still refuses to move the 軍旗 onto an occupied square, hunted or not', () => {
    // 攻略 §9 / §5.3 stay absolute. The 軍旗 could take the knight on c1 and leave
    // the file in one move; taking it removes the 軍旗 from the board (§4.1 puts
    // the winner on the target square) and 「軍旗以任何方式離開棋盤」 does not care
    // that it won.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-d2', square: sq('c3') },
        { id: 'w-c1', square: sq('b5') }, // move our own bishop out of c1
        { id: 'b-b8', square: sq('c1') }, // …and stand an enemy knight there
        { id: 'b-a8', square: sq('d5') },
      ],
      moves: [move('d1', 'c1'), move('b1', 'd2'), move('h2', 'h4'), PASS],
    })
    flagOn(view, 'white', 'w-d1')
    const played = playsOver(view, 'white', 40)
    expect(played.has('d1c1')).toBe(false)
    expect(played).toEqual(new Set(['b1d2']))
  })
})

describe('a pawn threat is not the same shape as a pawn move (§3, §4.2)', () => {
  /** 軍旗 on f4, and one black pawn placed by the caller. */
  function flagOnF4(pawnTo: string): ViewerState {
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-f2', square: sq('f4') },
        { id: 'b-f7', square: sq(pawnTo) },
      ],
      moves: [PASS],
    })
    return flagOn(view, 'white', 'w-f2')
  }

  it('ignores the pawn standing directly in front of the 軍旗', () => {
    // A pawn captures diagonally and pushes forward, and the two are different
    // squares. The pawn on f5 cannot touch f4 — it cannot even move, because its
    // push is blocked by the piece it is supposedly threatening.
    const report = flagThreat(flagOnF4('f5'), 'white')
    expect(report.immediate).toBe(false)
    expect(report.threats.some((t) => t.from === sq('f5'))).toBe(false)
    // What IS a threat is every pawn that can step onto the diagonal: e7–e5 and
    // g7–g5 both bear on f4 the move after next.
    expect(report.threats.filter((t) => t.plies === 2).map((t) => t.from))
      .toEqual(expect.arrayContaining([sq('e7'), sq('g7')]))
  })

  it('sees the pawn on the diagonal, and knows it cannot be blocked', () => {
    const report = flagThreat(flagOnF4('e5'), 'white')
    expect(report.immediate).toBe(true)
    expect(report.nearest?.from).toBe(sq('e5'))
    expect(report.nearest?.carrier).toBe('pawn')
    expect(report.nearest?.line).toEqual([]) // nothing to interpose against a pawn
  })

  it('refuses the double step that hands the 軍旗 to an en passant (§4.2)', () => {
    // The 軍旗 rides the d-pawn and d4 is a 結算格 — the best move on the board by
    // every other term in the file. A black pawn on c4 takes it by landing on d3,
    // which is neither the square the 軍旗 came from nor the one it went to, and a
    // destination-square test misses it entirely.
    const view = scene({
      color: 'white',
      place: [{ id: 'b-c7', square: sq('c4') }],
      moves: [move('d2', 'd4'), move('d2', 'd3'), move('e2', 'e4'), PASS],
    })
    flagOn(view, 'white', 'w-d2')
    const played = playsOver(view, 'white', 40)
    expect(played.has('d2d4')).toBe(false)
    expect(played.has('d2d3')).toBe(false) // and the ordinary diagonal, too
    expect(played).toEqual(new Set(['e2e4']))
  })
})

describe('it is not paranoid about a threat it has time to answer', () => {
  /**
   * The 軍旗 on d1 behind its own pawns on d2 and d3, with Black's rook on h5.
   *
   * The rook's shortest route is h5xh2, h2xe2, e2xd2, d2xd1 — FOUR moves, each of
   * them a contact it has to win. Nothing about this position is urgent, and a bot
   * that reacted to it would be reacting to the shape of a chessboard: past two
   * moves every slider on an open board can reach every square, so 「three away」
   * is not a threat, it is a description (see FLAG_THREAT_HORIZON).
   */
  function distant(moves: Move[]): ViewerState {
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-c2', square: sq('d3') }, // a second body in front of the 軍旗
        { id: 'b-a8', square: sq('h5') },
      ],
      moves,
    })
    return flagOn(view, 'white', 'w-d1')
  }

  it('reports nothing at all — it is outside the horizon', () => {
    const report = flagThreat(distant([PASS]), 'white')
    expect(report.flagSquare).toBe(sq('d1'))
    expect(report.threats).toEqual([])
    expect(report.plies).toBe(Number.POSITIVE_INFINITY)
  })

  it('does not run the 軍旗, and takes the 結算格 instead', () => {
    const view = distant([
      move('e2', 'e4'), // a free 結算格
      move('d1', 'c2'), // the 軍旗, off down the diagonal
      move('d1', 'b3'),
      move('d1', 'a4'),
      move('g1', 'f3'),
      PASS,
    ])
    const played = playsOver(view, 'white', 40)
    expect([...played].some((m) => m.startsWith('d1'))).toBe(false)
    expect(played).toEqual(new Set(['e2e4']))
  })

  it('keeps a non-immediate threat worth less than one 結算格, structurally', () => {
    // The two halves of 「price it at everything remaining, but do not be
    // paranoid」, as inequalities rather than as hopes. `winValue` is at least
    // `X − our score` and at least one 結算格, so:
    //   immediate    = FLAG_LOSS_WEIGHT × winValue     ≥ the whole remaining gap
    //   two plies    = that × FLAG_THREAT_DECAY        < one 結算格
    // The second is currently true by a mile, because the decay was measured at
    // 1800 games a cell and came out at zero — every positive value tested cost
    // two to four points of win rate and saved no 軍旗. This test is the fence
    // around that result: it does not forbid a future retune, it forbids one that
    // makes a threat we have a move to answer worth more than the income we would
    // give up answering it early.
    expect(FLAG_LOSS_WEIGHT).toBeGreaterThanOrEqual(1)
    expect(FLAG_THREAT_DECAY).toBeGreaterThanOrEqual(0)
    expect(FLAG_LOSS_WEIGHT * FLAG_THREAT_DECAY).toBeLessThan(1)
    // …and a flight is worth strictly less than the block that achieves the same
    // thing, but strictly more than nothing, or one of the two answers is dead.
    expect(FLAG_FLIGHT_SHARE).toBeGreaterThan(0)
    expect(FLAG_FLIGHT_SHARE).toBeLessThan(1)
    // The report has to tell 「takes it next move」 from 「one move to line up」 even
    // when the second is priced at nothing: the difference between them is exactly
    // what a block achieves, and a horizon of one could not see a block work.
    expect(FLAG_THREAT_HORIZON).toBeGreaterThanOrEqual(2)
  })
})

describe('and it holds up over games rather than over scenes', () => {
  it('loses far fewer 軍旗 than the same policy with the defence off', () => {
    // The scenes above are hand-built, so they prove the term fires where it was
    // aimed and nothing about how often it is aimed correctly. This is the A/B:
    // the identical file against itself with `{ flagDefence: false }`, one
    // variable, paired seeds, 側翼八格 because that is where the undefended policy
    // bleeds 軍旗 fastest (24 of 600 there against 9 of 600 on 中央四格).
    //
    // Measured at 1800 games a cell: 7 旗負 defended against 64 undefended
    // (中央四格 7 against 35), with the win rate at 50.8% ±1.2 — 「not worse」, which
    // is the honest reading, rather than 「better」. This test is the floor under
    // the mechanism, not the win rate: it asserts the 軍旗 losses really do go, and
    // that the games are real games and not 300 truncations.
    const summary = runMatch({
      seed: 20260816,
      games: 200,
      white: beliefPolicy,
      black: beliefNoFlagDefencePolicy,
      swapColors: true,
      config: { scoringSquares: SCORING_WIDE_8 },
      keepGames: true,
    })
    expect(summary.games).toBe(400)
    expect(summary.truncated).toBe(0)

    let defended = 0
    let undefended = 0
    for (const o of summary.outcomes ?? []) {
      if (o.result?.kind !== 'flag') continue
      const defendedSeat = o.policies.white === beliefPolicy.name ? 'white' : 'black'
      if (o.result.winner === defendedSeat) undefended++
      else defended++
    }
    // Measured on this seed: 0 against 11. The bars are set well inside that —
    // they are here to catch the defence going away, not to pin two counts.
    expect(undefended).toBeGreaterThan(8) // the defect is real and reproduces
    expect(defended * 3).toBeLessThan(undefended) // and most of it goes away
  })
})

// ---------------------------------------------------------------------------
// 7. determinism
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
