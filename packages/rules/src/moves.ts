/**
 * Move generation. Gamebook §3.
 *
 * Written from scratch — no chess library. The carrier layer moves exactly as
 * in chess (§3 opening line), with these explicit overrides:
 *
 *   §3①  the king is an ordinary piece. No check, no checkmate, so there is
 *        no "does this move leave me in check" filter at all: pseudo-legal
 *        moves ARE legal moves.
 *   §3②  castling is unconditional apart from three purely positional tests.
 *   §3③  no legal move simply means the turn is skipped — never stalemate.
 *   §3④  pass is always legal, whether or not other moves exist.
 *   §4    moving onto ANY enemy piece is legal, including a move you know
 *        loses, and including moving your 軍旗 into a piece (which loses the
 *        game on the spot, §7.5①). Legality never depends on the rank layer —
 *        it must not, or the move list itself would leak 兵種 (附錄 A).
 */

import {
  buildOccupancy,
  castlePlan,
  fileOf,
  forwardDir,
  inBounds,
  makeSquare,
  pawnDoubleStepRank,
  pawnHomeRank,
  parseSquare,
  promotionRank,
  rankOf,
  squareName,
  type Occupancy,
} from './board.js'
import type {
  Carrier,
  Color,
  GameState,
  Move,
  Piece,
  PieceId,
  Square,
} from './types.js'

export type PromotionCarrier = Exclude<Carrier, 'pawn' | 'king'>

export const PROMOTION_CHOICES: PromotionCarrier[] = ['queen', 'rook', 'bishop', 'knight']

const PROMOTION_LETTER: Record<PromotionCarrier, string> = {
  queen: 'q', rook: 'r', bishop: 'b', knight: 'n',
}

const LETTER_PROMOTION: Record<string, PromotionCarrier> = {
  q: 'queen', r: 'rook', b: 'bishop', n: 'knight',
}

/**
 * A generated move with its geometry already worked out, so that game.ts never
 * has to re-derive it. Internal to the engine.
 */
export interface ResolvedMove {
  move: Move
  moverId: PieceId
  from: Square
  /** where the mover ends up *if it survives the contact*. */
  to: Square
  /**
   * The square holding the piece that is contacted, or null for a quiet move.
   * Equal to `to` for an ordinary capture; DIFFERENT from `to` for en passant
   * — the one case in the game where 接觸格 ≠ 目的格 (§4).
   */
  contactSquare: Square | null
  isEnPassant: boolean
  isDoubleStep: boolean
  promoteTo?: PromotionCarrier
  castle?: {
    side: 'king' | 'queen'
    kingId: PieceId
    rookId: PieceId
    kingFrom: Square
    kingTo: Square
    rookFrom: Square
    rookTo: Square
  }
}

const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
]

const KING_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
]

const ROOK_RAYS: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]]
const BISHOP_RAYS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
const QUEEN_RAYS: ReadonlyArray<readonly [number, number]> = [...ROOK_RAYS, ...BISHOP_RAYS]

// ---------------------------------------------------------------------------
// En passant availability
// ---------------------------------------------------------------------------

export interface EnPassantInfo {
  /** the pawn that just double-stepped and may be captured */
  victim: Piece
  /** the square it skipped over — the capturing pawn's destination */
  skipped: Square
}

/**
 * En passant is RETAINED (§3, §4). GameState carries no dedicated ep field
 * (techspec §3 is normative and has none), so availability is derived from the
 * immediately preceding log entry — which is exactly the chess rule: the
 * window is one ply wide and closes on any other move, including a pass.
 */
