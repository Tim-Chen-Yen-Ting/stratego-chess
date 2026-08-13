/**
 * 起始配置 — gamebook §9.
 *
 * The carrier layer is the standard chess opening position. Before play, both
 * sides assign the 16 兵種 of §2 to their 16 carriers, simultaneously and
 * invisibly to each other; the assignment must be a bijection that uses up the
 * game's own 數量配置 (`config.distribution`, 附錄 B) exactly.
 */

import { parseSquare, squareName } from './board.js'
import {
  ALL_RANKS,
  DEFAULT_ASSIGNMENT_BY_HOME_SQUARE,
  DEFAULT_CONFIG,
  checkDistribution,
} from './constants.js'
import type {
  Carrier,
  Color,
  GameConfig,
  GameState,
  Piece,
  PieceId,
  Rank,
  RankDistribution,
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

/**
 * The deterministic fallback deployment for a given 數量配置, by home key.
 *
 * The hand-made §2 table in `DEFAULT_ASSIGNMENT_BY_HOME_SQUARE` is the seed and
 * is reproduced EXACTLY when the distribution is the standard one, so a default
 * game's placeholders and its timeout deployment are the same bytes they always
 * were. For any other table the seed is walked in home-key order, each slot
 * keeping its rank while that rank still has budget left; the slots that lose
 * their rank are then filled from what remains, walking the 階級 ladder in
 * order. Both halves are order-deterministic, so the result depends on the
 * distribution alone — never on iteration luck.
 *
 * §9 requires a TIMED-OUT side to be deployed at random, not from a fixed table
 * (a fixed one is equivalent to publishing that army). This function is not
 * that: it is the deterministic fallback the engine needs to hold a placeholder
 * before anyone has deployed. Rolling a random legal deployment is the caller's
 * job.
 */
export function defaultRankByHomeKey(distribution: RankDistribution): Record<string, Rank> {
  const problem = checkDistribution(distribution)
  if (problem !== null) {
    throw new Error(`cannot build a default assignment: 兵種 distribution ${problem}`)
  }

  const remaining = new Map<Rank, number>(ALL_RANKS.map((r) => [r, distribution[r]]))
  const out: Record<string, Rank> = {}
  const spare: string[] = []

  for (const homeKey of Object.keys(DEFAULT_ASSIGNMENT_BY_HOME_SQUARE)) {
    const seeded = DEFAULT_ASSIGNMENT_BY_HOME_SQUARE[homeKey]!
    const left = remaining.get(seeded) ?? 0
    if (left > 0) {
      out[homeKey] = seeded
      remaining.set(seeded, left - 1)
    } else {
      spare.push(homeKey)
    }
  }

  const pool: Rank[] = []
  for (const rank of ALL_RANKS) {
    for (let n = remaining.get(rank) ?? 0; n > 0; n--) pool.push(rank)
  }
  // Both sides of this are 16 by construction: the seed has one entry per piece
  // and `checkDistribution` has already proved the table sums to 16.
  if (pool.length !== spare.length) {
    throw new Error(
      `cannot build a default assignment: ${spare.length} slot(s) to fill but ${pool.length} 兵種 left over`,
    )
  }
  spare.forEach((homeKey, i) => { out[homeKey] = pool[i]! })

  return out
}

export function createGame(id: string, config?: Partial<GameConfig>): GameState {
  const cfg: GameConfig = { ...DEFAULT_CONFIG, ...config }

  // 附錄 B says the 兵種 counts are a setting; §2 says they total 16. Both hold
  // here or the game does not start: a table summing to anything else makes the
  // setup code a format no player can satisfy, and the failure would surface as
  // "your deployment is wrong" on every attempt rather than as the config error
  // it is.
  const problem = checkDistribution(cfg.distribution)
  if (problem !== null) throw new Error(`createGame: 兵種 distribution ${problem}`)
  // Frozen copy: a caller that keeps a reference to the table it passed in must
  // not be able to retune a running game by mutating it.
  cfg.distribution = Object.freeze({ ...cfg.distribution })

  // Ranks are non-nullable in the normative Piece type, so every piece starts
  // carrying its default-assignment rank. Those values are placeholders until
  // the owner submits — status.submitted is what says whether a side has
  // actually chosen — and on setup timeout the caller simply submits
  // defaultAssignment(), which writes the very same values back. They come from
  // THIS game's distribution, so even a placeholder army is a legal one.
  const placeholder = defaultRankByHomeKey(cfg.distribution)
  const pieces: Piece[] = STARTING_LAYOUT.map((slot) => ({
    id: slot.id,
    color: slot.color,
    carrier: slot.carrier,
    rank: placeholder[slot.homeKey]!,
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

/**
 * Validate a rank assignment: a bijection onto THIS GAME's 數量配置 over that
 * colour's 16 pieces (§9 「必須恰好用完 §2 的數量表」).
 *
 * The multiset comes from `s.config.distribution`, never from the module
 * constant — 兵種數量配置 is a 附錄 B tunable, and a validator that checked the
 * default table would reject every legal deployment in a retuned game while
 * accepting illegal ones.
 */
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
    const want = s.config.distribution[rank]
    const got = counts.get(rank) ?? 0
    if (got !== want) return `rank ${rank}: expected ${want}, got ${got}`
  }

  return null
}

/**
 * Universal fallback used on setup timeout (§0). Deterministic, and always a
 * bijection onto `s.config.distribution` — a retuned game gets a fallback that
 * its own `validateAssignment` accepts.
 */
export function defaultAssignment(color: Color, s: GameState): Record<PieceId, Rank> {
  const byHomeKey = defaultRankByHomeKey(s.config.distribution)
  const out: Record<PieceId, Rank> = {}
  for (const piece of s.pieces) {
    if (piece.color !== color) continue
    const slot = SLOT_BY_ID.get(piece.id)
    if (!slot) throw new Error(`piece ${piece.id} has no starting slot; cannot build a default assignment`)
    out[piece.id] = byHomeKey[slot.homeKey]!
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
