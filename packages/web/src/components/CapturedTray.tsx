import { useState } from 'react'
import type { Color, PieceId, Rank, ViewerPiece } from '@xiyang/rules'
import { CARRIER_GLYPH, CARRIER_LABEL, COLOR_LABEL, RANK_LABEL } from '../constants.js'
import { combatText, moveText, other, squareName } from '../format.js'
import type { CaptureRecord } from '../store.js'
import { RankPicker, isAnnotatable } from './PencilPanel.js'

/**
 * Removed pieces, both sides, with the event that removed each one.
 *
 * ── What this panel shows, and why it is allowed ───────────────────────────
 *
 * 紀錄給，解算不給 (gamebook §10). A capture is announced out loud the moment it
 * happens, and then it scrolls away: two turns later the player knows a piece is
 * gone but not what took it. Every line below is that same announcement, moved
 * next to the piece it was about instead of twenty lines up the log. The `ply`,
 * the mover, the squares and the outcome all come verbatim from `view.log`; the
 * tooltip is the log sentence itself, the one the 公開紀錄 panel already prints.
 * Reorganised LOG. Allowed.
 *
 * ── What this panel must never show ────────────────────────────────────────
 *
 * The CONCLUSION. No candidate range, no「(團長, 工兵]」, no「剩 5 種」, no
 * elimination, no counting against the §2 table — not in a label, not in a
 * tooltip, not in an aria-label, not in a sort order. Showing the event and
 * stopping is the entire point: reading the board is the game (§10 讀盤為本遊戲
 * 的核心技能). The moment this file derives what a dead piece COULD have been,
 * it is the solver §10 forbids.
 *
 * ── The 兵種 label ─────────────────────────────────────────────────────────
 *
 * A fact appears on a captured piece EXACTLY when the payload carries a rank for
 * it, and never otherwise. The redaction layer already decided that: your own
 * dead pieces always carry one, an enemy dead piece carries one only when the
 * event that killed it made the rank public (同階雙亡, 爆裂物 vs 爆裂物), and at
 * game end everything is open. `rank === null` renders no fact — a missing label
 * is itself public information (the loser is never revealed, §4).
 *
 * ── The player's own handwriting ───────────────────────────────────────────
 *
 * Where the payload carries no rank, the player may pencil their own guesses
 * (§10 玩家標記) straight from here — this is the piece they most want to
 * annotate, because the killing event is right there and the range is theirs to
 * work out. Marks are dashed and italic and bracketed; a 系統翻明 rank is solid.
 * A guess must never be mistaken for a fact. No mark is validated, filtered or
 * counted, and any of the eleven ranks may go on any dead piece.
 */

export interface CapturedTrayProps {
  pieces: readonly ViewerPiece[]
  /** the seat this viewer occupies, for the「你」marker and mark entitlement */
  me: Color | null
  /** piece id → the public event that removed it, derived from `view.log` */
  captures: ReadonlyMap<PieceId, CaptureRecord>
  /** the viewer's own pencil marks, client-only (§10) */
  marks: Readonly<Record<PieceId, readonly Rank[]>>
  onToggleMark: (pieceId: PieceId, rank: Rank) => void
  onClearMark: (pieceId: PieceId) => void
}

const SIDES: readonly Color[] = ['white', 'black']

