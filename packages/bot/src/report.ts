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
 * That includes the §7.1 split. `SideStats` already carries `earnedFromCaptures`
 * and `earnedFromSettlement`, priced by the engine's own `captureScore` off the
 * PUBLIC `CombatOutcome`; this file adds them up and never reprices anything.
 * Re-deriving the §7.3 table here would put a second copy of a 附錄 B rule in a
 * package that only measures.
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
  /**
   * Every figure below is derived from the SCORE, which §7.1 pays out of two
   * sources: the ① 吃子 payment of §7.3, settled in the action phase, and the
   * ② 佔領計分格 settlement of §7.2. The two are NOT interchangeable and this
   * struct keeps them apart, because only ② is a count of squares:
   *
   *   · a 得分 row (`pointsPerPly`, `earnedPerPly`, `meanScore`) is ①+②, which
   *     is what its label says — points.
   *   · a 佔格 row (`meanSquaresHeld`, `meanPeakHeld`, `maxPeakHeld`) reads ②
   *     ALONE. `record.ts` splits the columns for exactly this reason; the bot
   *     must not re-fuse them by dividing `earned` by a settlement count.
   *   · `captureIncome`/`capturePerPly` are the ① half on its own — the row a
   *     k sweep is actually reading.
   *
   * ① does not follow the mover: 守方勝 pays the defender and 有煙無傷 pays the
   * survivor, both on a ply that side never moved on, so ① has no per-own-結算
   * denominator and is pooled over GAME LENGTH instead.
   *
   * At the shipped `captureScoreK`/`fizzleBonus` of 0 the ① half is identically
   * zero, `earned === earnedFromSettlement` exactly, and the 得分 and 佔格 rows
   * coincide — which is why every notebook figure taken at the default is still
   * reproducible byte for byte.
   */
  /** pooled score / pooled plies, 貼目 included — ①+② */
  pointsPerPly: number | null
  /** pooled earned / pooled plies, 貼目 removed — ①+②, the cross-run comparable rate */
  earnedPerPly: number | null
  /**
   * ① 吃子得分 (§7.3) pooled over the whole run. 0 at the shipped default.
   *
   * Exact, not approximate: 附錄 B requires `captureScoreK` and `fizzleBonus` to
   * be whole numbers and `RANK_ORDER` is an integer, so this is a sum of
   * integers and prints without float dust. A fractional total in the report is
   * itself the finding — some caller has put a non-integer into 附錄 B.
   */
  captureIncome: number
  /** pooled ① / pooled plies — ① lands on either side's ply, so the denominator is length */
  capturePerPly: number | null
  /** pooled ② / pooled own 結算 — the mean 結算格 held at a settlement */
  meanSquaresHeld: number | null
  /** mean over games of that game's peak simultaneous ② holding */
  meanPeakHeld: number
  /** the largest simultaneous ② holding in the whole run */
  maxPeakHeld: number
  /** mean final score, 貼目 included — ①+② */
  meanScore: number
}

