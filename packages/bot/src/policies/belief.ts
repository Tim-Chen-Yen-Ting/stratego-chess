/**
 * `belief` — the first policy that PRICES a contact instead of guessing at it.
 *
 * ---------------------------------------------------------------------------
 * What it is
 * ---------------------------------------------------------------------------
 *
 * `greedy` never fights and `contest` fights blind (「no belief state, no
 * expected value, no idea what it is hitting」). Both are instruments. This one
 * is meant to be a PLAYER: it reads the same redacted `ViewerState` a human
 * gets, asks `beliefFor` what each enemy piece might be, and then values every
 * legal move in POINTS — the only currency the game actually pays in (§7).
 *
 * It is the 攻略 turned into arithmetic. Each section below names the paragraph
 * it implements:
 *
 *   攻略 §1   income is a RATE  ............ `economyOf`, and every value in the
 *                                            file being denominated in 結算格
 *   攻略 §3   park, don't march ............ the park filter, `RESTLESSNESS_COST`
 *   攻略 §4   behind → uncontested square ... `postureOf`, `wantedSquares`
 *   攻略 §4-2 ahead → contact and denial .... `postureOf.denialWeight`
 *   攻略 §5   hold 爆裂物 for a 翻明 司令 ..... `BOMB_WEIGHT`, `huntBonus`
 *   攻略 §6   winning costs a 翻明 .......... `revealCost`, `bombThreatOf`
 *   攻略 §7   a 翻明 司令 keeps attacking .... `MOVING_TARGET_WEIGHT`
 *   攻略 §9   the 軍旗 never crashes ......... `movesFlag`, absolute
 *
 * 佈署 (§9) is `deploy.ts`'s doctrine plus one addition of this policy's own;
 * see `chooseDeployment` at the bottom.
 *
 * Measured over 150 games a side (`npm run bot`, 中央四格, X=40): 100% against
 * `random`, ~95% against `greedy`, ~52% against `contest`. The last number is the
 * interesting one and it is not a typo — `contest` is 「greedy＋attack the square」
 * and rent collection is embarrassingly strong on this board (greedy.ts says so
 * itself). What this policy adds over it is not raw score but the thing the arena
 * could not measure before: it wins about one game in six by 奪旗 (§7④①), having
 * decided from the public record which piece was likely to be the 軍旗.
 *
 * ---------------------------------------------------------------------------
 * The lens (policy.ts, and it is not negotiable)
 * ---------------------------------------------------------------------------
 *
 * Everything here is computed from the redacted payload plus this side's OWN
 * 兵種 — which §10.1 grants us — and nothing else. There is no path from this
 * file to a `GameState`, to an enemy 兵種 that 翻明 has not published, or to the
 * opponent's deployment. Where the policy wants to know what an enemy piece is,
 * it asks `beliefFor`, which is itself a function of the public log.
 *
 * `view.legalMoves` remains the authority on legality: this file scores moves,
 * it never generates them, and it never tries to work out what the OPPONENT can
 * play next — that would be a second move generator, i.e. a second set of bugs.
 * The cost of that discipline is that the policy is 1 ply deep and cannot see a
 * piece hanging. Stated here so nobody reads the EV arithmetic as more than it
 * is: it prices the contact it is about to make, not the reply.
 *
 * ---------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------
 *
 * No `Math.random`, no clock, no globals. The seeded `Rng` is threaded into
 * `beliefFor` as well, so if the belief is sampled rather than enumerated the
 * samples are part of the same replayable stream. Exactly one `rng.pick` per
 * move (after `beliefFor`'s own draws), so a game replays byte for byte.
 */

import { ALL_RANKS, opposite, resolveCombat } from '@xiyang/rules'
import type {
  Carrier,
  Color,
  Move,
  PieceId,
  Rank,
  Square,
  ViewerPiece,
  ViewerState,
} from '@xiyang/rules'
import type { Rng } from '../prng.js'
import type { MoveShape, Policy } from '../policy.js'
import {
  heldScoring,
  heldScoringAfter,
  moveKey,
  occupancy,
  ownPieceIds,
  ownPieces,
  pawnReachesScoring,
  scoringSet,
  shapeOfMove,
  shuffled,
} from '../policy.js'
import { beliefFor, pBomb, pFlag, priorBelief } from '../belief.js'
import { informedDeployment } from '../deploy.js'
import type { BeliefOptions, RankBelief } from '../belief.js'

const PASS: Move = { kind: 'pass' }

// ---------------------------------------------------------------------------
// Tuning. Every number here is a POLICY weight, not a rule — nothing in
// packages/rules depends on any of them, and a different set produces a
// different player, not a different game. They are all DIMENSIONLESS: the unit
// of value in this file is 「one 結算格, held for the rest of the game」, which
// `economyOf` computes from the position. That is the whole trick — an opening
// square is worth thirty-odd points and an endgame square is worth two, and a
// bot with a hardcoded square value plays the endgame like the opening.
// ---------------------------------------------------------------------------

/**
 * 兵種 values, as a fraction of a 司令.
 *
 * There is no exchange table in the gamebook and there cannot be one: 子力 buys
 * nothing directly (攻略 §1 「子力領先跟贏球沒有必然關係」). A piece is worth what
 * it can still take and hold, so the ladder is the 階級 ladder, compressed —
 * the gap between 司令 and 軍長 matters far less than the gap between "can take
 * the centre off them" and "cannot".
 *
 * 工兵 sits ABOVE 排長 despite being 階級 9: it is immune to 爆裂物 in both
 * directions (§5.4), which makes it the cheapest piece to evict a bomb with and
 * the most annoying piece to evict FROM a 結算格 (攻略 §8②).
 */
