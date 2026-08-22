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
  DISTRIBUTION_TEXT,
  PIECES_PER_SIDE,
  RANK_LABEL,
  SCORING_AREAS,
  SCORING_AREA_DEFAULT_X,
  SCORING_AREA_IDS,
  SCORING_AREA_LABEL,
  checkDistribution,
  distributionDiff,
  distributionName,
  distributionTotal,
  type DistributionId,
  type ScoringAreaId,
} from '../constants.js'
import { formatClock, other, squareName } from '../format.js'
import { localizeUrl } from '../url.js'
import { useLang, fill, type Strings } from '../i18n.js'

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
function distributionDiffText(distribution: RankDistribution, lang: 'zh' | 'en'): string {
  const standardWord = lang === 'zh' ? '標準' : 'standard'
  return distributionDiff(distribution)
    .map(({ rank, count, standard }) => `${RANK_LABEL[lang][rank]}×${count}（${standardWord} ${standard}）`)
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
  lang: 'zh' | 'en',
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
          ? `${lang === 'zh' ? '：' : ': '}${(body as { error: string }).error}`
          : '',
      )
      .catch(() => '')
    throw new Error(
      lang === 'zh'
        ? `建立對局失敗（HTTP ${res.status}）${detail}`
        : `Failed to create game (HTTP ${res.status})${detail}`,
    )
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
function seatLabel(color: Color, lang: 'zh' | 'en'): string {
  if (lang === 'zh') return color === 'white' ? '執白（先手）' : '執黑（後手，貼目 +0.5）'
  return color === 'white' ? 'White (moves first)' : 'Black (moves second, +0.5 komi)'
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

/**
 * §7.3's two knobs, as THIS SCREEN pre-fills them — distinct from
 * `DEFAULT_CONFIG.captureScoreK` / `.fizzleBonus`, which ship at 0 and must
 * stay there (rules/constants.ts: the engine's own measurement baseline).
 * These are the values real games have actually used; 0 is still one edit away.
 */
const FORM_DEFAULT_CAPTURE_K = 1
const FORM_DEFAULT_FIZZLE_BONUS = 5

/** What the screen holds after a successful POST. */
interface CreatedState {
  game: CreatedGame
  options: CreateOptions
  /** the policy asked for, or null when a human opponent was chosen */
  requestedBot: string | null
  /** the bot the server actually seated — null means it seated none */
  bot: BotSeat | null
}

const STR = {
  zh: {
    pageTitle: '行軍西洋棋',
    pitch: '西洋棋的載體，行軍棋的兵種。載體公開、兵種隱藏，一律大吃小；中央四格每手結算，只有剛行動的一方計分，軍旗離場即判負。',
    settingsTitle: '對局設定',
    opponentLabel: '對手',
    opponentTypeAria: '對手類型',
    opponentHuman: '人類（邀請連結）',
    opponentBot: '機器人',
    opponentHintHuman: '建立後拿到一條邀請連結，交給對手，他用瀏覽器開啟即可入座。',
    opponentHintBot: '伺服器會在另一個座位坐一個機器人，建立完直接開局，沒有邀請連結。',
    botLabel: '機器人',
    botDefaultSuffix: '（預設）',
    botOnlyOpponentHint: '只有{{name}}是對手，其餘三個是量測儀器：它們是為了量棋盤而寫的，棋力低且各有一件事永遠不做（不吃子、不估勝算、不思考）。想下棋就用預設那個。',
    botIsPlayerHint: '機器人是{{playerWord}}，不是旁觀者：它跟你一樣只收到自己視角的盤面（規則書 §10），自己秘密佈署十六個兵種，看不到你的軍容——你也不會拿到它的。這局不會發出第二個座位的連結。',
    playerWord: '玩家',
    clockLabel: '時鐘',
    clockAria: '是否計時',
    clockTimed: '計時對局',
    clockUntimed: '不計時',
    clockHintTimed: '雙方各 {{summary}}，時間用盡即判負。',
    clockHintTimedBot: '機器人幾乎不耗時，讀秒實際上只約束你自己。',
    clockHintTimedHuman: '人對人請用這個。',
    clockHintUntimed: '完全關閉時鐘：不讀秒，也不會超時判負。與 LLM 靠複製貼上對弈時請選這個——一來一回的節奏遠慢於任何時鐘。',
    advancedSummary: '進階設定',
    areaLabel: '計分區',
    areaDefaultSuffix: '（預設）',
    areaHint1: '每一手結束時結算，{{onlyMover}}計分：該方棋子每佔一格得 1 分。目前選的是 {{squares}}。',
    onlyMoverWord: '只有剛行動的一方',
    areaHint2: '八格版把 a、h 兩條 rook 直線與兩側翼也變成有分可搶的地方，讓中央以外的半盤有東西可爭。',
    distLabel: '兵種配置',
    distDefaultSuffix: '（預設）',
    distTotalPrefix: '雙方同表，且對雙方公開——這是設定，不是暗牌。每方合計',
    distTotalUnit: '顆',
    distTotalBad: '（必須是 {{n}}）',
    distSameAsStandard: '，與規則書 §2 的表相同。',
    distDiffPrefix: '，與標準不同的是',
    xLabel: '目標分數 X',
    xHint1: '先達到 X 分者獲勝。每一手只有{{onlyMover}}結算，因此每方每個完整回合恰好結算一次；但一次結算拿的是{{currentSquares}}，所以{{autoFill}}——{{centerLabel}} {{centerX}} 分、{{wideLabel}} {{wideX}} 分，換計分區會跟著換，自己填過就不再自動換。這兩個數字是實際對局採用的，不是附錄 B 的定案（附錄 B 只定了四格版 {{defaultX}} 分，八格版{{undecided}}）。',
    onlyMoverBold: '只有剛行動的一方',
    currentSquaresBold: '當下持有的格數',
    autoFillBold: 'X 隨計分區自動帶入',
    undecidedWord: '待定',
    xHintWide: '八格版一次結算約 4 分、四格版約 2 分：同樣 X 下八格版短得多（《對局筆記》§9.3），所以八格版的預設 X 大約是四格版的兩倍。',
    xHintCentre: '試玩短局時調低。',
    kLabel: '吃子得分係數 k',
    kHint1: '分數的第二個來源（規則書 §7.3）：決定性勝負時，{{winner}}得 k ×（{{winner}}階級數字）。階級數字為 司令 1 … 軍旗 10，數字越大代表越弱，所以以弱勝強拿得越多。得分只看勝方的階級——那顆棋子在同一則公告裡已被強制翻明——永遠不看敗方的。',
    winnerWord: '勝方',
    kHint2: '{{zeroMeans}}：分數只來自佔領計分格。附錄 B 本身尚未定案，仍是 {{engineDefault}}；這個表單另外預填 {{formDefault}}，是實際對局採用的數字，改回 0 隨時可以。此分於行動階段①即時入帳，因此奪旗結束的那一手照樣付（§7.6）。{{mustBeInt}}——貼目須是唯一的非整數分數來源，否則 §7.4 的「分數永不相等」不再成立。',
    kZeroMeans: '0 表示關閉吃子得分',
    kMustBeInt: '必須為整數',
    fizzleLabel: '有煙無傷獎勵',
    fizzleHint: '工兵或軍旗碰上爆裂物時（有煙無傷 §5.4），{{survivor}}得這筆固定額。固定額，且與存活者是誰無關：工兵與軍旗若給的分不同，這一分本身就把兵種報了出來。同歸於盡則雙方皆零分，沒有這個旋鈕——那正是爆裂物無法從分數欄被數出來的原因。{{zeroMeans}}。附錄 B 本身仍是 {{engineDefault}}；這個表單另外預填 {{formDefault}}。',
    survivorWord: '存活方',
    fizzleZeroMeans: '0 表示拆彈不另外給分',
    noProgressLabel: '無進展回合 N',
    noProgressHint: '連續 N 個完整回合無吃子且無得分即終局，由比分高者獲勝（預設 {{n}}）。',
    setupLabel: '佈署時限（分）',
    setupHint: '時間內未佈署者，伺服器代為{{random}}配置後開局。與 LLM 對局時需要來回貼網址，務必留足時間——逾時的隨機軍容與自選的看起來完全一樣，不會有任何提示。',
    randomWord: '隨機',
    createBusy: '建立中…',
    createBot: '開始對局',
    createHuman: '建立對局',
    footerMemory: '對局存於記憶體，伺服器重啟即消失。無帳號、無配對',
    footerBotSuffix: '；機器人對局不發邀請連結。',
    footerHumanSuffix: '，僅邀請連結。',
    createdTitle: '對局已建立',
    summaryGameId: '對局編號',
    summaryOpponentBot: '對手 機器人',
    summaryClock: '計時',
    summaryUntimed: '不計時',
    summaryArea: '計分區',
    summaryAreaUnit: '格',
    summaryDist: '兵種配置',
    summaryTarget: '目標',
    summaryTargetUnit: '分',
    summaryK: '吃子 k',
    summaryFizzle: '有煙無傷 +',
    summaryNoProgress: '無進展',
    summaryNoProgressUnit: '回合',
    summarySetup: '佈署時限',
    summarySetupUnit: '分',
    botFallbackError: '這個伺服器沒有座機器人（可能是較舊的版本），已改建立一般對局。下面是邀請連結，找個人來坐，或重新整理再試一次。',
    botCreatedHeadline: '對手 {{name}}　它已入座，並會自己秘密佈署十六個兵種',
    botCreatedSeat: '擲幣結果：你{{seat}}{{firstMoveNote}}',
    botFirstMoveNote: '，機器人先行',
    botNextStep: '下一步是你的佈署：把十六個兵種指派到自己的十六顆棋子上。機器人同時、獨立地做同一件事——它看不到你的，你也看不到它的。',
    botEnter: '進入對局 →',
    botEntering: '正在進入…沒有自動跳轉的話，按上面的按鈕。',
    inviteLabel: '邀請對手（分享這條）— {{seat}}',
    linkFormAria: '對手連結形式',
    linkFormHuman: '人類',
    linkFormLlm: 'LLM',
    copyDone: '已複製',
    copyAction: '複製',
    seatNote: '同一個座位、同一組 token，只是換一種呈現：人類走 /g/ 的介面，LLM 走 /llm/ 的純文字。',
    llmHint: '把這條貼進網頁版聊天機器人，請它抓取（fetch）這個網址：它會拿到純文字盤面，以及每個合法著法各自的網址，抓其中一條就是落子。',
    humanUrlHint: '對手用瀏覽器開啟即可入座。',
    coinNote: '擲幣已決定顏色。想要另一色就把兩條連結對調——誰拿到哪條，誰就坐那個位子。',
    hostLabel: '你的入口（房主）— {{seat}}',
    publicLabel: '公開觀戰 — 無陣營，不入座',
    publicSafe: '對局進行中可安全轉發',
    publicHint1: '拿到這條的人看到的是雙方本來就都知道的那些：棋盤與載體、公開事件紀錄、已翻明的兵種、比分與時鐘。任何一方未翻明的兵種都不在裡面——不是收到了不顯示，是伺服器根本不送（規則書 §10）。他也不能落子、不能認輸。終局後全部兵種對所有人公開（§10 終局公開全部兵種），這條連結也會一起看到。',
    publicCareful: '別跟「綁定觀戰連結」搞混：',
    publicHint2: '那條綁定某一方的視角（規則書 §10.2 ①），等於把那方的整副軍容交出去，對局中不能給第三者；要轉發的是上面這條。',
    hostEnter: '以房主身分進入 →',
    domainNote: '若上方分享連結的網域與此頁不同（開發模式常見），對手仍應使用伺服器發出的連結。',
    copyFailed: '無法複製，請手動選取網址。',
  },
  en: {
    pageTitle: 'Marching Chess',
    pitch: 'Chess carriers, 行軍棋 ranks. Carriers are public, ranks are hidden, and it’s always big-beats-small. Centre 4 settles every ply, only the side that just moved scores, and losing your flag loses the game outright.',
    settingsTitle: 'Game settings',
    opponentLabel: 'Opponent',
    opponentTypeAria: 'Opponent type',
    opponentHuman: 'Human (invite link)',
    opponentBot: 'Bot',
    opponentHintHuman: 'You’ll get an invite link after creating — hand it to your opponent, they open it in a browser and take their seat.',
    opponentHintBot: 'The server seats a bot in the other chair. The game starts immediately once created — no invite link.',
    botLabel: 'Bot',
    botDefaultSuffix: ' (default)',
    botOnlyOpponentHint: 'Only {{name}} is an opponent — the other three are measuring instruments, built to measure the board, weak, and each permanently refusing to do one thing (never captures, never estimates odds, never plans). If you actually want a game, use the default one.',
    botIsPlayerHint: 'The bot is a {{playerWord}}, not a spectator: it receives exactly its own redacted view, same as you (gamebook §10), secretly deploys its own sixteen ranks, and can’t see yours — you won’t get to see its either. This game issues no second-seat link.',
    playerWord: 'player',
    clockLabel: 'Clock',
    clockAria: 'Timed or not',
    clockTimed: 'Timed game',
    clockUntimed: 'Untimed',
    clockHintTimed: 'Each side gets {{summary}}; running out loses the game.',
    clockHintTimedBot: 'The bot barely spends any time — the clock is really just constraining you.',
    clockHintTimedHuman: 'Use this for human vs. human.',
    clockHintUntimed: 'The clock is fully off: no countdown, no timeout loss. Use this when playing an LLM by copy-pasting URLs back and forth — that back-and-forth is far slower than any clock.',
    advancedSummary: 'Advanced settings',
    areaLabel: 'Scoring area',
    areaDefaultSuffix: ' (default)',
    areaHint1: 'Settlement runs at the end of every ply, but {{onlyMover}} scores: 1 point per square that side currently occupies. Currently selected: {{squares}}.',
    onlyMoverWord: 'only the side that just moved',
    areaHint2: 'The 8-square board turns the a/h rook files and both flanks into contested ground too, so there’s something to fight over off-centre as well.',
    distLabel: 'Rank distribution',
    distDefaultSuffix: ' (default)',
    distTotalPrefix: 'Same table for both sides, public to both — this is a setting, not a hidden card. Each side totals',
    distTotalUnit: 'pieces',
    distTotalBad: ' (must be {{n}})',
    distSameAsStandard: ', same as the gamebook §2 table.',
    distDiffPrefix: ', differing from standard by',
    xLabel: 'Score target (X)',
    xHint1: 'First to X points wins. Each ply only {{onlyMover}} settles, so each side settles exactly once per full turn — but a settlement pays {{currentSquares}}, so {{autoFill}} — {{centerLabel}} {{centerX}} points, {{wideLabel}} {{wideX}} points, switching the scoring area updates it, and it stops auto-updating once you type your own. These two numbers are what real games have actually used, not an Appendix B ruling (Appendix B only specifies {{defaultX}} points for the 4-square board — the 8-square board is still {{undecided}}).',
    onlyMoverBold: 'only the side that just moved',
    currentSquaresBold: 'the squares it currently holds',
    autoFillBold: 'X auto-fills from the scoring area',
    undecidedWord: 'undecided',
    xHintWide: 'A settlement on the 8-square board is worth about 4 points versus about 2 on the 4-square board: at the same X, the 8-square game is much shorter ({《對局筆記》§9.3}), so its default X is set to roughly double the 4-square board’s.',
    xHintCentre: 'Lower this for quick practice games.',
    kLabel: 'Capture-score coefficient (k)',
    kHint1: 'The second source of points (gamebook §7.3): on a decisive fight, the {{winner}} gets k × (the {{winner}}’s own rank number). Rank numbers run Commander 1 … Flag 10 — higher means weaker, so beating a stronger piece with a weaker one pays more. Only the winner’s rank counts — it’s already forced face-up in the same announcement — never the loser’s.',
    winnerWord: 'winner',
    kHint2: '{{zeroMeans}}: points come only from holding scoring squares. Appendix B itself is still undecided, at {{engineDefault}}; this form separately pre-fills {{formDefault}}, the number real games have actually used — switch back to 0 any time. This is paid immediately in the action phase, so the very move that captures the flag still pays it (§7.6). {{mustBeInt}} — komi has to stay the only non-integer source of points, or §7.4’s "the score can never tie" stops holding.',
    kZeroMeans: '0 turns capture-scoring off',
    kMustBeInt: 'Must be a whole number',
    fizzleLabel: 'Fizzle bonus',
    fizzleHint: 'When an Engineer or the Flag meets a bomb (fizzle, §5.4), the {{survivor}} gets this flat amount. Flat, and independent of who survived: if Engineer and Flag paid different amounts, that payment alone would out the piece’s rank. A mutual destruction pays both sides zero and has no knob here — that’s exactly why a bomb can’t be counted off the score column. {{zeroMeans}}. Appendix B itself is still {{engineDefault}}; this form separately pre-fills {{formDefault}}.',
    survivorWord: 'survivor',
    fizzleZeroMeans: '0 means disarming a bomb pays nothing extra',
    noProgressLabel: 'No-progress limit (N)',
    noProgressHint: 'N consecutive full turns with no capture and no score change ends the game; the higher score wins (default {{n}}).',
    setupLabel: 'Setup time limit (min)',
    setupHint: 'Anyone who hasn’t deployed in time gets a {{random}} assignment from the server, and the game starts anyway. Playing an LLM means pasting URLs back and forth, so leave plenty of time — a timed-out random army looks exactly like a chosen one, with no indication either way.',
    randomWord: 'random',
    createBusy: 'Creating…',
    createBot: 'Start game',
    createHuman: 'Create game',
    footerMemory: 'Games live in memory; a server restart drops them. No accounts, no matchmaking',
    footerBotSuffix: '; bot games issue no invite link.',
    footerHumanSuffix: ', invite links only.',
    createdTitle: 'Game created',
    summaryGameId: 'Game',
    summaryOpponentBot: 'Opponent bot',
    summaryClock: 'Timed',
    summaryUntimed: 'Untimed',
    summaryArea: 'Scoring area',
    summaryAreaUnit: 'squares',
    summaryDist: 'Ranks',
    summaryTarget: 'Target',
    summaryTargetUnit: 'points',
    summaryK: 'capture k',
    summaryFizzle: 'fizzle +',
    summaryNoProgress: 'no-progress',
    summaryNoProgressUnit: 'turns',
    summarySetup: 'setup limit',
    summarySetupUnit: 'min',
    botFallbackError: 'This server has no bot seated (possibly an older version) — created a regular game instead. Below is the invite link: find someone to take the seat, or refresh and try again.',
    botCreatedHeadline: 'Opponent {{name}}　it has taken its seat and will secretly deploy its own sixteen ranks',
    botCreatedSeat: 'Coin flip: you are {{seat}}{{firstMoveNote}}',
    botFirstMoveNote: ', the bot moves first',
    botNextStep: 'Next is your deployment: assign your sixteen ranks to your sixteen pieces. The bot is doing the same thing at the same time, independently — it can’t see yours, you can’t see its.',
    botEnter: 'Enter game →',
    botEntering: 'Entering… if it doesn’t redirect automatically, use the button above.',
    inviteLabel: 'Invite your opponent (share this) — {{seat}}',
    linkFormAria: 'Opponent link format',
    linkFormHuman: 'Human',
    linkFormLlm: 'LLM',
    copyDone: 'Copied',
    copyAction: 'Copy',
    seatNote: 'Same seat, same token, just a different rendering: humans use the /g/ UI, LLMs use the /llm/ plain text.',
    llmHint: 'Paste this into a web chatbot and ask it to fetch this URL: it gets back a plain-text board plus a URL for every legal move — fetching one plays it.',
    humanUrlHint: 'Your opponent opens it in a browser to take their seat.',
    coinNote: 'The coin flip already decided colours. Want the other one? Swap the two links — whoever holds which link sits in that seat.',
    hostLabel: 'Your entrance (host) — {{seat}}',
    publicLabel: 'Public spectator — no side, no seat',
    publicSafe: 'Safe to forward while the game is in progress',
    publicHint1: 'Whoever holds this link sees exactly what both players already know: the board and carriers, the public event log, revealed ranks, score, and clock. Neither side’s un-revealed ranks are in it — not received-but-hidden, the server simply never sends them (gamebook §10). They can’t move or resign either. Once the game ends, every rank opens to everyone (§10), and this link sees that too.',
    publicCareful: 'Don’t confuse this with a bound spectator link:',
    publicHint2: 'that one is bound to one side’s view (gamebook §10.2 ①) — equivalent to handing over that side’s entire army, and must never go to a third party mid-game. Forward the link above instead.',
    hostEnter: 'Enter as host →',
    domainNote: 'If the shared link’s domain differs from this page (common in dev mode), your opponent should still use the link the server issued.',
    copyFailed: 'Couldn’t copy — please select the URL manually.',
  },
} satisfies Strings<string>

export function Create() {
  const { lang } = useLang()
  const s = STR[lang]
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
  const distributionText = DISTRIBUTION_TEXT[lang][distributionId]
  const distributionSize = distributionTotal(distributionPreset.counts)
  const distributionChanges = distributionDiffText(distributionPreset.counts, lang)

  // null until the player types a value, so flipping the clock preset can keep
  // moving the default without ever discarding something they chose themselves
  const [setupMinutes, setSetupMinutes] = useState<string | null>(null)
  const setupMinutesShown =
    setupMinutes ?? String(clockEnabled ? SETUP_MINUTES_TIMED : SETUP_MINUTES_UNTIMED)

  /*
   * This field starts at SCORING_AREA_DEFAULT_X[scoringAreaId] and follows the
   * 計分區 picker until the creator types an X of their own — same touched-flag
   * pattern as 佈署時限 below: `scoreTarget` stays null (so the per-board default
   * keeps applying and switching 計分區 keeps updating the shown value) until an
   * onChange fires, and nothing overwrites what they typed after that.
   *
   * DEFAULT_CONFIG.scoreTarget (40, from @xiyang/rules) is NOT this field's
   * default, and never was for the wide area — see SCORING_AREA_DEFAULT_X's own
   * doc in constants.ts for why the two are kept separate. The reason they need
   * different numbers at all: a side holds about two squares on 中央四格 and
   * about four on 側翼八格, so a settlement there pays roughly double and the
   * score line arrives roughly twice as soon at the same X. Same X=40, n=300
   * bot games: 35.5 手 on 中央四格, 22.0 手 on 側翼八格 (《對局筆記》§9.3; §10.2
   * gives the mechanism on the current ruleset) — the 60/120 pair below is that
   * same ~2:1 ratio applied to the length real games have actually used.
   */
  const [scoreTarget, setScoreTarget] = useState<string | null>(null)
  /*
   * 吃子得分 (§7.3). Plain string state — NOT the touched-null pattern above,
   * because these two do not follow the 計分區 or clock preset, so there is
   * nothing for a null to keep re-deriving.
   *
   * Seeded from FORM_DEFAULT_CAPTURE_K / FORM_DEFAULT_FIZZLE_BONUS below, NOT
   * from DEFAULT_CONFIG (which ships both at 0 — 附錄 B: 待定, and the engine's
   * own measurement baseline, so it must stay 0 regardless of what this screen
   * pre-fills). These two are the values real games have actually used; a
   * creator who wants the bare §7.2-only economy still has 0 one edit away.
   */
  const [captureScoreK, setCaptureScoreK] = useState(String(FORM_DEFAULT_CAPTURE_K))
  const [fizzleBonus, setFizzleBonus] = useState(String(FORM_DEFAULT_FIZZLE_BONUS))
  const scoreTargetDefault = SCORING_AREA_DEFAULT_X[scoringAreaId]
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
        lang === 'zh'
          ? `兵種配置「${distributionText.label}」不合法：合計 ${distributionSize} 顆，必須恰好 ${PIECES_PER_SIDE} 顆（規則書 §2）。已停止建立。［${problem}］`
          : `Rank set "${distributionText.label}" is invalid: totals ${distributionSize} pieces, must be exactly ${PIECES_PER_SIDE} (gamebook §2). Not creating the game. [${problem}]`,
      )
      return
    }

    const options: CreateOptions = {
      clockEnabled,
      scoreTarget: readPositiveInt(scoreTargetShown, scoreTargetDefault),
      captureScoreK: readNonNegative(captureScoreK, FORM_DEFAULT_CAPTURE_K),
      fizzleBonus: readNonNegative(fizzleBonus, FORM_DEFAULT_FIZZLE_BONUS),
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
      const game = await postCreateGame(options, requestedBot, lang)
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
      setError(s.copyFailed)
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
      <h1>{s.pageTitle}</h1>
      <p className="muted">{s.pitch}</p>

      {!created && (
        <>
          <section className="panel">
            <h2>{s.settingsTitle}</h2>

            {/* WHO first, then how long and how much — the rest of this panel
                only makes sense once it is known whether a second person is
                coming. */}
            <div className="c-field c-opponent">
              <div className="c-field-head">
                <span className="c-field-label">{s.opponentLabel}</span>
                <span className="c-seg c-seg-big" role="group" aria-label={s.opponentTypeAria}>
                  <button
                    type="button"
                    aria-pressed={opponentKind === 'human'}
                    onClick={() => setOpponentKind('human')}
                  >
                    {s.opponentHuman}
                  </button>
                  <button
                    type="button"
                    aria-pressed={opponentKind === 'bot'}
                    onClick={() => setOpponentKind('bot')}
                  >
                    {s.opponentBot}
                  </button>
                </span>
              </div>
              <p className="muted small c-hint">
                {opponentKind === 'human' ? s.opponentHintHuman : s.opponentHintBot}
              </p>

              {opponentKind === 'bot' && (
                <>
                  <div className="c-num-row c-bot-row">
                    <span className="c-num-label" id="c-bot-label">
                      {s.botLabel}
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
                              <span className="c-choice-name">{policy.label[lang]}</span>
                              <span className="c-choice-what">
                                <code className="c-sq">{policy.id}</code>
                                {policy.id === DEFAULT_BOT_POLICY && s.botDefaultSuffix}
                              </span>
                            </span>
                            <span className="c-choice-why">{policy.line[lang]}</span>
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
                    {fill(s.botOnlyOpponentHint, { name: BOT_POLICIES[0]!.label[lang] })}
                  </p>
                  {/*
                   * The claim that makes a bot an opponent rather than a
                   * demonstration, said once, here, where the choice is made.
                   * It receives stateForViewer(state, {kind:'player', color})
                   * and nothing else — the same bytes your browser gets
                   * (規則書 §10). It cannot see your 兵種; you cannot see its.
                   */}
                  <p className="muted small c-hint">
                    {fill(s.botIsPlayerHint, { playerWord: s.playerWord })}
                  </p>
                </>
              )}
            </div>

            <div className="c-field">
              <div className="c-field-head">
                <span className="c-field-label">{s.clockLabel}</span>
                <span className="c-seg c-seg-big" role="group" aria-label={s.clockAria}>
                  <button
                    type="button"
                    aria-pressed={clockEnabled}
                    onClick={() => setClockEnabled(true)}
                  >
                    {s.clockTimed}
                  </button>
                  <button
                    type="button"
                    aria-pressed={!clockEnabled}
                    onClick={() => setClockEnabled(false)}
                  >
                    {s.clockUntimed}
                  </button>
                </span>
              </div>
              <p className="muted small c-hint">
                {clockEnabled
                  ? fill(s.clockHintTimed, { summary: CLOCK_SUMMARY }) +
                    (opponentKind === 'bot' ? s.clockHintTimedBot : s.clockHintTimedHuman)
                  : s.clockHintUntimed}
              </p>
            </div>

            <details className="c-adv">
              <summary>{s.advancedSummary}</summary>
              <div className="c-adv-body">
                <div className="c-num-row c-area-row">
                  <span className="c-num-label" id="c-area-label">
                    {s.areaLabel}
                  </span>
                  <span className="c-seg" role="group" aria-labelledby="c-area-label">
                    {SCORING_AREA_IDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={scoringAreaId === id}
                        onClick={() => setScoringAreaId(id)}
                      >
                        {SCORING_AREA_LABEL[lang][id]}
                        {id === 'center' && s.areaDefaultSuffix}
                      </button>
                    ))}
                  </span>
                </div>
                <p className="muted small c-hint">
                  {fill(s.areaHint1, {
                    onlyMover: s.onlyMoverWord,
                    squares: squareList(scoringArea.squares),
                  })}
                </p>
                <p className="muted small c-hint">{s.areaHint2}</p>

                <div className="c-num-row c-dist-row">
                  <span className="c-num-label" id="c-dist-label">
                    {s.distLabel}
                  </span>
                  {/* Same control semantics as the 計分區 picker above — a group
                      of aria-pressed buttons, not a role="radio" group, because
                      nothing here implements the arrow-key navigation a
                      radiogroup promises. Three options that each carry a
                      sentence of justification only need the shape to change. */}
                  <div className="c-choices" role="group" aria-labelledby="c-dist-label">
                    {DISTRIBUTION_IDS.map((id) => {
                      const text = DISTRIBUTION_TEXT[lang][id]
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
                            <span className="c-choice-name">{text.label}</span>
                            <span className="c-choice-what">
                              {id === 'standard' ? s.distDefaultSuffix : `— ${text.what}`}
                            </span>
                          </span>
                          {/* what it is FOR, not what it is */}
                          <span className="c-choice-why">{text.why}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <p className="muted small c-hint">
                  {s.distTotalPrefix}{' '}
                  <strong className={distributionSize === PIECES_PER_SIDE ? undefined : 'c-bad'}>
                    {distributionSize}
                  </strong>{' '}
                  {s.distTotalUnit}
                  {distributionSize === PIECES_PER_SIDE ? '' : fill(s.distTotalBad, { n: PIECES_PER_SIDE })}
                  {distributionChanges === '' ? (
                    s.distSameAsStandard
                  ) : (
                    <>
                      {s.distDiffPrefix} <code className="c-sq">{distributionChanges}</code>。
                    </>
                  )}
                </p>
                <p className="muted small c-hint">{distributionText.note}</p>

                <label className="c-num-row">
                  <span className="c-num-label">{s.xLabel}</span>
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
                  {fill(s.xHint1, {
                    onlyMover: s.onlyMoverBold,
                    currentSquares: s.currentSquaresBold,
                    autoFill: s.autoFillBold,
                    centerLabel: SCORING_AREA_LABEL[lang].center,
                    centerX: SCORING_AREA_DEFAULT_X.center,
                    wideLabel: SCORING_AREA_LABEL[lang].wide,
                    wideX: SCORING_AREA_DEFAULT_X.wide,
                    defaultX: DEFAULT_CONFIG.scoreTarget,
                    undecided: s.undecidedWord,
                  })}
                  {' '}
                  {wideArea ? s.xHintWide : s.xHintCentre}
                </p>

                {/*
                 * 吃子得分 (§7.3) — the OTHER source of points, and the only one
                 * that is off by default. It sits directly under 目標分數 X
                 * because it is the same currency: whatever is set here is spent
                 * against that line.
                 */}
                <label className="c-num-row">
                  <span className="c-num-label">{s.kLabel}</span>
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
                  {fill(s.kHint1, { winner: s.winnerWord })}
                </p>
                <p className="muted small c-hint">
                  {fill(s.kHint2, {
                    zeroMeans: s.kZeroMeans,
                    engineDefault: DEFAULT_CONFIG.captureScoreK,
                    formDefault: FORM_DEFAULT_CAPTURE_K,
                    mustBeInt: s.kMustBeInt,
                  })}
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">{s.fizzleLabel}</span>
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
                  {fill(s.fizzleHint, {
                    survivor: s.survivorWord,
                    zeroMeans: s.fizzleZeroMeans,
                    engineDefault: DEFAULT_CONFIG.fizzleBonus,
                    formDefault: FORM_DEFAULT_FIZZLE_BONUS,
                  })}
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">{s.noProgressLabel}</span>
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
                  {fill(s.noProgressHint, { n: DEFAULT_CONFIG.noProgressTurns })}
                </p>

                <label className="c-num-row">
                  <span className="c-num-label">{s.setupLabel}</span>
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
                  {fill(s.setupHint, { random: s.randomWord })}
                </p>
              </div>
            </details>
          </section>

          <button className="primary big" type="button" onClick={onCreate} disabled={busy}>
            {busy ? s.createBusy : opponentKind === 'bot' ? s.createBot : s.createHuman}
          </button>
          <p className="muted small">
            {s.footerMemory}
            {opponentKind === 'bot' ? s.footerBotSuffix : s.footerHumanSuffix}
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}

      {created && (
        <section className="panel">
          <h2>{s.createdTitle}</h2>
          <p className="muted small">
            {s.summaryGameId} {created.game.gameId} ·{' '}
            {created.bot !== null ? `${s.summaryOpponentBot} ${botPolicyLabel(created.bot.policy, lang)} · ` : ''}
            {created.options.clockEnabled ? `${s.summaryClock} ${CLOCK_SUMMARY}` : s.summaryUntimed} · {s.summaryArea}{' '}
            {created.options.scoringSquares.length} {s.summaryAreaUnit} · {s.summaryDist}{' '}
            {distributionName(created.options.distribution, lang)} · {s.summaryTarget} {created.options.scoreTarget} {s.summaryTargetUnit}
            {/* §7.3 is off unless it was switched on, and a line reading
                「吃子 k 0」 would suggest otherwise — so a default game's summary
                is byte-for-byte the one it printed before this setting existed. */}
            {created.options.captureScoreK > 0 && <> · {s.summaryK} {created.options.captureScoreK}</>}
            {created.options.fizzleBonus > 0 && <> · {s.summaryFizzle}{created.options.fizzleBonus}</>}
            {' '}· {s.summaryNoProgress} {created.options.noProgressTurns} {s.summaryNoProgressUnit} · {s.summarySetup}{' '}
            {Math.round(created.options.setupTimeoutMs / 60_000)} {s.summarySetupUnit}
          </p>

          {/*
           * Asked for a bot and got a human game back. Not a detail to swallow:
           * the player would otherwise sit at a board waiting for a move that
           * is never coming. The invite link below is the honest way out.
           */}
          {created.requestedBot !== null && created.bot === null && (
            <p className="error">{s.botFallbackError}</p>
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
                {fill(s.botCreatedHeadline, {
                  name: `${lang === 'zh' ? '機器人' : 'Bot'} · ${botPolicyLabel(created.bot.policy, lang)}`,
                })}
              </div>
              {/* the coin flip already ran (§9) and may well have handed the
                  human Black — say so before the board does */}
              <div className="c-bot-seat">
                {fill(s.botCreatedSeat, {
                  seat: seatLabel(created.game.hostColor, lang),
                  firstMoveNote: created.game.hostColor === 'black' ? s.botFirstMoveNote : '',
                })}
              </div>
              <p className="muted small c-hint">{s.botNextStep}</p>
              <p>
                <a className="primary big as-button" href={localizeUrl(created.game.hostUrl)}>
                  {s.botEnter}
                </a>
              </p>
              <p className="muted small">{s.botEntering}</p>
            </div>
          ) : (
            <>
            {opponentUrl !== '' && (
              <div className="link-row">
                <div className="link-label c-label-row">
                  <span>
                    {fill(s.inviteLabel, {
                      seat: seatLabel(created.game.guestColor ?? other(created.game.hostColor), lang),
                    })}
                  </span>
                  <span className="c-seg" role="group" aria-label={s.linkFormAria}>
                    <button
                      type="button"
                      aria-pressed={opponentMode === 'human'}
                      onClick={() => chooseOpponentMode('human')}
                    >
                      {s.linkFormHuman}
                    </button>
                    <button
                      type="button"
                      aria-pressed={opponentMode === 'llm'}
                      onClick={() => chooseOpponentMode('llm')}
                    >
                      {s.linkFormLlm}
                    </button>
                  </span>
                </div>
                <code className="link">{opponentUrl}</code>
                <button type="button" onClick={() => void copy('guest', opponentUrl)}>
                  {copied === 'guest' ? s.copyDone : s.copyAction}
                </button>
                <p className="muted small c-hint c-seat-note">{s.seatNote}</p>
                <p className="muted small c-hint">
                  {opponentMode === 'llm' ? s.llmHint : s.humanUrlHint}
                </p>
              </div>
            )}

            <div className="link-row">
              <p className="muted small c-hint">{s.coinNote}</p>

              <div className="link-label">{fill(s.hostLabel, { seat: seatLabel(created.game.hostColor, lang) })}</div>
              <code className="link">{created.game.hostUrl}</code>
              <button type="button" onClick={() => void copy('host', created.game.hostUrl)}>
                {copied === 'host' ? s.copyDone : s.copyAction}
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
                  <span>{s.publicLabel}</span>
                  <span className="c-safe">{s.publicSafe}</span>
                </div>
                <code className="link">{publicUrl}</code>
                <button type="button" onClick={() => void copy('public', publicUrl)}>
                  {copied === 'public' ? s.copyDone : s.copyAction}
                </button>
                <p className="muted small c-hint">{s.publicHint1}</p>
                <p className="muted small c-hint">
                  <strong className="c-careful">{s.publicCareful}</strong>
                  {s.publicHint2}
                </p>
              </div>
            )}

            <p>
              <a className="primary big as-button" href={localizeUrl(created.game.hostUrl)}>
                {s.hostEnter}
              </a>
            </p>
            <p className="muted small">{s.domainNote}</p>
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
