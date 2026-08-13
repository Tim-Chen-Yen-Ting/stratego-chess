# 行軍西洋棋 — Technical Specification v01

Implementation contract for `gamebook_v03.md`. Where this document and the gamebook disagree about **rules**, the gamebook wins. This document is authoritative for **structure, types and APIs**.

Document set:
| File | Role |
|---|---|
| `gamebook_v03.md` | **The rules.** What is legal. Normative. |
| `notebook_v01.md` | Derivations, emergent interactions, playtest data. Never normative. |
| `techspec_v01.md` | This file — structure, types, APIs. |
| `gamebook.md`, `gamebook_v02.md`, `plan_v01.md` | Superseded. Kept for history. |

---

## 0. Product scope (v1)

| Decision | Value |
|---|---|
| Accounts | None. Guest play only. |
| Persistence | None. Games live in memory. No database. |
| Matchmaking | None. Invite links only. |
| Setup timeout | Auto-assign a RANDOM valid army, then continue. Must not be a fixed default — a deterministic fallback publishes that player's whole army |
| Disconnect | Clock keeps running. No grace period. |
| Spectating | Via a player's share link, bound to that player's view |
| LLM play | GET-only HTTP interface, see §6 |

A server restart loses all in-progress games. Accepted for v1.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.x, `strict: true`, ES2022 modules |
| Runtime | Node 24 |
| Monorepo | npm workspaces |
| Server | Fastify 5 + Socket.IO 4 |
| Client | React 19 + Vite 6 |
| Client state | Zustand |
| Rules engine | Pure TypeScript, **zero runtime dependencies** |
| Test | Vitest |
| Hosting | Render, single Web Service (see §8) |

**Do not use `chess.js` or any chess library.** This variant removes check, checkmate, stalemate and insufficient-material, makes the king an ordinary capturable piece, makes castling unconditional, and makes captures losable by the attacker. Move generation is written from scratch — roughly 400 lines.

---

## 2. Repository layout

```
行軍西洋棋/
  package.json                  workspaces root
  tsconfig.base.json
  packages/
    rules/                      pure TS, zero deps — the authority
      package.json
      src/
        types.ts                all shared types (§3)
        constants.ts            RANK_ORDER, DISTRIBUTION, CENTER_SQUARES, defaults
        board.ts                square encoding, coordinate helpers
        moves.ts                move generation
        combat.ts               capture resolution
        game.ts                 state machine: apply, settle, victory, clock
        setup.ts                assignment validation, default assignment
        redact.ts               stateForViewer — THE security boundary
        render/text.ts          LLM text rendering
        index.ts                public surface, re-exports only
      test/
    server/                     Fastify + Socket.IO + LLM HTTP
      src/
        index.ts                bootstrap, static serving
        rooms.ts                in-memory game registry
        sockets.ts              Socket.IO handlers
        llm.ts                  GET-only LLM routes (§6)
        clock.ts                server-side timers
    web/                        React + Vite
      src/
        main.tsx
        App.tsx                 routing
        screens/Create.tsx
        screens/Setup.tsx
        screens/Game.tsx
        components/Board.tsx
        components/PieceTray.tsx
        components/EventLog.tsx
        store.ts                Zustand
        socket.ts               client transport
```

### File ownership during the build

Agents build in parallel and **must not write outside their assigned directory**:

| Owner | Directory |
|---|---|
| Rules agent | `packages/rules/**` except `test/` |
| Server agent | `packages/server/**` |
| Web agent | `packages/web/**` |
| Test agent | `packages/rules/test/**` |
| Integration agent | root config files, and fixes anywhere |

---

## 3. Shared types (`packages/rules/src/types.ts`)

This section is normative. Implement these exactly; every other package imports them.

```ts
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
  scoreTarget: number        // X, default 40 (80 under the wide-8 preset)
  noProgressTurns: number    // N, default 30
  komi: number               // default 0.5, credited to black
  /** §7 settlement squares. Default SCORING_CENTRE_4; SCORING_WIDE_8 adds a/h flanks.
   *  Settlement reads THIS, never a module constant, so a game keeps the shape
   *  it was created with. */
  scoringSquares: readonly Square[]
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
  /** bound to one player — sees exactly that player's view */
  | { kind: 'spectator'; bound: Color }
  /** the strictest viewer: 翻明 ranks and announced events only, no seat */
  | { kind: 'spectator-public' }
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
  /** absolute epoch-ms setup deadline, present only during setup. NOT derived
   *  from GameState — the engine holds no wall clock. rooms.ts fills it in. */
  setupDeadlineMs?: number
}
```

### Constants (`constants.ts`)

