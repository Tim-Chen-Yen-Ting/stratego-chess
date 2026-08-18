/**
 * GET-only LLM interface — techspec §6.
 *
 *   GET /llm/:token              current position, text/plain
 *   GET /llm/:token/rules        rules primer, text/plain
 *   GET /llm/:token/setup/:code  deploy an army during setup (§9)
 *   GET /llm/:token/:ply/:move   play the move, return the new position
 *
 * GET-only because web chatbots can fetch but cannot POST. That makes every URL
 * something a link preview or an eager retry might hit, so `:ply` is a guard: if
 * it does not match the current ply the move is NOT applied and the caller just
 * gets the position back with a note. Moves are therefore idempotent.
 *
 * The position always comes from `serialiseFor()` (→ `stateForViewer`) and is
 * rendered by `renderForLLM` from the rules package. The model gets the log and
 * nothing else — no solver, same as a human (gamebook §10).
 *
 * Every route here accepts EVERY token the room minted, but only the first two
 * are readable by all of them. The state and rules routes are read-only, so a
 * spectator token — bound or public — gets exactly the view that token is worth.
 * The setup and move routes require a PLAYER token and refuse everything else
 * outright: a 觀戰者 holds a view, never a seat (§10.2), so there is no colour it
 * could act as. See `seatRefusal`.
 *
 * Notation is NOT re-implemented here. `renderForLLM` prints every move URL using
 * the rules package's `moveToNotation`, so this file parses them back with that
 * package's `parseMoveNotation` and they round-trip by construction. The only
 * thing added locally is tolerance for the shapes a model types by hand.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  decodeSetupCode,
  encodeSetupCode,
  moveToNotation,
  parseMoveNotation,
  renderForLLM,
  renderRulesForLLM,
  squareName,
} from '@xiyang/rules'
import type { Color, GameConfig, Move, PieceId, Rank, Viewer, ViewerState } from '@xiyang/rules'

import {
  RoomError,
  playMove,
  randomAssignment,
  resolveToken,
  serialiseFor,
  submitRankAssignment,
  type Resolved,
} from './rooms.js'

// ------------------------------------------------------------- notation

/**
 * Canonical first — that is the exact string the printed URLs carry. Everything
 * after is tolerance for hand-typed input: `e2-e4`, `e2xe4`, `e7e8=Q`, `0-0`,
 * a trailing `+`/`#`/`!`. Reducing to the canonical form and handing off keeps
 * one parser in the system rather than two that can drift.
 */
