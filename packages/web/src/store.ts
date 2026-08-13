import { create } from 'zustand'
import { STARTING_LAYOUT, castlePlan } from '@xiyang/rules'
import type {
  Color,
  CombatOutcome,
  GameEvent,
  Move,
  PieceId,
  Rank,
  Square,
  Viewer,
  ViewerState,
} from '@xiyang/rules'
import { RANKS_IN_ORDER } from './constants.js'
import { connectGame, type GameSocket } from './socket.js'

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed'

interface AppState {
  token: string | null
  connection: ConnectionStatus
  /** the last ViewerState the server pushed — the client's only source of truth */
  view: ViewerState | null
  /** performance.now() at which `view` arrived, for local clock interpolation */
  viewAt: number
  error: string | null

  /**
   * 玩家標記 (gamebook §10) for the game AND seat named by `pencilScope`, and for
   * no other. Guesses the player wrote down themselves. A piece carries a SET of
   * ranks, because the information in this game is almost never a single name:
   * surviving a bomb means 工兵 OR 軍旗, and a behavioural read is "軍旗, maybe
   * 司令". This slice is CLIENT ONLY: it is never read by `sendAssign` /
   * `sendMove` / `sendResign`, never put in a socket payload, and is not part of
   * the redaction layer. Nothing in this store validates a mark against the
   * position, filters the offered ranks, or counts what is left — that would
   * make it a solver, which §10 forbids for players.
   *
   * Keyed by PieceId, never by square, so a mark survives the piece moving AND
   * the piece leaving the board. A CAPTURED piece is the one a player most wants
   * to annotate: the killing event is public, the player works the range out in
   * their own head, and they write it down here before they forget. The store
   * has no opinion about which pieces are annotatable — that is an entitlement
   * question the UI answers (enemy, rank not disclosed), not a deduction.
   */
  pencilScope: string | null
  pencilMarks: Record<PieceId, Rank[]>

  connect: (token: string) => void
  disconnect: () => void
  clearError: () => void
  setError: (message: string) => void

  /**
   * Swap the notepad to one game as seen from one seat, reading that notepad
   * from localStorage. Two tabs of the same browser are two seats and therefore
   * two notepads (see `pencilSeatKey`).
   */
  loadPencilMarks: (gameId: string, seat: string) => void
  /** Add `rank` if absent, remove it if present. No other piece is touched. */
  togglePencilMark: (pieceId: PieceId, rank: Rank) => void
  /** Add `rank` if absent; a second add is a no-op (used by drag-and-drop). */
  addPencilMark: (pieceId: PieceId, rank: Rank) => void
  /** Erase every mark on one piece. */
  clearPencilMark: (pieceId: PieceId) => void
  clearPencilMarks: () => void

  sendAssign: (assignment: Record<PieceId, Rank>) => void
  sendMove: (move: Move) => void
  sendResign: () => void
}

/** The socket lives outside the store: it is a resource, not render state. */
let socket: GameSocket | null = null

// ---------- pencil-mark persistence (localStorage, never the wire) ----------

const PENCIL_PREFIX = 'xiyang.pencil.'
/** Notes for a game nobody has opened in a week are dropped on next load. */
const PENCIL_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * v1 held one rank per piece. v2 holds a set. Records at any other version are
 * discarded on sight rather than migrated — a notepad is cheap to rewrite and a
 * migration is one more thing that can silently corrupt it.
 *
 * Extending marks to captured pieces did NOT bump this. The stored shape is
 * `{pieceId: rankName[]}` either way — a dead piece is just a piece id that
 * happens to have `square === null` in the payload, and nothing about a record
 * says where its pieces stand. A v2 notepad written before captured pieces were
 * annotatable reads back correctly; bumping would have thrown away the notes of
 * everyone mid-game for no gain.
 */
const PENCIL_VERSION = 2

/** Membership test on the eleven 兵種 names — a JSON parse guard, not a rule. */
const RANK_NAMES: ReadonlySet<string> = new Set<string>(RANKS_IN_ORDER)

interface PencilRecord {
  v: number
  savedAt: number
  marks: Record<PieceId, Rank[]>
}

/**
 * The key carries the game id AND the seat, so a different game is a different
 * notepad and — the case that matters for the two-tab test flow — white and
 * black in the same browser keep separate notepads instead of overwriting each
 * other. Nothing is ever shared between scopes.
 */
function pencilKey(scope: string): string {
  return `${PENCIL_PREFIX}${scope}`
}

