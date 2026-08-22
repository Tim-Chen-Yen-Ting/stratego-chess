import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CombatOutcome, ExportOpponent, GameStats, ViewerState } from '@xiyang/rules'
import { exportJson, exportMarkdown, gameStats } from '@xiyang/rules'
import { colorLabel, formatScore, resultText } from '../format.js'
import { botPolicyLabel } from '../socket.js'
import type { BotSeat } from '../socket.js'
import { useLang, fill, type Strings } from '../i18n.js'
import type { Lang } from '../i18n.js'

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
 * many contacts happened, how many were announced 同歸於盡, how many of a side's
 * own 結算 paid nothing) and over the PUBLIC carrier layer (how many squares were
 * held, where moves landed, which piece moved — all on the board for both sides).
 * Those are facts about what was announced, not claims about who anyone is. No
 * figure here ranges over 兵種: none narrows a candidate set, none eliminates
 * one, and nothing here is a solver. The table shows the headline numbers only
 * — the full breakdown is in the blob below it, which is the point of having
 * the blob.
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

const STR = {
  zh: {
    exportButtonTitle: '匯出這局的公開紀錄（Markdown / JSON），可直接貼到別處分析',
    exportButtonLabel: '匯出紀錄',
    panelTitle: '匯出對局紀錄',
    plyLabel: '第 {{ply}} 手',
    inProgress: '進行中',
    close: '關閉',
    statsSummary: '統計摘要',
    komiApplied: '{{color}}貼目 +{{score}} 已計入比分',
    statsError: '統計無法產生：{{message}}',
    noStats: '尚無統計。',
    statsNote:
      '以上為公開紀錄的統計（發生過幾次接觸、幾次同歸於盡…），不是推論輔助。同歸於盡不分辨同階與爆裂物，兩者公告完全相同。',
    exportFormatLabel: '匯出格式',
    copy: '複製',
    selectAll: '全選',
    download: '下載 {{filename}}',
    copied: '已複製',
    manualCopy: '已全選 — 請按 Ctrl/Cmd + C',
    recordError: '紀錄無法產生：{{message}}',
    recordAriaLabel: '對局紀錄',
    footerCounts: '{{lines}} 行 · {{chars}} 字元 · {{filename}}',
    footerScopeBase: '內容僅來自此視角已可見的資訊（規則書 §10）',
    footerScopeOver: '。對局已結束，全部兵種公開，故此為完整棋譜。',
    footerScopeOngoing: '：未翻明的敵方兵種不在其中，系統亦不附任何推測。對局結束後匯出即為完整棋譜。',
    colWhite: '白方',
    colBlack: '黑方',
    rowPlies: '手數',
    rowContacts: '接觸次數',
    rowContactResults: '接觸結果',
    rowMutualPerContact: '同歸於盡／接觸',
    rowScore: '比分（含貼目）',
    rowEarned: '結算得分',
    rowCaptureShare: '① 吃子得分佔比',
    rowPointsPerPly: '每手得分',
    rowEarnedPerSettlement: '每次結算平均佔格',
    rowPeakSquares: '最高同時佔格',
    rowZeroSettlements: '零分結算',
    rowLongestZeroRun: '最長零分連續（自身結算）',
    rowObjectiveMoves: '落點在計分格的手數',
    rowDistinctPieces: '動過的棋子數',
    rowLongestSingleRun: '單子連續移動最長',
    rowBombsKnown: '爆裂物已知損失（僅有煙無傷）',
    rowBombsActual: '爆裂物實際損失（終局才可得）',
    bombsActualPending: '終局後才可得',
    plyListPrefix: '第 {{plies}} 手',
  },
  en: {
    exportButtonTitle: 'Export this game’s public record (Markdown / JSON) — paste it elsewhere for analysis',
    exportButtonLabel: 'Export record',
    panelTitle: 'Export Game Record',
    plyLabel: 'Ply {{ply}}',
    inProgress: 'In progress',
    close: 'Close',
    statsSummary: 'Summary stats',
    komiApplied: '{{color}} komi +{{score}} already included in the score',
    statsError: 'Could not generate stats: {{message}}',
    noStats: 'No stats yet.',
    statsNote:
      'These are statistics over the public record (how many contacts occurred, how many were mutual destruction…), not an inference aid. Mutual destruction does not distinguish an equal-rank tie from a bomb — both are announced identically.',
    exportFormatLabel: 'Export format',
    copy: 'Copy',
    selectAll: 'Select all',
    download: 'Download {{filename}}',
    copied: 'Copied',
    manualCopy: 'Selected — press Ctrl/Cmd + C',
    recordError: 'Could not generate record: {{message}}',
    recordAriaLabel: 'Game record',
    footerCounts: '{{lines}} lines · {{chars}} characters · {{filename}}',
    footerScopeBase: 'Content is limited to what this viewpoint can already see (gamebook §10)',
    footerScopeOver: '. The game is over, every rank is disclosed, so this is the complete game record.',
    footerScopeOngoing:
      ': the enemy’s undisclosed ranks are not included, and the system attaches no guesses. Exporting after the game ends produces the complete record.',
    colWhite: 'White',
    colBlack: 'Black',
    rowPlies: 'Plies',
    rowContacts: 'Contacts',
    rowContactResults: 'Contact outcomes',
    rowMutualPerContact: 'Mutual destruction / contacts',
    rowScore: 'Score (incl. komi)',
    rowEarned: 'Points earned',
    rowCaptureShare: '① Share earned from captures',
    rowPointsPerPly: 'Points per ply',
    rowEarnedPerSettlement: 'Avg. squares held per settlement',
    rowPeakSquares: 'Peak squares held at once',
    rowZeroSettlements: 'Zero-point settlements',
    rowLongestZeroRun: 'Longest zero-point streak (own settlements)',
    rowObjectiveMoves: 'Plies landing on a scoring square',
    rowDistinctPieces: 'Distinct pieces moved',
    rowLongestSingleRun: 'Longest single-piece move streak',
    rowBombsKnown: 'Known bomb losses (fizzle only)',
    rowBombsActual: 'Actual bomb losses (available only after the game ends)',
    bombsActualPending: 'Available after the game ends',
    plyListPrefix: 'ply {{plies}}',
  },
} satisfies Strings<
  | 'exportButtonTitle'
  | 'exportButtonLabel'
  | 'panelTitle'
  | 'plyLabel'
  | 'inProgress'
  | 'close'
  | 'statsSummary'
  | 'komiApplied'
  | 'statsError'
  | 'noStats'
  | 'statsNote'
  | 'exportFormatLabel'
  | 'copy'
  | 'selectAll'
  | 'download'
  | 'copied'
  | 'manualCopy'
  | 'recordError'
  | 'recordAriaLabel'
  | 'footerCounts'
  | 'footerScopeBase'
  | 'footerScopeOver'
  | 'footerScopeOngoing'
  | 'colWhite'
  | 'colBlack'
  | 'rowPlies'
  | 'rowContacts'
  | 'rowContactResults'
  | 'rowMutualPerContact'
  | 'rowScore'
  | 'rowEarned'
  | 'rowCaptureShare'
  | 'rowPointsPerPly'
  | 'rowEarnedPerSettlement'
  | 'rowPeakSquares'
  | 'rowZeroSettlements'
  | 'rowLongestZeroRun'
  | 'rowObjectiveMoves'
  | 'rowDistinctPieces'
  | 'rowLongestSingleRun'
  | 'rowBombsKnown'
  | 'rowBombsActual'
  | 'bombsActualPending'
  | 'plyListPrefix'
