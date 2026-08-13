/**
 * Bootstrap — techspec §5, §8.
 *
 * One Fastify 5 instance on one port serving three things: the JSON/HTTP API,
 * the Socket.IO endpoint (attached to the same http.Server) and the built web
 * client as static files with an SPA fallback. Single origin, so no CORS and no
 * second service.
 *
 *   POST /api/game            create a game, get the invite links back
 *   GET  /api/game/:token     ViewerState as JSON
 *   GET  /api/links/:token    the share/LLM links that belong to this token
 *   GET  /healthz             200
 *   GET  /llm/...             see llm.ts (techspec §6)
 *   GET  /*                   static client build, falling back to index.html
 *
 * PORT comes from the environment (Render supplies it) and falls back to 3000.
 * PUBLIC_BASE_URL is needed only to build absolute LLM move URLs; locally it
 * defaults to http://localhost:PORT.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { Server as SocketIOServer } from 'socket.io'

import { ALL_RANKS, checkDistribution, viewerColor } from '@xiyang/rules'
import type { GameConfig, Rank, Viewer } from '@xiyang/rules'

import { registerLlmRoutes } from './llm.js'
import {
  createRoom,
  disposeAll,
  resolveToken,
  roomCount,
  seatColor,
  serialiseFor,
  type Room,
} from './rooms.js'
import { registerSocketHandlers, type GameServer, type ServerLog } from './sockets.js'

const here = dirname(fileURLToPath(import.meta.url))
/** dist/index.js and src/index.ts both sit two levels above packages/web/dist. */
const WEB_DIST = resolve(here, '../../web/dist')
const WEB_INDEX = join(WEB_DIST, 'index.html')

const PORT = readPort()
const HOST = process.env.HOST ?? '0.0.0.0'
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(
  /\/+$/,
  '',
)

/** Client-side route that turns a token into a seat at the table. */
function playUrl(token: string): string {
  return `${PUBLIC_BASE_URL}/g/${token}`
}

function llmUrl(token: string): string {
  return `${PUBLIC_BASE_URL}/llm/${token}`
}

function readPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000
}

// --------------------------------------------------------------- config input

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

/**
 * Whatever the caller sends is untrusted input, not a rules decision: the bounds
 * below only stop a client from parking the server on an absurd timer. Anything
 * omitted keeps the rules engine's own default (gamebook 附錄 B).
 */
function readConfig(input: unknown): Partial<GameConfig> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const raw = input as Record<string, unknown>
  const config: Partial<GameConfig> = {}

  const scoreTarget = clampNumber(raw['scoreTarget'], 1, 10_000)
  if (scoreTarget !== undefined) config.scoreTarget = scoreTarget

  const noProgressTurns = clampNumber(raw['noProgressTurns'], 1, 10_000)
  if (noProgressTurns !== undefined) config.noProgressTurns = noProgressTurns

  const komi = clampNumber(raw['komi'], 0, 1_000)
  if (komi !== undefined) config.komi = komi

  const clockInitialMs = clampNumber(raw['clockInitialMs'], 1_000, 86_400_000)
  if (clockInitialMs !== undefined) config.clockInitialMs = clockInitialMs

  const clockIncrementMs = clampNumber(raw['clockIncrementMs'], 0, 600_000)
  if (clockIncrementMs !== undefined) config.clockIncrementMs = clockIncrementMs

  const setupTimeoutMs = clampNumber(raw['setupTimeoutMs'], 1_000, 3_600_000)
  if (setupTimeoutMs !== undefined) config.setupTimeoutMs = setupTimeoutMs

  if (typeof raw['clockEnabled'] === 'boolean') config.clockEnabled = raw['clockEnabled']

  // The engine trusts this list, so it is sanitised here rather than there:
  // integers only, on the board, deduped, and never empty — a game with no
  // scoring squares could not be won on points at all.
  const rawSquares = raw['scoringSquares']
  if (Array.isArray(rawSquares)) {
    const squares = [
      ...new Set(
        rawSquares.filter(
          (sq): sq is number => Number.isInteger(sq) && (sq as number) >= 0 && (sq as number) < 64,
        ),
      ),
    ].sort((a, b) => a - b)
    if (squares.length > 0) config.scoringSquares = squares
  }

  // Same treatment as scoringSquares, and for the same reason: the engine trusts
  // this table, so it is sanitised at the door. Built key-by-key over ALL_RANKS
  // so an unknown key cannot survive, and assigned only if it is a legal §2
  // table — checkDistribution owns the sum-16 rule, this does not restate it.
  const rawDist = raw['distribution']
  if (typeof rawDist === 'object' && rawDist !== null && !Array.isArray(rawDist)) {
    const src = rawDist as Record<string, unknown>
    const table = {} as Record<Rank, number>
    let ok = true
    for (const rank of ALL_RANKS) {
      const n = src[rank]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) { ok = false; break }
      table[rank] = n
    }
    if (ok && checkDistribution(table) === null) config.distribution = table
  }

  return Object.keys(config).length === 0 ? undefined : config
}

