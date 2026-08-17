/**
 * LLM text rendering. techspec §6, gamebook §10.
 *
 * `renderForLLM` takes a **ViewerState** and nothing else. It is structurally
 * incapable of leaking a hidden 兵種, because a redacted rank is simply `null`
 * by the time it gets here. Everything else it prints — the board, the log,
 * the notation, the "revealed on ply N" annotations — is derived from the
 * public log plus the fixed opening position.
 *
 * Per gamebook §10 the model gets the 紀錄 but no 解算: no candidate-rank sets,
 * no inference help. Same deal a human player gets.
 */

import {
  FILES,
  castlePlan,
  fileOf,
  opposite,
  rankOf,
  squareName,
} from '../board.js'
import {
  CARRIER_LETTER,
  DEFAULT_CONFIG,
  RANK_NAMES_ZH,
  RANK_ORDER,
} from '../constants.js'
import { moveToNotation } from '../moves.js'
import { STARTING_LAYOUT } from '../setup.js'
import {
  SETUP_CODE_ALPHABET,
  encodeSetupCode,
  setupCodeCombinations,
  setupCodeExample,
  setupCodeLegend,
  setupCodeLength,
  setupCodeSlots,
} from '../setupcode.js'
import { viewerColor } from '../redact.js'
import type {
  Carrier,
  Color,
  GameEvent,
  Rank,
  RankDistribution,
  Result,
  Square,
  ViewerPiece,
  ViewerState,
} from '../types.js'

export interface RenderOptions {
  baseUrl: string
  token: string
}

// ---------------------------------------------------------------------------
// small formatters
// ---------------------------------------------------------------------------

function colorLabel(c: Color): string {
  return c === 'white' ? 'White' : 'Black'
}

function scoreText(n: number): string {
  return String(n)
}

function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function rankText(rank: Rank): string {
  const zh = RANK_NAMES_ZH[rank]
  if (rank === 'bomb') return `${zh}(—)`
  return `${zh}(${RANK_ORDER[rank as Exclude<Rank, 'bomb'>]})`
}

/** Board reading order: rank 8 first, a-file first. */
function readingOrder(a: Square, b: Square): number {
  const dr = rankOf(b) - rankOf(a)
  return dr !== 0 ? dr : fileOf(a) - fileOf(b)
}

function resultText(r: Result): string {
  switch (r.kind) {
    case 'flag':
      return `${colorLabel(r.winner)} wins — 奪旗: the opponent's 軍旗 left the board.`
    case 'flag-both':
      return 'Draw — both 軍旗 left the board on the same ply. This is the only draw in the game.'
    case 'score':
      return `${colorLabel(r.winner)} wins on score.`
    case 'no-progress':
      return `${colorLabel(r.winner)} wins — 停滯: no capture and no point for the full stagnation limit; higher score takes it.`
    case 'timeout':
      return `${colorLabel(r.winner)} wins on time.`
    case 'resign':
      return `${colorLabel(r.winner)} wins — opponent resigned.`
  }
}

// ---------------------------------------------------------------------------
// Public-log replay
//
// The log carries squares, not piece ids, so to print `Nf3xe5` (and to say
// which ply a piece was revealed on) the renderer replays the public record
// over the fixed opening position. Everything consumed here is public.
// ---------------------------------------------------------------------------

interface PublicCell {
  color: Color
  carrier: Carrier
  /** ply on which this piece was 翻明, if the log announced it */
  revealedPly?: number
}

interface Replay {
  /** annotated log lines, one per event */
  lines: string[]
  /** square → ply on which the piece now standing there was revealed */
  revealedPly: Map<Square, number>
}

function initialPublicBoard(): (PublicCell | undefined)[] {
  const board = new Array<PublicCell | undefined>(64)
  for (const slot of STARTING_LAYOUT) {
    board[slot.square] = { color: slot.color, carrier: slot.carrier }
  }
  return board
}

function moveNotationFor(e: GameEvent, board: (PublicCell | undefined)[]): string {
  if (e.move.kind === 'pass') return 'pass'
  if (e.move.kind === 'castle') return e.move.side === 'king' ? 'O-O' : 'O-O-O'

  const { from, to } = e.move
  const cell = board[from]
  const lead = cell && cell.carrier !== 'pawn' ? CARRIER_LETTER[cell.carrier] : ''
  const sep = e.combat ? 'x' : '-'
  const ep = e.combat && e.combat.defenderSquare !== to ? ' e.p.' : ''
  const promo = e.promoted ? `=${CARRIER_LETTER[e.promoted]}` : ''
  return `${lead}${squareName(from)}${sep}${squareName(to)}${promo}${ep}`
}

