/**
 * THE security boundary. Gamebook §10.
 *
 *   「用戶端永不接收其無權查看的兵種資料——不是『收到但不顯示』。」
 *
 * `stateForViewer` is the only sanctioned way to serialise a GameState for
 * transport. Nothing else in the system may put a `GameState` on a wire.
 *
 * The construction below is deliberately shaped so that *omitting* a rank is
 * the default and *including* one is the exception: `ViewerPiece` is built
 * field by field with `rank: null`, and the rank is written in only after
 * `entitledToRank` says yes. There is no spread of `Piece` anywhere in this
 * file — a spread would silently carry `rank` (and any field added later)
 * across the boundary, which is exactly the bug this module exists to prevent.
 */

import { legalMoves } from './moves.js'
import type {
  Color,
  GameEvent,
  GameState,
  GameStatus,
  Move,
  Piece,
  Viewer,
  ViewerPiece,
  ViewerState,
} from './types.js'

/** The colour whose hidden ranks this viewer is entitled to, if any. */
export function viewerColor(v: Viewer): Color | null {
  switch (v.kind) {
    case 'player': return v.color
    case 'replay-player': return v.color
    // 現場觀戰者: "與其進入時所綁定玩家的視角完全相同" — exactly the bound
    // player's view, no more.
    case 'spectator': return v.bound
    case 'replay-omniscient': return null
  }
}

/**
 * The whole of the hidden-information policy, in one predicate.
 *
 * A rank is disclosed when, and only when:
 *   1. the viewer owns the piece,                       (§10 玩家/觀戰者)
 *   2. the piece has been 翻明,                          (§4.3)
 *   3. the viewer is the omniscient replay viewer,      (§10 回放)
 *   4. the game is over — 終局公開全部兵種.               (§10 其他)
 */
export function entitledToRank(s: GameState, v: Viewer, piece: Piece): boolean {
  if (v.kind === 'replay-omniscient') return true
  if (s.status.kind === 'over') return true
  if (piece.revealed) return true
  return piece.color === viewerColor(v)
}

function copyMove(m: Move): Move {
  switch (m.kind) {
    case 'move':
      return m.promote
        ? { kind: 'move', from: m.from, to: m.to, promote: m.promote }
        : { kind: 'move', from: m.from, to: m.to }
    case 'castle':
      return { kind: 'castle', side: m.side }
    case 'pass':
      return { kind: 'pass' }
  }
}

/**
 * Events are public by construction (techspec §3: "Everything here is visible
 * to every viewer") — every CombatOutcome variant carries only what gamebook
 * §4「翻明總表」says is announced. They are copied, not aliased, so a consumer
 * cannot reach back into the authoritative state.
 */
function copyEvent(e: GameEvent): GameEvent {
  return {
    ply: e.ply,
    color: e.color,
    move: copyMove(e.move),
    ...(e.combat
      ? {
        combat: {
          outcome: { ...e.combat.outcome },
          attackerSquare: e.combat.attackerSquare,
          defenderSquare: e.combat.defenderSquare,
          survivorSquare: e.combat.survivorSquare,
        },
      }
      : {}),
    ...(e.promoted ? { promoted: e.promoted } : {}),
    scoreAfter: { white: e.scoreAfter.white, black: e.scoreAfter.black },
  }
}

function copyStatus(st: GameStatus): GameStatus {
  switch (st.kind) {
    case 'setup':
      return { kind: 'setup', submitted: { white: st.submitted.white, black: st.submitted.black } }
    case 'playing':
      return { kind: 'playing' }
    case 'over':
      return { kind: 'over', result: { ...st.result } }
  }
}

function copyViewer(v: Viewer): Viewer {
  switch (v.kind) {
    case 'player': return { kind: 'player', color: v.color }
    case 'spectator': return { kind: 'spectator', bound: v.bound }
    case 'replay-omniscient': return { kind: 'replay-omniscient' }
    case 'replay-player': return { kind: 'replay-player', color: v.color }
  }
}

/** THE security boundary. The ONLY legal way to serialise state for transport. */
export function stateForViewer(s: GameState, v: Viewer): ViewerState {
  const pieces: ViewerPiece[] = s.pieces.map((p) => {
    // Built explicitly, never spread. Default: no rank.
    const out: ViewerPiece = {
      id: p.id,
      color: p.color,
      carrier: p.carrier,
      square: p.square,
      revealed: p.revealed,
      rank: null,
    }
    if (entitledToRank(s, v, p)) out.rank = p.rank
    return out
  })

  const vs: ViewerState = {
    id: s.id,
    pieces,
    toMove: s.toMove,
    ply: s.ply,
    score: { white: s.score.white, black: s.score.black },
    log: s.log.map(copyEvent),
    clockMs: { white: s.clockMs.white, black: s.clockMs.black },
    noProgressTurns: s.noProgressTurns,
    status: copyStatus(s.status),
    config: { ...s.config },
    viewer: copyViewer(v),
  }

  // "推論輔助不是安全邊界" (§10) — but the move list is not inference help, it
  // is the carrier layer, which both players can compute anyway. It is sent
  // only to the player who is actually on turn.
  if (v.kind === 'player' && s.status.kind === 'playing' && v.color === s.toMove) {
    vs.legalMoves = legalMoves(s, v.color)
  }

  return vs
}