const RANK_WEIGHT: Readonly<Record<Rank, number>> = Object.freeze({
  commander: 1.0,
  general: 0.82,
  division: 0.68,
  brigade: 0.56,
  regiment: 0.46,
  battalion: 0.38,
  company: 0.3,
  platoon: 0.24,
  engineer: 0.28,
  flag: 0, // never priced by weight — a 軍旗 is the game itself (§7④①)
  bomb: 0, // priced by BOMB_WEIGHT, which is doctrine rather than 階級
})

/**
 * 爆裂物, priced just below a 司令 and above everything else.
 *
 * This single number IS 攻略 §5 「全場唯一真正值得用爆裂物換的目標，是已翻明的
 * 司令」. Because a 爆裂物 only ever resolves as a trade, the mutual branch of
 * the EV reads `their value − our value`, so a bomb priced at 0.75 declines
 * every trade whose expected target is worth less than 0.75 (which is every
 * unknown piece — a blind draw averages about 0.45) and accepts a 翻明 司令 at
 * 1.0. 「忍住」, in one constant.
 */
const BOMB_WEIGHT = 0.75

/** A 司令 is worth this much of one 結算格's remaining income. */
const PIECE_VALUE_IN_SQUARES = 0.55

/**
 * 早期可送達性 by 載體 — notebook §2.3, the finding the original design missed.
 *
 * Used twice, in both directions: how likely OUR 爆裂物 is to reach a 翻明 司令
 * (so a rook bomb does not set off on the seven-move march that never arrived),
 * and how much of a threat THEIR possible 爆裂物 is to a piece we are about to
 * 翻明 (a bomb that cannot be delivered is not a reason to stay hidden).
 */
const DELIVERABILITY: Readonly<Record<Carrier, number>> = Object.freeze({
  pawn: 0.5, // 站著就有威脅, but it cannot chase
  knight: 0.9, // jumps the unopened pawn line, cannot be blocked
  bishop: 0.6,
  rook: 0.25, // 「極低」 — blocked by its own pawns, opening a file is slow and public
  queen: 0.8,
  king: 0.4,
})

/** How much more (ahead) or less (behind) we like an even trade. 攻略 §4 / §4-2. */
const TRADE_SWING = 0.35
/** How much more (ahead) we value taking income OFF them. 攻略 §4-2. */
const DENIAL_SWING = 0.3
/** How much more (behind) a lost piece hurts — the §4.2 snowball, from the losing end. */
const RISK_SWING = 0.25

/** Walking towards a 結算格 we want, per square of Chebyshev progress. A tiebreak. */
const APPROACH_WEIGHT = 0.08
/** Walking a 爆裂物 towards a 翻明 司令, per square of progress, times 送達性. 攻略 §5. */
const HUNT_WEIGHT = 0.09
/** A 翻明 司令 of ours gets this for making contact — 「移動標靶」, notebook §2.3b. */
const MOVING_TARGET_WEIGHT = 0.12
/** A quiet 軍旗 move is discounted this hard even when it gains a square. 攻略 §9. */
const FLAG_RISK = 0.6

/**
 * What it costs to move a piece for no reason — 攻略 §3, 「停下來，不要一直走」.
 *
 * Without it every idle shuffle scores exactly 0, ties with a pass, and lands
 * inside the mixing band, so a position with nothing to do produces a random
 * legal move. That is not neutral: this policy is 1 ply deep and cannot see the
 * reply, so a piece that moves for nothing is a piece walking into a fight
 * nobody priced, and 攻略 §3's own example is a player who looks busy and earns
 * zero. Measured against `contest` it is worth about eight points of win rate,
 * the largest single effect in this file after the deployment.
 *
 * Smaller than one step of `APPROACH_WEIGHT`, so a move that actually goes
 * somewhere still beats standing still; larger than zero, so one that does not,
 * does not.
 */
const RESTLESSNESS_COST = 0.03

/**
 * THE MIXING BAND — the named epsilon, and the reason it exists.
 *
 * 附錄 A binds the RULES: no rule may produce 依兵種而異的可觀測行為. Nothing
 * binds a POLICY, and that is a hole a deterministic bot digs for itself. 「The
 * bot attacked」 is an observation, and against a deterministic bot it is an
 * observation about the bot's own 兵種: it attacked, therefore its rank clears
 * the threshold, and enough logged games recover the threshold exactly. A bot
 * that always plays argmax publishes its hand one move at a time.
 *
 * So the policy binds itself: among moves whose EV differs by less than this
 * fraction of a 結算格, it draws from the seeded stream. Note what it does NOT
 * do — it never plays a move that is dominated by more than the band. Playing
 * deliberately bad moves only pays against an opponent who is modelling you,
 * and none of `random`, `greedy` or `contest` is modelling anything.
 */
export const MIXING_BAND_SQUARES = 0.08

// ---------------------------------------------------------------------------
// The belief surface
//
// `beliefFor` lives in ../belief.js and is NOT reimplemented here. This policy
// asks it what an enemy piece might be and does no inference of its own: no
// candidate sets, no log replay, no counting of the 數量表. Everything below
// consumes `RankBelief` — one probability per 兵種, summing to 1 — and nothing
// else. The two files meet in exactly one function, `beliefLookup`.
// ---------------------------------------------------------------------------

/**
 * A distribution over 兵種 for one enemy piece.
 *
 * Structurally `RankBelief` with the fields optional, so the valuation functions
 * below can also be handed a hand-written `{ flag: 1 }` — which is how the tests
 * pin the exceptions of §5.4 and §7④① without having to manufacture a position
 * that produces them.
 */
