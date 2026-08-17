/**
 * Aggregation and printing. What a thousand games add up to.
 *
 * Two rules run through this file.
 *
 * **Reuse `gameStats`.** Per-game figures — plies, contacts, points per ply,
 * settlements, peak 結算格 held — are computed by `@xiyang/rules`
 * (`render/record.ts`) and are the same numbers the exported 棋譜 shows. A
 * second implementation here would drift from the one the notebook quotes, and
 * then two files would disagree about what happened in a game.
 *
 * **Pool, do not average ratios.** Notebook §6.6: two playtests were misread
 * because an 8-contact denominator was quoted as a rate. Every rate below is
 * therefore `total / total` across the whole run, never the mean of per-game
 * rates, and the raw fraction is printed next to it so the denominator is
 * always visible. The only per-game means are the ones where the per-game value
 * is itself the quantity of interest (plies, peak squares held).
 *
 * Redaction: this file reads the finished `GameState` through
 * `stateForViewer(state, { kind: 'omniscient' })`. That is the 全知者 replay
 * view of §10.1, which is exactly what an analyst is entitled to — and at 終局
 * §10.5 opens every 兵種 to every viewer anyway. It is used for statistics only;
 * no policy is ever handed a view produced here.
 *
 * The output is deterministic: no clock is read, no elapsed time is printed, no
 * iteration order depends on anything but the data. The same seed prints the
 * same bytes.
 */

import {
  ALL_RANKS,
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  RANK_NAMES_ZH,
  SCORING_CENTRE_4,
  SCORING_WIDE_8,
  gameStats,
  squareName,
  stateForViewer,
} from '@xiyang/rules'
import type { Color, GameConfig, Rank, Square } from '@xiyang/rules'
import type { Match, MatchOutcomeKind } from './harness.js'

// ---------------------------------------------------------------------------
// Shape of the aggregate
// ---------------------------------------------------------------------------

export interface RunMeta {
  /** the root seed the whole run came from */
  seed: number
  /** the ply cap each match was played under */
  maxPlies: number
}

export interface LengthStats {
  mean: number
  median: number
  min: number
  max: number
  total: number
}

export interface ContactStats {
  /** contacts of every kind, pooled */
  total: number
  /** contacts / plies, pooled — notebook §6.5's health signal */
  perPly: number | null
  /** 階級對決 — contacts where two 階級 were compared. Engine-instrumented. */
  rankDuels: number
  /** 同階雙亡 among those */
  rankTies: number
  /** rankTies / rankDuels, pooled; null when there were no rank duels */
  tieRate: number | null
  rankDecisive: number
  bombDetonations: number
  bombVsBomb: number
  fizzles: number
  /**
   * 同歸於盡 as the LOG announced it. Equals rankTies + bombDetonations +
   * bombVsBomb by construction; carried so the two paths can be compared, and
   * so the printed table can say plainly that the split above is not derivable
   * from a log (gamebook v04 §4.3).
   */
  announcedMutual: number
}

export interface SideAggregate {
  color: Color
  name: string
  wins: number
  /** wins / games — decided games only can be recovered from `Aggregate` */
  winRate: number
  /** wins broken down by the condition that ended the game */
  winsByCondition: Record<MatchOutcomeKind, number>
  /** pooled score / pooled plies, 貼目 included */
  pointsPerPly: number | null
  /** pooled earned / pooled plies, 貼目 removed — the cross-run comparable rate */
  earnedPerPly: number | null
  /** pooled earned / pooled own 結算 — the mean 結算格 held at a settlement */
  meanSquaresHeld: number | null
  /** mean over games of that game's peak simultaneous holding */
  meanPeakHeld: number
  /** the largest simultaneous holding in the whole run */
  maxPeakHeld: number
  /** mean final score, 貼目 included */
  meanScore: number
}

export interface Aggregate {
  meta: RunMeta
  config: GameConfig
  games: number
  /** games that ended with a winner */
  decided: number
  /** 雙旗同時離場 — the only draw in the game (§7④①) */
  drawn: number
  /** games that hit maxPlies without ending */
  unfinished: number
  /** how many games ended each way, regardless of who won */
  byCondition: Record<MatchOutcomeKind, number>
  plies: LengthStats
  contacts: ContactStats
  sides: Record<Color, SideAggregate>
}

const OUTCOME_KINDS: readonly MatchOutcomeKind[] = [
  'flag', 'score', 'no-progress', 'timeout', 'resign', 'flag-both', 'max-plies',
]

