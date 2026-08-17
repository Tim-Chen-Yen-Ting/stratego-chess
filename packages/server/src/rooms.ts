/**
 * In-memory game registry — techspec §5.
 *
 * There is no database. A room is a game plus its tokens, its clock and its
 * setup deadline. A server restart loses everything (techspec §0).
 *
 * Auth model: five unguessable tokens per game — one per player seat, one
 * spectator token bound to each colour (gamebook §10: a spectator enters through
 * a specific player and sees exactly that player's view), and one public
 * observer token that is bound to nobody. Possession of a token IS the
 * authorisation; there is nothing else to check.
 *
 * The five are not interchangeable, and the difference is the whole point: a
 * bound spectator token IS that player's army, so passing one to a third party
 * mid-game hands over sixteen 兵種. The public token carries only what both
 * players already know, which is why it is the one that is safe to share.
 *
 * ---------------------------------------------------------------------------
 * BOT SEATS
 * ---------------------------------------------------------------------------
 *
 * A room may have one seat played in-process by a `Policy` from @xiyang/bot.
 * Two rules govern it, and they point in opposite directions on purpose:
 *
 *   · the BOT is a player. It is handed `serialiseFor(room, { kind: 'player',
 *     color })` and nothing else — never the `GameState`, never the human's
 *     ranks. A policy that could see hidden 兵種 is not an opponent, it is the
 *     answer key.
 *   · the HUMAN must not be able to read the bot's army either. A bot seat is
 *     played from memory, so it needs no credential at all — and therefore
 *     MINTS NONE. `playerTokens[botColor]` and `spectatorTokens[botColor]` are
 *     `null`, not an unissued string: there is no token to leak, no row in the
 *     token map to resolve, and no code path that could accidentally print one.
 *     Handing back the bot's seat link would hand back its entire deployment.
 *
 * The coin flip (§9) still decides colour, so the human may well be Black. The
 * creator always holds the `host` seat; the bot always sits in `guest`.
 *
 * ALL rules live in @xiyang/rules. This file sequences calls into it and owns the
 * clock; it never decides a rules question.
 */

import { randomBytes, randomInt } from 'node:crypto'