export function enPassantInfo(s: GameState): EnPassantInfo | null {
  const last = s.log[s.log.length - 1]
  if (!last) return null
  if (last.move.kind !== 'move') return null
  // A double step is never a capture; requiring this also rules out a rook
  // that slid two ranks and LOST, leaving an enemy pawn standing on `to`.
  if (last.combat) return null

  const { from, to } = last.move
  if (fileOf(from) !== fileOf(to)) return null
  if (rankOf(from) !== pawnHomeRank(last.color)) return null
  if (rankOf(to) !== pawnDoubleStepRank(last.color)) return null

  const victim = s.pieces.find((p) => p.square === to)
  if (!victim || victim.carrier !== 'pawn' || victim.color !== last.color) return null

  return { victim, skipped: (from + to) / 2 }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function pushPawnDestination(
  out: ResolvedMove[],
  mover: Piece,
  from: Square,
  to: Square,
  contactSquare: Square | null,
  isEnPassant: boolean,
  isDoubleStep: boolean,
): void {
  if (rankOf(to) === promotionRank(mover.color)) {
    // The promotion choice is declared with the move even when the move may
    // lose the contact; it only takes effect if the pawn survives (§6).
    for (const promote of PROMOTION_CHOICES) {
      out.push({
        move: { kind: 'move', from, to, promote },
        moverId: mover.id,
        from,
        to,
        contactSquare,
        isEnPassant,
        isDoubleStep,
        promoteTo: promote,
      })
    }
    return
  }
  out.push({
    move: { kind: 'move', from, to },
    moverId: mover.id,
    from,
    to,
    contactSquare,
    isEnPassant,
    isDoubleStep,
  })
}

function pushPlain(out: ResolvedMove[], mover: Piece, from: Square, to: Square, capture: boolean): void {
  out.push({
    move: { kind: 'move', from, to },
    moverId: mover.id,
    from,
    to,
    contactSquare: capture ? to : null,
    isEnPassant: false,
    isDoubleStep: false,
  })
}

function generateForPiece(
  occ: Occupancy,
  ep: EnPassantInfo | null,
  piece: Piece,
  out: ResolvedMove[],
): void {
  const from = piece.square
  if (from === null) return
  const f = fileOf(from)
  const r = rankOf(from)

  switch (piece.carrier) {
    case 'pawn': {
      const dir = forwardDir(piece.color)

      const oneRank = r + dir
      if (inBounds(f, oneRank)) {
        const one = makeSquare(f, oneRank)
        if (!occ[one]) {
          pushPawnDestination(out, piece, from, one, null, false, false)

          const twoRank = r + 2 * dir
          if (r === pawnHomeRank(piece.color) && inBounds(f, twoRank)) {
            const two = makeSquare(f, twoRank)
            if (!occ[two]) {
              pushPawnDestination(out, piece, from, two, null, false, true)
            }
          }
        }
      }

      for (const df of [-1, 1]) {
        const cf = f + df
        const cr = r + dir
        if (!inBounds(cf, cr)) continue
        const target = makeSquare(cf, cr)
        const victim = occ[target]
        if (victim && victim.color !== piece.color) {
          pushPawnDestination(out, piece, from, target, target, false, false)
        } else if (!victim && ep && ep.skipped === target && ep.victim.color !== piece.color) {
          // 接觸格 ≠ 目的格: the mover lands on `target`, the pawn it fights
          // stands on ep.victim.square.
          pushPawnDestination(out, piece, from, target, ep.victim.square!, true, false)
        }
      }
      break
    }

    case 'knight': {
      for (const [df, dr] of KNIGHT_STEPS) {
        const cf = f + df
        const cr = r + dr
        if (!inBounds(cf, cr)) continue
        const target = makeSquare(cf, cr)
        const other = occ[target]
        if (other && other.color === piece.color) continue
        pushPlain(out, piece, from, target, !!other)
      }
      break
    }

    case 'king': {
      for (const [df, dr] of KING_STEPS) {
        const cf = f + df
        const cr = r + dr
        if (!inBounds(cf, cr)) continue
        const target = makeSquare(cf, cr)
        const other = occ[target]
        if (other && other.color === piece.color) continue
        pushPlain(out, piece, from, target, !!other)
      }
      break
    }

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
          const other = occ[target]
          if (other) {
            if (other.color !== piece.color) pushPlain(out, piece, from, target, true)
            break
          }
          pushPlain(out, piece, from, target, false)
          cf += df
          cr += dr
        }
      }
      break
    }
  }
}

/**
 * Castling, gamebook §3②. Exactly three conditions:
 *   1. king and rook are both standing on their starting squares
 *   2. neither has ever moved
 *   3. nothing between them
 * The three check-dependent chess preconditions do not apply — there is no
 * check in this game.
 */
function generateCastles(
  occ: Occupancy,
  color: Color,
  out: ResolvedMove[],
): void {
  for (const side of ['king', 'queen'] as const) {
    const plan = castlePlan(color, side)
    const king = occ[plan.kingFrom]
    const rook = occ[plan.rookFrom]
    if (!king || king.color !== color || king.carrier !== 'king' || king.hasMoved) continue
    if (!rook || rook.color !== color || rook.carrier !== 'rook' || rook.hasMoved) continue
    if (plan.between.some((sq) => occ[sq])) continue
    out.push({
      move: { kind: 'castle', side },
      moverId: king.id,
      from: plan.kingFrom,
      to: plan.kingTo,
      contactSquare: null,
      isEnPassant: false,
      isDoubleStep: false,
      castle: {
        side,
        kingId: king.id,
        rookId: rook.id,
        kingFrom: plan.kingFrom,
        kingTo: plan.kingTo,
        rookFrom: plan.rookFrom,
        rookTo: plan.rookTo,
      },
    })
  }
}

