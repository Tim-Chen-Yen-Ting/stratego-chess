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
  CENTER_SQUARES,
  DISTRIBUTION,
  RANK_NAMES_ZH,
  RANK_ORDER,
} from '../constants.js'
import { moveToNotation } from '../moves.js'
import { STARTING_LAYOUT } from '../setup.js'
import {
  SETUP_CODE_ALPHABET,
  SETUP_CODE_COMBINATIONS,
  SETUP_CODE_EXAMPLE,
  SETUP_CODE_LEGEND,
  SETUP_CODE_LENGTH,
  encodeSetupCode,
  setupCodeSlots,
} from '../setupcode.js'
import { viewerColor } from '../redact.js'
import type {
  Carrier,
  Color,
  GameEvent,
  Rank,
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
    case 'mutual-rank':
      return `同階雙亡 — both ${RANK_NAMES_ZH[outcome.rank]}; both removed`
    case 'bomb-detonate':
      return `${colorLabel(outcome.bombColor)} 爆裂物 detonated; the other piece is removed and NOT revealed`
    case 'bomb-vs-bomb':
      return '爆裂物 vs 爆裂物 — both removed'
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
    default:
      survivor = undefined
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
 * What SETUP_CODE_EXAMPLE means, position by position.
 *
 * Deliberately labelled by SLOT NUMBER, never by square name. An example line
 * reading `a1='6' 營長` sits on the page beside a board where a1 is the reader's
 * own, still-undeployed piece — and a model has every reason to read that as a
 * statement about a1 rather than as an illustration. Slot numbers cannot be
 * mistaken for a deployment; the numbered piece-order list above already tells
 * the reader which square each slot is.
 */
function exampleLines(color: Color): string[] {
  const chars = Array.from(SETUP_CODE_EXAMPLE)
  const items = setupCodeSlots(color).map((_slot, i) => {
    const ch = chars[i] ?? '?'
    const entry = SETUP_CODE_LEGEND.find((e) => e.letter === ch)
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

function deployLines(self: Color, base: string, token: string): string[] {
  const url = (tail: string): string => `${base}/llm/${encodeURIComponent(token)}/setup/${tail}`
  const out: string[] = []

  out.push('## Deploy — how to put your army on the board')
  out.push(
    `A deployment is a SETUP CODE: ${SETUP_CODE_LENGTH} characters, one per piece, in the order`,
  )
  out.push(`listed above. Case does not matter. The alphabet is ${SETUP_CODE_ALPHABET} —`)
  out.push('one character per 兵種:')
  out.push('')
  // 兵種 names are CJK, so pad by display columns (2 each) rather than by
  // String#length, or the table steps sideways on 爆裂物.
  const cols = (zh: string): number => Array.from(zh).length * 2
  const zhWidth = Math.max(...SETUP_CODE_LEGEND.map((e) => cols(e.zh)))
  const enWidth = Math.max(...SETUP_CODE_LEGEND.map((e) => e.rank.length))
  for (const e of SETUP_CODE_LEGEND) {
    const zh = e.zh + ' '.repeat(zhWidth - cols(e.zh))
    out.push(`  ${e.letter}  ${zh}  ${e.rank.padEnd(enWidth)}  ×${e.count}`)
  }
  out.push('')
  out.push(
    `Every code must use each character exactly that many times. ${groupDigits(SETUP_CODE_COMBINATIONS)} deployments`,
  )
  out.push(
    `are valid out of ${SETUP_CODE_ALPHABET.length}^${SETUP_CODE_LENGTH} possible strings, so most strings are NOT a deployment;`,
  )
  out.push('a rejected code comes back with the reason (bad length / bad character / wrong counts).')
  out.push('')
  out.push(`Worked example — ${SETUP_CODE_EXAMPLE} reads as:`)
  out.push(...exampleLines(self).map((line) => `  ${line}`))
  out.push(`  ${url(SETUP_CODE_EXAMPLE)}`)
  out.push('That example is the 階級 ladder in order and every reader of every game sees the')
  out.push('same string. It is here to show the shape, not to be played.')
  out.push('')
  out.push('Deploy a code of your own — replace the last part of the URL:')
  out.push(`  ${url(SETUP_CODE_EXAMPLE.replace(/./g, '?'))}`)
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
    if (isPlayer) out.push(...deployLines(self, base, token))
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

export function renderForLLM(vs: ViewerState, opts: RenderOptions): string {
  const self = viewerColor(vs.viewer)
  const base = opts.baseUrl.replace(/\/+$/, '')
  const lines: string[] = []

  // --- header ---------------------------------------------------------
  const who = self === null
    ? 'omniscient replay view'
    : vs.viewer.kind === 'spectator'
      ? `you are watching ${colorLabel(self).toUpperCase()}`
      : `you are ${colorLabel(self).toUpperCase()}`
  lines.push(`# 行軍西洋棋 — ${who}`)

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
      'IF YOUR TOOLS WILL NOT FETCH A URL YOU FOUND IN THIS PAGE — many will only fetch a',
    )
    lines.push(
      'URL a person pasted, to avoid following links out of fetched content — then do NOT',
    )
    lines.push('stall and do NOT invent a result. Print the single URL you have chosen, in full,')
    lines.push('and ask the person to paste it back or open it themselves. That is a normal and')
    lines.push('expected way to play here. Either way, choose your action and name it.')
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
  lines.push(
    `Centre squares ${CENTER_SQUARES.map(squareName).join(' ')} — each own piece standing on one scores 1 point EVERY ply, for both players.`,
  )
  lines.push('')

  const replay = replayLog(vs.log)

  // --- own pieces -----------------------------------------------------
  // While a side is still in setup its pieces carry placeholder 兵種, so they
  // must never be printed as that player's own. `setupOwnLines` prints the code
  // positions and the deployment instructions instead.
  const setupStatus = vs.status.kind === 'setup' ? vs.status : null

  if (self === null) {
    for (const color of ['white', 'black'] as const) {
      if (setupStatus !== null) {
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
    lines.push('## Legal moves — fetch one to play')
    lines.push(`Fetching a move URL plays it. The ${vs.ply} in the URL is the ply guard: if the game has moved on, the move is ignored and you just get the current position back.`)
    for (const m of vs.legalMoves) {
      const n = moveToNotation(m)
      lines.push(`${n.padEnd(6, ' ')} ${base}/llm/${encodeURIComponent(opts.token)}/${vs.ply}/${encodeURIComponent(n)}`)
    }
  } else if (vs.status.kind === 'playing') {
    lines.push('## Legal moves')
    lines.push(`Not your turn. Refetch ${base}/llm/${encodeURIComponent(opts.token)} after the opponent moves.`)
  }
  lines.push('')
  lines.push(`Rules primer: ${base}/llm/${encodeURIComponent(opts.token)}/rules`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Rules primer — GET /llm/:token/rules (techspec §6)
// ---------------------------------------------------------------------------

export function renderRulesForLLM(opts: RenderOptions): string {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const table = (Object.keys(RANK_ORDER) as Exclude<Rank, 'bomb'>[])
    .sort((a, b) => RANK_ORDER[a] - RANK_ORDER[b])
    .map((r) => `  ${String(RANK_ORDER[r]).padStart(2, ' ')}  ${RANK_NAMES_ZH[r]}  ${r}  ×${DISTRIBUTION[r]}`)
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
   —  爆裂物  bomb  ×${DISTRIBUTION.bomb}
Each side has exactly these 16.

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
- Equal ranks    → both removed, square empty, both ranks announced publicly.
The winner's rank is revealed permanently. The loser's rank is never revealed.

## 爆裂物 (bomb)
- Ties with everything, attacking or defending: both pieces are removed. Only
  the bomb's identity is announced; the victim's rank stays secret.
- EXCEPT against 工兵 and 軍旗, in both directions: the bomb simply loses and
  is removed, the 工兵/軍旗 is unharmed and is NOT revealed. Observers learn
  only that the survivor is "工兵 or 軍旗" (有煙無傷). If a surviving pawn
  reaches the 8th rank this way, it still promotes.

## 軍旗 (flag)
If your 軍旗 leaves the board by any route, you LOSE immediately — captured,
traded, or thrown at another piece. Promotion and castling do not count as
leaving the board. Both flags leaving on the same ply is the only draw.

## Scoring
After EVERY ply — yours and your opponent's — both players score +1 for each
own piece standing on d4, e4, d5 or e5. Black starts at komi. First to the
score target wins. If nothing is captured and nobody scores for the stagnation
limit in full turns, the higher score wins.

## Clock
Increment is granted on a completed move, or on a FORCED pass (you had no
legal move). A voluntary pass gets no increment.

## How to play here
GET the state URL, pick one of the pre-built move URLs at the bottom, and GET
it. The ply number inside the URL is a guard: a stale one is ignored.

State: ${base}/llm/${encodeURIComponent(opts.token)}
`
}
