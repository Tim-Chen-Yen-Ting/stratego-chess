/**
 * 視野 — fogofwar.md §1.1. Unit coverage for `pieceVisibleSquares`/`visionOf`,
 * one case per carrier, plus the two edge cases the general rule adds on top
 * of the doc's simplified per-piece bullets: a slider's ray-blocked square is
 * itself visible regardless of who occupies it, and a pawn's double-step
 * square is visible only through an empty path.
 */

import { describe, expect, it } from 'vitest'
import { sq } from './helpers.js'
import { pieceVisibleSquares, visionOf, type VisionPiece } from '../src/vision.js'

function piece(at: string, color: VisionPiece['color'], carrier: VisionPiece['carrier']): VisionPiece {
  return { color, carrier, square: sq(at) }
}

function visible(occupiedAt: readonly string[], p: VisionPiece): Set<string> {
  const occupied = new Set(occupiedAt.map(sq))
  return new Set(pieceVisibleSquares(occupied, p).map((s) => squareNameOf(s)))
}

// local, so this file does not have to import the board module just for one name
function squareNameOf(s: number): string {
  const file = 'abcdefgh'[s & 7]!
  const rank = String((s >> 3) + 1)
  return `${file}${rank}`
}

describe('視野 — pieceVisibleSquares', () => {
  it('king sees only the 8 adjacent squares', () => {
    const p = piece('e4', 'white', 'king')
    const got = visible(['e4'], p)
    expect(got).toEqual(new Set(['d3', 'd4', 'd5', 'e3', 'e5', 'f3', 'f4', 'f5']))
  })

  it('knight sees adjacent-8 ∪ its 8 leap squares, unblockable', () => {
    const p = piece('e4', 'white', 'knight')
    // occupy every leap square AND every adjacent square — none of it blocks a leap
    const got = visible(
      ['e4', 'd3', 'd5', 'f3', 'f5', 'e3', 'e5', 'd4', 'f4', 'c3', 'c5', 'g3', 'g5', 'd2', 'd6', 'f2', 'f6'],
      p,
    )
    expect(got).toEqual(
      new Set([
        // adjacent 8
        'd3', 'd4', 'd5', 'e3', 'e5', 'f3', 'f4', 'f5',
        // 8 leaps
        'd2', 'd6', 'f2', 'f6', 'c3', 'c5', 'g3', 'g5',
      ]),
    )
  })

  it('rook sees adjacent-8 ∪ each ray, stopping AT the first occupied square', () => {
    const p = piece('d4', 'white', 'rook')
    // a piece (either colour) sitting on d7, three squares up the file
    const got = visible(['d4', 'd7'], p)
    // the whole d-file ray up to and including d7, and correspondingly on the
    // other three rays out to the edge of the board — d7 is visible, d8 is not
    expect(got.has('d5')).toBe(true)
    expect(got.has('d6')).toBe(true)
    expect(got.has('d7')).toBe(true)
    expect(got.has('d8')).toBe(false)
    // unblocked rays reach the edge
    expect(got.has('a4')).toBe(true)
    expect(got.has('h4')).toBe(true)
    expect(got.has('d1')).toBe(true)
    // adjacent-8 is still present
    expect(got.has('c3')).toBe(true)
    expect(got.has('e5')).toBe(true)
  })

  it("a ray is blocked by the mover's OWN piece too — vision is not movement", () => {
    // moves.ts would never generate a "capture" of an own piece, but vision
    // must still show the square that piece occupies, per §1.1 該格看得見.
    const p = piece('d4', 'white', 'rook')
    const got = visible(['d4', 'd6'], p) // d6 stands empty-or-not, doesn't matter which colour
    expect(got.has('d5')).toBe(true)
    expect(got.has('d6')).toBe(true) // the blocking square itself is visible
    expect(got.has('d7')).toBe(false) // beyond it is not
  })

  it('bishop sees adjacent-8 ∪ diagonal rays, blocker-inclusive', () => {
    const p = piece('d4', 'white', 'bishop')
    const got = visible(['d4', 'g7'], p)
    expect(got.has('e5')).toBe(true)
    expect(got.has('f6')).toBe(true)
    expect(got.has('g7')).toBe(true)
    expect(got.has('h8')).toBe(false)
  })

  it('queen combines rook and bishop rays', () => {
    const p = piece('d4', 'white', 'queen')
    const got = visible(['d4'], p)
    expect(got.has('a4')).toBe(true) // rook ray
    expect(got.has('a1')).toBe(true) // bishop ray
    expect(got.has('h8')).toBe(true) // bishop ray, other diagonal
  })

  it('pawn off its home rank sees only the adjacent 8', () => {
    const p = piece('e5', 'white', 'pawn')
    const got = visible(['e5'], p)
    expect(got).toEqual(new Set(['d4', 'd5', 'd6', 'e4', 'e6', 'f4', 'f5', 'f6']))
  })

  it('pawn on its home rank with an empty path also sees its double-step square', () => {
    const p = piece('e2', 'white', 'pawn')
    const got = visible(['e2'], p)
    expect(got.has('e4')).toBe(true) // the double-step square
    expect(got.has('e3')).toBe(true) // already in the adjacent-8 term
  })

  it("pawn on its home rank blocked one square ahead does NOT see the double-step square", () => {
    const p = piece('e2', 'white', 'pawn')
    const got = visible(['e2', 'e3'], p)
    expect(got.has('e3')).toBe(true) // adjacent-8 still shows the blocker
    expect(got.has('e4')).toBe(false) // but the pawn cannot move there, so no extra vision
  })

  it("black pawn's home rank and forward direction are mirrored", () => {
    const p = piece('e7', 'black', 'pawn')
    const got = visible(['e7'], p)
    expect(got.has('e5')).toBe(true)
  })
})

describe('視野 — visionOf', () => {
  it('unions every on-board piece of the given colour, ignoring the other colour and captured pieces', () => {
    const pieces: VisionPiece[] = [
      piece('a1', 'white', 'king'),
      piece('h8', 'white', 'knight'),
      { color: 'white', carrier: 'queen', square: null }, // captured — contributes nothing
      piece('a8', 'black', 'king'), // opponent — not unioned in for 'white'
    ]
    const got = new Set([...visionOf(pieces, 'white')].map(squareNameOf))
    // from a1's king: adjacent 8 (only a2/b1/b2 are on-board)
    expect(got.has('a2')).toBe(true)
    expect(got.has('b1')).toBe(true)
    expect(got.has('b2')).toBe(true)
    // from h8's knight leap
    expect(got.has('f7')).toBe(true)
    expect(got.has('g6')).toBe(true)
    // never anything the black king alone would see and white's pieces do not
    expect(got.has('b8')).toBe(false)
  })

  it('a lone piece does not see its own square (redact.ts unions that in separately)', () => {
    const pieces: VisionPiece[] = [piece('e4', 'white', 'king')]
    const got = visionOf(pieces, 'white')
    expect(got.has(sq('e4'))).toBe(false)
  })
})
