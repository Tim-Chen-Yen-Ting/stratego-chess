/**
 * Step a finished game back through its own log.
 *
 * A replay is a sequence of state transitions, and the engine owns those — so
 * this reconstructs the opening position and re-applies the log with the real
 * `applyMove`, then redacts each step with the real `stateForViewer`. There is
 * no second move applier and no second entitlement rule here, for the same
 * reason `publicmoves.ts` calls the engine rather than copying it.
 *
 * It works because §10.5 opens every 兵種 at 終局: a finished ViewerState carries
 * the information needed to rebuild the game it came from.
 *
 * WHAT THIS IS FOR. Replaying from a PLAYER's perspective shows what that side
 * actually knew at that ply — their own 兵種 plus whatever had been 翻明 by then,
 * never the finished game's full disclosure. Because the engine flips `revealed`
 * exactly when it flipped it live, a rank appears in the frame the announcement
 * happened and not one earlier. That is what makes a replay usable for asking
 * "what did it know when it played that".
 *
 * TWO THINGS THE LOG CANNOT CARRY, both handled below rather than faked:
 * clocks (§2) and endings that write no move (§3).
 */

import { applyMove } from './game.js'
import { stateForViewer } from './redact.js'
import { createGame, submitAssignment } from './setup.js'
import type { Color, GameState, PieceId, Rank, Viewer, ViewerState } from './types.js'

const COLORS: readonly Color[] = ['white', 'black']

/**
 * Rebuild the position before ply 1, from a finished view.
 *
 * Returns null when the view cannot support a replay — an unfinished game keeps
 * its 兵種 hidden (§10), so there is nothing to rebuild from and inventing one
 * would be a fabrication rather than a replay.
 */
function openingFrom(vs: ViewerState): GameState | null {
  if (vs.status.kind !== 'over') return null

  const assignment: Record<Color, Record<PieceId, Rank>> = { white: {}, black: {} }
  for (const p of vs.pieces) {
    if (p.rank === null) return null
    assignment[p.color][p.id] = p.rank
  }

  let s = createGame(vs.id, vs.config)
  for (const color of COLORS) s = submitAssignment(s, color, assignment[color])
  return s
}

/**
 * §2 — CLOCKS ARE NOT RECOVERABLE, and are held constant rather than invented.
 *
 * `GameEvent` records no timing, so no implementation can reconstruct what the
 * clocks read at ply N. Worse, replaying through `applyMove` ADDS the increment
 * each ply without ever subtracting thinking time, so a naive replay's clocks
 * climb: measured 300000 → 318000 on a game whose true final reading was
 * 317454/317270. That is not a rounding error, it is a fiction with a plausible
 * shape, which is the worst kind.
 *
 * Every frame therefore carries the FINAL clock. A consumer must not present it
 * as stepping with the ply.
 */
function withFinalClock(frame: ViewerState, source: ViewerState): ViewerState {
  return { ...frame, clockMs: { white: source.clockMs.white, black: source.clockMs.black } }
}

/**
 * One redacted position per index: 0 is the opening, N is after ply N.
 *
 * Returns an empty array when the game is not finished, or when the view does
 * not carry every 兵種 (see `openingFrom`).
 */
export function replayGame(vs: ViewerState, viewer: Viewer): ViewerState[] {
  const opening = openingFrom(vs)
  if (opening === null) return []

  const frames: ViewerState[] = [withFinalClock(stateForViewer(opening, viewer), vs)]

  let state = opening
  for (const event of vs.log) {
    // The log is the engine's own record, so this cannot diverge — but a
    // corrupt or hand-edited record should truncate the replay rather than
    // throw and blank a finished game.
    let next: GameState
    try {
      next = applyMove(state, event.move)
    } catch {
      break
    }
    state = next
    frames.push(withFinalClock(stateForViewer(state, viewer), vs))
  }

  /*
   * §3 — ENDINGS THAT WRITE NO MOVE.
   *
   * 認輸 and 讀秒 (game.ts `resign` / `flagFall`) end a game without appending a
   * log entry, so replaying the log alone leaves the final state `playing`. That
   * is not cosmetic: `entitledToRank` opens every rank on `status.kind === 'over'`
   * (§10.5), so without this the last frame of a resigned game would hide ranks
   * a viewer is entitled to — measured at 17/32 instead of 32/32.
   *
   * The true ending is carried on the input, so it is transplanted onto the
   * final position BEFORE redaction, which is the only point at which it can
   * still affect what that frame discloses.
   */
  const lastIndex = frames.length - 1
  if (lastIndex >= 0 && state.status.kind !== 'over') {
    const ended: GameState = { ...state, status: vs.status }
    frames[lastIndex] = withFinalClock(stateForViewer(ended, viewer), vs)
  }

  return frames
}
