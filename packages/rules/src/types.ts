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

/**
 * 兵種 counts per side — the §2 數量表, i.e. `Readonly<Record<Rank, number>>`.
 *
 * Exactly the type of `GameConfig.distribution`, named so the functions that
 * take one can say what it is. It ALWAYS sums to 16 (§2 合計): that is not a
 * convention but an invariant `checkDistribution` enforces, because the setup
 * code is one character per piece and every deployment is a bijection onto this
 * table (§9).
 */
export type RankDistribution = Readonly<Record<Rank, number>>

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
  /**
   * 同歸於盡 — both pieces removed, and this is the WHOLE announcement.
   *
   * One variant covers all three ways a contact can take both pieces: an equal
   * 階級 trade, a 爆裂物 against an ordinary 兵種, and 爆裂物 against 爆裂物. The
   * engine still tells them apart — it must, a 爆裂物 is spent and a 軍旗 leaving
   * the board still loses on the spot — but the event carries no field that
   * separates them, on purpose:
   *
   *   • naming the tied 階級 handed BOTH players an exact rank for free;
   *   • announcing a detonation made 爆裂物 publicly countable, and an opponent
   *     who has counted both of yours knows a revealed 司令 is unkillable.
   *
   * With the three indistinguishable, a player who trades into you cannot tell
   * whether they met their own rank or a bomb, and cannot run your bomb count
   * down to zero. `fizzle` stays separate because a piece SURVIVES there — that
   * is observable on the board whatever the announcement says, so it remains the
   * one event that identifies a 爆裂物: a bomb that works stays secret, a bomb
   * that fizzles announces itself.
   *
   * There is deliberately NO discriminator for a redaction layer to strip. Every
   * `GameEvent` is public by construction (techspec §3) and stays that way; the
   * distinction does not exist in the event at all. 爆裂物 spent is therefore not
   * derivable from the log during play. At 終局 §10.5 opens every 兵種, so the
   * true count becomes derivable from the piece list instead — bomb-ranked
   * pieces with `square === null`.
   */
  | { kind: 'mutual-destruction' }
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
  /**
   * Running total after this ply, carrying BOTH of §7.1's score sources — the
   * ① 吃子 payment (§7.3) and the ② 佔領計分格 settlement (§7.2).
   *
   * There is deliberately no second field splitting the two. The capture half is
   * already a pure function of `combat.outcome`, `color` and the config (附錄
   * A(d): the payment reads only 兵種 the same event forced 翻明), so a viewer
   * can recover it without being told — and every field that could carry it
   * separately would be one more place for a rank to leak.
   */
  scoreAfter: { white: number; black: number }
}

