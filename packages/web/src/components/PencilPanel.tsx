import { useState } from 'react'
import type { Color, PieceId, Rank, Square, ViewerPiece } from '@xiyang/rules'
import { CARRIER_GLYPH, CARRIER_LABEL, RANKS_IN_ORDER, RANK_LABEL } from '../constants.js'
import { squareName } from '../format.js'

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
 * This panel is the OVERVIEW and the bulk eraser. Ticking individual ranks
 * happens on the board itself (right-click / long-press / left-click with
 * nothing selected); 「標記」 here opens that same popover.
 *
 * Only enemy pieces that are ON the board and NOT revealed get a row: a revealed
 * piece is a fact, and your own ranks you already know. That is an entitlement
 * question about which pieces are annotatable, not a deduction about which rank
 * they hold.
 */

export interface PencilPanelProps {
  pieces: readonly ViewerPiece[]
  /** the seat this viewer occupies; no seat, no enemy, no notepad */
  me: Color | null
  marks: Readonly<Record<PieceId, readonly Rank[]>>
  /** a dropped rank chip: add it to the piece's set */
  onAdd: (pieceId: PieceId, rank: Rank) => void
  /** click an existing chip to rub that one rank out */
  onToggle: (pieceId: PieceId, rank: Rank) => void
  /** erase every mark on one piece */
  onClear: (pieceId: PieceId) => void
  onClearAll: () => void
  /** open the board popover on this piece */
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

interface Row {
  piece: ViewerPiece
  square: Square
}

export function PencilPanel({
  pieces,
  me,
  marks,
  onAdd,
  onToggle,
  onClear,
  onClearAll,
  onOpenPicker,
  onDragRankStart,
  onDragRankEnd,
}: PencilPanelProps) {
  const [dragOver, setDragOver] = useState<PieceId | null>(null)

  if (me === null) return null

  const rows: Row[] = []
  for (const p of pieces) {
    if (p.color === me) continue
    if (p.square === null) continue
    if (p.revealed) continue
    rows.push({ piece: p, square: p.square })
  }
  rows.sort((a, b) => a.square - b.square)

  const rowIds = new Set(rows.map((r) => r.piece.id))
  const byId = new Map<PieceId, ViewerPiece>(pieces.map((p) => [p.id, p]))
  // Marks on pieces that are not in the rows above. They are kept, never
  // auto-erased (§10 forbids the system rubbing a mark out) — they are just
  // listed here so the player can tidy up their own notes if they want to.
  const other = Object.keys(marks).filter((id) => !rowIds.has(id) && (marks[id]?.length ?? 0) > 0)
  const pieceCount = Object.keys(marks).filter((id) => (marks[id]?.length ?? 0) > 0).length
  const markCount = Object.values(marks).reduce((n, list) => n + list.length, 0)

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
          在棋盤上<strong>右鍵</strong>（或長按）敵方棋子即可開啟標記選單；未選取自己棋子時，左鍵點擊也可以。
        </p>

        <div
          className="xy-pencil-pool"
          role="group"
          aria-label="兵種標記，可拖到下方棋子"
        >
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

        {rows.length === 0 ? (
          <p className="muted small">目前沒有可標記的敵方棋子（存活且未翻明）。</p>
        ) : (
          <ul className="xy-pencil-list">
            {rows.map(({ piece, square }) => {
              const list = marks[piece.id] ?? []
              return (
                <li
                  key={piece.id}
                  className={`xy-pencil-row${dragOver === piece.id ? ' xy-pencil-over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                    if (dragOver !== piece.id) setDragOver(piece.id)
                  }}
                  onDragLeave={() => setDragOver((id) => (id === piece.id ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(null)
                    const rank = readDraggedRank(e.dataTransfer)
                    if (rank) onAdd(piece.id, rank)
                  }}
                >
                  <code className="xy-pencil-sq">{squareName(square)}</code>
                  <span
                    className={`piece ${piece.color === 'white' ? 'piece-white' : 'piece-black'}`}
                  >
                    <span className="glyph">{CARRIER_GLYPH[piece.carrier]}</span>
                  </span>
                  <span className="muted small xy-pencil-carrier">{short(piece.carrier)}</span>

                  <MarkChips
                    marks={list}
                    label={squareName(square)}
                    onRemove={(rank) => onToggle(piece.id, rank)}
                  />

                  {onOpenPicker && (
                    <button
                      type="button"
                      className="xy-pencil-edit"
                      onClick={() => onOpenPicker(square)}
                      title="在棋盤上開啟標記選單"
                      aria-label={`編輯 ${squareName(square)} 的標記`}
                    >
                      標記
                    </button>
                  )}

                  <button
                    type="button"
                    className="xy-pencil-x"
                    disabled={list.length === 0}
                    onClick={() => onClear(piece.id)}
                    title="清除這顆棋子的標記"
                    aria-label={`清除 ${squareName(square)} 的標記`}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {other.length > 0 && (
          <div className="xy-pencil-stale">
            {/* Not a claim about those pieces — only that they are not in the
                rows above. The system never says what became of them. */}
            <div className="muted small">其他標記（不在上方清單中，標記保留）</div>
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
.xy-pencil-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 40vh;
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
.xy-pencil-over {
  background: rgba(110, 193, 255, 0.14);
  outline: 1px dashed var(--accent);
}
.xy-pencil-sq {
  font-size: 0.8rem;
  color: var(--muted);
  min-width: 2.1em;
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