/**
 * All moves that actually shift a piece — i.e. everything except pass.
 * Deterministically ordered: by origin square, then destination, then
 * promotion choice; castles last.
 */
export function generatePieceMoves(s: GameState, color: Color): ResolvedMove[] {
  const occ = buildOccupancy(s.pieces)
  const ep = enPassantInfo(s)
  const out: ResolvedMove[] = []
  for (const piece of s.pieces) {
    if (piece.color !== color || piece.square === null) continue
    generateForPiece(occ, ep, piece, out)
  }
  out.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    if (a.to !== b.to) return a.to - b.to
    return promoOrder(a.promoteTo) - promoOrder(b.promoteTo)
  })
  generateCastles(occ, color, out)
  return out
}

function promoOrder(p: PromotionCarrier | undefined): number {
  return p === undefined ? -1 : PROMOTION_CHOICES.indexOf(p)
}

/** True when the side to move has no piece move — i.e. its pass is FORCED (§8). */
export function hasAnyPieceMove(s: GameState, color: Color): boolean {
  return generatePieceMoves(s, color).length > 0
}

/**
 * All legal moves for `color`.
 *
 * Always includes `{ kind: 'pass' }` while the game is running (§3④): pass is
 * legal whether or not anything else is. A game that is not in the `playing`
 * status has no legal moves at all, pass included.
 */
export function legalMoves(s: GameState, color: Color): Move[] {
  if (s.status.kind !== 'playing') return []
  const moves = generatePieceMoves(s, color).map((r) => r.move)
  moves.push({ kind: 'pass' })
  return moves
}

/**
 * Find the generated move matching a caller-supplied Move.
 *
 * Promotion is matched leniently: a pawn move onto the last rank with no
 * `promote` (or an unrecognised one) is read as a queen promotion, so a client
 * that forgets the suffix still gets a legal move rather than a throw.
 */
export function matchMove(s: GameState, color: Color, move: Move): ResolvedMove | null {
  const candidates = generatePieceMoves(s, color)

  if (move.kind === 'castle') {
    return candidates.find((c) => c.move.kind === 'castle' && c.castle?.side === move.side) ?? null
  }

  if (move.kind === 'move') {
    const sameSquares = candidates.filter((c) => c.from === move.from && c.to === move.to)
    if (sameSquares.length === 0) return null
    if (sameSquares.length === 1 && sameSquares[0]!.promoteTo === undefined) return sameSquares[0]!
    const wanted = move.promote
    return (
      sameSquares.find((c) => c.promoteTo === wanted)
      ?? sameSquares.find((c) => c.promoteTo === 'queen')
      ?? sameSquares[0]!
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Notation — the wire format for the LLM interface (techspec §6)
// ---------------------------------------------------------------------------

/** `e2e4`, `e7e8q`, `O-O`, `O-O-O`, `pass`. */
export function moveToNotation(move: Move): string {
  switch (move.kind) {
    case 'move':
      return squareName(move.from) + squareName(move.to) + (move.promote ? PROMOTION_LETTER[move.promote] : '')
    case 'castle':
      return move.side === 'king' ? 'O-O' : 'O-O-O'
    case 'pass':
      return 'pass'
  }
}

/** Inverse of `moveToNotation`. Returns null on anything unparseable. */
export function parseMoveNotation(text: string): Move | null {
  const raw = text.trim()
  const lower = raw.toLowerCase()

  if (lower === 'pass') return { kind: 'pass' }
  if (lower === 'o-o' || lower === '0-0' || lower === 'oo') return { kind: 'castle', side: 'king' }
  if (lower === 'o-o-o' || lower === '0-0-0' || lower === 'ooo') return { kind: 'castle', side: 'queen' }

  if (lower.length !== 4 && lower.length !== 5) return null
  const from = parseSquare(lower.slice(0, 2))
  const to = parseSquare(lower.slice(2, 4))
  if (from === null || to === null) return null
  if (lower.length === 4) return { kind: 'move', from, to }

  const promote = LETTER_PROMOTION[lower[4]!]
  if (!promote) return null
  return { kind: 'move', from, to, promote }
}
