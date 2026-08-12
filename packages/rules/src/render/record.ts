/**
 * 棋譜 export — the record a human takes away from a game. Gamebook §10.
 *
 *   「紀錄給，解算不給。」
 *
 * Three pure functions over a **ViewerState** and nothing else:
 *
 *   exportMarkdown — what you paste into a chat window to discuss the game
 *   exportJson     — the same content as a plain object, for a script
 *   gameStats      — the analysis summary both of the above embed
 *
 * The redaction contract, in full:
 *
 *  · The input is ALREADY redacted. `stateForViewer` decided what this viewer
 *    may see; a hidden 兵種 arrives here as `rank: null`. Nothing in this file
 *    imports `GameState`, `entitledToRank` or the piece table, so there is no
 *    path by which it could reach around that boundary.
 *  · A rank is printed only when it came from `ViewerPiece.rank` (non-null) or
 *    from a `CombatOutcome` field, which §4「翻明總表」defines as announced to
 *    everyone. 爆裂物 is named for the three bomb outcomes for the same reason:
 *    the bomb's identity is公告 by the event itself.
 *  · No candidate sets, no ranges, no "the survivor must be 工兵 or 軍旗". That
 *    is 推論輔助 (§10) and it is the reader's job, not the record's — even
 *    though the deduction is trivial and even though a spectator UI is allowed
 *    to show it. A record that solves for you turns 讀盤 into reading.
 *  · The statistics are aggregates over the PUBLIC log: how many contacts, how
 *    they were announced, how many plies a side scored nothing. They are
 *    statements about what happened, not about who anyone is.
 *  · At game end the ViewerState carries every rank (§10 終局公開全部兵種), so a
 *    finished game exports in full with no special-casing anywhere below.
 *
 * Everything here is deterministic: no clock is read, no `Date` is touched, so
 * the same ViewerState always exports the same bytes.
 */

import { opposite, squareName } from '../board.js'
import {
  ALL_RANKS,
  CARRIER_LETTER,
  DISTRIBUTION,
  RANK_NAMES_ZH,
  RANK_ORDER,
} from '../constants.js'
import { viewerColor } from '../redact.js'
import { encodeSetupCode, setupCodeSlots } from '../setupcode.js'
import type {
  Carrier,
  Color,
  CombatOutcome,
  GameEvent,
  PieceId,
  Rank,
  Result,
  Square,
  ViewerState,
} from '../types.js'

// ---------------------------------------------------------------------------
// Statistics — the numbers the owner actually reads
// ---------------------------------------------------------------------------

/**
 * 同階雙亡 over every contact, kept as a RAW FRACTION.
 *
 * This is the single most misread number in the system: a percentage alone
 * ("17% ties") says nothing about whether that was 1 tie in 6 or 170 in 1000,
 * and two playtest games have already been argued about on the strength of a
 * ratio with no denominator. Both terms are therefore always carried, and the
 * ratio is `null` — never 0, never NaN — when there were no contacts at all.
 */
export interface TiesPerContest {
  /** contacts announced as `mutual-rank` */
  ties: number
  /** contacts of every kind, bombs included */
  contests: number
  /** ties / contests, or null when contests === 0 */
  ratio: number | null
  /**
   * Contacts in which two RANKS were actually compared: attacker-wins +
   * defender-wins + mutual-rank. Bomb contacts compare nothing, so including
   * them dilutes the denominator and makes the figure incomparable with the
   * ~18% expectation in notebook §4.1, which is derived over a bomb-free pool.
   * This is the fraction to quote.
   */
  rankDuels: number
  /** ties / rankDuels, or null when rankDuels === 0 */
  duelRatio: number | null
}

/** The longest streak of consecutive plies on which a side was credited nothing. */
export interface ZeroRun {
  length: number
  /** ply the run started on; null when the side never scored zero */
  startPly: number | null
}

export interface SideStats {
  color: Color
  /** final score as the ViewerState reports it — 貼目 included for black */
  score: number
  /** points credited by 結算, i.e. `score` minus the starting 貼目 credit */
  earned: number
  /** score / plies — the headline rate, 貼目 included */
  pointsPerPly: number
  /**
   * earned / plies. Because 結算 credits exactly +1 per own piece standing on a
   * scoring square (§7②), this is also the mean number of scoring squares the
   * side HELD per ply. It differs from `pointsPerPly` only by 貼目/plies.
   */
  scoringSquaresPerPly: number
  /** plies on which this side was credited nothing */
  zeroPlies: number
  longestZeroRun: ZeroRun
  /** 爆裂物 this side lost — detonated, traded, or fizzled against 工兵/軍旗 */
  bombsSpent: number
  /** the plies on which it lost them */
  bombPlies: number[]
}

