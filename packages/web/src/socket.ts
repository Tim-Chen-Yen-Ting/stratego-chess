import { io, type Socket } from 'socket.io-client'
import type { Color, Move, PieceId, Rank, ViewerState } from '@xiyang/rules'
import { other } from './format.js'

/**
 * Client transport (techspec §5). The socket carries exactly four outbound
 * events and two inbound ones. Every inbound `state` was produced by the
 * server's `stateForViewer()` — the client never sees a rank it is not
 * entitled to, so there is nothing to filter here.
 */

export interface ServerToClientEvents {
  state: (s: ViewerState) => void
  error: (e: { message: string }) => void
}

export interface ClientToServerEvents {
  join: (p: { token: string }) => void
  assign: (p: { assignment: Record<PieceId, Rank> }) => void
  move: (p: { move: Move }) => void
  resign: (p: Record<string, never>) => void
}

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface GameSocketHandlers {
  onState: (s: ViewerState) => void
  onError: (message: string) => void
  onOpen: () => void
  onClose: () => void
}

/**
 * Connects to the same origin. In dev, Vite proxies `/socket.io` through to
 * the Fastify server; in production the server serves this build itself, so a
 * same-origin connection is correct in both cases (techspec §8).
 */
export function connectGame(token: string, handlers: GameSocketHandlers): GameSocket {
  const socket: GameSocket = io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  })

  // `join` is re-sent on every (re)connect: on reconnect the server replies
  // with a fresh state for this viewer (gamebook §10 — 重連時重送的是該觀看者
  // 視角的狀態).
  socket.on('connect', () => {
    socket.emit('join', { token })
    handlers.onOpen()
  })
  socket.on('disconnect', () => handlers.onClose())
  socket.on('connect_error', (err: Error) => handlers.onError(err.message || '連線失敗'))
  socket.on('state', (s) => handlers.onState(s))
  socket.on('error', (e) => handlers.onError(e?.message ?? '未知錯誤'))

  return socket
}

// ---------------------------------------------------------------------------
// 機器人對局 — the bot roster and the seat it occupies
// ---------------------------------------------------------------------------

/**
 * One entry of the bot roster, as the create screen offers it and the game
 * screen names it.
 *
 * `id` is the server's own policy key (`POLICIES` in `@xiyang/bot`) and is the
 * only part that travels: the label and the sentence are this client's words for
 * it. The roster is duplicated here rather than imported because `@xiyang/bot`
 * is a Node package and the web client takes no new dependency for a list of
 * three strings — an unknown id therefore renders as itself (see
 * `botPolicyLabel`) instead of vanishing, which is what an out-of-date roster
 * should look like.
 */
export interface BotPolicyInfo {
  /** the policy key the server understands */
  id: string
  /** 中文 name shown in the picker */
  label: string
  /** one line: what this opponent actually does */
  line: string
}

/**
 * Ordered strongest-intent first. `contest` is the default because it is the
 * only one that starts fights: `greedy` never initiates a capture at all, and a
 * first game against an opponent that refuses every contact would show none of
 * the hidden layer this game is about.
 */
export const BOT_POLICIES: readonly BotPolicyInfo[] = [
  {
    id: 'contest',
    label: '爭奪',
    line: '先佔沒人站的計分格；沒有空格可佔時，就直接撞上對手正踩著的那一格。中央四格很快就沒有空位，所以它真的會跟你打——不知道對面是什麼兵種也照撞。',
  },
  {
    id: 'greedy',
    label: '佔點',
    line: '只走能多佔一格計分格的著法：從不主動吃子，也絕不移動軍旗。安靜，而且比看起來難纏——它不會犯錯，只會一直加分。',
  },
  {
    id: 'random',
    label: '亂走',
    line: '在合法著法裡均勻亂選。這是基準線而不是對手：用來對照別的機器人有多強，拿來練棋沒有意義。',
  },
]

export const DEFAULT_BOT_POLICY = 'contest'

export function botPolicyInfo(id: string): BotPolicyInfo | undefined {
  return BOT_POLICIES.find((p) => p.id === id)
}

/** 「爭奪（contest）」, or the bare id when this build does not know the name. */
export function botPolicyLabel(id: string): string {
  if (id === '') return '機器人'
  const info = botPolicyInfo(id)
  return info === undefined ? id : `${info.label}（${info.id}）`
}

/**
 * The seat a bot occupies in a live game.
 *
 * A bot is a PLAYER (gamebook §10.1): it is handed
 * `stateForViewer(state, { kind: 'player', color })` and nothing else, exactly
 * like the human across the table. So there is nothing to render about it
 * beyond these two facts — which chair it sits in, and which policy is driving
 * it. Its 兵種 are not in this client's payload and never will be.
 */
