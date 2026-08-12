import { io, type Socket } from 'socket.io-client'
import type { Move, PieceId, Rank, ViewerState } from '@xiyang/rules'

/**
 * Client transport (techspec §5). The socket carries exactly four outbound
 * events and two inbound ones. Every inbound `state` was produced by the
 * server's `stateForViewer()` — the client never sees a rank it is not
 * entitled to, so there is nothing to filter here.
 */

export interface ServerToClientEvents {
  state: (s: ViewerState) => void
  error: (e: { message: string }) => void
}

export interface ClientToServerEvents {
  join: (p: { token: string }) => void
  assign: (p: { assignment: Record<PieceId, Rank> }) => void
  move: (p: { move: Move }) => void
  resign: (p: Record<string, never>) => void
}

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface GameSocketHandlers {
  onState: (s: ViewerState) => void
  onError: (message: string) => void
  onOpen: () => void
  onClose: () => void
}

/**
 * Connects to the same origin. In dev, Vite proxies `/socket.io` through to
 * the Fastify server; in production the server serves this build itself, so a
 * same-origin connection is correct in both cases (techspec §8).
 */
export function connectGame(token: string, handlers: GameSocketHandlers): GameSocket {
  const socket: GameSocket = io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  })

  // `join` is re-sent on every (re)connect: on reconnect the server replies
  // with a fresh state for this viewer (gamebook §10 — 重連時重送的是該觀看者
  // 視角的狀態).
  socket.on('connect', () => {
    socket.emit('join', { token })
    handlers.onOpen()
  })
  socket.on('disconnect', () => handlers.onClose())
  socket.on('connect_error', (err: Error) => handlers.onError(err.message || '連線失敗'))
  socket.on('state', (s) => handlers.onState(s))
  socket.on('error', (e) => handlers.onError(e?.message ?? '未知錯誤'))

  return socket
}

export interface CreatedGame {
  gameId: string
  hostToken: string
  guestUrl: string
  hostUrl: string
  hostColor: 'white' | 'black'
  guestColor: 'white' | 'black'
  /** what the server actually built — may differ from what was requested */
  setupTimeoutMs?: number
  scoreTarget?: number
  noProgressTurns?: number
  clockEnabled?: boolean
  scoringSquares?: readonly number[]
}

// POST /api/game lives in Create.tsx (postCreateGame), which sends the config
// body the creation form builds. Only the CreatedGame type is shared from here.
