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
 *   攻略 §2   開局是圈地 ................... `approachBonus`, `ARRIVAL_WEIGHT`
 *   攻略 §3   park, don't march ............ the park filter, `RESTLESSNESS_COST`
 *   攻略 §4   behind → uncontested square ... `postureOf`, `wantedSquares`
 *   攻略 §4-2 ahead → contact and denial .... `postureOf.denialWeight`
 *   攻略 §5   hold 爆裂物 for a 翻明 司令 ..... `BOMB_WEIGHT`, `huntBonus`
 *   攻略 §6   winning costs a 翻明 .......... `revealCost`, `bombThreatOf`
 *   攻略 §7   a 翻明 司令 keeps attacking .... `MOVING_TARGET_WEIGHT`
 *   攻略 §9   the 軍旗 never crashes ......... `movesFlag`, absolute
 *   §5.3      the 軍旗 is not hunted .......... `flagThreat`, `flagDefence`
 *
 * 佈署 (§9) is `deploy.ts`'s doctrine plus one addition of this policy's own;
 * see `chooseDeployment` at the bottom.
 *
 * ---------------------------------------------------------------------------
 * What it measures, and what it took to get there
 * ---------------------------------------------------------------------------
 *
 * Against `contest` (1-ply greedy), both seats averaged, 1500 games a seat
 * (5 seeds × 300), and the same figure re-measured for the old weights on the
 * same build so the two columns are comparable:
 *
 *                        中央四格   側翼八格
 *   old weights            47.6%      59.0%
 *   these weights          69.7%      68.6%
 *   worst single seat      67.8%      63.6%
 *
 * (Notebook §10.3 recorded 41.0% / 58.4% for the old weights. That run and this
 * one straddle a change to `deploy.ts`, which both policies feed through, so the
 * 47.6% above is the honest 「before」 for this comparison and 41.0% is the number
 * the acceptance actually failed on. The gap this file closes is the same either
 * way.)
 *
 * Notebook §10.3 diagnosed it correctly and in one number: 平均持格／結算 1.61
 * against contest's 1.99. 「它持有的格子少 19%。」 It was not losing fights, it was
 * not taking squares.
 *
 * The cause was NOT the risk arithmetic. Every EV weight in this file was swept
 * — `revealCost` ×0 to ×2, 兵種 values 0.20 to 0.90 of a 結算格, all three posture
 * swings to zero and to double, `BOMB_WEIGHT` 0.5 to 1.0 — and not one of them
 * moved the win rate by more than the noise on 300 games. The contact pricing
 * was never the problem.
 *
 * The problem was that a 結算格 it did not already stand on was worth almost
 * nothing to it. Both halves of that are documented where they live:
 * `ARRIVAL_WEIGHT` (a square d steps away is worth `square/(1+d)`, so the piece
 * that can actually get there is the piece that moves) and `MIXING_BAND_SQUARES`
 * (the band was as wide as the entire positional signal, so the walk was a coin
 * flip and `pass` was in the pool). Two numbers, no new layer.
 *
 * It still takes 奪旗 wins (§7④①) off the public record — 21 of 600 中央四格 games
 * and 28 of 600 側翼八格 games. Note that this is DOWN as a share of its wins,
 * from about one in five to about one in twenty, and that is the right direction:
 * a 奪旗 is a lottery ticket the loser buys. The old policy cashed them often
 * because it was usually behind.
 *
 * ---------------------------------------------------------------------------
 * 軍旗 defence: what it bought, and what it cost
 * ---------------------------------------------------------------------------
 *
 * The version above LOST GAME 10 on ply 78 — 39–35.5, one settlement from X, its
 * 軍旗 unmoved on d1 with the file empty and a rook on d5, thirteen consecutive
 * passes. It had no term that could ask 「有東西打得到我的軍旗嗎」 (notebook §13.3).
 * `flagThreat` is that term.
 *
 * Against the IDENTICAL policy with `{ flagDefence: false }` — the same file, the
 * same weights, the same seeded streams, one variable — over 1800 games a cell
 * (3 seeds × 300 × both seats):
 *
 *                        中央四格   側翼八格
 *   win rate              51.2%      50.8%      ±1.2
 *   旗負, defended            7          7
 *   旗負, undefended         35         64
 *
 * So: it removes four fifths to nine tenths of the games this policy loses to
 * §7④①, and pays about nothing for it. 「About nothing」 is the honest phrasing —
 * +1.2 and +0.8 are both inside one standard error, so what the measurement
 * supports is 「not worse」, not 「better」. Against `contest`, which never hunts
 * anything and therefore cannot reward the defence at all, it is 68.1% vs 68.8%
 * (中央四格) and 67.0% vs 67.3% (側翼八格) — the price of carrying the machinery,
 * and it is within noise on both boards. 平均持格／結算, the number §10.3's
 * acceptance turned on, is unchanged to two decimals: 1.96 vs 1.97, 3.48 vs 3.49.
 *
 * The first cut was NOT free — see `FLAG_THREAT_DECAY`, which cost two to four
 * points of win rate until it was measured and set to zero. The mechanism was
 * §11.4's, again: a term the size of the positional signal it competed with.
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
 * `view.legalMoves` remains the authority on legality: this file scores moves and
 * never generates them. The cost of that discipline is that the policy is 1 ply
 * deep and cannot see a piece hanging. Stated here so nobody reads the EV
 * arithmetic as more than it is: it prices the contact it is about to make, not
 * the reply.
 *
 * ONE exception, and it is bounded: the 軍旗 threat model (§5.3, and see its own
 * section header) works out which enemy pieces have a route to one square — the
 * square our 軍旗 stands on. `view.legalMoves` is OUR list and cannot answer that,
 * so the geometry is derived directly. It reads carriers and occupancy, both
 * public under §1; it reads no 兵種 at all; and nothing it produces is ever
 * offered as a move this side may play, which is what the rule above is for. The
 * exception exists because §5.3 has no counterpart: every other loss in the game
 * is a bad trade, and that one is the game.
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