export interface BotSeat {
  /**
   * Which colour the bot plays, or null when the source did not say. Null still
   * means "the opponent is a bot"; a seated player can fill in the colour
   * themselves, because the bot is the side they are not.
   */
  color: Color | null
  /** the policy id, or '' when the source named a bot but not its policy */
  policy: string
}

function readColor(value: unknown): Color | null {
  return value === 'white' || value === 'black' ? value : null
}

function readPolicy(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * What the other chair holds, as the server describes it.
 *
 * `POST /api/game` and `GET /api/links/:token` both answer with
 * `opponent: { kind: 'human' }` or
 * `opponent: { kind: 'bot', policy, color, thinkMs }`. Every field is public:
 * a colour is public by §1 and a policy name says nothing whatever about a
 * deployment.
 */
export interface OpponentDescription {
  kind?: string
  policy?: string
  color?: Color
  /** how long the server makes the bot appear to think, ms */
  thinkMs?: number
}

/** Confirmed bot, confirmed human, or "this payload does not say". */
export type OpponentAnswer = BotSeat | 'human' | null

/**
 * Pull the opponent out of a payload of unknown vintage.
 *
 * Deliberately structural, and deliberately tri-valued. Three different
 * payloads can carry this fact — the create response, the links response, and
 * (should a build ever grow one) a marker on the state itself — and the client
 * cannot prove which server build it is talking to. A payload that says nothing
 * yields null, which means UNKNOWN and never 「human」: the difference decides
 * whether a caller may fall back to a weaker source or must stop.
 */
export function readOpponent(source: unknown): OpponentAnswer {
  if (typeof source !== 'object' || source === null) return null
  const probe = source as Record<string, unknown>

  const described = probe['opponent'] ?? probe['bot']
  if (typeof described === 'object' && described !== null) {
    const rec = described as Record<string, unknown>
    const kind = rec['kind']
    if (kind === 'human') return 'human'
    if (kind !== undefined && kind !== 'bot') return null
    const color = readColor(rec['color'])
    const policy = readPolicy(rec['policy'] ?? rec['name'])
    // `{ bot: {...} }` with no `kind` is still a bot, but an empty object is
    // not evidence of anything
    if (kind === undefined && color === null && policy === '') return null
    return { color, policy }
  }

  const color = readColor(probe['botColor'])
  const policy = readPolicy(probe['botPolicy'])
  if (color === null && policy === '') return null
  return { color, policy }
}

/** The bot seat only — `'human'` and 「unknown」 both collapse to null. */
export function readBotSeat(source: unknown): BotSeat | null {
  const answer = readOpponent(source)
  return answer === null || answer === 'human' ? null : answer
}

/**
 * Ask the server who is in the other chair (`GET /api/links/:token`).
 *
 * This is the authority for a screen reached by a fresh page load, which knows
 * only its token. The route is already the client's way of asking what its own
 * token entitles it to, and it answers `opponent` for every viewer — a bot's
 * policy name is common knowledge, and knowing one is playing does not reveal
 * a single 兵種.
 *
 * Returns null on any failure. A network hiccup must degrade to "say nothing",
 * never to a claim about the opponent.
 */
export async function fetchOpponent(token: string): Promise<OpponentAnswer> {
  try {
    const res = await fetch(`/api/links/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return readOpponent(await res.json())
  } catch {
    return null
  }
}

// --- the local memo -------------------------------------------------------
//
// The create screen knows it asked for a bot; the game screen, reached by a
// fresh page load through the host link, does not. When the server marks the
// payload (`readBotSeat` above) that is the authority and this is unused. When
// it does not, this carries the one fact across the navigation.
//
// It is a NOTE ABOUT A CHOICE THE USER MADE, not information: whether the
// opponent is a bot is the creator's own decision, already on their screen, so
// storing it grants nobody anything. No rank, no token and no state ever goes
// in here — those belong to the server (gamebook §10).

const BOT_MEMO_PREFIX = 'xiyang.bot.'
const BOT_MEMO_VERSION = 1
/** a memo for a game nobody has opened in a week is dropped on the next write */
const BOT_MEMO_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface BotMemo {
  v: number
  savedAt: number
  color: Color | null
  policy: string
}

function botMemoKey(token: string): string {
  return `${BOT_MEMO_PREFIX}${token}`
}

function pruneBotMemos(keep: string): void {
  try {
    const now = Date.now()
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key === null || !key.startsWith(BOT_MEMO_PREFIX) || key === keep) continue
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<BotMemo> | null
        const savedAt = parsed?.savedAt
        if (parsed?.v !== BOT_MEMO_VERSION) doomed.push(key)
        else if (typeof savedAt !== 'number' || now - savedAt > BOT_MEMO_TTL_MS) doomed.push(key)
      } catch {
        doomed.push(key)
      }
    }
    for (const key of doomed) window.localStorage.removeItem(key)
  } catch {
    // storage disabled — the memo degrades to "the server had better say so"
  }
}

export function rememberBotGame(token: string, seat: BotSeat): void {
  const key = botMemoKey(token)
  pruneBotMemos(key)
  try {
    const memo: BotMemo = {
      v: BOT_MEMO_VERSION,
      savedAt: Date.now(),
      color: seat.color,
      policy: seat.policy,
    }
    window.localStorage.setItem(key, JSON.stringify(memo))
  } catch {
    // ignore
  }
}

export function recallBotGame(token: string): BotSeat | null {
  try {
    const raw = window.localStorage.getItem(botMemoKey(token))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<BotMemo> | null
    if (parsed === null || parsed.v !== BOT_MEMO_VERSION) return null
    const savedAt = parsed.savedAt
    if (typeof savedAt !== 'number' || Date.now() - savedAt > BOT_MEMO_TTL_MS) return null
    return { color: readColor(parsed.color), policy: readPolicy(parsed.policy) }
  } catch {
    return null
  }
}

export interface CreatedGame {
  gameId: string
  hostToken: string
  hostUrl: string
  hostColor: Color
  /**
   * Who took the other chair — `{ kind: 'human' }`, or `{ kind: 'bot', … }` for
   * a 機器人對局. Optional because a build that predates bot games omits it
   * entirely, which is 「unknown」 and not 「human」 (see `readOpponent`).
   */
  opponent?: OpponentDescription
  /**
   * THE INVITE LINK, AND WHY IT IS OPTIONAL.
   *
   * In a bot game there is no second person, and the guest seat is the BOT's.
   * Its token is a player token: whoever holds it joins as that colour and is
   * served that colour's whole army, sixteen 兵種 the human is playing against.
   * So the server does not issue it, and this field is absent — the create
   * screen shows no invite row at all rather than a link reading "undefined",
   * which is the difference between an honest UI and one that hands the player
   * the answer key.
   *
   * The same reasoning makes `guestToken`, `guestColor`, `spectatorUrl` (bound
   * to a colour, §10.2 ①) and `omniscientUrl` (both armies, §10.2 ③) optional:
   * every one of them is a legitimate field of a human game and a leak in a bot
   * game, and the client cannot prove which build it is talking to. It renders
   * what it is given and nothing else.
   */
  guestUrl?: string
  guestToken?: string
  guestColor?: Color
  /** bound to the host's colour — that player's whole view (gamebook §10.2 ①) */
  spectatorUrl?: string
  /** both armies, live. Host-only in a human game; withheld in a bot game */
  omniscientUrl?: string
  /** the host's own seat rendered as text for a chatbot (techspec §6) */
  llmUrl?: string
  /**
   * 公開觀戰連結 — a token that resolves to the seatless viewer (gamebook §10).
   * It carries no colour, so it hands over nobody's 兵種: the board, the public
   * log and the 翻明 ranks, and nothing else. This is the one link that can be
   * forwarded while the game is running.
   *
   * Optional because the client cannot prove what a given server build sends —
   * the response is parsed, not validated. A build that predates the public
   * viewer simply omits it, and the Create screen then shows no such row rather
   * than a link reading "undefined".
   */
  publicUrl?: string
  /** what the server actually built — may differ from what was requested */
  setupTimeoutMs?: number
  scoreTarget?: number
  noProgressTurns?: number
  clockEnabled?: boolean
  scoringSquares?: readonly number[]
}

/**
 * Did this creation actually seat a bot, and where?
 *
 * Two independent witnesses, because the client cannot interrogate the server
 * build it happens to be talking to:
 *
 *   1. an explicit `bot` marker — the authority whenever it is present;
 *   2. the MISSING invite link. A human game always issues one; a bot game
 *      cannot, because that token is the bot's own seat. So when a bot was
 *      requested and no `guestUrl` came back, the request was honoured.
 *
 * Returns null when a bot was requested and neither witness appears — meaning
 * the server ignored the request and built an ordinary two-human game. That is
 * a case the caller must show rather than paper over: silently presenting a bot
 * game that is really waiting for a second person leaves the player staring at
 * a board nobody is sitting opposite.
 */
export function botSeatOf(game: CreatedGame, requestedPolicy: string | null): BotSeat | null {
  const declared = readOpponent(game)
  if (declared === 'human') return null
  if (declared !== null) {
    return {
      color: declared.color ?? other(game.hostColor),
      policy: declared.policy || (requestedPolicy ?? ''),
    }
  }
  if (requestedPolicy !== null && game.guestUrl === undefined) {
    return { color: other(game.hostColor), policy: requestedPolicy }
  }
  return null
}

// POST /api/game lives in Create.tsx (postCreateGame), which sends the config
// body the creation form builds. Only the CreatedGame type is shared from here.
