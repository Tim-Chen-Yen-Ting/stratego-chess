import { useEffect, useState } from 'react'
import { DEFAULT_CONFIG } from '@xiyang/rules'
import type { Color, RankDistribution, Square } from '@xiyang/rules'
import {
  BOT_POLICIES,
  DEFAULT_BOT_POLICY,
  botPolicyLabel,
  botSeatOf,
  rememberBotGame,
} from '../socket.js'
import type { BotSeat, CreatedGame } from '../socket.js'
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
import { formatClock, other, squareName } from '../format.js'
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

/**
 * WHO is on the other side. This is the first question the screen asks, because
 * it decides whether the game needs a second person at all — and therefore
 * whether an invite link is a useful thing to hand back.
 *
 * A bot is a PLAYER, not a mode of the interface: the server seats it, hands it
 * `stateForViewer(state, { kind: 'player', color })` and nothing else, and it
 * deploys its own sixteen 兵種 in secret exactly like a human would. Which is
 * why 「機器人」 is a peer of 「人類」 here rather than a checkbox in 進階設定.
 */
type OpponentKind = 'human' | 'bot'

/** How the invite link is rendered for a HUMAN opponent — see `llmForm`. */
type OpponentMode = 'human' | 'llm'

/** The subset of `GameConfig` this screen exposes. */
interface CreateOptions {
  clockEnabled: boolean
  scoreTarget: number
  /**
   * 吃子得分 (gamebook §7.3, 附錄 B) — the second source of points, and the one
   * that is off unless this screen turns it on. Both default to 0, which is the
   * engine's own default: 附錄 B lists both as 待定, so a game created without
   * touching these two fields scores exactly the way every recorded game did.
   */
  captureScoreK: number
  fizzleBonus: number
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
 *
 * `opponent` says who takes the second seat: `{ kind: 'bot', policy }` asks the
 * server to seat one in-process, and omitting it entirely is a human game —
 * byte-for-byte the request this screen sent before bot games existed.
 *
 * An unknown policy name comes back as a 400 carrying the server's own message,
 * which is surfaced verbatim. The server refuses to substitute a policy it does
 * know, and this screen must not paper over that: a game the player believes is
 * 「爭奪」 but is actually 「亂走」 is a lie about who they just played.
 */
async function postCreateGame(
  options: CreateOptions,
  botPolicy: string | null,
): Promise<CreatedGame> {
  const res = await fetch('/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: options,
      ...(botPolicy === null ? {} : { opponent: { kind: 'bot', policy: botPolicy } }),
    }),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: unknown) =>
        typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
          ? `：${(body as { error: string }).error}`
          : '',
      )
      .catch(() => '')
    throw new Error(`建立對局失敗（HTTP ${res.status}）${detail}`)
  }
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
 * Being able to choose matters: measuring what is left of the first-move
 * advantage means deliberately taking Black, not waiting for the coin.
 *
 * 貼目 0.5 is NOT that compensation and is not advertised as such. Settlement
 * credits only the side that just moved, which is what makes the counting even;
 * the half point exists so the score can never tie, so every score-decided
 * ending has a winner (§7.4/§7.5②). The seat label says "+0.5" and nothing more.
 * (These were written as §7.3/§7.4 under an earlier numbering; §7.3 is now
 * 吃子得分, which this screen also configures, so the old pair would read as a
 * claim about capture scoring.)
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

/**
 * The §7.3 amounts: whole numbers, and zero is a legal value.
 *
 * `readPositiveInt` is wrong because it rejects 0 — which is the DEFAULT here
 * and means 「吃子 pays nothing」, so zero has to survive. Anything unreadable or
 * negative falls back rather than travelling: §7.3 only ever describes a payment
 * (勝方得／存活方得), so a negative amount is not a value of this setting.
 *
 * ROUNDED, because 附錄 B requires whole numbers. §7.4 guarantees 「分數永不相等」
 * only while 貼目 is the sole non-integer source of points; a fractional k makes
 * white's column fractional too and a 分數 finish can then end level, with the
 * winner decided by a comparison in game.ts rather than by a rule. The server
 * clamps this as well — this is the friendlier of the two doors, not the lock.
 */
function readNonNegative(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
}

/**
 * How long the created panel is left on screen before a bot game enters itself.
 *
 * Not a loading delay — the game is already built. It is the one beat the coin
 * flip (§9) deserves: the human may have drawn Black and would otherwise learn
 * it from a board that is already moving. Long enough to read one line, short
 * enough that nobody reaches for a button.
 */