// --------------------------------------------------------------- logging

/**
 * Strip token segments out of a URL before it reaches the log stream.
 * `/llm/abc123/14/e2e4` -> `/llm/***\/14/e2e4`, `/api/game/abc123` -> `/api/game/***`.
 */
export function redactTokens(url: string): string {
  return url
    .replace(/^\/llm\/[^/?]+/, '/llm/***')
    .replace(/^\/api\/game\/[^/?]+/, '/api/game/***')
    .replace(/^\/api\/links\/[^/?]+/, '/api/links/***')
    .replace(/^\/g\/[^/?]+/, '/g/***')
}

// --------------------------------------------------------------- app

export function buildApp(): ReturnType<typeof Fastify> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        // Tokens ARE the auth. Fastify logs req.url by default, which would put
        // every player's bearer credential into the log stream.
        req(request: { method: string; url: string; ip?: string }) {
          return {
            method: request.method,
            url: redactTokens(request.url),
            remoteAddress: request.ip,
          }
        },
      },
    },
    trustProxy: true,
    // A 16-char setup code is well under this, but a mistyped one must still
    // reach decodeSetupCode so the caller gets its self-correcting text/plain
    // message. Fastify's default of 100 drops anything longer into the JSON
    // 404 handler, which breaks the text/plain contract of the LLM routes.
    maxParamLength: 512,
  })

  // A bare `POST /api/game` with a JSON content-type and no body is normal here.
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body.trim().length === 0) {
        done(null, {})
        return
      }
      try {
        done(null, JSON.parse(body) as unknown)
      } catch (error) {
        done(error as Error, undefined)
      }
    },
  )

  app.get('/healthz', async () => ({ ok: true, games: roomCount() }))

  app.post<{ Body: { config?: unknown } | undefined }>('/api/game', async (request) => {
    const room = createRoom(readConfig(request.body?.config))
    return describeNewRoom(room)
  })

  app.get<{ Params: { token: string } }>('/api/game/:token', async (request, reply) => {
    const session = resolveToken(request.params.token)
    if (session === undefined) {
      void reply.status(404)
      return { error: 'unknown token' }
    }
    void reply.header('Cache-Control', 'no-store')
    return serialiseFor(session.room, session.viewer)
  })

  // gamebook §10: a spectator enters through a specific player and inherits that
  // player's view, so each player needs the link that hands out their own view.
  // Two shareable links come back, and they are not interchangeable —
  // `spectatorUrl` is bound to a colour and carries that player's whole army,
  // `publicUrl` is bound to nobody and carries only what has been announced.
  app.get<{ Params: { token: string } }>('/api/links/:token', async (request, reply) => {
    const session = resolveToken(request.params.token)
    if (session === undefined) {
      void reply.status(404)
      return { error: 'unknown token' }
    }
    void reply.header('Cache-Control', 'no-store')
    const viewer: Viewer = session.viewer
    return {
      gameId: session.room.id,
      viewer,
      seat: session.seat ?? null,
      color: viewerColor(viewer),
      // hand this to a friend to have them watch over your shoulder — it carries
      // YOUR army, so it goes to someone you would show your hand to
      // A bound-spectator link belongs to a seat. The public observer has none,
      // and echoing its own token back under this name just duplicates publicUrl.
      spectatorUrl:
        viewer.kind === 'player'
          ? playUrl(session.room.spectatorTokens[viewer.color])
          : viewer.kind === 'spectator-public'
            ? null
            : playUrl(session.token),
      // …and this one to anybody at all: no colour, no seat, nothing but 翻明
      // ranks and the public log. Offered to every token holder, spectators
      // included, because sharing it can never widen what the recipient learns.
      publicUrl: playUrl(session.room.publicToken),
      llmUrl: viewer.kind === 'player' ? llmUrl(session.token) : null,
      // the same neutral view as text, for a model watching the game
      publicLlmUrl: llmUrl(session.room.publicToken),
    }
  })

  registerLlmRoutes(app, PUBLIC_BASE_URL)

  if (existsSync(WEB_DIST)) {
    void app.register(fastifyStatic, {
      root: WEB_DIST,
      index: ['index.html'],
      maxAge: '1h',
      setHeaders: (response, filePath) => {
        // the shell must never be cached; hashed assets under /assets may be
        if (filePath.endsWith('.html')) response.setHeader('Cache-Control', 'no-cache')
      },
    })
  } else {
    app.log.warn(`web client build not found at ${WEB_DIST} — serving API only`)
  }

  // SPA fallback: any unmatched GET that is not an API path gets the shell.
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/'
    const isApi =
      path.startsWith('/api') ||
      path.startsWith('/llm') ||
      path.startsWith('/socket.io') ||
      path === '/healthz'

    if (isApi || (request.method !== 'GET' && request.method !== 'HEAD')) {
      void reply.status(404)
      return { error: 'not found' }
    }

    try {
      const shell = await readFile(WEB_INDEX, 'utf8')
      void reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache')
      return shell
    } catch {
      void reply.status(503).type('text/plain; charset=utf-8')
      return 'The web client has not been built yet. Run: npm run build\n'
    }
  })

  return app
}

