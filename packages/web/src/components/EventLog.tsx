import { useEffect, useRef } from 'react'
import type { GameEvent } from '@xiyang/rules'
import { COLOR_LABEL } from '../constants.js'
import { eventLine } from '../format.js'

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
 */

export interface EventLogProps {
  log: readonly GameEvent[]
}

export function EventLog({ log }: EventLogProps) {
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [log.length])

  return (
    <section className="log panel">
      <h2>公開紀錄</h2>
      <div className="log-scroll">
        {log.length === 0 && <p className="muted small">尚無紀錄。</p>}
        <ol className="log-list">
          {log.map((ev) => {
            const line = eventLine(ev)
            return (
              <li
                key={ev.ply}
                className={`log-item log-${ev.color}`}
                // The full sentence stays reachable on hover. The compact line
                // is for reading at a glance; this is for settling a question.
                title={
                  [line.combat, line.enPassant ? 'en passant' : null, line.promoted]
                    .filter(Boolean)
                    .join('；') || undefined
                }
              >
                <span className="log-ply">{line.ply}</span>
                <span className={`log-color log-color-${ev.color}`}>
                  {COLOR_LABEL[ev.color]}
                  {line.tags.mover && <b className="log-tag">（{line.tags.mover}）</b>}
                </span>
                <span className="log-move">
                  {line.move}
                  {line.tags.target && <b className="log-tag">（{line.tags.target}）</b>}
                  {line.enPassant && <i className="log-flag">e.p.</i>}
                  {line.promoted && <i className="log-flag">↑</i>}
                </span>
                <span className="log-score">{line.score}</span>
              </li>
            )
          })}
        </ol>
        <div ref={endRef} />
      </div>
    </section>
  )
}