const BOT_ENTER_DELAY_MS = 1600

/** What the screen holds after a successful POST. */
interface CreatedState {
  game: CreatedGame
  options: CreateOptions
  /** the policy asked for, or null when a human opponent was chosen */
  requestedBot: string | null
  /** the bot the server actually seated — null means it seated none */
  bot: BotSeat | null
}

export function Create() {
  const [created, setCreated] = useState<CreatedState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const [clockEnabled, setClockEnabled] = useState(true)
  const [noProgressTurns, setNoProgressTurns] = useState(String(DEFAULT_CONFIG.noProgressTurns))
  const [opponentKind, setOpponentKind] = useState<OpponentKind>('human')
  const [botPolicy, setBotPolicy] = useState<string>(DEFAULT_BOT_POLICY)
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

  /*
   * This field starts at DEFAULT_CONFIG.scoreTarget whichever 計分區 is picked,
   * and the creator moves it. That is a choice about the form — X is theirs to
   * set, not something a preset multiplies behind their back — and NOT a claim
   * that 40 fits both areas. It does not, and the hint under the field says so.
   *
   * The wide area used to double X automatically. The doubling was dropped when
   * settlement changed to credit only the side that just moved, on the grounds
   * that a game now banks half as often as the number 80 was built for — but
   * that halving hit BOTH areas identically, so it cancels out of the comparison
   * between them and never justified handing the wide area the centre area's
   * number. What does not cancel is the income per settlement: a side holds
   * about two squares on 中央四格 and about four on 側翼八格, so a settlement
   * there pays roughly double and the score line arrives roughly twice as soon.
   * Same X=40, n=300 bot games: 35.5 手 on 中央四格, 22.0 手 on 側翼八格
   * (《對局筆記》§9.3; §10.2 gives the mechanism on the current ruleset).
   *
   * 附錄 B therefore lists X as 中央四格 40, 側翼八格 待定. The length-matched wide
   * figure is near 80 — every eight-square game on record used X=80 (§6.2–§6.5),
   * though those were played under the v03 ruleset and do not transfer.
   *
   * Same touched-flag pattern as 佈署時限: null until the player types, so the
   * defaults keep applying without ever discarding something they chose.
   */
  const [scoreTarget, setScoreTarget] = useState<string | null>(null)
  /*
   * 吃子得分 (§7.3). Plain string state seeded from DEFAULT_CONFIG rather than the
   * null-until-touched pattern above, because nothing else on this screen moves
   * these two: they do not follow the 計分區 preset or the clock preset, so there
   * is no default to keep re-applying. DEFAULT_CONFIG has both at 0 (附錄 B: 待定)
   * and that is what a creator who never opens 進階設定 sends.
   */
  const [captureScoreK, setCaptureScoreK] = useState(String(DEFAULT_CONFIG.captureScoreK))
  const [fizzleBonus, setFizzleBonus] = useState(String(DEFAULT_CONFIG.fizzleBonus))
  const scoreTargetDefault = DEFAULT_CONFIG.scoreTarget
  const scoreTargetShown = scoreTarget ?? String(scoreTargetDefault)
  /** wider than the centre preset — read off the squares, not off a preset id */
  const wideArea = scoringArea.squares.length > SCORING_AREAS.center.squares.length

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
      captureScoreK: readNonNegative(captureScoreK, DEFAULT_CONFIG.captureScoreK),
      fizzleBonus: readNonNegative(fizzleBonus, DEFAULT_CONFIG.fizzleBonus),
      noProgressTurns: readPositiveInt(noProgressTurns, DEFAULT_CONFIG.noProgressTurns),
      setupTimeoutMs:
        readPositiveInt(setupMinutesShown, clockEnabled ? SETUP_MINUTES_TIMED : SETUP_MINUTES_UNTIMED) *
        60_000,
      scoringSquares: scoringArea.squares,
      distribution: distributionPreset.counts,
    }
    const requestedBot = opponentKind === 'bot' ? botPolicy : null
    setBusy(true)
    setError(null)
    try {
      const game = await postCreateGame(options, requestedBot)
      const bot = botSeatOf(game, requestedBot)
      // Carried across the navigation into the game, where a fresh page load
      // knows only its token. Server-side marking wins wherever it exists; this
      // is the fallback, and it records a choice the player just made rather
      // than anything about the position (see socket.ts).
      if (bot !== null) rememberBotGame(game.hostToken, bot)
      setCreated({ game, options, requestedBot, bot })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A bot game has nobody to wait for, so it does not stop at a link. It shows
   * the coin flip for a beat and walks in.
   *
   * Only when the server confirmed the bot: if it fell back to a human game
   * (`bot === null`) the panel stays put, because then there IS a link that
   * matters and leaving the page would strand the invite.
   */
  useEffect(() => {
    if (created === null || created.bot === null) return
    const target = localizeUrl(created.game.hostUrl)
    const id = window.setTimeout(() => {
      window.location.assign(target)
    }, BOT_ENTER_DELAY_MS)
    return () => {
      window.clearTimeout(id)
    }
  }, [created])

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

  /**
   * The invite link, or '' when there is none to show.
   *
   * Empty is the normal case for a bot game: the second seat belongs to the
   * bot, and its token would serve whoever opened it that colour's entire
   * deployment. The server does not issue one, and the row below is not
   * rendered — `''` rather than `undefined` because a link row is either a link
   * or absent, never the word "undefined".
   */
  const guestUrl = created?.game.guestUrl ?? ''
  const opponentUrl =
    guestUrl === '' ? '' : opponentMode === 'llm' ? llmForm(guestUrl) : guestUrl

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
        西洋棋的載體，行軍棋的兵種。載體公開、兵種隱藏，一律大吃小；中央四格每手結算，
        只有剛行動的一方計分，軍旗離場即判負。
      </p>

      {!created && (
        <>
          <section className="panel">
            <h2>對局設定</h2>

            {/* WHO first, then how long and how much — the rest of this panel
                only makes sense once it is known whether a second person is
                coming. */}
            <div className="c-field c-opponent">
              <div className="c-field-head">
                <span className="c-field-label">對手</span>
                <span className="c-seg c-seg-big" role="group" aria-label="對手類型">
                  <button
                    type="button"
                    aria-pressed={opponentKind === 'human'}
                    onClick={() => setOpponentKind('human')}
                  >
                    人類（邀請連結）
                  </button>
                  <button
                    type="button"
                    aria-pressed={opponentKind === 'bot'}
                    onClick={() => setOpponentKind('bot')}
                  >
                    機器人
                  </button>
                </span>
              </div>
              <p className="muted small c-hint">
                {opponentKind === 'human'
                  ? '建立後拿到一條邀請連結，交給對手，他用瀏覽器開啟即可入座。'
                  : '伺服器會在另一個座位坐一個機器人，建立完直接開局，沒有邀請連結。'}
              </p>

              {opponentKind === 'bot' && (
                <>
                  <div className="c-num-row c-bot-row">
                    <span className="c-num-label" id="c-bot-label">
                      機器人
                    </span>
                    {/* same card shape as the 兵種配置 picker: four options that
                        each need a sentence saying what they will actually do to
                        you. Ordered strongest first (socket.ts), so the top card
                        is both the default and the real opponent. */}
                    <div className="c-choices" role="group" aria-labelledby="c-bot-label">
                      {BOT_POLICIES.map((policy) => {
                        const active = botPolicy === policy.id
                        return (
                          <button
                            key={policy.id}
                            type="button"
                            aria-pressed={active}
                            className={active ? 'c-choice c-choice-on' : 'c-choice'}
                            onClick={() => setBotPolicy(policy.id)}
                          >
                            <span className="c-choice-head">
                              <span className="c-choice-name">{policy.label}</span>
                              <span className="c-choice-what">
                                <code className="c-sq">{policy.id}</code>
                                {policy.id === DEFAULT_BOT_POLICY && '（預設）'}
                              </span>
                            </span>
                            <span className="c-choice-why">{policy.line}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  {/*
                   * Which of the four is worth your time, said plainly. Only the
                   * first is a player; the other three were built to MEASURE the
                   * board (notebook §9.1) and are kept because a result against
                   * an instrument is still a reading. Saying so is the whole
                   * point of listing them — a roster that offers four names and
                   * ranks none of them invites the player to pick the weakest.
                   */}
                  <p className="muted small c-hint">
                    只有<strong>推測</strong>是對手，其餘三個是量測儀器：它們是為了量棋盤而寫的，
                    棋力低且各有一件事永遠不做（不吃子、不估勝算、不思考）。想下棋就用預設那個。
                  </p>
                  {/*
                   * The claim that makes a bot an opponent rather than a
                   * demonstration, said once, here, where the choice is made.
                   * It receives stateForViewer(state, {kind:'player', color})
                   * and nothing else — the same bytes your browser gets
                   * (規則書 §10). It cannot see your 兵種; you cannot see its.
                   */}
                  <p className="muted small c-hint">
                    機器人是<strong>玩家</strong>，不是旁觀者：它跟你一樣只收到自己視角的盤面（規則書
                    §10），自己秘密佈署十六個兵種，看不到你的軍容——你也不會拿到它的。
                    這局不會發出第二個座位的連結。
                  </p>
                </>
              )}
            </div>

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
                  ? `雙方各 ${CLOCK_SUMMARY}，時間用盡即判負。` +
                    (opponentKind === 'bot'
                      ? '機器人幾乎不耗時，讀秒實際上只約束你自己。'
                      : '人對人請用這個。')
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
                  每一手結束時結算，<strong>只有剛行動的一方</strong>計分：該方棋子每佔一格得 1
                  分。目前選的是 <code className="c-sq">{squareList(scoringArea.squares)}</code>。
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
                  先達到 X 分者獲勝。每一手只有<strong>剛行動的一方</strong>結算，因此每方每個完整
                  回合恰好結算一次；但一次結算拿的是<strong>當下持有的格數</strong>，
                  所以 <strong>X 要隨計分區調整</strong>。附錄 B 只定了四格版的{' '}
                  {scoreTargetDefault} 分，八格版<strong>待定</strong>——這個欄位兩種都先填{' '}
                  {scoreTargetDefault}。
                  {wideArea
                    ? '八格版一次結算約 4 分、四格版約 2 分：同樣 X=40，n=300 的機器對局平均 22.0 手，四格版是 35.5 手（《對局筆記》§9.3）。想要跟四格版差不多長，X 大約要 80。'
                    : '試玩短局時調低。'}
                </p>

                {/*
                 * 吃子得分 (§7.3) — the OTHER source of points, and the only one
                 * that is off by default. It sits directly under 目標分數 X
                 * because it is the same currency: whatever is set here is spent
                 * against that line.
                 */}
                <label className="c-num-row">
                  <span className="c-num-label">吃子得分係數 k</span>
                  <input
                    className="c-num"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={captureScoreK}
                    onChange={(e) => setCaptureScoreK(e.target.value)}
                  />
                </label>
                <p className="muted small c-hint">
                  分數的第二個來源（規則書 §7.3）：決定性勝負時，<strong>勝方</strong>得 k ×（
                  <strong>勝方</strong>階級數字）。階級數字為 司令 1 … 軍旗 10，數字越大代表越弱，
                  所以以弱勝強拿得越多。得分只看勝方的階級——那顆棋子在同一則公告裡已被強制翻明——
                  永遠不看敗方的。
                </p>
                <p className="muted small c-hint">
                  <strong>0 表示關閉吃子得分</strong>：分數只來自佔領計分格，與這裡至今每一局都相同。
                  附錄 B 尚未定案，故預設 {DEFAULT_CONFIG.captureScoreK}。此分於行動階段①即時入帳，
                  因此奪旗結束的那一手照樣付（§7.6）。<strong>必須為整數</strong>——貼目須是唯一的
                  非整數分數來源，否則 §7.4 的「分數永不相等」不再成立。
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">有煙無傷獎勵</span>
                  <input
                    className="c-num"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={fizzleBonus}
                    onChange={(e) => setFizzleBonus(e.target.value)}
                  />
                </label>
                <p className="muted small c-hint">
                  工兵或軍旗碰上爆裂物時（有煙無傷 §5.4），<strong>存活方</strong>得這筆固定額。
                  固定額，且與存活者是誰無關：工兵與軍旗若給的分不同，這一分本身就把兵種報了出來。
                  同歸於盡則雙方皆零分，沒有這個旋鈕——那正是爆裂物無法從分數欄被數出來的原因。
                  <strong>0 表示拆彈不另外給分</strong>（預設 {DEFAULT_CONFIG.fizzleBonus}）。
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
            {busy ? '建立中…' : opponentKind === 'bot' ? '開始對局' : '建立對局'}
          </button>
          <p className="muted small">
            對局存於記憶體，伺服器重啟即消失。無帳號、無配對
            {opponentKind === 'bot' ? '；機器人對局不發邀請連結。' : '，僅邀請連結。'}
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}

      {created && (
        <section className="panel">
          <h2>對局已建立</h2>
          <p className="muted small">
            對局編號 {created.game.gameId} ·{' '}
            {created.bot !== null ? `對手 機器人 ${botPolicyLabel(created.bot.policy)} · ` : ''}
            {created.options.clockEnabled ? `計時 ${CLOCK_SUMMARY}` : '不計時'} · 計分區{' '}
            {created.options.scoringSquares.length} 格 · 兵種配置{' '}
            {distributionName(created.options.distribution)} · 目標 {created.options.scoreTarget} 分
            {/* §7.3 is off unless it was switched on, and a line reading
                「吃子 k 0」 would suggest otherwise — so a default game's summary
                is byte-for-byte the one it printed before this setting existed. */}
            {created.options.captureScoreK > 0 && <> · 吃子 k {created.options.captureScoreK}</>}
            {created.options.fizzleBonus > 0 && <> · 有煙無傷 +{created.options.fizzleBonus}</>}
            {' '}· 無進展 {created.options.noProgressTurns} 回合 · 佈署時限{' '}
            {Math.round(created.options.setupTimeoutMs / 60_000)} 分
          </p>

          {/*
           * Asked for a bot and got a human game back. Not a detail to swallow:
           * the player would otherwise sit at a board waiting for a move that
           * is never coming. The invite link below is the honest way out.
           */}
          {created.requestedBot !== null && created.bot === null && (
            <p className="error">
              這個伺服器沒有座機器人（可能是較舊的版本），已改建立一般對局。
              下面是邀請連結，找個人來坐，或重新整理再試一次。
            </p>
          )}

          {created.bot !== null ? (
            /*
             * A bot game hands back no invite row, because there is no second
             * person and the second SEAT is the bot's: its token would serve
             * whoever opened it the bot's entire deployment (規則書 §10.1 玩家:
             * 己方全部). The server withholds it; this screen therefore has
             * nothing to show and nothing to copy, and goes to the board.
             */
            <div className="c-bot-created">
              <div className="c-bot-headline">
                對手 <strong>機器人 · {botPolicyLabel(created.bot.policy)}</strong>
                　它已入座，並會自己秘密佈署十六個兵種
              </div>
              {/* the coin flip already ran (§9) and may well have handed the
                  human Black — say so before the board does */}
              <div className="c-bot-seat">
                擲幣結果：你<strong>{seatLabel(created.game.hostColor)}</strong>
                {created.game.hostColor === 'black' && '，機器人先行'}
              </div>
              <p className="muted small c-hint">
                下一步是你的佈署：把十六個兵種指派到自己的十六顆棋子上。
                機器人同時、獨立地做同一件事——它看不到你的，你也看不到它的。
              </p>
              <p>
                <a className="primary big as-button" href={localizeUrl(created.game.hostUrl)}>
                  進入對局 →
                </a>
              </p>
              <p className="muted small">正在進入…沒有自動跳轉的話，按上面的按鈕。</p>
            </div>
          ) : (
            <>
            {opponentUrl !== '' && (
              <div className="link-row">
                <div className="link-label c-label-row">
                  <span>
                    邀請對手（分享這條）—{' '}
                    {seatLabel(created.game.guestColor ?? other(created.game.hostColor))}
                  </span>
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
            )}

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
            </>
          )}
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
/* 對手: the first question on the screen, so it gets a rule under it rather
   than sitting flush against the clock row */
.screen-create .c-opponent {
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.screen-create .c-bot-row { align-items: flex-start; flex-wrap: wrap; margin-top: 14px; }
.screen-create .c-bot-row .c-num-label { padding-top: 6px; }

/* the created panel of a bot game: no links, one fact per line, one way out */
.screen-create .c-bot-created {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid #3d6d97;
  background: rgba(110, 193, 255, 0.06);
  border-radius: 8px;
}
.screen-create .c-bot-headline { font-size: 1.02rem; }
.screen-create .c-bot-seat { margin-top: 6px; color: var(--gold); }
.screen-create .c-bot-created > p:last-child { margin-bottom: 0; }

.screen-create .c-bad { color: var(--danger); }
.screen-create .c-sq {
  background: #0f1114;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 5px;
  letter-spacing: 0.04em;
}
`
