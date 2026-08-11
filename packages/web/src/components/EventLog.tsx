import { useEffect, useRef } from 'react'
import type { GameEvent } from '@xiyang/rules'
import { COLOR_LABEL } from '../constants.js'
import { eventLine } from '../format.js'

/**
 * The public event record (gamebook §10 — 紀錄給，解算不給). Every line here is
 * a restatement of something the server already announced to both sides. No
 * candidate-rank set is ever shown to a player; reading the board is the game.
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
              <li key={ev.ply} className={`log-item log-${ev.color}`}>
                <span className="log-ply">{line.ply}</span>
                <span className={`log-color log-color-${ev.color}`}>{COLOR_LABEL[ev.color]}</span>
                <span className="log-move">{line.move}</span>
                <span className="log-score">{line.score}</span>
                {(line.combat || line.promoted || line.enPassant) && (
                  <span className="log-detail">
                    {line.enPassant && <em>en passant　</em>}
                    {line.combat}
                    {line.combat && line.promoted ? '；' : ''}
                    {line.promoted}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
        <div ref={endRef} />
      </div>
    </section>
  )
}
