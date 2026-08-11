import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { Color, PieceId, Rank, Square, ViewerState } from '@xiyang/rules'
import { Board } from '../components/Board.js'
import { PieceTray } from '../components/PieceTray.js'
import { DISTRIBUTION, RANKS_IN_ORDER, RANK_LABEL } from '../constants.js'
import { colorLabel, formatCountdown } from '../format.js'
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
 *
 * Layout is a single centred column: board on top, 兵種池 underneath. The pool
 * is the progress display — every chip carries its own remaining count and a
 * spent rank greys out — so there is no separate 已指派 tally restating it.
 *
 * Two assignment paths, both live at once:
 *   · drag a rank chip onto one of your pieces (mouse), and
 *   · click a chip then click a piece (touch, where HTML5 drag does not exist).
 */

interface SetupProps {
  view: ViewerState
}

/**
 * What is being dragged. Same-document drag, so component state is the payload
 * and the DataTransfer only carries a human-readable label for interop — that
 * sidesteps the browsers that restrict custom MIME types, and the drop can
 * never be fed by a drag that started outside this page (`dropTargets` is empty
 * unless we started the drag ourselves).
 */
interface DragPayload {
  rank: Rank
  /** the piece the rank is being taken from, or null when it came from the pool */
  fromId: PieceId | null
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
  const [drag, setDrag] = useState<DragPayload | null>(null)

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

  const editable = seated && !mySubmitted

  // Whose 兵種 this viewer is entitled to during setup: their own if seated,
  // otherwise the side a spectator token is bound to. Used to decide whether the
  // board may show authoritative ranks yet — see rankOverride below.
  const boundColor: Color | null =
    me ?? (view.viewer.kind === 'spectator' ? view.viewer.bound : null)
  const boundSubmitted = boundColor !== null && submitted !== null ? submitted[boundColor] : false

  const mySquares = useMemo(
    () => myPieces.flatMap((p) => (p.square === null ? [] : [p.square])),
    [myPieces],
  )

  /** only my own 16 pieces accept a drop, and only while I am the one dragging */
  const dropTargets = useMemo(
    () => (editable && drag !== null ? new Set<Square>(mySquares) : new Set<Square>()),
    [editable, drag, mySquares],
  )

  /** a piece can be picked up only once it actually holds a draft rank */
  const dragSources = useMemo(() => {
    if (!editable) return new Set<Square>()
    const out = new Set<Square>()
    for (const p of myPieces) if (p.square !== null && draft[p.id]) out.add(p.square)
    return out
  }, [editable, myPieces, draft])

  // --- countdown -----------------------------------------------------------
  // The server sends an absolute deadline, so a client joining an invite late
  // sees the real remaining time. Falling back to a mount-anchored estimate
  // would show a guest a full timer while the server auto-assigns early.
  const mountedAt = useRef<number>(Date.now())
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  const remainingMs =
    view.setupDeadlineMs !== undefined
      ? view.setupDeadlineMs - now
      : view.config.setupTimeoutMs - (now - mountedAt.current)

