/**
 * Socket.IO transport — techspec §5.
 *
 *   → join    { token }
 *   → assign  { assignment }
 *   → move    { move }
 *   → resign  {}
 *   ← state   ViewerState
 *   ← error   { message }
 *
 * Every outbound `state` payload is produced by `serialiseFor()` in rooms.ts,
 * which is the single call site of `stateForViewer()`. Sockets are grouped into
 * one Socket.IO room per *viewer identity* (player white, player black,
 * spectator-of-white, spectator-of-black), so a broadcast renders each distinct
 * view exactly once and no view can ever be sent to the wrong audience.
 *
 * A bot seat has no socket and no viewer identity here at all: it is driven
 * in-process by rooms.ts, which hands its policy the same `serialiseFor` payload
 * a human would get. Nothing on this transport can join it, act as it, or
 * subscribe to its view — see `issuedViewers` and the `join` guard.
 *
 * Incoming payloads are typed `unknown` on purpose: they come off the wire, so
 * they are shape-checked here before they reach the rules engine.
 */

import type { Server, Socket } from 'socket.io'

import type { Carrier, Color, Move, PieceId, Rank, Square, Viewer, ViewerState } from '@xiyang/rules'

import {
  COLORS,
  RoomError,
  isBotSeatViewer,
  playMove,
  resignPlayer,
  resolveToken,
  serialiseFor,
  setBroadcaster,
  submitRankAssignment,
  type Resolved,
  type Room,
} from './rooms.js'

// ------------------------------------------------------------- event shapes

/** Documented client → server payloads (validated at runtime, see the guards). */
export interface JoinPayload {
  token: string
}
export interface AssignPayload {
  assignment: Record<PieceId, Rank>
}
export interface MovePayload {
  move: Move
}

export interface ClientToServerEvents {
  join: (payload: unknown) => void
  assign: (payload: unknown) => void
  move: (payload: unknown) => void
  resign: (payload?: unknown) => void
}

export interface ServerToClientEvents {
  state: (state: ViewerState) => void
  error: (payload: { message: string }) => void
}

export interface SocketData {
  token: string | null
  viewerRoom: string | null
}

export type GameServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>

type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>

