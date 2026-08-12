import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import type { Carrier, Color, Move, Rank, Square, ViewerState } from '@xiyang/rules'
import { Board } from '../components/Board.js'
import { CapturedTray } from '../components/CapturedTray.js'
import { EventLog } from '../components/EventLog.js'
import { ExportButton, ExportPanel } from '../components/ExportPanel.js'
import { PencilPanel, readDraggedRank } from '../components/PencilPanel.js'
import { RankTable } from '../components/RankTable.js'
import {
  CARRIER_LABEL,
  COLOR_LABEL,
  PROMOTION_CHOICES,
  RANK_LABEL,
} from '../constants.js'
import { colorLabel, formatClock, formatScore, resultText, squareName } from '../format.js'
import {
  canAct,
  captureRecords,
  myLegalMoves,
  pencilSeatKey,
  useStore,
  viewerColor,
} from '../store.js'

/**
 * Game screen (techspec §7).
 *
 * Everything clickable here is derived from `view.legalMoves`, which the server
 * sends only to the player to move. The client computes no legality, no
 * combat forecast and no candidate-rank sets (gamebook §10) — it renders the
 * ViewerState and emits Moves.
 *
 * Layout: move history left, board centre, captured pieces right, with the
 * static 兵種 reference under the history and the player's own pencil notepad
 * under the captured tray. The board keeps its natural size — `--sq` is a vmin
 * clamp, and the centre grid column is `min-content`, so the side columns give
 * way first and the whole thing folds to one column when it no longer fits.
 *
 * `captures` is the one derived structure this screen builds: piece id → the
 * public event that removed it, replayed off `view.log` (see `captureRecords`).
 * It is the log re-indexed, so the captured tray can put an announcement beside
 * the piece it was about. Nothing downstream turns it into a candidate set.
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

  // 玩家標記 — client-only guesses (gamebook §10). Never sent anywhere.
  const pencilMarks = useStore((s) => s.pencilMarks)
  const loadPencilMarks = useStore((s) => s.loadPencilMarks)
  const addPencilMark = useStore((s) => s.addPencilMark)
  const togglePencilMark = useStore((s) => s.togglePencilMark)
  const clearPencilMark = useStore((s) => s.clearPencilMark)
  const clearPencilMarks = useStore((s) => s.clearPencilMarks)

  const [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<PendingPromotion | null>(null)
  /** 匯出 — the record, for reading elsewhere. See ExportPanel. */
  const [exportOpen, setExportOpen] = useState(false)
  const [draggingRank, setDraggingRank] = useState<Rank | null>(null)
  /** which enemy square has the notepad popover open on the board, if any */
  const [pencilOpen, setPencilOpen] = useState<Square | null>(null)

  const me = viewerColor(view.viewer)
  const seated = canAct(view)
  const playing = view.status.kind === 'playing'
  const myTurn = seated && me === view.toMove && playing

  const moves = myLegalMoves(view)

  // The notepad belongs to THIS game AND THIS seat: two tabs of one browser are
  // two seats, and they must not share (or overwrite) one notepad.
  const seat = pencilSeatKey(view.viewer)
  useEffect(() => {
    loadPencilMarks(view.id, seat)
  }, [view.id, seat, loadPencilMarks])

  // piece id → the public event that removed it. Pure log bookkeeping; see the
  // header note and `captureRecords`.
  const captures = useMemo(() => captureRecords(view.log), [view.log])

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
    setPencilOpen(null)
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

  /**
   * Squares that accept a dropped pencil mark: enemy pieces on the board whose
   * 兵種 the payload does not carry. This is entitlement bookkeeping — which
   * pieces the player is allowed to scribble on — and says nothing about what
   * rank they hold. `rank === null` rather than `!revealed` so the final reveal
   * at game end (§10 終局公開全部兵種) retires the notepad too: once every rank
   * is a fact there is nothing left to guess at.
   *
   * Captured pieces are annotatable as well, but they have no square; the
   * captured tray and the pencil panel open their picker inline.
   */
  const pencilSquares = useMemo(() => {
    const set = new Set<Square>()
    if (me === null) return set
    for (const p of view.pieces) {
      if (p.color === me || p.square === null || p.rank !== null) continue
      set.add(p.square)
    }
    return set
  }, [view.pieces, me])

  /**
   * The popover only stays open while the square is still annotatable — a piece
   * that gets captured or 翻明 takes its notepad page with it. Derived, so the
   * state can never point at a square the board no longer offers.
   */
  const pencilOpenSquare = pencilOpen !== null && pencilSquares.has(pencilOpen) ? pencilOpen : null

  // stable identity: the board hangs document listeners off this while open
  const closePencil = useCallback(() => setPencilOpen(null), [])
  // likewise — the export panel keeps an Escape listener on the document
  const closeExport = useCallback(() => setExportOpen(false), [])
  const openExport = useCallback(() => setExportOpen(true), [])

  function play(move: Move) {
    setSelected(null)
    setPromotion(null)
    setPencilOpen(null)
    sendMove(move)
  }

  function onSquareClick(sq: Square) {
    if (promotion) return

    /*
     * Left-click routing. With one of my pieces selected the click keeps its
     * move meaning — an enemy square is a capture target and the move flow is
     * never intercepted. With nothing selected there is no move in flight, so a
     * click on an annotatable enemy piece opens the notepad instead.
     */
    if (selected === null && pencilSquares.has(sq)) {
      setPencilOpen(pencilOpen === sq ? null : sq)
      return
    }
    setPencilOpen(null)

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

  /** Right-click or long-press on an enemy piece: open the notepad popover. */
  function onPencilRequest(sq: Square) {
    if (!pencilSquares.has(sq)) return
    setPencilOpen(sq)
  }

  /** A rank chip dropped on an enemy piece: write the guess down, verbatim. */
  function onSquareDrop(sq: Square, e: DragEvent<HTMLElement>) {
    setDraggingRank(null)
    const rank = readDraggedRank(e.dataTransfer)
    if (rank === null) return
    const piece = view.pieces.find((p) => p.square === sq)
    if (piece === undefined) return
    addPencilMark(piece.id, rank)
  }

  function onResign() {
    if (window.confirm('確定認輸？此動作不可回復。')) sendResign()
  }

  return (
    <main className="screen screen-game">
      <style>{STYLE}</style>

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
        <div className="banner xy-over">
          <span>{resultText(view.status.result)}</span>
          {/* the moment the record is actually wanted — put it in the banner */}
          <ExportButton onClick={openExport} prominent />
        </div>
      )}

      <div className="xy-grid">
        {/* ---- left: the public record, then the static rules card ---- */}
        <div className="xy-col xy-col-left">
          <EventLog log={view.log} />
          <RankTable />
        </div>

        {/* ---- centre: the board ---- */}
        <div className="xy-col xy-col-board">
          <Board
            pieces={view.pieces}
            orientation={me ?? 'white'}
            selected={selected}
            targets={targets}
            origins={myTurn ? Array.from(movesFrom.keys()) : []}
            lastMove={lastMoveSquares}
            pencilMarks={pencilMarks}
            pencilTargets={pencilSquares}
            pencilOpen={pencilOpenSquare}
            onPencilRequest={onPencilRequest}
            onPencilClose={closePencil}
            onPencilToggle={togglePencilMark}
            onPencilClearPiece={clearPencilMark}
            dropTargets={draggingRank ? pencilSquares : undefined}
            dragActive={draggingRank !== null}
            onSquareClick={onSquareClick}
            onSquareDrop={onSquareDrop}
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
            {/* always available: the record is readable mid-game too — it is
                the public log, which both sides already have (規則書 §10) */}
            <ExportButton onClick={openExport} />
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

          {me !== null && (
            <p className="muted small">
              右鍵或長按敵方棋子可寫下猜測（未選取自己棋子時，左鍵點擊亦可）。已離場的棋子在「已離場棋子」面板按「標記」即可標。一顆棋子可標多個兵種；系統不驗證、不推論。
            </p>
          )}
        </div>

        {/* ---- right: what has left the board, what is known, what is guessed ---- */}
        <div className="xy-col xy-col-right">
          <CapturedTray
            pieces={view.pieces}
            me={me}
            captures={captures}
            marks={pencilMarks}
            onToggleMark={togglePencilMark}
            onClearMark={clearPencilMark}
          />

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

          <PencilPanel
            pieces={view.pieces}
            me={me}
            marks={pencilMarks}
            captures={captures}
            onAdd={addPencilMark}
            onToggle={togglePencilMark}
            onClear={clearPencilMark}
            onClearAll={clearPencilMarks}
            onOpenPicker={(sq) => setPencilOpen(sq)}
            onDragRankStart={(rank) => setDraggingRank(rank)}
            onDragRankEnd={() => setDraggingRank(null)}
          />
        </div>
      </div>

      {/*
       * Handed the ViewerState this screen already renders. It is the redacted
       * one (stateForViewer, 規則書 §10) — no fetch, no server call, nothing
       * re-derived, which is exactly what makes exporting it safe.
       */}
      {exportOpen && <ExportPanel view={view} onClose={closeExport} />}
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

/**
 * Scoped to this screen. The shared stylesheet is owned elsewhere, so the
 * three-column shell lives here under an `xy-` prefix.
 */
const STYLE = `
.screen.screen-game { max-width: 1560px; }
/* the result banner also carries the export button once the game is over */
.screen-game .banner.xy-over {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.xy-grid {
  display: grid;
  /* the centre column is min-content: it is exactly the board's natural width,
     so the side columns are what give way when the viewport tightens. */
  grid-template-columns: minmax(240px, 400px) min-content minmax(240px, 400px);
  align-items: start;
  justify-content: center;
  gap: 18px;
}
.xy-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.xy-col > .panel { margin: 0; }
.xy-col-board { justify-self: center; }
.xy-col-board .controls { margin-top: 0; }
.xy-col-board > p { margin: 0; }
@media (max-width: 1180px) {
  .xy-grid {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
  .xy-col { width: 100%; max-width: 620px; }
  .xy-col-board { order: -1; }
}
`
