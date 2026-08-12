/**
 * The state machine. Gamebook §4 (位置結算), §5, §6, §7, §8.
 *
 * Every ply is two sub-steps, in this order (§7):
 *
 *   ① 行動階段 — move / capture / castle / pass. 奪旗 is decided HERE and
 *      ends the game immediately, before any scoring happens.
 *   ② 結算階段 — both sides score the centre, then the score target (§7②) and
 *      the stagnation counter (§7③) are checked.
 *
 * `applyMove` is pure: the input state is never mutated, and every mutable
 * sub-object of the returned state is freshly allocated.
 */

import { opposite, promotionRank, rankOf } from './board.js'
import { resolveCombat } from './combat.js'
import { hasAnyPieceMove, matchMove, type ResolvedMove } from './moves.js'
import type {
  Color,
  GameConfig,
  GameEvent,
  GameState,
  Move,
  Piece,
  Result,
  Square,
} from './types.js'

function clonePieces(pieces: readonly Piece[]): Piece[] {
  return pieces.map((p) => ({ ...p }))
}

function initialScore(s: GameState): { white: number; black: number } {
  return { white: 0, black: s.config.komi }
}

/**
 * ② 結算 (§7): +1 per own piece standing on a scoring square.
 *
 * The square list is a PARAMETER, never a module constant — callers pass
 * `state.config.scoringSquares` (附錄 B: 必須為設定值，不得寫死), so a game
 * scores the shape it was created with. This counts PIECES, not squares, so a
 * duplicate in the list cannot pay twice.
 */
export function scoringPoints(
  pieces: readonly Piece[],
  color: Color,
  scoringSquares: readonly Square[],
): number {
  let n = 0
  for (const p of pieces) {
    if (p.color === color && p.square !== null && scoringSquares.includes(p.square)) n++
  }
  return n
}

/**
 * @deprecated Former name of {@link scoringPoints}, when the squares were fixed
 * at 中央四格. Kept so existing imports resolve; the square list is now required.
 */
export const centerPoints = scoringPoints

/** Did the given ply move the needle for §7③ — a capture, or any point scored? */
function plyHadProgress(
  log: readonly GameEvent[],
  index: number,
  base: { white: number; black: number },
): boolean {
  const e = log[index]
  if (!e) return false
  if (e.combat) return true
  const before = index > 0 ? log[index - 1]!.scoreAfter : base
  return e.scoreAfter.white !== before.white || e.scoreAfter.black !== before.black
}

/**
 * §7② / §7③ tie-break. 貼目 is meant to make an exact tie impossible; komi is
 * a configurable knob (附錄 B) so a caller can set it to 0 and produce one
 * anyway. Deterministic fallback: the tie goes to black, the side komi exists
 * to favour.
 */
function leader(score: { white: number; black: number }): Color {
  return score.white > score.black ? 'white' : 'black'
}

export function isGameOver(s: GameState): boolean {
  return s.status.kind === 'over'
}

// ---------------------------------------------------------------------------
// applyMove
// ---------------------------------------------------------------------------

