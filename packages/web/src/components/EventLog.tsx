import { useEffect, useRef } from 'react'
import type { GameEvent } from '@xiyang/rules'
import { COLOR_LABEL } from '../constants.js'
import { eventLine } from '../format.js'
import { fill, useLang, type Strings } from '../i18n.js'

/**
 * The public event record (gamebook §10 — 紀錄給，解算不給). Every line here is
 * a restatement of something the server already announced to both sides. No
 * candidate-rank set is ever shown to a player; reading the board is the game.
 *
 * A contact line may legitimately carry NO tag on either side: a mutual
 * destruction announces neither a rank nor a colour, because 同階雙亡 and a
 * 爆裂物 are deliberately one indistinguishable event. Do not "repair" that with
 * a badge naming one of them — 「同階雙亡」 next to such a line is a claim the
 * server never made, and a false one half the time. What that line legitimately
 * shows is what the board shows: both pieces went. The hover sentence
 * (`combatText`) states the ambiguity in words.
 *
 * ── The record as a means of NAVIGATION (replay) ───────────────────────────
 *
 * Once the game is over the board becomes steppable, and this panel becomes the
 * index into it: `currentPly` marks the row the board is showing and `onSelectPly`
 * jumps there. "What did the board look like when that happened" is the question
 * a log is read to answer, and until now the answer was to count rows by hand.
 *
 * THE WHOLE LOG STAYS ON SCREEN, INCLUDING ROWS AFTER THE CURRENT ONE, and that
 * is not a leak: every `GameEvent` is public by construction (techspec §3) and
 * carries only what §4.3 says is announced out loud, so no row here holds a 兵種
 * that was not announced at that ply to everybody. It is nevertheless the
 * FUTURE relative to the position on the board, so those rows are dimmed and the
 * caption says so — otherwise a viewer replaying one side's knowledge would read
 * the not-yet-happened as part of what that side knew. What the board shows is
 * entitlement; what this panel shows is the record. They are different questions
 * and the dimming is where the difference is drawn.
 */

const STR = {
  zh: {
    title: '公開紀錄',
    hint: ' · 點一列跳到那一手',
    empty: '尚無紀錄。',
    ariaJump: '跳到第 {{ply}} 手',
    openingWord: '開局',
    plyWord: '第 {{ply}} 手',
    footer: '棋盤停在{{position}}；淡色的是之後才發生的手。紀錄本身全程對所有人公開（規則書 §10.3），棋盤顯示的兵種才依視角而定。',
  },
  en: {
    title: 'Public record',
    hint: ' · click a row to jump to that move',
    empty: 'No moves yet.',
    ariaJump: 'Jump to move {{ply}}',
    openingWord: 'the opening',
    plyWord: 'move {{ply}}',
    footer:
      'The board is showing {{position}}; dimmed rows are moves that haven’t happened yet. The record itself is public to both players at all times (gamebook §10.3) — it’s the board that shows ranks according to viewpoint.',
  },
} satisfies Strings<'title' | 'hint' | 'empty' | 'ariaJump' | 'openingWord' | 'plyWord' | 'footer'>

export interface EventLogProps {
  log: readonly GameEvent[]
  /**
   * Replay only: the ply the board is currently showing. Its row is marked and
   * scrolled into view; later rows are dimmed as the future. `null` while the
   * board sits at the opening, before any move — every row is then the future.
   * Omit entirely during a live game.
   */
  currentPly?: number | null
  /**
   * Replay only: jump the board to a ply. Its presence is what makes the rows
   * interactive at all, so a live log stays plain text.
   */
  onSelectPly?: (ply: number) => void
}