```ts
/** Lower number beats higher number. 'bomb' is absent — it has no rank. */
export const RANK_ORDER: Record<Exclude<Rank, 'bomb'>, number> = {
  commander: 1, general: 2, division: 3, brigade: 4, regiment: 5,
  battalion: 6, company: 7, platoon: 8, engineer: 9, flag: 10,
}

export const DISTRIBUTION: Record<Rank, number> = {
  commander: 1, general: 1, division: 1, brigade: 2, regiment: 2,
  battalion: 2, company: 1, platoon: 1, engineer: 2, flag: 1, bomb: 2,
}  // sums to 16

/** Built from square NAMES, never literals — an off-by-one here is invisible
 *  and would corrupt every score. CENTER_SQUARES is an alias of the centre-4. */
export const SCORING_CENTRE_4: readonly Square[]   // d4 e4 d5 e5 = 27 28 35 36
export const SCORING_WIDE_8: readonly Square[]     // + a4 h4 a5 h5 = 24 31 32 39
export const CENTER_SQUARES: readonly Square[]     // = SCORING_CENTRE_4

export const DEFAULT_CONFIG: GameConfig = {
  scoreTarget: 40, noProgressTurns: 30, komi: 0.5,
  clockInitialMs: 900_000, clockIncrementMs: 10_000,
  setupTimeoutMs: 180_000, clockEnabled: true,
}
```

---

## 4. Rules engine public surface (`packages/rules/src/index.ts`)

```ts
export function createGame(id: string, config?: Partial<GameConfig>): GameState

/** Validate a rank assignment: bijection onto DISTRIBUTION over that colour's 16 pieces. */
export function validateAssignment(a: Record<PieceId, Rank>, color: Color, s: GameState): string | null

/** Universal fallback used on setup timeout (§0). Deterministic. */
export function defaultAssignment(color: Color, s: GameState): Record<PieceId, Rank>

export function submitAssignment(s: GameState, color: Color, a: Record<PieceId, Rank>): GameState

/** All legal moves for `color`. Always includes { kind: 'pass' } (§3④). */
export function legalMoves(s: GameState, color: Color): Move[]

/** Pure. Runs the ACTION sub-step then the SETTLEMENT sub-step. Throws on illegal input. */
export function applyMove(s: GameState, move: Move): GameState

export function resign(s: GameState, color: Color): GameState
export function flagFall(s: GameState, color: Color): GameState

/** THE security boundary. The ONLY legal way to serialise state for transport. */
export function stateForViewer(s: GameState, v: Viewer): ViewerState

export function renderForLLM(vs: ViewerState, opts: { baseUrl: string; token: string }): string

/** Setup-code codec (§6). ONE implementation — a renderer-side encoder plus a
 *  server-side parser would desync. 16 chars over 123456789FX. */
export function encodeSetupCode(state, color): string
export function decodeSetupCode(code, color, state): { assignment } | { error: string }

/** Game record export. Pure over a ViewerState, so it inherits redaction. */
export function exportMarkdown(vs: ViewerState): string
export function exportJson(vs: ViewerState): unknown
export function gameStats(vs: ViewerState): GameStats
```

### Critical implementation notes

Cross-reference the gamebook section given; do not reimplement from memory.

1. **Combat occupancy (§4).** Attacker wins → attacker occupies the target square. Attacker loses → attacker removed *from its origin*, defender unmoved, target square unchanged. Tie → both removed, square empty.
2. **En passant (§4).** Retained. Attacker wins → captured pawn removed from *its* square, attacker lands on the *skipped* square. Attacker loses → attacker removed from origin, skipped square stays empty.
3. **Bomb (§5).** Ties with everything except 工兵/軍旗, against which it **loses** in both directions. A surviving 工兵/軍旗 attacker **advances onto the target square** and is **not revealed**. If it reaches the 8th rank this way it **promotes** (§6).
4. **Reveal (§4 table).** Winner revealed. Loser never. Mutual-rank announces both. Bomb detonation announces the bomb only. Fizzle announces nothing. `mutual-rank` and `bomb-detonate` **must be distinct** event kinds — collapsing them makes a bomb victim wrongly infer the attacker's rank.
5. **Settlement (§7).** After **every ply**, both players score +1 per own piece on a centre square. Black's score starts at `komi`.
6. **Flag (§5, §7①).** Any 軍旗 leaving the board loses instantly, resolved in the ACTION sub-step before settlement. Both flags leaving simultaneously is a draw. Promotion and castling do **not** count as leaving the board.
7. **Pass (§3④).** Always legal. Increment is granted on a move, or on a pass when the player had **zero** other legal moves; never on a voluntary pass (§8).
8. **No-progress (§7③).** Increment `noProgressTurns` after a full turn in which no capture occurred and neither score changed. Any capture or any point resets it to 0. At N, higher score wins.
9. **No** insufficient-material, **no** threefold repetition, **no** 50-move rule, **no** stalemate (§3③⑤⑥).
10. `applyMove` is **pure** — never mutate the input state.