function combatText(e: GameEvent, board: (PublicCell | undefined)[]): string {
  if (!e.combat) return ''
  const { outcome, defenderSquare, survivorSquare } = e.combat
  const mover = e.color
  const other = opposite(mover)
  const defCell = board[defenderSquare]
  const defCarrier = defCell ? `${defCell.carrier} ` : ''
  const atkCell = board[e.combat.attackerSquare]
  const atkCarrier = atkCell ? `${atkCell.carrier} ` : ''

  switch (outcome.kind) {
    case 'attacker-wins':
      return `${colorLabel(mover)} ${atkCarrier}revealed ${RANK_NAMES_ZH[outcome.winnerRank]}; ${colorLabel(other)} piece removed`
    case 'defender-wins':
      return `${colorLabel(other)} ${defCarrier}revealed ${RANK_NAMES_ZH[outcome.winnerRank]}; ${colorLabel(mover)} piece removed`
    // 同歸於盡 is ONE announcement covering every way two pieces can leave
    // together, and it carries nothing — no 兵種, no colour. The line says so
    // outright, because a model that is not told the announcement is
    // deliberately ambiguous will read the silence as a rank tie and start
    // counting the opponent's 爆裂物 off the log. There is nothing to count:
    // an equal 兵種 and a 爆裂物 produce these same words.
    case 'mutual-destruction':
      return '同歸於盡 — both pieces removed; NOTHING revealed. Equal 兵種 or a 爆裂物 — the two are announced identically, so which it was cannot be known'
    case 'fizzle': {
      const where = survivorSquare === null ? '?' : squareName(survivorSquare)
      return `有煙無傷 — ${colorLabel(outcome.survivorColor)}'s ${where} piece is 工兵 or 軍旗 (a 爆裂物 was lost against it)`
    }
  }
}

function replayLog(log: readonly GameEvent[]): Replay {
  const board = initialPublicBoard()
  const lines: string[] = []

  for (const e of log) {
    const notation = moveNotationFor(e, board)
    const detail = combatText(e, board)
    const promoNote = e.promoted ? `promotes to ${e.promoted}` : ''
    const note = [detail, promoNote].filter(Boolean).join('; ')
    const head = `${String(e.ply).padStart(3, ' ')}  ${e.color === 'white' ? 'W' : 'B'} ${notation.padEnd(12, ' ')}`
    lines.push(note ? `${head}  ${note}` : head.trimEnd())

    applyToPublicBoard(board, e)
  }

  const revealedPly = new Map<Square, number>()
  for (let sq = 0; sq < 64; sq++) {
    const cell = board[sq]
    if (cell?.revealedPly !== undefined) revealedPly.set(sq, cell.revealedPly)
  }
  return { lines, revealedPly }
}

