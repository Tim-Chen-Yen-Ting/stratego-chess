/**
 * What has to be true about `belief` before any number it produces is worth
 * reading.
 *
 * The policy's whole claim is that it prices a contact instead of guessing at
 * it, so the tests are about the PRICE, not about the moves it happens to like:
 *
 *   1. it never crashes the 軍旗 into an occupied square (攻略 §9). This is not
 *      "a bad move" — §5.3 and §7.5① make it a resignation, and a policy that
 *      does it occasionally would show up in the arena as a mysterious 奪旗 rate.
 *   2. it attacks what the belief says is weaker and declines what it says is
 *      stronger. Without both, the belief is decoration.
 *   3. the two 兵種 exceptions are priced as exceptions: a possible 軍旗 is a WIN
 *      (§7.5①, the game ends — it is not a captured piece), and a 工兵 hitting a
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
  ALL_RANKS,
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
import type { RankBelief } from '../src/belief.js'
import { contestPolicy } from '../src/policies/contest.js'
import { randomPolicy } from '../src/policies/random.js'
import {
  APPROACH_WEIGHT,
  ARRIVAL_WEIGHT,
  FLAG_FLIGHT_SHARE,
  FLAG_LOSS_WEIGHT,
  FLAG_PARK_HORIZON,
  FLAG_STEP_COST,
  FLAG_THREAT_HORIZON,
  INFO_WEIGHT,
  MIXING_BAND_SQUARES,
  MOBILITY_ARRIVAL_WEIGHT,
  MOBILITY_WEIGHT,
  REPLY_WEIGHT,
  RESTLESSNESS_COST,
  beliefNoFlagDefencePolicy,
  beliefPolicy,
  branchOdds,
  classifyContact,
  contactEV,
  economyOf,
  flagThreat,
  makeBeliefPolicy,
  revealsOnWin,
} from '../src/policies/belief.js'
import { contactOddsBetween, replyRisk, squareSafety } from '../src/lookahead.js'
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

/** A belief that has already made up its mind, for the reply tests. */
const RANK_CERTAIN_COMMANDER: RankBelief = Object.freeze(
  Object.fromEntries(ALL_RANKS.map((r) => [r, r === 'commander' ? 1 : 0])) as Record<Rank, number>,
)
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
const VS_CONTEST: GameOutcome[] = await (async () => {
  const summary = await runMatch({
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
// 1. the 軍旗 never crashes into anything — 攻略 §9, §5.3, §7.5①
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
    // §7.5① settles it before any EV is computed: the 軍旗 leaving the board loses
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
    // because winning ends the game (§7.5①) rather than winning a piece.
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

describe('a possible 軍旗 is a win, not a captured piece (§7.5①)', () => {
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

describe('§7.3 吃子得分 priced into contactEV — additive, off the WINNER’s own rank', () => {
  // captureScoreK=3 (not 1) so a direction mistake can't hide behind k=1's
  // multiply-by-one; fizzleBonus=7, not a multiple of 3 × any RANK_ORDER, so a
  // fizzle payment can never be mistaken for a decisive one or vice versa —
  // same discipline capturescore.test.ts uses in packages/rules.
  const SCORED: ContactTerms = { ...TERMS, captureScoreK: 3, fizzleBonus: 7 }

  it('adds k × the WINNER’s (attacker’s) own rank on an ordinary win — not the target’s', () => {
    // commander (RANK_ORDER 1) beating a brigade — a legal win, 1 < 4: k×1 on
    // top of the existing square+value-reveal terms. If this priced off the
    // TARGET (brigade, 4) instead, it would be 12, not 3 — a direction bug
    // this pins immediately.
    expect(contactEV('commander', { brigade: 1 }, SCORED)).toBe(1 + 2 - 3 + 3 * 1)
    // platoon (RANK_ORDER 8) beating an engineer (9) — the only ordinary win a
    // platoon can ever have (§2 一律大吃小; a platoon loses to everything else
    // and only 軍旗 is weaker still, which is 'flag-win', not 'win'): k×8. Same
    // shape of win, far bigger payout — §7.3 pays the winner's own rank, not
    // the margin of victory, and a weak winner really does bank more.
    expect(contactEV('platoon', { engineer: 1 }, SCORED)).toBe(1 + 2 - 3 + 3 * 8)
  })

  it('subtracts k × THEIR own rank on an ordinary loss — the mirror, not a copy', () => {
    // We (brigade, 4) lose to a commander (1) — the strongest possible winner:
    // they bank k×1, which costs us that much.
    expect(contactEV('brigade', { commander: 1 }, SCORED)).toBe(-(5 + 0 + 3 * 1))
    // We (brigade, 4) lose to a division (3) — the WEAKEST piece that can
    // still beat a brigade (3 < 4, and nothing between them exists): they bank
    // k×3, costing us more than losing to the commander above despite division
    // being the "closer" fight — losing to a near-equal is the expensive way
    // to lose, exactly as §7.3 intends.
    expect(contactEV('brigade', { division: 1 }, SCORED)).toBe(-(5 + 0 + 3 * 3))
  })

  it('pays the flat fizzle bonus on a win, never k × rank — the bomb has no 階級', () => {
    // 工兵 beating a 爆裂物 is 'win' with rank==='bomb': flat fizzleBonus, and
    // 附錄 A(a) requires this NOT depend on which bomb-immune piece won.
    expect(contactEV('engineer', { bomb: 1 }, SCORED)).toBe(1 + 2 + 7)
    expect(contactEV('flag', { bomb: 1 }, SCORED)).toBe(1 + 2 + 7)
  })

  it('subtracts the flat fizzle bonus on a fizzle-LOSS, never k × rank', () => {
    // Our own 爆裂物 attacks their 工兵 and loses (§5.4) — the mirror of the win
    // case above. Costs us the flat bonus, not k × engineer's RANK_ORDER (9).
    expect(contactEV('bomb', { engineer: 1 }, SCORED)).toBe(-(5 + 0 + 7))
    expect(contactEV('bomb', { flag: 1 }, SCORED)).toBe(-(5 + 0 + 7))
  })

  it('adds nothing on 同歸於盡 — 附錄 A(d) pays both sides zero, not a scaled amount', () => {
    // brigade vs brigade: equal rank, ordinary mutual destruction.
    expect(contactEV('brigade', { brigade: 1 }, SCORED))
      .toBe(0 - 0 + 1 * 2 - 5) // unchanged from the k=0 formula — no capture term
    // A live k/fizzle must not leak into ANY mutual-destruction shape: bomb vs
    // an ordinary rank prices identically whether k is 0 or 3.
    expect(contactEV('bomb', { brigade: 1 }, SCORED)).toBe(contactEV('bomb', { brigade: 1 }, TERMS))
  })

  it('adds nothing on a 軍旗 win either — winValue already dwarfs it', () => {
    expect(contactEV('brigade', { flag: 1 }, SCORED)).toBe(SCORED.winValue)
  })

  it('is exactly the k=0 formula when captureScoreK/fizzleBonus are omitted or zero', () => {
    const explicitZero: ContactTerms = { ...TERMS, captureScoreK: 0, fizzleBonus: 0 }
    for (const [attacker, probs] of [
      ['commander', { platoon: 1 }],
      ['platoon', { commander: 1 }],
      ['brigade', { commander: 1 }],
      ['engineer', { bomb: 1 }],
      ['bomb', { engineer: 1 }],
      ['brigade', { brigade: 1 }],
    ] as const) {
      expect(contactEV(attacker, probs, explicitZero)).toBe(contactEV(attacker, probs, TERMS))
    }
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
    // Nobody is scoring yet, so nothing but the 停滯 fuse (§7.5③, N) bounds the game.
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
    // ends when either side gets there (§7.5②), however far we still have to go.
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
    //
    // GAME COUNT SHRUNK AND BUDGET MADE EXPLICIT, 2026-08-18: this had NO
    // explicit timeout — it rode vitest's 5000ms global default, unlike its two
    // siblings below which both carry an explicit 60_000ms. That default is
    // clearly an oversight rather than a decision: measured warm (as part of a
    // full-file run) this test cost 2305ms at games=8/151 positions, but run in
    // isolation under whatever made this file intermittently slow this session
    // it did not finish 151 positions inside 5000ms at all. `games: 8` is
    // trimmed to 6 (deterministic per-game position counts on this seed:
    // 18,18,16,20,21,24 → 117, still clearing the `positions > 100` floor below
    // with margin), and the budget is now an explicit number sized to the
    // observed worst case rather than an accidental tight one.
    let positions = 0
    let mixed = 0
    for (let game = 0; game < 6; game++) {
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
  }, 20_000)
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
    expect(report.threats).toHaveLength(1)
    expect(report.nearest?.from).toBe(sq('d5'))
    expect(report.nearest?.carrier).toBe('rook')
    expect(report.nearest?.enPassant).toBe(false)
    // …and the report is the ENGINE's answer, not a private one: the same rook
    // is in `carrierMoves`' list of Black replies, on the same square.
    expect(
      squareSafety(gameTen(GAME_TEN_MOVES), 'white', () => RANK_CERTAIN_COMMANDER, sq('d1'), 1)
        .attackers.map((a) => a.from),
    ).toEqual([sq('d5')])
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
    // Nor is it a threat one move later. e7–e5 and g7–g5 would each bear on f4,
    // and the horizon is deliberately one: §14.1 measured pre-emption at 1800
    // games a cell and found it saved no 軍旗 and cost two to four points.
    expect(report.threats).toEqual([])
  })

  it('sees the pawn on the diagonal, and knows it cannot be blocked', () => {
    const report = flagThreat(flagOnF4('e5'), 'white')
    expect(report.immediate).toBe(true)
    expect(report.nearest?.from).toBe(sq('e5'))
    expect(report.nearest?.carrier).toBe('pawn')
    expect(report.threats).toHaveLength(1)
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
    expect(report.immediate).toBe(false)
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

  it('keeps the weights in the order the measurements put them', () => {
    // The two halves of 「price it at everything remaining, but do not be
    // paranoid」, as inequalities rather than as hopes. `winValue` is at least
    // `X − our score` and at least one 結算格, so an immediate threat is worth
    // `FLAG_LOSS_WEIGHT × winValue` — the whole remaining gap — and a threat we
    // have a move to answer is worth NOTHING, which is not a simplification: the
    // decay was measured at 1800 games a cell and every positive value tested
    // cost two to four points of win rate and saved no 軍旗 (notebook §14.1). The
    // horizon is now one because that is the only depth the result supports.
    expect(FLAG_LOSS_WEIGHT).toBeGreaterThanOrEqual(1)
    expect(FLAG_THREAT_HORIZON).toBe(1)
    // …and a flight is worth strictly less than the block that achieves the same
    // thing, but strictly more than nothing, or one of the two answers is dead.
    expect(FLAG_FLIGHT_SHARE).toBeGreaterThan(0)
    expect(FLAG_FLIGHT_SHARE).toBeLessThan(1)
    // 軍旗 income (§15.1) has to cost more than an idle shuffle and less than a
    // 結算格, or the 軍旗 either never walks or walks for free. That ordering IS
    // the doctrine: it goes when it is the piece best placed to go, and loses the
    // argument to any other piece that is equally well placed.
    expect(FLAG_STEP_COST).toBeGreaterThan(RESTLESSNESS_COST)
    expect(FLAG_STEP_COST).toBeLessThan(1)
    // And every one of them has to be bigger than the band it competes inside,
    // or the dice decide it — notebook §11.4, the mistake this file has made
    // twice and is not going to make a third time.
    expect(MIXING_BAND_SQUARES).toBeLessThan(FLAG_STEP_COST)
    expect(MIXING_BAND_SQUARES).toBeLessThan(REPLY_WEIGHT)
  })
})

describe('and it holds up over games rather than over scenes', () => {
  it('loses far fewer 軍旗 than the same policy with the defence off', async () => {
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
    //
    // GAME COUNT AND FLOOR, SHRUNK 2026-08-18: this was `games: 200` (400 total)
    // asserting `undefended > 8`, at ~24s warm and up to ~105s under whatever made
    // this file's tests intermittently blow their timeouts (see notebook — same
    // code, same seed, 70s-to-280s swings on an idle machine, cause unidentified).
    // 「flag losses go away without the defence」 is a floor claim, not a rate
    // pin, so it does not need 1800-games precision to hold — it needs enough
    // volume that the rare event still shows up with margin. Checked directly
    // against this exact seed rather than estimated from a rate (the harness is
    // fully deterministic, so a smaller game count is not a smaller SAMPLE of the
    // same distribution, it is a different, fixed set of games): games=120 here
    // reproduces 6 undefended / 0 defended in ~7.7s of raw compute, so the floor
    // moves from 8 to 2 — same margin logic as the `defended * 3 <` line below,
    // just resized to the smaller count.
    const summary = await runMatch({
      seed: 20260816,
      games: 120,
      white: beliefPolicy,
      black: beliefNoFlagDefencePolicy,
      swapColors: true,
      config: { scoringSquares: SCORING_WIDE_8 },
      keepGames: true,
    })
    expect(summary.games).toBe(240)
    expect(summary.truncated).toBe(0)

    let defended = 0
    let undefended = 0
    for (const o of summary.outcomes ?? []) {
      if (o.result?.kind !== 'flag') continue
      const defendedSeat = o.policies.white === beliefPolicy.name ? 'white' : 'black'
      if (o.result.winner === defendedSeat) undefended++
      else defended++
    }
    // Measured on this seed at games=120: 0 against 6. The bars are set well
    // inside that — they are here to catch the defence going away, not to pin
    // two counts.
    expect(undefended).toBeGreaterThan(2) // the defect is real and reproduces
    expect(defended * 3).toBeLessThan(undefended) // and most of it goes away
  }, 60_000) // budget UNCHANGED though the raw cost dropped ~3x — the point of
  // the smaller game count is a bigger margin under this budget, not a smaller one
})

// ---------------------------------------------------------------------------
// 9. the reply — a square taken and lost straight back (CHANGE 1)
// ---------------------------------------------------------------------------

describe('it prices the answer to the move it is about to play', () => {
  it('reads survival off the engine, both §5.4 exceptions included', () => {
    // The half of the reply this policy consumes: P(our piece is still standing).
    // Written against `lookahead.ts`'s own primitive rather than a private one,
    // because a second combat table would disagree with the first exactly on the
    // §5.4 cases that decide whether a 軍旗 may hold a 結算格 at all.
    const holds = (mine: Rank, theirs: Partial<Record<Rank, number>>): number =>
      1 - contactOddsBetween({ [mine]: 1 }, theirs).mineLost

    // A 排長 (階級 8) attacked by something that is certainly a 司令 does not
    // survive; attacked by something that is certainly a 工兵 (階級 9) it does.
    expect(holds('platoon', { commander: 1 })).toBe(0)
    expect(holds('platoon', { engineer: 1 })).toBe(1)
    // 同階 takes both (§4.1 淨空), so the square is not HELD either — the
    // distinction a bare 階級 comparison would miss.
    expect(holds('platoon', { platoon: 1 })).toBe(0)
    // §5.4, both directions: a 爆裂物 takes anything with it EXCEPT 工兵 and 軍旗,
    // which survive untouched. That is the one attack a 軍旗 walks away from, and
    // it is the second-order argument for a 軍旗 on a 結算格 (§4.5b's, restated).
    expect(holds('brigade', { bomb: 1 })).toBe(0)
    expect(holds('engineer', { bomb: 1 })).toBe(1)
    expect(holds('flag', { bomb: 1 })).toBe(1)
    // …and nothing else: 階級 10 is the floor, so every other contact takes it.
    expect(holds('flag', { platoon: 1 })).toBe(0)
    // A split belief is priced as one, not rounded to whichever side is likelier.
    expect(holds('platoon', { commander: 0.5, engineer: 0.5 })).toBeCloseTo(0.5, 10)
  })

  /**
   * One white knight on c3, two empty 結算格 one hop away, and exactly one thing
   * separating them: which of the two a 翻明 司令 can answer.
   *
   * Everything else is held equal on purpose. Both destinations are empty, so
   * neither move is a contact; both are the same 結算格 distance from c3, so
   * `approachBonus` and `ARRIVAL_WEIGHT` give them the same number; both gain the
   * same single square, so `econ.square` cancels. The ONLY term that can tell
   * them apart is the reply, which is what makes this a test of the reply rather
   * than of the position.
   *
   * b4 and c5 are the two squares a knight can stand on to cover d5 and a4
   * respectively without covering the other, and both are empty in the §9 layout.
   */
  function twoSquares(commanderAt: string): ViewerState {
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-b1', square: sq('c3') },
        { id: 'b-b8', square: sq(commanderAt), rank: 'commander', reveal: true },
      ],
      moves: [move('c3', 'a4'), move('c3', 'd5'), PASS],
      config: { scoringSquares: SCORING_WIDE_8 },
    })
    // The 軍旗 somewhere neither knight square bears on, so §5.3 stays out of it.
    return flagOn(view, 'white', 'w-h1')
  }

  it('takes the 結算格 the 司令 cannot answer, and not the one it can', () => {
    const answers = (view: ViewerState, from: string, to: string): Square[] =>
      replyRisk(view, 'white', () => RANK_CERTAIN_COMMANDER, move(from, to), { gate: 'all' })
        .attackers.map((a) => a.from)

    const coversD5 = twoSquares('b4')
    expect(answers(coversD5, 'c3', 'd5')).toEqual([sq('b4')])
    expect(answers(coversD5, 'c3', 'a4')).toEqual([])
    expect(playsOver(coversD5, 'white', 40)).toEqual(new Set(['c3a4']))

    // The mirror image. Same knight, same two squares, same everything — the
    // 司令 stands on c5 instead of b4, and the answer inverts.
    const coversA4 = twoSquares('c5')
    expect(answers(coversA4, 'c3', 'a4')).toEqual([sq('c5')])
    expect(answers(coversA4, 'c3', 'd5')).toEqual([])
    expect(playsOver(coversA4, 'white', 40)).toEqual(new Set(['c3d5']))
  })

  it('is the reply that decides it, and nothing else in the file', () => {
    // The same two positions with `{ replyAware: false }`. Without the term the
    // policy cannot tell the squares apart at all, so it mixes across both — which
    // is the proof that the discrimination above came from CHANGE 1 rather than
    // from some accident of geometry that would have chosen a4 anyway.
    const off = makeBeliefPolicy('off', { replyAware: false })
    const played = new Set<string>()
    for (const at of ['b4', 'c5']) {
      const view = twoSquares(at)
      for (let seed = 0; seed < 40; seed++) {
        played.add(moveToNotation(off.move(view, 'white', makeRng(seed))))
      }
    }
    expect(played).toEqual(new Set(['c3a4', 'c3d5']))
  })

  it('costs exactly nothing when nothing can answer', () => {
    // The term is a COST on the piece being committed, never a discount on the
    // square, so a move the opponent cannot reply to is scored byte for byte as
    // it was before the change existed. That is the whole reason the change did
    // not turn into caution: see REPLY_WEIGHT for the version that did.
    const view = twoSquares('h6') // covers neither
    const off = makeBeliefPolicy('off', { replyAware: false })
    for (let seed = 0; seed < 20; seed++) {
      expect(moveToNotation(beliefPolicy.move(view, 'white', makeRng(seed))))
        .toBe(moveToNotation(off.move(view, 'white', makeRng(seed))))
    }
  })

  it('asks about the position the move PRODUCES, not the one it is played from', () => {
    const view = twoSquares('b4')
    const certainly = (): RankBelief => RANK_CERTAIN_COMMANDER
    const risk = replyRisk(view, 'white', certainly, move('c3', 'd5'), { gate: 'all' })
    expect(risk.attackers.map((a) => a.from)).toEqual([sq('b4')])
    expect(risk.pHoldsAfterReply).toBe(0)
    // The knight has ALREADY left c3 in the position being asked about, which is
    // the difference between a lookahead and a description of the present.
    expect(risk.attackers.every((a) => a.from !== sq('c3'))).toBe(true)
    // And a square nothing bears on comes back untouched, with an empty list —
    // the caller distinguishes 「they cannot」 from 「they probably lose」.
    const safe = replyRisk(view, 'white', certainly, move('c3', 'a4'), { gate: 'all' })
    expect(safe.attackers).toEqual([])
    expect(safe.pHoldsAfterReply).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 10. the 軍旗 collects rent (CHANGE 2, notebook §15.1)
// ---------------------------------------------------------------------------

describe('the 軍旗 is an income candidate, at a price (§7.1, notebook §15.1)', () => {
  /**
   * Game 11's shape, and it is the §9 opening position almost untouched.
   *
   * 「白方的軍旗主動走進敵陣，停在對手的計分格上收錢」 — a knight-carried 軍旗 went
   * `b1 → c3 → d5` on move 27 and never moved again, banking eleven settlements
   * off a 結算格 in BLACK's half. It survived for a reason that is completely
   * computable and that §15.1 spells out: 「黑方沒有棋子構得到 d5」.
   *
   * That is true of the opening layout as it stands, and it is worth saying why,
   * because it is the pawn distinction the whole reach model turns on. Black's
   * d7 pawn PUSHES to d5 and does not capture there; with a white piece standing
   * on d5 the push is not a legal move at all, and no black pawn captures onto
   * d5 from the seventh rank. Neither knight reaches it, and every bishop, rook
   * and queen is behind its own pawns.
   */
  function rent(spec: { blackAt?: [PieceId, string][]; flagAt?: string; moves: Move[] }): ViewerState {
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-b1', square: sq(spec.flagAt ?? 'c3') },
        ...(spec.blackAt ?? []).map(([id, square]) => ({ id, square: sq(square) })),
      ],
      moves: spec.moves,
    })
    return flagOn(view, 'white', 'w-b1')
  }

  const TO_D5: Move[] = [move('c3', 'd5'), move('c3', 'b5'), move('e2', 'e3'), PASS]

  it('knows a pawn that can PUSH to a square cannot capture on it', () => {
    // Reach and attack are the same relation exactly when something is standing
    // on the square, and this is the case where they are not. Black's d7 pawn CAN
    // move to d5 while d5 is empty; it cannot once the 軍旗 is there, because the
    // push is blocked and a pawn does not capture forwards. So the question has
    // to be asked about the position the move PRODUCES — which is the single most
    // common way to misread a pawn wall, and the reason the reach model builds a
    // position instead of an attack map.
    expect(
      squareSafety(rent({ moves: [PASS] }), 'white', () => RANK_CERTAIN_COMMANDER, sq('d5'), 1, {
        occupantRank: 'flag',
      }).attackers,
    ).toEqual([])
    expect(flagThreat(rent({ flagAt: 'd5', moves: [PASS] }), 'white').threats).toEqual([])
  })

  it('takes a 結算格 nothing on the board can reach', () => {
    expect(playsOver(rent({ moves: TO_D5 }), 'white', 40)).toEqual(new Set(['c3d5']))
  })

  it('refuses the same square the moment one piece reaches it', () => {
    // One black knight on b4, and the whole calculation inverts. Nothing else
    // changed — same 軍旗, same 載體, same 結算格, same distance, same score.
    const view = rent({ blackAt: [['b-b8', 'b4']], moves: TO_D5 })
    expect(flagThreat(rent({ flagAt: 'd5', blackAt: [['b-b8', 'b4']], moves: [PASS] }), 'white')
      .threats.map((t) => t.from)).toEqual([sq('b4')])
    const played = playsOver(view, 'white', 40)
    expect(played.has('c3d5')).toBe(false)
    expect(played.has('c3b5')).toBe(false) // b4 covers that too
  })

  it('walks back out when the safety decays', () => {
    // §15.1: 「風險不是恆定的」. The 軍旗 is already being paid for d5 and a knight
    // has arrived on b4, so the same square re-asked now answers differently and
    // the policy has to give up income it is collecting. Stepping off a 結算格 is
    // precisely what 攻略 §3's park filter refuses, so this is also the test that
    // §5.3 still outranks §3 — and that the re-evaluation happens every ply
    // rather than once, when the 軍旗 first went there.
    const view = rent({
      flagAt: 'd5',
      blackAt: [['b-b8', 'b4']],
      moves: [move('d5', 'c3'), move('d5', 'f4'), move('e2', 'e3'), PASS],
    })
    expect(flagThreat(view, 'white').immediate).toBe(true)
    const played = playsOver(view, 'white', 40)
    expect(played.has('pass')).toBe(false)
    expect(played.has('e2e3')).toBe(false)
    // …and wherever it goes, it goes somewhere nothing reaches. A 軍旗 that flees
    // onto another covered square has not answered anything.
    for (const notation of played) {
      const landed = rent({
        flagAt: notation.slice(2, 4),
        blackAt: [['b-b8', 'b4']],
        moves: [PASS],
      })
      expect(flagThreat(landed, 'white').immediate).toBe(false)
    }
  })

  it('never walks onto an occupied square, even one that pays (§5.3, 攻略 §9)', () => {
    // 攻略 §9 is absolute and outranks §7.1 every time they meet. d5 is a 結算格,
    // the capture is legal (§4 「任何棋子移動至敵子所在格皆為合法移動」), and it is a
    // resignation: 階級 10 loses to everything, and the one case that draws
    // instead of losing (軍旗 vs 軍旗) is a lottery ticket, not a plan.
    const view = rent({ blackAt: [['b-d7', 'd5']], moves: TO_D5 })
    expect(playsOver(view, 'white', 40).has('c3d5')).toBe(false)
  })

  /**
   * A 軍旗 riding a PAWN, one push from the only 結算格 on the board.
   *
   * The board is a 附錄 B tunable, so it is set to the single square d5 — which
   * makes d4 an ordinary square the 軍旗 may leave, and d5 the whole of the income
   * on offer. The 軍旗 walks one step for a square nothing on the board can reach.
   */
  function pawnRent(blackAt: [PieceId, string][]): ViewerState {
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-d2', square: sq('d4') },
        ...blackAt.map(([id, square]) => ({ id, square: sq(square) })),
      ],
      moves: [move('d4', 'd5'), move('e2', 'e3'), PASS],
      config: { scoringSquares: [sq('d5')] },
    })
    return flagOn(view, 'white', 'w-d2')
  }

  it('will not walk into a square it cannot get out of', () => {
    // The hole the safety gate leaves open on its own: 「nothing reaches it」 is
    // re-asked every ply and answered in time only if there is somewhere to go
    // when the answer changes, and a 軍旗 may not answer by capturing (§5.3). A
    // pawn on d5 with a black pawn on d6 has no push and no legal quiet move at
    // all — it is safe, it pays, and it is a cell.
    const boxed = pawnRent([['b-c7', 'd6']])
    expect(flagThreat(pawnRent([['b-c7', 'd6'], ['w-d2', 'd5']]), 'white').threats).toEqual([])
    expect(playsOver(boxed, 'white', 40).has('d4d5')).toBe(false)

    // The same square, the same 軍旗, the same 載體 — with d6 empty and unreached,
    // so there is a way back out. Now it goes. Both black pawns that capture onto
    // d6 are moved away and a rook takes e7, because vacating e7 would otherwise
    // open the f8 bishop onto d6 and put the cell straight back.
    const free: [PieceId, string][] = [['b-c7', 'c4'], ['b-e7', 'a6'], ['b-a8', 'e7']]
    const open = pawnRent(free)
    expect(flagThreat(pawnRent([...free, ['w-d2', 'd5']]), 'white').threats).toEqual([])
    expect(playsOver(open, 'white', 40)).toEqual(new Set(['d4d5']))
  })

  it('switching the rent off leaves the defence on', () => {
    // `{ flagIncome: false }` restores the pre-§15.1 policy. It must not restore
    // the pre-§13.3 one: the safety gate and both §5.3 absolutes are FILTERS, not
    // weights, and this switch turns off the income alone.
    const noRent = makeBeliefPolicy('no-rent', { flagIncome: false })
    const hunted = rent({
      flagAt: 'd5',
      blackAt: [['b-b8', 'b4']],
      moves: [move('d5', 'c3'), move('d5', 'f4'), move('e2', 'e3'), PASS],
    })
    for (let seed = 0; seed < 20; seed++) {
      const played = moveToNotation(noRent.move(hunted, 'white', makeRng(seed)))
      expect(played.startsWith('d5')).toBe(true)
    }
  })

  it('replays byte for byte from the same seed', () => {
    const view = rent({ moves: TO_D5 })
    const once = moveToNotation(beliefPolicy.move(view, 'white', makeRng(7)))
    expect(moveToNotation(beliefPolicy.move(view, 'white', makeRng(7)))).toBe(once)
    expect(moveToNotation(beliefPolicy.move(view, 'white', makeRng(7)))).toBe(once)
  })

  it('does not buy the rent with 奪旗 losses over real games', async () => {
    // The scenes above prove the gate fires where it was aimed and say nothing
    // about how often it is aimed correctly. This is the A/B: the identical file
    // against itself with the rent switched off, one variable, paired seeds,
    // 側翼八格 because that is the board with the most 結算格 to be tempted by.
    //
    // Measured at 3600 games a cell, both seats, both boards: the win rate and
    // 平均持格／結算 are both flat to within noise and 旗負 does not move. The fence
    // here is deliberately loose — it forbids a regression that doubles the 奪旗
    // losses, not one that moves them by a handful.
    //
    // GAME COUNT SHRUNK 2026-08-18: was `games: 150` (300 total), ~18s warm and
    // up to ~94s under the same unexplained slowdown noted on the sibling test
    // above. Both assertions here compare MEANS, not rare-event counts, so they
    // converge fast and do not need the original volume: checked directly on
    // this seed (fully deterministic — a smaller count is a different fixed set
    // of games, not a smaller sample), meanEarnedPerSettlement differs by under
    // 0.001 between the two arms at games=90, and flagLosses is 0/0. Both
    // conclusions — 「the mean does not move」 and 「旗負 does not explode」 — hold
    // with room to spare at a third of the raw compute (~6.5s).
    const summary = await runMatch({
      seed: 20260817,
      games: 90,
      white: beliefPolicy,
      black: makeBeliefPolicy('belief-norent', { flagIncome: false }),
      swapColors: true,
      config: { scoringSquares: SCORING_WIDE_8 },
    })
    expect(summary.games).toBe(180)
    const withRent = summary.byPolicy.belief
    const without = summary.byPolicy['belief-norent']
    expect(withRent).toBeDefined()
    expect(without).toBeDefined()
    expect(withRent!.flagLosses).toBeLessThan(2 * Math.max(6, without!.flagLosses))
    expect(withRent!.meanEarnedPerSettlement)
      .toBeGreaterThan(0.9 * without!.meanEarnedPerSettlement)
  }, 60_000) // budget UNCHANGED — same reasoning as the sibling test above
})

// ---------------------------------------------------------------------------
// mobilityBonus — develop toward the action once the front is settled
// ---------------------------------------------------------------------------

describe('it still develops once every 結算格 it wants is already held (mobilityBonus)', () => {
  /** White holds all four 結算格, so `ctx.wanted` is empty and `approachBonus` is 0 everywhere. */
  const HOLDERS: Placement[] = [
    { id: 'w-a1', square: sq('d4') },
    { id: 'w-b1', square: sq('e4') },
    { id: 'w-c1', square: sq('d5') },
    { id: 'w-d1', square: sq('e5') },
  ]

  it('still walks a spare piece towards the scoring cluster rather than settling for pass', () => {
    // The measured failure this term exists to close: a side that already
    // holds everything it wants had NO term telling it to do anything but
    // pass. a3 is genuinely empty (ranks 3–6 start empty) and — like every
    // corner of an 8×8 board relative to a 2×2 centre block — three Chebyshev
    // steps from the nearest of the four 結算格; c3 is one step short of them,
    // as close as a single non-scoring destination can land.
    const view = scene({
      color: 'white',
      place: [...HOLDERS, { id: 'w-h1', square: sq('a3'), rank: 'brigade' }],
      moves: [move('a3', 'c3'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['a3c3']))
  })

  it('keeps MOBILITY_WEIGHT / MOBILITY_ARRIVAL_WEIGHT at a quarter or less of the terms they fall back for', () => {
    // The structural statement, so a future retune of either pair on its own
    // cannot silently violate the ratio the whole design argument rests on —
    // same reasoning as the ARRIVAL_WEIGHT / MIXING_BAND_SQUARES test above.
    expect(MOBILITY_WEIGHT).toBeLessThanOrEqual(APPROACH_WEIGHT / 4)
    expect(MOBILITY_ARRIVAL_WEIGHT).toBeLessThanOrEqual(ARRIVAL_WEIGHT / 4)
    expect(MOBILITY_WEIGHT).toBeGreaterThan(0)
    expect(MOBILITY_ARRIVAL_WEIGHT).toBeGreaterThan(0)
  })

  /**
   * White holds three of the four 結算格 (e4, d5, e5), so `ctx.wanted = [d4]` —
   * NON-empty. Before the fix diagnosed this session, `mobilityBonus` returned
   * 0 on every ply like this one (its guard checked `ctx.wanted.length > 0`
   * directly), which is what made it fire on only 0.32% of calls across 250
   * self-play games on 中央四格: this exact shape — the front settled except
   * for ONE contested square neither a spare piece nor its neighbours can
   * usefully walk towards — is the overwhelmingly common one on a 4-square
   * board, not the rare one the old guard assumed. Used below for the
   * no-double-counting test, where `RESTLESSNESS_COST` eating most of a single
   * Chebyshev step's `mobilityBonus` does not matter — `approachBonus`'s own
   * value dwarfs both.
   */
  const ONE_UNHELD: Placement[] = [
    { id: 'w-b1', square: sq('e4') },
    { id: 'w-c1', square: sq('d5') },
    { id: 'w-d1', square: sq('e5') },
  ]

  /**
   * White holds e4 and d5; Black holds e5; d4 is empty. `ourRate` (2) beats
   * `theirRate` (1) so `postureOf` reads `ahead` — 攻略 §4-2, "他有幾格" — and
   * `wantedSquares`'s `posture.ahead && enemy.length > 0` branch fires,
   * returning ONLY the enemy-held square: `ctx.wanted = [e5]`, d4 excluded
   * even though it is genuinely unheld. `mobilityBonus` targets `ctx.scoring`
   * regardless of posture, so d4 is still on ITS board.
   *
   * This is the shape the fix's per-move condition is really for, not a
   * boundary case: 「there is an unheld square」 (d4) and 「it is not what we
   * should be walking towards right now」 (§4-2 says deny the enemy's e5
   * instead) are simultaneously true, and only a per-move `approachBonus`
   * of exactly 0 — not a per-position `ctx.wanted.length` check — can tell
   * "ignore d4, it's not the priority" apart from "there is nothing left to
   * develop towards at all".
   */
  const AHEAD_ONE_ENEMY: Placement[] = [
    { id: 'w-b1', square: sq('e4') },
    { id: 'w-c1', square: sq('d5') },
    { id: 'b-d7', square: sq('e5') },
  ]

  it('fires on a move that makes no progress towards the square still wanted, even though a DIFFERENT unheld square is available to walk onto (the case the old ctx.wanted-only guard missed)', () => {
    // w-h1, relocated to f5: Chebyshev distance 1 from e5 (the one square
    // `ctx.wanted` names) both before AND after f5→d4 (max(1,0)=1 either way,
    // since d4 and f5 are each one step from e5 on this board) — progress and
    // arrival both exactly 0, so `approachBonus` is 0 for this move, case (b)
    // from the fix, not a rounding artefact. Landing square d4 is empty (no
    // piece placed there), so the move is a genuine quiet walk, and against
    // the FULL scoring set `mobilityBonus` uses, f5→d4 walks all the way ONTO
    // an unheld 結算格 (distance 1 → 0) — the single largest positive
    // `mobilityBonus` a one-move-away piece can ever earn, comfortably clear
    // of both `RESTLESSNESS_COST` and `MIXING_BAND_SQUARES` (see the sizing
    // note on `MOBILITY_ARRIVAL_WEIGHT`'s test above), which a bare tie-break
    // step is not guaranteed to be.
    const view = scene({
      color: 'white',
      place: [...AHEAD_ONE_ENEMY, { id: 'w-h1', square: sq('f5') }],
      moves: [move('f5', 'd4'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['f5d4']))
  })

  it('still lets a genuine approachBonus win outright, sized at its own APPROACH_WEIGHT scale — not summed with mobilityBonus on top', () => {
    // Same position as above, `ctx.wanted` still just `[d4]`, but now a SECOND
    // piece is in play: w-c2, also on its home square, with a real approach to
    // the one square still wanted (c2→c3 closes distance 2→1, a genuine
    // Chebyshev step towards d4, not a tie). If the call site ever summed
    // `approachBonus(ctx, shape) + mobilityBonus(ctx, shape)` instead of
    // choosing between them with `||`, c2→c3's own value would only grow, so
    // this cannot by itself catch that regression — what it does confirm is
    // the other direction: `approachBonus`'s own, larger (quarter-scale-times-
    // four) number is what governs a real approach, and it is not somehow
    // capped or replaced by `mobilityBonus`'s smaller fallback value the way a
    // truthiness check (rather than `||`'s exact-zero test) might have done
    // for some other small-but-nonzero term in this file. f2→f3 — a real, if
    // small, `mobilityBonus`-only credit for the same reason f5→d4 gets one in
    // the test above (progress and arrival both 0 against `ctx.wanted = [d4]`
    // here, same tie shape) — stays on the table as the losing alternative.
    const view = scene({
      color: 'white',
      place: ONE_UNHELD,
      moves: [move('c2', 'c3'), move('f2', 'f3'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['c2c3']))
  })
})

// ---------------------------------------------------------------------------
// huntBonus, generalised past commander-only / bomb-only
// ---------------------------------------------------------------------------

describe('an ordinary piece is credited for approaching a 翻明 piece it would actually beat', () => {
  /**
   * Two knights mirrored about the centre file, each one Chebyshev step from
   * the nearest of the four 結算格 (none held, so `approachBonus` — not
   * `mobilityBonus` — supplies the shared baseline both moves below stand on).
   * `approachBonus` is IDENTICAL for the two mirrored steps by construction
   * (same distance, same arrival math), which is what isolates whatever
   * `ordinaryHuntBonus` adds on top: a real 翻明 target sits only on one
   * knight's side, at e2, so only `b4c4` also makes progress towards it.
   * `captureScoreK: 15` is a real, positive §7.3 payoff (not the shipped
   * default of 0) so the ordinary-hunt signal comfortably clears
   * `MIXING_BAND_SQUARES` on top of the tied `approachBonus` — otherwise the
   * two moves would still be within a coin flip of each other and this test
   * would prove nothing about direction.
   */
  const MIRROR: Placement[] = [
    { id: 'w-b1', square: sq('b4'), rank: 'commander' },
    { id: 'w-g1', square: sq('g4'), rank: 'commander' },
  ]

  it('prefers the mirrored step that also approaches a weaker 翻明 piece', () => {
    // 司令 (RANK_ORDER 1) beats a 軍長 (2) — the strongest target an ordinary
    // piece can ever be credited for approaching, since nothing beats 司令
    // itself (RANK_ORDER 1 is the minimum).
    const view = scene({
      color: 'white',
      place: [...MIRROR, { id: 'b-h8', square: sq('e2'), rank: 'general', reveal: true }],
      moves: [move('b4', 'c4'), move('g4', 'f4'), PASS],
      config: { captureScoreK: 15 },
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['b4c4']))
  })

  it('gets NOTHING for approaching a 翻明 piece it would LOSE to — the correctness property', () => {
    // 排長 (RANK_ORDER 8) does not beat a 旅長 (4): 8 < 4 is false. If the
    // guard in `ordinaryHuntBonus` were missing, `belief` would be lured into
    // walking a weak piece at a strong one purely for a phantom bonus; with
    // it, the target is filtered out of the candidate set for BOTH knights
    // (their rank, not their position, decides eligibility), so the two
    // mirrored moves stay exactly as tied as they would with no target on the
    // board at all — a real tie, so both have to appear over enough seeds,
    // exactly like the genuine ties in "it mixes inside the epsilon band"
    // above. A one-sided result here would mean the sign check is not doing
    // its job.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-b1', square: sq('b4'), rank: 'platoon' },
        { id: 'w-g1', square: sq('g4'), rank: 'platoon' },
        { id: 'b-h8', square: sq('e2'), rank: 'brigade', reveal: true },
      ],
      moves: [move('b4', 'c4'), move('g4', 'f4')],
    })
    const played = playsOver(view, 'white', 60)
    expect(played).toEqual(new Set(['b4c4', 'g4f4']))
  })

  it('never outbids an actual 結算格 — sized like the tie-break it is, not like approachBonus', () => {
    // d4 is a real, unheld 結算格 one diagonal step from c3. A 翻明 division
    // sits far in the other direction at a6 (empty at the start, unlike a1 —
    // white's own rook), the single best possible ordinary-hunt target
    // reachable from c3 in one step. Taking the actual square wins regardless.
    const view = scene({
      color: 'white',
      place: [
        { id: 'w-g1', square: sq('c3'), rank: 'commander' },
        { id: 'b-h8', square: sq('a6'), rank: 'general', reveal: true },
      ],
      moves: [move('c3', 'd4'), move('c3', 'b2'), PASS],
    })
    expect(playsOver(view, 'white', 40)).toEqual(new Set(['c3d4']))
  })
})

// ---------------------------------------------------------------------------
// revealValue — the information a forced reveal buys, even on a loss (§4.3)
// ---------------------------------------------------------------------------

describe('the information value of a forced reveal, even on a loss (§4.3)', () => {
  it('reduces the cost of a loss by exactly revealValue, and never flips its sign', () => {
    // brigade (4) loses to a certain commander (1): attackerValue(5) +
    // attackerSquares(0) + capture(0, k unset) − revealValue.
    expect(contactEV('brigade', { commander: 1 }, TERMS)).toBe(-(5 + 0 + 0))
    expect(contactEV('brigade', { commander: 1 }, { ...TERMS, revealValue: 2 })).toBe(-(5 + 0 + 0 - 2))
    // A real revealValue (see the sizing test below) never gets close enough
    // to attackerValue to turn this positive on its own.
    expect(contactEV('brigade', { commander: 1 }, { ...TERMS, revealValue: 2 })).toBeLessThan(0)
  })

  it('never appears in the win, flag-win, or mutual branches — nothing symmetric to price there', () => {
    // Deliberately huge, so a leak into the wrong branch would be obvious
    // rather than lost in noise.
    const withInfo: ContactTerms = { ...TERMS, revealValue: 50 }
    expect(contactEV('brigade', { platoon: 1 }, withInfo)).toBe(contactEV('brigade', { platoon: 1 }, TERMS))
    expect(contactEV('brigade', { flag: 1 }, withInfo)).toBe(contactEV('brigade', { flag: 1 }, TERMS))
    expect(contactEV('brigade', { brigade: 1 }, withInfo)).toBe(contactEV('brigade', { brigade: 1 }, TERMS))
  })

  it('keeps INFO_WEIGHT small enough that revealValue can never be competitive with attackerValue', () => {
    // The exact bound `INFO_WEIGHT`'s own doc comment argues from, checked as
    // a number rather than merely asserted by design intent, across a range
    // of `econ.square`: the weakest attacker that can ever reach 'lose' (排長,
    // RANK_WEIGHT 0.24 — 軍旗 never attacks, and a losing 爆裂物 is priced by
    // BOMB_WEIGHT 0.75, which is larger, not smaller) at the least
    // risk-averse posture (riskAversion floors at 1 − RISK_SWING = 0.75)
    // against the flattest belief a distribution over all `ALL_RANKS.length`
    // (11) ranks can produce (uniform, so the highest single probability is
    // 1/11 and `1 − maxProbability` peaks at 10/11).
    const PLATOON_RANK_WEIGHT = 0.24
    const PIECE_VALUE_IN_SQUARES = 0.55
    const RISK_AVERSION_FLOOR = 0.75
    const flattestOneMinusMax = (ALL_RANKS.length - 1) / ALL_RANKS.length

    for (const econSquare of [0.01, 0.1, 1, 5, 20, 100]) {
      const attackerValueFloor =
        PLATOON_RANK_WEIGHT * PIECE_VALUE_IN_SQUARES * RISK_AVERSION_FLOOR * econSquare
      const revealValueCeiling = INFO_WEIGHT * econSquare * flattestOneMinusMax
      expect(revealValueCeiling).toBeLessThan(attackerValueFloor)
    }
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

  it('replays a mixed match, where the belief is sampled every ply', async () => {
    const opts = { seed: 77, games: 6, white: beliefPolicy, black: randomPolicy, swapColors: true }
    expect(JSON.stringify(await runMatch(opts))).toBe(JSON.stringify(await runMatch(opts)))
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
