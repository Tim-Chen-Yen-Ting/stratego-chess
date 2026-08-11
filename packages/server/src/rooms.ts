/**
 * In-memory game registry — techspec §5.
 *
 * There is no database. A room is a game plus its tokens, its clock and its
 * setup deadline. A server restart loses everything (techspec §0).
 *
 * Auth model: four unguessable tokens per game — one per player seat and one
 * spectator token bound to each colour (gamebook §10: a spectator enters through
 * a specific player and sees exactly that player's view). Possession of a token
 * IS the authorisation; there is nothing else to check.
 *
 * ALL rules live in @xiyang/rules. This file sequences calls into it and owns the
 * clock; it never decides a rules question.
 */

import { randomBytes, randomInt } from 'node:crypto'

import {
  applyMove,
  createGame,
  defaultAssignment,
  flagFall,
  opposite,
  resign,
  stateForViewer,
  submitAssignment,
  validateAssignment,
} from '@xiyang/rules'
import type {
  Color,
  GameConfig,
  GameState,
  Move,
  PieceId,
  Rank,
  Viewer,
  ViewerState,
} from '@xiyang/rules'

import { GameClock } from './clock.js'

export const COLORS: readonly Color[] = ['white', 'black']

/** Which side of the invite a player token came from. Purely cosmetic. */
export type Seat = 'host' | 'guest'

/** An error whose `message` is safe to hand to a client. */
export class RoomError extends Error {
  readonly status: number

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.name = 'RoomError'
    this.status = options?.status ?? 400
  }
}

export interface Room {
  readonly id: string
  /** authoritative state; replaced wholesale, never mutated in place */
  state: GameState
  /** player token per colour */
  readonly playerTokens: Record<Color, string>
  /** spectator token per colour, bound to that colour's view */
  readonly spectatorTokens: Record<Color, string>
  /** which colour the invite creator drew (gamebook §9 coin flip) */
  readonly hostColor: Color
  readonly clock: GameClock
  setupTimer: NodeJS.Timeout | null
  readonly createdAt: number
  lastActivity: number
}

export interface Resolved {
  readonly room: Room
  readonly viewer: Viewer
  readonly token: string
  /** present for player tokens only */
  readonly seat?: Seat
}

interface TokenRecord {
  readonly gameId: string
  readonly viewer: Viewer
  readonly seat?: Seat
}

/** Finished or abandoned games are swept after this long. Memory hygiene only. */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000

const rooms = new Map<string, Room>()
const tokens = new Map<string, TokenRecord>()

let broadcaster: (room: Room) => void = () => {}

/** sockets.ts installs the fan-out here; rooms.ts must not import sockets.ts. */
export function setBroadcaster(fn: (room: Room) => void): void {
  broadcaster = fn
}

function notify(room: Room): void {
  room.lastActivity = Date.now()
  broadcaster(room)
}

// ---------------------------------------------------------------- creation

function mintToken(): string {
  return randomBytes(24).toString('base64url')
}

function mintGameId(): string {
  let id = randomBytes(8).toString('base64url')
  while (rooms.has(id)) id = randomBytes(8).toString('base64url')
  return id
}

export function createRoom(config?: Partial<GameConfig>): Room {
  sweep()

  const id = mintGameId()
  // gamebook §9: 擲幣決定執白. The seat labels are about the invite, not the colour.
  const hostColor: Color = randomInt(2) === 0 ? 'white' : 'black'
  const guestColor: Color = opposite(hostColor)

  const playerTokens: Record<Color, string> = { white: '', black: '' }
  playerTokens[hostColor] = mintToken()
  playerTokens[guestColor] = mintToken()
  const spectatorTokens: Record<Color, string> = { white: mintToken(), black: mintToken() }

  // The host closures only run after `room` below is initialised.
  const clock = new GameClock({
    read: () => room.state,
    write: (next: GameState) => {
      room.state = next
    },
    onExpiry: (color: Color) => {
      onFlagFall(room, color)
    },
  })

  const now = Date.now()
  const room: Room = {
    id,
    state: createGame(id, config),
    playerTokens,
    spectatorTokens,
    hostColor,
    clock,
    setupTimer: null,
    createdAt: now,
    lastActivity: now,
  }

  for (const color of COLORS) {
    tokens.set(playerTokens[color], {
      gameId: id,
      viewer: { kind: 'player', color },
      seat: color === hostColor ? 'host' : 'guest',
    })
    tokens.set(spectatorTokens[color], {
      gameId: id,
      viewer: { kind: 'spectator', bound: color },
    })
  }

  rooms.set(id, room)
  armSetupTimer(room)
  return room
}

export function seatColor(room: Room, seat: Seat): Color {
  return seat === 'host' ? room.hostColor : opposite(room.hostColor)
}

// ---------------------------------------------------------------- lookup

export function getRoom(id: string): Room | undefined {
  return rooms.get(id)
}

export function resolveToken(token: string): Resolved | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const record = tokens.get(token)
  if (record === undefined) return undefined
  const room = rooms.get(record.gameId)
  if (room === undefined) return undefined
  return record.seat === undefined
    ? { room, viewer: record.viewer, token }
    : { room, viewer: record.viewer, token, seat: record.seat }
}

