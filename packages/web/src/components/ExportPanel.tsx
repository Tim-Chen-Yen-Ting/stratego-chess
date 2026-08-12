import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CombatOutcome, GameStats, TiesPerContest, ViewerState, ZeroRun } from '@xiyang/rules'
import { exportJson, exportMarkdown, gameStats } from '@xiyang/rules'
import { colorLabel, formatScore, resultText } from '../format.js'

/**
 * 匯出對局紀錄 — the record, in one selectable blob.
 *
 * WHY IT IS SAFE (gamebook §10 — 紀錄給，解算不給):
 *
 * This component receives the `ViewerState` the screen already holds. That
 * object has ALREADY been through `stateForViewer` on the server, so it
 * physically does not contain a 兵種 this viewer is not entitled to. The panel
 * fetches nothing, asks the server for nothing, and — just as importantly —
 * derives nothing: every character it renders comes back out of
 * `exportMarkdown` / `exportJson` / `gameStats` in @xiyang/rules, which are fed
 * that same redacted state. There is no path here by which a hidden rank could
 * enter the output, because there is no path here that reads a rank at all.
 *
 * The stats table is history, not inference: counts over the PUBLIC log (how
 * many contacts happened, how many were 同階雙亡, how many plies scored
 * nothing). Those are facts about what was announced, not claims about who
 * anyone is. Nothing here narrows a candidate set, and nothing here is a solver.
 * It shows the headline numbers only — the full breakdown is in the blob below
 * it, which is the point of having the blob.
 *
 * A finished game needs no special case: at 終局 the ViewerState carries every
 * rank (§10 終局公開全部兵種), so the very same code path exports the complete
 * game record with all 兵種 in it.
 *
 * THE TEXTAREA IS THE PRODUCT. `navigator.clipboard` is unavailable over plain
 * http, and rejects silently in a few embedded contexts. So the readonly
 * textarea — pre-selected on open — is the guaranteed path: worst case the
 * owner presses Ctrl/Cmd+C on an already-selected blob. The copy button and the
 * download button are conveniences layered on top of that, never a substitute.
 */

export type ExportFormat = 'markdown' | 'json'

/**
 * Every announced contact kind, spelled short. Typed as a total Record over the
 * union, so a new CombatOutcome variant fails to compile here rather than
 * silently vanishing from the summary — the same discipline record.ts uses.
 */
const OUTCOME_SHORT: Record<CombatOutcome['kind'], string> = {
  'attacker-wins': '攻方勝',
  'defender-wins': '守方勝',
  'mutual-rank': '同階雙亡',
  'bomb-detonate': '爆裂物引爆',
  'bomb-vs-bomb': '爆裂物對爆',
  fizzle: '有煙無傷',
}

const OUTCOME_KINDS = Object.keys(OUTCOME_SHORT) as CombatOutcome['kind'][]

/** Counts print plain; rates keep three decimals, trailing zeros trimmed. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1000) / 1000)
}

/** `2 / 9（22%）` — the fraction always, because the ratio alone misleads. */
function ratioText(t: TiesPerContest): string {
  const pct = t.ratio === null ? '—' : `${Math.round(t.ratio * 100)}%`
  return `${t.ties} / ${t.contests}（${pct}）`
}

function zeroRunText(run: ZeroRun): string {
  if (run.length === 0) return '—'
  return run.startPly === null ? `${run.length} 手` : `${run.length} 手（第 ${run.startPly} 手起）`
}

// ---------------------------------------------------------------------------

export interface ExportButtonProps {
  onClick: () => void
  /** once the game is over this is the button that will actually be used */
  prominent?: boolean
}

/** The trigger. Lives in the game screen; the panel below is what it opens. */
export function ExportButton({ onClick, prominent = false }: ExportButtonProps) {
  return (
    <>
      <style>{STYLE}</style>
      <button
        type="button"
        className={prominent ? 'primary big xy-ex-open' : 'xy-ex-open'}
        onClick={onClick}
        title="匯出這局的公開紀錄（Markdown / JSON），可直接貼到別處分析"
      >
        匯出紀錄
      </button>
    </>
  )
}