import {
  ALL_RANKS,
  fileOf,
  forwardDir,
  inBounds,
  makeSquare,
  opposite,
  pawnDoubleStepRank,
  pawnHomeRank,
  rankOf,
  resolveCombat,
} from '@xiyang/rules'
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

/**
 * ARRIVAL — what a 結算格 is worth to a piece that is not standing on it yet.
 *
 * This is the number that was missing, and it cost 「19% less income」 (notebook
 * §10.3). `APPROACH_WEIGHT` alone is a pure GRADIENT: it pays the same for
 * closing 5→4 as for closing 1→0, so every piece on the board that could take
 * one step towards the centre scored exactly the same, ties went to the mixing
 * band, and the bot wandered. `contest` — which has no valuation at all — beat
 * it here by doing the one thing that is not a gradient: it sends the piece that
 * is CLOSEST, every time.
 *
 * The fix is to price the walk as an OPTION rather than as motion. A 結算格 pays
 * nothing until a piece is standing on it (攻略 §3 「移動經過一個計分格不會得分」),
 * so a piece d steps away holds a claim worth about
 *
 *     econ.square / (1 + d)
 *
 * — the whole square when it arrives, half of it one step out, a fifth of it
 * four steps out. The discount is not impatience; it is failure. Over d plies
 * the square can be taken, the walker can be taken, and the game can end, and
 * every one of those is likelier the longer the walk. So a move is worth the
 * CHANGE in that claim, which is large for the piece about to arrive and nearly
 * nothing for the piece across the board. That is the same instinct `contest`
 * has, derived instead of hardcoded, and it composes with everything else here
 * because it is denominated in 結算格 like every other term.
 *
 * Measured against `contest` over 1500 games a seat: 中央四格 47.6% → 69.7%,
 * 側翼八格 59.0% → 68.6%, and the number §10.3 named — 平均持格／結算 — 1.68 → 1.94
 * while theirs fell 1.87 → 1.52. Nothing else in this file moved the result by
 * more than noise; see the mixing band below, which is the other half of this bug.
 *
 * The plateau is wide (0.45–0.6 measure the same); 0.5 is its middle.
 *
 * Exported for the same reason `MIXING_BAND_SQUARES` is: the relationship
 * BETWEEN the two is the thing that broke, and a test can only pin a
 * relationship if it can see both sides of it.
 */
export const ARRIVAL_WEIGHT = 0.5

/** Walking a 爆裂物 towards a 翻明 司令, per square of progress, times 送達性. 攻略 §5. */
const HUNT_WEIGHT = 0.09
/** A 翻明 司令 of ours gets this for making contact — 「移動標靶」, notebook §2.3b. */
const MOVING_TARGET_WEIGHT = 0.12
/** A quiet 軍旗 move is discounted this hard even when it gains a square. 攻略 §9. */
const FLAG_RISK = 0.6

/**
 * How far ahead the 軍旗 threat search looks, in ENEMY MOVES. §5.3, notebook §13.3.
 *
 * Two, and the ceiling is not a budget — it is where the question stops carrying
 * information. `1` is 「it takes the 軍旗 on its next move」 and `2` is 「it needs
 * one move to line up」, which are exactly the two states worth telling apart. At
 * three, on any board with an open file or diagonal, EVERY enemy slider qualifies
 * against EVERY square: a rook reaches any square on an empty board in two moves,
 * so 「something is three moves from my 軍旗」 is a description of chess, not of a
 * threat. A policy that responded to it would move every ply and never park —
 * which is 攻略 §3's error, bought with 攻略 §9's anxiety.
 *
 * Notebook §13.4 makes the same point from the record: 「兩次防守都極其便宜」. The
 * defence that was missing is the one-tempo defence, and one tempo is what a
 * horizon of two sees.
 */
export const FLAG_THREAT_HORIZON = 2

/**
 * What losing the 軍旗 costs, as a multiple of `winValue`.
 *
 * §5.3: 「軍旗以任何方式離開棋盤，該方立即判負」. There is no other loss in the game
 * on this scale — a 司令 is 0.55 of a 結算格, and a 結算格 is one point a turn. So
 * the comparison a threatened 軍旗 has to win is not against one square, it is
 * against EVERYTHING still on the table, which `winValue` already computes:
 * `max(X − our score, econ.square)`, the points we still have to earn. Four of
 * those, so that a live threat outranks any income this policy can name, including
 * taking a 結算格 outright and including holding every one it already has.
 *
 * Game 10 is the arithmetic in one position: White at 39 of 40, one 結算格 held,
 * so `econ.square` = 1 and `winValue` = 1 — the best move on the board was worth
 * one point and the 軍旗 was worth the game. It passed thirteen times.
 */
export const FLAG_LOSS_WEIGHT = 4

