/**
 * The reply layer — 「我走完這一手，他回一手，會發生什麼事？」
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to remove, measured
 * ---------------------------------------------------------------------------
 *
 * `belief` beats `contest` on holdings (1.918 against 1.507) and yet applies
 * LESS pressure to a human than `contest` does — in real games it held 1.292
 * where `contest` held 1.905. The cause is not the contact arithmetic, which was
 * swept: it is that the policy is ONE PLY deep. It prices the contact it is about
 * to make and never asks what the opponent does next, so a capture that wins a
 * 結算格 and loses it straight back scores as a clean win. Its own header admits
 * it: 「it prices the contact it is about to make, not the reply」.
 *
 * This module is the reply. Pure functions, no policy weights, no move choice —
 * it answers two questions and hands them back:
 *
 *   `replyRisk(view, color, belief, move)`      after I play this, what can they do?
 *   `squareSafety(view, color, belief, sq, n)`  can anything reach this square at all?
 *
 * ---------------------------------------------------------------------------
 * Why the second question is not the first one repeated
 * ---------------------------------------------------------------------------
 *
 * Notebook §15.1: a human parked their 軍旗 on d5 — a 結算格 in the OPPONENT's
 * half — from move 27 to the end, collected eleven settlements, and won.
 * 「它為什麼活下來：不是因為隱蔽，是因為黑方沒有棋子構得到 d5。」 Every document in
 * the project treats the 軍旗 as a pure liability, and §7.1 says plainly 計分不區分
 * 兵種 — it collects rent like anything else. The risk of parking it is not a mood,
 * it is 「有沒有棋子能走到那一格」, which is pure 載體層 and therefore computable.
 * `squareSafety` is that computation, and it is what makes 軍旗 income assessable
 * instead of a gamble.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE GEOMETRY COMES FROM, and it is not from here
 * ---------------------------------------------------------------------------
 *
 * `@xiyang/rules` exports `carrierMoves(vs, color)` and `reachableSquares(vs,
 * color)`: legal moves for EITHER side, from a redacted `ViewerState`. That is
 * sound because move legality never touches the 兵種 layer — gamebook §1 splits
 * 載體層 (how it moves) from 兵種層 (what it beats), 附錄 A requires the legal move
 * set to be identical whatever 兵種 a piece carries, and `publicmoves.test.ts`
 * proves the equality directly against the authoritative generator.
 *
 * So there is NO movement geometry in this file. No knight offsets, no slider
 * rays, no pawn-capture special case. Every question of the form 「can that piece
 * get to that square」 is asked by constructing the position and calling the
 * engine. Two hand-rolled copies of the movement rules already exist in this
 * repository (the engine's, and the approximation inside `flagThreat`); a third
 * would be a bug farm, and the pawn is where it would bite — a pawn captures
 * diagonally and pushes forward, and en passant (§4.2) is the one capture in the
 * game whose 接觸格 is not its 目的格.
 *
 * What the engine will NOT give us is any 兵種 information. It answers 「where can
 * that piece go」, never 「would it win」. Combat still needs a belief, and that is
 * the caller's, threaded in.
 *
 * ---------------------------------------------------------------------------
 * NOT the worst case. That is the whole point.
 * ---------------------------------------------------------------------------
 *
 * A bot that treats every enemy piece as a 司令 contests nothing, and contesting
 * nothing is the passivity being fixed — notebook §9.1 is explicit that `greedy`
 * and `contest` are 量測儀器, not opponents, and the reason `belief` exists is to
 * be a player. So every attacker's threat is priced against the BELIEF over its
 * 兵種. An unknown enemy piece attacking our 旅長 removes it about 37% of the time
 * under the flat 數量表 prior, not 100%; the same piece attacking our 排長 removes
 * it about 75% of the time. Those two numbers are different decisions, and a
 * worst-case model erases the difference.
 *
 * One place a maximum IS taken, and it is over CHOICES rather than over ranks:
 * the opponent gets exactly one reply, so `pHoldsAfterReply` is
 * `1 − max(P(removes mine))` over the available replies, never a product over
 * them. A product would model every enemy piece attacking at once.
 *
 * ---------------------------------------------------------------------------
 * Absolute, not a delta
 * ---------------------------------------------------------------------------
 *
 * `expectedLoss` is the loss expected in the position the move PRODUCES, over all
 * of our pieces, not the change from the position we are in. If it were a delta,
 * `pass` would price at exactly zero and the same passivity would come back
 * through the other door — a policy that avoids contact because contact is the
 * only thing that scores badly. Comparing candidates then means comparing
 * absolutes, which is what a policy already does with `contactEV`.
 *
 * ---------------------------------------------------------------------------
 * The two-ply number is REPORTED and must not be PRICED like the one-ply number
 * ---------------------------------------------------------------------------
 *
 * Notebook §14.2 and §11.4 record the same trap twice, and it cost two to four
 * points of win rate the first time: **a term whose weight is the size of the
 * signal it competes with, firing in almost every position.** 「一個項的權重必須
 * 小於它所競爭的訊號，而且觸發頻率必須低於它的重要性。」 On any open board every
 * slider is two moves from every square, so 「something can reach here in two」 is a
 * description of chess, not a threat. `FLAG_THREAT_DECAY` was measured at exactly
 * ZERO for this reason.
 *
 * This module therefore keeps the two horizons in separate fields — `pHolds1` and
 * `pHolds2` — and offers `unreachable` as a BOOLEAN rather than as a weight.
 * 「nothing on the board can touch this square inside the horizon」 is the §15.1
 * question and it is a fact; 「something could line up」 is nearly always true and
 * is worth approximately nothing, because the answer to a two-ply threat is the
 * move you get in between. A caller that multiplies `pHolds2` into a value the
 * way it multiplies `pHolds1` will reproduce §14.2's regression exactly.
 *
 * ---------------------------------------------------------------------------
 * The lens, and determinism
 * ---------------------------------------------------------------------------
 *
 * Input is a `ViewerState` and a belief computed from one. There is no
 * `GameState` here, no hidden rank, no back channel. Our OWN 兵種 are read, which
 * §10.1 grants us.
 *
 * No `Math.random`, and no `Rng` either — nothing in this file draws. Every
 * number is a deterministic function of (view, colour, belief, move); the
 * sampling already happened in `beliefFor`, upstream, on the caller's seeded
 * stream. Every list this module returns is sorted on a canonical key so that
 * output never depends on the order the engine happened to generate moves in.
 */