export interface GameStats {
  pliesPlayed: number
  contacts: number
  contactsByOutcome: Record<CombatOutcome['kind'], number>
  tiesPerContest: TiesPerContest
  sides: Record<Color, SideStats>
}

/**
 * Display labels for every announced outcome.
 *
 * Typed as a total `Record` over the outcome union on purpose: adding a
 * CombatOutcome variant fails to compile until it is given a label here, and
 * `OUTCOME_KINDS` below is derived from this table, so a new variant is counted
 * by `gameStats` and printed by the renderer without a second edit.
 */
const OUTCOME_LABEL: Record<CombatOutcome['kind'], string> = {
  'attacker-wins': '攻方勝 attacker-wins',
  'defender-wins': '守方勝 defender-wins',
  'mutual-rank': '同階雙亡 mutual-rank',
  'bomb-detonate': '爆裂物引爆 bomb-detonate',
  'bomb-vs-bomb': '爆裂物對爆 bomb-vs-bomb',
  'fizzle': '有煙無傷 fizzle',
}

const OUTCOME_KINDS = Object.keys(OUTCOME_LABEL) as CombatOutcome['kind'][]

/** Both colours, in a fixed order. Local so this file never depends on mutable state. */
const COLORS: readonly Color[] = ['white', 'black']

/**
 * Which side LOST a 爆裂物 in this contact, from the announcement alone.
 *
 *   bomb-detonate  the bomb's own colour is公告 (§4 表)
 *   bomb-vs-bomb   both sides spent one
 *   fizzle         有煙無傷 removes ONLY the bomb (§5), so the spender is the
 *                  side that did not survive
 *
 * No rank is inferred: every branch reads a field of the public event.
 */
function bombSpenders(outcome: CombatOutcome): Color[] {
  switch (outcome.kind) {
    case 'bomb-detonate': return [outcome.bombColor]
    case 'bomb-vs-bomb': return ['white', 'black']
    case 'fizzle': return [opposite(outcome.survivorColor)]
    default: return []
  }
}

/** Score at ply 0: white 0, black 貼目 — the same baseline `createGame` sets. */
function startingScore(vs: ViewerState): Record<Color, number> {
  return { white: 0, black: vs.config.komi }
}

interface PlyIncome {
  white: number
  black: number
}

/**
 * Per-ply income for both sides, parallel to `vs.log`.
 *
 * Derived by differencing the log's `scoreAfter`, which is public. A ply that
 * ended the game by 奪旗 ran no 結算 (§7①) and therefore shows income 0 for
 * both sides — that is what the record says happened, and the record is what
 * this file reports.
 */
function incomePerPly(vs: ViewerState): PlyIncome[] {
  const out: PlyIncome[] = []
  let prev = startingScore(vs)
  for (const e of vs.log) {
    out.push({ white: e.scoreAfter.white - prev.white, black: e.scoreAfter.black - prev.black })
    prev = { white: e.scoreAfter.white, black: e.scoreAfter.black }
  }
  return out
}

/** 貼目 can be any rational (附錄 B), so compare against a tolerance, not 0. */
function isZero(n: number): boolean {
  return Math.abs(n) < 1e-9
}

function sideStats(vs: ViewerState, color: Color, income: readonly PlyIncome[]): SideStats {
  const plies = income.length
  const score = vs.score[color]
  const earned = score - startingScore(vs)[color]

  let zeroPlies = 0
  let longest = 0
  let longestStart: number | null = null
  let run = 0
  let runStart = 0

  income.forEach((inc, i) => {
    if (!isZero(inc[color])) {
      run = 0
      return
    }
    zeroPlies++
    if (run === 0) runStart = vs.log[i]?.ply ?? i + 1
    run++
    // strictly greater: a tie keeps the FIRST run of that length
    if (run > longest) {
      longest = run
      longestStart = runStart
    }
  })

  const bombPlies: number[] = []
  for (const e of vs.log) {
    if (!e.combat) continue
    if (bombSpenders(e.combat.outcome).includes(color)) bombPlies.push(e.ply)
  }

  return {
    color,
    score,
    earned,
    pointsPerPly: plies === 0 ? 0 : score / plies,
    scoringSquaresPerPly: plies === 0 ? 0 : earned / plies,
    zeroPlies,
    longestZeroRun: { length: longest, startPly: longestStart },
    bombsSpent: bombPlies.length,
    bombPlies,
  }
}