/**
 * What a threat one move further away is worth, per ply of distance.
 *
 * ZERO, and that is a measurement rather than a simplification. The policy sees
 * two-ply threats (`flagThreat` reports them, and the report is what tells a block
 * from a shuffle) and does not pay to pre-empt them.
 *
 * The argument for a small positive value is that a two-ply threat might have no
 * answer once it becomes immediate, so buying the tempo early is worth something.
 * The argument against is that a two-ply threat HAS an answer at two plies: they
 * spend a move lining up, we get a move in between, and the position we answer
 * then is one this same term prices at full weight. Reasoning does not settle it.
 * 1800 games a cell, both seats, both boards, against the identical policy with
 * the defence switched off:
 *
 *                       中央四格   側翼八格   旗負 (def / no def)
 *   decay 0.05            48.6%      46.3%     7,4 / 37,69
 *   decay 0.01            50.1%      46.8%     4,6 / 37,68
 *   decay 0  (this)       51.2%      50.8%     7,7 / 35,64
 *
 * The flag-loss column barely moves — the pre-emption was not what was saving the
 * 軍旗, the immediate response was — and the win rate moves by two to four points.
 * So the whole cost of the defence was in the term that was not needed.
 *
 * The mechanism is notebook §11.4's, exactly: a term sized like a decision that
 * is not one. Early on, half the enemy army is two moves from anything, so the
 * term fires in almost every opening position, and it pays for shuffling pieces
 * around one's own back rank at the moment 攻略 §2 says to be taking the centre.
 * `ARRIVAL_WEIGHT` was worth 22 points precisely because nothing else was
 * competing with the walk; this put something back in its way.
 *
 * Kept as a named constant at 0 rather than deleted, because the horizon it
 * scales is real and the number is the thing that was measured. The invariant a
 * test pins is `FLAG_LOSS_WEIGHT × FLAG_THREAT_DECAY < 1` — a non-immediate threat
 * is worth less than one 結算格, which at 0 is true with room to spare.
 */
export const FLAG_THREAT_DECAY = 0

/**
 * How much of a defence's value the 軍旗 keeps when the 軍旗 itself is the piece
 * that moves. 附錄 A, at the policy layer.
 *
 * 附錄 A binds the RULES: 「任何規則都不得產生依兵種而異的可觀測行為」. A policy
 * that answers every threat by moving one particular piece has re-created exactly
 * that observable, and worse — it publishes the one 兵種 the whole hidden layer
 * exists to protect. 「白方在第 39–77 手 pass 了 13 次」 is bad; 「白方每次有人瞄準
 * d1 就動 d1」 is a name badge.
 *
 * So a block and a flight are both priced, and the flight is priced lower, which
 * means a block wins whenever one exists and the flight still wins whenever it is
 * the only answer. It also costs nothing when the flag is not the answer: the
 * discount only ever applies to a move that relocates the 軍旗.
 */
export const FLAG_FLIGHT_SHARE = 0.6

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
 *
 * **It has to be narrower than the smallest decision the file makes.** At 0.08
 * it was not: it was exactly `APPROACH_WEIGHT`, so the entire positional signal
 * fitted inside the band and every walk towards a 結算格 was a coin flip. Worse,
 * the `Math.max(…, 0)` clamp below meant that whenever the best move was worth
 * less than one band — which is every position where nothing gains a square
 * outright — the floor sat at 0 and `pass` joined the pool. A bot holding no
 * 結算格, with an empty one three steps away, passed about half the time. That
 * is not a mixed strategy, it is a coin deciding the game.
 *
 * At 0.02 the band still covers what it is for — genuine ties, of which this
 * position is full (symmetric pawns, two pieces the same distance from the same
 * square), so the policy still refuses to publish which 兵種 it prefers — and no
 * longer covers the arrival term, which is now allowed to decide. Narrowing the
 * band ALONE is worth about six points on 中央四格; the rest needs
 * `ARRIVAL_WEIGHT` to have something to decide with.
 *
 * What it costs: over real games the policy used to draw from a pool averaging
 * 7.5 moves and played `pass` in 57% of 中央四格 positions while only 2.5% were
 * forced passes. It now averages 1.8, mixes in 38% of positions, and plays `pass`
 * essentially only when `pass` is the pool. Less hidden, and hidden where it
 * matters instead of everywhere.
 */
export const MIXING_BAND_SQUARES = 0.02

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
// 軍旗 defence —「有東西打得到我的軍旗嗎」
//
// The defect notebook §13.3 names, and the only one in the file that is not a
// question of price. §5.3: 「軍旗以任何方式離開棋盤，該方立即判負」. Game 10, ply
// 78: White's 軍旗 had sat on d1 all game with the d-file empty and Black's rook
// on d5, White passed thirteen times at 39 of 40 points, and `d5d1` ended it.
// Any of three moves won instead — a piece to d2/d3/d4, or the queen anywhere off
// the file. The policy had no term that could ask.
//
// ---------------------------------------------------------------------------
// Why this is legitimate, and why it is not a second move generator
// ---------------------------------------------------------------------------
//
// Everything below is CARRIER LAYER. §1 makes 載體層 public to both sides, and
// occupancy is on the board in front of everyone, so 「which enemy pieces have a
// line to this square」 is a fact a 公開觀戰者 holds — the strictest viewer in §10.1
// — and computing it discloses nothing. No 兵種 is read, ours or theirs; the
// belief is not consulted; a 排長 and a 司令 on d5 are the same threat, because
// they take the 軍旗 identically (§2 一律大吃小, and 階級 10 is the floor).
//
// It does mean deriving ENEMY reach from geometry, which `view.legalMoves` cannot
// give us — that list is ours alone, by construction. `policy.ts`'s rule is that a
// policy never generates ITS OWN moves, because the engine already did and a
// second implementation would be a second set of bugs; nothing here is ever
// offered as a move this side may play. It is a valuation of the opponent's reach
// and is used for no other purpose.
//
// Three geometric facts that are easy to get wrong and are each written out below:
//
//   · a pawn CAPTURES diagonally and forward only (§3), so the square it pushes
//     to is never a square it threatens. A pawn in front of the 軍旗 is not a
//     threat; a pawn diagonally behind it is.
//   · EN PASSANT (§4.2) is the one capture whose 接觸格 ≠ 目的格. If the 軍旗 rides
//     a pawn and that pawn DOUBLE-STEPS past an enemy pawn, it can be taken by a
//     capture that lands on the square it skipped. So a 軍旗 double-step has to be
//     tested against the skipped square, not against where the flag ends up.
//   · a slider is stopped by whatever stands between, which is what makes BLOCKING
//     an answer at all — and a block only buys a tempo, because the blocker can be
//     captured. That shows up here as an immediate threat becoming a two-ply one,
//     which is most of the value and honestly not all of it.
//
// The search is deliberately shallow (see `FLAG_THREAT_HORIZON`) and static: it
// assumes nothing else on the board moves. Both directions of that error are
// cheap. It over-counts, in that it lets an enemy piece capture its way to the
// 軍旗 without pricing the contact it would have to win; over-caution about the
// one piece whose loss ends the game is the error to prefer.
// ---------------------------------------------------------------------------

