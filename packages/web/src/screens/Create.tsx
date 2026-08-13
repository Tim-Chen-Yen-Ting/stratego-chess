import { useState } from 'react'
import { DEFAULT_CONFIG } from '@xiyang/rules'
import type { Color, RankDistribution, Square } from '@xiyang/rules'
import type { CreatedGame } from '../socket.js'
import {
  DISTRIBUTIONS,
  DISTRIBUTION_IDS,
  PIECES_PER_SIDE,
  RANK_LABEL,
  SCORING_AREAS,
  SCORING_AREA_IDS,
  checkDistribution,
  distributionDiff,
  distributionName,
  distributionTotal,
  type DistributionId,
  type ScoringAreaId,
} from '../constants.js'
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
  /** 兵種數量配置 (gamebook §2, 附錄 B) — the table dealt to BOTH sides. */
  distribution: RankDistribution
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
 * "工兵×4（標準 2） · 團長×1（標準 2）" — what this table actually moved.
 *
 * Read off the counts themselves rather than restated in prose, so the line
 * cannot drift from the table being sent even if the preset is retuned in
 * `@xiyang/rules`.
 */
function distributionDiffText(distribution: RankDistribution): string {
  return distributionDiff(distribution)
    .map(({ rank, count, standard }) => `${RANK_LABEL[rank]}×${count}（標準 ${standard}）`)
    .join(' · ')
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
/**
 * Which colour a link sits in. The server flips a fair coin at creation
 * (gamebook §9) and returns both colours, but the screen used to discard them —
 * so the host discovered their colour only by entering, and could not choose.
 * Being able to choose matters: testing whether 貼目 0.5 covers the first-move
 * advantage requires deliberately taking Black, not waiting for the coin.
 */
function seatLabel(color: Color): string {
  return color === 'white' ? '執白（先手）' : '執黑（後手，貼目 +0.5）'
}

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
  // 標準 by default: creating a game without opening 進階設定 must deal exactly
  // the §2 table it dealt before this picker existed.
  const [distributionId, setDistributionId] = useState<DistributionId>('standard')
  const distributionPreset = DISTRIBUTIONS[distributionId]
  const distributionSize = distributionTotal(distributionPreset.counts)
  const distributionChanges = distributionDiffText(distributionPreset.counts)

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
    /*
     * §2 合計 16, checked on the way out and never assumed. §9 makes the
     * deployment a bijection onto this table over sixteen carriers, so a table
     * summing to anything else creates a game nobody can deploy: every
     * submission fails `validateAssignment`, and the setup timer then deals a
     * random army out of the same impossible pool. The presets come from another
     * package and can be retuned there — that is exactly why this is a check.
     */
    const problem = checkDistribution(distributionPreset.counts)
    if (problem !== null) {
      setError(
        `兵種配置「${distributionPreset.label}」不合法：合計 ${distributionSize} 顆，必須恰好 ${PIECES_PER_SIDE} 顆（規則書 §2）。已停止建立。［${problem}］`,
      )
      return
    }

    const options: CreateOptions = {
      clockEnabled,
      scoreTarget: readPositiveInt(scoreTargetShown, scoreTargetDefault),
      noProgressTurns: readPositiveInt(noProgressTurns, DEFAULT_CONFIG.noProgressTurns),
      setupTimeoutMs:
        readPositiveInt(setupMinutesShown, clockEnabled ? SETUP_MINUTES_TIMED : SETUP_MINUTES_UNTIMED) *
        60_000,
      scoringSquares: scoringArea.squares,
      distribution: distributionPreset.counts,
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

  /**
   * 公開觀戰連結 (gamebook §10) — empty string when the server did not issue
   * one, which is the whole of the feature detection: no link, no row.
   */
  const publicUrl = created?.game.publicUrl ?? ''

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

                <div className="c-num-row c-dist-row">
                  <span className="c-num-label" id="c-dist-label">
                    兵種配置
                  </span>
                  {/* Same control semantics as the 計分區 picker above — a group
                      of aria-pressed buttons, not a role="radio" group, because
                      nothing here implements the arrow-key navigation a
                      radiogroup promises. Three options that each carry a
                      sentence of justification only need the shape to change. */}
                  <div className="c-choices" role="group" aria-labelledby="c-dist-label">
                    {DISTRIBUTION_IDS.map((id) => {
                      const preset = DISTRIBUTIONS[id]
                      const active = distributionId === id
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={active}
                          className={active ? 'c-choice c-choice-on' : 'c-choice'}
                          onClick={() => setDistributionId(id)}
                        >
                          <span className="c-choice-head">
                            <span className="c-choice-name">{preset.label}</span>
                            <span className="c-choice-what">
                              {id === 'standard' ? '（預設）' : `— ${preset.what}`}
                            </span>
                          </span>
                          {/* what it is FOR, not what it is */}
                          <span className="c-choice-why">{preset.why}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <p className="muted small c-hint">
                  雙方同表，且對雙方公開——這是設定，不是暗牌。每方合計{' '}
                  <strong className={distributionSize === PIECES_PER_SIDE ? undefined : 'c-bad'}>
                    {distributionSize}
                  </strong>{' '}
                  顆
                  {distributionSize === PIECES_PER_SIDE ? '' : `（必須是 ${PIECES_PER_SIDE}）`}
                  {distributionChanges === '' ? (
                    '，與規則書 §2 的表相同。'
                  ) : (
                    <>
                      ，與標準不同的是 <code className="c-sq">{distributionChanges}</code>。
                    </>
                  )}
                </p>
                <p className="muted small c-hint">{distributionPreset.note}</p>

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
            {created.options.scoringSquares.length} 格 · 兵種配置{' '}
            {distributionName(created.options.distribution)} · 目標 {created.options.scoreTarget} 分
            · 無進展 {created.options.noProgressTurns} 回合 · 佈署時限{' '}
            {Math.round(created.options.setupTimeoutMs / 60_000)} 分
          </p>

          <div className="link-row">
            <div className="link-label c-label-row">
              <span>邀請對手（分享這條）— {seatLabel(created.game.guestColor)}</span>
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
            <p className="muted small c-hint">
              擲幣已決定顏色。想要另一色就把兩條連結對調——誰拿到哪條，誰就坐那個位子。
            </p>

            <div className="link-label">你的入口（房主）— {seatLabel(created.game.hostColor)}</div>
            <code className="link">{created.game.hostUrl}</code>
            <button type="button" onClick={() => void copy('host', created.game.hostUrl)}>
              {copied === 'host' ? '已複製' : '複製'}
            </button>
          </div>

          {/*
           * The third link, and the only one that may leave the two seats.
           * Every other viewer is attached to somebody's army — a 綁定觀戰者
           * inherits one player's view entire (§10.2 ①) — so until this link
           * existed there was no way to let anyone watch a live game without
           * handing over sixteen 兵種. This one owns no colour.
           */}
          {publicUrl !== '' && (
            <div className="link-row c-public-row">
              <div className="link-label c-label-row">
                <span>公開觀戰 — 無陣營，不入座</span>
                <span className="c-safe">對局進行中可安全轉發</span>
              </div>
              <code className="link">{publicUrl}</code>
              <button type="button" onClick={() => void copy('public', publicUrl)}>
                {copied === 'public' ? '已複製' : '複製'}
              </button>
              <p className="muted small c-hint">
                拿到這條的人看到的是<strong>雙方本來就都知道的那些</strong>：棋盤與載體、公開事件紀錄、已翻明的兵種、比分與時鐘。任何一方未翻明的兵種都不在裡面——不是收到了不顯示，是伺服器根本不送（規則書 §10）。他也不能落子、不能認輸。終局後全部兵種對所有人公開（§10 終局公開全部兵種），這條連結也會一起看到。
              </p>
              <p className="muted small c-hint">
                <strong className="c-careful">別跟「綁定觀戰連結」搞混：</strong>
                那條綁定某一方的視角（規則書 §10.2 ①），等於把那方的整副軍容交出去，對局中不能給第三者；要轉發的是上面這條。
              </p>
            </div>
          )}

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

/* the one link that may be forwarded: boxed and tinted so it is not read as a
   third copy of the two seat links above it */
.screen-create .c-public-row {
  border: 1px solid #2f5a45;
  background: rgba(95, 208, 138, 0.06);
  border-radius: 8px;
  padding: 8px 10px 10px;
}
.screen-create .c-safe {
  flex: 0 0 auto;
  color: var(--ok);
  border: 1px solid rgba(95, 208, 138, 0.45);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 0.76rem;
  white-space: nowrap;
}
.screen-create .c-careful { color: var(--gold); }

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

/* the 兵種配置 picker. Three options that each need a sentence of justification
   do not fit a segmented control, so they are stacked cards; the label keeps the
   same column as the number fields and the cards take the rest of the row. */
.screen-create .c-dist-row { align-items: flex-start; flex-wrap: wrap; }
.screen-create .c-dist-row .c-num-label { padding-top: 6px; }
.screen-create .c-choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 18em;
  min-width: 0;
}
.screen-create .c-choice {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  background: #0f1114;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
  color: var(--muted);
}
.screen-create .c-choice:hover:not(:disabled) { border-color: var(--accent); color: var(--fg); }
.screen-create .c-choice-on {
  background: #2a4d6e;
  border-color: #3d6d97;
  color: var(--fg);
}
.screen-create .c-choice-head { display: block; }
.screen-create .c-choice-name { font-weight: 600; color: var(--fg); }
.screen-create .c-choice-what { font-size: 0.8rem; margin-left: 6px; }
.screen-create .c-choice-why {
  display: block;
  margin-top: 3px;
  font-size: 0.78rem;
  line-height: 1.5;
}
.screen-create .c-bad { color: var(--danger); }
.screen-create .c-sq {
  background: #0f1114;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 5px;
  letter-spacing: 0.04em;
}
`
