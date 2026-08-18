/**
 * @xiyang/bot — the harness, and the public surface of the package.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Six hand-played games (notebook §6) produced conclusions that were reversed
 * twice. §6.6 says why in one line: 「兩局之間同時改變了三件事」— board, model and
 * dice all moved between the two games being compared, so nothing in either was
 * attributable. §3.3b is the correction to §3.3, and §7 is a table of questions
 * that a sample of one cannot answer.
 *
 * A bot plays a thousand games in seconds with ONE variable moved. That is the
 * entire product. Everything in this file exists to make that claim true:
 *
 *   · `playGame` owns the `GameState` and never lets a policy near it;
 *   · every draw comes from a seed, so any surprising game can be replayed;
 *   · streams are split per (game, side, phase), so changing one side's policy
 *     leaves the other side's dice untouched — otherwise a match would repeat
 *     §6.6's mistake at scale.
 *
 * ---------------------------------------------------------------------------
 * The security boundary, restated for this package
 * ---------------------------------------------------------------------------
 *
 * The harness holds the authoritative `GameState`. Before asking a side to act
 * it calls `stateForViewer(state, { kind: 'player', color })` and hands the
 * result — nothing else — to that side's policy. `stateForViewer` deep-copies
 * every field (rules/redact.ts), so a policy cannot even reach back through an
 * alias, let alone read a hidden 兵種.
 *
 * A policy that peeked would produce self-play statistics about a different
 * game. See the header of `policy.ts` for what specifically would break.
 */

import {
  DEFAULT_CONFIG,
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  SCORING_CENTRE_4,
  SCORING_WIDE_8,
  applyMove,
  createGame,
  gameStats,
  moveToNotation,
  pieceAt,
  stateForViewer,
  submitAssignment,
  validateAssignment,
} from '@xiyang/rules'
import type {
  Color,
  GameConfig,
  GameState,
  GameStats,
  Move,
  PieceId,
  Rank,
  RankDistribution,
  Result,
  ViewerState,
} from '@xiyang/rules'
import { pathToFileURL } from 'node:url'

import { deriveSeed, makeRng } from './prng.js'
import type { Rng } from './prng.js'
import type { Policy } from './policy.js'
import { greedyPolicy } from './policies/greedy.js'
import { contestPolicy } from './policies/contest.js'
import { beliefPolicy } from './policies/belief.js'
import { randomPolicy } from './policies/random.js'

// ---------------------------------------------------------------------------
// Re-exports — the package's public surface
// ---------------------------------------------------------------------------

export { deriveSeed, makeRng } from './prng.js'
export type { Rng } from './prng.js'
export {
  heldScoring,
  heldScoringAfter,
  moveKey,
  occupancy,
  ownPieceIds,
  ownPieces,
  pawnReachesScoring,
  randomAssignment,
  rankPool,
  scoringSet,
  shapeOfMove,
  shuffled,
} from './policy.js'
export type { MoveShape, Policy } from './policy.js'
export { makeRandomPolicy, randomPolicy } from './policies/random.js'
export { greedyPolicy, makeGreedyPolicy } from './policies/greedy.js'

/** Every policy the CLI can name. Add one here and `--white NAME` finds it. */
export const POLICIES: Readonly<Record<string, Policy>> = Object.freeze({
  random: randomPolicy,
  greedy: greedyPolicy,
  contest: contestPolicy,
  belief: beliefPolicy,
})

const COLORS: readonly Color[] = ['white', 'black']

/**
 * Default ply cap. A game that hits it is reported as `truncated` and excluded
 * from nothing — a truncation is itself a finding (nobody could reach X), and
 * silently dropping those games would bias every rate upward.
 */
export const DEFAULT_MAX_PLIES = 1000

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

/** One ply, as the harness saw it. `moverId` comes from the harness's own state. */
export interface PlyRecord {
  ply: number
  color: Color
  /** the move in techspec §6 notation: `e2e4`, `e7e8q`, `O-O`, `pass` */
  notation: string
  /** which piece moved. 王車易位 records the king (as `gameStats` does); a pass, null. */
  moverId: PieceId | null
  /** did this ply make contact (§4) */
  contact: boolean
}