export interface GameConfig {
  /**
   * X — 先達 X 分者獲勝 (§7.5②). Default 40, which is 附錄 B's number for the
   * DEFAULT 中央四格 board; X varies with the 結算格 setting and 附錄 B lists
   * 側翼八格 as 待定.
   *
   * A settlement credits only the side that just moved (§7.1), so one piece
   * holding one scoring square earns 1 point per FULL TURN no matter how many
   * squares the board has — but a settlement pays for every square that side
   * holds, about two on 中央四格 and about four on 側翼八格, and X counts POINTS
   * rather than settlements. Widening the board therefore roughly doubles the
   * income per settlement and roughly halves the game: at the same X = 40,
   * n=300 `contest` vs `contest` runs 35.5 手 on 中央四格 and 22.0 手 on 側翼八格
   * (notebook §9.3; §10.2 states the mechanism, measured on the current
   * ruleset). A wide-8 game wanting the centre board's length needs its own X,
   * near 80 — 待定 until a sweep fixes it.
   */
  scoreTarget: number
  noProgressTurns: number    // N, default 30
  /**
   * 貼目 (§7.4), credited to black at ply 0. Default 0.5.
   *
   * Its one job is making an exact tie impossible, so every score-decided ending
   * has a winner. It is NOT compensation for a first-move scoring edge: under
   * mover-only settlement each side banks once per turn, before the opponent can
   * reply, so neither the number of settlements nor the exposure between them
   * favours white.
   */
  komi: number
  /**
   * k — 吃子得分係數 (§7.3), paid in ① 行動階段. Default 0.
   *
   * A 決定性勝負 pays `k × the WINNER's 階級 number` to the WINNER's side. The
   * 階級 numbers run 司令 1 … 軍旗 10, so a LARGER number is a WEAKER piece and a
   * weak winner is therefore paid MORE — that direction is the rule, stated in
   * §7.3 as 「階級數字越大代表越弱，故弱者獲勝得分越高」, not an inversion to
   * correct.
   *
   * It reads the winner's 階級 and nothing else, which §4.3 forced 翻明 in the
   * same event: 附錄 A(d) permits exactly that and forbids reading the loser's.
   *
   * 附錄 B lists k as 待定 — no sweep has fixed it yet — so the shipped default
   * is 0, i.e. 吃子 pays nothing and 佔領計分格 is the only live source.
   */
  captureScoreK: number
  /**
   * 有煙無傷獎勵 (§7.3, §5.4), paid in ① to 存活方. Default 0.
   *
   * A FLAT amount, never a function of any 兵種. The survivor of a fizzle is 工兵
   * or 軍旗 and the event says only which COLOUR lived; a bonus that differed
   * between the two would name the piece and undo 附錄 A(a). 同歸於盡 has no knob
   * at all — 附錄 B fixes it at 0 — which is what keeps 爆裂物 uncountable from
   * the score column.
   *
   * 附錄 B lists it as 待定, so the shipped default is 0.
   */
  fizzleBonus: number
  /**
   * ② 結算階段 scoring squares (§7.2). Default `SCORING_CENTRE_4` — d4/e4/d5/e5,
   * the gamebook's 中央四格. `SCORING_WIDE_8` adds the a/h flanks.
   *
   * 附錄 B: the board shape is a tunable, so settlement reads THIS list and
   * never a module constant. A game therefore keeps scoring the shape it was
   * created with, whatever a later preset says.
   */
  scoringSquares: readonly Square[]
  /**
   * 兵種 counts per side (§2 數量表). Default `DISTRIBUTION_STANDARD` — the
   * gamebook table, 司令1 … 工兵2 軍旗1 爆裂物2.
   *
   * 附錄 B lists 兵種數量配置 as a tunable, so everything that counts, validates,
   * renders or explains a deployment reads THIS table and never the module
   * constant. A game therefore keeps the army it was created with, whatever a
   * later preset says, and two games with different tables can run side by side.
   *
   * It always sums to 16 (§2 合計) — `createGame` refuses a config where it does
   * not. Changing it changes what `validateAssignment` accepts, so it cannot be
   * altered mid-game without invalidating both sides' deployments.
   */
  distribution: Readonly<Record<Rank, number>>
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
  /** consecutive FULL TURNS with no capture and no point scored (§7.5③) */
  noProgressTurns: number
  status: GameStatus
  config: GameConfig
}

// ---------- Viewer / redaction ----------

/**
 * Who is asking. Everything the redaction layer decides, it decides from this.
 *
 * `spectator-public` is the STRICTEST viewer in the system — strictly less than
 * a player, strictly less than a bound 現場觀戰者. §10.1 lists three viewer
 * types, and all three are attached to somebody's army: a 現場觀戰者 is bound to
 * one player and sees "與其進入時所綁定玩家的視角完全相同", so its link cannot be
 * handed to a third party mid-game without handing over that player's whole
 * deployment. This viewer closes that gap. It owns no colour and holds no seat,
 * and sees only what BOTH players already commonly know: 翻明 ranks (§4.3),
 * the public 事件紀錄 (§10.3), and — once the game is over — everything, because
 * §10.5 opens every 兵種 at 終局.
 */
export type Viewer =
  | { kind: 'player'; color: Color }
  | { kind: 'spectator'; bound: Color }
  | { kind: 'spectator-public' }
  | { kind: 'omniscient' }
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