/**
 * Which seat this viewer occupies, as a storage-key fragment.
 *
 * 公開觀戰者 gets a fragment of its own even though it has no seat and no
 * notepad UI (see `isPublicSpectator`). The key is what keeps notepads apart,
 * so the one viewer that must never touch a player's notes needs a fragment
 * that cannot collide with one: open the public link in the same browser as
 * your own seat and the two are `…::public` and `…::player-white`, which is the
 * difference between reading your own handwriting and overwriting it.
 */
export function pencilSeatKey(viewer: Viewer): string {
  switch (viewer.kind) {
    case 'player':
      return `player-${viewer.color}`
    case 'spectator':
      return `spectator-${viewer.bound}`
    case 'spectator-public':
      return 'public'
    case 'replay-player':
      return `replay-${viewer.color}`
    case 'omniscient':
      return 'omniscient'
  }
}

export function pencilScopeOf(gameId: string, seat: string): string {
  return `${gameId}::${seat}`
}

/** Stable, deduplicated display order. Says nothing about the position. */
function normalize(ranks: readonly Rank[]): Rank[] {
  const seen = new Set<Rank>()
  for (const r of ranks) seen.add(r)
  return RANKS_IN_ORDER.filter((r) => seen.has(r))
}

function readPencil(scope: string): Record<PieceId, Rank[]> {
  try {
    const raw = window.localStorage.getItem(pencilKey(scope))
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Partial<PencilRecord>
    // wrong schema version: discard, do not migrate
    if (record.v !== PENCIL_VERSION) return {}
    const marks = record.marks
    if (typeof marks !== 'object' || marks === null) return {}
    const out: Record<PieceId, Rank[]> = {}
    // Keep only entries that are actually {pieceId: rankName[]}. This drops
    // corrupt or hand-edited storage; it makes no claim about the position.
    for (const [id, value] of Object.entries(marks as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const kept: Rank[] = []
      for (const item of value as unknown[]) {
        if (typeof item === 'string' && RANK_NAMES.has(item)) kept.push(item as Rank)
      }
      if (kept.length > 0) out[id] = normalize(kept)
    }
    return out
  } catch {
    return {}
  }
}

function writePencil(scope: string, marks: Record<PieceId, Rank[]>): void {
  try {
    const trimmed: Record<PieceId, Rank[]> = {}
    for (const [id, ranks] of Object.entries(marks)) {
      if (ranks.length > 0) trimmed[id] = ranks
    }
    if (Object.keys(trimmed).length === 0) {
      window.localStorage.removeItem(pencilKey(scope))
      return
    }
    const record: PencilRecord = { v: PENCIL_VERSION, savedAt: Date.now(), marks: trimmed }
    window.localStorage.setItem(pencilKey(scope), JSON.stringify(record))
  } catch {
    // storage disabled or full — the notepad degrades to this session only
  }
}

/**
 * Housekeeping so old games do not accumulate forever. Also drops every record
 * written by an older schema, which is how v1 notepads disappear.
 */
function prunePencil(keep: string): void {
  try {
    const now = Date.now()
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key === null || !key.startsWith(PENCIL_PREFIX) || key === pencilKey(keep)) continue
      try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
        const record = parsed as Partial<PencilRecord> | null
        const savedAt = record?.savedAt
        if (record?.v !== PENCIL_VERSION) doomed.push(key)
        else if (typeof savedAt !== 'number' || now - savedAt > PENCIL_TTL_MS) doomed.push(key)
      } catch {
        doomed.push(key)
      }
    }
    for (const key of doomed) window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export const useStore = create<AppState>()((set, get) => ({
  token: null,
  connection: 'idle',
  view: null,
  viewAt: 0,
  error: null,
  pencilScope: null,
  pencilMarks: {},

  connect: (token) => {
    if (get().token === token && socket) return
    socket?.close()
    socket = null
    // a different token may be a different game or a different seat: start with
    // an empty notepad and let the Game screen load the marks belonging to the
    // game and seat it receives.
    set({
      token,
      connection: 'connecting',
      view: null,
      viewAt: 0,
      error: null,
      pencilScope: null,
      pencilMarks: {},
    })
    socket = connectGame(token, {
      onState: (view) => set({ view, viewAt: performance.now(), connection: 'open' }),
      onError: (message) => set({ error: message }),
      onOpen: () => set({ connection: 'open' }),
      onClose: () => set({ connection: 'closed' }),
    })
  },

  disconnect: () => {
    socket?.close()
    socket = null
    set({
      token: null,
      connection: 'idle',
      view: null,
      viewAt: 0,
      pencilScope: null,
      pencilMarks: {},
    })
  },

  clearError: () => set({ error: null }),
  setError: (message) => set({ error: message }),

  loadPencilMarks: (gameId, seat) => {
    const scope = pencilScopeOf(gameId, seat)
    if (get().pencilScope === scope) return
    prunePencil(scope)
    set({ pencilScope: scope, pencilMarks: readPencil(scope) })
  },

  // No validation and no inference (gamebook §10): whatever ranks the player
  // ticked are written down as-is, on any piece, in any combination, however
  // many times the same rank appears across the board.
  togglePencilMark: (pieceId, rank) => {
    const scope = get().pencilScope
    if (scope === null) return
    const current = get().pencilMarks[pieceId] ?? []
    const next = current.includes(rank)
      ? current.filter((r) => r !== rank)
      : normalize([...current, rank])
    const marks = { ...get().pencilMarks }
    if (next.length === 0) delete marks[pieceId]
    else marks[pieceId] = next
    writePencil(scope, marks)
    set({ pencilMarks: marks })
  },

  addPencilMark: (pieceId, rank) => {
    const scope = get().pencilScope
    if (scope === null) return
    const current = get().pencilMarks[pieceId] ?? []
    if (current.includes(rank)) return
    const marks = { ...get().pencilMarks, [pieceId]: normalize([...current, rank]) }
    writePencil(scope, marks)
    set({ pencilMarks: marks })
  },

  clearPencilMark: (pieceId) => {
    const scope = get().pencilScope
    if (scope === null) return
    const marks = { ...get().pencilMarks }
    delete marks[pieceId]
    writePencil(scope, marks)
    set({ pencilMarks: marks })
  },

  clearPencilMarks: () => {
    const scope = get().pencilScope
    if (scope === null) return
    writePencil(scope, {})
    set({ pencilMarks: {} })
  },

  sendAssign: (assignment) => {
    if (!socket) return set({ error: '尚未連線' })
    socket.emit('assign', { assignment })
  },

  sendMove: (move) => {
    if (!socket) return set({ error: '尚未連線' })
    socket.emit('move', { move })
  },

  sendResign: () => {
    if (!socket) return set({ error: '尚未連線' })
    socket.emit('resign', {})
  },
}))

