import { useEffect, useMemo, useRef, useState } from 'react'
import type { PieceId, Rank, Square, ViewerState } from '@xiyang/rules'
import { Board } from '../components/Board.js'
import { PieceTray } from '../components/PieceTray.js'
import { DISTRIBUTION, RANKS_IN_ORDER, RANK_LABEL } from '../constants.js'
import { colorLabel, formatCountdown, squareName } from '../format.js'
import { canAct, useStore, viewerColor } from '../store.js'

/**
 * Setup screen (techspec §7, gamebook §9). Both sides assign their 16 兵種 to
 * the 16 carriers of the standard opening position, simultaneously and
 * invisibly to each other. The assignment must be a bijection onto the
 * DISTRIBUTION table; Submit stays disabled until it is.
 *
 * The client only checks that the draft is complete and uses no rank more
 * often than the table allows — the server re-validates with
 * `validateAssignment()`, which is the authority.
 */

interface SetupProps {
  view: ViewerState
}

function emptyRemaining(): Record<Rank, number> {
  return { ...DISTRIBUTION }
}

export function Setup({ view }: SetupProps) {
  const sendAssign = useStore((s) => s.sendAssign)
  const me = viewerColor(view.viewer)
  const seated = canAct(view) && me !== null

  const [draft, setDraft] = useState<Record<PieceId, Rank>>({})
  const [selectedRank, setSelectedRank] = useState<Rank | null>(null)

  const myPieces = useMemo(
    () => view.pieces.filter((p) => p.color === me && p.square !== null),
    [view.pieces, me],
  )

  const remaining = useMemo(() => {
    const left = emptyRemaining()
    for (const id of Object.keys(draft)) {
      const rank = draft[id]
      if (rank) left[rank] -= 1
    }
    return left
  }, [draft])

  const pendingIds = useMemo(
    () => new Set(myPieces.filter((p) => !draft[p.id]).map((p) => p.id)),
    [myPieces, draft],
  )

  const overAssigned = RANKS_IN_ORDER.some((r) => remaining[r] < 0)
  const complete = pendingIds.size === 0 && myPieces.length === 16 && !overAssigned

  const submitted = view.status.kind === 'setup' ? view.status.submitted : null
  const mySubmitted = me !== null && submitted !== null ? submitted[me] : false
  const theirSubmitted =
    me !== null && submitted !== null ? submitted[me === 'white' ? 'black' : 'white'] : false

  // --- countdown -----------------------------------------------------------
  // ViewerState carries no setup start timestamp, so this is a local
  // approximation anchored at the moment this client first saw the setup
  // state. The server's timer is the authority; it auto-assigns on expiry (§0).
  const startedAt = useRef<number>(Date.now())
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  const remainingMs = view.config.setupTimeoutMs - (now - startedAt.current)

  function onSquareClick(sq: Square) {
    if (!seated || mySubmitted) return
    const piece = myPieces.find((p) => p.square === sq)
    if (!piece) return
    setDraft((prev) => {
      const next = { ...prev }
      if (selectedRank === null) {
        delete next[piece.id]
        return next
      }
      next[piece.id] = selectedRank
      return next
    })
    if (selectedRank !== null) {
      // keep the rank selected while copies remain, otherwise drop it
      const used = Object.values(draft).filter((r) => r === selectedRank).length
      const wasHolding = draft[piece.id] === selectedRank
      const after = used + (wasHolding ? 0 : 1)
      if (after >= DISTRIBUTION[selectedRank]) setSelectedRank(null)
    }
  }

  function fillRandomly() {
    const pool: Rank[] = []
    for (const rank of RANKS_IN_ORDER) {
      for (let i = 0; i < DISTRIBUTION[rank]; i++) pool.push(rank)
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const a = pool[i]
      pool[i] = pool[j]
      pool[j] = a
    }
    const next: Record<PieceId, Rank> = {}
    myPieces.forEach((p, i) => {
      const rank = pool[i]
      if (rank) next[p.id] = rank
    })
    setDraft(next)
    setSelectedRank(null)
  }

  function submit() {
    if (!complete) return
    sendAssign(draft)
  }

  return (
    <main className="screen screen-setup">
      <header className="topbar">
        <h1>佈署兵種</h1>
        <div className="topbar-right">
          <span className={remainingMs < 30_000 ? 'clock urgent' : 'clock'}>
            約 {formatCountdown(remainingMs)}
          </span>
          <span className="muted small">逾時系統自動指派</span>
        </div>
      </header>

      <div className="setup-body">
        <div className="setup-board">
          <div className="seat">
            {me ? `你執${colorLabel(me)}` : '觀看者視角'}
            {!seated && <span className="muted"> · 觀戰中，無法佈署</span>}
          </div>
          <Board
            pieces={view.pieces}
            orientation={me ?? 'white'}
            rankOverride={draft}
            pendingIds={pendingIds}
            origins={
              seated && !mySubmitted
                ? myPieces.flatMap((p) => (p.square === null ? [] : [p.square]))
                : []
            }
            onSquareClick={seated && !mySubmitted ? onSquareClick : undefined}
          />
        </div>

        <aside className="setup-side">
          {seated ? (
            <>
              <PieceTray
                remaining={remaining}
                selected={selectedRank}
                onSelect={setSelectedRank}
                disabled={mySubmitted}
              />

              <div className="setup-actions">
                <button type="button" onClick={fillRandomly} disabled={mySubmitted}>
                  隨機填滿
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft({})
                    setSelectedRank(null)
                  }}
                  disabled={mySubmitted}
                >
                  清除
                </button>
                <button className="primary" type="button" onClick={submit} disabled={!complete || mySubmitted}>
                  {mySubmitted ? '已送出' : '送出佈署'}
                </button>
              </div>

              <p className="muted small">
                {mySubmitted
                  ? theirSubmitted
                    ? '雙方皆已送出，即將開始。'
                    : '等待對手佈署…'
                  : selectedRank
                    ? `已選 ${RANK_LABEL[selectedRank]} — 點一顆自己的棋子指派。`
                    : '點兵種池中的兵種，再點自己的棋子。未選兵種時點棋子可清除。'}
              </p>
              {overAssigned && <p className="error">兵種數量超過配置表。</p>}

              <div className="assign-list panel">
                <h2>已指派 {myPieces.length - pendingIds.size} / 16</h2>
                <ul>
                  {myPieces.map((p) => (
                    <li key={p.id}>
                      <code>{p.square !== null ? squareName(p.square) : '—'}</code>{' '}
                      <span className="muted">{p.carrier}</span>{' '}
                      <strong>{draft[p.id] ? RANK_LABEL[draft[p.id]] : '未指派'}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div className="panel">
              <h2>等待雙方佈署</h2>
              <p className="muted small">
                觀戰視角綁定於邀請你的玩家，你所見與其完全相同（規則書 §10）。
              </p>
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}