import {
  ALL_RANKS,
  RANK_NAMES_ZH,
  carrierMoves,
  opposite,
  promotionRank,
  rankOf,
  reachableSquares,
  resolveCombat,
  squareName,
} from '@xiyang/rules'
import type {
  Carrier,
  Color,
  GameEvent,
  Move,
  PieceId,
  Rank,
  Square,
  ViewerPiece,
  ViewerState,
} from '@xiyang/rules'

import { priorBelief } from './belief.js'
import { moveKey, occupancy, shapeOfMove } from './policy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A distribution over 兵種 for one piece.
 *
 * Deliberately `Partial`, so a caller can hand in a literal `{ commander: 1 }`
 * — which is how the tests pin §5.4 and §7④① without manufacturing a position —
 * and so `belief.ts`'s `RankBelief` (a full `Record`) is assignable to it.
 */
export type RankProbs = Readonly<Partial<Record<Rank, number>>>

/**
 * `PieceId → P(兵種)`, for the ENEMY army.
 *
 * Structurally identical to the `BeliefLookup` `policies/belief.ts` builds out of
 * `beliefFor`, so that value passes straight in. The lookup is a parameter and
 * never computed here: `beliefFor` samples, so calling it per candidate move
 * would make the number of draws depend on how many moves happened to be legal
 * and a replay would need the move list to reproduce the dice.
 */
export type BeliefLookup = (id: PieceId) => RankProbs

/**
 * What a contact does, from OUR side, over both sides' 兵種 distributions.
 *
 * Every branch is decided by the engine's own `resolveCombat` (§4, §5) — see
 * `SURVIVES`. techspec §7 says 「The client must not implement rules」 and a bot is
 * a client; a private combat table would disagree with the engine exactly on the
 * 爆裂物 cases that matter most (§5.4's 雙向 immunity, and 同歸於盡's three
 * indistinguishable forms).
 */
export interface ContactOdds {
  /** P(their piece wins outright — ours leaves the board, theirs stands) */
  readonly theyWin: number
  /** P(同歸於盡 — both leave). §4.3 makes its three causes one event. */
  readonly mutual: number
  /** P(our piece wins — theirs leaves, ours stands) */
  readonly weWin: number
  /** P(our piece comes off the board at all) — `theyWin + mutual`. */
  readonly mineLost: number
  /** P(their piece comes off the board at all) — `weWin + mutual`. */
  readonly theirsLost: number
}

/** One enemy reply that makes contact with a piece of ours. */
export interface ReplyAttacker {
  readonly id: PieceId
  /** where it stands, before it replies */
  readonly from: Square
  /** the square it would move ONTO */
  readonly to: Square
  /**
   * The square our piece is standing on — its 接觸格.
   *
   * Equal to `to` for every capture in the game except en passant (§4.2), where
   * the attacker lands on the square our pawn skipped and our pawn dies on a
   * different square entirely. A destination-square test misses it.
   */
  readonly contactSquare: Square
  readonly enPassant: boolean
  /** 載體層, public to both sides (§1) */
  readonly carrier: Carrier
  /** 翻明 — its 兵種 is permanently public (§4.3), so the belief is a point mass */
  readonly revealed: boolean
  readonly odds: ContactOdds
  /** one line, so a caller can say WHY */
  readonly why: string
}

/** A piece of ours the opponent could hit on their next move. */
export interface ExposedPiece {
  readonly id: PieceId
  readonly square: Square
  /** ours to read — §10.1 grants a player its whole army */
  readonly rank: Rank | null
  readonly carrier: Carrier
  /** standing on a 結算格 (§7.1), so losing it costs income as well as material */
  readonly onScoring: boolean
  /** it is our 軍旗 — losing it loses the game outright (§5.3, §7④①) */
  readonly isFlag: boolean
  /** every reply that reaches it, most dangerous first */
  readonly attackers: readonly ReplyAttacker[]
  /** P(it is still standing after their single best reply at it) */
  readonly pHolds: number
  /** nothing could reach it BEFORE the move — this move created the exposure */
  readonly newlyExposed: boolean
  /** it is not a piece this move relocated — i.e. the exposure is collateral */
  readonly collateral: boolean
  /** expected points lost to the best reply aimed at this piece; see `LookaheadOptions.rankValue` */
  readonly expectedLoss: number
  readonly why: string
}

/** What the opponent can do about a move of ours. */
export interface ReplyRisk {
  readonly move: Move
  /**
   * False when the gate skipped this move (see `needsReplyAnalysis`). Every
   * number below is then its neutral value — `pHoldsAfterReply` 1, `expectedLoss`
   * 0 — and MUST NOT be read as 「safe」. It means 「not asked」.
   */
  readonly analysed: boolean
  /** the piece whose exposure `pHoldsAfterReply` is about, or null for a pass */
  readonly mover: PieceId | null
  /** where that piece ends up */
  readonly square: Square | null
  readonly moverRank: Rank | null
  /** the replies that reach `square`, most dangerous first */
  readonly attackers: readonly ReplyAttacker[]
  /** P(the moved piece is still standing after their single best reply) */
  readonly pHoldsAfterReply: number
  /** the reply likeliest to remove it, or null when nothing reaches it */
  readonly worst: ReplyAttacker | null
  /** EVERY piece of ours they could hit afterwards, most costly first */
  readonly exposed: readonly ExposedPiece[]
  /** expected points lost to their single best reply anywhere on the board */
  readonly expectedLoss: number
  /** the piece that loss falls on */
  readonly costliest: ExposedPiece | null
  readonly why: string
}

/** An enemy piece that cannot reach a square yet, but is one move from being able to. */
export interface LiningThreat {
  readonly id: PieceId
  /** where it stands now */
  readonly from: Square
  /** where it stands once the setup move has been played */
  readonly after: Square
  readonly carrier: Carrier
  /** the enemy move that puts it in place — or that clears the way for it */
  readonly setup: Move
  /** the setup move was made by a DIFFERENT piece: this is a discovered line */
  readonly discovered: boolean
  readonly odds: ContactOdds
  readonly why: string
}