export type RankProbs = Readonly<Partial<Record<Rank, number>>>

/** `PieceId → P(兵種)`. Defined for every enemy piece, alive or dead. */
export type BeliefLookup = (id: PieceId) => RankBelief

/**
 * How many particles the sampler draws per ply.
 *
 * Below `DEFAULT_SAMPLES`, because this is a bot ARENA: a policy runs some
 * hundreds of plies per game and some hundreds of games per question, and a
 * belief three times cheaper is three times more experiment for the same
 * afternoon. 64 particles put the standard error of a 1-in-16 marginal near
 * 0.03, which is finer than the decisions a 1-ply policy makes off it — the
 * mixing band below is wider than that by construction.
 */
const BELIEF_OPTIONS: BeliefOptions = { samples: 64 }

/**
 * The belief for this ply, memoised per piece.
 *
 * The `rng` goes in, and that is not optional: `beliefFor` SAMPLES, so its draws
 * are part of the same seeded stream as the tie-break below. Called exactly once
 * per ply — once per candidate move would make the number of draws depend on how
 * many moves happened to be legal, and a replay would need the move list to
 * reproduce the dice.
 */
function beliefLookup(view: ViewerState, color: Color, rng: Rng): BeliefLookup {
  const belief = beliefFor(view, color, rng, BELIEF_OPTIONS)
  // The 數量表 prior, for an id the belief does not cover — our own pieces (which
  // we never ask about) and, defensively, anything a future view shape adds.
  // It is not a second belief model: it conditions on nothing at all.
  const fallback: RankBelief = priorBelief(view)
  return (id) => belief.get(id) ?? fallback
}

// ---------------------------------------------------------------------------
// The economy — what a 結算格 is worth RIGHT NOW
// ---------------------------------------------------------------------------

export interface Economy {
  /** points one 結算格 is still worth to us: 1 × expected remaining own settlements */
  square: number
  /** our settlements to X at the current rate, Infinity when we hold nothing */
  ourPlies: number
  /** theirs, same */
  theirPlies: number
  /** 結算格 we hold now — i.e. our income per own ply (§7.1) */
  ourRate: number
  /** 結算格 they hold now. 攻略 §4-2: 「每回合問自己的不是我有幾格，是他有幾格」 */
  theirRate: number
}

/**
 * A 結算格 is worth 1 point per remaining own settlement — so estimate that.
 *
 * 攻略 §1: 「分數是速率不是存量」. Each of our own plies banks one point per
 * square we stand on (§7.1, mover-only settlement), so the value of holding one
 * more square is exactly the number of our own plies the game has left.
 *
 * The game ends when EITHER side crosses X (§7④②), so the horizon is the
 * smaller of the two projections — a square is worth little when the opponent
 * is two settlements from winning, however far WE still have to go. When
 * neither side scores at all, nothing ends the game except the 停滯 fuse, so N
 * (§7④③) is the horizon; that is a config value, not a constant.
 *
 * Deliberately computed from the CURRENT rate rather than the rate the move
 * being scored would produce. A per-move horizon would price each candidate's
 * square in its own currency and the comparison between candidates would stop
 * meaning anything. This is a property of the position, evaluated once per ply.
 */
export function economyOf(view: ViewerState, color: Color): Economy {
  const them = opposite(color)
  const target = view.config.scoreTarget
  const fuse = Math.max(1, view.config.noProgressTurns)

  const rateOf = (c: Color): number => heldScoring(view, c)
  const pliesOf = (c: Color): number => {
    const rate = rateOf(c)
    if (rate <= 0) return Number.POSITIVE_INFINITY
    return Math.max(1, Math.ceil(Math.max(target - view.score[c], 0) / rate))
  }

  const ourPlies = pliesOf(color)
  const theirPlies = pliesOf(them)
  const horizon = Math.min(ourPlies, theirPlies)

  return {
    square: Number.isFinite(horizon) ? Math.max(1, horizon) : fuse,
    ourPlies,
    theirPlies,
    ourRate: rateOf(color),
    theirRate: rateOf(them),
  }
}

export interface Posture {
  ahead: boolean
  behind: boolean
  /** multiplies the value of what a trade removes. >1 ahead (§4-2), <1 behind (§4) */
  tradeAppetite: number
  /** multiplies the income we take OFF the opponent by capturing */
  denialWeight: number
  /** multiplies what losing our own piece costs */
  riskAversion: number
}

/**
 * Ahead or behind — measured on the RACE, not on the scoreboard.
 *
 * 攻略 §4-2: 「累積領先＋速率落後＝你正在輸. 你手上的分差是過去賺的；對方的持格數
 * 是他未來的收入」. So the comparison is who reaches X first at the current rate,
 * which is exactly `economyOf`'s two projections. A bot 10 points up and one
 * square down knows it is losing.
 *
 * The three knobs are the two halves of one rule (notebook §4.2): an even trade
 * shrinks both armies, and a smaller board is easier to hold and harder to
 * break. That helps whoever is winning the race and hurts whoever is chasing.
 */
export function postureOf(econ: Economy): Posture {
  const ahead = econ.ourPlies < econ.theirPlies
  const behind = econ.ourPlies > econ.theirPlies
  const swing = ahead ? 1 : behind ? -1 : 0
  return {
    ahead,
    behind,
    tradeAppetite: 1 + swing * TRADE_SWING,
    denialWeight: 1 + swing * DENIAL_SWING,
    riskAversion: 1 - swing * RISK_SWING,
  }
}