// ---------- derived helpers (no rules, only entitlement bookkeeping) ----------

/**
 * The colour whose seat this viewer occupies, or null when it occupies none.
 *
 * NULL IS NOT WHITE. Two viewers have no colour, for opposite reasons: the
 * omniscient replay viewer needs none because it sees every colour, and the
 * 公開觀戰者 needs none because it sees no hidden 兵種 at all. Every caller must
 * treat the null as "this viewer owns nothing" and never fall back to a side —
 * a `me ?? 'white'` used for anything but which way up to draw the board would
 * hand White's pieces to somebody who is not White. Board orientation is the
 * one legitimate default, because it is a drawing convention and grants nothing.
 */
export function viewerColor(viewer: Viewer): Color | null {
  switch (viewer.kind) {
    case 'player':
      return viewer.color
    case 'spectator':
      return viewer.bound
    case 'spectator-public':
      return null
    case 'replay-player':
      return viewer.color
    case 'omniscient':
      return null
  }
}

/**
 * 公開觀戰者 (gamebook §10) — the seatless viewer. It holds no colour, so it is
 * handed nobody's army, and its link is the only one that is safe to pass to a
 * third party while the game is live.
 *
 * It is NOT the same question as `viewerColor(...) === null`: the omniscient
 * replay viewer is colourless too and sees everything, which is the opposite
 * entitlement. Ask this when the question is "is this the public view"; ask
 * `viewerColor` when the question is "whose pieces are these".
 */
export function isPublicSpectator(view: ViewerState): boolean {
  return view.viewer.kind === 'spectator-public'
}

/**
 * Only a seated player may act. Bound spectators and the 公開觀戰者 are
 * read-only views (§10) — and the server agrees, so a client that got this
 * wrong would be refused rather than obeyed.
 */
export function canAct(view: ViewerState): boolean {
  return view.viewer.kind === 'player'
}

/**
 * The board is playable exactly when the server sent `legalMoves` — the client
 * never derives legality itself (techspec §7).
 */
export function myLegalMoves(view: ViewerState): Move[] {
  if (!canAct(view)) return []
  return view.legalMoves ?? []
}

// ---------- which event removed which piece (log bookkeeping, not a solver) ----------