type Step = readonly [number, number]

const ROOK_DIRS: readonly Step[] = [[0, 1], [1, 0], [0, -1], [-1, 0]]
const BISHOP_DIRS: readonly Step[] = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
const QUEEN_DIRS: readonly Step[] = [...ROOK_DIRS, ...BISHOP_DIRS]
const KNIGHT_STEPS: readonly Step[] = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
]

type Occ = readonly (ViewerPiece | undefined)[]

/** The rays a sliding carrier travels on, or null for the three that do not slide. */
function raysOf(carrier: Carrier): readonly Step[] | null {
  switch (carrier) {
    case 'rook': return ROOK_DIRS
    case 'bishop': return BISHOP_DIRS
    case 'queen': return QUEEN_DIRS
    default: return null
  }
}

/** 'rook' / 'bishop' when the two squares share a line, else null. */
function alignment(a: Square, b: Square): 'rook' | 'bishop' | null {
  if (a === b) return null
  const df = fileOf(b) - fileOf(a)
  const dr = rankOf(b) - rankOf(a)
  if (df === 0 || dr === 0) return 'rook'
  if (Math.abs(df) === Math.abs(dr)) return 'bishop'
  return null
}

/** Squares strictly between two ALIGNED squares, ordered from `a` towards `b`. */
function between(a: Square, b: Square): Square[] {
  const df = Math.sign(fileOf(b) - fileOf(a))
  const dr = Math.sign(rankOf(b) - rankOf(a))
  const out: Square[] = []
  let f = fileOf(a) + df
  let r = rankOf(a) + dr
  while (inBounds(f, r) && makeSquare(f, r) !== b) {
    out.push(makeSquare(f, r))
    f += df
    r += dr
  }
  return out
}

function clearBetween(occ: Occ, a: Square, b: Square): boolean {
  return between(a, b).every((sq) => occ[sq] === undefined)
}

/**
 * Would a `carrier` of `color` standing on `from` capture whatever is on `target`?
 *
 * Attack geometry, not move geometry: for every carrier except the pawn they are
 * the same relation, and for the pawn they are emphatically not (§3, §4.2).
 */
function attacksSquare(
  occ: Occ,
  from: Square,
  carrier: Carrier,
  color: Color,
  target: Square,
): boolean {
  if (from === target) return false
  const df = Math.abs(fileOf(target) - fileOf(from))
  const dr = rankOf(target) - rankOf(from)
  switch (carrier) {
    case 'pawn':
      // Diagonal, forward, one square. A pawn NEVER threatens the square ahead of
      // it, which is the single most common way to misread a pawn wall.
      return df === 1 && dr === forwardDir(color)
    case 'knight':
      return (df === 1 && Math.abs(dr) === 2) || (df === 2 && Math.abs(dr) === 1)
    case 'king':
      return df <= 1 && Math.abs(dr) <= 1
    default: {
      const line = alignment(from, target)
      if (line === null) return false
      if (carrier === 'rook' && line !== 'rook') return false
      if (carrier === 'bishop' && line !== 'bishop') return false
      return clearBetween(occ, from, target)
    }
  }
}

/**
 * Every square this enemy carrier could move to right now — the §3 geometry, with
 * occupancy respected and its own colour blocking it.
 *
 * En passant is left out of THIS list on purpose: it can only ever be the capture
 * itself, never a setup move, and the capture is tested separately where the
 * 接觸格 ≠ 目的格 distinction actually matters.
 */
function destinationsOf(occ: Occ, from: Square, piece: ViewerPiece): Square[] {
  const out: Square[] = []
  const color = piece.color
  const f0 = fileOf(from)
  const r0 = rankOf(from)

  const consider = (f: number, r: number): void => {
    if (!inBounds(f, r)) return
    const sq = makeSquare(f, r)
    if (occ[sq]?.color === color) return
    out.push(sq)
  }

  const rays = raysOf(piece.carrier)
  if (rays !== null) {
    for (const [df, dr] of rays) {
      let f = f0 + df
      let r = r0 + dr
      while (inBounds(f, r)) {
        const sq = makeSquare(f, r)
        const other = occ[sq]
        if (other) {
          if (other.color !== color) out.push(sq)
          break
        }
        out.push(sq)
        f += df
        r += dr
      }
    }
    return out
  }

  if (piece.carrier === 'knight') {
    for (const [df, dr] of KNIGHT_STEPS) consider(f0 + df, r0 + dr)
    return out
  }
  if (piece.carrier === 'king') {
    for (const [df, dr] of QUEEN_DIRS) consider(f0 + df, r0 + dr)
    return out
  }

  // pawn (§3): pushes onto EMPTY squares, captures onto occupied ones. Two
  // different relations, which is the whole point of this function existing.
  const dir = forwardDir(color)
  if (inBounds(f0, r0 + dir)) {
    const one = makeSquare(f0, r0 + dir)
    if (occ[one] === undefined) {
      out.push(one)
      if (r0 === pawnHomeRank(color) && inBounds(f0, r0 + 2 * dir)) {
        const two = makeSquare(f0, r0 + 2 * dir)
        if (occ[two] === undefined) out.push(two)
      }
    }
  }
  for (const df of [-1, 1]) {
    if (!inBounds(f0 + df, r0 + dir)) continue
    const sq = makeSquare(f0 + df, r0 + dir)
    const other = occ[sq]
    if (other && other.color !== color) out.push(sq)
  }
  return out
}

