import { useEffect, useMemo, useState } from 'react'
import type { Carrier, Color, Move, Square, ViewerState } from '@xiyang/rules'
import { Board } from '../components/Board.js'
import { EventLog } from '../components/EventLog.js'
import {
  CARRIER_LABEL,
  COLOR_LABEL,
  PROMOTION_CHOICES,
  RANK_LABEL,
} from '../constants.js'
import { colorLabel, formatClock, formatScore, resultText, squareName } from '../format.js'
import { canAct, myLegalMoves, useStore, viewerColor } from '../store.js'

/**
 * Game screen (techspec §7).
 *
 * Everything clickable here is derived from `view.legalMoves`, which the server
 * sends only to the player to move. The client computes no legality, no
 * combat forecast and no candidate-rank sets (gamebook §10) — it renders the
 * ViewerState and emits Moves.
 */

interface GameProps {
  view: ViewerState
}

/** The board-click subset of Move; castling and passing use buttons. */
type BoardMove = Extract<Move, { kind: 'move' }>

interface PendingPromotion {
  from: Square
  to: Square
  options: BoardMove[]
}

export function Game({ view }: GameProps) {
  const sendMove = useStore((s) => s.sendMove)
  const sendResign = useStore((s) => s.sendResign)
  const viewAt = useStore((s) => s.viewAt)

  const [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<PendingPromotion | null>(null)

  const me = viewerColor(view.viewer)
  const seated = canAct(view)
  const playing = view.status.kind === 'playing'
  const myTurn = seated && me === view.toMove && playing

  const moves = myLegalMoves(view)

  const movesFrom = useMemo(() => {
    const m = new Map<Square, BoardMove[]>()
    for (const mv of moves) {
      if (mv.kind !== 'move') continue
      const list = m.get(mv.from)
      if (list) list.push(mv)
      else m.set(mv.from, [mv])
    }
    return m
  }, [moves])

  const castleMoves = moves.filter((m): m is Extract<Move, { kind: 'castle' }> => m.kind === 'castle')
  const passMove = moves.find((m) => m.kind === 'pass')
  const forcedPass = moves.length === 1 && passMove !== undefined

  const selectedMoves: BoardMove[] = selected === null ? [] : (movesFrom.get(selected) ?? [])
  const targets = Array.from(new Set(selectedMoves.map((m) => m.to)))

  // clear a stale selection whenever a new position arrives
  useEffect(() => {
    setSelected(null)
    setPromotion(null)
  }, [view.ply, view.status.kind])

  // --- clock ---------------------------------------------------------------
  // The server is authoritative (techspec §5). This only interpolates the
  // running side's clock between pushes so the display does not look frozen.
  const [nowPerf, setNowPerf] = useState(() => performance.now())
  useEffect(() => {
    if (!view.config.clockEnabled || !playing) return
    const id = window.setInterval(() => setNowPerf(performance.now()), 100)
    return () => window.clearInterval(id)
  }, [view.config.clockEnabled, playing])

  const elapsed = view.config.clockEnabled && playing ? Math.max(0, nowPerf - viewAt) : 0
  const shownClock = (color: Color) =>
    Math.max(0, view.clockMs[color] - (view.toMove === color ? elapsed : 0))

  const lastEvent = view.log.length > 0 ? view.log[view.log.length - 1] : undefined
  const lastMoveSquares =
    lastEvent && lastEvent.move.kind === 'move' ? [lastEvent.move.from, lastEvent.move.to] : []

  const revealedEnemy = view.pieces.filter(
    (p) => p.color !== me && p.revealed && p.rank !== null && p.square !== null,
  )

  function play(move: Move) {
    setSelected(null)
    setPromotion(null)
    sendMove(move)
  }

  function onSquareClick(sq: Square) {
    if (promotion) return
    if (!myTurn) {
      setSelected(selected === sq ? null : sq)
      return
    }
    if (selected === sq) {
      setSelected(null)
      return
    }
    if (selected !== null) {
      const candidates = (movesFrom.get(selected) ?? []).filter((m) => m.to === sq)
      if (candidates.length === 1) {
        play(candidates[0])
        return
      }
      if (candidates.length > 1) {
        // several moves share a destination: a promotion choice (techspec §3)
        setPromotion({ from: selected, to: sq, options: candidates })
        return
      }
    }
    if (movesFrom.has(sq)) setSelected(sq)
    else setSelected(null)
  }

  function onResign() {
    if (window.confirm('確定認輸？此動作不可回復。')) sendResign()
  }

  return (
    <main className="screen screen-game">
      <header className="topbar">
        <div className="scoreboard">
          <SidePanel
            color="white"
            score={view.score.white}
            clockMs={shownClock('white')}
            clockEnabled={view.config.clockEnabled}
            toMove={playing && view.toMove === 'white'}
            isMe={me === 'white'}
          />
          <SidePanel
            color="black"
            score={view.score.black}
            clockMs={shownClock('black')}
            clockEnabled={view.config.clockEnabled}
            toMove={playing && view.toMove === 'black'}
            isMe={me === 'black'}
          />
        </div>
        <div className="meta">
          <div>
            第 {view.ply} 手 ·{' '}
            {view.status.kind === 'over'
              ? '對局結束'
              : `輪到${colorLabel(view.toMove)}${myTurn ? '（你）' : ''}`}
          </div>
          <div className="muted small">
            分數線 {view.config.scoreTarget} · 黑方貼目 +{formatScore(view.config.komi)} · 停滯{' '}
            {view.noProgressTurns}/{view.config.noProgressTurns} 回合
          </div>
        </div>
      </header>

      {view.status.kind === 'over' && (
        <div className="banner">{resultText(view.status.result)}</div>
      )}

      <div className="game-body">
        <div className="game-board">
          <Board
            pieces={view.pieces}
            orientation={me ?? 'white'}
            selected={selected}
            targets={targets}
            origins={myTurn ? Array.from(movesFrom.keys()) : []}
            lastMove={lastMoveSquares}
            onSquareClick={onSquareClick}
          />

          {promotion && (
            <div className="promotion">
              <span>升變為：</span>
              {PROMOTION_CHOICES.map((carrier) => {
                const move = promotion.options.find((m) => m.promote === carrier)
                if (!move) return null
                return (
                  <button type="button" key={carrier} onClick={() => play(move)}>
                    {CARRIER_LABEL[carrier]}
                  </button>
                )
              })}
              <button type="button" onClick={() => setPromotion(null)}>
                取消
              </button>
            </div>
          )}

          <div className="controls">
            <button
              className="primary"
              type="button"
              disabled={!myTurn || passMove === undefined}
              onClick={() => passMove && play(passMove)}
              title={
                forcedPass
                  ? '無合法移動，強制 pass — 給予增秒（§8）'
                  : '主動 pass 永遠合法，但不給增秒（§8）'
              }
            >
              {forcedPass ? '跳過（無合法移動）' : '跳過（pass）'}
            </button>
            {castleMoves.map((m) => (
              <button
                type="button"
                key={m.side}
                disabled={!myTurn}
                onClick={() => play(m)}
                title="無條件易位：雙方皆未動過且中間無子即可（規則書 §3②）"
              >
                {m.side === 'king' ? 'O-O 王翼易位' : 'O-O-O 后翼易位'}
              </button>
            ))}
            <button
              className="danger"
              type="button"
              disabled={!seated || view.status.kind === 'over'}
              onClick={onResign}
            >
              認輸
            </button>
          </div>

          <p className="muted small">
            {!seated
              ? `觀戰視角（綁定${me ? colorLabel(me) : ''}），僅供觀看。`
              : myTurn
                ? selected === null
                  ? '點一顆有亮框的棋子，再點目標格。'
                  : `已選 ${squareName(selected)} — 點目標格，或再點一次取消。`
                : playing
                  ? '等待對手行動…'
                  : ''}
          </p>
        </div>

        <aside className="game-side">
          <section className="panel">
            <h2>已翻明的敵方兵種</h2>
            {revealedEnemy.length === 0 ? (
              <p className="muted small">尚無。</p>
            ) : (
              <ul className="revealed-list">
                {revealedEnemy.map((p) => (
                  <li key={p.id}>
                    <code>{p.square !== null ? squareName(p.square) : '—'}</code>{' '}
                    <span className="muted">{carrierShort(p.carrier)}</span>{' '}
                    <strong>{p.rank ? RANK_LABEL[p.rank] : ''}</strong>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">
              本遊戲不提供推論輔助；其餘敵方兵種請自行由公開紀錄推得（規則書 §10）。
            </p>
          </section>

          <EventLog log={view.log} />
        </aside>
      </div>
    </main>
  )
}

function carrierShort(carrier: Carrier): string {
  return CARRIER_LABEL[carrier].split(' ')[0]
}

interface SidePanelProps {
  color: Color
  score: number
  clockMs: number
  clockEnabled: boolean
  toMove: boolean
  isMe: boolean
}

function SidePanel({ color, score, clockMs, clockEnabled, toMove, isMe }: SidePanelProps) {
  return (
    <div className={`side side-${color}${toMove ? ' side-active' : ''}`}>
      <div className="side-name">
        {COLOR_LABEL[color]}方{isMe ? '（你）' : ''}
      </div>
      <div className="side-score">{formatScore(score)}</div>
      <div className={clockMs < 30_000 && clockEnabled ? 'clock urgent' : 'clock'}>
        {clockEnabled ? formatClock(clockMs) : '無限'}
      </div>
    </div>
  )
}
