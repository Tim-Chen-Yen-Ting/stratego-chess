/**
 * 起始配置 — gamebook §9.
 *
 * The carrier layer is the standard chess opening position. Before play, both
 * sides assign the 16 兵種 of §2 to their 16 carriers, simultaneously and
 * invisibly to each other; the assignment must be a bijection that uses up
 * DISTRIBUTION exactly.
 */

import { parseSquare, squareName } from './board.js'
import {
  ALL_RANKS,
  DEFAULT_ASSIGNMENT_BY_HOME_SQUARE,
  DEFAULT_CONFIG,
  DISTRIBUTION,
} from './constants.js'
import type {
  Carrier,
  Color,
  GameConfig,
  GameState,
  Piece,
  PieceId,
  Rank,
  Square,
} from './types.js'

const BACK_RANK_CARRIERS: Carrier[] = [
  'rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook',
]

export interface StartingSlot {
  id: PieceId
  color: Color
  carrier: Carrier
  square: Square
  /**
   * The slot's square as seen from its OWN side, i.e. black's a8 is 'a1' and
   * black's a7 is 'a2'. Keys DEFAULT_ASSIGNMENT_BY_HOME_SQUARE so both colours
   * receive the mirror image of the same default.
   */
  homeKey: string
}

function buildStartingLayout(): StartingSlot[] {
  const slots: StartingSlot[] = []
  for (const color of ['white', 'black'] as const) {
    const backRank = color === 'white' ? 0 : 7
    const pawnRank = color === 'white' ? 1 : 6
    for (let file = 0; file < 8; file++) {
      const sq = backRank * 8 + file
      slots.push({
        id: `${color[0]}-${squareName(sq)}`,
        color,
        carrier: BACK_RANK_CARRIERS[file]!,
        square: sq,
        homeKey: squareName(file),
      })
    }
    for (let file = 0; file < 8; file++) {
      const sq = pawnRank * 8 + file
      slots.push({
        id: `${color[0]}-${squareName(sq)}`,
        color,
        carrier: 'pawn',
        square: sq,
        homeKey: squareName(8 + file),
      })
    }
  }
  return slots
}

/** The fixed opening position. Also used by the text renderer to replay the log. */
export const STARTING_LAYOUT: readonly StartingSlot[] = buildStartingLayout()

const SLOT_BY_ID = new Map<PieceId, StartingSlot>(STARTING_LAYOUT.map((s) => [s.id, s]))

/** The starting slot for a piece id, or undefined for an unknown id. */
export function startingSlot(id: PieceId): StartingSlot | undefined {
  return SLOT_BY_ID.get(id)
}

export function createGame(id: string, config?: Partial<GameConfig>): GameState {
  const cfg: GameConfig = { ...DEFAULT_CONFIG, ...config }

  // Ranks are non-nullable in the normative Piece type, so every piece starts
  // carrying its default-assignment rank. Those values are placeholders until
  // the owner submits — status.submitted is what says whether a side has
  // actually chosen — and on setup timeout the caller simply submits
  // defaultAssignment(), which writes the very same values back.
  const pieces: Piece[] = STARTING_LAYOUT.map((slot) => ({
    id: slot.id,
    color: slot.color,
    carrier: slot.carrier,
    rank: DEFAULT_ASSIGNMENT_BY_HOME_SQUARE[slot.homeKey]!,
    square: slot.square,
    revealed: false,
    hasMoved: false,
  }))

  return {
    id,
    pieces,
    toMove: 'white',
    ply: 1,
    // 貼目 (§7): black is credited komi before a single move is played, which
    // is what makes every score-decided result have a winner.
    score: { white: 0, black: cfg.komi },
    log: [],
    clockMs: { white: cfg.clockInitialMs, black: cfg.clockInitialMs },
    noProgressTurns: 0,
    status: { kind: 'setup', submitted: { white: false, black: false } },
    config: cfg,
  }
}

/** Validate a rank assignment: bijection onto DISTRIBUTION over that colour's 16 pieces. */
export function validateAssignment(
  a: Record<PieceId, Rank>,
  color: Color,
  s: GameState,
): string | null {
  const own = s.pieces.filter((p) => p.color === color)
  const ownIds = new Set(own.map((p) => p.id))

  for (const key of Object.keys(a)) {
    if (!ownIds.has(key)) return `unknown piece id for ${color}: ${key}`
  }
  for (const piece of own) {
    if (!(piece.id in a)) return `missing assignment for piece ${piece.id}`
  }

  const counts = new Map<Rank, number>()
  for (const id of ownIds) {
    const rank = a[id]!
    if (!ALL_RANKS.includes(rank)) return `unknown rank for piece ${id}: ${String(rank)}`
    counts.set(rank, (counts.get(rank) ?? 0) + 1)
  }

  for (const rank of ALL_RANKS) {
    const want = DISTRIBUTION[rank]
    const got = counts.get(rank) ?? 0
    if (got !== want) return `rank ${rank}: expected ${want}, got ${got}`
  }

  return null
}

/** Universal fallback used on setup timeout (§0). Deterministic. */
export function defaultAssignment(color: Color, s: GameState): Record<PieceId, Rank> {
  const out: Record<PieceId, Rank> = {}
  for (const piece of s.pieces) {
    if (piece.color !== color) continue
    const slot = SLOT_BY_ID.get(piece.id)
    if (!slot) throw new Error(`piece ${piece.id} has no starting slot; cannot build a default assignment`)
    out[piece.id] = DEFAULT_ASSIGNMENT_BY_HOME_SQUARE[slot.homeKey]!
  }
  return out
}

export function submitAssignment(
  s: GameState,
  color: Color,
  a: Record<PieceId, Rank>,
): GameState {
  if (s.status.kind !== 'setup') throw new Error('assignments are only accepted during setup')
  if (s.status.submitted[color]) throw new Error(`${color} has already submitted an assignment`)

  const problem = validateAssignment(a, color, s)
  if (problem) throw new Error(`invalid assignment: ${problem}`)

  const submitted = { ...s.status.submitted, [color]: true } as Record<Color, boolean>
  const bothIn = submitted.white && submitted.black

  return {
    ...s,
    pieces: s.pieces.map((p) => (p.color === color ? { ...p, rank: a[p.id]! } : { ...p })),
    log: [...s.log],
    score: { ...s.score },
    clockMs: { ...s.clockMs },
    status: bothIn ? { kind: 'playing' } : { kind: 'setup', submitted },
    config: { ...s.config },
  }
}

/** Square of a starting slot by its own-perspective home key ('a1'…'h2'). */
export function homeKeySquare(color: Color, homeKey: string): Square | null {
  const sq = parseSquare(homeKey)
  if (sq === null) return null
  if (color === 'white') return sq
  // mirror rank 1↔8, 2↔7 …
  const file = sq & 7
  const rank = sq >> 3
  return (7 - rank) * 8 + file
}
