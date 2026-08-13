import type { Rank, RankDistribution } from '@xiyang/rules'
import {
  DISTRIBUTION,
  PIECES_PER_SIDE,
  RANKS_IN_ORDER,
  RANK_LABEL,
  RANK_NUMBER_LABEL,
  countOf,
  distributionName,
  distributionOf,
  distributionTotal,
  isStandardDistribution,
} from '../constants.js'
import { useStore } from '../store.js'

/**
 * The 兵種 hierarchy (gamebook §2), highest to lowest, with the per-side count
 * OF THE GAME ON SCREEN.
 *
 * STATIC REFERENCE DATA. Every number on this panel comes from the config the
 * game was created with and says nothing whatsoever about the current position:
 * it does not look at `view.pieces`, does not count what is still alive, does
 * not narrow anything. Reading the board is the game (gamebook §10); this is the
 * printed rules card next to the board, not a solver.
 *
 * 附錄 B makes the counts a per-game parameter, so the card reads
 * `config.distribution` (see `distributionOf`) rather than a module constant. A
 * card is only worth having while it is right: printed on a 工兵×4 game, a table
 * that still says ×2 would be a wrong answer carrying the rulebook's authority —
 * strictly worse than showing no card at all. The mechanism is Board.tsx's: the
 * store is read here so no caller has to be rewired, and a caller that already
 * holds the config may pass `distribution` instead. What is NOT allowed is a
 * constant.
 *
 * The count column is the FULL starting complement of each rank per side. It is
 * deliberately not decremented by captures — that would be bookkeeping the
 * player is supposed to do in their own head.
 */

/** Display-only romanisation, so the table reads for non-Chinese speakers too. */
const RANK_EN: Record<Rank, string> = {
  commander: 'commander',
  general: 'general',
  division: 'division',
  brigade: 'brigade',
  regiment: 'regiment',
  battalion: 'battalion',
  company: 'company',
  platoon: 'platoon',
  engineer: 'engineer',
  flag: 'flag',
  bomb: 'bomb',
}

export interface RankTableProps {
  /**
   * 本局的兵種數量表 (§2, 附錄 B). Omit it and the card reads the config of the
   * game currently on screen, which is what every existing caller wants.
   */
  distribution?: RankDistribution
}