export interface GameOutcome {
  id: string
  seed: number
  policies: Record<Color, string>
  /** null only when the game was truncated before reaching a result */
  result: Result | null
  /** the winner, or null for 雙方軍旗同時離場 — the only draw (§7.5①) — or a truncation */
  winner: Color | null
  truncated: boolean
  plies: number
  score: { white: number; black: number }
  /** what each policy actually deployed. The harness received it; §10.5 opens it at 終局 anyway. */
  deployment: Record<Color, Record<PieceId, Rank>>
  plyRecords: PlyRecord[]
  stats: GameStats
  /**
   * The final position through the 全知者 viewer.
   *
   * A viewer, not the `GameState`: even the harness's own report goes through
   * the redaction layer, so nothing downstream — a chart, a regression test, a
   * future policy that reads a saved game — can develop a habit of reading
   * authoritative state.
   */
  final: ViewerState
}

export interface PlayOptions {
  seed: number
  white: Policy
  black: Policy
  /** merged over the harness defaults, which are DEFAULT_CONFIG with the clock off */
  config?: Partial<GameConfig>
  maxPlies?: number
  id?: string
}

/**
 * Harness defaults. The clock is OFF: §8 讀秒 measures human thinking time, bots
 * have none, and leaving it on would grant 增秒 on every ply for no reason.
 */
function harnessConfig(config?: Partial<GameConfig>): Partial<GameConfig> {
  return { clockEnabled: false, ...config }
}

/** Which piece is about to move, read from the harness's own state (never a policy's). */
function moverIdOf(state: GameState, move: Move): PieceId | null {
  if (move.kind === 'pass') return null
  if (move.kind === 'castle') {
    const king = state.pieces.find(
      (p) => p.color === state.toMove && p.carrier === 'king' && p.square !== null,
    )
    return king?.id ?? null
  }
  return pieceAt(state.pieces, move.from)?.id ?? null
}

/**
 * Play one complete game.
 *
 * The loop is the security boundary in miniature: `state` never leaves this
 * function, `stateForViewer` is the only thing handed out, and `applyMove` is
 * the only thing that changes anything. A policy returning an illegal move
 * throws from the engine, and a policy returning an invalid deployment throws
 * here — both name the policy, because a silent fallback would let a broken bot
 * quietly contribute games to a measurement.
 */
export function playGame(opts: PlayOptions): GameOutcome {
  const maxPlies = opts.maxPlies ?? DEFAULT_MAX_PLIES
  const id = opts.id ?? `bot-${opts.seed}`
  const policies: Record<Color, Policy> = { white: opts.white, black: opts.black }

  let state = createGame(id, harnessConfig(opts.config))

  // ---- 佈署 (§9). Simultaneous and mutually invisible: each side is shown the
  // state BEFORE anyone submitted, and `stateForViewer` withholds the ranks of
  // any side that has not submitted — including that side's own placeholders.
  const preDeployment = state
  const deployment = {} as Record<Color, Record<PieceId, Rank>>
  for (const color of COLORS) {
    const policy = policies[color]
    const rng = makeRng(deriveSeed(opts.seed, `deploy:${color}`))
    const view = stateForViewer(preDeployment, { kind: 'player', color })
    const assignment = policy.deploy(view, color, rng)
    const problem = validateAssignment(assignment, color, state)
    if (problem !== null) {
      throw new Error(`policy '${policy.name}' deployed ${color} illegally: ${problem}`)
    }
    deployment[color] = assignment
    state = submitAssignment(state, color, assignment)
  }

  // ---- Play. One stream per side, so swapping the opponent does not shift this
  // side's tie-breaks (notebook §6.6 — one variable at a time).
  const moveRng: Record<Color, Rng> = {
    white: makeRng(deriveSeed(opts.seed, 'move:white')),
    black: makeRng(deriveSeed(opts.seed, 'move:black')),
  }

  const plyRecords: PlyRecord[] = []
  let truncated = false

  while (state.status.kind === 'playing') {
    if (plyRecords.length >= maxPlies) {
      truncated = true
      break
    }
    const color = state.toMove
    const view = stateForViewer(state, { kind: 'player', color })
    const move = policies[color].move(view, color, moveRng[color])
    const moverId = moverIdOf(state, move)

    state = applyMove(state, move)

    const event = state.log[state.log.length - 1]!
    plyRecords.push({
      ply: event.ply,
      color,
      notation: moveToNotation(event.move),
      moverId,
      contact: event.combat !== undefined,
    })
  }

  const result = state.status.kind === 'over' ? state.status.result : null
  const final = stateForViewer(state, { kind: 'omniscient' })

  return {
    id,
    seed: opts.seed,
    policies: { white: policies.white.name, black: policies.black.name },
    result,
    winner: result && result.kind !== 'flag-both' ? result.winner : null,
    truncated,
    plies: plyRecords.length,
    score: { white: state.score.white, black: state.score.black },
    deployment,
    plyRecords,
    stats: gameStats(final),
    final,
  }
}