/** One enemy piece with a route to our 軍旗, and how long the route is. */
export interface FlagThreat {
  /** where the threatening piece stands now */
  readonly from: Square
  /** its 載體 — public (§1), and all this model ever reads */
  readonly carrier: Carrier
  /**
   * Enemy MOVES until the 軍旗 leaves the board. `1` is a capture available on
   * their very next move; `2` is one move to line up and the capture after it.
   */
  readonly plies: number
  /**
   * The squares strictly between it and the 軍旗 — i.e. where a blocker goes.
   * Non-empty only for an immediate threat by a sliding 載體; a knight, a king and
   * a pawn cannot be blocked at all.
   */
  readonly line: readonly Square[]
  /** the capture would be an en passant (§4.2), so 接觸格 ≠ 目的格 */
  readonly enPassant: boolean
}

export interface FlagThreatReport {
  /** our 軍旗's square, or null when this view does not show one on the board */
  readonly flagSquare: Square | null
  /** every threat inside {@link FLAG_THREAT_HORIZON}, nearest first then by square */
  readonly threats: readonly FlagThreat[]
  /** the nearest of them */
  readonly nearest: FlagThreat | null
  /** the nearest threat's distance in enemy moves; Infinity when there is none */
  readonly plies: number
  /** somebody can take the 軍旗 on their very next move */
  readonly immediate: boolean
}

const NO_THREAT: FlagThreatReport = Object.freeze({
  flagSquare: null,
  threats: Object.freeze([]) as readonly FlagThreat[],
  nearest: null,
  plies: Number.POSITIVE_INFINITY,
  immediate: false,
})

function reportOf(flagSquare: Square | null, threats: FlagThreat[]): FlagThreatReport {
  threats.sort((a, b) => (a.plies !== b.plies ? a.plies - b.plies : a.from - b.from))
  const nearest = threats[0] ?? null
  return {
    flagSquare,
    threats,
    nearest,
    plies: nearest === null ? Number.POSITIVE_INFINITY : nearest.plies,
    immediate: nearest !== null && nearest.plies === 1,
  }
}

/**
 * How many moves this enemy piece needs before the 軍旗 comes off the board.
 *
 * `epSkipped` is the en-passant window (§4.2), non-null only when our 軍旗 rides a
 * pawn that has just double-stepped: an enemy pawn takes it by capturing onto the
 * SKIPPED square, so the target of the diagonal is not the flag's square at all.
 */
function threatFrom(
  occ: (ViewerPiece | undefined)[],
  from: Square,
  piece: ViewerPiece,
  flagSquare: Square,
  epSkipped: Square | null,
): FlagThreat | null {
  const { carrier, color } = piece

  if (attacksSquare(occ, from, carrier, color, flagSquare)) {
    const line = raysOf(carrier) === null ? [] : between(from, flagSquare)
    return { from, carrier, plies: 1, line, enPassant: false }
  }
  if (
    epSkipped !== null
    && carrier === 'pawn'
    && attacksSquare(occ, from, 'pawn', color, epSkipped)
  ) {
    return { from, carrier, plies: 1, line: [], enPassant: true }
  }
  if (FLAG_THREAT_HORIZON < 2) return null

  // One move to line up. The piece has LEFT `from`, so its own origin no longer
  // blocks the ray it is about to shoot down — a rook stepping sideways off the
  // file it wants is the commonest shape of this and would be missed otherwise.
  const origin = occ[from]
  occ[from] = undefined
  try {
    for (const to of destinationsOf(occ, from, piece)) {
      if (attacksSquare(occ, to, carrier, color, flagSquare)) {
        return { from, carrier, plies: 2, line: [], enPassant: false }
      }
    }
  } finally {
    occ[from] = origin
  }
  return null
}

function threatsOn(
  occ: (ViewerPiece | undefined)[],
  flagSquare: Square,
  color: Color,
  epSkipped: Square | null,
): FlagThreatReport {
  const threats: FlagThreat[] = []
  for (let sq = 0; sq < 64; sq++) {
    const piece = occ[sq]
    if (!piece || piece.color === color) continue
    const threat = threatFrom(occ, sq, piece, flagSquare, epSkipped)
    if (threat !== null) threats.push(threat)
  }
  return reportOf(flagSquare, threats)
}

/** Our own 軍旗's square. Ours to read: §10.1 grants a player its whole army. */
function ownFlagSquare(view: ViewerState, color: Color): Square | null {
  let square: Square | null = null
  let id = ''
  for (const p of view.pieces) {
    if (p.color !== color || p.square === null || p.rank !== 'flag') continue
    // Lowest id wins, so a hand-built view with two never depends on array order.
    if (square === null || p.id < id) {
      square = p.square
      id = p.id
    }
  }
  return square
}

/**
 * The en-passant window against our own 軍旗, off the public log (§4.2).
 *
 * In practice this is always null when a policy is asked to move: the window is
 * one ply wide and opens on OUR double step, so on our own turn the last entry is
 * the opponent's. It is computed anyway because `flagThreat` is a statement about
 * a position rather than about a turn, and because the same window IS reachable —
 * by the move this policy is about to consider (see `threatAfter`).
 */