---

## 5. Server

### HTTP

```
POST /api/game            → { gameId, hostToken, guestUrl, hostUrl }
GET  /api/game/:token     → ViewerState as JSON
GET  /healthz             → 200
GET  /*                   → static client build
```

Tokens are unguessable random strings and are the only auth. Each game issues:
`hostToken`, `guestToken`, two bound-spectator tokens (one per colour), and one `publicToken` carrying no side — the only link that is safe to share while a game is live.

### Socket.IO

| Direction | Event | Payload |
|---|---|---|
| → | `join` | `{ token }` |
| → | `assign` | `{ assignment: Record<PieceId, Rank> }` |
| → | `move` | `{ move: Move }` |
| → | `resign` | `{}` |
| ← | `state` | `ViewerState` |
| ← | `error` | `{ message }` |

**Every outbound `state` payload must be produced by `stateForViewer()`.** No other serialisation path may exist. This is the single rule that keeps hidden ranks hidden.

### Clock

Server-authoritative. One timer per active game, ticking the side to move. On expiry call `flagFall()`. Increment applied per §8 of the gamebook: on a move, or on a forced pass. Skip entirely when `config.clockEnabled` is false.

---

## 6. LLM interface

GET-only, because web chatbots can fetch but cannot POST.

```
GET /llm/:token              current state, rendered as text/plain
GET /llm/:token/rules        rules primer, text/plain
GET /llm/:token/:ply/:move   play the move, return the new state
```

- `:move` is `e2e4`, `e7e8q` (promotion), `O-O`, `O-O-O`, or `pass`.
- **The `:ply` guard makes moves idempotent.** If `:ply` ≠ the game's current ply, do not apply the move; return the current state with a note. This protects against link previews, retries and eager re-fetching.
- Respond `Cache-Control: no-store`.
- The rendered view goes through `stateForViewer()` with `{ kind: 'player', color }`. **The LLM gets the log but not a solver** — same as a human (gamebook §10).
- Every legal move is listed with its **fully-built URL**, so the model picks one rather than constructing it.

Target render, see gamebook §10 for what may appear:

```
# 行軍西洋棋 — you are BLACK
Ply 14 · your turn · W 6 – B 8.5 · clock W 12:04 B 13:31

## Board  (UPPERCASE = White, lowercase = black, . = empty)
  a b c d e f g h
8 r . b q k b n r
...

## Your pieces
a8 rook 旅長 · b8 knight 爆裂物 · ...

## Known enemy ranks
e4 knight 團長  (revealed ply 9)

## Public log
 9  Nf3xe5   White knight revealed 團長; Black piece removed
13  Ng5xh7   有煙無傷 — White's h7 piece is 工兵 or 軍旗

## Legal moves — fetch one to play
d7d5   {baseUrl}/llm/{token}/14/d7d5
pass   {baseUrl}/llm/{token}/14/pass
```

---

## 7. Web client

Three screens.

**Create** — button creates a game, shows the invite URL to share and a link to enter as host.

**Setup** — the standard chess opening position with all 16 own pieces shown. Player assigns the 16 ranks by drag or click. Shows the remaining pool from `DISTRIBUTION`. Submit is disabled until the assignment is a valid bijection. A countdown reflects `setupTimeoutMs`.

**Game** — board, own ranks shown on own pieces, revealed ranks shown on any piece, centre squares highlighted, score, clocks, event log, pass button, resign button.

**The client must not implement rules.** It renders `ViewerState` and sends `Move`s. Move legality comes from `legalMoves` in the payload. No candidate-set computation for players (gamebook §10) — the log only.

---

## 8. Render deployment — PLACEHOLDERS

Not wired up in this build. Everything below is scaffolded with placeholder values and marked `TODO(render)`.

```yaml
# render.yaml — PLACEHOLDER, not deployed
services:
  - type: web
    name: PLACEHOLDER_SERVICE_NAME
    runtime: node
    plan: starter                    # free tier sleeps and drops live games
    buildCommand: npm ci && npm run build
    startCommand: npm start
    envVars:
      - key: NODE_VERSION
        value: "24"
      - key: PUBLIC_BASE_URL
        value: PLACEHOLDER_BASE_URL  # needed for LLM move URLs
```

The server reads `PORT` from the environment (Render supplies it) and falls back to 3000 locally. `PUBLIC_BASE_URL` is required only for §6 URL construction; locally it defaults to `http://localhost:3000`.

Single service serves API, WebSocket and the built client from one origin — no CORS, no second service.

---

## 9. Definition of done

1. `npm install && npm run build` succeeds from a clean checkout
2. `npm test` passes, including the redaction property test
3. `npm start` serves a playable game between two browser tabs via invite link
4. The LLM endpoints return a coherent view and accept moves
5. No `TODO` outside the `TODO(render)` placeholders