// ---------------------------------------------------------------------------
// Many games
// ---------------------------------------------------------------------------

export interface MatchOptions {
  seed: number
  /** how many SEEDS to play. With `swapColors` each seed produces two games. */
  games: number
  white: Policy
  black: Policy
  config?: Partial<GameConfig>
  maxPlies?: number
  /**
   * Play every seed twice, colours reversed.
   *
   * Turned on by default in the CLI: notebook §7 records that 貼目 0.5 對先手 was
   * called 「明顯不足」 and then reversed, on games that never controlled for the
   * seat. A paired swap makes a seat effect visible instead of confounding.
   */
  swapColors?: boolean
  /** keep every `GameOutcome` in the summary. Off by default — 1000 games is a lot of memory. */
  keepGames?: boolean
}

/** Aggregate over a set of games, from one seat's or one policy's point of view. */
export interface Aggregate {
  games: number
  wins: number
  draws: number
  winRate: number
  /** final score including 貼目 for black */
  meanScore: number
  /** notebook §3.3b's 每手得分, 貼目 removed */
  meanEarnedPerPly: number
  /** mean 結算格 held at own settlements */
  meanEarnedPerSettlement: number
  /** notebook §3.3b's 同時持有 N 格 */
  meanPeakHeld: number
  /** notebook §3.3b's 最長零分 */
  meanLongestZeroRun: number
  /** notebook §3.3d's 落點率 — kept, and kept suspect: it counts arrivals, not departures */
  meanObjectiveRatio: number | null
  /** games lost to §7.5① 奪旗 */
  flagLosses: number
  /** contacts this side STARTED. The greedy instrument's headline invariant is that this is 0. */
  capturesInitiated: number
}

export interface MatchSummary {
  seed: number
  /** games actually played — twice `options.games` when `swapColors` is on */
  games: number
  truncated: number
  meanPlies: number
  resultKinds: Record<string, number>
  /** by SEAT — white vs black, the first-move question */
  byColor: Record<Color, Aggregate>
  /** by POLICY. Self-play collapses into one entry, since both sides share a name. */
  byPolicy: Record<string, Aggregate>
  contacts: {
    total: number
    perGame: number
    mutual: number
    fizzle: number
    attackerWins: number
    defenderWins: number
    /** 同歸於盡 / contacts. NOT comparable with notebook §4.1's 18%, see rules/render/record.ts */
    mutualRatio: number | null
  }
  outcomes?: GameOutcome[]
}

interface Acc {
  games: number
  wins: number
  draws: number
  score: number
  earnedPerPly: number
  earnedPerSettlement: number
  peakHeld: number
  longestZeroRun: number
  objectiveRatio: number
  objectiveGames: number
  flagLosses: number
  capturesInitiated: number
}

function newAcc(): Acc {
  return {
    games: 0, wins: 0, draws: 0, score: 0, earnedPerPly: 0, earnedPerSettlement: 0,
    peakHeld: 0, longestZeroRun: 0, objectiveRatio: 0, objectiveGames: 0,
    flagLosses: 0, capturesInitiated: 0,
  }
}