export interface ExportPanelProps {
  /** the state this screen already has — already redacted (gamebook §10) */
  view: ViewerState
  onClose: () => void
}

type CopyKind = 'idle' | 'done' | 'manual'

export function ExportPanel({ view, onClose }: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>('markdown')
  // `n` gives every click a fresh identity, so the 已複製 timer restarts on a
  // second copy instead of expiring on the first one's schedule.
  const [copy, setCopy] = useState<{ kind: CopyKind; n: number }>({ kind: 'idle', n: 0 })
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  // narrowed once: `status.result` only exists on the 'over' variant
  const result = view.status.kind === 'over' ? view.status.result : null

  /**
   * The record itself. Everything downstream of these two calls is display; if
   * one of them throws, the panel says so instead of taking the screen down —
   * the owner is mid-analysis and losing the board would be worse than a
   * message.
   */
  const rendered = useMemo<{ text: string; error: string | null }>(() => {
    try {
      const text =
        format === 'markdown' ? exportMarkdown(view) : JSON.stringify(exportJson(view), null, 2)
      return { text, error: null }
    } catch (err) {
      return { text: '', error: err instanceof Error ? err.message : String(err) }
    }
  }, [view, format])

  const stats = useMemo<{ value: GameStats | null; error: string | null }>(() => {
    try {
      return { value: gameStats(view), error: null }
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : String(err) }
    }
  }, [view])

  const text = rendered.text
  const lineCount = text === '' ? 0 : text.split('\n').length

  const safeId = view.id.replace(/[^A-Za-z0-9_-]+/g, '') || 'game'
  const filename = `xiyang-${safeId}.${format === 'markdown' ? 'md' : 'json'}`

  // esc closes, wherever focus happens to be
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Open (and every format switch) hands the owner a selected blob: Ctrl/Cmd+C
  // works before they touch anything, whatever the clipboard API is doing.
  useEffect(() => {
    const el = areaRef.current
    if (el === null) return
    el.focus()
    el.select()
  }, [format])

  useEffect(() => {
    if (copy.kind === 'idle') return
    const id = window.setTimeout(() => setCopy({ kind: 'idle', n: 0 }), 3000)
    return () => window.clearTimeout(id)
  }, [copy])

  const selectAll = useCallback(() => {
    const el = areaRef.current
    if (el === null) return
    el.focus()
    el.select()
  }, [])

  async function onCopy() {
    // select first: it makes the manual fallback immediate, and it is what
    // execCommand('copy') operates on
    selectAll()
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        setCopy((c) => ({ kind: 'done', n: c.n + 1 }))
        return
      }
    } catch {
      // blocked, insecure origin, or no permission — fall through
    }
    try {
      if (document.execCommand('copy')) {
        setCopy((c) => ({ kind: 'done', n: c.n + 1 }))
        return
      }
    } catch {
      // deprecated path also unavailable
    }
    setCopy((c) => ({ kind: 'manual', n: c.n + 1 }))
  }

  function onDownload() {
    const type =
      format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8'
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  function switchTo(next: ExportFormat) {
    setFormat(next)
    setCopy({ kind: 'idle', n: 0 })
  }

  return (
    <div
      className="xy-ex-backdrop"
      // click the dark area to dismiss; clicks inside the card do not reach here
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <style>{STYLE}</style>
      <div className="xy-ex-card" role="dialog" aria-modal="true" aria-labelledby="xy-ex-title">
        <header className="xy-ex-head">
          <h2 id="xy-ex-title" className="xy-ex-title">
            匯出對局紀錄
          </h2>
          <div className="muted small xy-ex-sub">
            <code>{view.id}</code> · 第 {view.ply} 手 ·{' '}
            {result === null ? '進行中' : resultText(result)}
          </div>
          <button type="button" className="xy-ex-close" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </header>

        <div className="xy-ex-body">
          {/* ---- headline numbers, readable without parsing the blob ---- */}
          <section className="xy-ex-stats-wrap">
            <div className="xy-ex-stats-head">
              <span>統計摘要</span>
              {/* the score row below already carries 貼目 — say so once, here */}
              <span className="muted small">
                {colorLabel('black')}貼目 +{formatScore(view.config.komi)} 已計入比分
              </span>
            </div>
            {stats.error !== null ? (
              <p className="error small">統計無法產生：{stats.error}</p>
            ) : stats.value === null ? (
              <p className="muted small">尚無統計。</p>
            ) : (
              <StatsTable stats={stats.value} />
            )}
            <p className="muted small xy-ex-note">
              以上為公開紀錄的統計（發生過幾次接觸、幾次同階雙亡…），不是推論輔助。
            </p>
          </section>

          {/* ---- format toggle + actions ---- */}
          <div className="xy-ex-bar">
            <div className="xy-ex-toggle" role="group" aria-label="匯出格式">
              <button
                type="button"
                className={format === 'markdown' ? 'xy-ex-tab xy-ex-tab-on' : 'xy-ex-tab'}
                aria-pressed={format === 'markdown'}
                onClick={() => switchTo('markdown')}
              >
                Markdown
              </button>
              <button
                type="button"
                className={format === 'json' ? 'xy-ex-tab xy-ex-tab-on' : 'xy-ex-tab'}
                aria-pressed={format === 'json'}
                onClick={() => switchTo('json')}
              >
                JSON
              </button>
            </div>

            <div className="xy-ex-actions">
              <button type="button" className="primary" onClick={onCopy} disabled={text === ''}>
                複製
              </button>
              <button type="button" onClick={selectAll} disabled={text === ''}>
                全選
              </button>
              <button type="button" onClick={onDownload} disabled={text === ''}>
                下載 {filename}
              </button>
              <span className="xy-ex-copied" role="status" aria-live="polite">
                {copy.kind === 'done' && <span className="xy-ex-ok">已複製</span>}
                {copy.kind === 'manual' && (
                  <span className="xy-ex-manual">已全選 — 請按 Ctrl/Cmd + C</span>
                )}
              </span>
            </div>
          </div>

          {/* ---- the blob ---- */}
          {rendered.error !== null && (
            <p className="error small">紀錄無法產生：{rendered.error}</p>
          )}
          <textarea
            ref={areaRef}
            className="xy-ex-text"
            readOnly
            spellCheck={false}
            wrap="off"
            value={text}
            aria-label="對局紀錄"
          />

          <p className="muted small xy-ex-foot">
            {lineCount} 行 · {text.length} 字元 · {filename}
            <br />
            內容僅來自此視角已可見的資訊（規則書 §10）
            {result !== null
              ? '。對局已結束，全部兵種公開，故此為完整棋譜。'
              : '：未翻明的敵方兵種不在其中，系統亦不附任何推測。對局結束後匯出即為完整棋譜。'}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The headline numbers: game-wide rows spanning both columns, then one column
 * per side. Every figure is a count or a rate over the PUBLIC log — what
 * happened, not who anyone is (gamebook §10). The per-ply detail behind these
 * totals is in the exported record itself, which is the point of the blob.
 */
function StatsTable({ stats }: { stats: GameStats }) {
  const w = stats.sides.white
  const b = stats.sides.black
  const outcomes = OUTCOME_KINDS.filter((kind) => stats.contactsByOutcome[kind] > 0)

  return (
    <table className="xy-ex-stats">
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">白方</th>
          <th scope="col">黑方</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">手數</th>
          <td colSpan={2}>{stats.pliesPlayed}</td>
        </tr>
        <tr>
          <th scope="row">接觸次數</th>
          <td colSpan={2}>{stats.contacts}</td>
        </tr>
        <tr>
          <th scope="row">接觸結果</th>
          <td colSpan={2}>
            {outcomes.length === 0
              ? '—'
              : outcomes
                  .map((kind) => `${OUTCOME_SHORT[kind]} ${stats.contactsByOutcome[kind]}`)
                  .join(' · ')}
          </td>
        </tr>
        <tr>
          <th scope="row">同階雙亡／接觸</th>
          <td colSpan={2}>{ratioText(stats.tiesPerContest)}</td>
        </tr>
        <tr>
          <th scope="row">比分（含貼目）</th>
          <td>{num(w.score)}</td>
          <td>{num(b.score)}</td>
        </tr>
        <tr>
          <th scope="row">結算得分</th>
          <td>{num(w.earned)}</td>
          <td>{num(b.earned)}</td>
        </tr>
        <tr>
          <th scope="row">每手得分</th>
          <td>{num(w.pointsPerPly)}</td>
          <td>{num(b.pointsPerPly)}</td>
        </tr>
        <tr>
          <th scope="row">每手佔分格</th>
          <td>{num(w.scoringSquaresPerPly)}</td>
          <td>{num(b.scoringSquaresPerPly)}</td>
        </tr>
        <tr>
          <th scope="row">零分手數</th>
          <td>{w.zeroPlies}</td>
          <td>{b.zeroPlies}</td>
        </tr>
        <tr>
          <th scope="row">最長零分連續</th>
          <td>{zeroRunText(w.longestZeroRun)}</td>
          <td>{zeroRunText(b.longestZeroRun)}</td>
        </tr>
        <tr>
          <th scope="row">爆裂物損失</th>
          <td title={plyListText(w.bombPlies)}>{w.bombsSpent}</td>
          <td title={plyListText(b.bombPlies)}>{b.bombsSpent}</td>
        </tr>
      </tbody>
    </table>
  )
}

/** Tooltip for a bomb count: which plies spent them. Announced, all of them. */
function plyListText(plies: readonly number[]): string | undefined {
  return plies.length === 0 ? undefined : `第 ${plies.join('、')} 手`
}

/**
 * Scoped to this component (the shared stylesheet is owned elsewhere), under an
 * `xy-ex-` prefix. Same vocabulary as the rest of the app: dark panel, one line
 * colour, accent for the live thing.
 */
const STYLE = `
.xy-ex-open { white-space: nowrap; }
.xy-ex-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: rgba(8, 9, 12, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.xy-ex-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  width: min(900px, 100%);
  max-height: min(880px, 92vh);
  display: flex;
  flex-direction: column;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
}
.xy-ex-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.xy-ex-title { margin: 0; color: var(--fg); font-size: 1.05rem; }
.xy-ex-sub { flex: 1 1 auto; overflow-wrap: anywhere; }
.xy-ex-close {
  flex: 0 0 auto;
  background: transparent;
  border: 0;
  color: var(--muted);
  padding: 0 4px;
  font-size: 1rem;
}
.xy-ex-close:hover { color: var(--fg); }
.xy-ex-body {
  padding: 12px 14px 14px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.xy-ex-stats-wrap {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
}
.xy-ex-stats-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 6px;
}
.xy-ex-stats {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}
.xy-ex-stats th {
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  padding: 2px 10px 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  white-space: nowrap;
}
.xy-ex-stats thead th {
  text-align: right;
  font-size: 0.75rem;
  padding: 0 0 2px;
  border-bottom: 1px solid var(--line);
}
.xy-ex-stats thead th:first-child { text-align: left; }
.xy-ex-stats td { width: 28%; }
.xy-ex-stats td {
  text-align: right;
  font-variant-numeric: tabular-nums;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  overflow-wrap: anywhere;
}
.xy-ex-stats tr:last-child th,
.xy-ex-stats tr:last-child td { border-bottom: 0; }
.xy-ex-note { margin: 6px 0 0; }
.xy-ex-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.xy-ex-toggle { display: flex; gap: 0; }
.xy-ex-tab { border-radius: 0; }
.xy-ex-tab:first-child { border-radius: 6px 0 0 6px; }
.xy-ex-tab:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
.xy-ex-tab-on {
  background: #2a4d6e;
  border-color: #3d6d97;
  position: relative;
  z-index: 1;
}
.xy-ex-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.xy-ex-copied { min-width: 4.5em; font-size: 0.82rem; }
.xy-ex-ok { color: var(--ok); font-weight: 600; }
.xy-ex-manual { color: var(--gold); }
.xy-ex-text {
  width: 100%;
  min-height: 260px;
  flex: 1 1 auto;
  resize: vertical;
  background: #0f1114;
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.45;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}
.xy-ex-text:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.xy-ex-foot { margin: 0; }
@media (max-width: 620px) {
  .xy-ex-bar { align-items: stretch; flex-direction: column; }
  .xy-ex-text { min-height: 180px; font-size: 0.75rem; }
}
`