>

/**
 * Every announced contact kind, spelled short. Typed as a total Record over the
 * union, so a new CombatOutcome variant fails to compile here rather than
 * silently vanishing from the summary — the same discipline record.ts uses.
 */
// ONE label for all three both-die contacts — 同階雙亡, 爆裂物引爆 and
// 爆裂物對爆 share a single contentless announcement (規則書 §4.3), and the
// record must not name a distinction the event does not carry.
const OUTCOME_SHORT: Strings<CombatOutcome['kind']> = {
  zh: {
    'attacker-wins': '攻方勝',
    'defender-wins': '守方勝',
    'mutual-destruction': '同歸於盡',
    fizzle: '有煙無傷',
  },
  en: {
    'attacker-wins': 'attacker wins',
    'defender-wins': 'defender wins',
    'mutual-destruction': 'mutual destruction',
    fizzle: 'fizzle',
  },
}

const OUTCOME_KINDS = Object.keys(OUTCOME_SHORT.zh) as CombatOutcome['kind'][]

/** Counts print plain; rates keep three decimals, trailing zeros trimmed. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1000) / 1000)
}

/**
 * `2 / 9（22%）` — both terms always, because the percentage alone misleads:
 * "22%" reads the same at 2-of-9 and at 220-of-1000, and notebook §6.4 records
 * two games already argued about on the strength of a ratio with no
 * denominator. A `null` ratio (empty denominator) prints as —, never 0%.
 */
