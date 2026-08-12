import { useState } from 'react'
import type { Dispatch, DragEvent, ReactNode, SetStateAction } from 'react'
import type { Color, PieceId, Rank, Square, ViewerPiece } from '@xiyang/rules'
import { CARRIER_GLYPH, CARRIER_LABEL, RANKS_IN_ORDER, RANK_LABEL } from '../constants.js'
import { squareName } from '../format.js'
import type { CaptureRecord } from '../store.js'

/**
 * 玩家標記 — pencil marks (gamebook §10).
 *
 * A notepad beside the board. The player writes GUESSES onto an enemy piece;
 * the system writes nothing. Four properties are load-bearing and must survive
 * every future edit of this file:
 *
 *   1. NO VALIDATION, NO INFERENCE. Every one of the eleven ranks is offered on
 *      every piece, always. The same rank may be pencilled onto five pieces at
 *      once. A mark may contradict a revealed fact or the §2 counts. Nothing is
 *      warned about, filtered, crossed out, or counted down. The moment this
 *      panel checks a mark against what is known, it becomes a solver and
 *      gamebook §10 forbids that for players. The restraint IS the feature.
 *   2. A SET PER PIECE. The information in this game is almost never a single
 *      name — surviving a bomb means 工兵 OR 軍旗 — so a piece carries any
 *      subset of the eleven, including contradictory ones.
 *   3. CLIENT ONLY. Marks live in localStorage via the store and never enter a
 *      socket payload. They are not part of the redaction layer.
 *   4. VISUALLY DISTINCT FROM FACT. A mark is dashed and italic; a 系統翻明
 *      rank is solid gold. A guess must never read as a fact.
 *
 * This panel is the OVERVIEW and the bulk eraser, in two sections:
 *
 *   · 存活 — enemy pieces still on the board. Ticking individual ranks happens
 *     on the board itself (right-click / long-press / left-click with nothing
 *     selected); 「標記」 here opens that same popover.
 *   · 已離場 — captured pieces. They have no square, so there is nothing on the
 *     board to click; 「標記」 opens the picker inline, in the row.
 *
 * Both sections are listed so 全部清除 visibly reaches everything.
 *
 * A piece gets a row when it is an ENEMY piece whose 兵種 the payload does not
 * carry (`rank === null`). That is one entitlement test covering every case:
 * your own ranks you already know, a 系統翻明 piece is a fact, and at game end
 * the server discloses everything, at which point nothing needs guessing at.
 * Entitlement is about which pieces are annotatable — never a deduction about
 * which rank they hold.
 */

export interface PencilPanelProps {
  pieces: readonly ViewerPiece[]
  /** the seat this viewer occupies; no seat, no enemy, no notepad */
  me: Color | null
  marks: Readonly<Record<PieceId, readonly Rank[]>>
  /**
   * piece id → the public event that removed it. Used ONLY to label a captured
   * row with the ply it left on, so two dead knights are told apart. Nothing is
   * derived from it here.
   */
  captures?: ReadonlyMap<PieceId, CaptureRecord>
  /** a dropped rank chip: add it to the piece's set */
  onAdd: (pieceId: PieceId, rank: Rank) => void
  /** click an existing chip to rub that one rank out */
  onToggle: (pieceId: PieceId, rank: Rank) => void
  /** erase every mark on one piece */
  onClear: (pieceId: PieceId) => void
  onClearAll: () => void
  /** open the board popover on this piece (living pieces only) */
  onOpenPicker?: (square: Square) => void
  /** a rank chip left the palette — the screen may light up drop targets */
  onDragRankStart?: (rank: Rank) => void
  onDragRankEnd?: () => void
}

const DRAG_TYPE = 'text/plain'
const DRAG_PREFIX = 'xiyang-rank:'
const RANK_SET: ReadonlySet<string> = new Set<string>(RANKS_IN_ORDER)

/**
 * The drag payload protocol, shared with whoever hosts the board. A rank name
 * is a string in a DataTransfer and nothing more; reading it back is a parse,
 * not a decision about the position.
 */