const OUTCOME_LABEL: Record<MatchOutcomeKind, string> = {
  'flag': '奪旗 flag',
  'score': '分數 score',
  'no-progress': '停滯 no-progress',
  'timeout': '超時 timeout',
  'resign': '認輸 resign',
  'flag-both': '雙旗和局 flag-both',
  'max-plies': '未終局 hit maxPlies',
}

const COLORS: readonly Color[] = ['white', 'black']

function zeroByCondition(): Record<MatchOutcomeKind, number> {
  const out = {} as Record<MatchOutcomeKind, number>
  for (const kind of OUTCOME_KINDS) out[kind] = 0
  return out
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

export function aggregate(matches: readonly Match[], meta: RunMeta): Aggregate {
  const first = matches[0]
  if (!first) throw new Error('aggregate: no matches to aggregate')

  const byCondition = zeroByCondition()
  const winsByCondition: Record<Color, Record<MatchOutcomeKind, number>> = {
    white: zeroByCondition(),
    black: zeroByCondition(),
  }
  const wins: Record<Color, number> = { white: 0, black: 0 }
  const totalScore: Record<Color, number> = { white: 0, black: 0 }
  const totalEarned: Record<Color, number> = { white: 0, black: 0 }
  const totalSettlements: Record<Color, number> = { white: 0, black: 0 }
  const peakSum: Record<Color, number> = { white: 0, black: 0 }
  const peakMax: Record<Color, number> = { white: 0, black: 0 }

  const plies: number[] = []
  let totalPlies = 0
  let totalContacts = 0
  let announcedMutual = 0
  let rankDuels = 0
  let rankTies = 0
  let rankDecisive = 0
  let bombDetonations = 0
  let bombVsBomb = 0
  let fizzles = 0
  let drawn = 0
  let unfinished = 0

  for (const match of matches) {
    // 全知者 (§10.1). Statistics only — see the file header.
    const view = stateForViewer(match.state, { kind: 'omniscient' })
    const stats = gameStats(view)
    const { outcome, duels } = match.result

    byCondition[outcome.kind]++
    if (outcome.winner !== null) {
      wins[outcome.winner]++
      winsByCondition[outcome.winner][outcome.kind]++
    } else if (outcome.kind === 'flag-both') {
      drawn++
    }
    if (match.result.unfinished) unfinished++

    plies.push(stats.pliesPlayed)
    totalPlies += stats.pliesPlayed
    totalContacts += stats.contacts
    announcedMutual += stats.contactsByOutcome['mutual-destruction']

    rankDuels += duels.rankDuels
    rankTies += duels.rankTies
    rankDecisive += duels.rankDecisive
    bombDetonations += duels.bombDetonations
    bombVsBomb += duels.bombVsBomb
    fizzles += duels.fizzles

    for (const color of COLORS) {
      const side = stats.sides[color]
      totalScore[color] += side.score
      totalEarned[color] += side.earned
      totalSettlements[color] += side.settlements
      const peak = side.peakSquaresHeld.count
      peakSum[color] += peak
      if (peak > peakMax[color]) peakMax[color] = peak
    }
  }

  const games = matches.length
  const sorted = [...plies].sort((a, b) => a - b)

  const side = (color: Color): SideAggregate => ({
    color,
    name: first.result.names[color],
    wins: wins[color],
    winRate: wins[color] / games,
    winsByCondition: winsByCondition[color],
    pointsPerPly: ratio(totalScore[color], totalPlies),
    earnedPerPly: ratio(totalEarned[color], totalPlies),
    meanSquaresHeld: ratio(totalEarned[color], totalSettlements[color]),
    meanPeakHeld: peakSum[color] / games,
    maxPeakHeld: peakMax[color],
    meanScore: totalScore[color] / games,
  })

  return {
    meta,
    config: first.state.config,
    games,
    decided: wins.white + wins.black,
    drawn,
    unfinished,
    byCondition,
    plies: {
      mean: totalPlies / games,
      median: median(sorted),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      total: totalPlies,
    },
    contacts: {
      total: totalContacts,
      perPly: ratio(totalContacts, totalPlies),
      rankDuels,
      rankTies,
      tieRate: ratio(rankTies, rankDuels),
      rankDecisive,
      bombDetonations,
      bombVsBomb,
      fizzles,
      announcedMutual,
    },
    sides: { white: side('white'), black: side('black') },
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Terminal columns, counting a CJK glyph as two.
 *
 * Every label in this report is bilingual, and padding by code unit puts the
 * numeric columns of a table with 同階雙亡 in one row and `flag` in the next two
 * characters apart. Cheaper to measure than to give up the Chinese.
 */
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    width += isWide(cp) ? 2 : 1
  }
  return width
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)))
  return align === 'right' ? fill + text : text + fill
}