/** The analysis summary. Aggregates over the public log; infers nothing. */
export function gameStats(vs: ViewerState): GameStats {
  const income = incomePerPly(vs)

  const contactsByOutcome = {} as Record<CombatOutcome['kind'], number>
  for (const kind of OUTCOME_KINDS) contactsByOutcome[kind] = 0

  let contacts = 0
  for (const e of vs.log) {
    if (!e.combat) continue
    contacts++
    contactsByOutcome[e.combat.outcome.kind]++
  }

  const ties = contactsByOutcome['mutual-rank']
  // only these three compare ranks; the three bomb outcomes never do
  const rankDuels =
    contactsByOutcome['attacker-wins'] +
    contactsByOutcome['defender-wins'] +
    contactsByOutcome['mutual-rank']

  return {
    pliesPlayed: vs.log.length,
    contacts,
    contactsByOutcome,
    tiesPerContest: {
      ties,
      contests: contacts,
      ratio: contacts === 0 ? null : ties / contacts,
      rankDuels,
      duelRatio: rankDuels === 0 ? null : ties / rankDuels,
    },
    sides: {
      white: sideStats(vs, 'white', income),
      black: sideStats(vs, 'black', income),
    },
  }
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function colorLabel(c: Color): string {
  return c === 'white' ? 'White' : 'Black'
}

/** Trim the float noise a tunable 貼目 can introduce, without padding integers. */
function fmt(n: number): string {
  return String(Number(n.toFixed(3)))
}

function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 司令(1) … 軍旗(10), 爆裂物(—). Only ever called with an ANNOUNCED rank. */
function rankText(rank: Rank): string {
  const zh = RANK_NAMES_ZH[rank]
  return rank === 'bomb' ? `${zh}(—)` : `${zh}(${RANK_ORDER[rank as Exclude<Rank, 'bomb'>]})`
}

function scorePair(score: { white: number; black: number }): string {
  return `${fmt(score.white)} – ${fmt(score.black)}`
}

function plyList(plies: readonly number[]): string {
  return plies.length === 0 ? '—' : plies.join(', ')
}

// ---------------------------------------------------------------------------
// Move notation
// ---------------------------------------------------------------------------

/**
 * Coordinate notation for one logged ply: `e2e4`, `b7a8q`, `O-O`, `pass`.
 *
 * `moveToNotation` is deliberately NOT used here. It renders `Move.promote`,
 * which is the promotion the mover ASKED for — and a pawn that loses or ties on
 * the 8th rank never promotes (§6：僅存活的 pawn 升變). Printing `b7a8q` for a
 * pawn that died on a8 would put a queen in the record that never existed, and
 * a record that lies about the board is worse than no record. The suffix comes
 * from `GameEvent.promoted`, which the engine writes only when the promotion
 * actually happened.
 */
function plyNotation(e: GameEvent): string {
  switch (e.move.kind) {
    case 'pass':
      return 'pass'
    case 'castle':
      return e.move.side === 'king' ? 'O-O' : 'O-O-O'
    case 'move': {
      const suffix = e.promoted ? CARRIER_LETTER[e.promoted].toLowerCase() : ''
      return `${squareName(e.move.from)}${squareName(e.move.to)}${suffix}`
    }
  }
}

/**
 * The public announcement for a contact, in words.
 *
 * Every rank named below is a field of the outcome, i.e. 公告 by §4「翻明總表」.
 * The 有煙無傷 line states what was announced (a 爆裂物 was lost, nobody was
 * 翻明) and stops there: naming the survivor as "工兵 or 軍旗" would be 解算.
 */
function outcomeText(e: GameEvent): string {
  if (!e.combat) return ''
  const { outcome, defenderSquare, survivorSquare } = e.combat
  // en passant is the one capture whose contact square is not the destination,
  // so naming only the defender's square reads as two unrelated squares
  const to = e.move.kind === 'move' ? e.move.to : null
  const where =
    to !== null && to !== defenderSquare
      ? `${squareName(defenderSquare)} (en passant, ${squareName(e.move.kind === 'move' ? e.move.from : defenderSquare)}→${squareName(to)})`
      : squareName(defenderSquare)
  const mover = colorLabel(e.color)
  const other = colorLabel(opposite(e.color))

  switch (outcome.kind) {
    case 'attacker-wins':
      return `${where}: ${mover} wins — 翻明 ${rankText(outcome.winnerRank)}; ${other}'s piece removed`
    case 'defender-wins':
      return `${where}: ${other} holds — 翻明 ${rankText(outcome.winnerRank)}; ${mover}'s piece removed`
    case 'mutual-rank':
      return `${where}: 同階雙亡 — both ${rankText(outcome.rank)}, both removed`
    case 'bomb-detonate':
      return `${where}: ${colorLabel(outcome.bombColor)}'s 爆裂物 detonates — both removed, the victim is NOT 翻明`
    case 'bomb-vs-bomb':
      return `${where}: 爆裂物 vs 爆裂物 — both removed`
    case 'fizzle': {
      const stands = survivorSquare === null ? where : squareName(survivorSquare)
      const survivor = colorLabel(outcome.survivorColor)
      const loser = colorLabel(opposite(outcome.survivorColor))
      return `${where}: 有煙無傷 — ${loser}'s 爆裂物 is lost, ${survivor}'s piece survives on ${stands}; nobody is 翻明`
    }
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

interface ResultLabel {
  /** the win condition by name: 奪旗 / 分數 / 停滯 / 超時 / 認輸 */
  condition: string
  /** what that condition means, in one clause */
  gloss: string
  winner: Color | null
  draw: boolean
}

function resultLabel(r: Result): ResultLabel {
  switch (r.kind) {
    case 'flag':
      return {
        condition: '奪旗',
        gloss: "the loser's 軍旗 left the board",
        winner: r.winner,
        draw: false,
      }
    case 'flag-both':
      return {
        condition: '奪旗',
        gloss: 'both 軍旗 left the board on the same ply — the only draw in the game',
        winner: null,
        draw: true,
      }
    case 'score':
      return { condition: '分數', gloss: 'the score target was reached', winner: r.winner, draw: false }
    case 'no-progress':
      return {
        condition: '停滯',
        gloss: 'the stagnation limit ran out; the higher score took it',
        winner: r.winner,
        draw: false,
      }
    case 'timeout':
      return { condition: '超時', gloss: 'the clock ran out', winner: r.winner, draw: false }
    case 'resign':
      return { condition: '認輸', gloss: 'the opponent resigned', winner: r.winner, draw: false }
  }
}

/** Who was ahead on points, or null when the score was exactly level. */
function pointLeader(vs: ViewerState): Color | null {
  if (vs.score.white > vs.score.black) return 'white'
  if (vs.score.black > vs.score.white) return 'black'
  return null
}

/**
 * Result + final score + the relation between them.
 *
 * The third line is the whole reason this block is not just "White wins 8–6.5":
 * a game can end on 奪旗, 超時 or 認輸 while the LOSER is far ahead on points,
 * and a record that prints only the score hides the most interesting thing that
 * happened in it.
 */
function resultLines(vs: ViewerState): string[] {
  const out: string[] = []

  if (vs.status.kind !== 'over') {
    out.push(
      vs.status.kind === 'setup'
        ? 'Not started — both sides are still assigning 兵種 (§9).'
        : `In progress — ply ${vs.ply}, ${colorLabel(vs.toMove)} to move.`,
    )
    out.push('')
    out.push(`Score so far: White ${fmt(vs.score.white)} – Black ${fmt(vs.score.black)}.`)
    return out
  }

  const label = resultLabel(vs.status.result)
  out.push(
    label.draw
      ? `**Draw** — ${label.condition} (${label.gloss}).`
      : `**${colorLabel(label.winner!)} wins** — ${label.condition} (${label.gloss}).`,
  )
  out.push('')
  out.push(`Final score: White ${fmt(vs.score.white)} – Black ${fmt(vs.score.black)}.`)

  const leader = pointLeader(vs)
  if (leader === null) {
    out.push('The score was level at the end.')
  } else if (label.winner === null) {
    out.push(`${colorLabel(leader)} led on points at the end.`)
  } else if (leader === label.winner) {
    out.push(`Won on ${label.condition}; ${colorLabel(label.winner)} also led on points.`)
  } else {
    const margin = Math.abs(vs.score.white - vs.score.black)
    out.push(
      `Won on ${label.condition} while ${colorLabel(leader)} led on points by ${fmt(margin)}`
      + ' — the score alone hides that.',
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Deployments (§9)
// ---------------------------------------------------------------------------

export interface DeploymentPiece {
  square: Square
  square_name: string
  carrier: Carrier
  rank: Rank
}

export interface Deployment {
  color: Color
  /** the 16-character setup code, the same format the LLM interface deploys with */
  code: string
  pieces: DeploymentPiece[]
}

/**
 * A side's whole deployment, or null when this view is not entitled to all of it.
 *
 * `encodeSetupCode` throws the moment one of the 16 兵種 is redacted, and that
 * throw IS the entitlement check — there is no path here that assembles a
 * partial army out of the ranks that happen to be visible.
 *
 * Callers withhold deployments entirely until 終局 — see deploymentLines() for
 * why. This function stays willing; the decision is made one level up, in both
 * the markdown and the JSON path.
 *
 * Squares and carriers come from the fixed §9 opening layout, not from the
 * pieces' current state: a deployment is what was assigned before ply 1, and
 * 升變 changes the carrier layer afterwards (§1).
 */
function deploymentFor(vs: ViewerState, color: Color): Deployment | null {
  let code: string
  try {
    code = encodeSetupCode(vs, color)
  } catch {
    return null
  }

  const rankById = new Map<PieceId, Rank | null>()
  for (const p of vs.pieces) {
    if (p.color === color) rankById.set(p.id, p.rank)
  }

  const pieces: DeploymentPiece[] = []
  for (const slot of setupCodeSlots(color)) {
    const rank = rankById.get(slot.id) ?? null
    if (rank === null) return null      // unreachable: encodeSetupCode already threw
    pieces.push({
      square: slot.square,
      square_name: squareName(slot.square),
      carrier: slot.carrier,
      rank,
    })
  }
  return { color, code, pieces }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function viewerLine(vs: ViewerState): string {
  const self = viewerColor(vs.viewer)
  switch (vs.viewer.kind) {
    case 'player':
      return `Exported from ${colorLabel(self!)}'s own view (player).`
    case 'spectator':
      return `Exported from a spectator bound to ${colorLabel(self!)} — identical to that player's view (§10).`
    case 'replay-omniscient':
      return 'Exported from the omniscient replay view — every 兵種 is public here.'
    case 'replay-player':
      return `Exported from the replay view of ${colorLabel(self!)}.`
  }
}

function provenanceLines(vs: ViewerState): string[] {
  const out = [viewerLine(vs)]
  out.push(
    vs.status.kind === 'over'
      ? 'The game is finished, so every 兵種 is in this record (§10 終局公開全部兵種).'
      : '兵種 this view is not entitled to are absent from this record — not hidden in it.'
      + ' 紀錄給，解算不給 (§10): the log is here, the reading of it is yours.',
  )
  return out
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The §2 兵種 table, the same for every game.
 *
 * Kept to ONE line on purpose. It names every 兵種 that exists, so it is the one
 * place in the record where a rank name appears without belonging to anybody —
 * a reader (or a test) grepping the record for a rank must be able to lift this
 * single line out and know the rest is attribution.
 */
const DISTRIBUTION_LINE_PREFIX = '- 兵種 distribution (§2, per side):'

function distributionLine(): string {
  const items = ALL_RANKS.map((r) => `${RANK_NAMES_ZH[r]}×${DISTRIBUTION[r]}`).join(' · ')
  const total = ALL_RANKS.reduce((n, r) => n + DISTRIBUTION[r], 0)
  return `${DISTRIBUTION_LINE_PREFIX} ${items} — ${total} per side`
}

/**
 * The settings the game was played under.
 *
 * A recorded game is worthless for tuning if you cannot tell which knobs
 * produced it (附錄 B), so every tunable is printed, and the scoring squares are
 * printed BY NAME — `[27,28,35,36]` is unreadable and an off-by-one in it is
 * invisible.
 */
function configLines(vs: ViewerState): string[] {
  const c = vs.config
  const squares = c.scoringSquares.length === 0
    ? 'none — no piece scores by standing anywhere'
    : `${c.scoringSquares.map(squareName).join(' ')} (${c.scoringSquares.length})`

  const clock = c.clockEnabled
    ? `${clockText(c.clockInitialMs)} + ${clockText(c.clockIncrementMs)} per move`
      + ` · setup limit ${clockText(c.setupTimeoutMs)}`
    : `disabled · setup limit ${clockText(c.setupTimeoutMs)}`

  return [
    `- 分數線 X (score target): ${fmt(c.scoreTarget)}`,
    `- 停滯 N (no-progress full turns): ${fmt(c.noProgressTurns)}`,
    `- 貼目 komi: ${fmt(c.komi)}, credited to Black before ply 1`,
    `- Scoring squares (結算格): ${squares}`,
    `- Clock (讀秒): ${clock}`,
    distributionLine(),
  ]
}

// ---------------------------------------------------------------------------
// exportMarkdown
// ---------------------------------------------------------------------------

function moveLogLines(vs: ViewerState): string[] {
  if (vs.log.length === 0) return ['(no moves yet)']

  const out = [
    '| Ply | Side | Move | Announced outcome | Score W–B |',
    '| ---: | :---: | :--- | :--- | :--- |',
  ]
  for (const e of vs.log) {
    const outcome = e.combat ? outcomeText(e) : '—'
    out.push(
      `| ${e.ply} | ${e.color === 'white' ? 'W' : 'B'} | ${plyNotation(e)} `
      + `| ${outcome} | ${scorePair(e.scoreAfter)} |`,
    )
  }
  return out
}

/**
 * Deployments are withheld while the game is live.
 *
 * The intended use of this export is pasting it into a chat window — which,
 * when the opponent is an LLM, is the very window the opponent reads. A
 * mid-game record carrying the exporter's own 16 兵種 hands over their entire
 * army, and no footer warning survives a copy-paste. Nothing is lost by
 * waiting: you already know your own deployment, and at 終局 the view carries
 * both sides in full (gamebook §10.5), which is when a record is worth keeping
 * anyway.
 */
function deploymentLines(vs: ViewerState): string[] {
  if (vs.status.kind !== 'over') {
    return [
      '_Withheld while the game is live._ This record is therefore safe to paste'
      + ' anywhere, including a chat window your opponent can read. Both'
      + ' deployments appear here once the game ends.',
      '',
    ]
  }

  const out: string[] = []
  for (const color of COLORS) {
    const d = deploymentFor(vs, color)
    if (d === null) {
      out.push(
        `**${colorLabel(color)}** — not in this record: this view does not hold all 16 兵種`
        + ' for that side.',
      )
      out.push('')
      continue
    }
    out.push(`**${colorLabel(color)}** — setup code \`${d.code}\``)
    out.push('')
    const cells = d.pieces.map(
      (p) => `${p.square_name} ${p.carrier} ${RANK_NAMES_ZH[p.rank]}`,
    )
    for (let i = 0; i < cells.length; i += 4) {
      out.push(cells.slice(i, i + 4).join(' · '))
      out.push('')
    }
  }
  return out
}

function statsLines(vs: ViewerState, stats: GameStats): string[] {
  const w = stats.sides.white
  const b = stats.sides.black
  const out: string[] = []

  out.push(
    `${stats.pliesPlayed} plies · ${stats.contacts} contacts.`
    + ' All of it read off the public log.',
  )
  out.push('')

  out.push('| Contact outcome | Count |')
  out.push('| :--- | ---: |')
  for (const kind of OUTCOME_KINDS) {
    out.push(`| ${OUTCOME_LABEL[kind]} | ${stats.contactsByOutcome[kind]} |`)
  }
  out.push('')

  const t = stats.tiesPerContest
  out.push(
    `**同階雙亡 ${t.ties}/${t.rankDuels} 階級對決**`
    + (t.duelRatio === null ? '' : ` (${fmt(t.duelRatio)})`)
    + ` · ${t.ties}/${t.contests} 全部接觸`
    + (t.ratio === null ? '' : ` (${fmt(t.ratio)})`),
  )
  out.push('')
  out.push(
    '> Quote the FIRST fraction. Bomb contacts compare no ranks, so counting them'
    + ' dilutes the denominator and breaks comparison with the ~18% expectation'
    + ' (notebook §4.1). Read the fraction, not the ratio — the denominator is'
    + ' small and this is the noisiest number in the system.',
  )
  out.push('')

  const zeroRun = (s: SideStats): string => {
    if (s.longestZeroRun.length === 0) return '0 — never scored zero'
    const from = s.longestZeroRun.startPly!
    const to = from + s.longestZeroRun.length - 1
    return `${s.longestZeroRun.length} (plies ${from}–${to})`
  }

  out.push('| Per side | White | Black |')
  out.push('| :--- | ---: | ---: |')
  out.push(`| Total score (貼目 included) | ${fmt(w.score)} | ${fmt(b.score)} |`)
  out.push(`| Points per ply | ${fmt(w.pointsPerPly)} | ${fmt(b.pointsPerPly)} |`)
  out.push(
    `| Scoring squares held, per ply | ${fmt(w.scoringSquaresPerPly)} `
    + `| ${fmt(b.scoringSquaresPerPly)} |`,
  )
  out.push(
    `| Plies scoring zero | ${w.zeroPlies} of ${stats.pliesPlayed} `
    + `| ${b.zeroPlies} of ${stats.pliesPlayed} |`,
  )
  out.push(`| Longest zero-income run | ${zeroRun(w)} | ${zeroRun(b)} |`)
  out.push(`| 爆裂物 spent | ${w.bombsSpent} | ${b.bombsSpent} |`)
  out.push(`| …on plies | ${plyList(w.bombPlies)} | ${plyList(b.bombPlies)} |`)
  return out
}

/**
 * The whole record as Markdown — the thing the owner pastes into a chat window
 * and argues with a model about. Order is fixed and load-bearing: result, then
 * the settings that produced it, then the log, then the deployments, then the
 * numbers.
 */
export function exportMarkdown(vs: ViewerState): string {
  const stats = gameStats(vs)
  const lines: string[] = []

  lines.push(`# 行軍西洋棋 — game ${vs.id}`)
  lines.push('')
  lines.push(...provenanceLines(vs))
  lines.push('')

  lines.push('## Result')
  lines.push('')
  lines.push(...resultLines(vs))
  lines.push('')

  lines.push('## Configuration')
  lines.push('')
  lines.push(...configLines(vs))
  lines.push('')

  lines.push('## Move log')
  lines.push('')
  lines.push(
    'Coordinate notation. A promotion suffix appears only where the pawn actually'
    + ' promoted — a pawn that lost or tied on the 8th rank did not (§6).',
  )
  lines.push('')
  lines.push(...moveLogLines(vs))
  lines.push('')

  lines.push('## Deployments')
  lines.push('')
  lines.push(...deploymentLines(vs))

  lines.push('## Statistics')
  lines.push('')
  lines.push(...statsLines(vs, stats))
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// exportJson
// ---------------------------------------------------------------------------

export interface RecordMoveJson {
  ply: number
  color: Color
  notation: string
  move_kind: 'move' | 'castle' | 'pass'
  from: Square | null
  from_name: string | null
  to: Square | null
  to_name: string | null
  castle_side: 'king' | 'queen' | null
  /** the carrier the pawn ACTUALLY became, null when nothing promoted */
  promoted: Carrier | null
  combat: {
    outcome: CombatOutcome
    attacker_square: Square
    attacker_square_name: string
    defender_square: Square
    defender_square_name: string
    survivor_square: Square | null
    survivor_square_name: string | null
  } | null
  score_after: { white: number; black: number }
  /** points credited to each side by this ply's 結算 */
  income: { white: number; black: number }
}

export interface RecordJson {
  format: 'xiyang-record'
  version: 1
  id: string
  viewer: { kind: string; color: Color | null }
  ply: number
  to_move: Color
  status: string
  result: { kind: string; condition: string; winner: Color | null; draw: boolean } | null
  score: { white: number; black: number }
  config: {
    score_target: number
    no_progress_turns: number
    komi: number
    scoring_squares: { square: Square; name: string }[]
    clock_enabled: boolean
    clock_initial_ms: number
    clock_increment_ms: number
    setup_timeout_ms: number
    distribution: { rank: Rank; count: number }[]
  }
  moves: RecordMoveJson[]
  deployments: { white: Deployment | null; black: Deployment | null }
  /** the position as this viewer holds it; `rank` is null where it is redacted */
  position: {
    id: PieceId
    color: Color
    carrier: Carrier
    square: Square | null
    square_name: string | null
    revealed: boolean
    rank: Rank | null
  }[]
  stats: {
    plies_played: number
    contacts: number
    contacts_by_outcome: { outcome: CombatOutcome['kind']; count: number }[]
    ties_per_contest: TiesPerContest
    sides: SideStats[]
  }
}

/**
 * The same content as the Markdown, as a plain object — for a script, not for a
 * reader. Arrays of records rather than prose, stable snake_case keys, no
 * rendering. Redaction-wise it is the Markdown's twin: every field is copied
 * from the ViewerState or derived from the public log.
 *
 * Declared `unknown` because callers should not build a hard dependency on the
 * shape; `RecordJson` is exported for the ones that want to.
 */
export function exportJson(vs: ViewerState): unknown {
  const stats = gameStats(vs)
  const income = incomePerPly(vs)

  const moves: RecordMoveJson[] = vs.log.map((e, i) => {
    const inc = income[i] ?? { white: 0, black: 0 }
    return {
      ply: e.ply,
      color: e.color,
      notation: plyNotation(e),
      move_kind: e.move.kind,
      from: e.move.kind === 'move' ? e.move.from : null,
      from_name: e.move.kind === 'move' ? squareName(e.move.from) : null,
      to: e.move.kind === 'move' ? e.move.to : null,
      to_name: e.move.kind === 'move' ? squareName(e.move.to) : null,
      castle_side: e.move.kind === 'castle' ? e.move.side : null,
      promoted: e.promoted ?? null,
      combat: e.combat
        ? {
          outcome: { ...e.combat.outcome },
          attacker_square: e.combat.attackerSquare,
          attacker_square_name: squareName(e.combat.attackerSquare),
          defender_square: e.combat.defenderSquare,
          defender_square_name: squareName(e.combat.defenderSquare),
          survivor_square: e.combat.survivorSquare,
          survivor_square_name:
            e.combat.survivorSquare === null ? null : squareName(e.combat.survivorSquare),
        }
        : null,
      score_after: { white: e.scoreAfter.white, black: e.scoreAfter.black },
      income: { white: inc.white, black: inc.black },
    }
  })

  const label = vs.status.kind === 'over' ? resultLabel(vs.status.result) : null

  const out: RecordJson = {
    format: 'xiyang-record',
    version: 1,
    id: vs.id,
    viewer: { kind: vs.viewer.kind, color: viewerColor(vs.viewer) },
    ply: vs.ply,
    to_move: vs.toMove,
    status: vs.status.kind,
    result: vs.status.kind === 'over' && label !== null
      ? {
        kind: vs.status.result.kind,
        condition: label.condition,
        winner: label.winner,
        draw: label.draw,
      }
      : null,
    score: { white: vs.score.white, black: vs.score.black },
    config: {
      score_target: vs.config.scoreTarget,
      no_progress_turns: vs.config.noProgressTurns,
      komi: vs.config.komi,
      scoring_squares: vs.config.scoringSquares.map((sq) => ({ square: sq, name: squareName(sq) })),
      clock_enabled: vs.config.clockEnabled,
      clock_initial_ms: vs.config.clockInitialMs,
      clock_increment_ms: vs.config.clockIncrementMs,
      setup_timeout_ms: vs.config.setupTimeoutMs,
      distribution: ALL_RANKS.map((rank) => ({ rank, count: DISTRIBUTION[rank] })),
    },
    moves,
    // Withheld while the game is live, exactly as in the markdown — see
    // deploymentLines(). A JSON export is if anything MORE likely to be pasted
    // somewhere mechanical, so it must not be the softer path out.
    deployments:
      vs.status.kind === 'over'
        ? { white: deploymentFor(vs, 'white'), black: deploymentFor(vs, 'black') }
        : { white: null, black: null },
    // Copied straight from the redacted view: `rank` is whatever `stateForViewer`
    // put there, null included. Nothing here re-derives one.
    position: vs.pieces.map((p) => ({
      id: p.id,
      color: p.color,
      carrier: p.carrier,
      square: p.square,
      square_name: p.square === null ? null : squareName(p.square),
      revealed: p.revealed,
      rank: p.rank,
    })),
    stats: {
      plies_played: stats.pliesPlayed,
      contacts: stats.contacts,
      contacts_by_outcome: OUTCOME_KINDS.map((kind) => ({
        outcome: kind,
        count: stats.contactsByOutcome[kind],
      })),
      ties_per_contest: stats.tiesPerContest,
      sides: [stats.sides.white, stats.sides.black],
    },
  }
  return out
}
