import { useEffect, useRef, useState } from 'react'
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Color, PieceId, Rank, Square, ViewerPiece } from '@xiyang/rules'
import {
  CARRIER_GLYPH,
  CARRIER_LABEL,
  RANKS_IN_ORDER,
  RANK_LABEL,
  scoringSquaresOf,
} from '../constants.js'
import { isDarkSquare, squareName } from '../format.js'
import { useStore } from '../store.js'

/**
 * Dumb 8×8 grid. It renders whatever the server sent and reports clicks and
 * drops. It knows nothing about how pieces move: `targets` is always derived
 * from the `legalMoves` in the payload (techspec §7). Its one reach outside the
 * props is the 計分區 highlight, which it takes from `config.scoringSquares` on
 * the live payload when the caller does not pass it — a per-game value that
 * must never come from a module constant. Nothing here infers,
 * narrows or validates a 兵種 — a dropped rank is handed straight back to the
 * caller as an opaque DataTransfer, and the pencil popover offers all eleven
 * ranks on every annotatable piece, always (gamebook §10).
 *
 * Rank display rule: an authoritative rank is drawn whenever the payload
 * carries one. The redaction layer already decided entitlement — own pieces
 * always, revealed pieces for everyone, and everything at game end (gamebook
 * §10). A piece with `rank === null` renders no 兵種 text at all.
 */

/**
 * The squares of the move the board is marking, with their ROLES named.
 *
 * This is the richer of the two forms `lastMove` accepts. The array form marks
 * squares and says nothing about them, which is all a live board needs — a
 * faint「上一手」trail. The replay is answering a different question,「這一手是
 * 哪一手」, and for that the roles matter: which square the mover left, which it
 * was heading for, and — the one case where those two do not cover the fight —
 * where contact actually happened.
 *
 * The board draws the roles and interprets nothing. It does not know a castle
 * from a capture and never derives these squares itself; the caller reads them
 * off the public log with the engine's own geometry.
 */
export interface MoveMarks {
  /** every square the move touched. A castle names all four (§3②). */
  squares: readonly Square[]
  /** where the mover started */
  from: Square
  /**
   * Where it was heading. Note §4.1: an attacker that loses never arrives, and
   * the mark still belongs here — this marks the MOVE that was played, not the
   * outcome, which the log and the board itself already show.
   */
  to: Square
  /**
   * §4.2 en passant — the whole game's one case where the contact square is
   * neither `from` nor `to`. Null or absent everywhere else, including an
   * ordinary capture, where contact happens on `to` and marking it twice would
   * say nothing.
   */
  contact?: Square | null
}

export interface BoardProps {
  pieces: readonly ViewerPiece[]
  /** which colour sits at the bottom */
  orientation: Color
  /**
   * The 計分區 to highlight (gamebook §7). Optional: when the caller does not
   * pass it the board reads `config.scoringSquares` off the live payload
   * itself. Either way the value ORIGINATES IN THE GAME'S CONFIG — 附錄 B makes
   * the scoring area a per-game tunable, and a game created with the wide
   * eight-square area must not be drawn with the four-square one. Never a
   * module constant.
   */
  scoringSquares?: readonly Square[]
  selected?: Square | null
  /** legal destination squares for the selected piece */
  targets?: readonly Square[]
  /** squares with at least one legal move originating there */
  origins?: readonly Square[]
  /**
   * The move the board is marking. ONE prop, two forms of the same thing:
   *
   *   · `Square[]` — from/to of the previous ply, drawn faintly. Unchanged.
   *   · `MoveMarks` — the same squares with their roles named, drawn
   *     emphatically. Supplying it IS the request for emphasis: naming the
   *     roles is something only a viewer examining one specific ply has cause
   *     to do, and that viewer needs to see it from across the room.
   *
   * Deliberately not a second `replayMove` prop beside this one. Two props
   * marking the same squares would eventually be passed together and disagree.
   */
  lastMove?: readonly Square[] | MoveMarks | null
  /** setup only: draft ranks that have not been submitted yet */
  rankOverride?: Readonly<Record<PieceId, Rank>>
  /** setup only: pieces still awaiting an assignment */
  pendingIds?: ReadonlySet<PieceId>
  /**
   * In-game only: the viewer's own private guesses about enemy 兵種 — the
   * 便條紙 of gamebook §10, never sent to the server. A piece may carry any
   * number of them. Drawn in a deliberately tentative style so a guess can
   * never be misread as a fact. The owning screen holds this state; the board
   * only paints it.
   */
  pencilMarks?: Readonly<Record<PieceId, readonly Rank[]>>
  /**
   * In-game only: squares whose piece the viewer may scribble on. Supplied by
   * the screen as entitlement bookkeeping (enemy, on the board, not 翻明); the
   * board makes no such judgement itself and reads nothing into it.
   */
  pencilTargets?: ReadonlySet<Square>
  /** the square whose pencil popover is open, or null */
  pencilOpen?: Square | null
  /** right-click or long-press on an annotatable square */
  onPencilRequest?: (sq: Square) => void
  onPencilClose?: () => void
  onPencilToggle?: (pieceId: PieceId, rank: Rank) => void
  onPencilClearPiece?: (pieceId: PieceId) => void
  /** setup only: squares whose assigned rank may be picked up and dragged off */
  dragSources?: ReadonlySet<Square>
  /** setup only: squares that accept a dropped rank */
  dropTargets?: ReadonlySet<Square>
  /** true while a rank drag is in flight — paints `dropTargets` */
  dragActive?: boolean
  onSquareClick?: (sq: Square) => void
  onSquareDragStart?: (sq: Square, e: DragEvent<HTMLElement>) => void
  onSquareDragEnd?: (sq: Square, e: DragEvent<HTMLElement>) => void
  onSquareDrop?: (sq: Square, e: DragEvent<HTMLElement>) => void
}

