import type { Color, PieceId, Rank, Square, ViewerPiece } from '@xiyang/rules'
import { CARRIER_GLYPH, CARRIER_LABEL, CENTER_SQUARES, RANK_LABEL } from '../constants.js'
import { isDarkSquare, squareName } from '../format.js'

/**
 * Dumb 8×8 grid. It renders whatever the server sent and reports clicks.
 * It knows nothing about how pieces move: `targets` is always derived from the
 * `legalMoves` in the payload (techspec §7).
 *
 * Rank display rule: a rank is drawn whenever the payload carries one. The
 * redaction layer already decided entitlement — own pieces always, revealed
 * pieces for everyone, and everything at game end (gamebook §10). A piece with
 * `rank === null` renders no 兵種 text at all.
 */

export interface BoardProps {
  pieces: readonly ViewerPiece[]
  /** which colour sits at the bottom */
  orientation: Color
  selected?: Square | null
  /** legal destination squares for the selected piece */
  targets?: readonly Square[]
  /** squares with at least one legal move originating there */
  origins?: readonly Square[]
  /** from/to of the previous ply, drawn faintly */
  lastMove?: readonly Square[]
  /** setup only: draft ranks that have not been submitted yet */
  rankOverride?: Readonly<Record<PieceId, Rank>>
  /** setup only: pieces still awaiting an assignment */
  pendingIds?: ReadonlySet<PieceId>
  onSquareClick?: (sq: Square) => void
}

const FILE_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

export function Board(props: BoardProps) {
  const {
    pieces,
    orientation,
    selected = null,
    targets = [],
    origins = [],
    lastMove = [],
    rankOverride,
    pendingIds,
    onSquareClick,
  } = props

  const bySquare = new Map<Square, ViewerPiece>()
  for (const p of pieces) if (p.square !== null) bySquare.set(p.square, p)

  const targetSet = new Set(targets)
  const originSet = new Set(origins)
  const lastSet = new Set(lastMove)
  const centerSet = new Set(CENTER_SQUARES)

  const rows = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
  const cols = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

  return (
    <div className="board-wrap">
      <div className="board" role="grid" aria-label="棋盤">
        {rows.map((r) => (
          <div className="board-row" role="row" key={r}>
            <div className="coord coord-rank" aria-hidden="true">
              {r + 1}
            </div>
            {cols.map((c) => {
              const sq = r * 8 + c
              const piece = bySquare.get(sq)
              const classes = ['sq', isDarkSquare(sq) ? 'sq-dark' : 'sq-light']
              if (centerSet.has(sq)) classes.push('sq-center')
              if (lastSet.has(sq)) classes.push('sq-last')
              if (sq === selected) classes.push('sq-selected')
              if (targetSet.has(sq)) classes.push(piece ? 'sq-capture' : 'sq-target')
              if (onSquareClick && (targetSet.has(sq) || originSet.has(sq))) {
                classes.push('sq-clickable')
              }
              // In setup mode (rankOverride supplied) show ONLY the draft the
              // player has actually built. piece.rank still carries the server's
              // placeholder assignment, and falling through to it would paint a
              // complete deployment the player never chose — while the tray still
              // reads 16/16 remaining.
              const shownRank = piece
                ? rankOverride
                  ? (rankOverride[piece.id] ?? null)
                  : (piece.rank ?? null)
                : null
              return (
                <button
                  type="button"
                  role="gridcell"
                  key={sq}
                  className={classes.join(' ')}
                  onClick={onSquareClick ? () => onSquareClick(sq) : undefined}
                  disabled={!onSquareClick}
                  title={describe(sq, piece, shownRank)}
                  aria-label={describe(sq, piece, shownRank)}
                >
                  {centerSet.has(sq) && <span className="center-dot" aria-hidden="true" />}
                  {piece && (
                    <span
                      className={[
                        'piece',
                        piece.color === 'white' ? 'piece-white' : 'piece-black',
                        piece.revealed ? 'piece-revealed' : '',
                        pendingIds?.has(piece.id) ? 'piece-pending' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span className="glyph">{CARRIER_GLYPH[piece.carrier]}</span>
                      <span className="rank-tag">
                        {shownRank ? RANK_LABEL[shownRank] : pendingIds?.has(piece.id) ? '？' : ''}
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
    </div>
  )
}

function describe(sq: Square, piece: ViewerPiece | undefined, rank: Rank | null): string {
  const name = squareName(sq)
  if (!piece) return name
  const who = piece.color === 'white' ? '白' : '黑'
  const carrier = CARRIER_LABEL[piece.carrier]
  const rankPart = rank ? ` ${RANK_LABEL[rank]}${piece.revealed ? '（已翻明）' : ''}` : ''
  return `${name} ${who} ${carrier}${rankPart}`
}