/** How exposed a piece standing on one square is. */
export interface Safety {
  readonly square: Square
  /** the horizon asked for, in ENEMY moves */
  readonly plies: number
  /** the piece standing there, or null when the occupant is hypothetical */
  readonly occupant: PieceId | null
  readonly occupantRank: Rank | null
  /** no piece of ours stands there; the answer is for a piece that arrives */
  readonly hypothetical: boolean
  readonly onScoring: boolean
  /** the occupant is our 軍旗 — §15.1's question, and §7④①'s stake */
  readonly isFlag: boolean
  /** replies that take it on the opponent's very NEXT move */
  readonly attackers: readonly ReplyAttacker[]
  /** P(it survives one enemy move) */
  readonly pHolds1: number
  /** pieces one move from being able to take it. Empty unless `plies >= 2`. */
  readonly lining: readonly LiningThreat[]
  /**
   * Whether the two-ply search actually ran. It is skipped when something can
   * already take the square this ply — an immediate threat dominates, and the
   * search is the expensive half.
   */
  readonly liningSearched: boolean
  /**
   * P(it survives two enemy moves) — **assuming we stand still in between**,
   * which we do not. Read `unreachable` for decisions and see the file header:
   * pricing this the way `pHolds1` is priced reproduces notebook §14.2's
   * regression, where pre-empting two-ply threats cost 2–4 points of win rate and
   * saved no 軍旗.
   */
  readonly pHolds2: number
  /** `pHolds1` when `plies` is 1, `pHolds2` when it is 2 or more */
  readonly pHolds: number
  /**
   * Nothing on the board can touch this square inside the horizon.
   *
   * The §15.1 condition, deliberately a boolean: 「黑方沒有棋子構得到 d5」 is a
   * fact about the position, and a fact is safe to act on where a small
   * continuous weight is not.
   */
  readonly unreachable: boolean
  readonly why: string
}

/**
 * How much of the move list to analyse.
 *
 * Constructing a post-move view is not free — it costs one engine move
 * generation per candidate — so the default gate is the one the income question
 * needs and nothing more.
 */
export type Gate =
  /** contact, 結算格 taken or left, or a line onto income possibly opened. Default. */
  | 'income'
  /** the above, plus any move whose destination the opponent can already reach */
  | 'exposed'
  /** everything, pass included */
  | 'all'

export interface LookaheadOptions {
  readonly gate?: Gate
  /**
   * Points per 兵種, for BOTH armies — the caller's valuation, because there is no
   * exchange table in the gamebook and there cannot be one (攻略 §1: 子力 buys
   * nothing directly).
   *
   * Applied exactly to our own pieces, whose 兵種 we know (§10.1), and in
   * expectation over the belief for theirs. Default: every 兵種 worth 1, which
   * makes `expectedLoss` a material count — 「pieces, net」 — rather than points.
   * `policies/belief.ts` should pass its own `ctx.valueOf`, which is denominated
   * in 結算格 and already prices 軍旗 at `winValue`.
   */
  readonly rankValue?: (rank: Rank) => number
  /**
   * What one 結算格 is worth, added to the stake of any of our pieces standing on
   * one (§7.1 — a settlement pays per piece per square). Default 0.
   */
  readonly squareValue?: number
  /** per-ply memo; see `makeLookaheadCache`. */
  readonly cache?: LookaheadCache
  /**
   * `squareSafety` only: the 兵種 to assume for a piece that is not there yet.
   *
   * Without it a hypothetical occupant is priced with this game's 數量表 prior
   * (附錄 B), which answers 「how safe is this square for an average piece」. Pass
   * `'flag'` to ask §15.1's actual question.
   */
  readonly occupantRank?: Rank
}

/** What the analysis cost. Exposed so the budget can be measured rather than assumed. */
export interface LookaheadStats {
  /** calls into the engine's move generator — the dominant cost */
  generations: number
  /** post-move `ViewerState`s constructed */
  postViews: number
  /** analyses answered from the memo instead of recomputed */
  hits: number
  replies: number
  safeties: number
}

/**
 * A per-ply memo.
 *
 * Both entry points run per candidate move per ply and both ask the same
 * questions repeatedly — 「what does the opponent reach from here」 is asked once
 * per candidate and is the same answer every time. The cache is keyed on the
 * `view` OBJECT: the harness hands a policy a fresh deep copy each ply
 * (`policy.ts`), so reference identity is a free and exact ply fingerprint, and a
 * caller can hold one cache for a whole game without ever having to clear it.
 */
export interface LookaheadCache {
  view: ViewerState | null
  color: Color | null
  picture: EnemyPicture | null
  reply: Map<string, ReplyRisk>
  safety: Map<string, Safety>
  stats: LookaheadStats
}