export function applyMove(s: GameState, move: Move): GameState {
  if (s.status.kind !== 'playing') throw new Error('game is not accepting moves')

  const mover: Color = s.toMove
  const pieces = clonePieces(s.pieces)
  const byId = new Map(pieces.map((p) => [p.id, p]))

  let resolved: ResolvedMove | null = null
  let forcedPass = false

  if (move.kind === 'pass') {
    // §3④ pass is always legal. §8: the increment is only granted when the
    // pass was FORCED, and "forced" is decided purely by carrier-layer
    // geometry, which both players can verify — it leaks no 兵種.
    forcedPass = !hasAnyPieceMove(s, mover)
  } else {
    resolved = matchMove(s, mover, move)
    if (!resolved) throw new Error(`illegal move: ${JSON.stringify(move)}`)
  }

  let combat: GameEvent['combat']
  let promoted: GameEvent['promoted']
  const recordedMove: Move = resolved ? resolved.move : { kind: 'pass' }

  // ---------------------------------------------------------------- ① ACTION
  if (resolved?.castle) {
    // §1 / §5: castling only relocates the carrier layer. The 兵種 layer is
    // untouched, and this is explicitly NOT "leaving the board" for a 軍旗.
    const king = byId.get(resolved.castle.kingId)!
    const rook = byId.get(resolved.castle.rookId)!
    king.square = resolved.castle.kingTo
    king.hasMoved = true
    rook.square = resolved.castle.rookTo
    rook.hasMoved = true
  } else if (resolved) {
    const attacker = byId.get(resolved.moverId)!
    const defender = resolved.contactSquare === null
      ? undefined
      : pieces.find((p) => p.square === resolved!.contactSquare && p.id !== attacker.id)

    let attackerSurvives = true

    if (defender) {
      const r = resolveCombat(attacker.rank, defender.rank, attacker.color, defender.color)
      attackerSurvives = r.attackerSurvives

      // §4 位置結算. The losing attacker is removed FROM ITS ORIGIN and never
      // enters the target square; the defender does not move at all. For en
      // passant this also means the skipped square simply stays empty.
      if (r.attackerSurvives) {
        attacker.square = resolved.to
      } else {
        attacker.square = null
      }
      if (!r.defenderSurvives) {
        defender.square = null
      }

      // §4.3 / §4 翻明總表. Losers are never revealed, and 工兵/軍旗 beating a
      // 爆裂物 reveals nothing at all (附錄 A) — resolveCombat already encodes
      // that, so this stays a dumb transcription.
      if (r.revealAttacker) attacker.revealed = true
      if (r.revealDefender) defender.revealed = true

      combat = {
        outcome: r.outcome,
        attackerSquare: resolved.from,
        defenderSquare: resolved.contactSquare!,
        survivorSquare: r.attackerSurvives
          ? resolved.to
          : r.defenderSurvives
            ? resolved.contactSquare!
            : null,
      }
    } else {
      attacker.square = resolved.to
    }

    attacker.hasMoved = true

    // §6 升變. Only a SURVIVING pawn promotes, and "surviving" includes the
    // 有煙無傷 case where a 工兵/軍旗 walked over a 爆裂物 onto the last rank
    // (§5) — no rank comparison happened, but the pawn is standing there.
    if (
      attackerSurvives
      && attacker.carrier === 'pawn'
      && rankOf(resolved.to) === promotionRank(attacker.color)
    ) {
      const choice = resolved.promoteTo ?? 'queen'
      attacker.carrier = choice
      promoted = choice
    }
  }

  // §7① 奪旗 — decided inside the ACTION sub-step, before any scoring.
  // Promotion and castling above never null a square, so they can never
  // trigger this (§5).
  const whiteFlagGone = flagIsOff(pieces, 'white')
  const blackFlagGone = flagIsOff(pieces, 'black')
  let result: Result | null = null
  if (whiteFlagGone && blackFlagGone) {
    result = { kind: 'flag-both' }            // the only draw in the game
  } else if (whiteFlagGone) {
    result = { kind: 'flag', winner: 'black' }
  } else if (blackFlagGone) {
    result = { kind: 'flag', winner: 'white' }
  }

  // ------------------------------------------------------------ ② SETTLEMENT
  const score = { ...s.score }
  let noProgressTurns = s.noProgressTurns

  if (!result) {
    // Both players score, every single ply (§7). A piece captured in ① is
    // already off the board and does not score for this ply. The board shape
    // comes from THIS game's config, never from a constant.
    score.white += scoringPoints(pieces, 'white', s.config.scoringSquares)
    score.black += scoringPoints(pieces, 'black', s.config.scoringSquares)
  }

  const event: GameEvent = {
    ply: s.ply,
    color: mover,
    move: recordedMove,
    ...(combat ? { combat } : {}),
    ...(promoted ? { promoted } : {}),
    scoreAfter: { white: score.white, black: score.black },
  }
  const log = [...s.log, event]

  if (!result) {
    if (score.white >= s.config.scoreTarget || score.black >= s.config.scoreTarget) {
      result = { kind: 'score', winner: leader(score) }
    }
  }

  // §7③ 停滯. The counter measures FULL TURNS (white ply + black ply) in which
  // nothing was captured and neither side scored. Any capture or any point
  // zeroes it. Turns close on even plies, because ply 1 is white's.
  const thisIndex = log.length - 1
  const base = initialScore(s)
  const progressNow = plyHadProgress(log, thisIndex, base)
  if (progressNow) {
    noProgressTurns = 0
  } else if (s.ply % 2 === 0 && !plyHadProgress(log, thisIndex - 1, base)) {
    noProgressTurns = s.noProgressTurns + 1
  }

  if (!result && noProgressTurns >= s.config.noProgressTurns) {
    result = { kind: 'no-progress', winner: leader(score) }
  }

  // §8 增秒: granted on a completed move, or on a forced pass. Never on a
  // voluntary pass.
  const clockMs = { ...s.clockMs }
  if (s.config.clockEnabled && (resolved !== null || forcedPass)) {
    clockMs[mover] += s.config.clockIncrementMs
  }

  return {
    id: s.id,
    pieces,
    toMove: opposite(mover),
    ply: s.ply + 1,
    score,
    log,
    clockMs,
    noProgressTurns,
    status: result ? { kind: 'over', result } : { kind: 'playing' },
    config: { ...s.config },
  }
}

