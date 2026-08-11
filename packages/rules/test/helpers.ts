/**
 * Test-only fixtures. Nothing here encodes a rule — every expectation lives in
 * the test files, quoting gamebook_v02.md.
 *
 * The engine ships no arbitrary-position builder (createGame only produces the
 * §9 opening), so `position()` hand-assembles a GameState. It is deliberately
 * dumb: it stores exactly what it is given.
 */

import { DEFAULT_CONFIG } from '../src/constants.js'
import { parseSquare, squareName } from '../src/board.js'
import { stateForViewer } from '../src/redact.js'
import type {
  Carrier,
  Color,
  GameConfig,
  GameEvent,
  GameState,
  GameStatus,
  Move,
  Piece,
  PieceId,
  Rank,
  Square,
  ViewerPiece,
} from '../src/types.js'

/** 'e4' → 28. Throws on a typo so a bad fixture fails loudly. */
export function sq(name: string): Square {
  const v = parseSquare(name)
  if (v === null) throw new Error(`test fixture: bad square name ${name}`)
  return v
}

export const name = squareName

export interface PieceSpec {
  /** algebraic square, or null for an already-removed piece */
  at: string | null
  color: Color
  carrier: Carrier
  rank: Rank
  id?: PieceId
  revealed?: boolean
  hasMoved?: boolean
}

export interface PositionOptions {
  id?: string
  toMove?: Color
  ply?: number
  score?: { white: number; black: number }
  log?: GameEvent[]
  clockMs?: { white: number; black: number }
  noProgressTurns?: number
  status?: GameStatus
  config?: Partial<GameConfig>
}

/** Hand-assemble a playable GameState from a piece list. */
export function position(specs: PieceSpec[], opts: PositionOptions = {}): GameState {
  const config: GameConfig = { ...DEFAULT_CONFIG, ...opts.config }
  const pieces: Piece[] = specs.map((spec, i) => ({
    id: spec.id ?? `${spec.color[0]}${i}-${spec.at ?? 'off'}`,
    color: spec.color,
    carrier: spec.carrier,
    rank: spec.rank,
    square: spec.at === null ? null : sq(spec.at),
    revealed: spec.revealed ?? false,
    hasMoved: spec.hasMoved ?? false,
  }))

  const ids = new Set<string>()
  for (const p of pieces) {
    if (ids.has(p.id)) throw new Error(`test fixture: duplicate piece id ${p.id}`)
    ids.add(p.id)
  }

  return {
    id: opts.id ?? 'test',
    pieces,
    toMove: opts.toMove ?? 'white',
    ply: opts.ply ?? 1,
    score: opts.score ? { ...opts.score } : { white: 0, black: config.komi },
    log: opts.log ? [...opts.log] : [],
    clockMs: opts.clockMs
      ? { ...opts.clockMs }
      : { white: config.clockInitialMs, black: config.clockInitialMs },
    noProgressTurns: opts.noProgressTurns ?? 0,
    status: opts.status ?? { kind: 'playing' },
    config,
  }
}

export function pieceById(s: GameState, id: PieceId): Piece {
  const p = s.pieces.find((x) => x.id === id)
  if (!p) throw new Error(`test fixture: no piece with id ${id}`)
  return p
}

/** The piece standing on `at`, or undefined when the square is empty. */
export function at(s: GameState, atName: string): Piece | undefined {
  const target = sq(atName)
  return s.pieces.find((p) => p.square === target)
}

export function isEmpty(s: GameState, atName: string): boolean {
  return at(s, atName) === undefined
}

export function lastEvent(s: GameState): GameEvent {
  const e = s.log[s.log.length - 1]
  if (!e) throw new Error('test fixture: log is empty')
  return e
}

/** Convenience for the common `{ kind: 'move' }` shape. */
export function mv(from: string, to: string, promote?: 'queen' | 'rook' | 'bishop' | 'knight'): Move {
  return promote
    ? { kind: 'move', from: sq(from), to: sq(to), promote }
    : { kind: 'move', from: sq(from), to: sq(to) }
}

export const PASS: Move = { kind: 'pass' }

/**
 * What a live player at the board can actually read off `id`'s 兵種.
 * Goes through the real redaction boundary — this is the observable form of
 * 翻明, as opposed to the internal `revealed` flag.
 */
export function rankSeenBy(s: GameState, viewer: Color, id: PieceId): Rank | null {
  const vs = stateForViewer(s, { kind: 'player', color: viewer })
  const vp: ViewerPiece | undefined = vs.pieces.find((p) => p.id === id)
  if (!vp) throw new Error(`test fixture: viewer state has no piece ${id}`)
  return vp.rank
}

/** Deep structural snapshot, for purity assertions. */
export function snapshot<T>(v: T): T {
  return structuredClone(v)
}