function accumulate(acc: Acc, outcome: GameOutcome, color: Color): void {
  const side = outcome.stats.sides[color]
  acc.games++
  if (outcome.winner === color) acc.wins++
  if (outcome.result?.kind === 'flag-both') acc.draws++
  if (outcome.result?.kind === 'flag' && outcome.result.winner !== color) acc.flagLosses++
  if (outcome.result?.kind === 'flag-both') acc.flagLosses++
  acc.score += side.score
  acc.earnedPerPly += side.earnedPerPly
  acc.earnedPerSettlement += side.earnedPerSettlement
  acc.peakHeld += side.peakSquaresHeld.count
  acc.longestZeroRun += side.longestZeroRun.length
  if (side.objectiveMoves.ratio !== null) {
    acc.objectiveRatio += side.objectiveMoves.ratio
    acc.objectiveGames++
  }
  for (const r of outcome.plyRecords) {
    if (r.color === color && r.contact) acc.capturesInitiated++
  }
}

function finish(acc: Acc): Aggregate {
  const n = acc.games || 1
  return {
    games: acc.games,
    wins: acc.wins,
    draws: acc.draws,
    winRate: acc.wins / n,
    meanScore: acc.score / n,
    meanEarnedPerPly: acc.earnedPerPly / n,
    meanEarnedPerSettlement: acc.earnedPerSettlement / n,
    meanPeakHeld: acc.peakHeld / n,
    meanLongestZeroRun: acc.longestZeroRun / n,
    meanObjectiveRatio: acc.objectiveGames > 0 ? acc.objectiveRatio / acc.objectiveGames : null,
    flagLosses: acc.flagLosses,
    capturesInitiated: acc.capturesInitiated,
  }
}

/**
 * Play a batch and aggregate it.
 *
 * Game `i` runs on `deriveSeed(seed, i)` — not `seed + i` — so consecutive
 * batches do not overlap and neighbouring games are not correlated. Nothing
 * here consults a clock or a counter outside the seed, so a summary is a pure
 * function of its options.
 */
export function runMatch(opts: MatchOptions): MatchSummary {
  const swap = opts.swapColors ?? false
  const byColor: Record<Color, Acc> = { white: newAcc(), black: newAcc() }
  const byPolicy = new Map<string, Acc>()
  const resultKinds: Record<string, number> = {}
  const outcomes: GameOutcome[] = []

  let played = 0
  let truncated = 0
  let plies = 0
  let contacts = 0
  let mutual = 0
  let fizzle = 0
  let attackerWins = 0
  let defenderWins = 0

  const policyAcc = (name: string): Acc => {
    let acc = byPolicy.get(name)
    if (!acc) {
      acc = newAcc()
      byPolicy.set(name, acc)
    }
    return acc
  }

  for (let i = 0; i < opts.games; i++) {
    const gameSeed = deriveSeed(opts.seed, i)
    const pairings: { white: Policy; black: Policy }[] = swap
      ? [{ white: opts.white, black: opts.black }, { white: opts.black, black: opts.white }]
      : [{ white: opts.white, black: opts.black }]

    pairings.forEach((pairing, k) => {
      const outcome = playGame({
        seed: gameSeed,
        white: pairing.white,
        black: pairing.black,
        ...(opts.config ? { config: opts.config } : {}),
        ...(opts.maxPlies !== undefined ? { maxPlies: opts.maxPlies } : {}),
        id: `${opts.seed}-${i}${swap ? (k === 0 ? 'a' : 'b') : ''}`,
      })

      played++
      plies += outcome.plies
      if (outcome.truncated) truncated++
      const kind = outcome.result?.kind ?? 'unfinished'
      resultKinds[kind] = (resultKinds[kind] ?? 0) + 1

      contacts += outcome.stats.contacts
      mutual += outcome.stats.contactsByOutcome['mutual-destruction']
      fizzle += outcome.stats.contactsByOutcome.fizzle
      attackerWins += outcome.stats.contactsByOutcome['attacker-wins']
      defenderWins += outcome.stats.contactsByOutcome['defender-wins']

      for (const color of COLORS) {
        accumulate(byColor[color], outcome, color)
        accumulate(policyAcc(outcome.policies[color]), outcome, color)
      }

      if (opts.keepGames) outcomes.push(outcome)
    })
  }

  const n = played || 1
  const summary: MatchSummary = {
    seed: opts.seed,
    games: played,
    truncated,
    meanPlies: plies / n,
    resultKinds,
    byColor: { white: finish(byColor.white), black: finish(byColor.black) },
    byPolicy: Object.fromEntries([...byPolicy].map(([name, acc]) => [name, finish(acc)])),
    contacts: {
      total: contacts,
      perGame: contacts / n,
      mutual,
      fizzle,
      attackerWins,
      defenderWins,
      mutualRatio: contacts > 0 ? mutual / contacts : null,
    },
  }
  if (opts.keepGames) summary.outcomes = outcomes
  return summary
}