function applyToPublicBoard(board: (PublicCell | undefined)[], e: GameEvent): void {
  if (e.move.kind === 'pass') return

  if (e.move.kind === 'castle') {
    const plan = castlePlan(e.color, e.move.side)
    const king = board[plan.kingFrom]
    const rook = board[plan.rookFrom]
    board[plan.kingFrom] = undefined
    board[plan.rookFrom] = undefined
    if (king) board[plan.kingTo] = king
    if (rook) board[plan.rookTo] = rook
    return
  }

  const { from, to } = e.move

  if (!e.combat) {
    const cell = board[from]
    board[from] = undefined
    if (cell) board[to] = e.promoted ? { ...cell, carrier: e.promoted } : cell
    return
  }

  const { outcome, attackerSquare, defenderSquare, survivorSquare } = e.combat
  const atk = board[attackerSquare]
  const def = board[defenderSquare]
  board[attackerSquare] = undefined
  board[defenderSquare] = undefined
  // en passant: the mover's destination is neither of the contact squares
  board[to] = undefined

  let survivor: PublicCell | undefined
  let survivorIsAttacker = false
  let revealedNow = false

  switch (outcome.kind) {
    case 'attacker-wins':
      survivor = atk
      survivorIsAttacker = true
      revealedNow = true
      break
    case 'defender-wins':
      survivor = def
      revealedNow = true
      break
    case 'fizzle':
      // 有煙無傷 reveals nothing; a previously revealed survivor stays revealed.
      survivorIsAttacker = outcome.survivorColor === e.color
      survivor = survivorIsAttacker ? atk : def
      break
    case 'mutual-destruction':
      // Nobody stands, and the event says nothing about who they were. The
      // board replay needs neither: both contact squares are cleared above.
      survivor = undefined
      break
  }

  if (survivor && survivorSquare !== null) {
    const carrier = survivorIsAttacker && e.promoted ? e.promoted : survivor.carrier
    board[survivorSquare] = {
      color: survivor.color,
      carrier,
      ...(revealedNow ? { revealedPly: e.ply } : survivor.revealedPly !== undefined ? { revealedPly: survivor.revealedPly } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderBoard(vs: ViewerState): string[] {
  const cells = new Array<string>(64).fill('.')
  for (const p of vs.pieces) {
    if (p.square === null) continue
    const letter = CARRIER_LETTER[p.carrier]
    cells[p.square] = p.color === 'white' ? letter : letter.toLowerCase()
  }
  const out: string[] = ['  ' + FILES.join(' ')]
  for (let r = 7; r >= 0; r--) {
    const row: string[] = []
    for (let f = 0; f < 8; f++) row.push(cells[r * 8 + f]!)
    out.push(`${r + 1} ${row.join(' ')}`)
  }
  return out
}

function pieceLine(p: ViewerPiece, revealedPly: Map<Square, number> | null): string {
  const where = p.square === null ? 'off' : squareName(p.square)
  const rank = p.rank === null ? '???' : rankText(p.rank)
  const when = p.square !== null && p.revealed && revealedPly?.get(p.square) !== undefined
    ? `  (revealed ply ${revealedPly.get(p.square)})`
    : ''
  return `${where} ${p.carrier} ${rank}${when}`
}

function chunkJoin(items: string[], perLine: number): string[] {
  const out: string[] = []
  for (let i = 0; i < items.length; i += perLine) {
    out.push(items.slice(i, i + perLine).join(' · '))
  }
  return out
}

function onBoardOf(vs: ViewerState, color: Color): ViewerPiece[] {
  return vs.pieces
    .filter((p) => p.color === color && p.square !== null)
    .sort((a, b) => readingOrder(a.square!, b.square!))
}

// ---------------------------------------------------------------------------
// Setup — 兵種 assignment (gamebook §9)
//
// Two things must be true of this block. First, while a side has not deployed,
// the ranks sitting on its pieces are placeholders, so the view must not print
// them as though they were the player's own choices. Second, the deployment
// instructions have to be complete: alphabet, piece order, a worked example and
// both URLs, because a model reading this text is told nothing else.
//
// The piece order is not restated here — it comes from `setupCodeSlots`, the
// same function the decoder indexes with, so the printed order and the decoded
// order are one thing.
// ---------------------------------------------------------------------------

function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The 16 code positions: "1 a2 pawn · 2 b2 pawn · …". */
function slotLines(color: Color): string[] {
  const items = setupCodeSlots(color).map(
    (slot, i) => `${String(i + 1).padStart(2, ' ')} ${squareName(slot.square)} ${slot.carrier}`,
  )
  return chunkJoin(items, 4)
}

/**
 * What the worked example means, position by position.
 *
 * Deliberately labelled by SLOT NUMBER, never by square name. An example line
 * reading `a1='6' 營長` sits on the page beside a board where a1 is the reader's
 * own, still-undeployed piece — and a model has every reason to read that as a
 * statement about a1 rather than as an illustration. Slot numbers cannot be
 * mistaken for a deployment; the numbered piece-order list above already tells
 * the reader which square each slot is.
 */
function exampleLines(color: Color, distribution: RankDistribution): string[] {
  const legend = setupCodeLegend(distribution)
  const chars = Array.from(setupCodeExample(distribution))
  const items = setupCodeSlots(color).map((_slot, i) => {
    const ch = chars[i] ?? '?'
    const entry = legend.find((e) => e.letter === ch)
    return `#${String(i + 1).padStart(2, '0')}='${ch}' ${entry ? entry.zh : '?'}`
  })
  return chunkJoin(items, 4)
}

/** Never let a redacted rank turn a render into a throw. */
function tryEncodeSetupCode(vs: ViewerState, color: Color): string | null {
  try {
    return encodeSetupCode(vs, color)
  } catch {
    return null
  }
}

/**
 * The deployment instructions, for the 數量配置 of THIS game.
 *
 * Every number below — the code length, the ×counts in the table, the worked
 * example, how many deployments are legal — is read off `distribution`. A model
 * is told nothing else about the format, so a table copied from the default
 * preset into a game that was retuned (附錄 B) would have it write codes the
 * server then rejects, with no way to find out why.
 */
function deployLines(
  self: Color,
  base: string,
  token: string,
  distribution: RankDistribution,
): string[] {
  const url = (tail: string): string => `${base}/llm/${encodeURIComponent(token)}/setup/${tail}`
  const legend = setupCodeLegend(distribution)
  const length = setupCodeLength(distribution)
  const example = setupCodeExample(distribution)
  const out: string[] = []

  out.push('## Deploy — how to put your army on the board')
  out.push(
    `A deployment is a SETUP CODE: ${length} characters, one per piece, in the order`,
  )
  out.push(`listed above. Case does not matter. The alphabet is ${SETUP_CODE_ALPHABET} —`)
  out.push('one character per 兵種:')
  out.push('')
  // 兵種 names are CJK, so pad by display columns (2 each) rather than by
  // String#length, or the table steps sideways on 爆裂物.
  const cols = (zh: string): number => Array.from(zh).length * 2
  const zhWidth = Math.max(...legend.map((e) => cols(e.zh)))
  const enWidth = Math.max(...legend.map((e) => e.rank.length))
  for (const e of legend) {
    const zh = e.zh + ' '.repeat(zhWidth - cols(e.zh))
    out.push(`  ${e.letter}  ${zh}  ${e.rank.padEnd(enWidth)}  ×${e.count}`)
  }
  out.push('')
  out.push(
    `Every code must use each character exactly that many times. ${groupDigits(setupCodeCombinations(distribution))} deployments`,
  )
  out.push(
    `are valid out of ${SETUP_CODE_ALPHABET.length}^${length} possible strings, so most strings are NOT a deployment;`,
  )
  out.push('a rejected code comes back with the reason (bad length / bad character / wrong counts).')
  out.push('')
  out.push('Those counts are this game\'s setting (附錄 B), not a universal table — read them')
  out.push('off the list above rather than from anything you remember about the game.')
  out.push('')
  out.push(`Worked example — ${example} reads as:`)
  out.push(...exampleLines(self, distribution).map((line) => `  ${line}`))
  out.push(`  ${url(example)}`)
  out.push('That example is the 階級 ladder in order, so every reader of a game with these')
  out.push('counts sees the same string. It is here to show the shape, not to be played.')
  out.push('')
  out.push('Deploy a code of your own — replace the last part of the URL:')
  out.push(`  ${url(example.replace(/./g, '?'))}`)
  out.push('Or have the server roll a uniformly random legal deployment for you:')
  out.push(`  ${url('random')}`)
  out.push('')
  out.push('Fetching one of those URLs deploys immediately and is FINAL — a deployment cannot')
  out.push('be changed once submitted. If you never deploy, the server rolls a random one for')
  out.push('you when the setup timer runs out, and play begins.')
  return out
}

/** Replaces the "## Your pieces" / enemy blocks while the game is in setup. */
function setupOwnLines(
  vs: ViewerState,
  self: Color,
  submitted: boolean,
  base: string,
  token: string,
): string[] {
  const out: string[] = []
  const isPlayer = vs.viewer.kind === 'player'
  const owner = isPlayer ? 'Your' : `${colorLabel(self)}'s`

  if (!submitted) {
    out.push(`## ${owner} pieces — NO 兵種 ASSIGNED YET`)
    out.push(
      isPlayer
        ? 'Nothing is deployed. Your 16 carriers stand on their opening squares, but none of'
        : `${colorLabel(self)} has not deployed. The 16 carriers stand on their opening squares, but none of`,
    )
    out.push('them carries a 兵種 yet. The list below is not an army — it is only which')
    out.push('piece each position of a setup code refers to:')
    out.push(...slotLines(self))
    out.push('')
    if (isPlayer) out.push(...deployLines(self, base, token, vs.config.distribution))
    else out.push('(Watching only — deploying is up to that player.)')
    return out
  }

  out.push(`## ${owner} pieces  (deployed — waiting for the opponent)`)
  const mine = onBoardOf(vs, self).map((p) => pieceLine(p, null))
  out.push(...(mine.length ? chunkJoin(mine, 4) : ['(none)']))
  const code = tryEncodeSetupCode(vs, self)
  if (code !== null) out.push(`Setup code: ${code} — private to this view.`)
  out.push('The opponent is still assigning. Re-fetch this URL; play starts when both are in.')
  return out
}

// ---------------------------------------------------------------------------
// renderForLLM
// ---------------------------------------------------------------------------

/**
 * Who is standing on each scoring square, right now.
 *
 * This is board state, not 解算 — occupancy is the carrier layer, which is
 * public to everyone (gamebook §1), and it is exactly what the web client
 * already draws by highlighting those squares. Naming the squares without
 * saying who holds them left the model to re-derive occupancy from the ASCII
 * board every single ply, and across two LLM-vs-LLM games it stopped doing so:
 * a5 sat empty for 26 plies with a one-move pawn push available, unplayed.
 *
 * The EMPTY count is called out last because that is the actionable half —
 * an unoccupied scoring square is free income for whoever steps on it.
 */
function scoringOccupancy(
  vs: ViewerState,
  scoring: readonly Square[],
  self: Color | null,
): string[] {
  const bySquare = new Map<Square, ViewerPiece>()
  for (const p of vs.pieces) if (p.square !== null) bySquare.set(p.square, p)

  const cells: string[] = []
  let mine = 0
  let empty = 0
  for (const sq of scoring) {
    const piece = bySquare.get(sq)
    if (piece === undefined) {
      empty += 1
      cells.push(`${squareName(sq)} EMPTY`)
      continue
    }
    if (self !== null && piece.color === self) mine += 1
    cells.push(`${squareName(sq)} ${colorLabel(piece.color)} ${piece.carrier}`)
  }

  const out = chunkJoin(cells, 4)
  const tally =
    self === null
      ? `${empty} of ${scoring.length} EMPTY.`
      : `You hold ${mine} of ${scoring.length}. ${empty} EMPTY — free to take.`
  out.push(tally)
  return out
}

export function renderForLLM(vs: ViewerState, opts: RenderOptions): string {
  const self = viewerColor(vs.viewer)
  const base = opts.baseUrl.replace(/\/+$/, '')
  const lines: string[] = []

  // --- header ---------------------------------------------------------
  // TWO viewers have no colour, and they are opposites: the replay viewer sees
  // every 兵種, the public observer sees only the 翻明 ones. `self === null`
  // therefore identifies neither on its own, and the seatless paths below cannot
  // simply be inherited from the replay viewer — they were written for a reader
  // who knows everything. What the two share is that neither has a seat, so
  // nothing gated on `vs.viewer.kind === 'player'` (how to act, deployment
  // instructions, the move list) can reach either one.
  const publicOnly = vs.viewer.kind === 'spectator-public'
  const who = publicOnly
    ? 'public observer, no seat'
    : self === null
      ? 'omniscient replay view'
      : vs.viewer.kind === 'spectator'
        ? `you are watching ${colorLabel(self).toUpperCase()}`
        : `you are ${colorLabel(self).toUpperCase()}`
  lines.push(`# 行軍西洋棋 — ${who}`)
  if (publicOnly && vs.status.kind === 'over') {
    lines.push('You watched this game from the outside. It is over, so every 兵種 is open now')
    lines.push('(§10.5 終局公開全部兵種) — including the ones that were never 翻明.')
  } else if (publicOnly) {
    lines.push(
      'You are watching a live game from the outside. This view carries ONLY what both',
    )
    lines.push(
      'players already know in common: the carriers, the 翻明 兵種, and the public log.',
    )
    lines.push('Every other 兵種 shows as ??? — it is not withheld from display, it was never')
    lines.push('sent. You hold no seat here: you cannot deploy, move, or resign.')
  }

  const turn = vs.status.kind === 'over'
    ? 'game over'
    : vs.status.kind === 'setup'
      ? 'setup'
      : self === null || self !== vs.toMove
        ? `${colorLabel(vs.toMove)} to move`
        : 'your turn'
  const bits = [
    `Ply ${vs.ply}`,
    turn,
    `W ${scoreText(vs.score.white)} – B ${scoreText(vs.score.black)}`,
  ]
  if (vs.config.clockEnabled) {
    bits.push(`clock W ${clockText(vs.clockMs.white)} B ${clockText(vs.clockMs.black)}`)
  }
  lines.push(bits.join(' · '))
  lines.push('')

  // --- how to act ------------------------------------------------------
  // A reading agent will correctly notice that the action URLs below CHANGE
  // state on GET, and a cautious one then declines to fetch them — which is a
  // sensible default and exactly wrong here, because fetching IS the move. The
  // interface has to say so itself; the human relaying it cannot be relied on to.
  if (self !== null && vs.viewer.kind === 'player' && vs.status.kind !== 'over') {
    lines.push('## How to act')
    lines.push(
      'This is a two-player game server, and you hold one seat. Every action is a plain',
    )
    lines.push(
      'GET because chat tools can fetch a URL but cannot POST — so FETCHING one of the',
    )
    lines.push('URLs below IS your move. There is no separate submit step.')
    lines.push('')
    lines.push('Fetching an action URL here is intended and safe:')
    lines.push(
      '  · it affects only this one private game, created by the person you are talking to,',
    )
    lines.push('    who gave you this link in order to play;')
    lines.push(
      '  · move URLs carry the ply number, so fetching one twice does nothing the second',
    )
    lines.push('    time — a retry or a link preview cannot corrupt the game;')
    lines.push('  · nothing else on the server is reachable from these URLs.')
    lines.push('')
    lines.push('Pick one action, fetch it, and report what came back — the response is the')
    lines.push('new position.')
    lines.push('')
    lines.push(
      'EVERY legal move is listed at the bottom under "## Legal moves", with its URL already',
    )
    lines.push(
      'built. That list is EXHAUSTIVE and it is generated by the server, not by you. Do NOT',
    )
    lines.push('work a move out from the board — pick one off the list. Anything else is refused.')
    lines.push('')
    lines.push(
      'This matters more here than in most games. 行軍西洋棋 borrows its 兵種 from 軍棋 and its',
    )
    lines.push(
      'MOVEMENT entirely from chess, and the two are easy to blend. Real errors seen in play:',
    )
    lines.push(
      'a pawn capturing sideways, a pawn moving backwards — both legal in 軍棋, neither legal',
    )
    lines.push('here. Pawns move and capture exactly as in chess. So does everything else.')
    lines.push('')
    lines.push(
      "SAME RULE FOR THE SETTINGS. If you were given a strategy guide, it does NOT know this",
    )
    lines.push(
      "game's configuration — 結算格, 兵種 counts, X and N are all per-game (附錄 B). The",
    )
    lines.push(
      "squares listed under Scoring squares below are THIS game's, and they are the only ones",
    )
    lines.push("that score. Where a guide names squares and this view disagrees, THIS VIEW WINS.")
    lines.push('')
    lines.push(
      'IF YOUR TOOLS WILL NOT FETCH A URL YOU FOUND IN THIS PAGE — many will only fetch a',
    )
    lines.push(
      'URL a person pasted, to avoid following links out of fetched content — then do NOT',
    )
    lines.push('stall and do NOT invent a result.')
    lines.push('')
    lines.push(
      'DO NOT RETYPE THE TOKEN. It is 32 random characters; reconstructing it from memory',
    )
    lines.push('drops characters and the link then 404s. Name ONLY the short suffix, like this:')
    lines.push('')
    lines.push('    play: 14/g8f6          (or, during setup)    deploy: setup/4X1F29563785X9F6')
    lines.push('')
    lines.push(
      'and ask the person to append it to the game link they already have. If they do want',
    )
    lines.push('the whole URL, copy it verbatim from the list below — never rebuild it by hand.')
    lines.push('')
  }

  // --- result ---------------------------------------------------------
  if (vs.status.kind === 'over') {
    lines.push('## Result')
    lines.push(resultText(vs.status.result))
    lines.push('')
  }

  if (vs.status.kind === 'setup') {
    const submitted = vs.status.submitted
    const flag = (c: Color): string =>
      `${colorLabel(c)}: ${submitted[c] ? 'deployed' : 'NOT deployed yet'}`
    lines.push('## Setup — 兵種 assignment (§9)')
    lines.push(
      'The game has not started. Both sides assign their 16 兵種 in secret before the',
    )
    lines.push('first ply; play begins the moment both are in. No move can be played yet.')
    lines.push(`${flag('white')} · ${flag('black')}`)
    lines.push('')
  }

  // --- board ----------------------------------------------------------
  lines.push('## Board  (UPPERCASE = White, lowercase = black, . = empty)')
  lines.push(...renderBoard(vs))
  lines.push('')
  // The squares come from THIS game's config, never from the default preset.
  // The board shape is tunable (附錄 B), and a model told the wrong squares
  // would play a different game than the one it is sitting in.
  const scoring = vs.config.scoringSquares
  if (scoring.length === 0) {
    lines.push('No scoring squares are configured for this game — no piece scores by standing anywhere.')
    lines.push('')
  } else {
    lines.push(
      'Scoring squares — settlement runs after EVERY ply, but credits ONLY the player who',
    )
    lines.push(
      'just moved: +1 for each own piece of theirs standing on one. Your own squares pay',
    )
    lines.push(
      'you on your own plies, not on the opponent\'s, so each side banks once per turn.',
    )
    lines.push(...scoringOccupancy(vs, scoring, self))
    lines.push('')
  }

  const replay = replayLog(vs.log)

  // --- own pieces -----------------------------------------------------
  // While a side is still in setup its pieces carry placeholder 兵種, so they
  // must never be printed as that player's own. `setupOwnLines` prints the code
  // positions and the deployment instructions instead.
  const setupStatus = vs.status.kind === 'setup' ? vs.status : null

  if (publicOnly && setupStatus === null) {
    // The narrowest listing in the system. The omniscient path below prints one
    // undivided list per colour because every rank in it is known; here most are
    // not, so the two groups are printed APART rather than interleaved. That is
    // not cosmetic: chunkJoin puts four pieces on a line, so an interleaved list
    // would print a 翻明 兵種 on the same line as a hidden piece's square, and
    // line adjacency is the granularity both the redaction property suite and a
    // reader skimming the text actually work at.
    for (const color of ['white', 'black'] as const) {
      const onBoard = onBoardOf(vs, color)
      const known = onBoard.filter((p) => p.rank !== null)
      const hidden = onBoard.filter((p) => p.rank === null)

      lines.push(`## ${colorLabel(color)} pieces`)
      // At 終局 this view holds every 兵種, including ones that were never 翻明
      // — so it must not claim they were announced. Splitting the list has no
      // purpose here either: with nothing hidden there is nothing to keep apart.
      if (vs.status.kind === 'over') {
        lines.push('終局公開全部兵種 (§10.5) — the unrevealed ones are in here too:')
        lines.push(
          ...(known.length
            ? chunkJoin(known.map((p) => pieceLine(p, replay.revealedPly)), 4)
            : ['(none)']),
        )
        lines.push('')
        continue
      }

      lines.push('翻明 — announced, and known to both players:')
      lines.push(
        ...(known.length
          ? chunkJoin(known.map((p) => pieceLine(p, replay.revealedPly)), 4)
          : ['(none yet)']),
      )
      if (hidden.length > 0) {
        lines.push(`兵種 not public — ${hidden.length} piece(s), carrier and square only:`)
        lines.push(...chunkJoin(hidden.map((p) => pieceLine(p, null)), 4))
      }
      lines.push('')
    }
  } else if (self === null) {
    for (const color of ['white', 'black'] as const) {
      if (setupStatus !== null) {
        // `setupOwnLines` speaks to a SEAT — it prints "your" pieces, a private
        // setup code and "the opponent is still assigning". The omniscient
        // replay viewer can stand in for each side in turn; the public observer
        // cannot, because it has no side and no opponent. Give it the neutral
        // statement instead of a sentence addressed to somebody else.
        if (publicOnly) {
          lines.push(
            `## ${colorLabel(color)} — ${setupStatus.submitted[color] ? 'deployed' : 'not deployed yet'}`,
          )
          lines.push('兵種 are secret until 終局; nothing of either army is in this view.')
          lines.push('')
          continue
        }
        lines.push(...setupOwnLines(vs, color, setupStatus.submitted[color], base, opts.token))
        lines.push('')
        continue
      }
      lines.push(`## ${colorLabel(color)} pieces`)
      const items = onBoardOf(vs, color).map((p) => pieceLine(p, replay.revealedPly))
      lines.push(...(items.length ? chunkJoin(items, 4) : ['(none)']))
      lines.push('')
    }
  } else if (setupStatus !== null) {
    lines.push(...setupOwnLines(vs, self, setupStatus.submitted[self], base, opts.token))
    lines.push('')
  } else {
    lines.push('## Your pieces')
    const mine = onBoardOf(vs, self).map((p) => pieceLine(p, null))
    lines.push(...(mine.length ? chunkJoin(mine, 4) : ['(none)']))
    lines.push('')

    lines.push('## Known enemy ranks')
    const known = onBoardOf(vs, opposite(self))
      .filter((p) => p.rank !== null)
      .map((p) => pieceLine(p, replay.revealedPly))
    lines.push(...(known.length ? known : ['(none yet)']))
    lines.push('')

    const unknown = onBoardOf(vs, opposite(self)).filter((p) => p.rank === null).length
    lines.push(`${unknown} enemy piece(s) on the board still have an unknown 兵種. Reading the log is the game; no solver is provided.`)
    lines.push('')
  }

  // --- log ------------------------------------------------------------
  lines.push('## Public log')
  lines.push(...(replay.lines.length ? replay.lines : ['(no moves yet)']))
  lines.push('')

  // --- legal moves ----------------------------------------------------
  if (vs.legalMoves && vs.legalMoves.length > 0) {
    lines.push('## Legal moves — the complete list. Pick from here; nothing else is accepted')
    lines.push(`Fetching a move URL plays it. The ${vs.ply} in the URL is the ply guard: if the game has moved on, the move is ignored and you just get the current position back.`)
    for (const m of vs.legalMoves) {
      const n = moveToNotation(m)
      lines.push(`${n.padEnd(6, ' ')} ${base}/llm/${encodeURIComponent(opts.token)}/${vs.ply}/${encodeURIComponent(n)}`)
    }
  } else if (vs.status.kind === 'playing') {
    lines.push('## Legal moves')
    // "Not your turn" would promise a turn that is coming. A 公開觀戰者 never
    // gets one, so it is told the reason it has no list rather than a schedule.
    lines.push(
      publicOnly
        ? `No move list — this view holds no seat and cannot play. Refetch ${base}/llm/${encodeURIComponent(opts.token)} to follow the game.`
        : `Not your turn. Refetch ${base}/llm/${encodeURIComponent(opts.token)} after the opponent moves.`,
    )
  }
  lines.push('')
  lines.push(`Rules primer: ${base}/llm/${encodeURIComponent(opts.token)}/rules`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Rules primer — GET /llm/:token/rules (techspec §6)
// ---------------------------------------------------------------------------

/**
 * The rules primer.
 *
 * `distribution` is the 數量配置 of the game the reader is in. It is optional
 * only because a caller may genuinely have no game in hand (a bare
 * documentation route); anyone rendering this FOR a game must pass
 * `state.config.distribution`, or the ×counts in the 階級 table will describe a
 * different army than the one the reader is deploying (附錄 B).
 */
export function renderRulesForLLM(
  opts: RenderOptions,
  distribution: RankDistribution = DEFAULT_CONFIG.distribution,
): string {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const total = setupCodeLength(distribution)
  const table = (Object.keys(RANK_ORDER) as Exclude<Rank, 'bomb'>[])
    .sort((a, b) => RANK_ORDER[a] - RANK_ORDER[b])
    .map((r) => `  ${String(RANK_ORDER[r]).padStart(2, ' ')}  ${RANK_NAMES_ZH[r]}  ${r}  ×${distribution[r]}`)
    .join('\n')

  return `# 行軍西洋棋 — rules primer

Chess board and chess movement, carrying 行軍棋 ranks, hidden information and
rank-based capture. This is NOT chess. Read the overrides.

## Two layers per piece
- CARRIER (pawn/knight/bishop/rook/queen/king) — public. Decides how it MOVES.
- RANK 兵種 — private to its owner. Decides what it BEATS.
The layers are independent: 軍旗 can ride a queen, 司令 can ride a pawn.

## Ranks — lower number beats higher number
${table}
   —  爆裂物  bomb  ×${distribution.bomb}
Each side has exactly these ${total}. The ×counts are a setting of the game you are
in (附錄 B), so read them off the deployment screen rather than assuming.

## Movement overrides vs chess
- The king is an ORDINARY piece. No check, no checkmate. Capturing a king is
  just another rank comparison.
- Castling is unconditional: king and rook both still on their home squares,
  neither has ever moved, nothing between them. That is all.
- No stalemate. No insufficient material. No threefold repetition. No 50-move
  rule.
- pass is ALWAYS legal, even when you have other moves.
- En passant works exactly as in chess.
- Moving onto ANY enemy piece is legal, including a move you know loses.

## Capture — the whole thing
Compare ranks. Lower number wins.
- Attacker wins  → defender removed, attacker takes the square.
- Attacker LOSES → the ATTACKER is removed from the square it came FROM. It
  never enters the target square. The defender does not move.
- Equal ranks    → both removed, square empty, and NOTHING is announced.
The winner's rank is revealed permanently. The loser's rank is never revealed.

## 同歸於盡 — the announcement that says nothing
When two pieces leave the board together the announcement is 同歸於盡, and it
carries nothing: no 兵種, no colour, nothing that separates one case from
another. It covers three different events — equal 兵種, a 爆裂物 taking an
ordinary piece, and 爆裂物 against 爆裂物 — and they are indistinguishable ON
PURPOSE. Therefore:
- trading into a piece does NOT tell you it shared your 兵種. It may have been a
  爆裂物, and you cannot tell;
- you cannot count the opponent's 爆裂物 down. One that works is never named, so
  a 司令 is never provably safe;
- the ONLY event that identifies a 爆裂物 is 有煙無傷 below — a 爆裂物 that
  fizzles announces itself, a 爆裂物 that works stays secret.
Do not treat 同歸於盡 as evidence of a rank. It is evidence of a removal.

## 爆裂物 (bomb)
- Ties with everything, attacking or defending: both pieces are removed, and the
  announcement is the ordinary 同歸於盡. The bomb is not named and neither is
  the victim.
- EXCEPT against 工兵 and 軍旗, in both directions: the bomb simply loses and
  is removed, the 工兵/軍旗 is unharmed and is NOT revealed. Observers learn
  only that the survivor is "工兵 or 軍旗" (有煙無傷). If a surviving pawn
  reaches the 8th rank this way, it still promotes.

## 軍旗 (flag)
If your 軍旗 leaves the board by any route, you LOSE immediately — captured,
traded, or thrown at another piece. Promotion and castling do not count as
leaving the board. Both flags leaving on the same ply is the only draw.

## Scoring
Settlement runs after EVERY ply, but it credits ONLY the player who just moved:
+1 for each of that player's own pieces standing on a SCORING SQUARE. Your
squares pay you on your plies, the opponent's on theirs, so each side banks
exactly once per full turn — a piece parked on a scoring square earns you one
point a turn, not two. A pass settles as well: the passer is the mover.
Which squares those are is a setting of the game you are in (usually the four
centre squares d4 e4 d5 e5, but a game may be set up wider), so read them off
the "Scoring squares" line under the board in the state view rather than
assuming. Black starts at komi, which exists only to make ties impossible.
First to the score target wins. If nothing is captured and nobody scores for
the stagnation limit in full turns, the higher score wins.

## Clock
Increment is granted on a completed move, or on a FORCED pass (you had no
legal move). A voluntary pass gets no increment.

## How to play here
GET the state URL, pick one of the pre-built move URLs at the bottom, and GET
it. The ply number inside the URL is a guard: a stale one is ignored.

State: ${base}/llm/${encodeURIComponent(opts.token)}
`
}