export function parseMoveToken(raw: string): Move | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const direct = parseMoveNotation(trimmed)
  if (direct !== null) return direct

  const lowered = trimmed.toLowerCase()
  if (lowered === 'skip' || lowered === 'none') return { kind: 'pass' }

  const castling = lowered.replace(/[-_\s]/g, '').replace(/0/g, 'o')
  if (castling === 'oo' || castling === 'ooo') return parseMoveNotation(castling)

  return parseMoveNotation(lowered.replace(/[-x=_\s+#!?]/g, ''))
}

type Selection = { ok: Move } | { problem: string }

/**
 * Resolve a parsed move against the legal list the redaction layer handed us.
 * This is matching, not legality: `legalMoves` already decided what is legal,
 * and matching against the very list that was printed guarantees that anything
 * the model was offered is something the model can play.
 */
function selectLegalMove(parsed: Move, legal: readonly Move[]): Selection {
  if (parsed.kind === 'pass') {
    const pass = legal.find((candidate) => candidate.kind === 'pass')
    return pass === undefined ? { problem: 'pass is not available' } : { ok: pass }
  }

  if (parsed.kind === 'castle') {
    const castle = legal.find(
      (candidate) => candidate.kind === 'castle' && candidate.side === parsed.side,
    )
    return castle === undefined
      ? { problem: `${moveToNotation(parsed)} is not available` }
      : { ok: castle }
  }

  const candidates = legal.filter(
    (candidate): candidate is Extract<Move, { kind: 'move' }> =>
      candidate.kind === 'move' && candidate.from === parsed.from && candidate.to === parsed.to,
  )
  if (candidates.length === 0) {
    return { problem: `${moveToNotation(parsed)} is not a legal move here` }
  }

  if (parsed.promote !== undefined) {
    const exact = candidates.find((candidate) => candidate.promote === parsed.promote)
    return exact === undefined
      ? { problem: `${moveToNotation(parsed)} is not a legal move here` }
      : { ok: exact }
  }

  const first = candidates[0]
  if (candidates.length === 1 && first !== undefined) return { ok: first }
  return {
    problem: `${squareName(parsed.from)}${squareName(parsed.to)} promotes — add q, r, b or n`,
  }
}

// ------------------------------------------------------------- rendering

function noteBlock(notes: readonly string[]): string {
  if (notes.length === 0) return ''
  return `${notes.map((note) => `> NOTE: ${note}`).join('\n')}\n\n`
}

/**
 * The one place LLM output is assembled. The position itself is whatever
 * `serialiseFor` + `renderForLLM` produce; everything added here is chrome.
 */
function renderPosition(session: Resolved, baseUrl: string, notes: readonly string[]): string {
  const state = serialiseFor(session.room, session.viewer)
  const extra = [...notes]

  if (state.status.kind === 'setup') {
    extra.push(
      'the game has not started: both sides are still assigning 兵種 in secret. ' +
        'If a side never deploys, the server rolls a RANDOM army for it when the setup ' +
        'timer runs out and play begins. Re-fetch this URL to check.',
    )
  }

  const body = renderForLLM(state, { baseUrl, token: session.token })
  return `${noteBlock(extra)}${body}\n`
}

function plain(reply: FastifyReply, body: string, status = 200): void {
  void reply
    .status(status)
    .header('Cache-Control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(body)
}

/**
 * Why a token that is not a player token cannot act, in that viewer's own terms.
 *
 * Both mutating routes below refuse every non-player viewer. That refusal is
 * deliberate and total, not a side effect of the seat lookup: gamebook §10 gives
 * a 觀戰者 a VIEW and never a seat, so there is no colour to act as. Saying which
 * kind of watcher the caller is matters, because the two arrive by very different
 * links — a bound spectator was let in by one player, while a public observer may
 * have been handed the link by anyone — and a model told only "you cannot play"
 * will otherwise keep trying.
 */
function seatRefusal(viewer: Viewer, what: 'deployed' | 'played'): string {
  const nothing = what === 'deployed' ? 'nothing was deployed' : 'no move was made'
  switch (viewer.kind) {
    case 'spectator-public':
      return (
        'this link is the public observer view of a live game: no seat, no colour, and no ' +
        `兵種 beyond the ones already announced — so ${nothing}. Nothing you fetch under ` +
        'this token can change the game. Only the two players can act.'
      )
    case 'spectator':
      return (
        `you are watching this game over ${viewer.bound === 'white' ? 'White' : 'Black'}'s ` +
        `shoulder, not playing it, so ${nothing}. Acting is that player's alone.`
      )
    default:
      return `you are watching this game, not playing it, so ${nothing}.`
  }
}

/** Keep hostile or oversized path segments out of the rendered text. */
function echoable(raw: string): string {
  const cleaned = raw.replace(/[^\x20-\x7e]/g, '').slice(0, 24)
  return cleaned.length === 0 ? '(empty)' : cleaned
}

// ------------------------------------------------------------- routes

export function registerLlmRoutes(app: FastifyInstance, baseUrl: string): void {
  app.get<{ Params: { token: string } }>('/llm/:token', (request, reply) => {
    const session = resolveToken(request.params.token)
    if (session === undefined) {
      notFound(reply)
      return
    }
    plain(reply, renderPosition(session, baseUrl, []))
  })

  app.get<{ Params: { token: string } }>('/llm/:token/rules', (request, reply) => {
    const session = resolveToken(request.params.token)
    if (session === undefined) {
      notFound(reply)
      return
    }
    const state = serialiseFor(session.room, session.viewer)
    // the primer prints §2 counts, which are per-game (附錄 B) — hand it this
    // game's table or it teaches the model the wrong army
    const primer = renderRulesForLLM(
      { baseUrl, token: session.token },
      state.config.distribution,
    )
    plain(reply, `${primer}\n${settingsBlock(state)}`)
  })

  // Deployment (§9). Static "setup" outranks the parametric ":ply" of the move
  // route below, so the two never collide.
  app.get<{ Params: { token: string } }>('/llm/:token/setup', (request, reply) => {
    const session = resolveToken(request.params.token)
    if (session === undefined) {
      notFound(reply)
      return
    }
    // No code in the URL, so nothing is deployed — just show the instructions,
    // which the position itself carries while this player is still in setup. A
    // watcher gets the same refusal as `/setup/:code`: telling a viewer with no
    // seat to "append your 16 characters" invites it to keep fetching a route
    // that will never do anything for it.
    plain(
      reply,
      renderPosition(session, baseUrl, [
        session.viewer.kind === 'player'
          ? 'that URL has no setup code on the end, so nothing was deployed. ' +
            'Append your 16 characters, or the word random.'
          : seatRefusal(session.viewer, 'deployed'),
      ]),
    )
  })

  app.get<{ Params: { token: string; code: string } }>(
    '/llm/:token/setup/:code',
    // Mutating, exactly like the move route: a HEAD from a link unfurler must
    // not deploy an army the player never chose.
    { exposeHeadRoute: false },
    (request, reply) => {
      const session = resolveToken(request.params.token)
      if (session === undefined) {
        notFound(reply)
        return
      }
      plain(reply, attemptSetup(session, baseUrl, request.params.code))
    },
  )

  app.get<{ Params: { token: string; ply: string; move: string } }>(
    '/llm/:token/:ply/:move',
    // Fastify auto-registers HEAD for every GET. A HEAD would APPLY the move and
    // return no body, so the mover never sees the result — and link unfurlers
    // issue HEAD routinely. That is exactly the scenario the ply guard exists to
    // stop, so the route must not answer HEAD at all.
    { exposeHeadRoute: false },
    (request, reply) => {
      const session = resolveToken(request.params.token)
      if (session === undefined) {
        notFound(reply)
        return
      }
      plain(reply, attemptMove(session, baseUrl, request.params.ply, request.params.move))
    },
  )
}

function notFound(reply: FastifyReply): void {
  plain(
    reply,
    'Unknown token. This game link is not valid — it may have expired with a server restart.\n',
    404,
  )
}

// ------------------------------------------------------------- setup

/** `/setup/random` — the one code that is a word rather than a deployment. */
const RANDOM_CODE = 'random'

/**
 * GET /llm/:token/setup/<code|random> — deploy this player's 16 兵種 (§9).
 *
 * Nothing about the format is decided here: `decodeSetupCode` owns the code and
 * `validateAssignment` (through it, and again through `submitRankAssignment`)
 * owns legality. The random deployment is built in rooms.ts, which is where the
 * server's entropy lives — the rules package stays deterministic.
 *
 * A deployment is one-way. Both refusals below matter: after setup there is no
 * such thing as deploying, and a second deployment would let a player rewrite an
 * army the opponent may already have been playing against.
 */
function attemptSetup(session: Resolved, baseUrl: string, codeParam: string): string {
  const viewer = session.viewer
  // A seat is required before anything else is even looked at — the code in the
  // URL is not parsed, no state is touched. Deploying is the one act that writes
  // a whole army, and only its owner may do it (§9 互不可見).
  if (viewer.kind !== 'player') {
    return renderPosition(session, baseUrl, [seatRefusal(viewer, 'deployed')])
  }

  const state = serialiseFor(session.room, viewer)
  if (state.status.kind !== 'setup') {
    return renderPosition(session, baseUrl, [
      state.status.kind === 'playing'
        ? 'both armies are already deployed and play has started, so nothing was deployed. ' +
          'Setup is over; play a move instead.'
        : 'the game is over, so nothing was deployed.',
    ])
  }

  if (state.status.submitted[viewer.color]) {
    return renderPosition(session, baseUrl, [
      'you have already deployed. A deployment is final and cannot be changed, ' +
        'so nothing was done. Your army is listed below.',
    ])
  }

  const wantsRandom = codeParam.trim().toLowerCase() === RANDOM_CODE
  let assignment: Record<PieceId, Rank> = {}

  if (!wantsRandom) {
    const decoded = decodeSetupCode(codeParam, viewer.color, session.room.state)
    if ('error' in decoded) {
      return renderPosition(session, baseUrl, [`${decoded.error} Nothing was deployed.`])
    }
    assignment = decoded.assignment
  }

  try {
    // randomAssignment belongs inside the guard too: it can raise RoomError, and
    // escaping here would surface as a JSON 500 on a route that promises text/plain.
    if (wantsRandom) assignment = randomAssignment(session.room.state, viewer.color)
    submitRankAssignment(session.room, viewer.color, assignment)
  } catch (error) {
    const message = error instanceof RoomError ? error.message : 'that deployment was refused'
    return renderPosition(session, baseUrl, [`${message}, so nothing was deployed.`])
  }

  return renderPosition(session, baseUrl, [deployedNote(session, viewer.color, wantsRandom)])
}

/**
 * Echo back what was deployed. The code is read out of the REDACTED view, so
 * this path cannot print a 兵種 the caller was not already entitled to — and the
 * caller here is the owner of that army.
 */
function deployedNote(session: Resolved, color: Color, wasRandom: boolean): string {
  const how = wasRandom ? 'deployed a random army' : 'deployed your army'
  try {
    const code = encodeSetupCode(serialiseFor(session.room, session.viewer), color)
    return `${how} — your setup code is ${code}. It is final, and only this view shows it.`
  } catch {
    return `${how}. It is final.`
  }
}

// ------------------------------------------------------------- moves

function attemptMove(
  session: Resolved,
  baseUrl: string,
  plyParam: string,
  moveParam: string,
): string {
  const viewer = session.viewer

  // The seat check comes FIRST, before the ply guard, the turn check and the
  // notation parse. A watcher is not "wrong about the ply" or "not on turn" — it
  // has no seat at all, and every later branch below is written for someone who
  // does. `playMove` would refuse this too, but only incidentally: it is handed a
  // colour, and there is no colour to hand it for a viewer that owns none.
  if (viewer.kind !== 'player') {
    return renderPosition(session, baseUrl, [seatRefusal(viewer, 'played')])
  }

  const state = serialiseFor(session.room, viewer)

  if (state.status.kind !== 'playing') {
    const reason =
      state.status.kind === 'setup'
        ? 'the game has not started yet, so no move was made.'
        : 'the game is over, so no move was made.'
    return renderPosition(session, baseUrl, [reason])
  }

  // The idempotency guard. Anything that re-fetches an old URL lands here.
  const wantedPly = Number.parseInt(plyParam, 10)
  if (!Number.isInteger(wantedPly) || wantedPly !== state.ply) {
    return renderPosition(session, baseUrl, [
      `that URL plays at ply ${echoable(plyParam)}, but the game is at ply ${state.ply}. ` +
        'Nothing was played — this move was probably already made. ' +
        'Use one of the URLs listed below.',
    ])
  }

  if (state.toMove !== viewer.color) {
    return renderPosition(session, baseUrl, [
      `it is ${state.toMove}'s turn, so no move was made. Re-fetch to see their reply.`,
    ])
  }

  const parsed = parseMoveToken(moveParam)
  if (parsed === null) {
    return renderPosition(session, baseUrl, [
      `could not read "${echoable(moveParam)}" as a move. ` +
        'Use e2e4, e7e8q for a promotion, O-O, O-O-O, or pass.',
    ])
  }

  const legal = state.legalMoves
  let chosen = parsed
  if (legal !== undefined) {
    const selection = selectLegalMove(parsed, legal)
    if ('problem' in selection) {
      return renderPosition(session, baseUrl, [
        `${selection.problem}, so nothing was played. Pick one of the URLs below.`,
      ])
    }
    chosen = selection.ok
  }

  try {
    playMove(session.room, viewer.color, chosen)
  } catch (error) {
    const message = error instanceof RoomError ? error.message : 'that move was refused'
    return renderPosition(session, baseUrl, [`${message}, so nothing was played.`])
  }

  return renderPosition(session, baseUrl, [`played ${moveToNotation(chosen)}.`])
}

// ------------------------------------------------------------- settings

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * 吃子得分係數 k (§7.3), as one column of the settings table.
 *
 * Zero is the shipped default and reads as an explicit "off" rather than a bare
 * 0: a model that has just been told points exist must be able to see that this
 * particular source of them is switched off in the game it is actually in.
 */
function captureScoreText(config: GameConfig): string {
  return config.captureScoreK === 0
    ? '0 — 吃子 pays no points in this game'
    : `${config.captureScoreK} × the WINNER's 階級 number, to the winner's side`
}

/** 有煙無傷獎勵 (§7.3, §5.4) — a FLAT amount, never a function of any 兵種. */
function fizzleBonusText(config: GameConfig): string {
  return config.fizzleBonus === 0
    ? '0 — a 有煙無傷 pays no points in this game'
    : `${config.fizzleBonus} points to the SURVIVING side of a 有煙無傷`
}

/**
 * The primer itself is `renderRulesForLLM` — the rules package owns every word of
 * it, because it is a statement of the rules. What is appended here is this
 * game's tunable NUMBERS (gamebook 附錄 B: settings, never hard-coded), read off
 * the redacted ViewerState.
 *
 * That split used to have one exception. The primer's 「## Scoring」 section
 * presented 佔領計分格 as the only source of points — true at the shipped k = 0
 * and false at any other value — so this block carried a conditional paragraph
 * about what the coefficient multiplies, to stop a bare 「capture score k  2」
 * underneath it from handing the model a number it had been told could not
 * exist. `renderRulesForLLM` now states §7.3 itself: both §7.1 sources, the three
 * outcome rows, that ① is paid in the action phase and therefore need not land on
 * the mover, and that the amounts are settings which may be zero. The paragraph
 * has moved there, as its own comment said it should, and this block is numbers
 * alone at every k. The one-line descriptions beside the two §7.3 numbers stay —
 * they say what the VALUE is, which is this block's job, not what the rule is.
 */
function settingsBlock(state: ViewerState): string {
  const config: GameConfig = state.config
  const clock = config.clockEnabled
    ? `${formatClock(config.clockInitialMs)} + ${Math.round(config.clockIncrementMs / 1000)}s increment`
    : 'disabled for this game — take as long as you like'

  return `## This game's settings
score target      ${config.scoreTarget} points
stagnation limit  ${config.noProgressTurns} full turns
komi              ${config.komi} to Black
capture score k   ${captureScoreText(config)}
fizzle bonus      ${fizzleBonusText(config)}
clock             ${clock}
`
}