/**
 * §7① — a side loses the instant its 軍旗 leaves the board, by any route:
 * captured, thrown at another piece, or traded off against the enemy 軍旗.
 */
function flagIsOff(pieces: readonly Piece[], color: Color): boolean {
  const flags = pieces.filter((p) => p.color === color && p.rank === 'flag')
  if (flags.length === 0) return false
  return flags.every((p) => p.square === null)
}

// ---------------------------------------------------------------------------
// Terminations that do not come from a move
// ---------------------------------------------------------------------------

/** §7⑤ 認輸 — available at any time, including during setup. */
export function resign(s: GameState, color: Color): GameState {
  if (s.status.kind === 'over') return s
  return {
    ...s,
    pieces: clonePieces(s.pieces),
    score: { ...s.score },
    log: [...s.log],
    clockMs: { ...s.clockMs },
    config: { ...s.config },
    status: { kind: 'over', result: { kind: 'resign', winner: opposite(color) } },
  }
}

/** §7④ 超時 — `color`'s clock hit zero. Nothing to do with 軍旗. */
export function flagFall(s: GameState, color: Color): GameState {
  if (s.status.kind !== 'playing') return s
  return {
    ...s,
    pieces: clonePieces(s.pieces),
    score: { ...s.score },
    log: [...s.log],
    clockMs: { ...s.clockMs, [color]: 0 },
    config: { ...s.config },
    status: { kind: 'over', result: { kind: 'timeout', winner: opposite(color) } },
  }
}

/**
 * Subtract elapsed time from one side's clock, floored at zero. Pure; the
 * server owns the timer and decides when to call `flagFall`.
 */
export function tickClock(s: GameState, color: Color, elapsedMs: number): GameState {
  if (!s.config.clockEnabled) return s
  const remaining = Math.max(0, s.clockMs[color] - Math.max(0, elapsedMs))
  return {
    ...s,
    pieces: clonePieces(s.pieces),
    score: { ...s.score },
    log: [...s.log],
    clockMs: { ...s.clockMs, [color]: remaining },
    config: { ...s.config },
  }
}

/**
 * Squares that score this ply, for UI highlighting. Reads the game's own
 * config, so a board created with a different preset highlights that preset.
 *
 * Takes anything carrying a config — `GameState` and `ViewerState` both fit, so
 * a client can ask the same question of the redacted state it actually holds.
 * Returns a fresh mutable copy; the config's own list is frozen.
 */
export function scoringSquares(s: { config: GameConfig }): Square[] {
  return [...s.config.scoringSquares]
}

/**
 * @deprecated Former name of {@link scoringSquares}, when it answered from a
 * constant and took no argument. Kept so existing imports resolve.
 */
export const centerSquares = scoringSquares
