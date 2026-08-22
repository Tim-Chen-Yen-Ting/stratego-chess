import type { DragEvent } from 'react'
import type { Rank, RankDistribution } from '@xiyang/rules'
import {
  DISTRIBUTION,
  RANKS_IN_ORDER,
  RANK_LABEL,
  RANK_NUMBER_LABEL,
  countOf,
  distributionName,
  distributionOf,
  isStandardDistribution,
} from '../constants.js'
import { useStore } from '../store.js'
import { fill, useLang, type Strings } from '../i18n.js'

/**
 * The remaining pool from THIS GAME's 兵種 table (gamebook §2, 附錄 B — the
 * counts are a per-game parameter, so the chips read `config.distribution` and
 * never a module constant; see `distributionOf`). Two ways in, both live:
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

const STR = {
  zh: {
    poolLabel: '兵種池',
    poolLabelVariant: '兵種池 · {{name}}配置',
    dragHint: '拖曳兵種到棋子上，或點兵種再點棋子',
    titleUnused: '{{num}} {{label}} — 本局不使用',
    titleRemaining: '{{num}} {{label}} — 尚餘 {{left}} / {{total}}',
    unused: '本局不使用',
    spent: '已用完',
    note: '爆裂物無固定階級，接觸時視同同階；但對工兵與軍旗無效（雙向）。軍旗以任何方式離場即判負。',
  },
  en: {
    poolLabel: 'Rank pool',
    poolLabelVariant: 'Rank pool · {{name}}',
    dragHint: 'Drag a rank onto a piece, or click a rank then click a piece',
    titleUnused: '{{num}} {{label}} — not used this game',
    titleRemaining: '{{num}} {{label}} — {{left}} / {{total}} left',
    unused: 'Not used',
    spent: 'Used up',
    note: 'A bomb has no fixed rank — on contact it counts as equal-rank to anything — but is harmless against Engineers and the Flag (both directions). The Flag leaving the board by any means is an immediate loss.',
  },
} satisfies Strings<
  | 'poolLabel'
  | 'poolLabelVariant'
  | 'dragHint'
  | 'titleUnused'
  | 'titleRemaining'
  | 'unused'
  | 'spent'
  | 'note'
>

export interface PieceTrayProps {
  /** how many of each rank are still unassigned */
  remaining: Record<Rank, number>
  /**
   * 本局的兵種數量表 — the denominator of every chip. Omit it and the tray reads
   * the config of the game on screen, which is what the Setup screen wants.
   */
  distribution?: RankDistribution
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
  distribution,
  selected,
  onSelect,
  disabled = false,
  onRankDragStart,
  onRankDragEnd,
  onPoolDrop,
  poolDropActive = false,
}: PieceTrayProps) {
  const { lang } = useLang()
  const s = STR[lang]
  const acceptsDrop = onPoolDrop !== undefined && !disabled

  // Same mechanism as Board.tsx: subscribed unconditionally, stable reference,
  // and a caller holding the config may pass `distribution` instead. A chip
  // reading "/ 2" in a game dealt four of that rank would send the player into
  // a deployment the server then rejects.
  const configCounts = useStore((s) => (s.view === null ? DISTRIBUTION : distributionOf(s.view.config)))
  const counts = distribution ?? configCounts
  // The 兵種階級表 card lives on the Game screen, so during deployment this pool
  // is the ONLY place the counts appear. If they are not §2's, say which table
  // this is — the player is about to commit sixteen pieces to it.
  const isStandard = isStandardDistribution(counts)
  const distName = distributionName(counts, lang)

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
        <span>{isStandard ? s.poolLabel : fill(s.poolLabelVariant, { name: distName })}</span>
        <span className="muted small">{s.dragHint}</span>
      </div>
      <div className="tray-grid">
        {RANKS_IN_ORDER.map((rank) => {
          const left = remaining[rank]
          const total = countOf(counts, rank)
          // A variant may deal none of a rank. That chip is not 已用完 — nothing
          // was ever there to use — and saying so is the difference between a
          // pool the player can trust and one they have to second-guess.
          const unused = total <= 0
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
              title={
                unused
                  ? fill(s.titleUnused, { num: RANK_NUMBER_LABEL[rank], label: RANK_LABEL[lang][rank] })
                  : fill(s.titleRemaining, {
                      num: RANK_NUMBER_LABEL[rank],
                      label: RANK_LABEL[lang][rank],
                      left: Math.max(0, left),
                      total,
                    })
              }
            >
              <span className="tray-order">{RANK_NUMBER_LABEL[rank]}</span>
              <span className="tray-label">{RANK_LABEL[lang][rank]}</span>
              <span className="tray-count">
                {unused ? s.unused : spent ? s.spent : `×${left}`}
                {!unused && <span className="tray-total"> / {total}</span>}
              </span>
            </button>
          )
        })}
      </div>
      <p className="muted small tray-note">{s.note}</p>
    </div>
  )
}