export interface Aggregate {
  meta: RunMeta
  config: GameConfig
  games: number
  /** games that ended with a winner */
  decided: number
  /** 雙旗同時離場 — the only draw in the game (§7.5①) */
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
  // §7.1's two sources, pooled separately — see the note on `SideAggregate`.
  // `totalEarned` stays the sum of both because the rows it feeds are per-ply
  // 得分 rates; only the per-結算 row below needs the ② column on its own.
  const totalCaptured: Record<Color, number> = { white: 0, black: 0 }
  const totalHeld: Record<Color, number> = { white: 0, black: 0 }
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
      // `record.ts` guarantees earnedFromCaptures + earnedFromSettlement ===
      // earned, so these two pools always add back up to `totalEarned`.
      totalCaptured[color] += side.earnedFromCaptures
      totalHeld[color] += side.earnedFromSettlement
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
    captureIncome: totalCaptured[color],
    // ① is pooled over GAME LENGTH, not over own 結算: 守方勝 and 有煙無傷 credit
    // the side that did not move, so a per-own-結算 denominator would be the
    // wrong one for part of the numerator.
    capturePerPly: ratio(totalCaptured[color], totalPlies),
    // ② ALONE over own 結算. This used to be `totalEarned / totalSettlements`,
    // which was a true square count only while ① was identically zero, and at
    // any k > 0 reported capture points as squares held — a figure that could
    // exceed the number of 結算格 on the board. §7.5② credits +1 per own piece
    // standing on a 結算格, so the ② column IS the count of squares.
    meanSquaresHeld: ratio(totalHeld[color], totalSettlements[color]),
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
  // Every 附錄 B knob the run was played under, read back off the ENGINE's config
  // (`aggregate` takes it from `state.config`, not from the parsed flags), so a
  // flag that was accepted but never threaded prints its default and is caught.
  out.push(
    `結算格 ${squaresName(config.scoringSquares)}`
    + ` · X ${num(config.scoreTarget, 0)} · N ${num(config.noProgressTurns, 0)}`
    + ` · 貼目 ${config.komi}`
    + ` · 吃子 k ${config.captureScoreK} · 有煙無傷 ${config.fizzleBonus}`
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
  const capturesLive = config.captureScoreK !== 0 || config.fizzleBonus !== 0
  const sideRows: string[][] = [
    ['wins', `${w.wins} (${pct(w.winRate)})`, `${b.wins} (${pct(b.winRate)})`],
    ['每手得分 points/ply (貼目 in)', rate(w.pointsPerPly), rate(b.pointsPerPly)],
    ['每手得分 earned/ply (貼目 out)', rate(w.earnedPerPly), rate(b.earnedPerPly)],
  ]
  // The ① rows are gated on the CONFIG, not on whether any capture happened: a
  // k-sweep run where nothing ever met should still show its zero income, while
  // a default run must print the same bytes it always has. `capturesLive` is a
  // pure function of 附錄 B, so the shape of the table is fixed before the first
  // game is played.
  if (capturesLive) {
    // The label carries no ① mark on purpose. U+2460 is East Asian AMBIGUOUS
    // width — one column in a Latin locale, two in a CJK one — and `isWide`
    // resolves it to one, so a terminal that renders it wide would knock these
    // two rows out of the numeric column. The prose below says which source is
    // which; the table stays measurable.
    sideRows.push(
      ['吃子得分 capture income', String(w.captureIncome), String(b.captureIncome)],
      ['吃子得分 capture/ply', rate(w.capturePerPly), rate(b.capturePerPly)],
    )
  }
  sideRows.push(
    // ② alone — see `meanSquaresHeld`. The label is a square count and stays one.
    ['平均佔格 mean squares/結算', rate(w.meanSquaresHeld), rate(b.meanSquaresHeld)],
    ['最高同時佔格 mean peak', num(w.meanPeakHeld, 2), num(b.meanPeakHeld, 2)],
    ['最高同時佔格 max peak', String(w.maxPeakHeld), String(b.maxPeakHeld)],
    ['平均終局分數 mean score', num(w.meanScore, 2), num(b.meanScore, 2)],
  )
  out.push(...table(['', `White ${w.name}`, `Black ${b.name}`], sideRows))
  out.push('')
  out.push(...wrap(
    'points/ply keeps GAME LENGTH as its denominator (what 分數線 X is checked'
    + ' against); mean squares/結算 is per own 結算 and runs at about twice it,'
    + ' because §7.1 settlement credits only the mover — a side settles on half'
    + ' the plies.',
  ))
  // Only when a §7.3 knob is live. At the shipped defaults both are 0, the ①
  // payment is identically zero, ①+② collapses to ②, and every row above says
  // the same thing either way — so this paragraph does not appear and the report
  // is byte-for-byte what every existing notebook measurement was read off.
  if (capturesLive) {
    out.push('')
    out.push(...wrap(
      `§7.3 吃子得分 IS LIVE (k ${config.captureScoreK}, 有煙無傷 ${config.fizzleBonus}), so the score has`
      + ' TWO sources (§7.1) and the rows above are split accordingly. The 佔格 rows —'
      + ' mean squares/結算, mean peak, max peak — read the ② 佔領計分格 column ALONE'
      + ' (rules/render/record.ts `sideStats` takes them off `income[i].settlement[color]`,'
      + ' not off the ply\'s whole score delta), so they are still counts of squares and'
      + ' still bounded by the number of 結算格 on the board. The two capture income rows'
      + ' are the ① half, and ① is NOT mover-only: 守方勝 pays the defender and 有煙無傷 pays the'
      + ' survivor, both on a ply that side never moved on, which is why ① is pooled per'
      + ' PLY and has no per-own-結算 form. Two consequences for reading the note above:'
      + ' every 得分 row is ①+②, so mean squares/結算 no longer runs at about twice'
      + ' earned/ply; and a k≠0 run is a different economy that pools with nothing'
      + ' measured at the default.',
    ))
  }
  out.push('')
  out.push(`replay this run: --seed ${agg.meta.seed} --games ${agg.games} --max-plies ${agg.meta.maxPlies}`)

  return out.join('\n')
}
