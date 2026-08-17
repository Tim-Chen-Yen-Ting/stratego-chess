/**
 * Legal moves for EITHER side, computed from a redacted `ViewerState`.
 *
 * WHY THIS IS SOUND, and it is the whole point of the module: move legality
 * never touches the 兵種 layer. gamebook §1 splits the two — 載體層 decides how
 * a piece MOVES, 兵種層 decides what it BEATS — and 附錄 A requires the legal
 * move set to be identical whatever 兵種 a piece carries, with
 * `gamebook-audit.spec.ts` asserting exactly that. `moves.ts` says the same in
 * its own header: "Legality never depends on the rank layer."
 *
 * So a `ViewerState` already contains everything move generation needs. It is
 * not an approximation of the real generator and it is not a second copy of the
 * movement rules — it reconstructs the minimal state the existing generator
 * wants and calls it. There is still exactly ONE implementation of how pieces
 * move, which is what stops the two drifting apart.
 *
 * This exists because a policy needs to ask what the OPPONENT can do next, and
 * `ViewerState.legalMoves` carries only the viewer's own moves. Without it,
 * every consumer hand-rolls carrier geometry — which had already happened twice
 * before this module existed.
 *
 * WHAT IT DOES NOT GIVE YOU: any 兵種 information. It answers "where can that
 * piece go", never "what is it" or "would it win". Combat still needs a belief.
 */

import { castlePlan } from './board.js'
import { generatePieceMoves } from './moves.js'
import { STARTING_LAYOUT } from './setup.js'
import type {
  Color,
  GameState,
  Move,
  Piece,
  Square,
  ViewerPiece,
  ViewerState,
} from './types.js'

/**
 * Squares a piece has left at some point in the game.
 *
 * `ViewerPiece` deliberately carries no `hasMoved` — its field set is pinned by
 * a redaction test so that a stray spread cannot smuggle anything across the
 * boundary. But whether a piece has moved is entirely public: it is in the log.
 * Castling is the one move that relocates two pieces without an ordinary
 * `from`, so it is expanded through the engine's own `castlePlan`.
 */
function vacatedSquares(vs: ViewerState): Set<Square> {
  const seen = new Set<Square>()
  for (const e of vs.log) {
    if (e.move.kind === 'move') {
      seen.add(e.move.from)
    } else if (e.move.kind === 'castle') {
      const plan = castlePlan(e.color, e.move.side)
      seen.add(plan.kingFrom)
      seen.add(plan.rookFrom)
    }
  }
  return seen
}

/** The square a piece began the game on, from the §9 opening layout. */
function startingSquares(): Map<string, Square> {
  const out = new Map<string, Square>()
  for (const slot of STARTING_LAYOUT) out.set(slot.id, slot.square)
  return out
}

/**
 * Castling asks only whether the king and that rook have never moved (§3②).
 *
 * A piece standing on its own starting square has moved if and only if that
 * square was ever vacated: for it to have left and returned, a move must have
 * originated there. A piece standing anywhere else has obviously moved.
 */
function hasMovedFrom(
  piece: ViewerPiece,
  start: Map<string, Square>,
  vacated: ReadonlySet<Square>,
): boolean {
  const home = start.get(piece.id)
  if (home === undefined) return true
  if (piece.square !== home) return true
  return vacated.has(home)
}

/**
 * A GameState shaped well enough for move generation, and for nothing else.
 *
 * `rank` is filled with a placeholder because `Piece` requires the field and
 * the generator provably never reads it. Do NOT pass the result of this to
 * anything that resolves combat or scores — it would be reading a rank that was
 * invented here. It exists to be handed straight to `generatePieceMoves`.
 */
function movementStateOf(vs: ViewerState): GameState {
  const start = startingSquares()
  const vacated = vacatedSquares(vs)

  const pieces: Piece[] = vs.pieces.map((p) => ({
    id: p.id,
    color: p.color,
    carrier: p.carrier,
    // placeholder — never read by move generation (附錄 A, moves.ts header)
    rank: 'engineer',
    square: p.square,
    revealed: p.revealed,
    hasMoved: hasMovedFrom(p, start, vacated),
  }))

  return {
    id: vs.id,
    pieces,
    toMove: vs.toMove,
    ply: vs.ply,
    score: { white: vs.score.white, black: vs.score.black },
    log: vs.log,
    clockMs: { white: vs.clockMs.white, black: vs.clockMs.black },
    noProgressTurns: vs.noProgressTurns,
    status: vs.status,
    config: vs.config,
  }
}

/**
 * Every legal move for `color`, derived from public information alone.
 *
 * Includes `pass`, which §3④ makes always legal. For the viewer's own colour
 * this agrees with `ViewerState.legalMoves` exactly; for the opponent it is the
 * list that field never carries.
 */
export function carrierMoves(vs: ViewerState, color: Color): Move[] {
  if (vs.status.kind !== 'playing') return []
  const moves = generatePieceMoves(movementStateOf(vs), color).map((r) => r.move)
  moves.push({ kind: 'pass' })
  return moves
}

/**
 * Squares `color` could move a piece ONTO next ply, mapped to the pieces that
 * could go there. The shape a lookahead actually wants: "who can reach this
 * square, and from where".
 */
export function reachableSquares(
  vs: ViewerState,
  color: Color,
): Map<Square, { from: Square; carrier: ViewerPiece['carrier'] }[]> {
  const bySquare = new Map<Square, ViewerPiece>()
  for (const p of vs.pieces) if (p.square !== null) bySquare.set(p.square, p)

  const out = new Map<Square, { from: Square; carrier: ViewerPiece['carrier'] }[]>()
  for (const move of carrierMoves(vs, color)) {
    if (move.kind !== 'move') continue
    const mover = bySquare.get(move.from)
    if (mover === undefined) continue
    const list = out.get(move.to)
    const entry = { from: move.from, carrier: mover.carrier }
    if (list === undefined) out.set(move.to, [entry])
    else list.push(entry)
  }
  return out
}