// ---------------------------------------------------------------------------
// Contact arithmetic (§4, §5)
// ---------------------------------------------------------------------------

export type ContactKind = 'win' | 'flag-win' | 'lose' | 'mutual'

/**
 * What our `attacker` would be worth against a `defender` of a given 兵種.
 *
 * The outcome is decided by the ENGINE's `resolveCombat` (§4, §5), never by a
 * private copy of the combat table: techspec §7 says 「The client must not
 * implement rules」 and a bot is a client. A second table would disagree with the
 * first exactly on the 爆裂物 cases that matter most. All this adds is the two
 * distinctions a VALUATION needs and a resolution does not:
 *
 *   'flag-win'  the defender is the enemy 軍旗 — taking it ends the game on the
 *               spot (§7④①), so it is not a captured piece, it is a win.
 *   'lose'      we come off the board and never enter the target square (§4.1
 *               「攻方從未進入目標格」). For a 爆裂物 meeting 工兵/軍旗 this is
 *               有煙無傷 (§5.4): the bomb is spent and the defender is untouched.
 *
 * `reveals` is the engine's own `revealAttacker` flag — 翻明 is permanent (§4.3)
 * and has exactly one exception (§5.4 / 附錄 A(c)), and reading the flag means
 * this file never has to know which one it was.
 */
function resolutionOf(attacker: Rank, defender: Rank): { kind: ContactKind; reveals: boolean } {
  // The colours only label a 有煙無傷's announced survivor, which is not read
  // here; survival and 翻明 depend on the pair of 兵種, not on who moved.
  const res = resolveCombat(attacker, defender, 'white', 'black')
  if (res.attackerSurvives && !res.defenderSurvives) {
    return { kind: defender === 'flag' ? 'flag-win' : 'win', reveals: res.revealAttacker }
  }
  if (!res.attackerSurvives && res.defenderSurvives) return { kind: 'lose', reveals: false }
  return { kind: 'mutual', reveals: false }
}

/** What happens when our `attacker` meets `defender`. §4.1, §5.1, §5.4, §7④①. */
export function classifyContact(attacker: Rank, defender: Rank): ContactKind {
  return resolutionOf(attacker, defender).kind
}

/**
 * Does winning this contact force 翻明? §4.3, and its one exception, §5.4.
 *
 * 工兵/軍旗 beating a 爆裂物 is the single win in the game that publishes
 * nothing — 附錄 A(c). Everything else that wins is public forever.
 */
export function revealsOnWin(attacker: Rank, defender: Rank): boolean {
  return resolutionOf(attacker, defender).reveals
}

/**
 * The four branch probabilities for a rank against a belief.
 *
 * belief.ts already answers three of them (`contactOdds(belief, mine)`); this
 * splits the fourth out of the win bucket, because 軍旗 is the one capture that
 * is not a capture — it ends the game (§7④①) and must not be priced as a piece.
 */
export function branchOdds(
  attacker: Rank,
  probs: RankProbs,
): { win: number; flagWin: number; lose: number; mutual: number } {
  let win = 0
  let flagWin = 0
  let lose = 0
  let mutual = 0
  for (const rank of ALL_RANKS) {
    const p = probs[rank] ?? 0
    if (p <= 0) continue
    switch (classifyContact(attacker, rank)) {
      case 'win':
        win += p
        break
      case 'flag-win':
        flagWin += p
        break
      case 'lose':
        lose += p
        break
      default:
        mutual += p
    }
  }
  return { win, flagWin, lose, mutual }
}

/** Everything the position contributes to a contact's value. All fields are POINTS. */
export interface ContactTerms {
  /** change in own 結算格 held if we survive and take the square */
  squareGain: number
  /** income denied to the opponent when the target leaves the board (0 if it held none) */
  denial: number
  /** what our own piece is worth */
  attackerValue: number
  /** income we give up if our piece comes off the board — the 結算格 it stands on */
  attackerSquares: number
  /** rank value × P(the opponent still holds a deliverable 爆裂物) */
  revealCost: number
  /** what ending the game as the winner is worth right now (§7④①) */
  winValue: number
  /** posture, 攻略 §4 / §4-2 */
  tradeAppetite: number
  /** points per enemy 兵種 */
  valueOf: (rank: Rank) => number
}

/**
 * EV of attacking, over a belief `P` about the target, with our rank `A`.
 *
 *   EV = P(win)    · (squareGain + targetValue − revealCost)
 *      − P(lose)   · (valueOf(A) + squares A was holding)
 *      + P(mutual) · (squareCleared − valueOf(A))
 *
 * written out rank by rank rather than branch by branch, which is the same sum
 * and lets each term use the value of the specific 兵種 that produced it.
 *
 * Three things the plain three-branch form hides, all of them from §5 and §7:
 *
 *  · **軍旗 is not a captured piece.** Taking it ends the game (§7④①), so its
 *    share of P(win) is priced at `winValue` — a win outright — and pays no
 *    reveal cost, because there is no game left in which to be hunted.
 *  · **The reveal is priced only where a reveal happens.** 工兵/軍旗 beating a
 *    爆裂物 wins and publishes nothing (§5.4), so that slice of P(win) is free.
 *  · **The mutual branch counts what it removed.** For an ordinary A the two
 *    values nearly cancel (同階 means the target is worth what we are), which is
 *    why the short form drops it — but a 爆裂物 resolves as a trade EVERY time,
 *    and dropping the term would make the ace worthless and the 攻略 §5 doctrine
 *    unexpressible. `tradeAppetite` scales it: 攻略 §4-2 wants trades when we
 *    are ahead, §4 refuses them when we are behind.
 */