/** The two questions, bound to one position and one belief. */
export interface Lookahead {
  readonly view: ViewerState
  readonly color: Color
  readonly cache: LookaheadCache
  readonly stats: LookaheadStats
  needsReplyAnalysis(move: Move): boolean
  replyRisk(move: Move): ReplyRisk
  squareSafety(square: Square, plies?: number, occupantRank?: Rank): Safety
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How far `squareSafety` will look, in ENEMY moves.
 *
 * Two, and the ceiling is where the question stops carrying information rather
 * than where the budget runs out — the same argument `FLAG_THREAT_HORIZON` makes.
 * `1` is 「it takes the square on its next move」 and `2` is 「it needs one move to
 * line up」, which are exactly the two states worth telling apart: the second is
 * what a park has to survive (§15.1's d5 survived eleven settlements) and the
 * first is what it cannot. At three, every slider on an open board qualifies
 * against every square.
 */
export const SAFETY_HORIZON = 2

/** The id of the stand-in piece `squareSafety` puts on an empty square. */
const PROBE_ID = '@probe'

/**
 * The engine's combat answers, memoised once per ordered pair of 兵種.
 *
 * NOT a second combat table — every entry is `resolveCombat`'s own output,
 * computed at load and never re-derived. It exists because `contactOddsBetween`
 * runs over both sides' distributions for every attacker of every candidate move,
 * and 121 engine calls per attacker is a cost with no information in it.
 */
const SURVIVES: readonly (readonly { attacker: boolean; defender: boolean }[])[] =
  ALL_RANKS.map((a) =>
    ALL_RANKS.map((d) => {
      const res = resolveCombat(a, d, 'white', 'black')
      // Colours only label a 有煙無傷's announced survivor (§4.3), which is not
      // read here; survival depends on the pair of 兵種 and not on who moved.
      return { attacker: res.attackerSurvives, defender: res.defenderSurvives }
    }),
  )

const POINT_MASS: Readonly<Record<Rank, RankProbs>> = (() => {
  const out = {} as Record<Rank, RankProbs>
  for (const r of ALL_RANKS) out[r] = Object.freeze({ [r]: 1 }) as RankProbs
  return Object.freeze(out)
})()

const NO_ODDS: ContactOdds = Object.freeze({
  theyWin: 0,
  mutual: 0,
  weWin: 0,
  mineLost: 0,
  theirsLost: 0,
})

// ---------------------------------------------------------------------------
// Combat arithmetic over two distributions
// ---------------------------------------------------------------------------

function totalOf(probs: RankProbs): number {
  let total = 0
  for (const r of ALL_RANKS) total += probs[r] ?? 0
  return total
}

/**
 * What happens when a piece of ours drawn from `mine` is attacked by a piece of
 * theirs drawn from `theirs`.
 *
 * Both sides are distributions, which is not decoration: our own 兵種 is normally
 * a point mass (§10.1 gives us our army), but `squareSafety` is routinely asked
 * about a piece that is not standing there yet, and 「how safe is this square」 for
 * an unknown arrival is a real question with a real answer.
 *
 * Their piece is the ATTACKER because this module is about the reply. The
 * direction does not change who survives — §5.4's immunity is explicitly 雙向 and
 * §2's 一律大吃小 has no attacker bonus — but it is passed truthfully anyway.
 *
 * Degenerate inputs (an empty or unnormalised distribution) are rescaled rather
 * than trusted, so a belief that lost its mass produces a vague answer instead of
 * a silent zero that reads as safety.
 */
export function contactOddsBetween(mine: RankProbs, theirs: RankProbs): ContactOdds {
  const mineTotal = totalOf(mine)
  const theirTotal = totalOf(theirs)
  if (mineTotal <= 0 || theirTotal <= 0) return NO_ODDS

  let theyWin = 0
  let mutual = 0
  let weWin = 0

  for (let ti = 0; ti < ALL_RANKS.length; ti++) {
    const pt = (theirs[ALL_RANKS[ti]!] ?? 0) / theirTotal
    if (pt <= 0) continue
    const row = SURVIVES[ti]!
    for (let mi = 0; mi < ALL_RANKS.length; mi++) {
      const pm = (mine[ALL_RANKS[mi]!] ?? 0) / mineTotal
      if (pm <= 0) continue
      const cell = row[mi]!
      const p = pt * pm
      if (cell.attacker && !cell.defender) theyWin += p
      else if (!cell.attacker && cell.defender) weWin += p
      else mutual += p
    }
  }

  return { theyWin, mutual, weWin, mineLost: theyWin + mutual, theirsLost: weWin + mutual }
}

/** Expected points of an enemy piece, over the belief. */
function expectedValue(probs: RankProbs, rankValue: (rank: Rank) => number): number {
  const total = totalOf(probs)
  if (total <= 0) return 0
  let v = 0
  for (const r of ALL_RANKS) {
    const p = probs[r] ?? 0
    if (p > 0) v += (p / total) * rankValue(r)
  }
  return v
}

// ---------------------------------------------------------------------------
// The post-move view
// ---------------------------------------------------------------------------

/**
 * The position this move produces, as a `ViewerState` the engine will accept.
 *
 * **Optimistic about a contact, in exactly the way `heldScoringAfter` and
 * `threatAfter` are**: the attacker is assumed to survive and occupy the target.
 * That is the right conditioning for the question being asked — 「if I take this
 * square, can I hold it」 presupposes taking it. In the worlds where the attack
 * lost or traded, our piece is not standing there and there is nothing to hold;
 * `pHoldsAfterReply` is therefore P(hold | we arrived), and the caller already
 * has P(we arrived) from `contactEV`.
 *
 * Three details that the engine reads and that a lazier copy would drop:
 *
 *  · the victim is removed from ITS square, not from the destination. For an en
 *    passant (§4.2) those are different squares and clearing the destination
 *    would leave the captured pawn on the board.
 *  · the move is APPENDED TO THE LOG. `carrierMoves` derives castling rights from
 *    the log (a `ViewerPiece` carries no `hasMoved`), and `enPassantInfo` derives
 *    the en-passant window from the last entry. Without the entry, our pawn's
 *    double step would not offer the opponent the capture it just offered them —
 *    which is the single most missable reply in the game.
 *  · 升變 (§6) changes the 載體層 and nothing else, so a promoting move rewrites
 *    the carrier and leaves the 兵種 alone.
 *
 * The entry carries NO `combat` field even for a capture, and that is deliberate.
 * §4.3 makes every announcement a piece of public evidence, and fabricating one
 * would inject a fact that did not happen into anything that replays the log —
 * `enemyFacts` above all. It cannot corrupt what this module needs: the only
 * thing `enPassantInfo` does with `combat` is refuse a window, and a window needs
 * a pawn that moved two ranks along one file, which no capture in the game is.
 *
 * **Do not hand the result to `beliefFor`.** It is a movement-and-occupancy view.
 * The score is not settled (§7.1), the status is not re-tested (§7④), and the
 * removed piece is removed on an assumption rather than on an event.
 */
export function viewAfter(view: ViewerState, color: Color, move: Move): ViewerState | null {
  const shape = shapeOfMove(view, color, move)
  if (shape === null) return null

  const pieces: ViewerPiece[] = view.pieces.map((p) => ({ ...p }))
  const byId = new Map<PieceId, ViewerPiece>(pieces.map((p) => [p.id, p]))

  if (shape.contact !== undefined) {
    const victim = byId.get(shape.contact.id)
    if (victim) victim.square = null
  }

  for (const [id, to] of shape.relocations) {
    const piece = byId.get(id)
    if (!piece) continue
    piece.square = to
    if (
      move.kind === 'move'
      && move.promote !== undefined
      && piece.carrier === 'pawn'
      && rankOf(to) === promotionRank(color)
    ) {
      piece.carrier = move.promote
    }
  }

  const entry: GameEvent = {
    ply: view.ply,
    color,
    move,
    scoreAfter: { white: view.score.white, black: view.score.black },
  }

  return {
    ...view,
    pieces,
    toMove: opposite(color),
    ply: view.ply + 1,
    log: [...view.log, entry],
    // ours, and now stale. A policy reading it off a post-move view would be
    // choosing from the move list of a position it is no longer in.
    legalMoves: undefined,
  }
}

// ---------------------------------------------------------------------------
// What the opponent can reach — one engine call, two answers
// ---------------------------------------------------------------------------

/** One enemy reply that makes contact, before any 兵種 is priced. */
interface Contact {
  readonly attacker: ViewerPiece
  readonly from: Square
  readonly to: Square
  readonly contactSquare: Square
  readonly enPassant: boolean
}

/**
 * Everything one call to `carrierMoves` can tell us about the opponent.
 *
 * `reach` is the grouping `reachableSquares` performs, taken off the same move
 * list rather than off a second generation — the generator is the expensive part
 * and this runs per candidate move. `contacts` is the part `reachableSquares`
 * cannot express: it maps the VICTIM's id, which for an en passant is not the
 * piece standing on the destination square (§4.2).
 */
interface EnemyPicture {
  readonly contacts: ReadonlyMap<PieceId, readonly Contact[]>
  readonly reach: ReadonlySet<Square>
  readonly moves: readonly Move[]
}

function enemyPicture(view: ViewerState, color: Color, stats: LookaheadStats): EnemyPicture {
  const enemy = opposite(color)
  const moves = carrierMoves(view, enemy)
  stats.generations++

  const occ = occupancy(view)
  const contacts = new Map<PieceId, Contact[]>()
  const reach = new Set<Square>()

  for (const move of moves) {
    if (move.kind !== 'move') continue
    reach.add(move.to)
    const attacker = occ[move.from]
    if (attacker === undefined) continue

    // `shapeOfMove` owns the §4.2 rule that locates an en-passant victim, and it
    // is reused rather than restated: 接觸格 ≠ 目的格 is the one shape a
    // destination-square test gets silently wrong.
    const shape = shapeOfMove(view, enemy, move)
    const victim = shape?.contact
    if (!victim || victim.color !== color || victim.square === null) continue

    const list = contacts.get(victim.id)
    // A promotion generates four moves with one destination (§6). They are one
    // threat, so the first wins and the rest are dropped.
    if (list && list.some((c) => c.attacker.id === attacker.id)) continue

    const contact: Contact = {
      attacker,
      from: move.from,
      to: move.to,
      contactSquare: victim.square,
      enPassant: move.to !== victim.square,
    }
    if (list) list.push(contact)
    else contacts.set(victim.id, [contact])
  }

  return { contacts, reach, moves }
}

// ---------------------------------------------------------------------------
// Cache plumbing
// ---------------------------------------------------------------------------

export function makeLookaheadStats(): LookaheadStats {
  return { generations: 0, postViews: 0, hits: 0, replies: 0, safeties: 0 }
}

/** A memo a caller can hold for a whole game; it resets itself per position. */
export function makeLookaheadCache(): LookaheadCache {
  return {
    view: null,
    color: null,
    picture: null,
    reply: new Map(),
    safety: new Map(),
    stats: makeLookaheadStats(),
  }
}

function bind(cache: LookaheadCache | undefined, view: ViewerState, color: Color): LookaheadCache {
  const c = cache ?? makeLookaheadCache()
  if (c.view !== view || c.color !== color) {
    c.view = view
    c.color = color
    c.picture = null
    c.reply.clear()
    c.safety.clear()
  }
  return c
}

function pictureOf(cache: LookaheadCache, view: ViewerState, color: Color): EnemyPicture {
  if (cache.picture === null) cache.picture = enemyPicture(view, color, cache.stats)
  return cache.picture
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Is this move worth the cost of a post-move view?
 *
 * The default gate is the income question and nothing else, because that is the
 * question the reply layer exists to answer: 「a capture that wins a square and
 * loses it straight back scores as a clean win」. A move that neither touches a
 * 結算格 nor opens a line onto one cannot change the answer.
 *
 * Four ways in, and the fourth is the one that needs an argument:
 *
 *  1. it makes contact — 「can I hold what I take」 is the whole defect;
 *  2. it lands on a 結算格 — the income it is taking has to survive one reply;
 *  3. it leaves a 結算格 — §7.1 pays per piece per square, so this is a rate change
 *     whose replacement has to be worth having;
 *  4. it VACATES a square the opponent can already reach, while we hold income.
 *
 * (4) is exact for the case that matters, and cheap. A quiet move can only newly
 * expose a 結算格 to enemy fire by stepping out of a slider's way, and the piece
 * that is in a slider's way is by definition the first piece on that ray — which
 * means the slider can capture it, which means its square is in
 * `reach`. No geometry is computed to establish this: the set is the opponent's
 * own move list.
 */
export function needsReplyAnalysis(
  view: ViewerState,
  color: Color,
  move: Move,
  opts: LookaheadOptions = {},
): boolean {
  const gate = opts.gate ?? 'income'
  if (gate === 'all') return true

  const shape = shapeOfMove(view, color, move)
  if (shape === null) return false

  const cache = bind(opts.cache, view, color)
  const picture = pictureOf(cache, view, color)
  const scoring = new Set<Square>(view.config.scoringSquares)

  let holdsIncome = false
  for (const p of view.pieces) {
    if (p.color === color && p.square !== null && scoring.has(p.square)) {
      holdsIncome = true
      break
    }
  }

  // pass (§3④) relocates nothing, so it changes no line and takes no square. It
  // is still analysed while we hold income, because `expectedLoss` is an absolute
  // and a caller comparing candidates needs the do-nothing baseline in the same
  // currency as everything else.
  if (shape.relocations.size === 0) return holdsIncome

  if (shape.contact !== undefined) return true

  const byId = new Map(view.pieces.map((p) => [p.id, p]))
  for (const [id, to] of shape.relocations) {
    if (scoring.has(to)) return true
    if (gate === 'exposed' && picture.reach.has(to)) return true
    const piece = byId.get(id)
    if (piece?.square == null) continue
    if (scoring.has(piece.square)) return true
    if (holdsIncome && picture.reach.has(piece.square)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Describing an attacker
// ---------------------------------------------------------------------------

const pct = (x: number): string => `${Math.round(x * 100)}%`

const rankName = (rank: Rank | null): string =>
  rank === null ? 'an unknown 兵種' : `${RANK_NAMES_ZH[rank]}`

function attackerFrom(contact: Contact, odds: ContactOdds, victimRank: Rank | null): ReplyAttacker {
  const where = `${contact.attacker.id} ${contact.attacker.carrier} `
    + `${squareName(contact.from)}→${squareName(contact.to)}`
  const ep = contact.enPassant ? ' by en passant (§4.2)' : ''
  const seen = contact.attacker.revealed ? ' 翻明' : ''
  return {
    id: contact.attacker.id,
    from: contact.from,
    to: contact.to,
    contactSquare: contact.contactSquare,
    enPassant: contact.enPassant,
    carrier: contact.attacker.carrier,
    revealed: contact.attacker.revealed,
    odds,
    why:
      `${where}${seen}${ep} removes our ${rankName(victimRank)} ${pct(odds.mineLost)}`
      + ` (${pct(odds.theyWin)} beats it, ${pct(odds.mutual)} 同歸於盡, ${pct(odds.weWin)} loses to it)`,
  }
}

// ---------------------------------------------------------------------------
// replyRisk
// ---------------------------------------------------------------------------

function probsFor(view: ViewerState, belief: BeliefLookup, id: PieceId): RankProbs {
  const probs = belief(id)
  return totalOf(probs) > 0 ? probs : priorBelief(view)
}

function ownProbs(view: ViewerState, piece: ViewerPiece): RankProbs {
  // §10.1 hands a player its whole army, so this is a point mass during play. The
  // fallback is for a view that redacted our own side — a replay viewer, or a
  // hand-built scene — and it degrades into 「an average piece」 rather than into a
  // silent zero.
  return piece.rank === null ? priorBelief(view) : POINT_MASS[piece.rank]
}

function buildAttackers(
  view: ViewerState,
  belief: BeliefLookup,
  contacts: readonly Contact[],
  victim: ViewerPiece,
): ReplyAttacker[] {
  const mine = ownProbs(view, victim)
  const out = contacts.map((c) =>
    attackerFrom(c, contactOddsBetween(mine, probsFor(view, belief, c.attacker.id)), victim.rank),
  )
  out.sort(
    (a, b) =>
      b.odds.mineLost - a.odds.mineLost || a.from - b.from || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return out
}

function exposedFrom(
  view: ViewerState,
  belief: BeliefLookup,
  victim: ViewerPiece,
  contacts: readonly Contact[],
  before: readonly Contact[] | undefined,
  relocated: ReadonlySet<PieceId>,
  scoring: ReadonlySet<Square>,
  rankValue: (rank: Rank) => number,
  squareValue: number,
): ExposedPiece {
  const attackers = buildAttackers(view, belief, contacts, victim)
  const square = victim.square as Square
  const onScoring = scoring.has(square)
  const stake = (victim.rank === null ? 0 : rankValue(victim.rank)) + (onScoring ? squareValue : 0)

  let pHolds = 1
  let expectedLoss = Number.NEGATIVE_INFINITY
  let worst: ReplyAttacker | null = null
  for (const a of attackers) {
    pHolds = Math.min(pHolds, 1 - a.odds.mineLost)
    // Netted against what the reply costs THEM. An opponent who trades a 司令 for
    // a 排長 has not punished us, and a model that ignores the other half of the
    // trade is the paranoid model this file exists not to be.
    const theirs = expectedValue(probsFor(view, belief, a.id), rankValue)
    const loss = a.odds.mineLost * stake - a.odds.theirsLost * theirs
    if (loss > expectedLoss) {
      expectedLoss = loss
      worst = a
    }
  }
  if (attackers.length === 0) expectedLoss = 0

  const newlyExposed = (before?.length ?? 0) === 0 && attackers.length > 0
  const collateral = !relocated.has(victim.id)
  const tags = [
    onScoring ? '結算格' : null,
    victim.rank === 'flag' ? '軍旗 — §7④① loses the game outright' : null,
    newlyExposed && collateral ? 'newly exposed by this move' : null,
  ].filter((t): t is string => t !== null)

  return {
    id: victim.id,
    square,
    rank: victim.rank,
    carrier: victim.carrier,
    onScoring,
    isFlag: victim.rank === 'flag',
    attackers,
    pHolds,
    newlyExposed,
    collateral,
    expectedLoss,
    why:
      `${victim.id} on ${squareName(square)}${tags.length ? ` [${tags.join(', ')}]` : ''}`
      + ` holds ${pct(pHolds)}${worst ? ` — worst reply: ${worst.why}` : ''}`,
  }
}

function unanalysed(move: Move, why: string): ReplyRisk {
  return {
    move,
    analysed: false,
    mover: null,
    square: null,
    moverRank: null,
    attackers: [],
    pHoldsAfterReply: 1,
    worst: null,
    exposed: [],
    expectedLoss: 0,
    costliest: null,
    why,
  }
}

/**
 * For a move of ours, what the opponent can do about it.
 *
 * The move is applied to a COPY of the view — our piece has left its origin,
 * which may open a line, and may have removed a piece, which may remove a
 * defender — and the ENGINE is then asked what the opponent can reach. Nothing
 * here reasons about geometry; see the file header.
 *
 * What comes back is the whole board's exposure, not just the moved piece's:
 * the opponent gets ONE reply and will spend it wherever it pays best, so
 * `expectedLoss` is a maximum over our pieces and `pHoldsAfterReply` is the
 * separate question of whether the square we just took survives.
 */
export function replyRisk(
  view: ViewerState,
  color: Color,
  belief: BeliefLookup,
  move: Move,
  opts: LookaheadOptions = {},
): ReplyRisk {
  const cache = bind(opts.cache, view, color)
  const key = moveKey(move)
  const memo = cache.reply.get(key)
  if (memo !== undefined) {
    cache.stats.hits++
    return memo
  }
  cache.stats.replies++

  const shape = shapeOfMove(view, color, move)
  if (shape === null) {
    return unanalysed(move, `${key} does not describe anything on this board`)
  }
  if (!needsReplyAnalysis(view, color, move, opts)) {
    const risk = unanalysed(move, `${key} touches no 結算格 and opens no line onto one — not analysed`)
    cache.reply.set(key, risk)
    return risk
  }

  const rankValue = opts.rankValue ?? (() => 1)
  const squareValue = opts.squareValue ?? 0
  const scoring = new Set<Square>(view.config.scoringSquares)
  const before = pictureOf(cache, view, color)

  // pass changes no occupancy and opens no en-passant window against us (a window
  // belongs to the opponent of whoever double-stepped, §4.2), so the opponent's
  // reach is exactly what it already is and the position needs no regeneration.
  let after: EnemyPicture
  let post: ViewerState
  if (shape.relocations.size === 0 && shape.contact === undefined) {
    after = before
    post = view
  } else {
    const next = viewAfter(view, color, move)
    if (next === null) return unanalysed(move, `${key} could not be applied`)
    cache.stats.postViews++
    post = next
    after = enemyPicture(post, color, cache.stats)
  }

  const relocated = new Set<PieceId>(shape.relocations.keys())
  const postById = new Map<PieceId, ViewerPiece>(post.pieces.map((p) => [p.id, p]))

  const exposed: ExposedPiece[] = []
  for (const [id, contacts] of after.contacts) {
    const piece = postById.get(id)
    if (!piece || piece.square === null || piece.color !== color) continue
    exposed.push(
      exposedFrom(
        post,
        belief,
        piece,
        contacts,
        before.contacts.get(id),
        relocated,
        scoring,
        rankValue,
        squareValue,
      ),
    )
  }
  exposed.sort(
    (a, b) => b.expectedLoss - a.expectedLoss || a.square - b.square || (a.id < b.id ? -1 : 1),
  )

  // The moved piece — for 王車易位 (§3②), whichever of the two ends up more
  // exposed, since the move buys both placements at once.
  let mover: ViewerPiece | null = null
  let entry: ExposedPiece | null = null
  let pHoldsAfterReply = 1
  for (const id of relocated) {
    const piece = postById.get(id)
    if (!piece || piece.square === null) continue
    const found = exposed.find((e) => e.id === id) ?? null
    const holds = found?.pHolds ?? 1
    if (mover === null || holds < pHoldsAfterReply) {
      mover = piece
      entry = found
      pHoldsAfterReply = holds
    }
  }

  const costliest = exposed[0] ?? null
  const expectedLoss = costliest === null ? 0 : Math.max(0, costliest.expectedLoss)

  const risk: ReplyRisk = {
    move,
    analysed: true,
    mover: mover?.id ?? null,
    square: mover?.square ?? null,
    moverRank: mover?.rank ?? null,
    attackers: entry?.attackers ?? [],
    pHoldsAfterReply,
    worst: entry?.attackers[0] ?? null,
    exposed,
    expectedLoss,
    costliest,
    why:
      mover === null
        ? `${key} — ${exposed.length} of our pieces are in reach afterwards`
        : `${key} — ${squareName(mover.square as Square)} holds ${pct(pHoldsAfterReply)}`
          + (entry?.attackers[0] ? `; ${entry.attackers[0].why}` : '; nothing of theirs reaches it')
          + (exposed.some((e) => e.collateral && e.newlyExposed)
            ? `; it also exposes ${exposed.filter((e) => e.collateral && e.newlyExposed).map((e) => e.id).join(', ')}`
            : ''),
  }
  cache.reply.set(key, risk)
  return risk
}

// ---------------------------------------------------------------------------
// squareSafety
// ---------------------------------------------------------------------------

/**
 * The position with a piece of ours standing on `square`.
 *
 * When one already does, that is the position. When the square is empty — or
 * holds an enemy piece we would have to take to get there — a stand-in of ours is
 * placed on it and any enemy occupant is removed.
 *
 * The stand-in is not a convenience, it is what makes the answer correct. Asking
 * `reachableSquares` about an EMPTY square counts every enemy pawn that could
 * push onto it, and a pawn that can push onto a square cannot capture on it (§3)
 * — the single most common way to misread a pawn wall. With a body on the square
 * the engine answers the question actually being asked, and it answers it with
 * the same generator that runs the game.
 *
 * Its 載體 is irrelevant to the answer (an enemy's reach depends on occupancy and
 * colour, never on what our piece is riding), so it takes the cheapest one.
 */
function probeFor(
  view: ViewerState,
  color: Color,
  square: Square,
  occupantRank: Rank | undefined,
): { view: ViewerState; victim: ViewerPiece; hypothetical: boolean } {
  const standing = view.pieces.find((p) => p.square === square)
  if (standing && standing.color === color) {
    if (occupantRank === undefined || occupantRank === standing.rank) {
      return { view, victim: standing, hypothetical: false }
    }
  }

  const pieces: ViewerPiece[] = view.pieces.map((p) =>
    p.square === square ? { ...p, square: null } : { ...p },
  )
  const probe: ViewerPiece = {
    id: PROBE_ID,
    color,
    carrier: 'pawn',
    square,
    revealed: false,
    rank: occupantRank ?? (standing && standing.color === color ? standing.rank : null),
  }
  pieces.push(probe)
  return {
    view: { ...view, pieces, legalMoves: undefined },
    victim: probe,
    hypothetical: true,
  }
}

/**
 * Enemy pieces that cannot reach `square` yet and are one move from being able
 * to — the second half of §15.1's question.
 *
 * Computed by playing each of the opponent's legal moves onto a copy of the
 * position and asking `reachableSquares` again. Exhaustive over their move list,
 * so it catches the two shapes that matter and does not distinguish between them
 * in the search: the piece that walks into position, and the piece that shoots
 * down a line a DIFFERENT piece just stepped out of. `discovered` tells them
 * apart in the report, because they are answered differently.
 *
 * Optimistic for the opponent in one respect: their setup move is assumed to win
 * any contact it makes (`viewAfter`'s conditioning, applied from their side). For
 * a question whose answer is 「nothing can get here」 the safe direction to be
 * wrong in is over-counting, and this over-counts.
 *
 * Our piece does not move in this search. That is why `pHolds2` is a description
 * and not a decision — see the file header, and notebook §14.2.
 */
function liningThreats(
  probe: ViewerState,
  color: Color,
  square: Square,
  belief: BeliefLookup,
  mine: RankProbs,
  stats: LookaheadStats,
): LiningThreat[] {
  const enemy = opposite(color)
  const occNow = occupancy(probe)
  const squareNow = new Map<PieceId, Square>()
  for (const p of probe.pieces) if (p.square !== null) squareNow.set(p.id, p.square)
  const out: LiningThreat[] = []
  const seen = new Set<PieceId>()

  const moves = carrierMoves(probe, enemy)
  stats.generations++

  for (const move of moves) {
    if (move.kind === 'pass') continue
    // A move onto the square is an IMMEDIATE threat, not a setup; those are found
    // one ply earlier and this branch only runs when there are none.
    if (move.kind === 'move' && move.to === square) continue

    const post = viewAfter(probe, enemy, move)
    if (post === null) continue
    stats.postViews++

    const reach = reachableSquares(post, enemy)
    stats.generations++
    const entries = reach.get(square)
    if (entries === undefined) continue

    const postOcc = occupancy(post)
    const setupMover = move.kind === 'move' ? occNow[move.from]?.id : undefined
    for (const entry of entries) {
      const piece = postOcc[entry.from]
      if (!piece || piece.color !== enemy) continue
      if (seen.has(piece.id)) continue
      seen.add(piece.id)
      const odds = contactOddsBetween(mine, probsFor(probe, belief, piece.id))
      const discovered = setupMover !== piece.id
      out.push({
        id: piece.id,
        from: squareNow.get(piece.id) ?? entry.from,
        after: entry.from,
        carrier: piece.carrier,
        setup: move,
        discovered,
        odds,
        why:
          `${piece.id} ${piece.carrier} reaches ${squareName(square)} after ${moveKey(move)}`
          + `${discovered ? ' (a discovered line — a different piece moved)' : ''}`
          + `, then removes it ${pct(odds.mineLost)}`,
      })
    }
  }

  out.sort((a, b) => b.odds.mineLost - a.odds.mineLost || a.from - b.from || (a.id < b.id ? -1 : 1))
  return out
}

/**
 * How exposed a piece standing on `square` is over the next `plies` enemy moves.
 *
 * This is the function that makes 軍旗 income assessable. Notebook §15.1 records
 * a human parking their 軍旗 on an enemy-half 結算格 for eleven settlements and
 * winning, and it survived for one reason: NOTHING COULD REACH IT. 「風險是可以數
 * 的，而它數對了。」 Ask with `{ occupantRank: 'flag' }` and read `unreachable`.
 *
 * `plies` of 1 asks 「can it be taken on their next move」 and costs one engine
 * generation. `plies` of 2 adds 「is anything one move from being able to」 and
 * costs one generation per enemy move — it is the expensive call, and it is
 * skipped entirely when the answer at one ply is already 「yes」.
 */
export function squareSafety(
  view: ViewerState,
  color: Color,
  belief: BeliefLookup,
  square: Square,
  plies: number = SAFETY_HORIZON,
  opts: LookaheadOptions = {},
): Safety {
  const cache = bind(opts.cache, view, color)
  const horizon = Math.max(1, Math.min(SAFETY_HORIZON, Math.floor(plies)))
  const key = `${square}:${horizon}:${opts.occupantRank ?? '-'}`
  const memo = cache.safety.get(key)
  if (memo !== undefined) {
    cache.stats.hits++
    return memo
  }
  cache.stats.safeties++

  const { view: probe, victim, hypothetical } = probeFor(view, color, square, opts.occupantRank)
  const scoring = new Set<Square>(view.config.scoringSquares)
  const onScoring = scoring.has(square)
  const mine = ownProbs(view, victim)

  // The unprobed position is the one the per-ply memo already holds; a probe is a
  // different position and gets its own generation.
  const picture = hypothetical
    ? enemyPicture(probe, color, cache.stats)
    : pictureOf(cache, view, color)

  const attackers = buildAttackers(probe, belief, picture.contacts.get(victim.id) ?? [], victim)
  const pHolds1 = attackers.reduce((p, a) => Math.min(p, 1 - a.odds.mineLost), 1)

  const searchLining = horizon >= 2 && attackers.length === 0
  const lining = searchLining
    ? liningThreats(probe, color, square, belief, mine, cache.stats)
    : []
  const pHolds2 = lining.reduce((p, t) => Math.min(p, 1 - t.odds.mineLost), pHolds1)

  const unreachable = attackers.length === 0 && (horizon < 2 || (searchLining && lining.length === 0))
  const isFlag = victim.rank === 'flag'

  const why = (() => {
    const who = hypothetical ? 'a piece of ours arriving on' : `${victim.id} on`
    const head = `${who} ${squareName(square)}${onScoring ? ' (結算格)' : ''}${isFlag ? ' — the 軍旗 (§5.3, §7④①)' : ''}`
    if (attackers.length > 0) return `${head}: ${pct(pHolds1)} holds — ${attackers[0]!.why}`
    if (!searchLining) return `${head}: nothing reaches it this ply`
    if (lining.length === 0) {
      return `${head}: nothing on the board reaches it inside ${horizon} enemy moves (§15.1)`
    }
    return `${head}: safe this ply; ${lining.length} piece(s) one move from it — ${lining[0]!.why}`
  })()

  const safety: Safety = {
    square,
    plies: horizon,
    occupant: hypothetical ? null : victim.id,
    occupantRank: victim.rank,
    hypothetical,
    onScoring,
    isFlag,
    attackers,
    pHolds1,
    lining,
    liningSearched: searchLining,
    pHolds2,
    pHolds: horizon >= 2 ? pHolds2 : pHolds1,
    unreachable,
    why,
  }
  cache.safety.set(key, safety)
  return safety
}

// ---------------------------------------------------------------------------
// Bound to one position
// ---------------------------------------------------------------------------

/**
 * The two questions with the view, colour, belief and memo already tied down.
 *
 * The cache's life is one ply by construction — it clears itself when a different
 * `view` object arrives — so a policy can build one of these at the top of
 * `chooseMove` and ask it about every candidate without thinking about
 * invalidation.
 */
export function lookaheadFor(
  view: ViewerState,
  color: Color,
  belief: BeliefLookup,
  opts: LookaheadOptions = {},
): Lookahead {
  const cache = bind(opts.cache, view, color)
  const bound: LookaheadOptions = { ...opts, cache }
  return {
    view,
    color,
    cache,
    stats: cache.stats,
    needsReplyAnalysis: (move) => needsReplyAnalysis(view, color, move, bound),
    replyRisk: (move) => replyRisk(view, color, belief, move, bound),
    squareSafety: (square, plies = SAFETY_HORIZON, occupantRank) =>
      squareSafety(view, color, belief, square, plies, {
        ...bound,
        ...(occupantRank === undefined ? {} : { occupantRank }),
      }),
  }
}

// ---------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------

/** Why a move is risky, one line per reason, ready to print. */
export function explainReply(risk: ReplyRisk): string[] {
  const lines = [risk.why]
  for (const e of risk.exposed) lines.push(`  ${e.why}`)
  return lines
}

/** Why a square is (un)safe, one line per reason. */
export function explainSafety(safety: Safety): string[] {
  const lines = [safety.why]
  for (const a of safety.attackers) lines.push(`  now: ${a.why}`)
  for (const t of safety.lining) lines.push(`  next: ${t.why}`)
  return lines
}
