/**
 * The bot contract, and the ONLY lens a bot is allowed to look through.
 *
 * ---------------------------------------------------------------------------
 * ViewerState is the whole input surface. Nothing else. Ever.
 * ---------------------------------------------------------------------------
 *
 * Both methods below take a `ViewerState` — the redacted payload gamebook §10
 * defines and `stateForViewer` produces, exactly the bytes a human player's
 * browser receives. A policy is handed no `GameState`, no piece list from the
 * engine, no opponent deployment, and no back channel to any of them. There is
 * deliberately no debug escape hatch: this file imports types and pure helpers
 * from `@xiyang/rules` and never a state accessor.
 *
 * The reason is that a bot arena is a MEASURING INSTRUMENT before it is an
 * opponent, and an instrument that reads the answer key measures a different
 * game. A policy that could see hidden 兵種 would:
 *
 *   · never lose a contact it could avoid, so the 同歸於盡 rate (notebook §4.1,
 *     predicted 18%, observed 13.3% over six games) would come out near zero and
 *     the §4.2 snowball would vanish from the data;
 *   · never need 爆裂物 delivery (§2.3), so the single most load-bearing
 *     playtest finding in the notebook could not be reproduced or refuted;
 *   · make 軍旗 hunting deterministic, collapsing §5.1 into a solved problem.
 *
 * Every number such a run produced would be about a perfect-information variant
 * that nobody plays. The rule is therefore structural, not advisory: the harness
 * in `index.ts` owns the `GameState`, calls `stateForViewer` for each side, and
 * hands the result down. A policy that wants more information has to infer it
 * from the public log, which is precisely what a human has to do.
 *
 * `view.legalMoves` is the authority on legality. A policy never computes its
 * own move list — the engine already put the right one in the payload, and a
 * second implementation would be a second set of bugs (techspec §7: 「The client
 * must not implement rules」 — a bot is a client).
 */

import {
  ALL_RANKS,
  castlePlan,
  fileOf,
  forwardDir,
  makeSquare,
  moveToNotation,
  onBoard,
  pawnHomeRank,
  rankOf,
} from '@xiyang/rules'
import type {
  Color,
  Move,
  PieceId,
  Rank,
  Square,
  ViewerPiece,
  ViewerState,
} from '@xiyang/rules'
import type { Rng } from './prng.js'

/**
 * A bot.
 *
 * Both methods are PURE with respect to everything except `rng`, which they may
 * advance. They must not retain the `view` between calls, must not mutate it
 * (the harness hands over a fresh deep copy each time, so mutation is merely
 * useless rather than dangerous), and must not consult any clock, environment or
 * global state — a policy that reads the wall clock stops being replayable, and
 * replayability is the point of the whole package.
 */
export interface Policy {
  readonly name: string
  /**
   * Choose a deployment (§9): a bijection from this side's 16 pieces onto
   * `view.config.distribution`.
   *
   * Sees only its OWN side's carriers, because that is all a ViewerState offers
   * during setup — the carrier layer is public (§1), but `stateForViewer`
   * suppresses ranks for any side that has not submitted, including the
   * placeholder ranks the engine holds internally. There is nothing to peek at.
   */
  deploy(view: ViewerState, color: Color, rng: Rng): Record<PieceId, Rank>
  /**
   * Choose a move. `view.legalMoves` is the authority on what is legal; a policy
   * picks from that list and never invents an entry.
   */
  move(view: ViewerState, color: Color, rng: Rng): Move
}

// ---------------------------------------------------------------------------
// The lens — everything below reads a ViewerState and nothing else
// ---------------------------------------------------------------------------

/** Own pieces, board or not. */
export function ownPieces(view: ViewerState, color: Color): ViewerPiece[] {
  return view.pieces.filter((p) => p.color === color)
}

/** Own piece ids in a stable, host-independent order — the deployment key order. */
export function ownPieceIds(view: ViewerState, color: Color): PieceId[] {
  return ownPieces(view, color)
    .map((p) => p.id)
    .sort()
}

/** Square → piece, over the pieces this viewer can see standing on the board. */
export function occupancy(view: ViewerState): (ViewerPiece | undefined)[] {
  const occ = new Array<ViewerPiece | undefined>(64)
  for (const p of view.pieces) {
    if (p.square !== null) occ[p.square] = p
  }
  return occ
}

/** The game's own 結算格 (附錄 B), as a set. Never a module constant. */
export function scoringSet(view: ViewerState): Set<Square> {
  return new Set(view.config.scoringSquares)
}

/** How many own pieces stand on a 結算格 right now — i.e. this side's income per settlement (§7). */
export function heldScoring(view: ViewerState, color: Color): number {
  const scoring = scoringSet(view)
  let n = 0
  for (const p of view.pieces) {
    if (p.color === color && p.square !== null && scoring.has(p.square)) n++
  }
  return n
}

/**
 * What a move does to the board, read off the PUBLIC layers alone.
 *
 * Carriers and squares are public (§1 載體層 雙方公開), so every field here is
 * derivable by a spectator. Nothing in it depends on a 兵種.
 */
export interface MoveShape {
  /** own pieces this move relocates, id → destination. Two entries for 王車易位. */
  readonly relocations: ReadonlyMap<PieceId, Square>
  /**
   * The enemy piece this move would make contact with, or undefined for a quiet
   * move. Includes the en-passant victim, which does NOT stand on the
   * destination square (§4.2) and is the one capture a destination-square test
   * silently misses.
   */
  readonly contact: ViewerPiece | undefined
}

