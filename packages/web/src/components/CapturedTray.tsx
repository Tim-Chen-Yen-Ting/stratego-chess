import { useState } from 'react'
import type { Color, PieceId, Rank, ViewerPiece } from '@xiyang/rules'
import { CARRIER_GLYPH, CARRIER_LABEL, COLOR_LABEL, RANK_LABEL } from '../constants.js'
import { combatText, moveText, other, squareName } from '../format.js'
import type { CaptureRecord } from '../store.js'
import { fill, useLang, type Lang, type Strings } from '../i18n.js'
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
 * dead pieces always carry one, an enemy dead piece carries one only if it was
 * already 翻明 while it stood on the board (§4 — winning a fight is the only way
 * that happens), and at game end everything is open (§10.5). `rank === null`
 * renders no fact — a missing label is itself public information (the loser is
 * never revealed, §4).
 *
 * No killing event reveals anything any more: mutual destruction is a single
 * announcement covering both 同階雙亡 and 爆裂物, and it names neither piece. So
 * a piece removed that way shows 「？」 for the rest of the game, exactly like a
 * piece that simply lost. That is the point — an enemy who trades into you must
 * not be able to tell which of the two it met, and must not be able to count
 * your 爆裂物 down to zero. Do not add a range, a hint, or a 「至少是…」 here.
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

const STR = {
  zh: {
    title: '已離場棋子',
    noneYet: '尚無棋子離場。',
    you: '（你）',
    none: '—',
    removeMarkTitle: '移除「{{rank}}」（我的標記）',
    removeMarkAria: '移除標記 {{rank}}',
    markTitle: '寫下我的猜測（系統不驗證、不推論）',
    markAria: '標記這顆已離場的{{carrier}}',
    markButton: '標記',
    pickerTitlePly: '第 {{ply}} 手離場',
    pickerTitleUnknown: '已離場',
    lineWithPly: '第 {{ply}} 手 · {{line}}',
    lineUnknown: '離場紀錄不明',
    noteBefore: '每一列是當時的',
    noteBold: '公開公告',
    noteAfter:
      '，只是搬到棋子旁邊。「？」＝該子的兵種未公開；本畫面不推測、不列可能範圍、不計算剩餘（規則書 §10）。〔　〕為你自己寫的猜測，點一下可擦掉。',
    ownerColor: '{{color}}方的',
    ownerMine: '你的',
    ownerOpponent: '對方的',
    plainRemoved: '離場',
    attackerWinsLine: '於 {{here}} 被{{owner}}{{rank}}吃掉',
    defenderWinsLine: '由 {{here}} 攻擊 {{contact}} 落敗 — {{owner}}{{rank}}守住並翻明',
    mutualLine: '接觸於 {{contact}} 雙方同時移除 — 同階或爆裂物，公開紀錄不區分（雙方兵種皆不公開）',
    fizzleLine: '接觸於 {{contact}} 有煙無傷 — {{owner}}{{bomb}}落敗移除（不翻明）',
    rankUndisclosed: '兵種未公開',
    logLine: '第 {{ply}} 手 公開紀錄：{{record}}',
  },
  en: {
    title: 'Captured pieces',
    noneYet: 'No pieces have left the board yet.',
    you: ' (you)',
    none: '—',
    removeMarkTitle: 'Remove “{{rank}}” (my mark)',
    removeMarkAria: 'Remove mark {{rank}}',
    markTitle: 'Write down my guess (the system does not verify or infer)',
    markAria: 'Mark this captured {{carrier}}',
    markButton: 'Mark',
    pickerTitlePly: 'Left on move {{ply}}',
    pickerTitleUnknown: 'Left the board',
    lineWithPly: 'Move {{ply}} · {{line}}',
    lineUnknown: 'No removal record',
    noteBefore: 'Each line is the ',
    noteBold: 'public announcement',
    noteAfter:
      ' from the moment it happened, just moved next to the piece. “？” means that piece’s rank has not been disclosed; this panel never guesses, lists a candidate range, or counts down what remains (gamebook §10). 〔 〕 marks are your own guesses — click one to erase it.',
    ownerColor: '{{color}}’s',
    ownerMine: 'your',
    ownerOpponent: 'the opponent’s',
    plainRemoved: 'Left the board',
    attackerWinsLine: 'Captured at {{here}} by {{owner}} {{rank}}',
    defenderWinsLine:
      'Attacked from {{here}} into {{contact}} and lost — {{owner}} {{rank}} held its ground and was revealed',
    mutualLine:
      'Contact at {{contact}}, both removed simultaneously — an equal-rank tie or a bomb; the public record does not distinguish (neither side’s rank is disclosed)',
    fizzleLine: 'Contact at {{contact}}, fizzle — {{owner}} {{bomb}} was removed in the loss (not revealed)',
    rankUndisclosed: 'Rank undisclosed',
    logLine: 'Move {{ply}} public record: {{record}}',
  },
} satisfies Strings<
  | 'title'
  | 'noneYet'
  | 'you'
  | 'none'
  | 'removeMarkTitle'
  | 'removeMarkAria'
  | 'markTitle'
  | 'markAria'
  | 'markButton'
  | 'pickerTitlePly'
  | 'pickerTitleUnknown'
  | 'lineWithPly'
  | 'lineUnknown'
  | 'noteBefore'
  | 'noteBold'
  | 'noteAfter'
  | 'ownerColor'
  | 'ownerMine'
  | 'ownerOpponent'
  | 'plainRemoved'
  | 'attackerWinsLine'
  | 'defenderWinsLine'
  | 'mutualLine'
  | 'fizzleLine'
  | 'rankUndisclosed'
  | 'logLine'
