import { useState } from 'react'
import { DEFAULT_CONFIG } from '@xiyang/rules'
import type { Square } from '@xiyang/rules'
import type { CreatedGame } from '../socket.js'
import { SCORING_AREAS, SCORING_AREA_IDS, type ScoringAreaId } from '../constants.js'
import { formatClock, squareName } from '../format.js'
import { localizeUrl } from '../url.js'

/**
 * Create screen (techspec §7). A handful of settings, one POST /api/game, then
 * the two links the server issued: one to share with the opponent, one to enter
 * as host. There is no matchmaking and no lobby — invite links only (§0).
 *
 * Nothing here computes rules. The settings are transport: whatever the user
 * picks is handed to the server, which owns `GameConfig`; the screen never
 * validates or derives anything about the game itself (gamebook §10).
 */

type OpponentMode = 'human' | 'llm'

/** The subset of `GameConfig` this screen exposes. */
interface CreateOptions {
  clockEnabled: boolean
  scoreTarget: number
  noProgressTurns: number
  setupTimeoutMs: number
  /** 計分區 (gamebook §7, 附錄 B) — which squares score, for this game only. */
  scoringSquares: readonly Square[]
}

/**
 * Deploying against an LLM means relaying URLs through a chat window, which
 * takes far longer than a person dragging ranks onto a board. At the 3-minute
 * default the timer fires mid-conversation and the server rolls a RANDOM army
 * over the deployment the model was still choosing — silently, because a
 * random army looks exactly like a chosen one. So the untimed preset, which IS
 * the LLM preset, gets an hour.
 */
const SETUP_MINUTES_TIMED = Math.round(DEFAULT_CONFIG.setupTimeoutMs / 60_000)
const SETUP_MINUTES_UNTIMED = 60

const CLOCK_SUMMARY = `${formatClock(DEFAULT_CONFIG.clockInitialMs)} + ${Math.round(
  DEFAULT_CONFIG.clockIncrementMs / 1000,
)} 秒`

/** "d4 e4 d5 e5" — a plain listing of the chosen squares, for the hint line. */
function squareList(squares: readonly Square[]): string {
  return squares.map(squareName).join(' ')
}

/**
 * POST /api/game (techspec §5). The body is NESTED — `{ config: { ... } }` —
 * and every field is optional; the server fills the rest from DEFAULT_CONFIG.
 */
async function postCreateGame(options: CreateOptions): Promise<CreatedGame> {
  const res = await fetch('/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: options }),
  })
  if (!res.ok) throw new Error(`建立對局失敗（HTTP ${res.status}）`)
  return (await res.json()) as CreatedGame
}

/**
 * One token, two renderings. `/g/<token>` is the React UI; `/llm/<token>` is
 * the SAME seat as plain text for a chatbot to fetch (techspec §6). This is not
 * a second invitation — whoever holds the token sits in that chair either way.
 */
function llmForm(playUrl: string): string {
  try {
    const parsed = new URL(playUrl, window.location.origin)
    const token = parsed.pathname.split('/').filter(Boolean).pop()
    if (token !== undefined && token.length > 0) {
      parsed.pathname = `/llm/${token}`
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    }
  } catch {
    // fall through to the textual swap below
  }
  return playUrl.replace('/g/', '/llm/')
}

function readPositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function Create() {
  const [created, setCreated] = useState<{ game: CreatedGame; options: CreateOptions } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const [clockEnabled, setClockEnabled] = useState(true)
  const [noProgressTurns, setNoProgressTurns] = useState(String(DEFAULT_CONFIG.noProgressTurns))
  const [opponentMode, setOpponentMode] = useState<OpponentMode>('human')
  const [scoringAreaId, setScoringAreaId] = useState<ScoringAreaId>('center')
  const scoringArea = SCORING_AREAS[scoringAreaId]

  // null until the player types a value, so flipping the clock preset can keep
  // moving the default without ever discarding something they chose themselves
  const [setupMinutes, setSetupMinutes] = useState<string | null>(null)
  const setupMinutesShown =
    setupMinutes ?? String(clockEnabled ? SETUP_MINUTES_TIMED : SETUP_MINUTES_UNTIMED)

  // same touched-flag pattern: the scoring-area preset moves the default X
  // (twice the area, twice the rate) until the player types their own number
  const [scoreTarget, setScoreTarget] = useState<string | null>(null)
  const scoreTargetDefault = DEFAULT_CONFIG.scoreTarget * scoringArea.scoreTargetFactor
  const scoreTargetShown = scoreTarget ?? String(scoreTargetDefault)

  async function onCreate() {
    const options: CreateOptions = {
      clockEnabled,
      scoreTarget: readPositiveInt(scoreTargetShown, scoreTargetDefault),
      noProgressTurns: readPositiveInt(noProgressTurns, DEFAULT_CONFIG.noProgressTurns),
      setupTimeoutMs:
        readPositiveInt(setupMinutesShown, clockEnabled ? SETUP_MINUTES_TIMED : SETUP_MINUTES_UNTIMED) *
        60_000,
      scoringSquares: scoringArea.squares,
    }
    setBusy(true)
    setError(null)
    try {
      setCreated({ game: await postCreateGame(options), options })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      setError('無法複製，請手動選取網址。')
    }
  }

  function chooseOpponentMode(mode: OpponentMode) {
    setOpponentMode(mode)
    // the visible URL just changed — an "已複製" badge next to it would be a lie
    setCopied(null)
  }

  const opponentUrl =
    created === null
      ? ''
      : opponentMode === 'llm'
        ? llmForm(created.game.guestUrl)
        : created.game.guestUrl

  return (
    <main className="screen screen-create">
      <style>{CREATE_CSS}</style>
      <h1>行軍西洋棋</h1>
      <p className="muted">
        西洋棋的載體，行軍棋的兵種。載體公開、兵種隱藏，一律大吃小；中央四格每手計分，
        軍旗離場即判負。
      </p>

      {!created && (
        <>
          <section className="panel">
            <h2>對局設定</h2>

            <div className="c-field">
              <div className="c-field-head">
                <span className="c-field-label">時鐘</span>
                <span className="c-seg c-seg-big" role="group" aria-label="是否計時">
                  <button
                    type="button"
                    aria-pressed={clockEnabled}
                    onClick={() => setClockEnabled(true)}
                  >
                    計時對局
                  </button>
                  <button
                    type="button"
                    aria-pressed={!clockEnabled}
                    onClick={() => setClockEnabled(false)}
                  >
                    不計時
                  </button>
                </span>
              </div>
              <p className="muted small c-hint">
                {clockEnabled
                  ? `雙方各 ${CLOCK_SUMMARY}，時間用盡即判負。人對人請用這個。`
                  : '完全關閉時鐘：不讀秒，也不會超時判負。與 LLM 靠複製貼上對弈時請選這個——一來一回的節奏遠慢於任何時鐘。'}
              </p>
            </div>

            <details className="c-adv">
              <summary>進階設定</summary>
              <div className="c-adv-body">
                <div className="c-num-row c-area-row">
                  <span className="c-num-label" id="c-area-label">
                    計分區
                  </span>
                  <span className="c-seg" role="group" aria-labelledby="c-area-label">
                    {SCORING_AREA_IDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={scoringAreaId === id}
                        onClick={() => setScoringAreaId(id)}
                      >
                        {SCORING_AREAS[id].label}
                        {id === 'center' && '（預設）'}
                      </button>
                    ))}
                  </span>
                </div>
                <p className="muted small c-hint">
                  每一手結束時，己方棋子每佔一格得 1 分。目前選的是{' '}
                  <code className="c-sq">{squareList(scoringArea.squares)}</code>。
                </p>
                <p className="muted small c-hint">
                  八格版把 a、h 兩條 rook 直線與兩側翼也變成有分可搶的地方，讓中央以外的半盤有東西可爭。
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">目標分數 X</span>
                  <input
                    className="c-num"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={scoreTargetShown}
                    onChange={(e) => setScoreTarget(e.target.value)}
                  />
                </label>
                <p className="muted small c-hint">
                  先達到 X 分者獲勝（此計分區預設 {scoreTargetDefault}）。
                  {scoringArea.scoreTargetFactor > 1
                    ? '兩倍的計分區大約以兩倍速度累積，預設值因此同步加倍；覺得太長就自己改。'
                    : '試玩短局時調低。'}
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">無進展回合 N</span>
                  <input
                    className="c-num"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={noProgressTurns}
                    onChange={(e) => setNoProgressTurns(e.target.value)}
                  />
                </label>
                <p className="muted small c-hint">
                  連續 N 個完整回合無吃子且無得分即終局，由比分高者獲勝（預設{' '}
                  {DEFAULT_CONFIG.noProgressTurns}）。
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">佈署時限（分）</span>
                  <input
                    className="c-num"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={setupMinutesShown}
                    onChange={(e) => setSetupMinutes(e.target.value)}
                  />
                </label>
                <p className="muted small c-hint">
                  時間內未佈署者，伺服器代為<strong>隨機</strong>配置後開局。與 LLM
                  對局時需要來回貼網址，務必留足時間——逾時的隨機軍容與自選的看起來完全一樣，
                  不會有任何提示。
                </p>
              </div>
            </details>
          </section>

          <button className="primary big" type="button" onClick={onCreate} disabled={busy}>
            {busy ? '建立中…' : '建立對局'}
          </button>
          <p className="muted small">
            對局存於記憶體，伺服器重啟即消失。無帳號、無配對，僅邀請連結。
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}

      {created && (
        <section className="panel">
          <h2>對局已建立</h2>
          <p className="muted small">
            對局編號 {created.game.gameId} ·{' '}
            {created.options.clockEnabled ? `計時 ${CLOCK_SUMMARY}` : '不計時'} · 計分區{' '}
            {created.options.scoringSquares.length} 格 · 目標 {created.options.scoreTarget} 分 ·
            無進展 {created.options.noProgressTurns} 回合 · 佈署時限{' '}
            {Math.round(created.options.setupTimeoutMs / 60_000)} 分
          </p>

          <div className="link-row">
            <div className="link-label c-label-row">
              <span>邀請對手（分享這條）</span>
              <span className="c-seg" role="group" aria-label="對手連結形式">
                <button
                  type="button"
                  aria-pressed={opponentMode === 'human'}
                  onClick={() => chooseOpponentMode('human')}
                >
                  人類
                </button>
                <button
                  type="button"
                  aria-pressed={opponentMode === 'llm'}
                  onClick={() => chooseOpponentMode('llm')}
                >
                  LLM
                </button>
              </span>
            </div>
            <code className="link">{opponentUrl}</code>
            <button type="button" onClick={() => void copy('guest', opponentUrl)}>
              {copied === 'guest' ? '已複製' : '複製'}
            </button>
            <p className="muted small c-hint c-seat-note">
              同一個座位、同一組 token，只是換一種呈現：人類走 <code>/g/</code> 的介面，
              LLM 走 <code>/llm/</code> 的純文字。
            </p>
            <p className="muted small c-hint">
              {opponentMode === 'llm'
                ? '把這條貼進網頁版聊天機器人，請它抓取（fetch）這個網址：它會拿到純文字盤面，以及每個合法著法各自的網址，抓其中一條就是落子。'
                : '對手用瀏覽器開啟即可入座。'}
            </p>
          </div>

          <div className="link-row">
            <div className="link-label">你的入口（房主）</div>
            <code className="link">{created.game.hostUrl}</code>
            <button type="button" onClick={() => void copy('host', created.game.hostUrl)}>
              {copied === 'host' ? '已複製' : '複製'}
            </button>
          </div>

          <p>
            <a className="primary big as-button" href={localizeUrl(created.game.hostUrl)}>
              以房主身分進入 →
            </a>
          </p>
          <p className="muted small">
            若上方分享連結的網域與此頁不同（開發模式常見），對手仍應使用伺服器發出的連結。
          </p>
        </section>
      )}
    </main>
  )
}