export function CapturedTray({
  pieces,
  me,
  captures,
  marks,
  onToggleMark,
  onClearMark,
}: CapturedTrayProps) {
  /** which captured piece has its notepad open, if any */
  const [openId, setOpenId] = useState<PieceId | null>(null)

  const dead = pieces.filter((p) => p.square === null)
  // Oldest first, so the tray reads in the same direction as the log. Pieces the
  // log never accounted for keep their payload order at the end.
  const order = (p: ViewerPiece) => captures.get(p.id)?.ply ?? Number.MAX_SAFE_INTEGER

  return (
    <>
      <style>{STYLE}</style>
      <section className="panel xy-cap">
        <h2>已離場棋子</h2>
        {dead.length === 0 ? (
          <p className="muted small">尚無棋子離場。</p>
        ) : (
          SIDES.map((color) => {
            const list = dead.filter((p) => p.color === color).sort((a, b) => order(a) - order(b))
            return (
              <div className="xy-cap-side" key={color}>
                <div className="xy-cap-head">
                  {COLOR_LABEL[color]}方{me === color ? '（你）' : ''}
                  <span className="muted xy-cap-n">{list.length}</span>
                </div>
                {list.length === 0 ? (
                  <p className="muted small xy-cap-none">—</p>
                ) : (
                  <ul className="xy-cap-list">
                    {list.map((p) => {
                      const rec = captures.get(p.id)
                      const mine = marks[p.id] ?? []
                      const canMark = isAnnotatable(p, me)
                      const open = openId === p.id
                      return (
                        <li className="xy-cap-entry" key={p.id}>
                          <div className="xy-cap-item" title={describe(p, rec, me)}>
                            <span
                              className={`piece xy-cap-face ${
                                p.color === 'white' ? 'piece-white' : 'piece-black'
                              }`}
                            >
                              <span className="glyph">{CARRIER_GLYPH[p.carrier]}</span>
                            </span>

                            {p.rank !== null ? (
                              <span className="xy-cap-rank">{RANK_LABEL[p.rank]}</span>
                            ) : mine.length > 0 ? (
                              <span className="xy-cap-marks">
                                {mine.map((rank) => (
                                  <button
                                    type="button"
                                    key={rank}
                                    className="xy-cap-mark"
                                    onClick={() => onToggleMark(p.id, rank)}
                                    title={`移除「${RANK_LABEL[rank]}」（我的標記）`}
                                    aria-label={`移除標記 ${RANK_LABEL[rank]}`}
                                  >
                                    〔{RANK_LABEL[rank]}〕
                                  </button>
                                ))}
                              </span>
                            ) : (
                              <span className="xy-cap-rank xy-cap-unknown">？</span>
                            )}

                            {canMark && (
                              <button
                                type="button"
                                className={open ? 'xy-cap-edit xy-cap-edit-on' : 'xy-cap-edit'}
                                aria-expanded={open}
                                onClick={() => setOpenId(open ? null : p.id)}
                                title="寫下我的猜測（系統不驗證、不推論）"
                                aria-label={`標記這顆已離場的${CARRIER_LABEL[p.carrier]}`}
                              >
                                標記
                              </button>
                            )}

                            <span className="muted small xy-cap-line">
                              {rec ? `第 ${rec.ply} 手 · ${captureLine(rec, me)}` : '離場紀錄不明'}
                            </span>
                          </div>

                          {open && (
                            <RankPicker
                              title={`${rec ? `第 ${rec.ply} 手離場` : '已離場'} · ${shortCarrier(p)}`}
                              marks={mine}
                              onToggle={(rank) => onToggleMark(p.id, rank)}
                              onClear={() => onClearMark(p.id)}
                              onClose={() => setOpenId(null)}
                            />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })
        )}
        <p className="muted small xy-cap-note">
          每一列是當時的<strong>公開公告</strong>，只是搬到棋子旁邊。「？」＝該子的兵種未公開；本畫面不推測、不列可能範圍、不計算剩餘（規則書
          §10）。〔　〕為你自己寫的猜測，點一下可擦掉。
        </p>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// The one line under each captured piece.
//
// Every branch restates gamebook §4「翻明總表」/ §5 for the event that removed
// this piece — who moved, where the contact was, and what the server announced.
// Nothing here looks at any other event, at the §2 counts, or at what is still
// unaccounted for. There is deliberately no "therefore".
// ---------------------------------------------------------------------------

/** The colour of the piece this record is about. */
function deadColorOf(rec: CaptureRecord): Color {
  return rec.role === 'attacker' ? rec.event.color : other(rec.event.color)
}

function ownerLabel(color: Color, me: Color | null): string {
  if (me === null) return `${COLOR_LABEL[color]}方的`
  return color === me ? '你的' : '對方的'
}

export function captureLine(rec: CaptureRecord, me: Color | null): string {
  const combat = rec.event.combat
  if (combat === undefined) return '離場'

  const { outcome, defenderSquare } = combat
  const mover = rec.event.color
  const here = squareName(rec.square)
  const contact = squareName(defenderSquare)

  switch (outcome.kind) {
    case 'attacker-wins':
      // this piece was standing there; the winner is 永久翻明 by announcement
      return `於 ${here} 被${ownerLabel(mover, me)}${RANK_LABEL[outcome.winnerRank]}吃掉`
    case 'defender-wins':
      // 攻方由其原格移除 (§4 位置結算) — this piece never entered the target
      return `由 ${here} 攻擊 ${contact} 落敗 — ${ownerLabel(other(mover), me)}${
        RANK_LABEL[outcome.winnerRank]
      }守住並翻明`
    case 'mutual-rank':
      // both are removed, so 「接觸於」 rather than 「於」: the attacker died at
      // its own origin and never entered the contact square (§4 位置結算)
      return `接觸於 ${contact} 同階雙亡 — 雙方皆為 ${RANK_LABEL[outcome.rank]}`
    case 'bomb-vs-bomb':
      return `接觸於 ${contact} 爆裂物對爆裂物 — 雙方皆公告為爆裂物`
    case 'bomb-detonate':
      // only the bomb is announced; the piece it took stays hidden (§4 翻明總表)
      return deadColorOf(rec) === outcome.bombColor
        ? `接觸於 ${contact} 引爆（${RANK_LABEL.bomb}）— 對方兵種不公開`
        : `於 ${here} 被${ownerLabel(outcome.bombColor, me)}${RANK_LABEL.bomb}炸掉`
    case 'fizzle':
      // 有煙無傷 (§5): the 爆裂物 is the piece removed, and 附錄 A(a) keeps BOTH
      // sides unrevealed — which is why this card still shows「？」. What the
      // survivor is, the 公開紀錄 states in its own words; this card does not
      // speak for it, and nothing here narrows anything.
      return `接觸於 ${contact} 有煙無傷 — ${ownerLabel(deadColorOf(rec), me)}${
        RANK_LABEL.bomb
      }落敗移除（不翻明）`
  }
}

function shortCarrier(p: ViewerPiece): string {
  return CARRIER_LABEL[p.carrier].split(' ')[0]
}

/**
 * Hover text. The 兵種 half is the payload; the event half is the very sentence
 * the 公開紀錄 panel shows for that ply, quoted rather than re-derived.
 */
function describe(p: ViewerPiece, rec: CaptureRecord | undefined, me: Color | null): string {
  const who = COLOR_LABEL[p.color]
  const carrier = CARRIER_LABEL[p.carrier]
  const head = `${who} ${carrier}　${p.rank ? RANK_LABEL[p.rank] : '兵種未公開'}`
  if (rec === undefined) return head
  const ev = rec.event
  const record = ev.combat
    ? `${moveText(ev.move, true, ev.promoted)}｜${combatText(ev.combat.outcome, ev.color)}`
    : moveText(ev.move, false, ev.promoted)
  return `${head}\n第 ${rec.ply} 手 公開紀錄：${record}\n${captureLine(rec, me)}`
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
.xy-cap-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 38vh;
  overflow: auto;
}
.xy-cap-entry { list-style: none; }
.xy-cap-entry + .xy-cap-entry { margin-top: 4px; }
.xy-cap-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 7px;
  padding: 4px 6px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  opacity: 0.94;
}
.xy-cap-face { grid-column: 1; grid-row: 1 / span 2; }
.xy-cap .glyph { font-size: 1.45rem; }
.xy-cap-rank {
  grid-column: 2;
  grid-row: 1;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--fg);
}
.xy-cap-unknown { color: var(--muted); font-weight: 400; }
.xy-cap-marks {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
/* the player's own handwriting: bracketed, dashed and italic, so a guess can
   never be misread as a 系統翻明 fact (§10) */
.xy-cap-mark {
  font-size: 0.74rem;
  font-style: italic;
  padding: 0 3px;
  border: 1px dashed var(--accent);
  border-radius: 4px;
  color: var(--accent);
  background: rgba(110, 193, 255, 0.08);
  line-height: 1.35;
  white-space: nowrap;
  cursor: pointer;
}
.xy-cap-mark:hover { text-decoration: line-through; }
.xy-cap-edit {
  grid-column: 3;
  grid-row: 1;
  font-size: 0.72rem;
  padding: 1px 6px;
  line-height: 1.3;
}
.xy-cap-edit-on { border-color: var(--accent); color: var(--accent); }
.xy-cap-line {
  grid-column: 2 / span 2;
  grid-row: 2;
  font-size: 0.72rem;
  line-height: 1.35;
}
.xy-cap-note { margin: 8px 0 0; }
`