const EMPTY_SHAPE: MoveShape = { relocations: new Map(), contact: undefined }

/**
 * Classify a move against the position. Returns null when the move does not
 * describe anything on this board — a policy should never see that, since it
 * only ever plays entries from `view.legalMoves`.
 */
export function shapeOfMove(view: ViewerState, color: Color, move: Move): MoveShape | null {
  if (move.kind === 'pass') return EMPTY_SHAPE

  const occ = occupancy(view)

  if (move.kind === 'castle') {
    // §3② relocates king and rook and nothing else; it cannot make contact
    // (the squares between them must be empty for it to be legal at all).
    const plan = castlePlan(color, move.side)
    const king = occ[plan.kingFrom]
    const rook = occ[plan.rookFrom]
    if (!king || !rook) return null
    return {
      relocations: new Map([
        [king.id, plan.kingTo],
        [rook.id, plan.rookTo],
      ]),
      contact: undefined,
    }
  }

  const mover = occ[move.from]
  if (!mover || mover.color !== color) return null

  const onTarget = occ[move.to]
  let contact: ViewerPiece | undefined = onTarget && onTarget.color !== color ? onTarget : undefined

  // En passant (§4.2): the only capture whose 接觸格 differs from its 目的格. A
  // pawn changing file onto an EMPTY square can be nothing else, so the victim
  // is the piece beside the origin on the destination file.
  if (!contact && mover.carrier === 'pawn' && fileOf(move.from) !== fileOf(move.to) && !onTarget) {
    const victimSquare = makeSquare(fileOf(move.to), rankOf(move.from))
    const victim = occ[victimSquare]
    if (victim && victim.color !== color) contact = victim
  }

  return { relocations: new Map([[mover.id, move.to]]), contact }
}

/**
 * How many 結算格 this side would stand on after the move.
 *
 * Exact for any move that makes no contact, which is the only kind the greedy
 * instrument plays: with no combat there is no rank comparison, so the resulting
 * position follows from the public layers alone (§4.1 only becomes ambiguous
 * once two 兵種 meet). For a capturing move it optimistically assumes the
 * attacker survives — see the caller, which never asks.
 */
export function heldScoringAfter(view: ViewerState, color: Color, shape: MoveShape): number {
  const scoring = scoringSet(view)
  let n = 0
  for (const p of view.pieces) {
    if (p.color !== color) continue
    const moved = shape.relocations.get(p.id)
    const square = moved ?? p.square
    if (square !== null && scoring.has(square)) n++
  }
  return n
}

/**
 * Can a pawn standing here step onto a 結算格 this ply?
 *
 * Pawn geometry off the public layers: one step, plus the double step while it
 * still stands on its home rank (§3). Used by the greedy deployment to keep the
 * 軍旗 off the pieces it is about to march into the centre.
 */
export function pawnReachesScoring(piece: ViewerPiece, scoring: ReadonlySet<Square>): boolean {
  if (piece.carrier !== 'pawn' || piece.square === null) return false
  const dir = forwardDir(piece.color)
  const one = piece.square + 8 * dir
  if (onBoard(one) && scoring.has(one)) return true
  if (rankOf(piece.square) !== pawnHomeRank(piece.color)) return false
  const two = piece.square + 16 * dir
  return onBoard(two) && scoring.has(two)
}

/**
 * A canonical, host-independent key for a move.
 *
 * Tie-breaks sort on this before drawing, so a policy's choice depends on the
 * seed and the position — never on the order the engine happened to generate
 * moves in, which would silently couple every bot to move-generation internals.
 */
export function moveKey(move: Move): string {
  return moveToNotation(move)
}

// ---------------------------------------------------------------------------
// Deployment helpers (§9)
// ---------------------------------------------------------------------------

/**
 * This game's 數量表 expanded into 16 individual 兵種, in 階級 order.
 *
 * Read from `view.config.distribution`, never from the module constant: 兵種數量配置
 * is a 附錄 B tunable, and a bot that deployed the standard table into a
 * 偵察兵 game would have every deployment rejected.
 */
export function rankPool(view: ViewerState): Rank[] {
  const pool: Rank[] = []
  for (const rank of ALL_RANKS) {
    for (let n = view.config.distribution[rank] ?? 0; n > 0; n--) pool.push(rank)
  }
  return pool
}

/**
 * Fisher-Yates over an `Rng`, as a free function rather than `rng.shuffled`.
 *
 * Same draws, same result — the point is the DEPENDENCY. A policy should need
 * as little of the random-source API as it can: `int` and `pick` and nothing
 * else. Then any seeded stream can drive it, and a policy is portable to a
 * harness that hands it a different `Rng` implementation.
 */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * A uniformly random legal deployment.
 *
 * §9 requires the timeout fallback to be random rather than a fixed default,
 * because a fixed one publishes that side's whole army. The same argument
 * applies to a bot: a deterministic deployment would make every self-play game
 * start from a position the other policy could have memorised, and the hidden
 * layer would be measuring nothing.
 */
export function randomAssignment(
  view: ViewerState,
  color: Color,
  rng: Rng,
): Record<PieceId, Rank> {
  const ids = ownPieceIds(view, color)
  const pool = shuffled(rankPool(view), rng)
  const out: Record<PieceId, Rank> = {}
  ids.forEach((id, i) => {
    const rank = pool[i]
    if (rank !== undefined) out[id] = rank
  })
  return out
}
