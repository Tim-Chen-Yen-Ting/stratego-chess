import type { DragEvent } from 'react'
import type { Rank } from '@xiyang/rules'
import { DISTRIBUTION, RANKS_IN_ORDER, RANK_LABEL, RANK_NUMBER_LABEL } from '../constants.js'

/**
 * The remaining pool from DISTRIBUTION (gamebook §2). Two ways in, both live:
 *
 *   · drag a rank chip onto one of your pieces on the board, or
 *   · click a chip then click one of your pieces (the touch-friendly path).
 *
 * Dropping a piece back onto this pool clears its assignment. The pool is also
 * the only counter the screen needs: each chip carries its own remaining count
 * and a spent rank greys out, so no second progress widget is required.
 *
 * The tray decides nothing — it neither validates the assignment nor infers
 * anything from it. `remaining` is arithmetic on the caller's draft against the
 * §2 table; `validateAssignment()` on the server is the authority.
 */

export interface PieceTrayProps {
  /** how many of each rank are still unassigned */
  remaining: Record<Rank, number>
  selected: Rank | null
  onSelect: (rank: Rank | null) => void
  disabled?: boolean
  /** a chip has been picked up — the caller fills the DataTransfer */
  onRankDragStart?: (rank: Rank, e: DragEvent<HTMLElement>) => void
  onRankDragEnd?: () => void
  /** a piece was dropped back onto the pool — the caller clears its rank */
  onPoolDrop?: (e: DragEvent<HTMLElement>) => void
  /** true while a board piece is being dragged, so the pool can invite the drop */
  poolDropActive?: boolean
}

export function PieceTray({
  remaining,
  selected,
  onSelect,
  disabled = false,
  onRankDragStart,
  onRankDragEnd,
  onPoolDrop,
  poolDropActive = false,
}: PieceTrayProps) {
  const acceptsDrop = onPoolDrop !== undefined && !disabled

  return (
    <div
      className={['tray', acceptsDrop && poolDropActive ? 'tray-drop-active' : '']
        .filter(Boolean)
        .join(' ')}
      onDragOver={
        acceptsDrop
          ? (e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }
          : undefined
      }
      onDrop={
        acceptsDrop && onPoolDrop
          ? (e) => {
              e.preventDefault()
              onPoolDrop(e)
            }
          : undefined
      }
    >
      <div className="tray-head">
        <span>兵種池</span>
        <span className="muted small">拖曳兵種到棋子上，或點兵種再點棋子</span>
      </div>
      <div className="tray-grid">
        {RANKS_IN_ORDER.map((rank) => {
          const left = remaining[rank]
          const total = DISTRIBUTION[rank]
          const spent = left <= 0
          const isSelected = selected === rank
          const canDrag = !disabled && !spent && onRankDragStart !== undefined
          return (
            <button
              type="button"
              key={rank}
              className={[
                'tray-item',
                isSelected ? 'tray-item-selected' : '',
                spent ? 'tray-item-empty' : '',
                canDrag ? 'tray-item-draggable' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={disabled || spent}
              draggable={canDrag || undefined}
              onDragStart={canDrag && onRankDragStart ? (e) => onRankDragStart(rank, e) : undefined}
              onDragEnd={canDrag ? () => onRankDragEnd?.() : undefined}
              onClick={() => onSelect(isSelected ? null : rank)}
              title={`${RANK_NUMBER_LABEL[rank]} ${RANK_LABEL[rank]} — 尚餘 ${Math.max(0, left)} / ${total}`}
            >
              <span className="tray-order">{RANK_NUMBER_LABEL[rank]}</span>
              <span className="tray-label">{RANK_LABEL[rank]}</span>
              <span className="tray-count">
                {spent ? '已用完' : `×${left}`}
                <span className="tray-total"> / {total}</span>
              </span>
            </button>
          )
        })}
      </div>
      <p className="muted small tray-note">
        爆裂物無固定階級，接觸時視同同階；但對工兵與軍旗無效（雙向）。軍旗以任何方式離場即判負。
      </p>
    </div>
  )
}