export function contactEV(attacker: Rank, probs: RankProbs, terms: ContactTerms): number {
  let ev = 0
  for (const rank of ALL_RANKS) {
    const p = probs[rank] ?? 0
    if (p <= 0) continue
    const resolution = resolutionOf(attacker, rank)
    switch (resolution.kind) {
      case 'flag-win':
        ev += p * terms.winValue
        break
      case 'win': {
        const reveal = resolution.reveals ? terms.revealCost : 0
        ev += p * (terms.squareGain + terms.valueOf(rank) + terms.denial - reveal)
        break
      }
      case 'lose':
        ev -= p * (terms.attackerValue + terms.attackerSquares)
        break
      default: {
        // 雙亡: both removed, target square cleared, our square given up too.
        const cleared = terms.denial - terms.attackerSquares
        ev += p * (cleared + terms.tradeAppetite * terms.valueOf(rank) - terms.attackerValue)
      }
    }
  }
  return ev
}

// ---------------------------------------------------------------------------
// Per-ply context
// ---------------------------------------------------------------------------

interface Ctx {
  view: ViewerState
  color: Color
  econ: Economy
  posture: Posture
  scoring: ReadonlySet<Square>
  held: number
  belief: BeliefLookup
  byId: ReadonlyMap<PieceId, ViewerPiece>
  flagIds: ReadonlySet<PieceId>
  /** P(the opponent still has a 爆裂物 it could actually deliver) */
  bombThreat: number
  /** square of a 翻明 enemy 司令, if there is one to hunt (攻略 §5) */
  huntSquare: Square | null
  /** 結算格 we do not hold, filtered by posture (§4 second battlefield / §4-2 denial) */
  wanted: readonly Square[]
  winValue: number
  valueOf: (rank: Rank) => number
}

function chebyshev(a: Square, b: Square): number {
  return Math.max(Math.abs((a % 8) - (b % 8)), Math.abs(Math.floor(a / 8) - Math.floor(b / 8)))
}

/**
 * P(the opponent still holds a 爆裂物 that could reach us).
 *
 * NOTE, and this is the point of the v04 change: before v04 every detonation was
 * announced, so both bombs could be counted down to zero from the log and a
 * 翻明 司令 became publicly unkillable once they were spent (notebook §8.4, and
 * §6.4's game where exactly that happened). Now 同階雙亡, 爆裂物 vs 一般 and
 * 爆對爆 are literally the same event (§4.3), so the count is NOT derivable and
 * this number is a belief, not an observation. It should be soft, and it is: it
 * comes out of the same `beliefFor` distribution as everything else, weighted by
 * 送達性 (notebook §2.3 — 「打得贏不等於打得到」, and a bomb on a rook is a bomb
 * that never arrives).
 */
function bombThreatOf(view: ViewerState, color: Color, belief: BeliefLookup): number {
  let miss = 1
  for (const piece of view.pieces) {
    if (piece.color === color || piece.square === null) continue
    const p = pBomb(belief(piece.id))
    if (p <= 0) continue
    miss *= 1 - p * DELIVERABILITY[piece.carrier]
  }
  return 1 - miss
}

/** The 翻明 enemy 司令 to hunt, if any. 攻略 §5 「忍住」 until this exists. */
function huntSquareOf(view: ViewerState, color: Color): Square | null {
  for (const piece of view.pieces) {
    if (piece.color === color || piece.square === null) continue
    if (piece.revealed && piece.rank === 'commander') return piece.square
  }
  return null
}

/**
 * Which 結算格 we should be walking towards.
 *
 * 攻略 §4 (behind): 「去對手不在的地方開第二戰場」 — an empty square, if the board
 * offers one. The 攻略 flags its own precondition (「但先確認真的有第二戰場」), so
 * when every unheld square is occupied this falls back to all of them: on
 * 中央四格 with two apiece there IS no detour and 搶格子與打仗是同一件事.
 *
 * 攻略 §4-2 (ahead): the opposite question — 「他有幾格」 — so head for the ones
 * they are standing on and take the income off them.
 */
function wantedSquares(view: ViewerState, color: Color, posture: Posture): Square[] {
  const occ = occupancy(view)
  const scoring = scoringSet(view)
  const unheld = [...scoring].filter((sq) => occ[sq]?.color !== color)
  if (unheld.length === 0) return []
  const empty = unheld.filter((sq) => occ[sq] === undefined)
  const enemy = unheld.filter((sq) => occ[sq] !== undefined)
  if (posture.behind && empty.length > 0) return empty
  if (posture.ahead && enemy.length > 0) return enemy
  return unheld
}

function contextFor(view: ViewerState, color: Color, rng: Rng): Ctx {
  const econ = economyOf(view, color)
  const posture = postureOf(econ)
  const belief = beliefLookup(view, color, rng)
  const mine = ownPieces(view, color)

  // 攻略 §7④①: our own 軍旗 leaving the board loses instantly, so ending the game
  // as the winner is worth every point we would otherwise still have to earn,
  // and never less than the best square on the board. Derived from X and the
  // score — near the end it is small, because by then we were going to win anyway.
  const winValue = Math.max(view.config.scoreTarget - view.score[color], econ.square)

  const value = (rank: Rank): number => {
    if (rank === 'flag') return winValue
    const weight = rank === 'bomb' ? BOMB_WEIGHT : RANK_WEIGHT[rank]
    return weight * PIECE_VALUE_IN_SQUARES * econ.square
  }

  return {
    view,
    color,
    econ,
    posture,
    scoring: scoringSet(view),
    held: heldScoring(view, color),
    belief,
    byId: new Map(view.pieces.map((p) => [p.id, p])),
    flagIds: new Set(mine.filter((p) => p.rank === 'flag').map((p) => p.id)),
    bombThreat: bombThreatOf(view, color, belief),
    huntSquare: huntSquareOf(view, color),
    wanted: wantedSquares(view, color, posture),
    winValue,
    valueOf: value,
  }
}