/**
 * 紀錄給，解算不給 (gamebook §10). A `GameEvent` names squares, not pieces, so
 * "what killed my knight?" is buried twenty lines up the log even though the
 * answer was announced out loud at the time. What follows re-associates each
 * removed piece with the public event that removed it, so the captured tray can
 * put the announcement next to the piece instead of making the player scroll.
 *
 * THIS IS LOG, NOT SOLVER, and the line between them is exactly where the
 * carrier layer ends:
 *
 *   · Everything consumed here is public to both sides — the fixed opening
 *     position (`STARTING_LAYOUT`), the from/to squares in the log, the castling
 *     geometry (`castlePlan`), and the outcome kind the server announced. The
 *     rules engine's own LLM renderer replays the same record the same way.
 *   · Who died is READ OFF the announced outcome, never worked out: an
 *     `attacker-wins` event says the defender was removed, a `fizzle` says the
 *     bomb was. No rank is compared, no rank is guessed, no candidate set is
 *     built, nothing is counted against §2. The 兵種 layer is not touched at all.
 *
 * A consumer that turned a record into "so it must be one of these five" would
 * be the solver §10 forbids. Showing the event and stopping is the whole point.
 */
export interface CaptureRecord {
  /** the ply whose ACTION sub-step removed this piece */
  ply: number
  /** the public event, verbatim from `view.log` */
  event: GameEvent
  /** did this piece move into the contact, or was it the one standing there */
  role: 'attacker' | 'defender'
  /** the square it was standing on when it was removed (§4 位置結算) */
  square: Square
}

/**
 * Who is left standing, restated from the announcement. Every branch is a
 * transcription of gamebook §4「翻明總表」/ §5 — not a rank comparison, which
 * the client could not perform and must never attempt.
 */
function survivors(
  outcome: CombatOutcome,
  mover: Color,
): { attacker: boolean; defender: boolean } {
  switch (outcome.kind) {
    case 'attacker-wins':
      return { attacker: true, defender: false }
    case 'defender-wins':
      return { attacker: false, defender: true }
    // 同歸於盡 — one announcement covering an equal 兵種, a 爆裂物 taking an
    // ordinary piece, and 爆裂物 vs 爆裂物. Which of the three it was is not in
    // the event and must not be guessed; it makes no difference here, because
    // all three clear the square (§4 位置結算).
    case 'mutual-destruction':
      return { attacker: false, defender: false }
    case 'fizzle': {
      // 有煙無傷: the 爆裂物 is the one removed, so the announced survivor colour
      // says which side of the contact walked away (§5).
      const attackerLived = outcome.survivorColor === mover
      return { attacker: attackerLived, defender: !attackerLived }
    }
  }
}

function applyEventToIds(
  board: (PieceId | undefined)[],
  out: Map<PieceId, CaptureRecord>,
  e: GameEvent,
): void {
  if (e.move.kind === 'pass') return

  if (e.move.kind === 'castle') {
    const plan = castlePlan(e.color, e.move.side)
    const king = board[plan.kingFrom]
    const rook = board[plan.rookFrom]
    board[plan.kingFrom] = undefined
    board[plan.rookFrom] = undefined
    if (king !== undefined) board[plan.kingTo] = king
    if (rook !== undefined) board[plan.rookTo] = rook
    return
  }

  const { from, to } = e.move

  if (!e.combat) {
    const id = board[from]
    board[from] = undefined
    if (id !== undefined) board[to] = id
    return
  }

  const { outcome, attackerSquare, defenderSquare, survivorSquare } = e.combat
  const attacker = board[attackerSquare]
  const defender = board[defenderSquare]
  board[attackerSquare] = undefined
  board[defenderSquare] = undefined
  // en passant is the one case where the destination is neither contact square
  board[to] = undefined

  const alive = survivors(outcome, e.color)

  if (!alive.attacker && attacker !== undefined) {
    out.set(attacker, { ply: e.ply, event: e, role: 'attacker', square: attackerSquare })
  }
  if (!alive.defender && defender !== undefined) {
    out.set(defender, { ply: e.ply, event: e, role: 'defender', square: defenderSquare })
  }

  const survivor = alive.attacker ? attacker : alive.defender ? defender : undefined
  if (survivor !== undefined && survivorSquare !== null) board[survivorSquare] = survivor
}

/**
 * piece id → the public event that removed it. Pieces still on the board, and
 * any piece the log never touched, simply have no entry.
 */
export function captureRecords(log: readonly GameEvent[]): Map<PieceId, CaptureRecord> {
  const out = new Map<PieceId, CaptureRecord>()
  const board = new Array<PieceId | undefined>(64)
  for (const slot of STARTING_LAYOUT) board[slot.square] = slot.id
  for (const e of log) applyEventToIds(board, out, e)
  return out
}