function fractionText(top: number, bottom: number, ratio: number | null): string {
  const pct = ratio === null ? '—' : `${Math.round(ratio * 100)}%`
  return `${top} / ${bottom}（${pct}）`
}

const PLY_UNIT: Record<Lang, string> = { zh: '手', en: 'ply' }

/** `5 手（第 12 手起）` — a streak is worth little without where it started. */
function runText(run: { length: number; startPly: number | null }, lang: Lang): string {
  if (run.length === 0) return '—'
  if (lang === 'zh') {
    return run.startPly === null ? `${run.length} 手` : `${run.length} 手（第 ${run.startPly} 手起）`
  }
  return run.startPly === null
    ? `${run.length} ${PLY_UNIT.en}`
    : `${run.length} ${PLY_UNIT.en} (starting ply ${run.startPly})`
}

/** `6 格（第 19 手）` — the high-water mark, and the ply it was reached on. */
function peakText(peak: { count: number; ply: number | null }, lang: Lang): string {
  if (peak.count === 0) return '—'
  if (lang === 'zh') {
    return peak.ply === null ? `${peak.count} 格` : `${peak.count} 格（第 ${peak.ply} 手）`
  }
  return peak.ply === null
    ? `${peak.count} squares`
    : `${peak.count} squares (ply ${peak.ply})`
}

// ---------------------------------------------------------------------------

export interface ExportButtonProps {
  onClick: () => void
  /** once the game is over this is the button that will actually be used */
  prominent?: boolean
}

/**
 * The trigger. Lives in the game screen; the panel below is what it opens.
 *
 * It carries NO `<style>`. The game screen mounts this button in two places at
 * once (a prominent one at 終局 plus the one in the toolbar), so injecting the
 * panel's stylesheet here put two or three identical ~150-line copies of it in
 * the DOM at the same time. `STYLE` now ships with `ExportPanel` alone — one
 * copy, and only while the panel is actually open. The one declaration this
 * button needed for itself is inline, so it does not depend on the panel being
 * open to look right.
 */
export function ExportButton({ onClick, prominent = false }: ExportButtonProps) {
  const { lang } = useLang()
  const s = STR[lang]
  return (
    <button
      type="button"
      className={prominent ? 'primary big xy-ex-open' : 'xy-ex-open'}
      style={{ whiteSpace: 'nowrap' }}
      onClick={onClick}
      title={s.exportButtonTitle}
    >
      {s.exportButtonLabel}
    </button>
  )
}

export interface ExportPanelProps {
  /** the state this screen already has — already redacted (gamebook §10) */
  view: ViewerState
  /**
   * Who the other chair holds, if this screen already knows — the same value
   * `Game.tsx` resolves for its own thinking-indicator UI (`readBotSeat(view)
   * ?? confirmedBot`). Recording it was a manual step until now: five games in
   * a row were filed by hand-typing the opponent from memory, and 007–010 were
   * once misfiled entirely because that memory was wrong. `null` for a
   * human-vs-human game or when this screen genuinely does not know — the
   * export then reads exactly as it did before this prop existed.
   */
  bot: BotSeat | null
  onClose: () => void
}

