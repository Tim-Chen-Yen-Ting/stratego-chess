import type { Rank } from '@xiyang/rules'
import { DISTRIBUTION, RANKS_IN_ORDER, RANK_LABEL, RANK_NUMBER_LABEL } from '../constants.js'

/**
 * The remaining pool from DISTRIBUTION (gamebook §2). Click a rank here, then
 * click one of your pieces on the board to assign it. Clicking the selected
 * rank again deselects.
 */

export interface PieceTrayProps {
  /** how many of each rank are still unassigned */
  remaining: Record<Rank, number>
  selected: Rank | null
  onSelect: (rank: Rank | null) => void
  disabled?: boolean
}

export function PieceTray({ remaining, selected, onSelect, disabled = false }: PieceTrayProps) {
  return (
    <div className="tray">
      <div className="tray-head">
        兵種池 <span className="muted">（點兵種，再點自己的棋子）</span>
      </div>
      <div className="tray-grid">
        {RANKS_IN_ORDER.map((rank) => {
          const left = remaining[rank]
          const total = DISTRIBUTION[rank]
          const isSelected = selected === rank
          return (
            <button
              type="button"
              key={rank}
              className={[
                'tray-item',
                isSelected ? 'tray-item-selected' : '',
                left === 0 ? 'tray-item-empty' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={disabled || left === 0}
              onClick={() => onSelect(isSelected ? null : rank)}
            >
              <span className="tray-order">{RANK_NUMBER_LABEL[rank]}</span>
              <span className="tray-label">{RANK_LABEL[rank]}</span>
              <span className="tray-count">
                {left}/{total}
              </span>
            </button>
          )
        })}
      </div>
      <p className="muted small">
        爆裂物無固定階級，接觸時視同同階；但對工兵與軍旗無效（雙向）。軍旗以任何方式離場即判負。
      </p>
    </div>
  )
}