/**
 * RANK DISPLAY PRECEDENCE — three independent sources, deliberately ordered so
 * that a tentative mark can never impersonate a fact:
 *
 *   1. `rankOverride` (setup draft) — when supplied the board is in setup mode
 *      and shows ONLY what the player has drafted so far. `pencilMarks` is
 *      ignored entirely; the two never mix, and setup has no enemy to guess at.
 *   2. `piece.rank` (authoritative) — own 兵種, anything 系統翻明, and the
 *      full reveal at game end. Always beats a pencil mark on the same piece:
 *      once a fact exists the guess stops being drawn.
 *   3. `pencilMarks` (tentative) — drawn only when 1 and 2 give nothing, i.e.
 *      an enemy piece this viewer is not entitled to see. Rendered bracketed,
 *      smaller, dimmer and italic (see `.rank-tag-pencil`).
 */
interface RankTag {
  /** an authoritative 兵種 to draw, or null */
  fact: Rank | null
  /** the viewer's own guesses, already in display order. Never mixed with 1–2. */
  marks: readonly Rank[]
}

function resolveTag(
  piece: ViewerPiece,
  rankOverride: Readonly<Record<PieceId, Rank>> | undefined,
  pencilMarks: Readonly<Record<PieceId, readonly Rank[]>> | undefined,
): RankTag {
  if (rankOverride) return { fact: rankOverride[piece.id] ?? null, marks: [] }
  if (piece.rank !== null) return { fact: piece.rank, marks: [] }
  return { fact: null, marks: pencilMarks?.[piece.id] ?? [] }
}

/**
 * A square cannot hold five names. One mark keeps the bracketed tag as before;
 * two or three are spelled out when they fit the square; anything longer
 * collapses to a count badge, 〔?4〕. The badge is a LAYOUT decision about the
 * viewer's own handwriting — it counts what the player wrote, never what is
 * left in the §2 table (gamebook §10 forbids the second).
 */
const PENCIL_SEPARATOR = '、'
/**
 * Width budget in units of one full-width character. The multi-mark tag is set
 * at 0.155 × --sq inside a square of width --sq, so a little over six units fit
 * on a line, and the tag is allowed to wrap onto a second line inside the
 * square. Purely a typographic number.
 */
const PENCIL_TAG_BUDGET = 12

function tagWidth(text: string): number {
  let w = 0
  for (const ch of text) w += ch.codePointAt(0)! < 0x2000 ? 0.5 : 1
  return w
}

function pencilTagText(marks: readonly Rank[]): string {
  if (marks.length === 0) return ''
  if (marks.length === 1) return `〔${RANK_LABEL[marks[0]]}〕`
  if (marks.length <= 3) {
    const text = `〔${marks.map((r) => RANK_LABEL[r]).join(PENCIL_SEPARATOR)}〕`
    if (tagWidth(text) <= PENCIL_TAG_BUDGET) return text
  }
  return `〔?${marks.length}〕`
}