type CopyKind = 'idle' | 'done' | 'manual'

export function ExportPanel({ view, bot, onClose }: ExportPanelProps) {
  const { lang } = useLang()
  const s = STR[lang]
  const [format, setFormat] = useState<ExportFormat>('markdown')
  // `n` gives every click a fresh identity, so the 已複製 timer restarts on a
  // second copy instead of expiring on the first one's schedule.
  const [copy, setCopy] = useState<{ kind: CopyKind; n: number }>({ kind: 'idle', n: 0 })
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  // narrowed once: `status.result` only exists on the 'over' variant
  const result = view.status.kind === 'over' ? view.status.result : null

  /**
   * `@xiyang/rules` does not know what a policy id means — that registry is
   * this package's (`botPolicyLabel`) — so the label is resolved HERE and
   * handed down as a plain string. `bot.policy` can be `''` when the source
   * named a bot but not which one (`readBotSeat`'s contract); `botPolicyLabel`
   * already renders that as 「機器人」 rather than an empty string.
   */
  const opponent = useMemo<ExportOpponent | null>(
    () => (bot === null ? null : { color: bot.color, label: botPolicyLabel(bot.policy, lang) }),
    [bot, lang],
  )

  /**
   * The record itself. Everything downstream of these two calls is display; if
   * one of them throws, the panel says so instead of taking the screen down —
   * the owner is mid-analysis and losing the board would be worse than a
   * message.
   */
  const rendered = useMemo<{ text: string; error: string | null }>(() => {
    try {
      const text =
        format === 'markdown'
          ? exportMarkdown(view, opponent)
          : JSON.stringify(exportJson(view, opponent), null, 2)
      return { text, error: null }
    } catch (err) {
      return { text: '', error: err instanceof Error ? err.message : String(err) }
    }
  }, [view, format, opponent])

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
            {s.panelTitle}
          </h2>
          <div className="muted small xy-ex-sub">
            <code>{view.id}</code> · {fill(s.plyLabel, { ply: view.ply })} ·{' '}
            {result === null ? s.inProgress : resultText(result, lang)}
          </div>
          <button type="button" className="xy-ex-close" onClick={onClose} aria-label={s.close}>
            ✕
          </button>
        </header>

        <div className="xy-ex-body">
          {/* ---- headline numbers, readable without parsing the blob ---- */}
          <section className="xy-ex-stats-wrap">
            <div className="xy-ex-stats-head">
              <span>{s.statsSummary}</span>
              {/* the score row below already carries 貼目 — say so once, here */}
              <span className="muted small">
                {fill(s.komiApplied, {
                  color: colorLabel('black', lang),
                  score: formatScore(view.config.komi),
                })}
              </span>
            </div>
            {stats.error !== null ? (
              <p className="error small">{fill(s.statsError, { message: stats.error })}</p>
            ) : stats.value === null ? (
              <p className="muted small">{s.noStats}</p>
            ) : (
              <StatsTable stats={stats.value} lang={lang} />
            )}
            <p className="muted small xy-ex-note">{s.statsNote}</p>
          </section>

          {/* ---- format toggle + actions ---- */}
          <div className="xy-ex-bar">
            <div className="xy-ex-toggle" role="group" aria-label={s.exportFormatLabel}>
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
                {s.copy}
              </button>
              <button type="button" onClick={selectAll} disabled={text === ''}>
                {s.selectAll}
              </button>
              <button type="button" onClick={onDownload} disabled={text === ''}>
                {fill(s.download, { filename })}
              </button>
              <span className="xy-ex-copied" role="status" aria-live="polite">
                {copy.kind === 'done' && <span className="xy-ex-ok">{s.copied}</span>}
                {copy.kind === 'manual' && <span className="xy-ex-manual">{s.manualCopy}</span>}
              </span>
            </div>
          </div>

          {/* ---- the blob ---- */}
          {rendered.error !== null && (
            <p className="error small">{fill(s.recordError, { message: rendered.error })}</p>
          )}
          <textarea
            ref={areaRef}
            className="xy-ex-text"
            readOnly
            spellCheck={false}
            wrap="off"
            value={text}
            aria-label={s.recordAriaLabel}
          />

          <p className="muted small xy-ex-foot">
            {fill(s.footerCounts, { lines: lineCount, chars: text.length, filename })}
            <br />
            {s.footerScopeBase}
            {result !== null ? s.footerScopeOver : s.footerScopeOngoing}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The headline numbers: game-wide rows spanning both columns, then one column
 * per side. Every figure is a count or a rate over the PUBLIC log and the
 * PUBLIC carrier layer — how many squares a side held, where its moves landed,
 * how many of its pieces it has moved. What happened, not who anyone is
 * (gamebook §10); no row here is about a 兵種, hidden or otherwise. The per-ply
 * detail behind these totals is in the exported record itself, which is the
 * point of the blob.
 */
function StatsTable({ stats, lang }: { stats: GameStats; lang: Lang }) {
  const s = STR[lang]
  const w = stats.sides.white
  const b = stats.sides.black
  const outcomes = OUTCOME_KINDS.filter((kind) => stats.contactsByOutcome[kind] > 0)

  return (
    <table className="xy-ex-stats">
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">{s.colWhite}</th>
          <th scope="col">{s.colBlack}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">{s.rowPlies}</th>
          <td colSpan={2}>{stats.pliesPlayed}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowContacts}</th>
          <td colSpan={2}>{stats.contacts}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowContactResults}</th>
          <td colSpan={2}>
            {outcomes.length === 0
              ? '—'
              : outcomes
                  .map((kind) => `${OUTCOME_SHORT[lang][kind]} ${stats.contactsByOutcome[kind]}`)
                  .join(' · ')}
          </td>
        </tr>
        {/* 同歸於盡 over ALL contacts — not the old 同階雙亡／階級對決 rate.
            The numerator now also holds every 爆裂物 contact and the denominator
            can no longer exclude them, so this figure runs higher and must not
            be read against the old ~18% expectation. */}
        <tr>
          <th scope="row">{s.rowMutualPerContact}</th>
          <td colSpan={2}>
            {fractionText(
              stats.mutualDestruction.mutual,
              stats.mutualDestruction.contests,
              stats.mutualDestruction.ratio,
            )}
          </td>
        </tr>
        <tr>
          <th scope="row">{s.rowScore}</th>
          <td>{num(w.score)}</td>
          <td>{num(b.score)}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowEarned}</th>
          <td>{num(w.earned)}</td>
          <td>{num(b.earned)}</td>
        </tr>
        {/* 打（吃子，①）／囤（佔格，②）的比例，直接算出來。分母是上一列的
            「結算得分」（＝①＋②），跟匯出區塊 markdown 的「① share」是同一個數，
            只是這裡不展開①②兩個原始數字——面板本來就只留標題數字，細節在下面
            的匯出文字裡。分母為 0（尚未得分）時 fractionText 印出 —，不是 0%。 */}
        <tr>
          <th scope="row">{s.rowCaptureShare}</th>
          <td>
            {fractionText(w.earnedFromCaptures, w.earned, w.earned > 0 ? w.earnedFromCaptures / w.earned : null)}
          </td>
          <td>
            {fractionText(b.earnedFromCaptures, b.earned, b.earned > 0 ? b.earnedFromCaptures / b.earned : null)}
          </td>
        </tr>
        {/* 每手得分 keeps GAME LENGTH as its denominator — it is the rate 分數線
            X is checked against. Under mover-only 結算 a side is credited on
            half the plies, so it runs at about half the mean below; the two are
            different measurements, not the same one twice. */}
        <tr>
          <th scope="row">{s.rowPointsPerPly}</th>
          <td>{num(w.pointsPerPly)}</td>
          <td>{num(b.pointsPerPly)}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowEarnedPerSettlement}</th>
          <td>{num(w.earnedPerSettlement)}</td>
          <td>{num(b.earnedPerSettlement)}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowPeakSquares}</th>
          <td>{peakText(w.peakSquaresHeld, lang)}</td>
          <td>{peakText(b.peakSquaresHeld, lang)}</td>
        </tr>
        {/* Own 結算, not plies: §7 settles after every ply but credits only the
            mover, so every opponent ply is a structural zero for this side and
            counting them would bury a real drought under an artefact. */}
        <tr>
          <th scope="row">{s.rowZeroSettlements}</th>
          <td>{fractionText(w.zeroSettlements, w.settlements, zeroRate(w))}</td>
          <td>{fractionText(b.zeroSettlements, b.settlements, zeroRate(b))}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowLongestZeroRun}</th>
          <td>{runText(w.longestZeroRun, lang)}</td>
          <td>{runText(b.longestZeroRun, lang)}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowObjectiveMoves}</th>
          <td>
            {fractionText(w.objectiveMoves.count, w.objectiveMoves.total, w.objectiveMoves.ratio)}
          </td>
          <td>
            {fractionText(b.objectiveMoves.count, b.objectiveMoves.total, b.objectiveMoves.ratio)}
          </td>
        </tr>
        <tr>
          <th scope="row">{s.rowDistinctPieces}</th>
          <td>{w.distinctPiecesMoved}</td>
          <td>{b.distinctPiecesMoved}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowLongestSingleRun}</th>
          <td>{runText(w.longestSinglePieceRun, lang)}</td>
          <td>{runText(b.longestSinglePieceRun, lang)}</td>
        </tr>
        {/* TWO bomb rows, and the top one is a FLOOR. 同歸於盡 announces nothing,
            so a 爆裂物 that worked never appears in the log at all; only 有煙無傷
            still names one. The true count exists only at 終局, where §10.5 has
            already opened every 兵種 to every viewer. */}
        <tr>
          <th scope="row">{s.rowBombsKnown}</th>
          <td title={plyListText(w.bombsLost.knownPlies, lang)}>{w.bombsLost.known}</td>
          <td title={plyListText(b.bombsLost.knownPlies, lang)}>{b.bombsLost.known}</td>
        </tr>
        <tr>
          <th scope="row">{s.rowBombsActual}</th>
          <td>{bombsActualText(w.bombsLost.actual, lang)}</td>
          <td>{bombsActualText(b.bombsLost.actual, lang)}</td>
        </tr>
      </tbody>
    </table>
  )
}

