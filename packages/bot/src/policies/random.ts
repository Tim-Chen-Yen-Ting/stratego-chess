/**
 * The baseline. Uniform over `view.legalMoves`, random legal deployment.
 *
 * This bot is not an opponent, it is a ZERO POINT. Every other policy's score is
 * meaningless in isolation — "greedy wins 94%" says nothing until you know what
 * knowing nothing scores on the same board with the same dice. It is also the
 * cheapest possible check on the rules engine: a few thousand uniform games walk
 * into 王車易位, en passant, 升變, 有煙無傷 and 奪旗 far more often than a
 * careful player ever would, and `applyMove` throws if any of them is illegal.
 *
 * Uniform includes `{ kind: 'pass' }`, which `legalMoves` always appends (§3④).
 * That is deliberate and it is not a bug in the baseline: pass is a real action
 * with a real settlement, so a baseline that filtered it out would be sampling a
 * different action space than the one the rules define.
 */

import type { Color, Move, PieceId, Rank, ViewerState } from '@xiyang/rules'
import type { Rng } from '../prng.js'
import type { Policy } from '../policy.js'
import { randomAssignment } from '../policy.js'

/**
 * Uniform over the legal moves in the payload.
 *
 * The fallback to pass covers the one case that should never happen: a policy
 * asked to move on a view with no move list, i.e. when it is not this side's
 * turn. Passing is always legal (§3④), so the harness gets a valid move and the
 * bug shows up as a strange log rather than as a crash three layers down.
 */
function chooseMove(view: ViewerState, _color: Color, rng: Rng): Move {
  const moves = view.legalMoves
  if (!moves || moves.length === 0) return { kind: 'pass' }
  return rng.pick(moves)
}

export function makeRandomPolicy(name = 'random'): Policy {
  return {
    name,
    deploy(view: ViewerState, color: Color, rng: Rng): Record<PieceId, Rank> {
      return randomAssignment(view, color, rng)
    },
    move: chooseMove,
  }
}

export const randomPolicy: Policy = makeRandomPolicy()
