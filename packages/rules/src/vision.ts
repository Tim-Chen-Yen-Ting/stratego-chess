/**
 * 視野 — fogofwar.md §1.1. Not wired into `applyMove` or `legalMoves` at all:
 * this module only ANSWERS "what can this colour currently see", which
 * `redact.ts` consumes to decide whether to disclose a piece's existence, and
 * which the web client re-derives client-side for its own always-visible
 * pieces to paint the fog overlay. Legality itself never changes (附錄 A).
 *
 * THE RULE (§1.1, general form — this module implements this, not the
 * per-piece bullets underneath it, which are lossy restatements of it):
 *
 *   每顆己方棋子提供的視野＝它的周圍八格 ∪ 它能合法移動到的所有格。
 *
 * For a slider this is NOT the same walk `moves.ts` does for move
 * generation: `generateForPiece` stops a ray at the first occupied square and
 * pushes a MOVE only when that square is an enemy. Vision needs the blocked
 * square itself to be visible regardless of who stands on it (§1.1: "該格看
 * 得見，其後看不見") — you can always see your own piece three squares up a
 * rank even though it is not a destination you can move to.
 */

import { fileOf, forwardDir, inBounds, makeSquare, pawnHomeRank, rankOf } from './board.js'
import type { Carrier, Color, Square } from './types.js'

const KING_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
]

const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
]

const ROOK_RAYS: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]
const BISHOP_RAYS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
const QUEEN_RAYS: ReadonlyArray<readonly [number, number]> = [...ROOK_RAYS, ...BISHOP_RAYS]

/** The minimal shape vision needs — satisfied by both `Piece` and `ViewerPiece`. */
export interface VisionPiece {
  color: Color
  carrier: Carrier
  square: Square | null
}

/** Every square one piece's vision reaches, per §1.1. */
export function pieceVisibleSquares(occupied: ReadonlySet<Square>, piece: VisionPiece): Square[] {
  const from = piece.square
  if (from === null) return []
  const f = fileOf(from)
  const r = rankOf(from)
  const out: Square[] = []

  // Adjacent 8, always — the common term in every carrier's vision (§1.1).
  for (const [df, dr] of KING_STEPS) {
    const cf = f + df
    const cr = r + dr
    if (inBounds(cf, cr)) out.push(makeSquare(cf, cr))
  }

  switch (piece.carrier) {
    case 'pawn': {
      // The one case the adjacent-8 term does not already cover: a double
      // step from the home rank, and only through an empty path — an
      // occupied square ahead is not a square this pawn can move to, and the
      // adjacent-8 term already grants visibility of the blocking square.
      const oneRank = r + forwardDir(piece.color)
      if (r === pawnHomeRank(piece.color) && inBounds(f, oneRank)) {
        const one = makeSquare(f, oneRank)
        const twoRank = r + 2 * forwardDir(piece.color)
        if (!occupied.has(one) && inBounds(f, twoRank)) out.push(makeSquare(f, twoRank))
      }
      break
    }

    case 'king':
      // Adjacent-8 is the whole of it (§1.1: "全場視野最小").
      break

    case 'knight':
      // Leaps are never blocked, so every landing square is visible outright.
      for (const [df, dr] of KNIGHT_STEPS) {
        const cf = f + df
        const cr = r + dr
        if (inBounds(cf, cr)) out.push(makeSquare(cf, cr))
      }
      break

    case 'bishop':
    case 'rook':
    case 'queen': {
      const rays = piece.carrier === 'bishop' ? BISHOP_RAYS
        : piece.carrier === 'rook' ? ROOK_RAYS
          : QUEEN_RAYS
      for (const [df, dr] of rays) {
        let cf = f + df
        let cr = r + dr
        while (inBounds(cf, cr)) {
          const target = makeSquare(cf, cr)
          out.push(target)
          if (occupied.has(target)) break // blocked — by either colour — and visible up to here only
          cf += df
          cr += dr
        }
      }
      break
    }
  }

  return out
}

/**
 * The union of every on-board `color` piece's vision, per §1.1 — "己方全部棋子
 * 的視野取聯集". Does NOT include the always-visible 結算格 (fogofwar.md §1.3);
 * a caller that needs those unions them in separately, since that rule is
 * about the game's config rather than about any piece's vision.
 */
export function visionOf(pieces: readonly VisionPiece[], color: Color): Set<Square> {
  const occupied = new Set<Square>()
  for (const p of pieces) if (p.square !== null) occupied.add(p.square)

  const out = new Set<Square>()
  for (const p of pieces) {
    if (p.color !== color || p.square === null) continue
    for (const sq of pieceVisibleSquares(occupied, p)) out.add(sq)
  }
  return out
}