/** Minimal logging surface so this module does not depend on Fastify. */
export interface ServerLog {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

const NO_LOG: ServerLog = { info: () => {}, warn: () => {}, error: () => {} }

// ------------------------------------------------------------- viewer rooms

function viewerRoomName(gameId: string, viewer: Viewer): string {
  switch (viewer.kind) {
    case 'player':
      return `${gameId}#player:${viewer.color}`
    case 'spectator':
      return `${gameId}#spectator:${viewer.bound}`
    // Seatless and colourless, so every public observer of a game shares one
    // room — they all receive byte-identical payloads by construction.
    case 'spectator-public':
      return `${gameId}#spectator:public`
    case 'replay-player':
      return `${gameId}#replay:${viewer.color}`
    case 'omniscient':
      return `${gameId}#replay:omniscient`
  }
}

/**
 * Every viewer identity THIS GAME hands out. `broadcastState` fans out over this
 * list, so anything missing here receives its join payload and then silently
 * never updates again — a frozen board with no error, which is how the public
 * observer shipped broken the first time.
 *
 * A bot seat contributes NOTHING to this list: no player view and no bound
 * spectator view for its colour. That is not an optimisation. The bot's seat
 * carries its whole deployment, and the guarantee that nobody can subscribe to
 * it should not rest on "no token was minted" alone — this makes the view
 * unrenderable on the socket path as well, so two independent mistakes would be
 * needed to put it on the wire.
 */
function issuedViewers(room: Room): Viewer[] {
  const viewers: Viewer[] = []
  for (const color of COLORS) {
    const player: Viewer = { kind: 'player', color }
    const spectator: Viewer = { kind: 'spectator', bound: color }
    if (!isBotSeatViewer(room, player)) viewers.push(player)
    if (!isBotSeatViewer(room, spectator)) viewers.push(spectator)
  }
  viewers.push({ kind: 'spectator-public' })
  return viewers
}

// ------------------------------------------------------------- payload guards

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readToken(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const token = payload['token']
  return typeof token === 'string' && token.length > 0 ? token : null
}

/**
 * Shape only: piece id → some string. Whether those strings are real 兵種 and
 * whether they form the bijection demanded by gamebook §9 is `validateAssignment`'s
 * job, and duplicating that vocabulary here would be reimplementing a rule.
 */
function readAssignment(payload: unknown): Record<PieceId, Rank> | null {
  if (!isRecord(payload)) return null
  const assignment = payload['assignment']
  if (!isRecord(assignment)) return null
  const entries = Object.entries(assignment)
  if (entries.length === 0) return null
  for (const [id, rank] of entries) {
    if (id.length === 0) return null
    if (typeof rank !== 'string' || rank.length === 0) return null
  }
  // trusted only as far as "string → string"; the rules engine is the judge
  return assignment as Record<PieceId, Rank>
}

/** The carrier layer is plain chess, so this list is notation, not a rule. */
const PROMOTIONS = ['knight', 'bishop', 'rook', 'queen'] as const satisfies readonly Exclude<
  Carrier,
  'pawn' | 'king'
>[]

function isSquare(value: unknown): value is Square {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 63
}

export function readMove(payload: unknown): Move | null {
  if (!isRecord(payload)) return null
  const move = payload['move']
  if (!isRecord(move)) return null

  switch (move['kind']) {
    case 'pass':
      return { kind: 'pass' }
    case 'castle': {
      const side = move['side']
      return side === 'king' || side === 'queen' ? { kind: 'castle', side } : null
    }
    case 'move': {
      const from = move['from']
      const to = move['to']
      if (!isSquare(from) || !isSquare(to)) return null
      const promote = move['promote']
      if (promote === undefined || promote === null) return { kind: 'move', from, to }
      const match = PROMOTIONS.find((carrier) => carrier === promote)
      return match === undefined ? null : { kind: 'move', from, to, promote: match }
    }
    default:
      return null
  }
}

// ------------------------------------------------------------- handlers

export function registerSocketHandlers(io: GameServer, log: ServerLog = NO_LOG): void {
  setBroadcaster((room) => {
    broadcastState(io, room)
  })

  io.on('connection', (socket: GameSocket) => {
    socket.data.token = null
    socket.data.viewerRoom = null

    socket.on('join', (payload) => {
      const token = readToken(payload)
      if (token === null) {
        fail(socket, 'a token is required')
        return
      }
      const session = resolveToken(token)
      // The bot's seat is never issued a token, so the second test can only fire
      // on a bug in issuance — and it is exactly the bug that would put sixteen
      // hidden 兵種 into somebody's browser. Refused as "unknown", because from
      // the outside that seat genuinely has no address.
      if (session === undefined || isBotSeatViewer(session.room, session.viewer)) {
        fail(socket, 'unknown token')
        return
      }

      if (socket.data.viewerRoom !== null) socket.leave(socket.data.viewerRoom)
      const name = viewerRoomName(session.room.id, session.viewer)
      socket.data.token = token
      socket.data.viewerRoom = name
      void socket.join(name)

      sendState(socket, session)
    })

    socket.on('assign', (payload) => {
      guarded(socket, log, (session, color) => {
        const assignment = readAssignment(payload)
        if (assignment === null) throw new RoomError('malformed assignment')
        submitRankAssignment(session.room, color, assignment)
      })
    })

    socket.on('move', (payload) => {
      guarded(socket, log, (session, color) => {
        const move = readMove(payload)
        if (move === null) throw new RoomError('malformed move')
        playMove(session.room, color, move)
      })
    })

    socket.on('resign', () => {
      guarded(socket, log, (session, color) => {
        resignPlayer(session.room, color)
      })
    })

    // No disconnect handling on purpose: techspec §0 — the clock keeps running
    // and there is no grace period. Reconnecting simply re-joins.
  })
}

/**
 * Resolve the socket's session, require a player seat, run the action, and turn
 * anything thrown into a client-safe `error` event. Successful actions broadcast
 * through the registry, so nothing here emits state directly.
 */
function guarded(
  socket: GameSocket,
  log: ServerLog,
  action: (session: Resolved, color: Color) => void,
): void {
  const token = socket.data.token
  const session = token === null ? undefined : resolveToken(token)
  if (session === undefined) {
    fail(socket, 'join with a valid token first')
    return
  }
  if (session.viewer.kind !== 'player') {
    fail(socket, 'spectators cannot act in the game')
    return
  }

  try {
    action(session, session.viewer.color)
  } catch (error) {
    if (error instanceof RoomError) {
      // The cause may carry engine detail; it stays on the server.
      const cause = error.cause
      if (cause instanceof Error) log.warn(`rejected action: ${error.message} (${cause.message})`)
      fail(socket, error.message)
      return
    }
    log.error(`unhandled action failure: ${error instanceof Error ? error.message : 'unknown'}`)
    fail(socket, 'the server could not process that')
  }
}

function fail(socket: GameSocket, message: string): void {
  socket.emit('error', { message })
}

function sendState(socket: GameSocket, session: Resolved): void {
  socket.emit('state', serialiseFor(session.room, session.viewer))
}

/** Fan a state change out to every connected viewer, one render per identity. */
export function broadcastState(io: GameServer, room: Room): void {
  const occupied = io.sockets.adapter.rooms
  for (const viewer of issuedViewers(room)) {
    const name = viewerRoomName(room.id, viewer)
    if (!occupied.has(name)) continue
    io.to(name).emit('state', serialiseFor(room, viewer))
  }
}