// ---------------------------------------------------------------------------
// CLI — `node packages/bot/dist/index.js --white greedy --black random --games 500`
// ---------------------------------------------------------------------------

const BOARDS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  centre4: SCORING_CENTRE_4,
  center4: SCORING_CENTRE_4,
  wide8: SCORING_WIDE_8,
})

const DISTRIBUTIONS: Readonly<Record<string, RankDistribution>> = Object.freeze({
  standard: DISTRIBUTION_STANDARD,
  scouts: DISTRIBUTION_SCOUTS,
  'top-heavy': DISTRIBUTION_TOP_HEAVY,
})

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = argv[i + 1]
  return value !== undefined && !value.startsWith('--') ? value : undefined
}

function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, got '${raw}'`)
  return n
}

function policyFlag(argv: readonly string[], name: string, fallback: string): Policy {
  const key = flagValue(argv, name) ?? fallback
  const policy = POLICIES[key]
  if (!policy) {
    throw new Error(`unknown policy '${key}'. Known: ${Object.keys(POLICIES).join(', ')}`)
  }
  return policy
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function fmt(x: number, digits = 3): string {
  return x.toFixed(digits)
}

function aggregateLine(label: string, a: Aggregate): string {
  return [
    label.padEnd(10),
    String(a.games).padStart(6),
    pct(a.winRate).padStart(7),
    fmt(a.meanScore, 1).padStart(8),
    fmt(a.meanEarnedPerPly).padStart(9),
    fmt(a.meanPeakHeld, 2).padStart(6),
    fmt(a.meanLongestZeroRun, 2).padStart(7),
    (a.meanObjectiveRatio === null ? '—' : fmt(a.meanObjectiveRatio, 2)).padStart(7),
    String(a.flagLosses).padStart(6),
    String(a.capturesInitiated).padStart(9),
  ].join(' ')
}

const HEADER = [
  ''.padEnd(10),
  'games'.padStart(6),
  'win'.padStart(7),
  'score'.padStart(8),
  'pts/ply'.padStart(9),
  'peak'.padStart(6),
  'zero'.padStart(7),
  'objRt'.padStart(7),
  '旗負'.padStart(5),
  'attacks'.padStart(9),
].join(' ')

/** Render a summary as the text a human reads in the terminal. */
export function formatSummary(summary: MatchSummary, title: string): string {
  const lines: string[] = []
  lines.push(title)
  lines.push(
    `seed ${summary.seed} · ${summary.games} games · mean ${fmt(summary.meanPlies, 1)} plies`
    + (summary.truncated > 0 ? ` · ${summary.truncated} truncated` : ''),
  )
  lines.push('')
  lines.push(HEADER)
  for (const [name, agg] of Object.entries(summary.byPolicy)) lines.push(aggregateLine(name, agg))
  lines.push('')
  lines.push(aggregateLine('as white', summary.byColor.white))
  lines.push(aggregateLine('as black', summary.byColor.black))
  lines.push('')
  const kinds = Object.entries(summary.resultKinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')
  lines.push(`endings   ${kinds}`)
  const c = summary.contacts
  lines.push(
    `contacts  ${c.total} total (${fmt(c.perGame, 2)}/game) · 同歸於盡 ${c.mutual}`
    + ` · 有煙無傷 ${c.fizzle} · 攻方勝 ${c.attackerWins} · 守方勝 ${c.defenderWins}`
    + (c.mutualRatio === null ? '' : ` · 雙亡率 ${pct(c.mutualRatio)}`),
  )
  return lines.join('\n')
}

export function runCli(argv: readonly string[]): string {
  if (argv.includes('--help') || argv.includes('-h')) {
    return [
      'xiyang bot arena — self-play measurement over @xiyang/rules',
      '',
      '  --games N          seeds to play (default 200; doubled by --swap)',
      '  --seed S           master seed (default 1)',
      `  --white NAME       ${Object.keys(POLICIES).join(' | ')} (default greedy)`,
      `  --black NAME       ${Object.keys(POLICIES).join(' | ')} (default random)`,
      `  --board NAME       ${Object.keys(BOARDS).join(' | ')} (default centre4)`,
      `  --distribution N   ${Object.keys(DISTRIBUTIONS).join(' | ')} (default standard)`,
      '  --target X         score line (default 40)',
      '  --stall N          停滯 turns (default 30)',
      '  --komi K           貼目 for black (default 0.5)',
      `  --k C              吃子得分係數 k, §7.3 (default ${DEFAULT_CONFIG.captureScoreK})`,
      `  --fizzle F         有煙無傷獎勵, §7.3 (default ${DEFAULT_CONFIG.fizzleBonus})`,
      '  --max-plies M      ply cap per game (default 1000)',
      '  --no-swap          do NOT replay every seat swapped (swapping is the default)',
      '  --json             emit the summary as JSON instead of a table',
    ].join('\n')
  }

  const white = policyFlag(argv, 'white', 'greedy')
  const black = policyFlag(argv, 'black', 'random')
  const boardName = flagValue(argv, 'board') ?? 'centre4'
  const board = BOARDS[boardName]
  if (!board) throw new Error(`unknown board '${boardName}'. Known: ${Object.keys(BOARDS).join(', ')}`)
  const distName = flagValue(argv, 'distribution') ?? 'standard'
  const distribution = DISTRIBUTIONS[distName]
  if (!distribution) {
    throw new Error(`unknown distribution '${distName}'. Known: ${Object.keys(DISTRIBUTIONS).join(', ')}`)
  }
  // §7.3's two knobs, 附錄 B 待定. The fallback is the ENGINE's default rather than a
  // literal here, so this CLI cannot quietly play a different economy from the one
  // `DEFAULT_CONFIG` ships — and both appear in the title, because a run at a
  // non-zero k is a separate series that must never be pooled with the k=0 ones.
  //
  // Rounded, because 附錄 B requires whole numbers: 貼目 must stay the ONLY
  // non-integer source of points or §7.4's 「分數永不相等」 stops holding and a 分數
  // finish can end level, which the rulebook says cannot happen.
  const captureScoreK = Math.round(numberFlag(argv, 'k', DEFAULT_CONFIG.captureScoreK))
  const fizzleBonus = Math.round(numberFlag(argv, 'fizzle', DEFAULT_CONFIG.fizzleBonus))

  const summary = runMatch({
    seed: numberFlag(argv, 'seed', 1),
    games: numberFlag(argv, 'games', 200),
    white,
    black,
    swapColors: !argv.includes('--no-swap'),
    maxPlies: numberFlag(argv, 'max-plies', DEFAULT_MAX_PLIES),
    config: {
      scoringSquares: board,
      distribution,
      scoreTarget: numberFlag(argv, 'target', 40),
      noProgressTurns: numberFlag(argv, 'stall', 30),
      komi: numberFlag(argv, 'komi', 0.5),
      captureScoreK,
      fizzleBonus,
    },
  })

  if (argv.includes('--json')) return JSON.stringify(summary, null, 2)
  return formatSummary(
    summary,
    `${white.name} vs ${black.name} · ${boardName} · ${distName}`
    + ` · X=${numberFlag(argv, 'target', 40)} · N=${numberFlag(argv, 'stall', 30)}`
    + ` · k=${captureScoreK} · 有煙無傷=${fizzleBonus}`,
  )
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  console.log(runCli(process.argv.slice(2)))
}
