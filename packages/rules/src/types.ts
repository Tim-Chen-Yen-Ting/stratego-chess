/**
 * 行軍西洋棋 — shared types.
 *
 * Normative: techspec_v01.md §3. These declarations are copied verbatim from
 * the spec; every other package compiles against them. Do not "improve" them.
 */

export type Color = 'white' | 'black'

export type Carrier = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king'

/** 兵種. 'bomb' (爆裂物) has no fixed rank — it ties with everything. */
export type Rank =
  | 'commander'   // 司令   1
  | 'general'     // 軍長   2
  | 'division'    // 師長   3
  | 'brigade'     // 旅長   4
  | 'regiment'    // 團長   5
  | 'battalion'   // 營長   6
  | 'company'     // 連長   7
  | 'platoon'     // 排長   8
  | 'engineer'    // 工兵   9
  | 'flag'        // 軍旗  10
  | 'bomb'        // 爆裂物 —

/** 0..63, a1 = 0, h1 = 7, a8 = 56, h8 = 63. */
export type Square = number

export type PieceId = string

export interface Piece {
  id: PieceId
  color: Color
  carrier: Carrier
  rank: Rank
  /** null once removed from the board. */
  square: Square | null
  /** true once the rank is permanently public (§4.3). */
  revealed: boolean
  /** for castling rights. Set on any completed move by this piece. */
  hasMoved: boolean
}

export type Move =
  | { kind: 'move'; from: Square; to: Square; promote?: Exclude<Carrier, 'pawn' | 'king'> }
  | { kind: 'castle'; side: 'king' | 'queen' }
  | { kind: 'pass' }

export type CombatOutcome =
  | { kind: 'attacker-wins'; winnerRank: Rank }
  | { kind: 'defender-wins'; winnerRank: Rank }
  | { kind: 'mutual-rank'; rank: Rank }
  | { kind: 'bomb-detonate'; bombColor: Color }
  | { kind: 'bomb-vs-bomb' }
  /** 有煙無傷 — reveals nothing. Survivor is 工兵 or 軍旗. */
  | { kind: 'fizzle'; survivorColor: Color }

/** One public log entry. Everything here is visible to every viewer. */
export interface GameEvent {
  ply: number
  color: Color
  move: Move
  /** present only if the move made contact */
  combat?: {
    outcome: CombatOutcome
    attackerSquare: Square
    defenderSquare: Square
    /** where the survivor ended up, null if none survived */
    survivorSquare: Square | null
  }
  promoted?: Carrier
  scoreAfter: { white: number; black: number }
}

export interface GameConfig {
  scoreTarget: number        // X, default 40
  noProgressTurns: number    // N, default 30
  komi: number               // default 0.5, credited to black
  clockInitialMs: number     // default 900_000
  clockIncrementMs: number   // default 10_000
  setupTimeoutMs: number     // default 180_000
  /** when false the clock is disabled entirely (LLM games) */
  clockEnabled: boolean
}

export type Result =
  | { kind: 'flag'; winner: Color }
  | { kind: 'flag-both' }               // the only draw in the game
  | { kind: 'score'; winner: Color }
  | { kind: 'no-progress'; winner: Color }
  | { kind: 'timeout'; winner: Color }
  | { kind: 'resign'; winner: Color }

export type GameStatus =
  | { kind: 'setup'; submitted: Record<Color, boolean> }
  | { kind: 'playing' }
  | { kind: 'over'; result: Result }

export interface GameState {
  id: string
  pieces: Piece[]
  toMove: Color
  ply: number
  score: { white: number; black: number }
  log: GameEvent[]
  clockMs: { white: number; black: number }
  /** consecutive FULL TURNS with no capture and no point scored (§7③) */
  noProgressTurns: number
  status: GameStatus
  config: GameConfig
}

// ---------- Viewer / redaction ----------

export type Viewer =
  | { kind: 'player'; color: Color }
  | { kind: 'spectator'; bound: Color }
  | { kind: 'replay-omniscient' }
  | { kind: 'replay-player'; color: Color }

export interface ViewerPiece {
  id: PieceId
  color: Color
  carrier: Carrier
  square: Square | null
  revealed: boolean
  /** null when this viewer is not entitled to the rank */
  rank: Rank | null
}

export interface ViewerState {
  id: string
  pieces: ViewerPiece[]
  toMove: Color
  ply: number
  score: { white: number; black: number }
  log: GameEvent[]
  clockMs: { white: number; black: number }
  noProgressTurns: number
  status: GameStatus
  config: GameConfig
  viewer: Viewer
  /** legal moves, present only for a player whose turn it is */
  legalMoves?: Move[]
  /**
   * Absolute epoch-ms deadline for the setup phase, present only during setup.
   *
   * Not derived from GameState — the rules engine holds no wall clock, and must
   * not, or `applyMove` stops being deterministic. The transport layer fills this
   * in from its own timer. Without it a client can only anchor the countdown at
   * the moment it first rendered, so anyone joining an invite late sees a full
   * timer while the server auto-assigns early.
   */
  setupDeadlineMs?: number
}