// ---------------------------------------------------------------------------
// Move filters — the two absolutes
// ---------------------------------------------------------------------------

/** Does this move relocate our 軍旗 (or a piece whose rank the view did not disclose)? */
function movesFlag(ctx: Ctx, shape: MoveShape): boolean {
  for (const id of shape.relocations.keys()) {
    if (ctx.flagIds.has(id)) return true
    const piece = ctx.byId.get(id)
    // A rank we cannot see on our OWN piece never happens in a well-formed view;
    // if it ever did, treat it as the flag rather than gamble the game on it.
    if (!piece || piece.color !== ctx.color || piece.rank === null) return true
  }
  return false
}

/** 攻略 §3 — would this move step OFF a 結算格 we are being paid for? */
function vacatesScoring(ctx: Ctx, shape: MoveShape): boolean {
  for (const [id, to] of shape.relocations) {
    const piece = ctx.byId.get(id)
    if (!piece || piece.square === null) continue
    if (ctx.scoring.has(piece.square) && to !== piece.square) return true
  }
  return false
}

/** How many 結算格 the pieces this move relocates are standing on right now. */
function squaresLeftBehind(ctx: Ctx, shape: MoveShape): number {
  let n = 0
  for (const id of shape.relocations.keys()) {
    const piece = ctx.byId.get(id)
    if (piece && piece.square !== null && ctx.scoring.has(piece.square)) n++
  }
  return n
}

// ---------------------------------------------------------------------------
// Positional terms — small on purpose, they break ties and nothing else
// ---------------------------------------------------------------------------

function nearest(from: Square, targets: readonly Square[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const sq of targets) best = Math.min(best, chebyshev(from, sq))
  return best
}

/** Walking towards a 結算格 we want (攻略 §2, §4, §4-2). One mover only; a castle is not a march. */
function approachBonus(ctx: Ctx, shape: MoveShape): number {
  if (ctx.wanted.length === 0 || shape.relocations.size !== 1) return 0
  const [[id, to]] = [...shape.relocations]
  const piece = ctx.byId.get(id)
  if (!piece || piece.square === null) return 0
  const before = nearest(piece.square, ctx.wanted)
  const after = nearest(to, ctx.wanted)
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0
  const progress = Math.max(-1, Math.min(1, before - after))
  return APPROACH_WEIGHT * ctx.econ.square * progress
}

/**
 * 攻略 §5 — once an enemy 司令 is 翻明, walk the 爆裂物 at it.
 *
 * Weighted by 送達性 (notebook §2.3): the finding was that the answer existed,
 * the position was known, and the carrier could not get there — seven moves in
 * one game, a knight three moves away in another while the 司令 collected five
 * points a turn. A rook bomb therefore gets a ninth of a knight bomb's
 * enthusiasm, which is usually not enough to leave a 結算格 for.
 */
function huntBonus(ctx: Ctx, shape: MoveShape): number {
  const target = ctx.huntSquare
  if (target === null || shape.relocations.size !== 1) return 0
  const [[id, to]] = [...shape.relocations]
  const piece = ctx.byId.get(id)
  if (!piece || piece.square === null || piece.rank !== 'bomb') return 0
  const progress = Math.max(-1, Math.min(1, chebyshev(piece.square, target) - chebyshev(to, target)))
  return HUNT_WEIGHT * ctx.econ.square * DELIVERABILITY[piece.carrier] * progress
}

/**
 * 攻略 §7 — a 翻明 司令 of ours should keep attacking, not hide.
 *
 * 「一顆每手都在吃子的翻明司令，是移動標靶」 (notebook §2.3b). Both answers to a
 * revealed 司令 — their 爆裂物 and their own 司令 — need it to stand still long
 * enough to be reached, so standing still is the mistake. Note that the reveal
 * cost has already gone to zero for this piece: it is public, §4.3 is permanent,
 * and there is nothing left to protect by declining a fight.
 *
 * It does NOT override the park filter, so a 翻明 司令 standing on a 結算格 still
 * refuses to step off it for a fight that gains nothing. That is 攻略 §3 beating
 * 攻略 §7 where they meet, on purpose: §7 is advice for a piece that is otherwise
 * idle, and a 司令 collecting rent is not idle. The bonus applies to every contact
 * that does not cost income — which, for a piece that beats everything, is most
 * of them.
 */
function movingTargetBonus(ctx: Ctx, shape: MoveShape, mover: ViewerPiece | undefined): number {
  if (!mover || !mover.revealed || mover.rank !== 'commander') return 0
  return shape.contact !== undefined ? MOVING_TARGET_WEIGHT * ctx.econ.square : 0
}

// ---------------------------------------------------------------------------
// Valuing one move
// ---------------------------------------------------------------------------