export function EventLog({ log, currentPly, onSelectPly }: EventLogProps) {
  const { lang } = useLang()
  const s = STR[lang]
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const currentRef = useRef<HTMLLIElement | null>(null)

  const replaying = onSelectPly !== undefined
  /** at the opening frame nothing has been played, so everything is ahead */
  const atPly = currentPly ?? 0

  useEffect(() => {
    // Live: follow the tail, as before. Replay: follow the position instead —
    // the tail is where the game ended, not where the viewer is looking.
    if (!replaying) {
      endRef.current?.scrollIntoView({ block: 'nearest' })
      return
    }
    const box = scrollRef.current
    const row = currentRef.current
    if (box === null || row === null) return
    // Scrolls THIS panel and nothing else. `scrollIntoView` would walk every
    // scrollable ancestor including the document, which yanks the whole page
    // sideways each time you step a ply.
    const boxRect = box.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < boxRect.top) {
      box.scrollTop += rowRect.top - boxRect.top - 8
    } else if (rowRect.bottom > boxRect.bottom) {
      box.scrollTop += rowRect.bottom - boxRect.bottom + 8
    }
  }, [log.length, currentPly, replaying])

  return (
    <section className="log panel">
      <style>{STYLE}</style>
      <h2>
        {s.title}
        {replaying && <span className="muted xy-log-hint">{s.hint}</span>}
      </h2>
      <div className="log-scroll" ref={scrollRef}>
        {log.length === 0 && <p className="muted small">{s.empty}</p>}
        <ol className="log-list">
          {log.map((ev) => {
            const line = eventLine(ev, lang)
            const current = replaying && ev.ply === currentPly
            const future = replaying && ev.ply > atPly
            // The full sentence stays reachable on hover. The compact line
            // is for reading at a glance; this is for settling a question.
            const title =
              [line.combat, line.enPassant ? 'en passant' : null, line.promoted]
                .filter(Boolean)
                .join('；') || undefined
            const rowClass = [
              'log-item',
              `log-${ev.color}`,
              current ? 'xy-log-current' : '',
              future ? 'xy-log-future' : '',
            ]
              .filter(Boolean)
              .join(' ')

            const body = (
              <>
                <span className="log-ply">{line.ply}</span>
                <span className={`log-color log-color-${ev.color}`}>
                  {COLOR_LABEL[lang][ev.color]}
                  {line.tags.mover && <b className="log-tag">（{line.tags.mover}）</b>}
                </span>
                <span className="log-move">
                  {line.move}
                  {line.tags.target && <b className="log-tag">（{line.tags.target}）</b>}
                  {line.enPassant && <i className="log-flag">e.p.</i>}
                  {line.promoted && <i className="log-flag">↑</i>}
                </span>
                <span className="log-score">{line.score}</span>
              </>
            )

            return (
              <li
                key={ev.ply}
                className="xy-log-row"
                ref={current ? currentRef : undefined}
                aria-current={current ? 'true' : undefined}
              >
                {onSelectPly ? (
                  <button
                    type="button"
                    className={`${rowClass} xy-log-btn`}
                    title={title}
                    aria-label={fill(s.ariaJump, { ply: ev.ply })}
                    onClick={() => onSelectPly(ev.ply)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={rowClass} title={title}>
                    {body}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <div ref={endRef} />
      </div>
      {replaying && (
        <p className="muted small xy-log-foot">
          {fill(s.footer, {
            position: currentPly == null ? s.openingWord : fill(s.plyWord, { ply: currentPly }),
          })}
        </p>
      )}
    </section>
  )
}

/**
 * Scoped to this panel. The shared stylesheet owns `.log-item` and the tags;
 * only what the replay adds lives here, under an `xy-` prefix.
 */
const STYLE = `
.log .xy-log-hint { font-weight: 400; font-size: 0.82rem; }
.log .xy-log-row { list-style: none; }
/* a row that is also a jump target. .log-item still supplies the grid, the
   padding and the rule underneath; this only undoes what being a <button>
   would otherwise impose on it. */
.log .xy-log-btn {
  width: 100%;
  margin: 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 0;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.log .xy-log-btn:hover { background: rgba(255, 255, 255, 0.055); }
/* the same amber the board rings the current move with, so the two places
   marking「this ply」are visibly the same mark */
.log .xy-log-current {
  background: rgba(255, 232, 140, 0.13);
  box-shadow: inset 3px 0 0 #ffe88c;
}
.log .xy-log-btn.xy-log-current:hover { background: rgba(255, 232, 140, 0.2); }
/* ahead of the board. Public record, but not yet part of the position on
   screen — see the panel note. */
.log .xy-log-future { opacity: 0.42; }
.log .xy-log-btn.xy-log-future:hover { opacity: 0.75; }
.log .xy-log-foot { margin: 8px 0 0; line-height: 1.5; }
`