/** The full list, for tooltips and screen readers, where width is not a problem. */
function pencilFullText(marks: readonly Rank[]): string {
  return `〔${marks.map((r) => RANK_LABEL[r]).join(PENCIL_SEPARATOR)}〕`
}

/** `lastMove` after both of its forms have been flattened into one. */
interface ResolvedMarks {
  squares: ReadonlySet<Square>
  /** null in the array form, which names no roles */
  from: Square | null
  to: Square | null
  contact: Square | null
}

const NO_MARKS: ResolvedMarks = {
  squares: new Set<Square>(),
  from: null,
  to: null,
  contact: null,
}

function resolveMarks(value: BoardProps['lastMove']): ResolvedMarks {
  if (value === undefined || value === null) return NO_MARKS
  if ('squares' in value) {
    return {
      squares: new Set(value.squares),
      from: value.from,
      to: value.to,
      contact: value.contact ?? null,
    }
  }
  return { squares: new Set(value), from: null, to: null, contact: null }
}

/** What this square is to the move being marked, for the label. */
function markRole(sq: Square, marks: ResolvedMarks): string | null {
  if (sq === marks.contact) return '本手接觸格'
  if (sq === marks.from) return '本手起點'
  if (sq === marks.to) return '本手終點'
  return null
}

const FILE_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

/** Touch equivalent of a right-click. */
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 12

/** board border + padding, and the rank-coordinate gutter, in px (see styles.css) */
const BOARD_INSET_PX = 5
const BOARD_GUTTER_PX = 18