/**
 * Greedy word wrap on display width. Deterministic — a pure function of the
 * string — so a wrapped note does not break the byte-identical guarantee.
 */
function wrap(text: string, width = 92): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line === '') line = word
    else if (displayWidth(line) + 1 + displayWidth(word) <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

type Align = 'left' | 'right'

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const aligns: Align[] = headers.map((_, i) => (i === 0 ? 'left' : 'right'))
  const widths = headers.map((h, i) => {
    let w = displayWidth(h)
    for (const row of rows) w = Math.max(w, displayWidth(row[i] ?? ''))
    return w
  })
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i]!, aligns[i]!)).join('  ').trimEnd()

  const rule = widths.map((w) => '─'.repeat(w)).join('  ')
  return [line(headers), rule, ...rows.map(line)]
}

/** Trim float noise without padding integers — the same rule record.ts uses. */
function num(n: number, dp: number): string {
  return n.toFixed(dp)
}

function rate(n: number | null, dp = 3): string {
  return n === null ? '—' : n.toFixed(dp)
}

function pct(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`
}

function sameSquares(a: readonly Square[], b: readonly Square[]): boolean {
  return a.length === b.length && a.every((sq, i) => sq === b[i])
}

function squaresName(squares: readonly Square[]): string {
  const named = squares.map(squareName).join(' ')
  if (sameSquares(squares, SCORING_CENTRE_4)) return `centre4 — ${named}`
  if (sameSquares(squares, SCORING_WIDE_8)) return `wide8 — ${named}`
  return `custom — ${named || '(none)'}`
}

function sameDistribution(a: Readonly<Record<Rank, number>>, b: Readonly<Record<Rank, number>>): boolean {
  return ALL_RANKS.every((r) => a[r] === b[r])
}

/** 附錄 B order: 司令-軍長-師長-旅長-團長-營長-連長-排長-工兵-軍旗-爆裂物. */
function distributionName(d: Readonly<Record<Rank, number>>): string {
  const counts = ALL_RANKS.map((r) => d[r]).join('-')
  if (sameDistribution(d, DISTRIBUTION_STANDARD)) return `standard ${counts}`
  if (sameDistribution(d, DISTRIBUTION_SCOUTS)) return `scouts ${counts}`
  if (sameDistribution(d, DISTRIBUTION_TOP_HEAVY)) return `topheavy ${counts}`
  return `custom ${counts}`
}

/** Only ever printed for a custom table, where the bare numbers are unreadable. */
function distributionDetail(d: Readonly<Record<Rank, number>>): string {
  return ALL_RANKS.map((r) => `${RANK_NAMES_ZH[r]}${d[r]}`).join(' ')
}

/**
 * The whole report, as a string. Compact, aligned, and byte-identical for a
 * given seed — nothing here reads a clock or a locale.
 */
export function formatReport(agg: Aggregate): string {
  const { config, sides } = agg
  const out: string[] = []

  out.push('行軍西洋棋 — bot harness')
  out.push(
    `white ${sides.white.name} · black ${sides.black.name}`
    + ` · ${agg.games} games · seed ${agg.meta.seed} · maxPlies ${agg.meta.maxPlies}`,
  )
  out.push(
    `結算格 ${squaresName(config.scoringSquares)}`
    + ` · X ${num(config.scoreTarget, 0)} · N ${num(config.noProgressTurns, 0)}`
    + ` · 貼目 ${config.komi}`
    + ` · clock ${config.clockEnabled ? 'on' : 'off'}`,
  )
  const distribution = distributionName(config.distribution)
  out.push(`兵種 ${distribution}`)
  // A named preset is legible from its counts; an unnamed one is not.
  if (distribution.startsWith('custom')) out.push(`     ${distributionDetail(config.distribution)}`)
  out.push('')

  // ---- who won, and how ----------------------------------------------------
  out.push('勝負 — games ending each way, and who took them')
  out.push('')
  const resultRows = OUTCOME_KINDS.map((kind) => {
    const total = agg.byCondition[kind]
    const w = sides.white.winsByCondition[kind]
    const b = sides.black.winsByCondition[kind]
    const none = total - w - b
    return [
      OUTCOME_LABEL[kind],
      String(w),
      String(b),
      String(none),
      String(total),
      pct(ratio(total, agg.games)),
    ]
  })
  resultRows.push([
    'total',
    String(sides.white.wins),
    String(sides.black.wins),
    String(agg.games - agg.decided),
    String(agg.games),
    pct(1),
  ])
  out.push(...table(['條件 condition', 'W wins', 'B wins', 'no winner', 'games', 'share'], resultRows))
  out.push('')
  out.push(
    `win rate — white ${pct(sides.white.winRate)} · black ${pct(sides.black.winRate)}`
    + ` · draw ${pct(ratio(agg.drawn, agg.games))}`
    + ` · unfinished ${pct(ratio(agg.unfinished, agg.games))}`,
  )
  out.push('')

  // ---- length --------------------------------------------------------------
  out.push(
    `長度 length — mean ${num(agg.plies.mean, 1)} · median ${num(agg.plies.median, 1)}`
    + ` · min ${agg.plies.min} · max ${agg.plies.max} · ${agg.plies.total} plies total`,
  )
  out.push('')

  // ---- contacts ------------------------------------------------------------
  const c = agg.contacts
  out.push('接觸 contacts — pooled over the whole run, never a mean of per-game rates')
  out.push('')
  const contactRows: string[][] = [
    ['接觸 contacts', String(c.total), c.perPly === null ? '—' : `${rate(c.perPly)} per ply`],
    ['階級對決 rank duels', String(c.rankDuels), `${rate(ratio(c.rankDuels, c.total))} of contacts`],
    ['　同階雙亡 rank ties', String(c.rankTies), `${rate(c.tieRate)} of rank duels`],
    ['　decided', String(c.rankDecisive), `${rate(ratio(c.rankDecisive, c.rankDuels))} of rank duels`],
    ['爆裂物 detonations', String(c.bombDetonations), `${rate(ratio(c.bombDetonations, c.total))} of contacts`],
    ['爆對爆 bomb vs bomb', String(c.bombVsBomb), `${rate(ratio(c.bombVsBomb, c.total))} of contacts`],
    ['有煙無傷 fizzles', String(c.fizzles), `${rate(ratio(c.fizzles, c.total))} of contacts`],
    ['同歸於盡 announced', String(c.announcedMutual), `${rate(ratio(c.announcedMutual, c.total))} of contacts`],
  ]
  out.push(...table(['', 'count', 'rate'], contactRows))
  out.push('')
  out.push(...wrap(
    '接觸/手 contacts per ply is the health signal of notebook §6.5: two bots that'
    + ' both sit on 結算格 and never touch each other have deleted the hidden layer.',
  ))
  const split = c.rankTies + c.bombDetonations + c.bombVsBomb
  out.push(...wrap(
    `同階雙亡/階級對決 is ENGINE-INSTRUMENTED — a log cannot produce it (§4.3: an equal 兵種, a`
    + ` 爆裂物 and 爆對爆 all announce the same 同歸於盡). The ${c.announcedMutual} announced`
    + ` 同歸於盡 split as ${c.rankTies} + ${c.bombDetonations} + ${c.bombVsBomb}`
    + (split === c.announcedMutual ? '.' : ` — MISMATCH, expected ${c.announcedMutual}.`),
  ))
  out.push('')

  // ---- per side ------------------------------------------------------------
  out.push('每方 per side — 貼目 is credited to black before ply 1')
  out.push('')
  const w = sides.white
  const b = sides.black
  out.push(...table(
    ['', `White ${w.name}`, `Black ${b.name}`],
    [
      ['wins', `${w.wins} (${pct(w.winRate)})`, `${b.wins} (${pct(b.winRate)})`],
      ['每手得分 points/ply (貼目 in)', rate(w.pointsPerPly), rate(b.pointsPerPly)],
      ['每手得分 earned/ply (貼目 out)', rate(w.earnedPerPly), rate(b.earnedPerPly)],
      ['平均佔格 mean squares/結算', rate(w.meanSquaresHeld), rate(b.meanSquaresHeld)],
      ['最高同時佔格 mean peak', num(w.meanPeakHeld, 2), num(b.meanPeakHeld, 2)],
      ['最高同時佔格 max peak', String(w.maxPeakHeld), String(b.maxPeakHeld)],
      ['平均終局分數 mean score', num(w.meanScore, 2), num(b.meanScore, 2)],
    ],
  ))
  out.push('')
  out.push(...wrap(
    'points/ply keeps GAME LENGTH as its denominator (what 分數線 X is checked'
    + ' against); mean squares/結算 is per own 結算 and runs at about twice it,'
    + ' because §7 credits only the mover — a side settles on half the plies.',
  ))
  out.push('')
  out.push(`replay this run: --seed ${agg.meta.seed} --games ${agg.games} --max-plies ${agg.meta.maxPlies}`)

  return out.join('\n')
}