function epWindowFor(view: ViewerState, color: Color, flagSquare: Square): Square | null {
  const last = view.log[view.log.length - 1]
  if (!last || last.color !== color) return null
  if (last.move.kind !== 'move' || last.combat) return null
  const { from, to } = last.move
  if (to !== flagSquare) return null
  if (fileOf(from) !== fileOf(to)) return null
  if (rankOf(from) !== pawnHomeRank(color)) return null
  if (rankOf(to) !== pawnDoubleStepRank(color)) return null
  const mover = view.pieces.find((p) => p.square === to)
  if (!mover || mover.color !== color || mover.carrier !== 'pawn') return null
  return (from + to) / 2
}

/**
 * Can anything reach our 軍旗, from where, and in how many of its moves?
 *
 * The public entry point, and the whole of the model. Pure carrier layer, pure
 * `ViewerState`, no 兵種 read anywhere — see the section header for why that is
 * both sufficient and permitted.
 */
export function flagThreat(view: ViewerState, color: Color): FlagThreatReport {
  const flagSquare = ownFlagSquare(view, color)
  if (flagSquare === null) return NO_THREAT
  const occ = occupancy(view)
  return threatsOn(occ, flagSquare, color, epWindowFor(view, color, flagSquare))
}

/**
 * Squares whose occupancy can change the IMMEDIATE picture — the gate.
 *
 * Every square from which something could bear on the 軍旗: the eight rays walked
 * out to and including the first piece on each (a slider beyond a blocker cannot
 * see the flag, and the blocker's own square is exactly where a line opens when it
 * leaves), plus the knight jumps, plus the two squares an enemy pawn captures from.
 *
 * This is what makes the per-move recomputation affordable, and it is EXACT for
 * the case that matters. A quiet move can only create a new immediate threat by
 * vacating a square that was blocking a ray — such a square is in this set by
 * construction — and can only answer one by landing between, capturing the hunter,
 * or moving the 軍旗. Everything else provably leaves the one-ply picture alone.
 * (Two-ply changes CAN slip past the gate: a piece of ours far from the flag can
 * unblock a route an enemy slider would use to line up. That is a miss and never a
 * false alarm, and a two-ply threat is priced at a twentieth of an immediate one.)
 */