/** Tooltip for a bomb count: which plies announced one. All 有煙無傷. */
function plyListText(plies: readonly number[], lang: Lang): string | undefined {
  if (plies.length === 0) return undefined
  return fill(STR[lang].plyListPrefix, { plies: plies.join(lang === 'zh' ? '、' : ', ') })
}

/**
 * The true 爆裂物 loss, or an explicit "not yet". Never a 0 — a blank count and
 * a count of zero are different claims, and printing the second for the first
 * would say the side still holds every bomb it started with.
 */
function bombsActualText(actual: number | null, lang: Lang): string {
  return actual === null ? STR[lang].bombsActualPending : String(actual)
}

/** Share of a side's OWN 結算 that credited nothing; null when it never settled. */
function zeroRate(s: { zeroSettlements: number; settlements: number }): number | null {
  return s.settlements === 0 ? null : s.zeroSettlements / s.settlements
}

/**
 * Scoped to this component (the shared stylesheet is owned elsewhere), under an
 * `xy-ex-` prefix. Same vocabulary as the rest of the app: dark panel, one line
 * colour, accent for the live thing.
 *
 * Mounted by `ExportPanel` and nowhere else — every selector below describes
 * something inside the open dialog, so the whole sheet enters and leaves with
 * it, exactly once.
 */
const STYLE = `
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
.xy-ex-stats td {
  width: 28%;
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
  /* row labels only: 落點在計分格的手數 is wider than a phone can spare beside
     two value columns, and a wrapped label beats a sideways scroll. The header
     row keeps its nowrap — 白方 / 黑方 are two characters. */
  .xy-ex-stats tbody th { white-space: normal; }
}
`