/** null = the move is refused outright, not merely scored low. */
function evaluate(ctx: Ctx, move: Move): number | null {
  const shape = shapeOfMove(ctx.view, ctx.color, move)
  if (!shape) return null
  if (shape.relocations.size === 0) return 0 // pass — the baseline every EV is measured against

  const flagMove = movesFlag(ctx, shape)
  // 攻略 §9, absolute and untested-by-EV: 「絕對不要拿軍旗去撞任何東西」. Moving the
  // 軍旗 onto an occupied square is not a bad move to be priced, it is a
  // resignation (§5.3 + §7④①) — and the one case where it draws instead of
  // losing (軍旗 vs 軍旗) is a lottery ticket, not a plan.
  if (flagMove && shape.contact !== undefined) return null

  const gainSquares = heldScoringAfter(ctx.view, ctx.color, shape) - ctx.held
  const gain = gainSquares * ctx.econ.square
  const contact = shape.contact

  // 攻略 §3 — 「佔到格子之後，除非有更好的理由，不要動它」. A move that steps off a
  // 結算格 without strictly improving the holding is refused. The exception is
  // the only reason that could be better than income: the target might be the
  // 軍旗, and taking it ends the game.
  if (vacatesScoring(ctx, shape) && gainSquares <= 0) {
    const flagChance = contact ? pFlag(ctx.belief(contact.id)) : 0
    if (flagChance * ctx.winValue <= ctx.econ.square) return null
  }

  const moverId = shape.relocations.size === 1 ? [...shape.relocations.keys()][0] : undefined
  const mover = moverId === undefined ? undefined : ctx.byId.get(moverId)

  // Positional terms only. `gain` is added below — unconditionally for a quiet
  // move, and inside the win branch for a contact, because a failed attack never
  // enters the target square at all (§4.1 「攻方從未進入目標格」).
  const positional =
    approachBonus(ctx, shape) + huntBonus(ctx, shape) - RESTLESSNESS_COST * ctx.econ.square

  if (flagMove) {
    // A quiet 軍旗 move is legal and occasionally right — a 軍旗 on a 結算格 scores
    // like anything else (§7.1 「計分不區分兵種」). It is also the piece whose loss
    // ends the game, and this policy cannot see what attacks the destination
    // (no enemy move generation, by design). So: only for a strict gain, and
    // discounted hard enough that almost anything else wins the comparison.
    if (gainSquares <= 0) return null
    return gain + positional - FLAG_RISK * ctx.econ.square
  }

  if (!contact) return gain + positional

  const attackerRank = mover?.rank ?? null
  // Attacking with a piece whose own rank the view did not disclose cannot be
  // priced. It does not happen during play (§10.1 gives us our whole army).
  if (attackerRank === null) return null

  const attackerValue = ctx.valueOf(attackerRank) * ctx.posture.riskAversion
  const denialSquares = contact.square !== null && ctx.scoring.has(contact.square) ? 1 : 0

  const ev = contactEV(attackerRank, ctx.belief(contact.id), {
    squareGain: gain,
    denial: denialSquares * ctx.econ.square * ctx.posture.denialWeight,
    attackerValue,
    attackerSquares: squaresLeftBehind(ctx, shape) * ctx.econ.square,
    // 攻略 §6: winning is 翻明 and 翻明 is permanent (§4.3). The price is the
    // piece's own value against the chance that the opponent still has a 爆裂物
    // that can reach it. And there is a second, quieter bill in the same
    // transaction (notebook §1.3): a 翻明 winner is provably neither 工兵 nor
    // 軍旗, so every fight we win deletes one hiding place for our own 軍旗,
    // publicly and unavoidably. 「贏一場仗，就等於公開縮小自己軍旗的藏身範圍。」
    revealCost: mover?.revealed ? 0 : ctx.valueOf(attackerRank) * ctx.bombThreat,
    winValue: ctx.winValue,
    tradeAppetite: ctx.posture.tradeAppetite,
    valueOf: ctx.valueOf,
  })

  return ev + positional + movingTargetBonus(ctx, shape, mover)
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function chooseMove(view: ViewerState, color: Color, rng: Rng): Move {
  const moves = view.legalMoves
  if (!moves || moves.length === 0) return PASS

  const ctx = contextFor(view, color, rng)

  const scored: { move: Move; ev: number }[] = []
  let best = 0 // pass is always legal (§3④) and always scores 0 — the do-nothing baseline
  for (const move of moves) {
    const ev = evaluate(ctx, move)
    if (ev === null) continue
    scored.push({ move, ev })
    if (ev > best) best = ev
  }

  // The mixing band. Everything within one epsilon of the best is a candidate;
  // nothing below the do-nothing baseline ever is, so the randomisation never
  // reaches for a dominated move — it only refuses to publish which of several
  // equally good moves this bot's 兵種 preferred.
  const floor = Math.max(best - MIXING_BAND_SQUARES * ctx.econ.square, 0)
  const pool = scored.filter((s) => s.ev >= floor).map((s) => s.move)
  if (pool.length === 0) return PASS

  // Sort on a canonical key before drawing: the choice must depend on the seed
  // and the position, never on the order `legalMoves` arrived in.
  pool.sort((a, b) => (moveKey(a) < moveKey(b) ? -1 : moveKey(a) > moveKey(b) ? 1 : 0))
  return rng.pick(pool)
}

// ---------------------------------------------------------------------------
// 佈署 (§9)
// ---------------------------------------------------------------------------

/*
 * 佈署 is `deploy.ts`'s job, plus one doctrine it deliberately does not have.
 *
 * `informedDeployment` already plays 攻略 §9 (軍旗放哪裡), §5 (爆裂物的載體), §8
 * (工兵) and §7 (司令的鏡像交換) as WEIGHTS rather than as a preference order,
 * which is what keeps a deployment random enough to satisfy §9 — 「配置必須為
 * 隨機，不得為固定的預設值」 applies to a bot exactly as it applies to a player,
 * and an argmax over a doctrine table is an opening book with extra steps. None
 * of that is re-derived here.
 *
 * Two adjustments, both stated as disagreements rather than smuggled in:
 *
 * **工兵 doctrine off** (`{ doctrine: { engineer: false } }`). 攻略 §8②'s 防爆佔格
 * puts a 工兵 on the pawn that marches to a 結算格, and against an opponent whose
 * cheapest eviction is a 爆裂物 trade it is exactly right. Every policy in this
 * package evicts with a real 階級 instead, and a 工兵 (階級 9) loses to thirteen
 * of the sixteen. Measured: leaving the doctrine on costs about ten points of win
 * rate against `contest`. This is the same option deploy.ts documents for running
 * one variable at a time — the number above is that experiment.
 *
 * **Income ranks**, `holdTheIncome` below: what the module leaves uniform is
 * every 兵種 nobody has an argument about (軍長 down to 排長), and this policy
 * does have one, because it is the only policy here that both takes 結算格 and
 * expects to be attacked on them.
 *
 * One thing deliberately NOT adjusted, and it is the largest single number
 * measured while building this: FORCING the 司令 onto the queen is worth about
 * thirteen points of win rate against `contest`. It is declined because
 * `COMMANDER_WEIGHTS` argues, correctly, that it is the most stereotyped
 * placement in the game — an opponent who has read the same page suspects the
 * queen first, and none of the baselines reads anything. Buying win rate off
 * opponents that cannot model you, at the price of the one placement a modelling
 * opponent would check first, is exactly the trade notebook §9.5 warns the arena
 * has never actually measured. The experiment is one line for whoever wants it.
 */

/**
 * Concentration of the income doctrine: weight ∝ 階級 value to this power.
 *
 * A BIAS, not a rule, for the §9 reason above. At 3 a 軍長 is roughly forty times
 * likelier than a 排長 to be the piece that walks into the centre, and a 排長 is
 * still perfectly possible — so 「the piece on d4 is one of their best」 is a good
 * read rather than a fact, which is all a deployment should ever concede.
 */
const INCOME_CONCENTRATION = 3

/** Weighted index draw. One `Rng` draw, whatever the weights. */
function weightedIndex(weights: readonly number[], rng: Rng): number {
  let total = 0
  for (const w of weights) total += Math.max(0, w)
  if (total <= 0) return rng.int(weights.length)
  let r = rng.next() * total
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i] ?? 0)
    if (r < 0) return i
  }
  return weights.length - 1
}

