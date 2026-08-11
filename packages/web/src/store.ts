import { create } from 'zustand'
import type { Color, Move, PieceId, Rank, Viewer, ViewerState } from '@xiyang/rules'
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

  connect: (token: string) => void
  disconnect: () => void
  clearError: () => void
  setError: (message: string) => void

  sendAssign: (assignment: Record<PieceId, Rank>) => void
  sendMove: (move: Move) => void
  sendResign: () => void
}

/** The socket lives outside the store: it is a resource, not render state. */
let socket: GameSocket | null = null

export const useStore = create<AppState>()((set, get) => ({
  token: null,
  connection: 'idle',
  view: null,
  viewAt: 0,
  error: null,

  connect: (token) => {
    if (get().token === token && socket) return
    socket?.close()
    socket = null
    set({ token, connection: 'connecting', view: null, viewAt: 0, error: null })
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
    set({ token: null, connection: 'idle', view: null, viewAt: 0 })
  },

  clearError: () => set({ error: null }),
  setError: (message) => set({ error: message }),

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

/** The colour whose seat this viewer occupies, or null for an omniscient replay. */
export function viewerColor(viewer: Viewer): Color | null {
  switch (viewer.kind) {
    case 'player':
      return viewer.color
    case 'spectator':
      return viewer.bound
    case 'replay-player':
      return viewer.color
    case 'replay-omniscient':
      return null
  }
}

/** Only a seated player may act; spectators are bound read-only views (§10). */
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