  function onSquareClick(sq: Square) {
    if (!editable) return
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

  // --- drag and drop -------------------------------------------------------

  function beginDrag(payload: DragPayload, e: DragEvent<HTMLElement>) {
    setDrag(payload)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', RANK_LABEL[payload.rank])
  }

  function onRankDragStart(rank: Rank, e: DragEvent<HTMLElement>) {
    if (!editable) {
      e.preventDefault()
      return
    }
    setSelectedRank(null)
    beginDrag({ rank, fromId: null }, e)
  }

  function onPieceDragStart(sq: Square, e: DragEvent<HTMLElement>) {
    const piece = myPieces.find((p) => p.square === sq)
    const rank = piece ? draft[piece.id] : undefined
    if (!editable || !piece || !rank) {
      e.preventDefault()
      return
    }
    beginDrag({ rank, fromId: piece.id }, e)
  }

  /** Drop onto one of my pieces: assign, and swap or displace whatever was there. */
  function onSquareDrop(sq: Square) {
    const payload = drag
    setDrag(null)
    if (!editable || !payload) return
    const target = myPieces.find((p) => p.square === sq)
    if (!target || target.id === payload.fromId) return
    setDraft((prev) => {
      const next = { ...prev }
      // whatever the target held goes back to the pool, or straight to the
      // source piece when this was a board-to-board move (a swap)
      const displaced = next[target.id]
      next[target.id] = payload.rank
      if (payload.fromId !== null) {
        if (displaced) next[payload.fromId] = displaced
        else delete next[payload.fromId]
      }
      return next
    })
  }

  /** Drop back onto the pool: the piece loses its rank. */
  function onPoolDrop() {
    const payload = drag
    setDrag(null)
    if (!editable || !payload || payload.fromId === null) return
    const fromId = payload.fromId
    setDraft((prev) => {
      const next = { ...prev }
      delete next[fromId]
      return next
    })
  }

  function fillRandomly() {
    const pool: Rank[] = []
    for (const rank of RANKS_IN_ORDER) {
      for (let i = 0; i < DISTRIBUTION[rank]; i++) pool.push(rank)
    }
    // CSPRNG, matching the server's own shuffle (rooms.ts randomAssignment).
    // This draws a hidden army; a predictable one is the same failure as a
    // published one, and Math.random() is predictable from a handful of outputs.
    const draw = (bound: number): number => {
      const buf = new Uint32Array(1)
      const limit = Math.floor(0x1_0000_0000 / bound) * bound
      let v: number
      do {
        crypto.getRandomValues(buf)
        v = buf[0] as number
      } while (v >= limit) // reject the tail so the modulo stays uniform
      return v % bound
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = draw(i + 1)
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

      <div className="setup-stack">
        <div className="seat">
          {me ? `你執${colorLabel(me)}` : '觀看者視角'}
          {!seated && <span className="muted"> · 觀戰中，無法佈署</span>}
        </div>

        <Board
          pieces={view.pieces}
          orientation={me ?? 'white'}
          /*
           * The draft only overrides the board while it is still a draft. Once
           * submitted (or for a spectator, who never had one) the override is
           * dropped so the board falls through to `piece.rank` — the ranks the
           * payload already carries — instead of painting every own piece 「？」.
           */
          /*
           * A side that has NOT deployed still carries the server's placeholder
           * assignment in the payload, so falling through to `piece.rank` here
           * paints a whole fabricated army in fact styling — which a spectator
           * bound to that side would read as their real deployment. gamebook §10
           * forbids a guess ever being mistaken for a fact, and a placeholder is
           * worse than a guess. An empty override shows nothing until the side
           * actually deploys.
           */
          rankOverride={editable ? draft : boundSubmitted ? undefined : {}}
          pendingIds={editable ? pendingIds : undefined}
          origins={editable ? mySquares : []}
          dragSources={dragSources}
          dropTargets={dropTargets}
          dragActive={drag !== null}
          onSquareClick={editable ? onSquareClick : undefined}
          onSquareDragStart={editable ? onPieceDragStart : undefined}
          onSquareDragEnd={editable ? () => setDrag(null) : undefined}
          onSquareDrop={editable ? onSquareDrop : undefined}
        />

        {seated ? (
          <div className="setup-pool">
            <p className="muted small setup-hint">
              {mySubmitted
                ? theirSubmitted
                  ? '雙方皆已送出，即將開始。'
                  : '等待對手佈署…'
                : drag
                  ? `拖曳中 ${RANK_LABEL[drag.rank]} — 放到自己的棋子上${
                      drag.fromId ? '，或放回兵種池以清除' : ''
                    }。`
                  : selectedRank
                    ? `已選 ${RANK_LABEL[selectedRank]} — 點一顆自己的棋子指派。`
                    : '拖曳兵種到自己的棋子上；或點兵種再點棋子。把棋子拖回兵種池即清除。'}
            </p>

            <PieceTray
              remaining={remaining}
              selected={selectedRank}
              onSelect={setSelectedRank}
              disabled={mySubmitted}
              onRankDragStart={onRankDragStart}
              onRankDragEnd={() => setDrag(null)}
              onPoolDrop={onPoolDrop}
              poolDropActive={drag !== null && drag.fromId !== null}
            />

            {overAssigned && <p className="error">兵種數量超過配置表。</p>}

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
              <button
                className="primary"
                type="button"
                onClick={submit}
                disabled={!complete || mySubmitted}
              >
                {mySubmitted ? '已送出' : '送出佈署'}
              </button>
            </div>
          </div>
        ) : (
          <div className="setup-pool">
            <div className="panel">
              <h2>等待雙方佈署</h2>
              <p className="muted small">
                觀戰視角綁定於邀請你的玩家，你所見與其完全相同（規則書 §10）。
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