/**
 * Put the ranks that can HOLD a 結算格 on the pieces that are going to stand on
 * one — 攻略 §1's 收租, from the defending end.
 *
 * The pieces this touches are exactly the ones `informedDeployment` dealt
 * uniformly — 軍長 down to 排長, plus the 工兵 whose doctrine is switched off
 * above. Every placement it still makes doctrinally (軍旗, 爆裂物, 司令) is left
 * exactly where it put it, so this composes with that module rather than arguing
 * with it. What it changes is which of them rides the pawn that will be standing
 * on d4 on move one.
 *
 * The argument is 攻略 §1 read from the defending end: income is a rate, so a
 * square is worth only what it collects BEFORE somebody takes it back, and the
 * cheapest way to take one back is to attack whatever is standing there. A 結算格
 * held by a 排長 is a square lent to the first piece that tries.
 *
 * Note what it does NOT do: it never moves the 軍旗 (which `informedDeployment`
 * has already kept off marching pawns, weight 0) and never touches a 爆裂物 that
 * doctrine deliberately put on a pawn — a bomb on a 結算格 is 攻略 §4-2's
 * defensive tool, not a mistake to be corrected.
 */
function holdTheIncome(
  base: Record<PieceId, Rank>,
  view: ViewerState,
  color: Color,
  rng: Rng,
): Record<PieceId, Rank> {
  const scoring = scoringSet(view)
  const byId = new Map<PieceId, ViewerPiece>(ownPieces(view, color).map((p) => [p.id, p]))
  const doctrinal = (rank: Rank): boolean =>
    rank === 'flag' || rank === 'bomb' || rank === 'commander'

  // The uniformly dealt half of the deployment, and nothing else.
  const free = ownPieceIds(view, color).filter((id) => {
    const rank = base[id]
    return rank !== undefined && !doctrinal(rank)
  })
  const pool = free.map((id) => base[id] as Rank)
  const marching = shuffled(
    free.filter((id) => {
      const piece = byId.get(id)
      return piece !== undefined && pawnReachesScoring(piece, scoring)
    }),
    rng,
  )
  if (marching.length === 0) return base

  const out: Record<PieceId, Rank> = { ...base }
  const remaining = [...pool]
  for (const id of marching) {
    if (remaining.length === 0) break
    const i = weightedIndex(
      remaining.map((rank) => Math.pow(RANK_WEIGHT[rank], INCOME_CONCENTRATION)),
      rng,
    )
    out[id] = remaining[i] as Rank
    remaining.splice(i, 1)
  }

  const taken = new Set(marching)
  const rest = shuffled(free.filter((id) => !taken.has(id)), rng)
  rest.forEach((id, i) => {
    const rank = remaining[i]
    if (rank !== undefined) out[id] = rank
  })
  return out
}

function chooseDeployment(view: ViewerState, color: Color, rng: Rng): Record<PieceId, Rank> {
  const doctrine = informedDeployment(view, color, rng, { doctrine: { engineer: false } })
  return holdTheIncome(doctrine, view, color, rng)
}

export function makeBeliefPolicy(name = 'belief'): Policy {
  return { name, deploy: chooseDeployment, move: chooseMove }
}

export const beliefPolicy: Policy = makeBeliefPolicy()