export function Board(props: BoardProps) {
  const {
    pieces,
    orientation,
    scoringSquares,
    selected = null,
    targets = [],
    origins = [],
    lastMove,
    rankOverride,
    pendingIds,
    pencilMarks,
    pencilTargets,
    pencilOpen = null,
    onPencilRequest,
    onPencilClose,
    onPencilToggle,
    onPencilClearPiece,
    dragSources,
    dropTargets,
    dragActive = false,
    onSquareClick,
    onSquareDragStart,
    onSquareDragEnd,
    onSquareDrop,
  } = props

  /*
   * The 計分區, from the config of the game actually on screen. The selector
   * returns a stable reference (see `scoringSquaresOf`), and it is subscribed
   * unconditionally so the hook order never changes. A caller that already has
   * the config in hand may pass `scoringSquares` and this is ignored; what is
   * NOT allowed is a constant, which would keep painting d4 e4 d5 e5 on a board
   * whose config scores eight squares.
   */
  const configSquares = useStore((s) => (s.view === null ? null : scoringSquaresOf(s.view.config)))
  const scoreSquares = scoringSquares ?? configSquares ?? []

  // purely visual: which drop target the pointer is currently over
  const [hoverSq, setHoverSq] = useState<Square | null>(null)

  // long-press bookkeeping; refs because none of it is rendered
  const pressRef = useRef<{ timer: number; x: number; y: number } | null>(null)
  const longFiredRef = useRef(false)

  function cancelPress() {
    if (pressRef.current !== null) window.clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }

  useEffect(() => cancelPress, [])

  // Dismiss the popover on Escape or on a pointer press that is neither inside
  // it nor on a square (a square press is handled by the click logic, which may
  // want to move the popover to another piece).
  useEffect(() => {
    if (pencilOpen === null || onPencilClose === undefined) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onPencilClose()
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('.xy-pop') !== null || target.closest('.sq') !== null) return
      onPencilClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [pencilOpen, onPencilClose])

  const bySquare = new Map<Square, ViewerPiece>()
  for (const p of pieces) if (p.square !== null) bySquare.set(p.square, p)

  const targetSet = new Set(targets)
  const originSet = new Set(origins)
  const moveMarks = resolveMarks(lastMove)
  // `sq-center` / `center-dot` are the shared stylesheet's names for the
  // scoring highlight and stay as they are; only the membership is per-game.
  const centerSet = new Set(scoreSquares)

  const rows = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
  const cols = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

  const canPencil = onPencilRequest !== undefined && pencilTargets !== undefined
  const openPiece = pencilOpen === null ? undefined : bySquare.get(pencilOpen)

  return (
    <div className="board-wrap">
      <style>{STYLE}</style>
      <div className="board" role="grid" aria-label="棋盤">
        {rows.map((r) => (
          <div className="board-row" role="row" key={r}>
            <div className="coord coord-rank" aria-hidden="true">
              {r + 1}
            </div>
            {cols.map((c) => {
              const sq = r * 8 + c
              const piece = bySquare.get(sq)
              const droppable = onSquareDrop !== undefined && (dropTargets?.has(sq) ?? false)
              const pencilable = canPencil && (pencilTargets?.has(sq) ?? false)
              const classes = ['sq', isDarkSquare(sq) ? 'sq-dark' : 'sq-light']
              if (centerSet.has(sq)) classes.push('sq-center')
              if (moveMarks.squares.has(sq)) classes.push('sq-last')
              // roles on top of the trail — see `MoveMarks`. Only the structured
              // form sets these, so a live board is untouched by them.
              if (sq === moveMarks.from) classes.push('sq-move-from')
              if (sq === moveMarks.to) classes.push('sq-move-to')
              if (sq === moveMarks.contact) classes.push('sq-move-contact')
              if (sq === selected) classes.push('sq-selected')
              if (targetSet.has(sq)) classes.push(piece ? 'sq-capture' : 'sq-target')
              if (onSquareClick && (targetSet.has(sq) || originSet.has(sq))) {
                classes.push('sq-clickable')
              }
              if (pencilable) classes.push('sq-pencilable')
              if (pencilOpen === sq) classes.push('sq-pencil-open')
              if (droppable && dragActive) classes.push('sq-droppable')
              if (droppable && dragActive && hoverSq === sq) classes.push('sq-drop-hover')

              const { fact, marks } = piece
                ? resolveTag(piece, rankOverride, pencilMarks)
                : { fact: null, marks: [] as readonly Rank[] }
              const pencil = fact === null && marks.length > 0
              // a drag source needs a handler to fill the DataTransfer: Firefox
              // cancels a dragstart that sets nothing
              const draggable =
                piece !== undefined &&
                onSquareDragStart !== undefined &&
                (dragSources?.has(sq) ?? false)

              const role = markRole(sq, moveMarks)
              const described = describe(sq, piece, fact, marks, pendingIds)
              const label = role === null ? described : `${described}（${role}）`

              return (
                <button
                  type="button"
                  role="gridcell"
                  key={sq}
                  className={classes.join(' ')}
                  onClick={
                    onSquareClick
                      ? () => {
                          // swallow the click a completed long-press produces
                          if (longFiredRef.current) {
                            longFiredRef.current = false
                            return
                          }
                          onSquareClick(sq)
                        }
                      : undefined
                  }
                  disabled={!onSquareClick}
                  title={label}
                  aria-label={label}
                  onContextMenu={
                    pencilable && onPencilRequest
                      ? (e) => {
                          e.preventDefault()
                          onPencilRequest(sq)
                        }
                      : undefined
                  }
                  onPointerDown={
                    pencilable && onPencilRequest
                      ? (e: ReactPointerEvent<HTMLElement>) => {
                          if (e.pointerType === 'mouse') return
                          cancelPress()
                          longFiredRef.current = false
                          const x = e.clientX
                          const y = e.clientY
                          const timer = window.setTimeout(() => {
                            pressRef.current = null
                            longFiredRef.current = true
                            onPencilRequest(sq)
                          }, LONG_PRESS_MS)
                          pressRef.current = { timer, x, y }
                        }
                      : undefined
                  }
                  onPointerMove={
                    pencilable
                      ? (e: ReactPointerEvent<HTMLElement>) => {
                          const press = pressRef.current
                          if (press === null) return
                          const dx = e.clientX - press.x
                          const dy = e.clientY - press.y
                          if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) {
                            cancelPress()
                          }
                        }
                      : undefined
                  }
                  onPointerUp={pencilable ? cancelPress : undefined}
                  onPointerCancel={pencilable ? cancelPress : undefined}
                  onPointerLeave={pencilable ? cancelPress : undefined}
                  onDragOver={
                    droppable
                      ? (e) => {
                          // preventDefault is what marks this square as a legal
                          // drop; squares outside dropTargets simply never do it.
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          if (hoverSq !== sq) setHoverSq(sq)
                        }
                      : undefined
                  }
                  onDragLeave={
                    droppable
                      ? (e) => {
                          const next = e.relatedTarget
                          if (next instanceof Node && e.currentTarget.contains(next)) return
                          setHoverSq((cur) => (cur === sq ? null : cur))
                        }
                      : undefined
                  }
                  onDrop={
                    droppable && onSquareDrop
                      ? (e) => {
                          e.preventDefault()
                          setHoverSq(null)
                          onSquareDrop(sq, e)
                        }
                      : undefined
                  }
                >
                  {centerSet.has(sq) && <span className="center-dot" aria-hidden="true" />}
                  {piece && (
                    <span
                      className={[
                        'piece',
                        piece.color === 'white' ? 'piece-white' : 'piece-black',
                        piece.revealed ? 'piece-revealed' : '',
                        pendingIds?.has(piece.id) ? 'piece-pending' : '',
                        draggable ? 'piece-draggable' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      draggable={draggable || undefined}
                      onDragStart={
                        draggable && onSquareDragStart ? (e) => onSquareDragStart(sq, e) : undefined
                      }
                      onDragEnd={
                        draggable
                          ? (e) => {
                              setHoverSq(null)
                              onSquareDragEnd?.(sq, e)
                            }
                          : undefined
                      }
                    >
                      <span className="glyph">{CARRIER_GLYPH[piece.carrier]}</span>
                      <span
                        className={
                          pencil
                            ? marks.length > 1
                              ? 'rank-tag rank-tag-pencil rank-tag-pencil-multi'
                              : 'rank-tag rank-tag-pencil'
                            : 'rank-tag'
                        }
                      >
                        {fact
                          ? RANK_LABEL[fact]
                          : pencil
                            ? pencilTagText(marks)
                            : pendingIds?.has(piece.id)
                              ? '？'
                              : ''}
                      </span>
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
        <div className="board-row board-files" aria-hidden="true">
          <div className="coord coord-rank" />
          {cols.map((c) => (
            <div className="coord coord-file" key={c}>
              {FILE_LETTERS[c]}
            </div>
          ))}
        </div>
      </div>

      {pencilOpen !== null && openPiece !== undefined && (
        <PencilPopover
          square={pencilOpen}
          piece={openPiece}
          marks={pencilMarks?.[openPiece.id] ?? []}
          rowIdx={rows.indexOf(Math.floor(pencilOpen / 8))}
          colIdx={cols.indexOf(pencilOpen % 8)}
          onToggle={onPencilToggle}
          onClearPiece={onPencilClearPiece}
          onClose={onPencilClose}
        />
      )}
    </div>
  )
}

interface PencilPopoverProps {
  square: Square
  piece: ViewerPiece
  marks: readonly Rank[]
  rowIdx: number
  colIdx: number
  onToggle?: (pieceId: PieceId, rank: Rank) => void
  onClearPiece?: (pieceId: PieceId) => void
  onClose?: () => void
}

/**
 * The notepad, opened on the piece itself. ALL ELEVEN RANKS, ALWAYS, on every
 * annotatable piece — nothing is filtered, greyed, crossed out or counted, and
 * no combination is refused. Tick 司令 on five pieces if you like; the system
 * has no opinion (gamebook §10). That restraint is the whole point.
 */
function PencilPopover({
  square,
  piece,
  marks,
  rowIdx,
  colIdx,
  onToggle,
  onClearPiece,
  onClose,
}: PencilPopoverProps) {
  const on = new Set<Rank>(marks)
  // Anchored to the square: horizontally at its centre, nudged inwards near the
  // edges so it stays over the board; flipped above for the bottom rows.
  const above = rowIdx >= 5
  const shiftPct = 10 + (colIdx / 7) * 80
  const left = `calc(${BOARD_INSET_PX + BOARD_GUTTER_PX}px + var(--sq) * ${colIdx + 0.5})`
  const top = above
    ? `calc(${BOARD_INSET_PX}px + var(--sq) * ${rowIdx} - 6px)`
    : `calc(${BOARD_INSET_PX}px + var(--sq) * ${rowIdx + 1} + 6px)`

  return (
    <div
      className="xy-pop"
      role="dialog"
      aria-label={`${squareName(square)} 的標記`}
      style={{
        left,
        top,
        transform: `translate(-${shiftPct}%, ${above ? '-100%' : '0'})`,
      }}
    >
      <div className="xy-pop-head">
        <code>{squareName(square)}</code>
        <span className="muted small">{CARRIER_LABEL[piece.carrier]}</span>
        <button
          type="button"
          className="xy-pop-close"
          onClick={() => onClose?.()}
          aria-label="關閉標記選單"
          title="關閉"
        >
          ×
        </button>
      </div>

      <div className="xy-pop-grid">
        {RANKS_IN_ORDER.map((rank) => {
          const ticked = on.has(rank)
          return (
            <button
              type="button"
              key={rank}
              className={ticked ? 'xy-pop-rank xy-pop-on' : 'xy-pop-rank'}
              aria-pressed={ticked}
              onClick={() => onToggle?.(piece.id, rank)}
            >
              {RANK_LABEL[rank]}
            </button>
          )
        })}
      </div>

      <div className="xy-pop-foot">
        <button
          type="button"
          className="xy-pop-clear"
          disabled={marks.length === 0}
          onClick={() => onClearPiece?.(piece.id)}
        >
          清除
        </button>
        <span className="muted small">自己的猜測，系統不驗證、不推論</span>
      </div>
    </div>
  )
}

function describe(
  sq: Square,
  piece: ViewerPiece | undefined,
  fact: Rank | null,
  marks: readonly Rank[],
  pendingIds: ReadonlySet<PieceId> | undefined,
): string {
  const name = squareName(sq)
  if (!piece) return name
  const who = piece.color === 'white' ? '白' : '黑'
  const carrier = CARRIER_LABEL[piece.carrier]
  if (fact !== null) {
    return `${name} ${who} ${carrier} ${RANK_LABEL[fact]}${piece.revealed ? '（已翻明）' : ''}`
  }
  if (marks.length > 0) {
    return `${name} ${who} ${carrier} ${pencilFullText(marks)}我的標記，非事實`
  }
  return `${name} ${who} ${carrier}${pendingIds?.has(piece.id) ? ' 未指派' : ''}`
}

/**
 * Scoped to the board. The shared stylesheet owns the grid and the rank tags;
 * everything the on-board notepad needs lives here under an `xy-` prefix.
 */
const STYLE = `
/* ---- the ply being examined (replay) -------------------------------------
   The shared stylesheet's faint .sq-last fill still marks every square the move
   touched; these name the ROLES on top of it, which is what turns「上一手」into
  「你正在看的這一手」. Drawn with ::before so nothing here fights .sq-center's
   outline, .sq-target's ::after dot, or the box-shadow-based selection marks —
   a square can legitimately be several of those at once. ::before precedes the
   piece in DOM order, so the glyph still paints on top of the ring. */
.sq-move-from::before,
.sq-move-to::before,
.sq-move-contact::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}
/* the mover left here — dashed, because nothing is standing on it any more */
.sq-move-from::before { border: 2px dashed rgba(255, 232, 140, 0.85); }
/* where it was heading (§4.1 — it may not have arrived; the log says which) */
.sq-move-to::before { border: 3px solid #ffe88c; }
/* §4.2 en passant, the one move whose contact square is neither from nor to.
   Red, the colour this board already uses for a capture, because that is what
   happened on it. */
.sq-move-contact::before { border: 3px solid var(--danger); }
/* readable before the ring registers. Overrides .sq-last's fill by document
   order — this element is injected after the stylesheet, same specificity. */
.sq-move-from,
.sq-move-to,
.sq-move-contact {
  box-shadow: inset 0 0 0 100px rgba(255, 232, 140, 0.2);
}

.sq-pencilable {
  -webkit-touch-callout: none;
  touch-action: manipulation;
  user-select: none;
}
/* a square that is also a legal destination keeps the move cursor: the move
   flow always wins over the notepad */
.sq-pencilable:not(.sq-clickable) {
  cursor: context-menu;
}
.sq-pencil-open {
  box-shadow: inset 0 0 0 3px var(--accent);
}
.xy-pop {
  position: absolute;
  z-index: 30;
  width: max-content;
  max-width: min(280px, 92vw);
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  padding: 8px;
}
.xy-pop-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}
.xy-pop-head code { font-size: 0.85rem; }
.xy-pop-close {
  margin-left: auto;
  padding: 0 6px;
  line-height: 1.3;
  background: transparent;
  border: 0;
}
.xy-pop-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}
.xy-pop-rank {
  font-size: 0.82rem;
  padding: 4px 2px;
  border: 1px dashed var(--line);
  border-radius: 5px;
  white-space: nowrap;
}
.xy-pop-on {
  border: 1px dashed var(--accent);
  color: var(--accent);
  background: rgba(110, 193, 255, 0.16);
  font-style: italic;
}
.xy-pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.xy-pop-clear { font-size: 0.8rem; padding: 3px 9px; }
`