function describeNewRoom(room: Room): Record<string, unknown> {
  const hostColor = room.hostColor
  const guestColor = seatColor(room, 'guest')
  const hostToken = room.playerTokens[hostColor]
  const guestToken = room.playerTokens[guestColor]
  // even a scalar off the config comes through the serialiser — there is exactly
  // one road out of a GameState in this package and it runs through redaction
  const config = serialiseFor(room, { kind: 'player', color: hostColor }).config

  return {
    gameId: room.id,
    hostToken,
    guestToken,
    hostUrl: playUrl(hostToken),
    guestUrl: playUrl(guestToken),
    // gamebook §9: the coin flip already happened, server-side
    hostColor,
    guestColor,
    // ONLY the host's own links. Returning the opponent's spectator token would
    // let the creator read every enemy 兵種 for the whole game — the redactor
    // would work perfectly and still hand over everything, because it would be
    // given the wrong Viewer. Each player gets their own colour's spectator link
    // from GET /api/game/:token instead.
    spectatorUrl: playUrl(room.spectatorTokens[hostColor]),
    // THE ONE LINK THAT IS SAFE TO SHARE WITH ANYONE MID-GAME, and the reason it
    // exists. `spectatorUrl` above is bound to one player and shows that player's
    // whole army (§10.2 「與其進入時所綁定玩家的視角完全相同」), so posting it in a
    // group chat hands sixteen 兵種 to whoever is reading — including the
    // opponent. This one resolves to `{ kind: 'spectator-public' }`, which is
    // entitled to a rank only once it is 翻明 (§4.3) or the game is over (§10.5):
    // strictly the common knowledge of both players, so it cannot relay anything
    // either player does not already have. Both are returned because they answer
    // different questions — "watch over my shoulder" vs "watch the game".
    publicUrl: playUrl(room.publicToken),
    llmUrl: llmUrl(hostToken),
    // Echo back what the server ACTUALLY built, not what was asked for. The
    // creation form confirms the settings to the player, and confirming a value
    // that was clamped or dropped on the way in is worse than not confirming it.
    setupTimeoutMs: config.setupTimeoutMs,
    scoreTarget: config.scoreTarget,
    noProgressTurns: config.noProgressTurns,
    clockEnabled: config.clockEnabled,
    scoringSquares: config.scoringSquares,
    distribution: config.distribution,
  }
}

// --------------------------------------------------------------- start

async function main(): Promise<void> {
  const app = buildApp()

  const io: GameServer = new SocketIOServer(app.server, {
    serveClient: false,
    path: '/socket.io',
  })

  const log: ServerLog = {
    info: (message) => {
      app.log.info(message)
    },
    warn: (message) => {
      app.log.warn(message)
    },
    error: (message) => {
      app.log.error(message)
    },
  }

  registerSocketHandlers(io, log)

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    app.log.info(`${signal} received, shutting down`)
    void io.close()
    disposeAll()
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    shutdown('SIGTERM')
  })

  await app.listen({ port: PORT, host: HOST })
  app.log.info(`行軍西洋棋 server ready — public base URL ${PUBLIC_BASE_URL}`)
}

/**
 * Only listen when this file IS the process. `buildApp` is exported so it can be
 * driven in-process, and importing it must not bind a port. Anything other than a
 * clean "argv[1] is some other file" answer falls through to starting, so the
 * normal `node dist/index.js` path can never be argued out of running.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return true
  try {
    return resolve(invoked) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return true
  }
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`failed to start: ${error instanceof Error ? error.message : 'unknown'}\n`)
    process.exit(1)
  })
}
