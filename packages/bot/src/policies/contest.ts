import type { Color, Move, Rank, ViewerState } from '@xiyang/rules'
import type { Rng } from '../prng.js'
import type { MoveShape, Policy } from '../policy.js'
import {
  heldScoring,
  heldScoringAfter,
  moveKey,
  ownPieces,
  scoringSet,
  shapeOfMove,
} from '../policy.js'
import { greedyPolicy } from './greedy.js'

const PASS: Move = { kind: 'pass' }

/**
 * greedy, plus: attack an enemy-held 結算格 when there is no free one to take.
 *
 * WHY THIS EXISTS. `greedy` never initiates a capture, so greedy-vs-greedy yields
 * exactly ZERO contacts on any board — which makes it useless for the one
 * question the instrument was built to answer (notebook §7): does making 結算格
 * scarce force players to fight for them?
 *
 * On 側翼八格 there are eight squares and neither side can hold more than a few,
 * so a free one is almost always available and this policy behaves like greedy.
 * On 中央四格 with two apiece the free squares run out around ply 4, and from
 * then on the only way to gain is to take one off the opponent. The difference
 * in contacts-per-ply between the two boards IS the scarcity effect, isolated.
 *
 * It attacks BLINDLY — no belief state, no expected value, no idea what it is
 * hitting. That is deliberate. This is an instrument for measuring how often the
 * board FORCES contact, not a player. A policy that declined bad-looking attacks
 * would confound "the board offered no alternative" with "the bot judged the odds
 * poorly", and the whole point is to separate those.
 *
 * The 軍旗 exclusion is absolute, as in greedy: attacking with it loses the game
 * outright (§5.3), so it is not a tempting-but-bad move, it is a resignation.
 */

/** Does this move step onto a 結算格 the opponent is currently standing on? */
function contestsScoringSquare(
  view: ViewerState,
  color: Color,
  shape: MoveShape,
  held: number,
): boolean {
  // A contest is only worth calling one if it would actually raise our holding.
  return heldScoringAfter(view, color, shape) > held
}

function chooseMove(view: ViewerState, color: Color, rng: Rng): Move {
  // First preference is always the peaceful gain — free income beats a coin flip
  // against an unknown 兵種 every time. Only when greedy has nothing does this
  // policy differ from it at all.
  const peaceful = greedyPolicy.move(view, color, rng)
  if (peaceful.kind !== 'pass') return peaceful

  const moves = view.legalMoves
  if (!moves || moves.length === 0) return PASS

  const held = heldScoring(view, color)
  const flagIds = new Set(
    ownPieces(view, color)
      .filter((p) => p.rank === ('flag' as Rank))
      .map((p) => p.id),
  )

  const candidates: Move[] = []
  for (const move of moves) {
    if (move.kind === 'pass') continue
    const shape = shapeOfMove(view, color, move)
    if (!shape) continue
    if (shape.contact === undefined) continue              // must be a contact
    // §5.3 — the 軍旗 leaving the board loses instantly, so attacking with it is
    // not a bad move, it is a resignation. Excluded absolutely, as in greedy.
    let movesFlag = false
    for (const id of shape.relocations.keys()) if (flagIds.has(id)) movesFlag = true
    if (movesFlag) continue
    if (!contestsScoringSquare(view, color, shape, held)) continue
    candidates.push(move)
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => (moveKey(a) < moveKey(b) ? -1 : moveKey(a) > moveKey(b) ? 1 : 0))
    return rng.pick(candidates)
  }

  return approach(view, color, rng, flagIds)
}

/**
 * Nothing gains a 結算格 this ply and nothing can be taken off the opponent.
 * Walk a piece TOWARDS a square we do not hold.
 *
 * Without this the policy deadlocks. On 中央四格 both sides take two squares with
 * pawn double-steps, and after that every immediate gain is zero: the only pieces
 * adjacent to an enemy square are already standing on our own, so capturing swaps
 * one square for another and nets nothing. A knight could contest d5, but the
 * move that starts it (b1–c3) gains nothing on the ply it is played, so a
 * strictly 1-ply policy never plays it. Measured: 0 contacts in 300 games, every
 * one exactly 41 plies — a stalemate of the bot's own making, not the board's.
 *
 * Distance is Chebyshev, which is exact for a king and a queen and merely
 * monotone for everything else. That is enough: this is a tie-break for
 * otherwise-worthless moves, not an evaluation.
 */
function approach(
  view: ViewerState,
  color: Color,
  rng: Rng,
  flagIds: ReadonlySet<string>,
): Move {
  const moves = view.legalMoves
  if (!moves || moves.length === 0) return PASS

  const scoring = scoringSet(view)
  const mine = new Set(
    ownPieces(view, color)
      .filter((p) => p.square !== null && scoring.has(p.square))
      .map((p) => p.square as number),
  )
  const wanted = [...scoring].filter((sq) => !mine.has(sq))
  if (wanted.length === 0) return PASS

  const dist = (a: number, b: number): number =>
    Math.max(Math.abs((a % 8) - (b % 8)), Math.abs(Math.floor(a / 8) - Math.floor(b / 8)))
  const nearest = (sq: number): number => Math.min(...wanted.map((w) => dist(sq, w)))

  let best = Infinity
  let picks: Move[] = []
  for (const move of moves) {
    if (move.kind !== 'move') continue
    const shape = shapeOfMove(view, color, move)
    if (!shape) continue
    let movesFlag = false
    for (const id of shape.relocations.keys()) if (flagIds.has(id)) movesFlag = true
    if (movesFlag) continue
    // never abandon a square we are already being paid for
    if (mine.has(move.from)) continue
    const before = nearest(move.from)
    const after = nearest(move.to)
    if (after >= before) continue
    if (after < best) {
      best = after
      picks = [move]
    } else if (after === best) {
      picks.push(move)
    }
  }

  if (picks.length === 0) return PASS
  picks.sort((a, b) => (moveKey(a) < moveKey(b) ? -1 : moveKey(a) > moveKey(b) ? 1 : 0))
  return rng.pick(picks)
}

export const contestPolicy: Policy = {
  name: 'contest',
  deploy: greedyPolicy.deploy,
  move: chooseMove,
}