/**
 * Component-scoped styling. `styles.css` is owned elsewhere, so everything new
 * on this screen lives here under a `c-` prefix and reuses the shared tokens.
 */
const CREATE_CSS = `
.screen-create .c-field { margin: 0 0 4px; }
.screen-create .c-field-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.screen-create .c-field-label { color: var(--muted); font-size: 0.82rem; }
.screen-create .c-hint { margin: 6px 0 0; }
.screen-create .link-row .c-hint { flex: 0 0 100%; }
.screen-create .c-seat-note code { background: #0f1114; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }

.screen-create .c-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.screen-create .c-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: #0f1114;
  border: 1px solid var(--line);
  border-radius: 999px;
}
.screen-create .c-seg > button {
  padding: 4px 12px;
  font-size: 0.85rem;
  line-height: 1.3;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 999px;
}
.screen-create .c-seg > button:hover:not(:disabled) { color: var(--fg); border-color: var(--line); }
.screen-create .c-seg > button[aria-pressed='true'] {
  color: var(--fg);
  background: #2a4d6e;
  border-color: #3d6d97;
}
.screen-create .c-seg > button[aria-pressed='true']:hover:not(:disabled) { border-color: var(--accent); }
.screen-create .c-seg-big > button { padding: 8px 18px; font-size: 1rem; }

.screen-create .c-adv { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 8px; }
.screen-create .c-adv > summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; }
.screen-create .c-adv > summary:hover { color: var(--fg); }
.screen-create .c-adv-body { padding: 4px 0 2px; }

.screen-create .c-num-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.screen-create .c-num-label { color: var(--muted); font-size: 0.82rem; min-width: 8em; }
.screen-create .c-num {
  width: 6.5em;
  font: inherit;
  color: var(--fg);
  background: #0f1114;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
}
.screen-create .c-num:focus { outline: none; border-color: var(--accent); }

/* the 計分區 picker: same row rhythm as the number fields, but the control is a
   segmented pair, so it may wrap instead of squeezing the labels */
.screen-create .c-area-row { flex-wrap: wrap; }
.screen-create .c-area-row .c-seg { flex-wrap: wrap; }
.screen-create .c-sq {
  background: #0f1114;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 5px;
  letter-spacing: 0.04em;
}
`
