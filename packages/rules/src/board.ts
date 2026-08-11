/**
 * Square encoding and coordinate helpers.
 *
 * Encoding (techspec §3): Square is 0..63 with a1 = 0, h1 = 7, a8 = 56,
 * h8 = 63. So `square = rankIndex * 8 + fileIndex`, both indices 0-based and
 * counted from a1.
 */

import type { Color, Piece, Square } from './types.js'

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const

/** 0 = a-file … 7 = h-file. */
export function fileOf(sq: Square): number {
  return sq & 7
}

/** 0 = rank 1 … 7 = rank 8. */
export function rankOf(sq: Square): number {
  return sq >> 3
}

export function makeSquare(file: number, rank: number): Square {
  return rank * 8 + file
}

export function onBoard(sq: number): boolean {
  return Number.isInteger(sq) && sq >= 0 && sq < 64
}

/** True when (file, rank) are both within 0..7. */
export function inBounds(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8
}

export function squareName(sq: Square): string {
  return FILES[fileOf(sq)] + RANKS[rankOf(sq)]
}

/** Parse "e4" → 28. Returns null on anything else. */
export function parseSquare(name: string): Square | null {
  if (name.length !== 2) return null
  const file = FILES.indexOf(name[0]!.toLowerCase() as (typeof FILES)[number])
  const rank = RANKS.indexOf(name[1]! as (typeof RANKS)[number])
  if (file < 0 || rank < 0) return null
  return makeSquare(file, rank)
}

/** Direction of pawn travel: +1 rank for white, −1 for black. */
export function forwardDir(color: Color): number {
  return color === 'white' ? 1 : -1
}

/** The rank index a pawn of this colour starts on (white 1 = rank 2). */
export function pawnHomeRank(color: Color): number {
  return color === 'white' ? 1 : 6
}

/** The rank index that triggers promotion (gamebook §6, "第 8 排"). */
export function promotionRank(color: Color): number {
  return color === 'white' ? 7 : 0
}

/** The rank index a pawn lands on after a legal double step. */
export function pawnDoubleStepRank(color: Color): number {
  return color === 'white' ? 3 : 4
}

export function opposite(color: Color): Color {
  return color === 'white' ? 'black' : 'white'
}

// ---------------------------------------------------------------------------
// Occupancy views over a piece list
// ---------------------------------------------------------------------------

/** Sparse square → piece index map for a piece list. */
export type Occupancy = (Piece | undefined)[]

export function buildOccupancy(pieces: readonly Piece[]): Occupancy {
  const occ: Occupancy = new Array<Piece | undefined>(64)
  for (const p of pieces) {
    if (p.square !== null) occ[p.square] = p
  }
  return occ
}

export function pieceAt(pieces: readonly Piece[], sq: Square): Piece | undefined {
  for (const p of pieces) {
    if (p.square === sq) return p
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Castling geometry (gamebook §3②)
// ---------------------------------------------------------------------------

export interface CastlePlan {
  kingFrom: Square
  kingTo: Square
  rookFrom: Square
  rookTo: Square
  /** squares that must be empty between king and rook */
  between: Square[]
}

const CASTLE_PLANS: Record<Color, Record<'king' | 'queen', CastlePlan>> = {
  white: {
    king: { kingFrom: 4, kingTo: 6, rookFrom: 7, rookTo: 5, between: [5, 6] },
    queen: { kingFrom: 4, kingTo: 2, rookFrom: 0, rookTo: 3, between: [1, 2, 3] },
  },
  black: {
    king: { kingFrom: 60, kingTo: 62, rookFrom: 63, rookTo: 61, between: [61, 62] },
    queen: { kingFrom: 60, kingTo: 58, rookFrom: 56, rookTo: 59, between: [57, 58, 59] },
  },
}

export function castlePlan(color: Color, side: 'king' | 'queen'): CastlePlan {
  return CASTLE_PLANS[color][side]
}