import {
  ALL_RANKS,
  DISTRIBUTION,
  applyMove,
  createGame,
  defaultAssignment,
  flagFall,
  moveToNotation,
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
import { deriveSeed, makeRng } from '@xiyang/bot'
import type { Policy, Rng } from '@xiyang/bot'

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

/**
 * Minimal logging surface, so this module depends on no web framework.
 *
 * The default is NOT a no-op for `error`. A policy that returns an illegal move
 * stalls the game with the bot to play and nothing on screen to explain it; if
 * that can happen silently on a server nobody wired a logger into, the bug is
 * invisible exactly when it matters. `info`/`warn` stay quiet until asked.
 */
export interface RoomLog {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

let log: RoomLog = {
  info: () => {},
  warn: () => {},
  error: (message) => {
    process.stderr.write(`${message}\n`)
  },
}

/** index.ts installs the Fastify logger here. */
export function setRoomLog(next: RoomLog): void {
  log = next
}

/** How long the bot appears to think before its move lands. */
export const DEFAULT_BOT_THINK_MS = 400
const MAX_BOT_THINK_MS = 30_000

function readEnvThinkMs(): number {
  const parsed = Number.parseInt(process.env['BOT_THINK_MS'] ?? '', 10)
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_BOT_THINK_MS
  return Math.min(parsed, MAX_BOT_THINK_MS)
}

const ENV_BOT_THINK_MS = readEnvThinkMs()

/** What a caller asks for when it wants the second seat played by a policy. */
export interface BotOpponent {
  readonly policy: Policy
  /** the POLICIES registry key, echoed back to clients. Never a rules input. */
  readonly name: string
  /** overrides BOT_THINK_MS for this room. Clamped. */
  readonly thinkMs?: number
}

export interface CreateRoomOptions {
  readonly config?: Partial<GameConfig>
  readonly bot?: BotOpponent
}

/**
 * The in-process opponent. Everything mutable here is scheduling bookkeeping —
 * the bot holds no game state of its own, because it is handed a fresh
 * `ViewerState` for every decision and retains nothing between them.
 */
export interface BotSeat {
  readonly color: Color
  readonly policy: Policy
  readonly name: string
  readonly thinkMs: number
  /**
   * Separate streams for 佈署 and for moves, both derived from the room id, so a
   * game is reproducible from its id alone and the deployment draw does not
   * shift the move draws (@xiyang/bot prng.ts: split, never share).
   */
  readonly deployRng: Rng
  readonly moveRng: Rng
  /** the pending think-delay timer, or null when nothing is queued */
  timer: NodeJS.Timeout | null
  /** re-entrancy latch: true from picking a move until the broadcast is done */
  thinking: boolean
  /** set once a policy has failed. The seat stops driving rather than spinning. */
  faulted: boolean
}

export interface Room {
  readonly id: string
  /** authoritative state; replaced wholesale, never mutated in place */
  state: GameState
  /**
   * Player token per colour, or null for a seat played in-process by a bot.
   *
   * Null rather than an unissued string: a bot seat has no credential to hand
   * out, and modelling that as "there is no token" makes every consumer confront
   * it at the type level instead of quietly interpolating one into a URL.
   */
  readonly playerTokens: Record<Color, string | null>
  /** spectator token per colour, bound to that colour's view; null for a bot seat */
  readonly spectatorTokens: Record<Color, string | null>
  /**
   * The one token in the room that is bound to no player: it resolves to
   * `{ kind: 'spectator-public' }`, which sees 翻明 ranks and the public log and
   * nothing else. Safe to hand to anyone while the game is running.
   */
  readonly publicToken: string
  /**
   * Sees both armies, live. Issued ONLY to the invite creator, who already
   * holds both player tokens (techspec §0, accepted) — so it grants nothing
   * they could not already get by opening both seats. It must never reach the
   * guest or any third party: for them it IS the game.
   */
  readonly omniscientToken: string
  /** which colour the invite creator drew (gamebook §9 coin flip) */
  readonly hostColor: Color
  /** the seat played by a policy, or null for a human-vs-human game */
  readonly bot: BotSeat | null
  readonly clock: GameClock
  setupTimer: NodeJS.Timeout | null
  /** absolute epoch-ms the setup timer fires, or null when it is not armed */
  setupDeadline: number | null
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

/**
 * One state change, fanned out — and then the bot is given the chance to answer.
 *
 * The broadcast is wrapped because a transport failure is not a game failure:
 * letting a Socket.IO error escape here would abort `playMove` half-way through
 * and, worse, would be mistaken for a bot fault by `takeBotTurn`'s catch.
 */
function notify(room: Room): void {
  room.lastActivity = Date.now()
  try {
    broadcaster(room)
  } catch (error) {
    log.error(`broadcast failed for game ${room.id}: ${describeError(error)}`)
  }
  driveBot(room)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/**
 * Seed the room's bot streams from the ROOM ID.
 *
 * The id is the one handle a human has on a finished game, so deriving from it
 * makes "replay game xyz" possible without storing anything: same id, same
 * policy, same deployment and the same tie-breaks. `deriveSeed` hashes the
 * label, so neighbouring ids do not produce correlated streams.
 */
function botSeed(id: string, label: string): number {
  return deriveSeed(deriveSeed(0, `room:${id}`), label)
}

export function createRoom(options: CreateRoomOptions = {}): Room {
  sweep()

  const { config, bot: opponent } = options
  const id = mintGameId()
  // gamebook §9: 擲幣決定執白. The seat labels are about the invite, not the colour.
  // The flip runs for a bot game too: the human is the host seat and may be Black.
  const hostColor: Color = randomInt(2) === 0 ? 'white' : 'black'
  const guestColor: Color = opposite(hostColor)

  // The bot always takes the guest seat — the creator is the one holding the
  // browser — and that seat is issued NO tokens at all. See the file header.
  const botColor: Color | null = opponent === undefined ? null : guestColor

  const playerTokens: Record<Color, string | null> = { white: null, black: null }
  const spectatorTokens: Record<Color, string | null> = { white: null, black: null }
  for (const color of COLORS) {
    if (color === botColor) continue
    playerTokens[color] = mintToken()
    spectatorTokens[color] = mintToken()
  }
  const publicToken = mintToken()
  const omniscientToken = mintToken()

  const bot: BotSeat | null =
    opponent === undefined || botColor === null
      ? null
      : {
          color: botColor,
          policy: opponent.policy,
          name: opponent.name,
          thinkMs: clampThinkMs(opponent.thinkMs),
          deployRng: makeRng(botSeed(id, `deploy:${botColor}`)),
          moveRng: makeRng(botSeed(id, `move:${botColor}`)),
          timer: null,
          thinking: false,
          faulted: false,
        }

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
    publicToken,
    omniscientToken,
    hostColor,
    bot,
    clock,
    setupTimer: null,
    setupDeadline: null,
    createdAt: now,
    lastActivity: now,
  }

  // A bot seat minted no tokens, so there is nothing to register for it: no
  // player row and no bound-spectator row. Its view exists only inside
  // `takeBotTurn`, and no string in the universe resolves to it.
  for (const color of COLORS) {
    const playerToken = playerTokens[color]
    if (playerToken !== null) {
      tokens.set(playerToken, {
        gameId: id,
        viewer: { kind: 'player', color },
        seat: color === hostColor ? 'host' : 'guest',
      })
    }
    const spectatorToken = spectatorTokens[color]
    if (spectatorToken !== null) {
      tokens.set(spectatorToken, {
        gameId: id,
        viewer: { kind: 'spectator', bound: color },
      })
    }
  }

  // No colour, no seat. `entitledToRank` gives this viewer a 兵種 only once the
  // piece is 翻明 or the game is over, so it is the one link in the room that can
  // be handed to a third party mid-game without giving away an army.
  tokens.set(publicToken, { gameId: id, viewer: { kind: 'spectator-public' } })
  tokens.set(omniscientToken, { gameId: id, viewer: { kind: 'omniscient' } })

  rooms.set(id, room)
  armSetupTimer(room)
  // §9 佈署 is 同時且互不可見, so the bot deploys the moment the room exists rather
  // than waiting to see what the human does. It could not see it anyway.
  deployBot(room)
  return room
}

function clampThinkMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return ENV_BOT_THINK_MS
  return Math.min(MAX_BOT_THINK_MS, Math.max(0, Math.round(requested)))
}

/**
 * Does this viewer identity belong to the room's bot seat?
 *
 * The second barrier. No token resolves to a bot seat in the first place, so
 * this can only ever fire on a bug — which is the point of asking: the HTTP and
 * socket layers check it before they serialise or fan anything out, so a future
 * mistake in token issuance still cannot put the bot's sixteen 兵種 on the wire.
 */
export function isBotSeatViewer(room: Room, viewer: Viewer): boolean {
  const bot = room.bot
  if (bot === null) return false
  switch (viewer.kind) {
    case 'player':
    case 'replay-player':
      return viewer.color === bot.color
    case 'spectator':
      return viewer.bound === bot.color
    default:
      return false
  }
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
  const view = stateForViewer(room.state, viewer)
  // The setup deadline is wall-clock state owned by this layer, not by the rules
  // engine. Attaching it here keeps `stateForViewer` the single redaction path —
  // this carries no 兵種 and is the same value for every viewer.
  if (view.status.kind === 'setup' && room.setupDeadline !== null) {
    view.setupDeadlineMs = room.setupDeadline
  }
  return view
}

// ---------------------------------------------------------------- setup

function armSetupTimer(room: Room): void {
  const ms = room.state.config.setupTimeoutMs
  if (!Number.isFinite(ms) || ms <= 0) return
  room.setupTimer = setTimeout(() => onSetupTimeout(room), ms)
  room.setupDeadline = Date.now() + ms
}

function clearSetupTimer(room: Room): void {
  if (room.setupTimer !== null) {
    clearTimeout(room.setupTimer)
    room.setupTimer = null
    room.setupDeadline = null
  }
}

function pendingColors(state: GameState): Color[] {
  const status = state.status
  if (status.kind !== 'setup') return []
  return COLORS.filter((color) => !status.submitted[color])
}

/**
 * A uniformly random legal deployment (§9 一對一 bijection onto DISTRIBUTION).
 *
 * The shuffle lives HERE and not in @xiyang/rules deliberately: the rules
 * package is pure and deterministic, which is what makes it testable, and
 * randomness is the server's business. `randomInt` is the CSPRNG — a predictable
 * army is the same failure as a published one, and this is hidden information.
 *
 * Fisher-Yates over THIS GAME'S 兵種 table, so every draw is a valid assignment
 * by construction and every valid assignment is equally likely. It must read
 * `state.config.distribution` and not the module constant: in a retuned game the
 * constant's multiset is the wrong one, and the §9 timeout deployment would then
 * be rejected by the game's own validator.
 */
export function randomAssignment(state: GameState, color: Color): Record<PieceId, Rank> {
  const bag: Rank[] = []
  for (const rank of ALL_RANKS) {
    for (let n = 0; n < (state.config.distribution[rank] ?? 0); n++) bag.push(rank)
  }

  for (let i = bag.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const a = bag[i]!
    bag[i] = bag[j]!
    bag[j] = a
  }

  const own = state.pieces.filter((piece) => piece.color === color)
  if (own.length !== bag.length) {
    throw new RoomError(`cannot deploy: ${color} has ${own.length} pieces, expected ${bag.length}`, {
      status: 500,
    })
  }

  const assignment: Record<PieceId, Rank> = {}
  own.forEach((piece, i) => {
    assignment[piece.id] = bag[i]!
  })
  return assignment
}

/**
 * techspec §0/§5: on timeout, auto-deploy for anyone who has not submitted, then
 * let the state machine start the game.
 *
 * The fallback is RANDOM, not `defaultAssignment()`. A deterministic fallback is
 * a published army: every opponent can look up exactly where the timed-out
 * player's 軍旗 and 爆裂物 sit, which destroys the hidden layer (gamebook §10)
 * for the rest of that game. `defaultAssignment` survives only as the
 * last-resort belt-and-braces below — a game wedged in setup forever is worse
 * than a predictable one, and it can never actually be reached.
 */
function timeoutAssignment(state: GameState, color: Color): Record<PieceId, Rank> {
  const rolled = randomAssignment(state, color)
  return validateAssignment(rolled, color, state) === null
    ? rolled
    : defaultAssignment(color, state)
}

function onSetupTimeout(room: Room): void {
  room.setupTimer = null
  if (room.state.status.kind !== 'setup') return

  for (const color of pendingColors(room.state)) {
    if (room.state.status.kind !== 'setup') break
    room.state = submitAssignment(room.state, color, timeoutAssignment(room.state, color))
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

// ---------------------------------------------------------------- the bot seat

/**
 * The bot's lens. The ONLY thing a policy is ever handed.
 *
 * It is the same call the human's browser is served from — `serialiseFor` →
 * `stateForViewer` — with the bot's own colour in it. There is deliberately no
 * second path: no `room.state`, no piece list, no "just for the bot" accessor.
 * A bot that could see the human's 兵種 is not an opponent, and every number a
 * game with one produced would describe a variant nobody plays.
 */
function botView(room: Room, bot: BotSeat): ViewerState {
  return serialiseFor(room, { kind: 'player', color: bot.color })
}

function clearBotTimer(room: Room): void {
  const bot = room.bot
  if (bot === null || bot.timer === null) return
  clearTimeout(bot.timer)
  bot.timer = null
}

/**
 * §9 佈署 for the bot seat, run once at room creation.
 *
 * The view handed to `deploy` is the pre-deployment one, in which `stateForViewer`
 * withholds the ranks of every side that has not submitted — including the bot's
 * own placeholders. So there is nothing to peek at even in principle.
 *
 * A policy that returns an invalid deployment is logged loudly and then
 * OVERRIDDEN with a random §9 army, which is the opposite of the move path
 * below. The asymmetry is deliberate: the gamebook already specifies a random
 * fallback for a side that fails to deploy (§9 佈署逾時者), so substituting one
 * here changes nothing about the game — whereas substituting a MOVE would
 * silently paper over a broken policy with a legal-looking ply.
 */
function deployBot(room: Room): void {
  const bot = room.bot
  if (bot === null) return
  const status = room.state.status
  if (status.kind !== 'setup' || status.submitted[bot.color]) return

  let assignment: Record<PieceId, Rank>
  try {
    assignment = bot.policy.deploy(botView(room, bot), bot.color, bot.deployRng)
    const problem = validateAssignment(assignment, bot.color, room.state)
    if (problem !== null) throw new Error(problem)
  } catch (error) {
    log.error(
      `BOT FAILURE game=${room.id} policy=${bot.name} seat=${bot.color} phase=deploy: ` +
        `${describeError(error)} — falling back to a random §9 deployment`,
    )
    assignment = timeoutAssignment(room.state, bot.color)
  }

  try {
    submitRankAssignment(room, bot.color, assignment)
  } catch (error) {
    // Unreachable short of a rules-engine change: the assignment above was
    // either validated or produced by the engine's own fallback.
    log.error(
      `BOT FAILURE game=${room.id} policy=${bot.name} seat=${bot.color} phase=deploy: ` +
        `the server could not submit the deployment: ${describeError(error)}`,
    )
  }
}

/**
 * Queue the bot's reply, if it is the bot's move.
 *
 * Called from `notify`, so EVERY state change gets one look: the human's move,
 * the human's pass, a setup submission, a setup timeout, a flag fall. It is also
 * called again at the end of `takeBotTurn`, because a state change can leave it
 * the bot's turn once more and the notify from inside that turn is suppressed by
 * the `thinking` latch.
 *
 * Nothing here blocks. The delay is a timer, so the HTTP request or socket event
 * that triggered it returns immediately and the board updates with the human's
 * own move before the bot's arrives.
 */
function driveBot(room: Room): void {
  const bot = room.bot
  if (bot === null) return

  // A turn is in flight. It will re-drive itself once its broadcast is out;
  // scheduling here would let a second turn start on top of the first.
  if (bot.thinking) return

  if (bot.faulted || room.state.status.kind !== 'playing' || room.state.toMove !== bot.color) {
    clearBotTimer(room)
    return
  }

  if (bot.timer !== null) return
  bot.timer = setTimeout(() => {
    takeBotTurn(room)
  }, bot.thinkMs)
}

/**
 * One bot ply: look, choose, apply, broadcast, then look again.
 *
 * A policy returning something illegal is a SERVER error, not a player error.
 * It is logged at error level with the game, the policy and the move, and the
 * seat is then marked faulted so the room stops driving it — no substitute move,
 * no silent pass. A pass is a real ply that settles points (§7.1), so playing one
 * on the policy's behalf would quietly alter the game to hide a bug.
 */
function takeBotTurn(room: Room): void {
  const bot = room.bot
  if (bot === null) return
  bot.timer = null

  if (bot.thinking || bot.faulted) return
  if (room.state.status.kind !== 'playing') return
  if (room.state.toMove !== bot.color) return

  const ply = room.state.ply
  let chosen: Move | null = null
  bot.thinking = true
  try {
    chosen = bot.policy.move(botView(room, bot), bot.color, bot.moveRng)
    // `playMove` broadcasts on the way out; the latch above keeps that broadcast
    // from starting another turn before this one has finished.
    playMove(room, bot.color, chosen)
  } catch (error) {
    bot.faulted = true
    log.error(
      `BOT FAILURE game=${room.id} policy=${bot.name} seat=${bot.color} ply=${ply} ` +
        `move=${chosen === null ? '(none — the policy threw)' : safeNotation(chosen)}: ` +
        `${describeError(error)}${causeText(error)} — the seat has stopped playing`,
    )
  } finally {
    bot.thinking = false
  }

  // LOOP. Alternation makes two bot plies in a row impossible today, but the
  // scheduler must not depend on that: it asks the state, every time.
  driveBot(room)
}

/** `playMove` wraps the engine's complaint as `cause`; that detail stays server-side. */
function causeText(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof Error ? ` (${cause.message})` : ''
}

/**
 * Print the offending move for the log. `moveToNotation` assumes a well-formed
 * `Move`, and the whole reason we are here is that the policy handed back
 * something that may not be one — so a throw inside the error handler must not
 * replace the error being reported.
 */
function safeNotation(move: Move): string {
  try {
    return moveToNotation(move)
  } catch {
    return JSON.stringify(move)
  }
}

// ---------------------------------------------------------------- sweeping

/** Drop rooms nobody has touched in a day. Games are in memory only (techspec §0). */
export function sweep(now = Date.now()): number {
  let dropped = 0
  for (const [id, room] of rooms) {
    if (now - room.lastActivity < ROOM_TTL_MS) continue
    clearSetupTimer(room)
    clearBotTimer(room)
    room.clock.dispose()
    for (const color of COLORS) {
      const playerToken = room.playerTokens[color]
      if (playerToken !== null) tokens.delete(playerToken)
      const spectatorToken = room.spectatorTokens[color]
      if (spectatorToken !== null) tokens.delete(spectatorToken)
    }
    // every token the room minted, or the map keeps growing after the sweep
    tokens.delete(room.publicToken)
    tokens.delete(room.omniscientToken)
    rooms.delete(id)
    dropped += 1
  }
  return dropped
}

/** Test/shutdown helper: stop every timer this module owns. */
export function disposeAll(): void {
  for (const room of rooms.values()) {
    clearSetupTimer(room)
    clearBotTimer(room)
    room.clock.dispose()
  }
}