export function readDraggedRank(dt: DataTransfer): Rank | null {
  const raw = dt.getData(DRAG_TYPE)
  const value = raw.startsWith(DRAG_PREFIX) ? raw.slice(DRAG_PREFIX.length) : ''
  return RANK_SET.has(value) ? (value as Rank) : null
}

/** Enemy, and the payload carries no 兵種 for it — see the header note. */
export function isAnnotatable(piece: ViewerPiece, me: Color | null): boolean {
  return me !== null && piece.color !== me && piece.rank === null
}

interface Row {
  piece: ViewerPiece
  /** null once the piece has left the board */
  square: Square | null
  /** how the row identifies its piece: the square, or the ply it left on */
  label: string
}

export function PencilPanel({
  pieces,
  me,
  marks,
  captures,
  onAdd,
  onToggle,
  onClear,
  onClearAll,
  onOpenPicker,
  onDragRankStart,
  onDragRankEnd,
}: PencilPanelProps) {
  const [dragOver, setDragOver] = useState<PieceId | null>(null)
  /** which captured row has its inline picker open, if any */
  const [openId, setOpenId] = useState<PieceId | null>(null)

  if (me === null) return null

  const living: Row[] = []
  const dead: Row[] = []
  for (const p of pieces) {
    if (!isAnnotatable(p, me)) continue
    if (p.square !== null) {
      living.push({ piece: p, square: p.square, label: squareName(p.square) })
    } else {
      const rec = captures?.get(p.id)
      dead.push({
        piece: p,
        square: null,
        // Which ply removed it, straight from the log. Never why, never what.
        label: rec ? `第 ${rec.ply} 手` : '已離場',
      })
    }
  }
  living.sort((a, b) => (a.square ?? 0) - (b.square ?? 0))
  dead.sort((a, b) => {
    const pa = captures?.get(a.piece.id)?.ply ?? Number.MAX_SAFE_INTEGER
    const pb = captures?.get(b.piece.id)?.ply ?? Number.MAX_SAFE_INTEGER
    return pa !== pb ? pa - pb : a.piece.id.localeCompare(b.piece.id)
  })

  const rowIds = new Set([...living, ...dead].map((r) => r.piece.id))
  const byId = new Map<PieceId, ViewerPiece>(pieces.map((p) => [p.id, p]))
  // Marks on pieces that are in neither section above — a piece since 翻明, or a
  // note left by an older build. They are kept, never auto-erased (§10 forbids
  // the system rubbing a mark out); they are listed so the player can tidy up
  // their own notes if they want to, and so 全部清除 is honest about its reach.
  const other = Object.keys(marks).filter((id) => !rowIds.has(id) && (marks[id]?.length ?? 0) > 0)
  const pieceCount = Object.keys(marks).filter((id) => (marks[id]?.length ?? 0) > 0).length
  const markCount = Object.values(marks).reduce((n, list) => n + list.length, 0)

  const rowProps = {
    marks,
    dragOver,
    setDragOver,
    onAdd,
    onToggle,
    onClear,
  }

  return (
    <>
      <style>{STYLE}</style>
      <section className="panel xy-pencil">
        <h2>我的標記（猜測）</h2>
        <p className="muted small xy-pencil-note">
          自己寫的便條紙。一顆棋子可以同時標好幾個兵種——擋下爆裂物的那顆就是「工兵或軍旗」。系統不驗證、不推論、不過濾、不代為計數，你可以把同一個兵種標在五顆棋子上，也可以標得跟事實相反（規則書
          §10）。標記只存在這台裝置，永不送出。
        </p>
        <p className="muted small xy-pencil-note">
          在棋盤上<strong>右鍵</strong>（或長按）敵方棋子即可開啟標記選單；未選取自己棋子時，左鍵點擊也可以。已離場的棋子沒有格子可點，改由下方或「已離場棋子」面板標記。
        </p>

        <div className="xy-pencil-pool" role="group" aria-label="兵種標記，可拖到下方棋子">
          {RANKS_IN_ORDER.map((rank) => (
            <span
              key={rank}
              className="xy-pencil-chip"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, `${DRAG_PREFIX}${rank}`)
                e.dataTransfer.effectAllowed = 'copy'
                onDragRankStart?.(rank)
              }}
              onDragEnd={() => {
                setDragOver(null)
                onDragRankEnd?.()
              }}
              title={`把「${RANK_LABEL[rank]}」拖到棋盤上的敵方棋子，或拖到下方清單`}
            >
              {RANK_LABEL[rank]}
            </span>
          ))}
        </div>

        <div className="muted small xy-pencil-section">存活・未翻明</div>
        {living.length === 0 ? (
          <p className="muted small xy-pencil-empty">目前沒有可標記的存活敵方棋子。</p>
        ) : (
          <ul className="xy-pencil-list">
            {living.map((row) => {
              const sq = row.square
              return (
                <li key={row.piece.id} className="xy-pencil-entry">
                  <PencilRow
                    row={row}
                    {...rowProps}
                    action={
                      onOpenPicker && sq !== null ? (
                        <button
                          type="button"
                          className="xy-pencil-edit"
                          onClick={() => onOpenPicker(sq)}
                          title="在棋盤上開啟標記選單"
                          aria-label={`編輯 ${row.label} 的標記`}
                        >
                          標記
                        </button>
                      ) : null
                    }
                  />
                </li>
              )
            })}
          </ul>
        )}

        <div className="muted small xy-pencil-section">已離場</div>
        {dead.length === 0 ? (
          <p className="muted small xy-pencil-empty">尚無已離場且兵種未公開的敵方棋子。</p>
        ) : (
          <ul className="xy-pencil-list">
            {dead.map((row) => {
              const open = openId === row.piece.id
              return (
                <li key={row.piece.id} className="xy-pencil-entry">
                  <PencilRow
                    row={row}
                    {...rowProps}
                    action={
                      <button
                        type="button"
                        className={open ? 'xy-pencil-edit xy-pencil-edit-on' : 'xy-pencil-edit'}
                        aria-expanded={open}
                        onClick={() => setOpenId(open ? null : row.piece.id)}
                        aria-label={`編輯 ${row.label} 離場棋子的標記`}
                      >
                        標記
                      </button>
                    }
                  />
                  {open && (
                    <RankPicker
                      title={`${row.label}離場 · ${short(row.piece.carrier)}`}
                      marks={marks[row.piece.id] ?? []}
                      onToggle={(rank) => onToggle(row.piece.id, rank)}
                      onClear={() => onClear(row.piece.id)}
                      onClose={() => setOpenId(null)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {other.length > 0 && (
          <div className="xy-pencil-stale">
            {/* Not a claim about those pieces — only that they are in neither
                section above. The system never says what became of them. */}
            <div className="muted small xy-pencil-section">其他標記（標記保留）</div>
            <ul className="xy-pencil-list">
              {other.map((id) => {
                const list = marks[id] ?? []
                const piece = byId.get(id)
                const where =
                  piece === undefined
                    ? id
                    : piece.square !== null
                      ? squareName(piece.square)
                      : `${short(piece.carrier)}（不在盤上）`
                return (
                  <li key={id} className="xy-pencil-row">
                    <code className="xy-pencil-sq xy-pencil-sq-wide">{where}</code>
                    {piece && (
                      <span
                        className={`piece ${
                          piece.color === 'white' ? 'piece-white' : 'piece-black'
                        }`}
                      >
                        <span className="glyph">{CARRIER_GLYPH[piece.carrier]}</span>
                      </span>
                    )}
                    <MarkChips marks={list} label={where} onRemove={(rank) => onToggle(id, rank)} />
                    <button
                      type="button"
                      className="xy-pencil-x"
                      onClick={() => onClear(id)}
                      title="清除這個標記"
                      aria-label="清除這個標記"
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <div className="xy-pencil-foot">
          <button type="button" disabled={markCount === 0} onClick={onClearAll}>
            全部清除
          </button>
          <span className="muted small">
            {pieceCount} 顆棋子 · {markCount} 個標記
          </span>
        </div>
      </section>
    </>
  )
}

interface PencilRowProps {
  row: Row
  marks: Readonly<Record<PieceId, readonly Rank[]>>
  dragOver: PieceId | null
  setDragOver: Dispatch<SetStateAction<PieceId | null>>
  onAdd: (pieceId: PieceId, rank: Rank) => void
  onToggle: (pieceId: PieceId, rank: Rank) => void
  onClear: (pieceId: PieceId) => void
  /** the per-row edit affordance: board popover for living, inline for dead */
  action: ReactNode
}

/** One notepad line. Accepts a dropped rank chip; never reads anything into it. */
function PencilRow({
  row,
  marks,
  dragOver,
  setDragOver,
  onAdd,
  onToggle,
  onClear,
  action,
}: PencilRowProps) {
  const { piece, label } = row
  const list = marks[piece.id] ?? []

  return (
    <div
      className={`xy-pencil-row${dragOver === piece.id ? ' xy-pencil-over' : ''}`}
      onDragOver={(e: DragEvent<HTMLElement>) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (dragOver !== piece.id) setDragOver(piece.id)
      }}
      onDragLeave={() => setDragOver((id) => (id === piece.id ? null : id))}
      onDrop={(e: DragEvent<HTMLElement>) => {
        e.preventDefault()
        setDragOver(null)
        const rank = readDraggedRank(e.dataTransfer)
        if (rank) onAdd(piece.id, rank)
      }}
    >
      <code className="xy-pencil-sq">{label}</code>
      <span className={`piece ${piece.color === 'white' ? 'piece-white' : 'piece-black'}`}>
        <span className="glyph">{CARRIER_GLYPH[piece.carrier]}</span>
      </span>
      <span className="muted small xy-pencil-carrier">{short(piece.carrier)}</span>

      <MarkChips marks={list} label={label} onRemove={(rank) => onToggle(piece.id, rank)} />

      {action}

      <button
        type="button"
        className="xy-pencil-x"
        disabled={list.length === 0}
        onClick={() => onClear(piece.id)}
        title="清除這顆棋子的標記"
        aria-label={`清除 ${label} 的標記`}
      >
        ×
      </button>
    </div>
  )
}

export interface RankPickerProps {
  /** what the picker is attached to, for the header and the screen reader */
  title: string
  marks: readonly Rank[]
  onToggle: (rank: Rank) => void
  onClear: () => void
  onClose?: () => void
}

/**
 * The notepad grid, inline. ALL ELEVEN RANKS, ALWAYS, on every annotatable
 * piece — nothing is filtered, greyed, crossed out or counted, and no
 * combination is refused. Tick 司令 on five pieces if you like; the system has
 * no opinion (gamebook §10). That restraint is the whole point.
 *
 * The board has its own anchored popover for living pieces; this one is for the
 * pieces that no longer have a square to anchor to, and is shared by the pencil
 * panel and the captured tray. It carries its own <style> so it renders
 * correctly wherever it is mounted.
 */
export function RankPicker({ title, marks, onToggle, onClear, onClose }: RankPickerProps) {
  const on = new Set<Rank>(marks)
  return (
    <>
      <style>{PICKER_STYLE}</style>
      <div className="xy-pick" role="group" aria-label={`${title} 的標記`}>
        <div className="xy-pick-head">
          <span className="muted small">{title}</span>
          {onClose && (
            <button
              type="button"
              className="xy-pick-close"
              onClick={onClose}
              aria-label="關閉標記選單"
              title="關閉"
            >
              ×
            </button>
          )}
        </div>
        <div className="xy-pick-grid">
          {RANKS_IN_ORDER.map((rank) => {
            const ticked = on.has(rank)
            return (
              <button
                type="button"
                key={rank}
                className={ticked ? 'xy-pick-rank xy-pick-on' : 'xy-pick-rank'}
                aria-pressed={ticked}
                onClick={() => onToggle(rank)}
              >
                {RANK_LABEL[rank]}
              </button>
            )
          })}
        </div>
        <div className="xy-pick-foot">
          <button
            type="button"
            className="xy-pick-clear"
            disabled={marks.length === 0}
            onClick={onClear}
          >
            清除
          </button>
          <span className="muted small">自己的猜測，系統不驗證、不推論</span>
        </div>
      </div>
    </>
  )
}

interface MarkChipsProps {
  marks: readonly Rank[]
  label: string
  onRemove: (rank: Rank) => void
}

/** The player's own handwriting, one chip per guess. Click a chip to rub it out. */
function MarkChips({ marks, label, onRemove }: MarkChipsProps) {
  if (marks.length === 0) return <span className="xy-mark xy-mark-empty">未標記</span>
  return (
    <span className="xy-marks">
      {marks.map((rank) => (
        <button
          key={rank}
          type="button"
          className="xy-mark xy-mark-chip"
          onClick={() => onRemove(rank)}
          title={`移除「${RANK_LABEL[rank]}」`}
          aria-label={`移除 ${label} 的標記 ${RANK_LABEL[rank]}`}
        >
          {RANK_LABEL[rank]}
        </button>
      ))}
    </span>
  )
}

function short(carrier: ViewerPiece['carrier']): string {
  return CARRIER_LABEL[carrier].split(' ')[0]
}

/**
 * Shared by the pencil panel and the captured tray, so it lives apart from the
 * panel's own STYLE and travels with `RankPicker`.
 */
export const PICKER_STYLE = `
.xy-pick {
  margin: 4px 0 8px;
  padding: 7px;
  border: 1px dashed var(--accent);
  border-radius: 7px;
  background: rgba(110, 193, 255, 0.06);
}
.xy-pick-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}
.xy-pick-close {
  margin-left: auto;
  padding: 0 6px;
  line-height: 1.3;
  background: transparent;
  border: 0;
}
.xy-pick-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}
.xy-pick-rank {
  font-size: 0.82rem;
  padding: 4px 2px;
  border: 1px dashed var(--line);
  border-radius: 5px;
  white-space: nowrap;
}
.xy-pick-on {
  border: 1px dashed var(--accent);
  color: var(--accent);
  background: rgba(110, 193, 255, 0.16);
  font-style: italic;
}
.xy-pick-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
.xy-pick-clear { font-size: 0.8rem; padding: 3px 9px; }
`

const STYLE = `
.xy-pencil-note { margin: 0 0 8px; }
.xy-pencil-pool {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}
.xy-pencil-chip {
  font-size: 0.78rem;
  padding: 2px 6px;
  border: 1px dashed var(--accent);
  border-radius: 5px;
  color: var(--accent);
  background: rgba(110, 193, 255, 0.08);
  cursor: grab;
  user-select: none;
}
.xy-pencil-chip:active { cursor: grabbing; }
.xy-pencil-section {
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
  margin: 10px 0 4px;
}
.xy-pencil-empty { margin: 0; }
.xy-pencil-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 34vh;
  overflow: auto;
}
.xy-pencil-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}
.xy-pencil-entry { list-style: none; }
.xy-pencil-over {
  background: rgba(110, 193, 255, 0.14);
  outline: 1px dashed var(--accent);
}
.xy-pencil-sq {
  font-size: 0.8rem;
  color: var(--muted);
  min-width: 2.1em;
  white-space: nowrap;
}
.xy-pencil-sq-wide {
  min-width: 2.1em;
  overflow-wrap: anywhere;
}
.xy-pencil .glyph { font-size: 1.15rem; }
.xy-pencil-carrier { min-width: 2.4em; }
.xy-marks {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
  margin-left: auto;
}
.xy-mark {
  font-size: 0.78rem;
  font-style: italic;
  padding: 1px 5px;
  border: 1px dashed var(--accent);
  border-radius: 4px;
  color: var(--accent);
  white-space: nowrap;
}
.xy-mark-empty {
  border-color: transparent;
  color: var(--muted);
  font-style: normal;
  margin-left: auto;
}
.xy-mark-chip {
  background: rgba(110, 193, 255, 0.08);
  line-height: 1.3;
  cursor: pointer;
}
.xy-mark-chip:hover { text-decoration: line-through; }
.xy-pencil-edit {
  font-size: 0.76rem;
  padding: 2px 7px;
}
.xy-pencil-edit-on {
  border-color: var(--accent);
  color: var(--accent);
}
.xy-pencil-x {
  padding: 1px 7px;
  line-height: 1.2;
}
.xy-pencil-stale { margin-top: 8px; }
.xy-pencil-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.xy-pencil-foot button { font-size: 0.82rem; padding: 4px 10px; }
`
