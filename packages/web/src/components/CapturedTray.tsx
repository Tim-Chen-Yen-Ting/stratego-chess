import type { Color, ViewerPiece } from '@xiyang/rules'
import { CARRIER_GLYPH, CARRIER_LABEL, COLOR_LABEL, RANK_LABEL } from '../constants.js'

/**
 * Removed pieces, both sides, drawn with the same chess glyphs as the board.
 *
 * The 兵種 label appears on a captured piece EXACTLY when the payload carries a
 * rank for it, and never otherwise. The redaction layer already decided that
 * (gamebook §10): your own dead pieces always carry one, an enemy dead piece
 * carries one only when the event that killed it made the rank public, and at
 * game end everything is open. This component adds no inference of any kind —
 * `rank === null` simply renders no label. A missing label is itself public
 * information (the loser is never revealed, gamebook §4), so nothing here is
 * hidden from a viewer who is entitled to it.
 */

export interface CapturedTrayProps {
  pieces: readonly ViewerPiece[]
  /** the seat this viewer occupies, for the「你」marker only */
  me: Color | null
}

const SIDES: readonly Color[] = ['white', 'black']

export function CapturedTray({ pieces, me }: CapturedTrayProps) {
  const dead = pieces.filter((p) => p.square === null)

  return (
    <>
      <style>{STYLE}</style>
      <section className="panel xy-cap">
        <h2>已離場棋子</h2>
        {dead.length === 0 ? (
          <p className="muted small">尚無棋子離場。</p>
        ) : (
          SIDES.map((color) => {
            const list = dead.filter((p) => p.color === color)
            return (
              <div className="xy-cap-side" key={color}>
                <div className="xy-cap-head">
                  {COLOR_LABEL[color]}方{me === color ? '（你）' : ''}
                  <span className="muted xy-cap-n">{list.length}</span>
                </div>
                {list.length === 0 ? (
                  <p className="muted small xy-cap-none">—</p>
                ) : (
                  <ul className="xy-cap-row">
                    {list.map((p) => (
                      <li className="xy-cap-item" key={p.id} title={describe(p)}>
                        <span
                          className={`piece ${p.color === 'white' ? 'piece-white' : 'piece-black'}`}
                        >
                          <span className="glyph">{CARRIER_GLYPH[p.carrier]}</span>
                        </span>
                        <span className={p.rank ? 'xy-cap-rank' : 'xy-cap-rank xy-cap-unknown'}>
                          {p.rank ? RANK_LABEL[p.rank] : '？'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })
        )}
        <p className="muted small xy-cap-note">
          「？」＝該子的兵種未公開，本畫面不作推測（規則書 §10）。
        </p>
      </section>
    </>
  )
}

function describe(p: ViewerPiece): string {
  const who = COLOR_LABEL[p.color]
  const carrier = CARRIER_LABEL[p.carrier]
  return `${who} ${carrier}　${p.rank ? RANK_LABEL[p.rank] : '兵種未公開'}`
}

const STYLE = `
.xy-cap .xy-cap-side + .xy-cap-side { margin-top: 10px; }
.xy-cap-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
  margin-bottom: 6px;
}
.xy-cap-n { margin-left: auto; font-variant-numeric: tabular-nums; }
.xy-cap-none { margin: 0; }
.xy-cap-row {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.xy-cap-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 44px;
  padding: 4px 5px 3px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  opacity: 0.92;
}
.xy-cap .glyph { font-size: 1.45rem; }
.xy-cap-rank {
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
  color: var(--fg);
}
.xy-cap-unknown { color: var(--muted); font-weight: 400; }
.xy-cap-note { margin: 8px 0 0; }
`