>

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
  const { lang } = useLang()
  const s = STR[lang]
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
        <h2>{s.title}</h2>
        {dead.length === 0 ? (
          <p className="muted small">{s.noneYet}</p>
        ) : (
          SIDES.map((color) => {
            const list = dead.filter((p) => p.color === color).sort((a, b) => order(a) - order(b))
            return (
              <div className="xy-cap-side" key={color}>
                <div className="xy-cap-head">
                  {COLOR_LABEL[lang][color]}
                  {lang === 'zh' ? '方' : ''}
                  {me === color ? s.you : ''}
                  <span className="muted xy-cap-n">{list.length}</span>
                </div>
                {list.length === 0 ? (
                  <p className="muted small xy-cap-none">{s.none}</p>
                ) : (
                  <ul className="xy-cap-list">
                    {list.map((p) => {
                      const rec = captures.get(p.id)
                      const mine = marks[p.id] ?? []
                      const canMark = isAnnotatable(p, me)
                      const open = openId === p.id
                      return (
                        <li className="xy-cap-entry" key={p.id}>
                          <div className="xy-cap-item" title={describe(p, rec, me, lang)}>
                            <span
                              className={`piece xy-cap-face ${
                                p.color === 'white' ? 'piece-white' : 'piece-black'
                              }`}
                            >
                              <span className="glyph">{CARRIER_GLYPH[p.carrier]}</span>
                            </span>

                            {p.rank !== null ? (
                              <span className="xy-cap-rank">{RANK_LABEL[lang][p.rank]}</span>
                            ) : mine.length > 0 ? (
                              <span className="xy-cap-marks">
                                {mine.map((rank) => (
                                  <button
                                    type="button"
                                    key={rank}
                                    className="xy-cap-mark"
                                    onClick={() => onToggleMark(p.id, rank)}
                                    title={fill(s.removeMarkTitle, { rank: RANK_LABEL[lang][rank] })}
                                    aria-label={fill(s.removeMarkAria, { rank: RANK_LABEL[lang][rank] })}
                                  >
                                    〔{RANK_LABEL[lang][rank]}〕
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
                                title={s.markTitle}
                                aria-label={fill(s.markAria, {
                                  carrier: CARRIER_LABEL[lang][p.carrier],
                                })}
                              >
                                {s.markButton}
                              </button>
                            )}

                            <span className="muted small xy-cap-line">
                              {rec
                                ? fill(s.lineWithPly, { ply: rec.ply, line: captureLine(rec, me, lang) })
                                : s.lineUnknown}
                            </span>
                          </div>

                          {open && (
                            <RankPicker
                              title={`${
                                rec ? fill(s.pickerTitlePly, { ply: rec.ply }) : s.pickerTitleUnknown
                              } · ${shortCarrier(p, lang)}`}
                              marks={mine}
                              onToggle={(rank) => onToggleMark(p.id, rank)}
                              onClear={() => onClearMark(p.id)}
                              onClose={() => setOpenId(null)}
                              lang={lang}
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
          {s.noteBefore}
          <strong>{s.noteBold}</strong>
          {s.noteAfter}
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

function ownerLabel(color: Color, me: Color | null, lang: Lang): string {
  const s = STR[lang]
  if (me === null) return fill(s.ownerColor, { color: COLOR_LABEL[lang][color] })
  return color === me ? s.ownerMine : s.ownerOpponent
}

export function captureLine(rec: CaptureRecord, me: Color | null, lang: Lang): string {
  const s = STR[lang]
  const combat = rec.event.combat
  if (combat === undefined) return s.plainRemoved

  const { outcome, defenderSquare } = combat
  const mover = rec.event.color
  const here = squareName(rec.square)
  const contact = squareName(defenderSquare)

  switch (outcome.kind) {
    case 'attacker-wins':
      // this piece was standing there; the winner is 永久翻明 by announcement
      return fill(s.attackerWinsLine, {
        here,
        owner: ownerLabel(mover, me, lang),
        rank: RANK_LABEL[lang][outcome.winnerRank],
      })
    case 'defender-wins':
      // 攻方由其原格移除 (§4 位置結算) — this piece never entered the target
      return fill(s.defenderWinsLine, {
        here,
        contact,
        owner: ownerLabel(other(mover), me, lang),
        rank: RANK_LABEL[lang][outcome.winnerRank],
      })
    case 'mutual-destruction':
      // Both are removed, so 「接觸於」 rather than 「於」: the attacker died at
      // its own origin and never entered the contact square (§4 位置結算).
      //
      // 同階雙亡 and 爆裂物 are ONE announcement now, and it names nobody. This
      // card therefore states the removal and says outright that which kind it
      // was is not public — the piece it is attached to could be either half of
      // either story. Writing 「同階雙亡」 here would hand the reader a rank
      // equality the server never announced.
      return fill(s.mutualLine, { contact })
    case 'fizzle':
      // 有煙無傷 (§5): the 爆裂物 is the piece removed, and 附錄 A(a) keeps BOTH
      // sides unrevealed — which is why this card still shows「？」. What the
      // survivor is, the 公開紀錄 states in its own words; this card does not
      // speak for it, and nothing here narrows anything.
      return fill(s.fizzleLine, {
        contact,
        owner: ownerLabel(deadColorOf(rec), me, lang),
        bomb: RANK_LABEL[lang].bomb,
      })
  }
}

function shortCarrier(p: ViewerPiece, lang: Lang): string {
  return CARRIER_LABEL[lang][p.carrier].split(' ')[0]!
}

/**
 * Hover text. The 兵種 half is the payload; the event half is the very sentence
 * the 公開紀錄 panel shows for that ply, quoted rather than re-derived.
 */
function describe(p: ViewerPiece, rec: CaptureRecord | undefined, me: Color | null, lang: Lang): string {
  const s = STR[lang]
  const who = COLOR_LABEL[lang][p.color]
  const carrier = CARRIER_LABEL[lang][p.carrier]
  const head = `${who} ${carrier}　${p.rank ? RANK_LABEL[lang][p.rank] : s.rankUndisclosed}`
  if (rec === undefined) return head
  const ev = rec.event
  const record = ev.combat
    ? `${moveText(ev.move, true, lang, ev.promoted)}｜${combatText(ev.combat.outcome, ev.color, lang)}`
    : moveText(ev.move, false, lang, ev.promoted)
  return `${head}\n${fill(s.logLine, { ply: rec.ply, record })}\n${captureLine(rec, me, lang)}`
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
