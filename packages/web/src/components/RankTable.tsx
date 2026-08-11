import type { Rank } from '@xiyang/rules'
import { DISTRIBUTION, RANKS_IN_ORDER, RANK_LABEL, RANK_NUMBER_LABEL } from '../constants.js'

/**
 * The 兵種 hierarchy (gamebook §2), highest to lowest, with the per-side count
 * from DISTRIBUTION.
 *
 * STATIC REFERENCE DATA. Every number on this panel comes from the rules
 * package's constant table and says nothing whatsoever about the current
 * position: it does not look at `view.pieces`, does not count what is still
 * alive, does not narrow anything. Reading the board is the game (gamebook
 * §10); this is the printed rules card next to the board, not a solver.
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

const TOTAL = RANKS_IN_ORDER.reduce((n, r) => n + DISTRIBUTION[r], 0)

export function RankTable() {
  return (
    <>
      <style>{STYLE}</style>
      <details className="panel xy-ranks" open>
        <summary className="xy-ranks-summary">
          兵種階級表 <span className="muted small">（規則書 §2 · 固定參考）</span>
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
            {RANKS_IN_ORDER.map((rank) => (
              <tr key={rank} className={rank === 'bomb' ? 'xy-ranks-bomb' : undefined}>
                <td className="xy-ranks-num">{RANK_NUMBER_LABEL[rank]}</td>
                <td>
                  <span className="xy-ranks-name">{RANK_LABEL[rank]}</span>{' '}
                  <span className="muted xy-ranks-en">{RANK_EN[rank]}</span>
                </td>
                <td className="xy-ranks-count">×{DISTRIBUTION[rank]}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="muted">合計</td>
              <td className="xy-ranks-count muted">{TOTAL}</td>
            </tr>
          </tfoot>
        </table>

        <p className="xy-ranks-line">一律大吃小，無兵種例外（1 最大，10 最小）。</p>

        <ul className="xy-ranks-rules">
          <li>
            <strong>同階雙亡。</strong>階級相同時雙方同時移除，該格淨空。
          </li>
          <li>
            <strong>爆裂物：工兵與軍旗雙向免疫。</strong>爆裂物無固定階級，接觸時視同同階，故對任何兵種皆為雙亡；唯獨工兵與軍旗擊敗它——攻守兩個方向皆然。此時為「有煙無傷」，存活者不翻明，只公告其為工兵或軍旗。
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