function flagLinesOf(occ: Occ, flagSquare: Square, color: Color): Set<Square> {
  const out = new Set<Square>()
  const f0 = fileOf(flagSquare)
  const r0 = rankOf(flagSquare)
  for (const [df, dr] of QUEEN_DIRS) {
    let f = f0 + df
    let r = r0 + dr
    while (inBounds(f, r)) {
      const sq = makeSquare(f, r)
      out.add(sq)
      if (occ[sq] !== undefined) break
      f += df
      r += dr
    }
  }
  for (const [df, dr] of KNIGHT_STEPS) {
    if (inBounds(f0 + df, r0 + dr)) out.add(makeSquare(f0 + df, r0 + dr))
  }
  // Where an enemy pawn stands to capture onto this square — its own forward
  // direction is the opposite of ours, so it comes from the rank in front of us.
  const theirDir = forwardDir(opposite(color))
  for (const df of [-1, 1]) {
    if (inBounds(f0 + df, r0 - theirDir)) out.add(makeSquare(f0 + df, r0 - theirDir))
  }
  return out
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
  /** square → piece, this ply. Shared with the 軍旗 threat model, which reads it a lot. */
  occ: readonly (ViewerPiece | undefined)[]
  /** our own 軍旗's square, or null if this view does not show one */
  flagSquare: Square | null
  /** can anything reach it, and how soon (§5.3, notebook §13.3) */
  threat: FlagThreatReport
  /** the squares whose occupancy can change that answer — see `flagLinesOf` */
  threatLines: ReadonlySet<Square>
  /** what losing the 軍旗 costs, in points. `FLAG_LOSS_WEIGHT × winValue`. */
  flagLoss: number
  /** per-ply discount on a threat that is not yet immediate */
  threatDecay: number
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

function contextFor(view: ViewerState, color: Color, rng: Rng, opts: BeliefPolicyOptions): Ctx {
  const econ = economyOf(view, color)
  const posture = postureOf(econ)
  const belief = beliefLookup(view, color, rng)
  const mine = ownPieces(view, color)
  const occ = occupancy(view)

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

  const flagSquare = opts.flagDefence === false ? null : ownFlagSquare(view, color)
  const threat = flagSquare === null
    ? NO_THREAT
    : threatsOn(occ.slice(), flagSquare, color, epWindowFor(view, color, flagSquare))

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
    occ,
    flagSquare,
    threat,
    threatLines: flagSquare === null ? new Set<Square>() : flagLinesOf(occ, flagSquare, color),
    flagLoss: (opts.flagLossWeight ?? FLAG_LOSS_WEIGHT) * winValue,
    threatDecay: opts.flagThreatDecay ?? FLAG_THREAT_DECAY,
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
// Positional terms
//
// `huntBonus` and `movingTargetBonus` are tie-breaks and are sized like them.
// `approachBonus` is NOT — it is the valuation of a 結算格 we do not hold yet,
// and on a board where every square is already taken it is the only term that
// can grow the holding at all. It was sized like a tie-break, and that was the
// bug (see `ARRIVAL_WEIGHT`).
// ---------------------------------------------------------------------------

function nearest(from: Square, targets: readonly Square[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const sq of targets) best = Math.min(best, chebyshev(from, sq))
  return best
}

/**
 * What this move does to our claim on the 結算格 we want (攻略 §2, §4, §4-2).
 *
 * Two terms, and they are doing different jobs:
 *
 *   progress · APPROACH_WEIGHT   direction. Signed, clamped to one step, so a
 *                                queen sliding four squares is not four times a
 *                                pawn's step and a retreat is priced as one.
 *   arrival  · ARRIVAL_WEIGHT    distance. `1/(1+d)` is what a square is worth
 *                                to a piece d steps short of it, so the change
 *                                in it is worth most to the piece that is about
 *                                to arrive and almost nothing to the one across
 *                                the board. This is what makes the CLOSEST piece
 *                                the one that walks — see `ARRIVAL_WEIGHT`.
 *
 * Both are denominated in 結算格 and multiplied by `econ.square`, like every
 * other value in this file, so the walk shrinks correctly as the game shortens.
 *
 * One mover only; a castle is not a march.
 */
function approachBonus(ctx: Ctx, shape: MoveShape): number {
  if (ctx.wanted.length === 0 || shape.relocations.size !== 1) return 0
  const [[id, to]] = [...shape.relocations]
  const piece = ctx.byId.get(id)
  if (!piece || piece.square === null) return 0
  const before = nearest(piece.square, ctx.wanted)
  const after = nearest(to, ctx.wanted)
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0
  const progress = Math.max(-1, Math.min(1, before - after))
  const arrival = 1 / (1 + after) - 1 / (1 + before)
  return ctx.econ.square * (APPROACH_WEIGHT * progress + ARRIVAL_WEIGHT * arrival)
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
// 軍旗 defence, as a move term
// ---------------------------------------------------------------------------

/** Points at stake when the nearest threat is `plies` enemy moves away. */
function threatValue(ctx: Ctx, plies: number): number {
  if (!Number.isFinite(plies) || plies > FLAG_THREAT_HORIZON) return 0
  return ctx.flagLoss * Math.pow(ctx.threatDecay, plies - 1)
}

/** Would this move relocate our 軍旗 by a double step, opening an §4.2 window? */
function flagDoubleStep(ctx: Ctx, shape: MoveShape): Square | null {
  if (ctx.flagSquare === null) return null
  for (const [id, to] of shape.relocations) {
    const piece = ctx.byId.get(id)
    if (!piece || piece.square !== ctx.flagSquare || piece.carrier !== 'pawn') continue
    if (rankOf(piece.square) !== pawnHomeRank(ctx.color)) continue
    if (fileOf(to) !== fileOf(piece.square)) continue
    if (rankOf(to) !== pawnDoubleStepRank(ctx.color)) continue
    return (piece.square + to) / 2
  }
  return null
}

/**
 * The threat picture after this move, on the position the move would produce.
 *
 * Optimistic about a contact in exactly the way `heldScoringAfter` is: the
 * attacker is assumed to survive and occupy. The caller pays for that assumption
 * by scaling the resulting credit by the odds it holds (§4.1 — a losing attacker
 * never enters the target square, so a block that loses is not a block).
 */
function threatAfter(ctx: Ctx, shape: MoveShape): FlagThreatReport {
  if (ctx.flagSquare === null) return NO_THREAT
  const occ = ctx.occ.slice()

  let flagSquare = ctx.flagSquare
  for (const [id] of shape.relocations) {
    const piece = ctx.byId.get(id)
    if (piece?.square != null) occ[piece.square] = undefined
  }
  // The 接觸格 is not always the 目的格 (§4.2), so the victim is cleared by ITS
  // square rather than by where we land.
  if (shape.contact?.square != null) occ[shape.contact.square] = undefined
  for (const [id, to] of shape.relocations) {
    const piece = ctx.byId.get(id)
    if (!piece) continue
    occ[to] = piece
    if (piece.square === ctx.flagSquare) flagSquare = to
  }

  return threatsOn(occ, flagSquare, ctx.color, flagDoubleStep(ctx, shape))
}

/**
 * What this move does to the 軍旗's safety, in points. The §13.3 fix.
 *
 * A DELTA — `value(now) − value(after)` — rather than a penalty on positions that
 * stay dangerous, and the difference matters in both directions. A penalty would
 * tax every move equally in a lost-looking position, including the move that takes
 * the ENEMY 軍旗 and ends the game in our favour; a delta leaves every move that
 * changes nothing at exactly its own EV, which keeps `pass` at the zero baseline
 * `chooseMove` measures against. It is also symmetric for free: a quiet move that
 * vacates a blocking square, or a 軍旗 that steps somewhere still covered, prices
 * as the negative it is.
 *
 * The gate is `threatLines`: for every other move the one-ply picture provably
 * cannot have changed, and the delta is zero without recomputing anything.
 */
function flagDefence(ctx: Ctx, shape: MoveShape): number {
  if (ctx.flagSquare === null) return 0

  let gated = shape.contact !== undefined || movesFlag(ctx, shape)
  if (!gated) {
    for (const [id, to] of shape.relocations) {
      const piece = ctx.byId.get(id)
      if (piece?.square != null && ctx.threatLines.has(piece.square)) gated = true
      if (ctx.threatLines.has(to)) gated = true
    }
  }
  if (!gated) return 0

  const delta = threatValue(ctx, ctx.threat.plies) - threatValue(ctx, threatAfter(ctx, shape).plies)
  if (delta <= 0) return delta

  // 附錄 A at the policy layer — see `FLAG_FLIGHT_SHARE`. Only a move that
  // relocates the 軍旗 pays it, so blocking is strictly the cheaper answer and the
  // bot does not answer every threat by moving one identifiable piece.
  return movesFlag(ctx, shape) ? delta * FLAG_FLIGHT_SHARE : delta
}

/**
 * How much of a defensive contact actually happens. §4.1, §7④①.
 *
 * A defence that has to win a fight first only defends in the worlds where it
 * wins. Two shapes, and they take different odds: hitting the hunter itself is
 * answered by 同歸於盡 as well as by winning (both pieces leave, the hunt is over),
 * while blocking by capturing something else needs our piece to survive AND stand
 * on the square — 「攻方從未進入目標格」 otherwise.
 *
 * And a third, which is not a defence at all until you look at it: taking THEIR
 * 軍旗 ends the game in our favour on the spot (§7④①), so in that slice of the
 * belief every threat to ours is answered as completely as by any block. Without
 * this term the arithmetic inverts in the one position where it is most obviously
 * wrong — a piece the pool has cornered as their 軍旗, while ours is under fire —
 * because a block is priced at `FLAG_LOSS_WEIGHT × winValue` and winning outright
 * is priced at `winValue`. Rare to the point of never; still an inversion, and it
 * costs one term to remove.
 */
function defenceCredit(ctx: Ctx, defence: number, attacker: Rank, contact: ViewerPiece): number {
  // A move that makes things WORSE is priced at full weight rather than at the
  // odds it happens: over-caution about the 軍旗 is the error to prefer.
  if (defence <= 0) return defence
  const odds = branchOdds(attacker, ctx.belief(contact.id))
  const hunter = ctx.threat.threats.some((t) => t.from === contact.square)
  const survives = hunter ? odds.win + odds.mutual : odds.win
  return defence * survives + threatValue(ctx, ctx.threat.plies) * odds.flagWin
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
  // losing (軍旗 vs 軍旗) is a lottery ticket, not a plan. It stays absolute when
  // the 軍旗 is being hunted: a flag that runs into a piece has lost the game it
  // was running from.
  if (flagMove && shape.contact !== undefined) return null

  const gainSquares = heldScoringAfter(ctx.view, ctx.color, shape) - ctx.held
  const gain = gainSquares * ctx.econ.square
  const contact = shape.contact
  const defence = flagDefence(ctx, shape)

  // 攻略 §3 — 「佔到格子之後，除非有更好的理由，不要動它」. A move that steps off a
  // 結算格 without strictly improving the holding is refused. There are exactly
  // two reasons better than income, and they are the two ways the game ends:
  // the target might be the 軍旗 (§7④①), or ours might be about to leave the
  // board (§5.3). Game 10 needed the second one — 白 held e4 with the king and
  // `e4d4` both kept the income and blocked the file, and the park filter as it
  // stood refused it before any of this was priced.
  if (vacatesScoring(ctx, shape) && gainSquares <= 0 && defence <= 0) {
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
    // ends the game, so: only for a strict gain, or to get out of the way of
    // something that can actually reach it, and discounted either way.
    //
    // The second clause is what `FLAG_RISK`'s original comment was standing in
    // for — 「this policy cannot see what attacks the destination」 was true and is
    // no longer: `flagDefence` prices the destination on the position the move
    // produces, so a 軍旗 fleeing along the line it is being hunted down, or onto
    // a square the same piece also covers, scores no defence and is refused here.
    if (gainSquares <= 0 && defence <= 0) return null
    return gain + positional + defence - FLAG_RISK * ctx.econ.square
  }

  if (!contact) return gain + positional + defence

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
    + defenceCredit(ctx, defence, attackerRank, contact)
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function chooseMove(view: ViewerState, color: Color, rng: Rng, opts: BeliefPolicyOptions): Move {
  const moves = view.legalMoves
  if (!moves || moves.length === 0) return PASS

  const ctx = contextFor(view, color, rng, opts)

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

/**
 * Switches, for measurement rather than for play.
 *
 * Notebook §9.5's standing complaint is that an unmeasured layer is a story, and
 * §11.2 is what happens when you measure one: half the deployment doctrine turned
 * out to be worth negative win rate. So the 軍旗 defence ships with an off switch,
 * because 「never loses its 軍旗」 and 「wins more games」 are different claims and
 * only an A/B tells them apart.
 */
export interface BeliefPolicyOptions {
  /**
   * Ask whether anything can reach our 軍旗, and pay to stop it (§5.3, §13.3).
   *
   * Default on. Off reproduces the policy that lost game 10: the threat report is
   * never built, every defence delta is zero, and the park filter and the 軍旗
   * filter fall back to their income-only forms. It costs no `Rng` draws either
   * way, so the two variants stay on the same seeded stream and a paired
   * comparison really is one variable.
   */
  readonly flagDefence?: boolean
  /**
   * Override {@link FLAG_LOSS_WEIGHT} / {@link FLAG_THREAT_DECAY}.
   *
   * Not for play — for the sweep. §11.2 measured six deployment doctrines one at
   * a time and found two of them worth NEGATIVE win rate; the only way that was
   * ever going to be visible is a switch per doctrine. The 軍旗 defence has two
   * numbers in it and they answer different questions (「how much is the game
   * worth」 and 「how twitchy is it」), so they turn separately.
   */
  readonly flagLossWeight?: number
  readonly flagThreatDecay?: number
}

export function makeBeliefPolicy(name = 'belief', opts: BeliefPolicyOptions = {}): Policy {
  return {
    name,
    deploy: chooseDeployment,
    move: (view, color, rng) => chooseMove(view, color, rng, opts),
  }
}

export const beliefPolicy: Policy = makeBeliefPolicy()

/** The pre-§13.3 policy, kept nameable so the fix can be measured against it. */
export const beliefNoFlagDefencePolicy: Policy = makeBeliefPolicy('belief-nodef', {
  flagDefence: false,
})