export function roomCount(): number {
  return rooms.size
}

// ------------------------------------------------------- THE serialiser

/**
 * The ONLY function on the server that turns game state into something sendable.
 * Everything outbound — Socket.IO `state`, GET /api/game/:token, the LLM render —
 * comes through here, and it goes through `stateForViewer` (techspec §5).
 *
 * Nothing else in this package may touch `room.state` on its way out.
 */
export function serialiseFor(room: Room, viewer: Viewer): ViewerState {
  // fold in the time burned so far, so every payload carries a live clock
  room.clock.sync()
  return stateForViewer(room.state, viewer)
}

// ---------------------------------------------------------------- setup

function armSetupTimer(room: Room): void {
  const ms = room.state.config.setupTimeoutMs
  if (!Number.isFinite(ms) || ms <= 0) return
  room.setupTimer = setTimeout(() => onSetupTimeout(room), ms)
}

function clearSetupTimer(room: Room): void {
  if (room.setupTimer !== null) {
    clearTimeout(room.setupTimer)
    room.setupTimer = null
  }
}

function pendingColors(state: GameState): Color[] {
  const status = state.status
  if (status.kind !== 'setup') return []
  return COLORS.filter((color) => !status.submitted[color])
}

/**
 * techspec §0/§5: on timeout, auto-apply `defaultAssignment()` for anyone who has
 * not submitted, then let the state machine start the game.
 */
function onSetupTimeout(room: Room): void {
  room.setupTimer = null
  if (room.state.status.kind !== 'setup') return

  for (const color of pendingColors(room.state)) {
    if (room.state.status.kind !== 'setup') break
    room.state = submitAssignment(room.state, color, defaultAssignment(color, room.state))
  }

  afterSetupChange(room)
  notify(room)
}

function afterSetupChange(room: Room): void {
  if (room.state.status.kind === 'setup') return
  clearSetupTimer(room)
  room.clock.resume()
}

export function submitRankAssignment(
  room: Room,
  color: Color,
  assignment: Record<PieceId, Rank>,
): void {
  const status = room.state.status
  if (status.kind !== 'setup') throw new RoomError('setup is already finished')
  if (status.submitted[color]) throw new RoomError('you have already submitted your assignment')

  const problem = validateAssignment(assignment, color, room.state)
  if (problem !== null) throw new RoomError(problem)

  try {
    room.state = submitAssignment(room.state, color, assignment)
  } catch (cause) {
    throw new RoomError('that assignment was rejected', { cause })
  }

  afterSetupChange(room)
  notify(room)
}

// ---------------------------------------------------------------- play

/**
 * The server does NOT grant the §8 增秒 itself.
 *
 * `applyMove` already does it, gated on "completed move, or FORCED pass, never a
 * voluntary pass" — which is a rules question (gamebook §8) and therefore the
 * engine's to answer. Adding it here too was a double increment. All this file
 * owns is *elapsed* time: `pause()` settles the mover's spent time into clockMs
 * BEFORE `applyMove` reads it, so the engine adds the increment on top of an
 * already-correct number.
 */
export function playMove(room: Room, color: Color, move: Move): void {
  const status = room.state.status
  if (status.kind === 'setup') throw new RoomError('the game has not started yet')
  if (status.kind === 'over') throw new RoomError('the game is over')
  if (room.state.toMove !== color) throw new RoomError('it is not your turn')

  // settle the mover's elapsed time before the state is replaced
  room.clock.pause()

  let next: GameState
  try {
    next = applyMove(room.state, move)
  } catch (cause) {
    room.clock.resume()
    throw new RoomError('illegal move', { cause })
  }

  room.state = next

  if (room.state.status.kind === 'playing') room.clock.resume()
  else room.clock.stop()

  notify(room)
}

export function resignPlayer(room: Room, color: Color): void {
  if (room.state.status.kind === 'over') throw new RoomError('the game is over')
  room.clock.pause()
  try {
    room.state = resign(room.state, color)
  } catch (cause) {
    room.clock.resume()
    throw new RoomError('could not resign', { cause })
  }
  clearSetupTimer(room)
  room.clock.stop()
  notify(room)
}

function onFlagFall(room: Room, color: Color): void {
  if (room.state.status.kind !== 'playing') return
  room.state = flagFall(room.state, color)
  room.clock.stop()
  notify(room)
}

// ---------------------------------------------------------------- sweeping

/** Drop rooms nobody has touched in a day. Games are in memory only (techspec §0). */
export function sweep(now = Date.now()): number {
  let dropped = 0
  for (const [id, room] of rooms) {
    if (now - room.lastActivity < ROOM_TTL_MS) continue
    clearSetupTimer(room)
    room.clock.dispose()
    for (const color of COLORS) {
      tokens.delete(room.playerTokens[color])
      tokens.delete(room.spectatorTokens[color])
    }
    rooms.delete(id)
    dropped += 1
  }
  return dropped
}

/** Test/shutdown helper: stop every timer this module owns. */
export function disposeAll(): void {
  for (const room of rooms.values()) {
    clearSetupTimer(room)
    room.clock.dispose()
  }
}