export function RankTable({ distribution }: RankTableProps) {
  // Subscribed unconditionally so the hook order never changes. The selector
  // returns a stable reference (see `distributionOf`). With no game on screen
  // there is no per-game table to be wrong about, so the §2 default stands in.
  const configCounts = useStore((s) => (s.view === null ? DISTRIBUTION : distributionOf(s.view.config)))
  const counts = distribution ?? configCounts

  const total = distributionTotal(counts)
  const name = distributionName(counts)
  const isStandard = isStandardDistribution(counts)

  return (
    <>
      <style>{STYLE}</style>
      <details className="panel xy-ranks" open>
        <summary className="xy-ranks-summary">
          兵種階級表{' '}
          <span className="muted small">
            （{isStandard ? '規則書 §2' : `本局配置 ${name}`} · 固定參考）
          </span>
        </summary>

        <table className="xy-ranks-table">
          <thead>
            <tr>
              <th scope="col" className="xy-ranks-num">
                階
              </th>
              <th scope="col">兵種</th>
              <th scope="col" className="xy-ranks-count">
                每方
              </th>
            </tr>
          </thead>
          <tbody>
            {RANKS_IN_ORDER.map((rank) => {
              const count = countOf(counts, rank)
              const moved = count !== countOf(DISTRIBUTION, rank)
              return (
                <tr key={rank} className={rank === 'bomb' ? 'xy-ranks-bomb' : undefined}>
                  <td className="xy-ranks-num">{RANK_NUMBER_LABEL[rank]}</td>
                  <td>
                    <span className="xy-ranks-name">{RANK_LABEL[rank]}</span>{' '}
                    <span className="muted xy-ranks-en">{RANK_EN[rank]}</span>
                  </td>
                  <td className={moved ? 'xy-ranks-count xy-ranks-moved' : 'xy-ranks-count'}>
                    ×{count}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="muted">合計</td>
              {/* §2 says 16. Stated, not assumed — a table that sums to anything
                  else is unplayable (§9 bijection) and the card says so instead
                  of quietly printing the wrong number. */}
              <td
                className={
                  total === PIECES_PER_SIDE ? 'xy-ranks-count muted' : 'xy-ranks-count xy-ranks-warn'
                }
              >
                {total}
                {total !== PIECES_PER_SIDE && ` ⚠ 應為 ${PIECES_PER_SIDE}`}
              </td>
            </tr>
          </tfoot>
        </table>

        {!isStandard && (
          <p className="xy-ranks-variant">
            本局採用<strong>{name}</strong>配置，數量與規則書 §2 的表不同（附錄 B：數量為可調參數）。
            階級與規則不變。
          </p>
        )}

        <p className="xy-ranks-line">一律大吃小，無兵種例外（1 最大，10 最小）。</p>

        <ul className="xy-ranks-rules">
          <li>
            <strong>同歸於盡：一種公告，三種原因。</strong>階級相同、爆裂物撞上一般兵種、爆裂物撞上爆裂物，三者都是雙方同時移除、該格淨空、
            <strong>不翻明任何一方</strong>，而且公告完全相同——你無從得知自己碰上的是同階還是爆裂物，也無法從紀錄數對手還剩幾顆爆裂物。
          </li>
          <li>
            <strong>爆裂物：工兵與軍旗雙向免疫。</strong>爆裂物無固定階級，接觸時視同同階，故對任何兵種皆為雙亡；唯獨工兵與軍旗擊敗它——攻守兩個方向皆然。此時為「有煙無傷」，存活者不翻明，只公告其為工兵或軍旗。
            這是<strong>唯一</strong>會點出爆裂物的事件：成功引爆的爆裂物永遠不留名，失效的才會自曝。
          </li>
          <li>
            <strong>軍旗離場即刻判負。</strong>軍旗以任何方式離開棋盤，該方立即輸；雙方同時離場為和局。升變與易位不算離場。
          </li>
        </ul>
      </details>
    </>
  )
}

const STYLE = `
.xy-ranks > summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--muted);
  list-style: revert;
}
.xy-ranks[open] > summary { margin-bottom: 8px; }
.xy-ranks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}
.xy-ranks-table th {
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  font-size: 0.75rem;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--line);
}
.xy-ranks-table td {
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.xy-ranks-num {
  width: 2.2em;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  padding-right: 8px !important;
}
.xy-ranks-count {
  width: 3em;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.xy-ranks-name { font-weight: 600; }
.xy-ranks-en { font-size: 0.75rem; }
.xy-ranks-bomb .xy-ranks-name { color: var(--danger); }
.xy-ranks-table tfoot td { border-bottom: 0; font-size: 0.78rem; }
/* a count this game moved away from the §2 table, and a total that cannot be
   deployed at all — both are things the player must not have to notice */
.xy-ranks-moved { color: var(--gold); font-weight: 600; }
.xy-ranks-warn { color: var(--danger); font-weight: 600; }
.xy-ranks-variant {
  margin: 8px 0 0;
  font-size: 0.78rem;
  color: var(--muted);
}
.xy-ranks-variant strong { color: var(--gold); font-weight: 600; }
.xy-ranks-line {
  margin: 8px 0 4px;
  font-size: 0.82rem;
  color: var(--fg);
}
.xy-ranks-rules {
  margin: 0;
  padding-left: 1.1em;
  font-size: 0.8rem;
  color: var(--muted);
}
.xy-ranks-rules li { margin: 4px 0; }
.xy-ranks-rules strong { color: var(--gold); font-weight: 600; }
`
