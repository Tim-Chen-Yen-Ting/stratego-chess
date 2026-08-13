/**
 * 棋譜 export — gamebook §10「紀錄給，解算不給」.
 *
 * The scripted game below is played through the real engine and every number in
 * `gameStats` is then checked against a hand computation written out in the
 * comment beside it. It is built to hit every counter at least once: all four
 * CombatOutcome kinds, a 有煙無傷 fizzle, and a zero-income run on BOTH sides.
 *
 * 同歸於盡 is reached three different ways on purpose — an equal 兵種 (ply 3), a
 * 爆裂物 against an ordinary piece (ply 9), and 爆裂物 against 爆裂物 (ply 11) —
 * because the record's job is now to make those three indistinguishable. Three
 * separate engine paths, one announcement, one line of text.
 *
 * Board (fixture A). No 軍旗 is deployed, so 奪旗 cannot fire and the script
 * runs to its end; the game is then ended by 認輸.
 *
 *     8  a8 BA 團長  b8 BB 旅長  c8 BC 司令  d8 BD 團長   f8 BF 爆裂物  g8 BG 爆裂物  h8 BH 工兵
 *     1  a1 WA 司令  b1 WB 旅長  c1 WC 排長  e2 WP 連長   f1 WF 營長    g1 WG 爆裂物  h1 WH 爆裂物
 */

import { describe, expect, it } from 'vitest'
import { ALL_RANKS, RANK_NAMES_ZH } from '../src/constants.js'
import { applyMove, resign } from '../src/game.js'
import { entitledToRank, stateForViewer } from '../src/redact.js'
import {
  exportJson,
  exportMarkdown,
  gameStats,
  type GameStats,
  type RecordJson,
} from '../src/render/record.js'
import { createGame, submitAssignment } from '../src/setup.js'
import { decodeSetupCode } from '../src/setupcode.js'
import type { Color, GameState, Move, Rank, Result, Viewer, ViewerState } from '../src/types.js'
import { PASS, mv, position, sq } from './helpers.js'

/**
 * Rotate the 兵種 of every piece this viewer may NOT see, giving a different but
 * equally legal world (the §2 multiset is preserved) that the viewer has no way
 * to rule out. Anything in an export that moves when this is applied is carrying
 * information about a hidden rank.
 *
 * `test/redaction.property.ts` owns the general version of this primitive, but
 * that module registers its whole suite at import time — importing it here would
 * run the 遮蔽層 corpus a second time — so the export suite keeps its own.
 */
function permuteHiddenRanks(s: GameState, v: Viewer): { state: GameState; changed: boolean } {
  const hidden = s.pieces.flatMap((p, i) => (entitledToRank(s, v, p) ? [] : [i]))
  const ranks = hidden.map((i) => s.pieces[i]!.rank)
  const rotated = ranks.length > 1 ? [...ranks.slice(1), ranks[0]!] : ranks
  const next = new Map<number, Rank>(hidden.map((pieceIndex, k) => [pieceIndex, rotated[k]!]))

  let changed = false
  const pieces = s.pieces.map((p, i) => {
    const r = next.get(i)
    if (r === undefined || r === p.rank) return { ...p }
    changed = true
    return { ...p, rank: r }
  })
  return { state: { ...s, pieces }, changed }
}

/** The one figure that is not derivable from the log, blanked for comparison. */
function withoutTrueBombCount(g: GameStats): GameStats {
  const blank = (c: Color) => ({
    ...g.sides[c],
    bombsLost: { ...g.sides[c].bombsLost, actual: null },
  })
  return { ...g, sides: { white: blank('white'), black: blank('black') } }
}

// ---------------------------------------------------------------------------
// Fixture A — the scripted game
// ---------------------------------------------------------------------------

function scriptedStart(): GameState {
  return position(
    [
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'WA' },
      { at: 'b1', color: 'white', carrier: 'rook', rank: 'brigade', id: 'WB' },
      { at: 'c1', color: 'white', carrier: 'rook', rank: 'platoon', id: 'WC' },
      { at: 'e2', color: 'white', carrier: 'pawn', rank: 'company', id: 'WP' },
      { at: 'f1', color: 'white', carrier: 'rook', rank: 'battalion', id: 'WF' },
      { at: 'g1', color: 'white', carrier: 'rook', rank: 'bomb', id: 'WG' },
      { at: 'h1', color: 'white', carrier: 'rook', rank: 'bomb', id: 'WH' },

      { at: 'a8', color: 'black', carrier: 'rook', rank: 'regiment', id: 'BA' },
      { at: 'b8', color: 'black', carrier: 'rook', rank: 'brigade', id: 'BB' },
      { at: 'c8', color: 'black', carrier: 'rook', rank: 'commander', id: 'BC' },
      { at: 'd8', color: 'black', carrier: 'rook', rank: 'regiment', id: 'BD' },
      { at: 'f8', color: 'black', carrier: 'rook', rank: 'bomb', id: 'BF' },
      { at: 'g8', color: 'black', carrier: 'rook', rank: 'bomb', id: 'BG' },
      { at: 'h8', color: 'black', carrier: 'rook', rank: 'engineer', id: 'BH' },
    ],
    { id: 'rec-a', toMove: 'white' },
  )
}

/**
 * Ply by ply. Odd plies are white's.
 *
 *   1  W a1a8  司令 beats 團長                       → attacker-wins
 *   2  B d8d5  black rook takes a scoring square
 *   3  W b1b8  旅長 vs 旅長                          → mutual-destruction
 *   4  B pass
 *   5  W c1c8  排長 throws itself at 司令             → defender-wins
 *   6  B pass
 *   7  W e2e4  white pawn takes a scoring square
 *   8  B d5d7  black rook leaves the centre
 *   9  W f1f8  營長 walks into a 爆裂物               → mutual-destruction
 *  10  B pass
 *  11  W g1g8  爆裂物 vs 爆裂物                       → mutual-destruction
 *  12  B pass
 *  13  W h1h8  爆裂物 vs 工兵                         → fizzle (white's bomb lost)
 *  14  B pass
 */
const SCRIPT: Move[] = [
  mv('a1', 'a8'),
  mv('d8', 'd5'),
  mv('b1', 'b8'),
  PASS,
  mv('c1', 'c8'),
  PASS,
  mv('e2', 'e4'),
  mv('d5', 'd7'),
  mv('f1', 'f8'),
  PASS,
  mv('g1', 'g8'),
  PASS,
  mv('h1', 'h8'),
  PASS,
]

function playScript(): GameState {
  let s = scriptedStart()
  for (const move of SCRIPT) s = applyMove(s, move)
  return s
}

/** After ply 14, still `playing`. */
const MID = playScript()
/** Black resigns on ply 15 — 認輸, White wins. */
const DONE = resign(MID, 'black')

const asBlackMid: ViewerState = stateForViewer(MID, { kind: 'player', color: 'black' })
const asBlackDone: ViewerState = stateForViewer(DONE, { kind: 'player', color: 'black' })

describe('the scripted game runs as the fixture claims', () => {
  it('played 14 plies and is only over after the resignation', () => {
    expect(MID.log).toHaveLength(14)
    expect(MID.status).toEqual({ kind: 'playing' })
    expect(DONE.status).toEqual({ kind: 'over', result: { kind: 'resign', winner: 'white' } })
  })

  it('ends 4 – 3.5: each side banks only on its own plies (§7)', () => {
    // 結算 runs after every ply but credits the MOVER alone. White's pawn stands
    // on e4 from ply 7, so White is paid at its own settlements on plies 7, 9,
    // 11 and 13 = 4. Black holds d5 from ply 2 and leaves it on ply 8, so it is
    // paid on plies 2, 4 and 6 = 3, plus 0.5 貼目.
    expect(DONE.score).toEqual({ white: 4, black: 3.5 })
  })
})

// ---------------------------------------------------------------------------
// gameStats — hand-computed
// ---------------------------------------------------------------------------

describe('gameStats over the public log', () => {
  const stats = gameStats(asBlackDone)

  it('counts 14 plies and 6 contacts, one of every announced kind', () => {
    // Four kinds now, not six. Plies 3, 9 and 11 are three different resolutions
    // in the engine — equal 兵種, 爆裂物 vs ordinary, 爆裂物 vs 爆裂物 — and one
    // single announcement out here.
    expect(stats.pliesPlayed).toBe(14)
    expect(stats.contacts).toBe(6)
    expect(stats.contactsByOutcome).toEqual({
      'attacker-wins': 1,
      'defender-wins': 1,
      'mutual-destruction': 3,
      fizzle: 1,
    })
  })

  it('reports 同歸於盡 over all contacts, and does NOT claim to be the tie rate', () => {
    // The old `tiesPerContest` was 同階雙亡 over 階級對決, the figure notebook
    // §4.1 checks against ~18%. Both of its terms are gone: the rank ties are
    // inside 同歸於盡 with the two bomb cases and cannot be lifted out, and the
    // bomb contacts can no longer be excluded from the denominator. What is left
    // is a different measurement under a different name — 3 of 6 here, where the
    // old figure would have been 1 of 3.
    expect(stats.mutualDestruction).toEqual({ mutual: 3, contests: 6, ratio: 0.5 })
    expect(stats).not.toHaveProperty('tiesPerContest')
  })

  it('white: 4 points over its 7 settlements, an opening drought, 1 KNOWN bomb', () => {
    // White is settled on plies 1, 3, 5, 7, 9, 11, 13 and on no others. It holds
    // nothing until the pawn reaches e4 on ply 7, so that series is
    // [0,0,0,1,1,1,1]: 3 zero settlements running from ply 1 to ply 5 — five
    // plies apart, three settlements long — then one square every time after.
    // The peak is ONE square, first held at the settlement of ply 7.
    // White's seven moves are seven different pieces —
    //   1 a1a8 · 3 b1b8 · 5 c1c8 · 7 e2e4 · 9 f1f8 · 11 g1g8 · 13 h1h8
    // — so distinct = 7 and no piece ever moves twice in a row: runs of 1, and
    // the first of them starts on ply 1. Of those seven destinations only e4 is
    // a 結算格 (d4 e4 d5 e5), so 1 of 7.
    // Bombs: White spent both — g1 on ply 11 and h1 on ply 13 — but only ply 13
    // is KNOWN, because that one fizzled. Ply 11 announced 同歸於盡 and nothing
    // else. The true 2 comes from the piece list at 終局, not from the log.
    expect(stats.sides.white).toEqual({
      color: 'white',
      score: 4,
      earned: 4,
      settlements: 7,
      pointsPerPly: 4 / 14,
      earnedPerPly: 4 / 14,
      earnedPerSettlement: 4 / 7,
      peakSquaresHeld: { count: 1, ply: 7 },
      zeroSettlements: 3,
      longestZeroRun: { length: 3, startPly: 1, endPly: 5 },
      objectiveMoves: { count: 1, total: 7, ratio: 1 / 7 },
      distinctPiecesMoved: 7,
      longestSinglePieceRun: { length: 1, startPly: 1 },
      bombsLost: { known: 1, knownPlies: [13], actual: 2 },
    })
    expect(stats.sides.white.earnedPerSettlement).toBeCloseTo(0.5714, 4)
    expect(stats.sides.white.objectiveMoves.ratio).toBeCloseTo(0.1429, 4)
  })

  it('black: 3 earned + 0.5 貼目, a drought after leaving d5, and NO known bomb', () => {
    // Black is settled on plies 2, 4, 6, 8, 10, 12, 14. It holds d5 for the
    // first three = 3 points, then nothing at all: [1,1,1,0,0,0,0], a run of 4
    // zero settlements spanning plies 8 to 14.
    // Black plays exactly TWO moves in fourteen plies — 2 d8d5 and 8 d5d7, the
    // same rook both times, and the five passes in between are not moves. So
    // total = 2 (not 7), distinct = 1, and the run is 2 long from ply 2. d5 is
    // a 結算格 and d7 is not: 1 of 2.
    // Black lost both 爆裂物 (f8 on ply 9, g8 on ply 11) and the log proves
    // NEITHER: both announced 同歸於盡. `known` is 0 while `actual` is 2 — the
    // whole point of keeping the two numbers apart.
    expect(stats.sides.black).toEqual({
      color: 'black',
      score: 3.5,
      earned: 3,
      settlements: 7,
      pointsPerPly: 3.5 / 14,
      earnedPerPly: 3 / 14,
      earnedPerSettlement: 3 / 7,
      peakSquaresHeld: { count: 1, ply: 2 },
      zeroSettlements: 4,
      longestZeroRun: { length: 4, startPly: 8, endPly: 14 },
      objectiveMoves: { count: 1, total: 2, ratio: 0.5 },
      distinctPiecesMoved: 1,
      longestSinglePieceRun: { length: 2, startPly: 2 },
      bombsLost: { known: 0, knownPlies: [], actual: 2 },
    })
    // 貼目 is in the score but is not a scoring square: the two rates differ.
    expect(stats.sides.black.pointsPerPly).toBeCloseTo(0.25, 4)
    expect(stats.sides.black.earnedPerPly).toBeCloseTo(0.2143, 4)
  })

  it('a side is never credited on the opponent’s ply (§7 mover-only 結算)', () => {
    // The structural fact every counter above is built on. Differencing the
    // public `scoreAfter` column, exactly one side moves on any ply, and it is
    // always the side that just played.
    const json = exportJson(asBlackDone) as RecordJson
    expect(json.moves.map((m) => m.income.white)).toEqual(
      [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    )
    expect(json.moves.map((m) => m.income.black)).toEqual(
      [0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    )
    for (const m of json.moves) {
      const idle = m.color === 'white' ? m.income.black : m.income.white
      expect(idle, `ply ${m.ply} credited the side that did not move`).toBe(0)
    }
    // …so both sides settle the same number of times over a full-turn game
    expect(stats.sides.white.settlements).toBe(7)
    expect(stats.sides.black.settlements).toBe(7)
    expect(stats.sides.white.settlements + stats.sides.black.settlements)
      .toBe(stats.pliesPlayed)
  })

  it('counts a PASS as an action, never as a move (§3④)', () => {
    // Black is on the board for 14 plies and answers 7 of them; 5 of those 7
    // are passes. The denominator of `objectiveMoves` is the other 2 — putting
    // passes in it would report Black landing on the objective 1 time in 7
    // rather than 1 in 2, which is a statement about a side that never moved.
    const blackPlies = asBlackDone.log.filter((e) => e.color === 'black')
    expect(blackPlies).toHaveLength(7)
    expect(blackPlies.filter((e) => e.move.kind === 'pass')).toHaveLength(5)
    expect(stats.sides.black.objectiveMoves.total).toBe(2)
    // A pass still SETTLES, though — the passer is the mover — so it is one of
    // Black's seven settlements even while it is none of its two moves.
    expect(stats.sides.black.settlements).toBe(7)
    // and the five passes sit BETWEEN Black's two moves without breaking the
    // one-piece run: a pass moves nobody, so there is nobody else to break it
    expect(stats.sides.black.longestSinglePieceRun).toEqual({ length: 2, startPly: 2 })
  })

  it('is identical from every viewer at 終局 — the numbers are public by construction', () => {
    const asWhite = stateForViewer(DONE, { kind: 'player', color: 'white' })
    const asOmniscient = stateForViewer(DONE, { kind: 'omniscient' })
    const asPublic = stateForViewer(DONE, { kind: 'spectator-public' })
    expect(gameStats(asWhite)).toEqual(stats)
    expect(gameStats(asOmniscient)).toEqual(stats)
    expect(gameStats(asPublic)).toEqual(stats)
  })

  it('and mid-game it differs in exactly one field: the true 爆裂物 count', () => {
    // Everything else is read off the log, which is complete at ply 14 and does
    // not change when Black resigns. The one figure that is NOT in the log is
    // how many 爆裂物 each side really spent, and it stays null until 終局 opens
    // the 兵種 (§10.5) — for every viewer, including the one whose bombs they are.
    const live = gameStats(asBlackMid)
    expect(withoutTrueBombCount(live)).toEqual(withoutTrueBombCount(stats))
    expect(live.sides.white.bombsLost.actual).toBeNull()
    expect(live.sides.black.bombsLost.actual).toBeNull()
    expect(stats.sides.white.bombsLost.actual).toBe(2)
    expect(stats.sides.black.bombsLost.actual).toBe(2)
    // …and while it is live, every seat agrees, including Black about its own
    expect(gameStats(stateForViewer(MID, { kind: 'player', color: 'white' }))).toEqual(live)
    expect(gameStats(stateForViewer(MID, { kind: 'omniscient' }))).toEqual(live)
  })

  it('the log cannot see a 爆裂物 that worked — only one that fizzled', () => {
    // Four bombs were spent in this game. Three of them (BF ply 9, BG and WG
    // ply 11) announced 同歸於盡, which carries nothing; only WH, which fizzled
    // against the 工兵 on ply 13, is in the record as a bomb at all.
    expect(stats.contactsByOutcome['mutual-destruction']).toBe(3)
    expect(stats.sides.white.bombsLost.known + stats.sides.black.bombsLost.known).toBe(1)
    expect(stats.sides.white.bombsLost.actual! + stats.sides.black.bombsLost.actual!).toBe(4)
    // the three 同歸於盡 events carry no field at all beyond the discriminator
    for (const e of asBlackDone.log) {
      if (e.combat?.outcome.kind !== 'mutual-destruction') continue
      expect(e.combat.outcome).toEqual({ kind: 'mutual-destruction' })
      expect(Object.keys(e.combat.outcome)).toEqual(['kind'])
    }
  })

  it('survives a game with no plies at all', () => {
    const fresh = stateForViewer(createGame('empty'), { kind: 'player', color: 'white' })
    const s = gameStats(fresh)
    expect(s.pliesPlayed).toBe(0)
    expect(s.mutualDestruction).toEqual({ mutual: 0, contests: 0, ratio: null })
    expect(s.sides.white.pointsPerPly).toBe(0)
    expect(s.sides.white.earnedPerPly).toBe(0)
    expect(s.sides.white.earnedPerSettlement).toBe(0)
    expect(s.sides.white.settlements).toBe(0)
    // nothing happened, so every "when" is null rather than a fabricated ply 0
    expect(s.sides.black.longestZeroRun).toEqual({ length: 0, startPly: null, endPly: null })
    expect(s.sides.white.peakSquaresHeld).toEqual({ count: 0, ply: null })
    expect(s.sides.black.peakSquaresHeld).toEqual({ count: 0, ply: null })
    expect(s.sides.white.objectiveMoves).toEqual({ count: 0, total: 0, ratio: null })
    expect(s.sides.black.distinctPiecesMoved).toBe(0)
    expect(s.sides.black.longestSinglePieceRun).toEqual({ length: 0, startPly: null })
    // not started, so the true bomb count is not derivable either
    expect(s.sides.white.bombsLost).toEqual({ known: 0, knownPlies: [], actual: null })
  })

  it('keeps the two scoring rates apart, because they are two measurements', () => {
    // They used to be one under two names: when both sides settled every ply, a
    // piece on a 結算格 scored a point per ply, so "squares held" and "points per
    // ply" differed only by 貼目/plies and the table printed the same fact twice.
    // Mover-only settlement separates them by a factor of two — a side settles on
    // half the plies — so both are carried and neither is a synonym.
    expect(stats.sides.white).not.toHaveProperty('scoringSquaresPerPly')
    expect(stats.sides.white.earnedPerPly).toBe(stats.sides.white.pointsPerPly)
    expect(stats.sides.white.earnedPerSettlement).toBe(2 * stats.sides.white.earnedPerPly)
    expect(stats.sides.black.earnedPerSettlement).toBe(2 * stats.sides.black.earnedPerPly)
    expect(stats.sides.black.pointsPerPly - stats.sides.black.earnedPerPly)
      .toBeCloseTo(asBlackDone.config.komi / 14, 12)
  })
})

// ---------------------------------------------------------------------------
// Fixture B — the peak
//
// Fixture A never lets either side hold two 結算格 at once, which is exactly the
// case the headline number exists for (notebook §3.3b: White reached six of
// eight simultaneously and it had to be hand-derived from the score column).
// This one builds the peak on purpose, reaches it TWICE, and gives Black a side
// that scores nothing and moves nothing at all.
//
//     1  a1 —          d1 WD rook   e1 WE rook
//     8  a8 BA rook
//
// No 軍旗 anywhere and no contact ever, so nothing ends the game early.
// ---------------------------------------------------------------------------

function peakStart(): GameState {
  return position(
    [
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'brigade', id: 'WD' },
      { at: 'e1', color: 'white', carrier: 'rook', rank: 'regiment', id: 'WE' },
      { at: 'a8', color: 'black', carrier: 'rook', rank: 'battalion', id: 'BA' },
    ],
    { id: 'rec-peak', toMove: 'white' },
  )
}

/**
 *   1  W d1d3   off the 結算格 — income 0
 *   2  B pass
 *   3  W d3d4   holds d4               → +1
 *   4  B pass
 *   5  W d4d5   holds d5               → +1
 *   6  B pass
 *   7  W e1e4   holds d5 AND e4        → +2   ← the peak, first reached here
 *   8  B pass
 *   9  W d5d4   holds d4 AND e4        → +2   ← the peak again; ply 7 stands
 *  10  B pass
 */
const PEAK_SCRIPT: Move[] = [
  mv('d1', 'd3'), PASS,
  mv('d3', 'd4'), PASS,
  mv('d4', 'd5'), PASS,
  mv('e1', 'e4'), PASS,
  mv('d5', 'd4'), PASS,
]

const PEAK: ViewerState = stateForViewer(
  PEAK_SCRIPT.reduce(applyMove, peakStart()),
  { kind: 'omniscient' },
)

describe('peakSquaresHeld — the most squares held at once', () => {
  const stats = gameStats(PEAK)

  it('the fixture scores what the script says: White [0,1,1,2,2], Black nothing', () => {
    expect(stats.pliesPlayed).toBe(10)
    const json = exportJson(PEAK) as RecordJson
    // interleaved with Black's passes, which credit Black and never White
    expect(json.moves.map((m) => m.income.white)).toEqual([0, 0, 1, 0, 1, 0, 2, 0, 2, 0])
    expect(json.moves.map((m) => m.income.black)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(PEAK.score).toEqual({ white: 6, black: 0.5 })
  })

  it('white peaked at TWO on ply 7 — the first ply at the peak, not the last', () => {
    // The maximum of White's settlement series is 2, reached at the settlements
    // of plies 7 and 9. The record keeps the ply the peak was first reached, the
    // same tie-break `longestZeroRun` uses, because "when did it get there" is
    // the question and the last ply at the peak answers nothing.
    expect(stats.sides.white.peakSquaresHeld).toEqual({ count: 2, ply: 7 })
    // and it is genuinely more than the mean of the same series, 6/5
    expect(stats.sides.white.earnedPerSettlement).toBe(1.2)
    // while the per-PLY rate is half of that, because White settles on half the
    // plies. Same points, two denominators, and only one of them is the series.
    expect(stats.sides.white.earnedPerPly).toBe(0.6)
  })

  it('a side that never scores gets a peak of zero and no ply', () => {
    // Black stands on a8 for the whole game. There is no ply to point at, so
    // the field is null — never 0, which would read as "peaked on ply 0".
    expect(stats.sides.black.peakSquaresHeld).toEqual({ count: 0, ply: null })
    expect(stats.sides.black.earned).toBe(0)
    // five settlements of its own, all empty — not ten, which would be counting
    // White's plies as Black's droughts
    expect(stats.sides.black.settlements).toBe(5)
    expect(stats.sides.black.zeroSettlements).toBe(5)
    expect(stats.sides.black.longestZeroRun).toEqual({ length: 5, startPly: 2, endPly: 10 })
    expect(exportMarkdown(PEAK)).toContain(
      '| Peak scoring squares held at once | 2 (first on ply 7) | 0 — never held one |',
    )
    expect(exportMarkdown(PEAK)).toContain('| Own 結算 scoring zero | 1 of 5 | 5 of 5 |')
  })

  it('a zero run is spanned by its plies, not by its length', () => {
    // Black's five zero settlements are plies 2, 4, 6, 8, 10 — a run of 5 that
    // spans NINE plies. Deriving the end as start + length - 1 would print
    // "plies 2–6" and quietly halve the drought.
    const md = exportMarkdown(PEAK)
    expect(md).toContain('| Longest zero-income run (own 結算) | 1 (plies 1–1) | 5 (plies 2–10) |')
  })

  it('a side that only ever passes moved no pieces at all', () => {
    // Ten plies, five of them Black's, every one a pass. `total` is 0, so the
    // ratio is null rather than 0/0, and there is no run to start.
    expect(PEAK.log.filter((e) => e.color === 'black').every((e) => e.move.kind === 'pass'))
      .toBe(true)
    expect(stats.sides.black.objectiveMoves).toEqual({ count: 0, total: 0, ratio: null })
    expect(stats.sides.black.distinctPiecesMoved).toBe(0)
    expect(stats.sides.black.longestSinglePieceRun).toEqual({ length: 0, startPly: null })
    expect(exportMarkdown(PEAK)).toContain(
      '| Moves ending on a scoring square | 4 of 5 (0.8) | — (no moves) |',
    )
  })

  it('white: 5 moves by 2 pieces, one of them three plies in a row', () => {
    // Moves: 1 d1d3, 3 d3d4, 5 d4d5 — all the d1 rook — then 7 e1e4 with the
    // other one, then 9 d5d4 with the first again. Two distinct pieces; the
    // longest same-piece run is the opening three, from ply 1. The later return
    // to the d-rook is a run of 1 and does not extend the earlier one.
    // Destinations d4, d5, e4, d4 are 結算格 and d3 is not: 4 of 5.
    expect(stats.sides.white.distinctPiecesMoved).toBe(2)
    expect(stats.sides.white.longestSinglePieceRun).toEqual({ length: 3, startPly: 1 })
    expect(stats.sides.white.objectiveMoves).toEqual({ count: 4, total: 5, ratio: 0.8 })
  })
})

// ---------------------------------------------------------------------------
// Fixture D — a piece keeps its identity through a contact
//
// The log carries squares, not piece ids, so "which piece moved" is replayed
// off the public carrier layer. The replay has to follow a piece THROUGH a
// contact in both directions — a winning attacker takes the target square, a
// winning defender stays on its own (§4 位置結算) — or a survivor that moves
// again looks like a brand new piece and both piece counters inflate.
//
//     8  b8 BB rook 師長  c8 BC rook 營長  h8 BH rook 司令
//     4  a4 BA rook 工兵
//     1  a1 WA rook 司令  h1 WH rook 排長
//
// b8 and c8 never move and never fight. They are here so that White's view has
// more than one 兵種 left to permute in the last test of the block.
// ---------------------------------------------------------------------------

function survivorStart(): GameState {
  return position(
    [
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'WA' },
      { at: 'h1', color: 'white', carrier: 'rook', rank: 'platoon', id: 'WH' },
      { at: 'a4', color: 'black', carrier: 'rook', rank: 'engineer', id: 'BA' },
      { at: 'b8', color: 'black', carrier: 'rook', rank: 'division', id: 'BB' },
      { at: 'c8', color: 'black', carrier: 'rook', rank: 'battalion', id: 'BC' },
      { at: 'h8', color: 'black', carrier: 'rook', rank: 'commander', id: 'BH' },
    ],
    { id: 'rec-survivor', toMove: 'white' },
  )
}

const SURVIVOR_SCRIPT: Move[] = [
  mv('a1', 'a4'),   // 1  司令 beats 工兵 — the white rook takes a4
  mv('h8', 'h4'),   // 2  the black rook comes down
  mv('a4', 'd4'),   // 3  the SAME white rook goes on to d4, a 結算格
  PASS,             // 4
  mv('h1', 'h4'),   // 5  排長 throws itself at 司令 — white is removed from h1
  mv('h4', 'h5'),   // 6  the SAME black rook, which never left h4, moves on
]

const SURVIVOR_RAW: GameState = SURVIVOR_SCRIPT.reduce(applyMove, survivorStart())
const SURVIVOR: ViewerState = stateForViewer(SURVIVOR_RAW, { kind: 'omniscient' })

describe('a survivor is still the same piece', () => {
  const stats = gameStats(SURVIVOR)

  it('the fixture is the two contacts it claims to be', () => {
    expect(stats.contactsByOutcome['attacker-wins']).toBe(1)
    expect(stats.contactsByOutcome['defender-wins']).toBe(1)
    // White's rook reaches d4 on ply 3 and is paid at its own settlements on
    // plies 3 and 5 — losing the h1 rook on ply 5 costs it nothing on d4.
    expect(SURVIVOR.score).toEqual({ white: 2, black: 0.5 })
  })

  it('a winning ATTACKER that moves on again is not counted twice', () => {
    // White plays a1a4, a4d4, h1h4. The first two are one rook that captured
    // its way to a4 and carried on; the third is the other one. Two pieces, and
    // the first of them moved twice running from ply 1. Only d4 is a 結算格.
    expect(stats.sides.white.distinctPiecesMoved).toBe(2)
    expect(stats.sides.white.longestSinglePieceRun).toEqual({ length: 2, startPly: 1 })
    expect(stats.sides.white.objectiveMoves).toEqual({ count: 1, total: 3, ratio: 1 / 3 })
  })

  it('a winning DEFENDER that moves on again is not counted twice either', () => {
    // Black plays h8h4 and, after standing its ground on ply 5, h4h5. One rook,
    // moving twice — the pass on ply 4 is not a move and does not split them.
    // Neither square is a 結算格, so the ratio is a real 0, not null.
    expect(stats.sides.black.distinctPiecesMoved).toBe(1)
    expect(stats.sides.black.longestSinglePieceRun).toEqual({ length: 2, startPly: 2 })
    expect(stats.sides.black.objectiveMoves).toEqual({ count: 0, total: 2, ratio: 0 })
  })

  it('and none of it moves when the hidden 兵種 are permuted', () => {
    // The replay reads squares, `outcome.kind` and the announced colours — all
    // public. Nothing it produces may vary with a rank a player cannot see.
    const viewer: Viewer = { kind: 'player', color: 'white' }
    const alt = permuteHiddenRanks(SURVIVOR_RAW, viewer)
    expect(alt.changed).toBe(true)
    expect(gameStats(stateForViewer(alt.state, viewer)))
      .toEqual(gameStats(stateForViewer(SURVIVOR_RAW, viewer)))
    expect(exportMarkdown(stateForViewer(alt.state, viewer)))
      .toBe(exportMarkdown(stateForViewer(SURVIVOR_RAW, viewer)))
  })
})

// ---------------------------------------------------------------------------
// Fixture C — 王車易位
//
// Castling relocates two carriers on one move, so it has to be decided which
// square and which piece it counts as. §3② calls it the king's move, so both
// answers come from the king. The two games below differ ONLY in which of the
// two landing squares is a 結算格, which is what makes the choice testable.
// ---------------------------------------------------------------------------

function castleGame(scoring: string[]): ViewerState {
  const start = position(
    [
      { at: 'e1', color: 'white', carrier: 'king', rank: 'brigade', id: 'WK' },
      { at: 'h1', color: 'white', carrier: 'rook', rank: 'regiment', id: 'WR' },
      { at: 'a8', color: 'black', carrier: 'rook', rank: 'battalion', id: 'BA' },
    ],
    { id: 'rec-castle', toMove: 'white', config: { scoringSquares: scoring.map(sq) } },
  )
  // 1 W O-O (king e1→g1, rook h1→f1) · 2 B pass
  const played = [{ kind: 'castle', side: 'king' } as Move, PASS].reduce(applyMove, start)
  return stateForViewer(played, { kind: 'omniscient' })
}

describe('王車易位 counts once, by the king (§3②)', () => {
  it('lands on a 結算格 when the KING does', () => {
    // g1 is the king's destination and the only 結算格 in this game. One move,
    // and it ended on the objective: 1 of 1.
    const stats = gameStats(castleGame(['g1']))
    expect(stats.sides.white.objectiveMoves).toEqual({ count: 1, total: 1, ratio: 1 })
    // it scored, so the peak sees it too — one square, from ply 1
    expect(stats.sides.white.peakSquaresHeld).toEqual({ count: 1, ply: 1 })
    // +1 at White's own settlement on ply 1, and nothing on Black's ply 2
    expect(stats.sides.white.score).toBe(1)
  })

  it('does NOT land on one when only the ROOK does', () => {
    // Same castle, but now f1 — where the rook lands — is the 結算格 and g1 is
    // not. White still scores +1 off the rook, so the move plainly reached the
    // objective in points; it is still not an objective MOVE, because the move
    // is the king's and the king landed on g1.
    const stats = gameStats(castleGame(['f1']))
    expect(stats.sides.white.objectiveMoves).toEqual({ count: 0, total: 1, ratio: 0 })
    expect(stats.sides.white.peakSquaresHeld).toEqual({ count: 1, ply: 1 })
    expect(stats.sides.white.score).toBe(1)
  })

  it('is ONE mover, not two — the rook rides along', () => {
    const stats = gameStats(castleGame(['g1']))
    expect(stats.sides.white.distinctPiecesMoved).toBe(1)
    expect(stats.sides.white.longestSinglePieceRun).toEqual({ length: 1, startPly: 1 })
    // and the log really did move both carriers
    const done = castleGame(['g1'])
    expect(done.pieces.find((p) => p.id === 'WK')!.square).toBe(sq('g1'))
    expect(done.pieces.find((p) => p.id === 'WR')!.square).toBe(sq('f1'))
    expect(done.log[0]!.move).toEqual({ kind: 'castle', side: 'king' })
  })
})

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** The announced-outcome column of one logged ply. */
function outcomeCell(md: string, ply: number): string {
  const row = md.split('\n').find((l) => l.startsWith(`| ${ply} | `))
  expect(row, `no log row for ply ${ply}`).toBeDefined()
  return row!.split('|')[4]!.trim()
}

describe('exportMarkdown — the thing you paste into a chat', () => {
  const md = exportMarkdown(asBlackDone)

  it('names the win condition, not just the score', () => {
    expect(md).toContain('**White wins** — 認輸')
    expect(md).toContain('Final score: White 4 – Black 3.5.')
    expect(md).toContain('Won on 認輸; White also led on points.')
  })

  it('prints the config that produced the game, scoring squares BY NAME', () => {
    expect(md).toContain('- 分數線 X (score target): 40')
    expect(md).toContain('- 停滯 N (no-progress full turns): 30')
    expect(md).toContain('- 貼目 komi: 0.5, credited to Black before ply 1')
    expect(md).toContain('- Scoring squares (結算格): d4 e4 d5 e5 (4)')
    expect(md).toContain('- Clock (讀秒): 15:00 + 0:10 per move · setup limit 3:00')
    expect(md).toContain('司令×1 · 軍長×1 · 師長×1 · 旅長×2')
    expect(md).toContain('爆裂物×2 — 16 per side')
  })

  it('logs one line per ply: ply, colour, coordinate move, outcome, running score', () => {
    expect(md).toContain('| 1 | W | a1a8 | a8: White wins — 翻明 司令(1)')
    expect(md).toContain('| 2 | B | d8d5 | — | 0 – 1.5 |')
    expect(md).toContain('| 3 | W | b1b8 | b8: 同歸於盡 — both removed, nobody is 翻明')
    expect(md).toContain('| 4 | B | pass | — | 0 – 2.5 |')
    expect(md).toContain('| 5 | W | c1c8 | c8: Black holds — 翻明 司令(1)')
    expect(md).toContain('| 9 | W | f1f8 | f8: 同歸於盡 — both removed, nobody is 翻明')
    expect(md).toContain('| 11 | W | g1g8 | g8: 同歸於盡 — both removed, nobody is 翻明')
    expect(md).toContain('| 13 | W | h1h8 | h8: 有煙無傷 — White\'s 爆裂物 is lost')
    expect(md).toContain('| 14 | B | pass | — | 4 – 3.5 |')
    // one row per ply, plus header and separator
    const rows = md.split('\n').filter((l) => /^\| \d+ \| [WB] \|/.test(l))
    expect(rows).toHaveLength(14)
  })

  it('reads the three 同歸於盡 contacts as ONE announcement, word for word', () => {
    // Ply 3 was an equal 兵種, ply 9 a 爆裂物 taking an ordinary piece, ply 11 a
    // 爆裂物 against a 爆裂物. Three engine paths; strip the square each happened
    // on and the record must not distinguish them by a single character.
    const said = [3, 9, 11].map((ply) => outcomeCell(md, ply).replace(/^[a-h][1-8]: /, ''))
    expect(new Set(said).size).toBe(1)
    // …and it says outright that it is ambiguous, rather than staying quiet and
    // letting a reader take it for a rank tie
    expect(said[0]).toContain('同歸於盡')
    expect(said[0]).toContain('cannot say which')
    // the tied 階級 is gone from the line: it used to print "both 旅長(4)"
    for (const rank of ALL_RANKS) {
      if (rank === 'bomb') continue
      expect(said[0], `${rank} named on a 同歸於盡`).not.toContain(RANK_NAMES_ZH[rank])
    }
  })

  it('never offers the 有煙無傷 deduction — that is 解算, not 紀錄', () => {
    // §10's solver table says the survivor of a fizzle is「工兵 或 軍旗」. That
    // is the reader's job. The record states the announcement and stops.
    expect(md).toContain('nobody is 翻明')
    expect(md).not.toContain('工兵 or 軍旗')
    expect(md).not.toContain('工兵 或 軍旗')
  })

  it('carries the stats block, 同歸於盡 as a raw fraction with a warning', () => {
    expect(md).toContain('14 plies · 6 contacts.')
    expect(md).toContain('**同歸於盡 3/6 全部接觸** (0.5)')
    expect(md).toContain('| 同歸於盡 mutual-destruction | 3 |')
    // the old fraction and the expectation it was quoted against are both named,
    // so nobody reads this number as that one
    expect(md).toContain('NOT the 同階雙亡/階級對決 tie rate')
    expect(md).toContain('~18%')
    expect(md).toContain('| Own 結算 scoring zero | 3 of 7 | 4 of 7 |')
    expect(md).toContain('| Longest zero-income run (own 結算) | 3 (plies 1–5) | 4 (plies 8–14) |')
  })

  it('labels the two 爆裂物 rows so a live figure is never read as a count', () => {
    expect(md).toContain('| 爆裂物 KNOWN lost (有煙無傷 only) | 1 | 0 |')
    expect(md).toContain('| …on plies | 13 | — |')
    expect(md).toContain('| 爆裂物 truly lost (終局 only) | 2 | 2 |')
    expect(md).toContain('a FLOOR,')
    expect(md).toContain('Never read a live figure against a finished one.')

    // and mid-game the true row says so rather than printing a number
    const live = exportMarkdown(asBlackMid)
    expect(live).toContain('| 爆裂物 truly lost (終局 only) | not derivable yet | not derivable yet |')
    expect(live).toContain('| 爆裂物 KNOWN lost (有煙無傷 only) | 1 | 0 |')
  })

  it('puts peak-held next to the two rates, and says which is which', () => {
    // 4/14 = 0.286 and 3.5/14 = 0.25 per PLY; 4/7 = 0.571 and 3/7 = 0.429 per
    // own 結算. The pair is a factor of two apart because each side settles on
    // half the plies — that is the rule, not the play, and the note says so.
    expect(md).toContain('| Points per ply (貼目 included) | 0.286 | 0.25 |')
    expect(md).toContain('| Mean squares held per own 結算 | 0.571 | 0.429 |')
    expect(md).toContain('| Peak scoring squares held at once | 1 (first on ply 7) | 1 (first on ply 2) |')
    expect(md).toContain('credits only the side that just moved')
    expect(md).not.toContain('| Plies scoring zero |')

    const rows = md.split('\n').filter((l) => l.startsWith('| Points per ply'))
    expect(rows).toHaveLength(1)
  })

  it('prints the move counters: objective, distinct pieces, longest one-piece run', () => {
    // White 1 of 7 (only e2e4 landed on a 結算格) = 0.143; Black 1 of 2 (d8d5,
    // not d5d7) = 0.5, its five passes excluded from both denominators.
    expect(md).toContain('| Moves ending on a scoring square | 1 of 7 (0.143) | 1 of 2 (0.5) |')
    expect(md).toContain('| Distinct pieces moved | 7 | 1 |')
    expect(md).toContain('| Longest run on one piece | 1 (from ply 1) | 2 (from ply 2) |')
  })

  it('renders a game that has not started yet without inventing one', () => {
    const setup = exportMarkdown(
      stateForViewer(createGame('fresh'), { kind: 'player', color: 'white' }),
    )
    expect(setup).toContain('Not started — both sides are still assigning 兵種')
    expect(setup).toContain('(no moves yet)')
  })
})

describe('the win condition is always named (§7 勝負條件)', () => {
  /** White is 17.5 points ahead in every one of these. */
  function over(result: Result): ViewerState {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'flag' },
        { at: 'h8', color: 'black', carrier: 'rook', rank: 'flag' },
      ],
      { status: { kind: 'over', result }, score: { white: 30, black: 12.5 }, ply: 21 },
    )
    return stateForViewer(s, { kind: 'omniscient' })
  }

  it.each([
    [{ kind: 'flag', winner: 'white' } as Result, '奪旗'],
    [{ kind: 'score', winner: 'white' } as Result, '分數'],
    [{ kind: 'no-progress', winner: 'white' } as Result, '停滯'],
    [{ kind: 'timeout', winner: 'white' } as Result, '超時'],
    [{ kind: 'resign', winner: 'white' } as Result, '認輸'],
  ])('%o is reported as %s', (result, condition) => {
    expect(exportMarkdown(over(result))).toContain(`**White wins** — ${condition}`)
  })

  it('says so when the winner was BEHIND on points — the score alone hides that', () => {
    const md = exportMarkdown(over({ kind: 'flag', winner: 'black' }))
    expect(md).toContain('**Black wins** — 奪旗')
    expect(md).toContain('Final score: White 30 – Black 12.5.')
    expect(md).toContain('Won on 奪旗 while White led on points by 17.5 — the score alone hides that.')
  })

  it('reports the one draw in the game as a draw', () => {
    const md = exportMarkdown(over({ kind: 'flag-both' }))
    expect(md).toContain('**Draw** — 奪旗')
    expect(md).toContain('White led on points at the end.')
  })
})

// ---------------------------------------------------------------------------
// Promotion suffix — §6, and the reason `Move.promote` is never rendered
// ---------------------------------------------------------------------------

describe('the promotion suffix comes from GameEvent.promoted, never from Move.promote', () => {
  /** White pawn on b7, an enemy on a8, and a queen promotion always requested. */
  function eighthRank(pawnRank: Rank, targetRank: Rank): GameState {
    const s = position(
      [
        { at: 'b7', color: 'white', carrier: 'pawn', rank: pawnRank, id: 'P', hasMoved: true },
        { at: 'a8', color: 'black', carrier: 'knight', rank: targetRank, id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'general', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ],
      { id: 'promo', toMove: 'white' },
    )
    return applyMove(s, mv('b7', 'a8', 'queen'))
  }

  function logRow(s: GameState): string {
    const md = exportMarkdown(stateForViewer(s, { kind: 'omniscient' }))
    const row = md.split('\n').find((l) => l.startsWith('| 1 | W |'))
    expect(row).toBeDefined()
    return row!
  }

  it('a pawn that TIES on the 8th rank did not promote, so no suffix (§6)', () => {
    const s = eighthRank('brigade', 'brigade')
    const e = s.log[0]!
    // The requested promotion is still in the recorded move — that is exactly
    // the trap: rendering it would put a queen on a8 that never existed.
    expect(e.move).toEqual({ kind: 'move', from: 49, to: 56, promote: 'queen' })
    expect(e.promoted).toBeUndefined()

    const row = logRow(s)
    expect(row).toContain('| b7a8 |')
    expect(row).not.toContain('b7a8q')
    expect(row).toContain('同歸於盡')
  })

  it('a pawn that WINS on the 8th rank did promote, so the suffix is there', () => {
    const s = eighthRank('general', 'company')
    expect(s.log[0]!.promoted).toBe('queen')
    expect(logRow(s)).toContain('| b7a8q |')
  })

  it('a 工兵 that beats a 爆裂物 on the 8th rank promotes too (§5), still unrevealed', () => {
    const s = eighthRank('engineer', 'bomb')
    expect(s.log[0]!.promoted).toBe('queen')
    const row = logRow(s)
    expect(row).toContain('| b7a8q |')
    expect(row).toContain('有煙無傷')
  })

  it('the JSON says the same thing', () => {
    const tie = exportJson(
      stateForViewer(eighthRank('brigade', 'brigade'), { kind: 'omniscient' }),
    ) as RecordJson
    expect(tie.moves[0]!.notation).toBe('b7a8')
    expect(tie.moves[0]!.promoted).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Redaction — §10. The export may not emit what the viewer cannot see.
// ---------------------------------------------------------------------------

/**
 * The §2 兵種 table names every rank that exists and attributes none of them to
 * anybody, so it is the one line of the record a rank-name grep has to lift out
 * first. It is deliberately a single line; the assertion below fails if a future
 * edit spreads it over several.
 */
const DISTRIBUTION_PREFIX = '- 兵種 distribution (§2, per side):'

describe('§10 — a mid-game export leaks no 兵種 the viewer is not entitled to', () => {
  // From Black's seat after ply 14, Black may see: its own seven pieces
  // (司令 旅長 團長 工兵 爆裂物) and White's 翻明 pieces — which is now a1's 司令
  // (ply 1) and nothing else. b1's 旅長 died in a 同歸於盡 and g1's 爆裂物 in
  // another, and neither announcement 翻明s anybody.
  const VISIBLE: Rank[] = ['commander', 'brigade', 'regiment', 'engineer', 'bomb']
  // Everything else. White's 排長 (lost as attacker), 營長 (died in a 同歸於盡),
  // 連長 (never in contact) and both 爆裂物, plus the three ranks nobody
  // deployed at all.
  const HIDDEN: Rank[] = ALL_RANKS.filter((r) => !VISIBLE.includes(r))

  it('the premise holds: those ranks really are absent from the ViewerState', () => {
    expect(HIDDEN).toEqual(['general', 'division', 'battalion', 'company', 'platoon', 'flag'])
    const carried = new Set(asBlackMid.pieces.map((p) => p.rank).filter((r): r is Rank => r !== null))
    for (const rank of HIDDEN) expect(carried.has(rank)).toBe(false)
    for (const rank of VISIBLE) expect(carried.has(rank)).toBe(true)
    // white's 排長/營長/連長/爆裂物 are still on the authoritative state
    expect(MID.pieces.find((p) => p.id === 'WP')!.rank).toBe('company')
    // and a 同歸於盡 翻明s nobody, so White's 旅長 and 爆裂物 are not public
    // through the piece list either — the record only sees the ply-1 司令
    expect(MID.pieces.find((p) => p.id === 'WA')!.revealed).toBe(true)
    for (const id of ['WB', 'WF', 'WG', 'WH']) {
      expect(MID.pieces.find((p) => p.id === id)!.revealed, id).toBe(false)
    }
  })

  it('greps the RENDERED MARKDOWN and finds none of them', () => {
    const md = exportMarkdown(asBlackMid)
    const all = md.split('\n')
    const lines = all.filter((l) => !l.startsWith(DISTRIBUTION_PREFIX))
    expect(all.length - lines.length).toBe(1)   // exactly one §2 table line
    const text = lines.join('\n')

    for (const rank of HIDDEN) {
      expect(text).not.toContain(RANK_NAMES_ZH[rank])   // 軍長 師長 營長 連長 排長 軍旗
      expect(text).not.toContain(rank)                  // general division …
    }
    // …while the ranks it IS entitled to are present, so the grep is not
    // passing merely because the record is empty.
    expect(text).toContain('司令')      // 翻明 on ply 1, and again on ply 5
    expect(text).toContain('爆裂物')    // announced by the 有煙無傷 on ply 13
    // 旅長 is NOT here, though Black holds two of them and knows perfectly well
    // what died on b8: the record prints a 兵種 only where the GAME announced
    // one, and 同歸於盡 announces none.
    expect(text).not.toContain('旅長')
  })

  it('greps the RENDERED JSON and finds none of them either', () => {
    const json = exportJson(asBlackMid) as RecordJson
    // config.distribution is the §2 table again — same exemption, same reason.
    const text = JSON.stringify({ ...json, config: { ...json.config, distribution: [] } })
    for (const rank of HIDDEN) {
      expect(text).not.toContain(RANK_NAMES_ZH[rank])
      expect(text).not.toContain(`"${rank}"`)
    }
    // the redacted position is passed through as nulls, never re-derived
    const wp = json.position.find((p) => p.id === 'WP')!
    expect(wp.rank).toBeNull()
    expect(wp.revealed).toBe(false)
  })

  it('is INDISTINGUISHABLE across the hidden ranks — the strongest form', () => {
    // A grep can only catch a rank string that appears. This catches a record
    // that *varies* with a 兵種 the viewer may not see, however indirectly:
    // permute White's unrevealed ranks into a different, equally legal world and
    // the exported bytes must not move by one character. The rotation moves a
    // 爆裂物 onto a piece that is still standing, so a bomb count taken off the
    // piece list mid-game would move with it — which is why there is not one.
    const viewer: Viewer = { kind: 'player', color: 'black' }
    const alt = permuteHiddenRanks(MID, viewer)
    expect(alt.changed).toBe(true)

    const here = stateForViewer(MID, viewer)
    const there = stateForViewer(alt.state, viewer)
    expect(exportMarkdown(there)).toBe(exportMarkdown(here))
    expect(JSON.stringify(exportJson(there))).toBe(JSON.stringify(exportJson(here)))
    expect(gameStats(there)).toEqual(gameStats(here))
  })

  it('a spectator bound to Black sees exactly what Black sees (§10 現場觀戰)', () => {
    const spectator = stateForViewer(MID, { kind: 'spectator', bound: 'black' })
    const asPlayer = exportMarkdown(asBlackMid)
    const asSpectator = exportMarkdown(spectator)
    // only the provenance line differs
    expect(asSpectator).toContain('Exported from a spectator bound to Black')
    expect(asSpectator.split('\n').slice(3)).toEqual(asPlayer.split('\n').slice(3))
  })

  it('and once the game is over the same export carries every 兵種 (終局公開全部兵種)', () => {
    const md = exportMarkdown(asBlackDone)
    expect(md).toContain('The game is finished, so every 兵種 is in this record')
    const done = exportJson(asBlackDone) as RecordJson
    expect(done.position.find((p) => p.id === 'WP')!.rank).toBe('company')
  })
})

// ---------------------------------------------------------------------------
// Deployments — §9
// ---------------------------------------------------------------------------

// Both are permutations of the §2 multiset, so both decode cleanly.
const WHITE_CODE = 'XXF9987665544321'
const BLACK_CODE = '67899FXX12344556'

function deployedGame(): GameState {
  let s = createGame('rec-deploy')
  for (const [color, code] of [['white', WHITE_CODE], ['black', BLACK_CODE]] as [Color, string][]) {
    const decoded = decodeSetupCode(code, color, s)
    if ('error' in decoded) throw new Error(`fixture: ${decoded.error}`)
    s = submitAssignment(s, color, decoded.assignment)
  }
  return s
}

describe('deployments are exported when — and only when — the view carries them', () => {
  const played = deployedGame()

  it('mid-game exports NEITHER deployment — not even the exporter’s own', () => {
    // The intended use is pasting this into a chat window, which against an LLM
    // opponent is the window the opponent reads. Carrying your own 16 兵種 there
    // hands over the army, and a footer warning does not survive a copy-paste.
    const vs = stateForViewer(played, { kind: 'player', color: 'white' })
    const md = exportMarkdown(vs)
    expect(md).toContain('Withheld while the game is live')
    expect(md).not.toContain(WHITE_CODE)
    expect(md).not.toContain(BLACK_CODE)

    // the JSON path must not be the softer way out
    const json = exportJson(vs) as RecordJson
    expect(json.deployments.white).toBeNull()
    expect(json.deployments.black).toBeNull()
    expect(JSON.stringify(json)).not.toContain(WHITE_CODE)
  })

  it('and does not count the exporter’s own 爆裂物 either, for the same reason', () => {
    // White can see all sixteen of its own 兵種 mid-game, so the true count is
    // sitting right there in the ViewerState. Publishing it would tell the
    // opponent how many 爆裂物 White has left, which is precisely what 同歸於盡
    // was made silent to withhold.
    const stats = gameStats(stateForViewer(played, { kind: 'player', color: 'white' }))
    expect(stats.sides.white.bombsLost.actual).toBeNull()
    expect(stats.sides.black.bombsLost.actual).toBeNull()
  })

  it('at game end both are there, round-tripping the codes they were deployed with', () => {
    const finished = resign(played, 'white')
    const vs = stateForViewer(finished, { kind: 'player', color: 'white' })
    const md = exportMarkdown(vs)
    expect(md).toContain(`**White** — setup code \`${WHITE_CODE}\``)
    expect(md).toContain(`**Black** — setup code \`${BLACK_CODE}\``)

    const json = exportJson(vs) as RecordJson
    expect(json.deployments.white?.code).toBe(WHITE_CODE)
    expect(json.deployments.black?.code).toBe(BLACK_CODE)
    // slot 1 of a code is the a2 pawn; black's code starts '6' = 營長
    expect(json.deployments.black?.pieces[0]).toEqual({
      square: 56,
      square_name: 'a8',
      carrier: 'rook',
      rank: 'battalion',
    })
    // 終局 opens every 兵種, so the true bomb count is derivable now — and it is
    // zero, because nobody ever made contact in this fixture
    const stats = gameStats(vs)
    expect(stats.sides.white.bombsLost).toEqual({ known: 0, knownPlies: [], actual: 0 })
    expect(stats.sides.black.bombsLost.actual).toBe(0)
  })

  it('never reaches for the opponent’s: permuting all 16 of Black’s changes nothing', () => {
    const viewer: Viewer = { kind: 'player', color: 'white' }
    const alt = permuteHiddenRanks(played, viewer)
    expect(alt.changed).toBe(true)
    expect(exportMarkdown(stateForViewer(alt.state, viewer)))
      .toBe(exportMarkdown(stateForViewer(played, viewer)))
  })

  it('a hand-built position has no §9 slots, so no deployment is claimed', () => {
    const json = exportJson(asBlackDone) as RecordJson
    expect(json.deployments).toEqual({ white: null, black: null })
  })
})

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('exportJson — arrays of records, for a script', () => {
  const json = exportJson(asBlackDone) as RecordJson

  it('carries the result, the config and the stats', () => {
    expect(json.format).toBe('xiyang-record')
    expect(json.status).toBe('over')
    expect(json.result).toEqual({
      kind: 'resign',
      condition: '認輸',
      winner: 'white',
      draw: false,
    })
    expect(json.score).toEqual({ white: 4, black: 3.5 })
    expect(json.config.scoring_squares).toEqual([
      { square: 27, name: 'd4' },
      { square: 28, name: 'e4' },
      { square: 35, name: 'd5' },
      { square: 36, name: 'e5' },
    ])
    expect(json.stats.mutual_destruction).toEqual({ mutual: 3, contests: 6, ratio: 0.5 })
    // the key that used to be here measured something no longer observable, so
    // it is gone rather than quietly repurposed
    expect(JSON.stringify(json)).not.toContain('ties_per_contest')
    expect(json.stats.contacts_by_outcome)
      .toContainEqual({ outcome: 'mutual-destruction', count: 3 })
    expect(json.stats.sides.map((s) => s.color)).toEqual(['white', 'black'])
  })

  it('carries every per-side counter, and no second name for one of them', () => {
    // Same hand computation as the gameStats block: White holds one square from
    // ply 7, moves seven different pieces and lands on e4 once in seven; Black
    // holds one from ply 2 and moves one rook twice, its five passes excluded.
    const [w, b] = json.stats.sides
    expect(w).toMatchObject({
      color: 'white',
      settlements: 7,
      earnedPerPly: 4 / 14,
      earnedPerSettlement: 4 / 7,
      peakSquaresHeld: { count: 1, ply: 7 },
      objectiveMoves: { count: 1, total: 7, ratio: 1 / 7 },
      distinctPiecesMoved: 7,
      longestSinglePieceRun: { length: 1, startPly: 1 },
      bombsLost: { known: 1, knownPlies: [13], actual: 2 },
    })
    expect(b).toMatchObject({
      color: 'black',
      settlements: 7,
      earnedPerPly: 3 / 14,
      earnedPerSettlement: 3 / 7,
      peakSquaresHeld: { count: 1, ply: 2 },
      objectiveMoves: { count: 1, total: 2, ratio: 0.5 },
      distinctPiecesMoved: 1,
      longestSinglePieceRun: { length: 2, startPly: 2 },
      bombsLost: { known: 0, knownPlies: [], actual: 2 },
    })
    expect(JSON.stringify(json)).not.toContain('scoringSquaresPerPly')
    expect(JSON.stringify(json)).not.toContain('zeroPlies')
  })

  it('gives one record per ply, with the per-ply income spelled out', () => {
    expect(json.moves).toHaveLength(14)
    expect(json.moves[0]).toEqual({
      ply: 1,
      color: 'white',
      notation: 'a1a8',
      move_kind: 'move',
      from: 0,
      from_name: 'a1',
      to: 56,
      to_name: 'a8',
      castle_side: null,
      promoted: null,
      combat: {
        outcome: { kind: 'attacker-wins', winnerRank: 'commander' },
        attacker_square: 0,
        attacker_square_name: 'a1',
        defender_square: 56,
        defender_square_name: 'a8',
        survivor_square: 56,
        survivor_square_name: 'a8',
      },
      score_after: { white: 0, black: 0.5 },
      income: { white: 0, black: 0 },
    })
    expect(json.moves[3]).toMatchObject({ ply: 4, notation: 'pass', move_kind: 'pass', combat: null })
  })

  it('carries a 同歸於盡 as a bare kind — there is nothing else in it', () => {
    // No colour, no rank, no discriminator for anyone downstream to strip. The
    // three of them are byte-identical.
    const three = [2, 8, 10].map((i) => json.moves[i]!.combat!.outcome)
    for (const o of three) expect(o).toEqual({ kind: 'mutual-destruction' })
    expect(new Set(three.map((o) => JSON.stringify(o))).size).toBe(1)
  })

  it('is JSON-serialisable and holds no live reference into the ViewerState', () => {
    const round = JSON.parse(JSON.stringify(json)) as RecordJson
    expect(round.stats).toEqual(json.stats)
    expect(round.moves).toHaveLength(14)
  })
})

// ---------------------------------------------------------------------------
// Purity — these are pure functions over a ViewerState (techspec §4)
// ---------------------------------------------------------------------------

describe('the exporters are pure', () => {
  it('do not touch the ViewerState they are handed', () => {
    const before = structuredClone(asBlackDone)
    exportMarkdown(asBlackDone)
    exportJson(asBlackDone)
    gameStats(asBlackDone)
    expect(asBlackDone).toEqual(before)
  })

  it('are deterministic — the same state exports the same bytes', () => {
    expect(exportMarkdown(asBlackDone)).toBe(exportMarkdown(asBlackDone))
    expect(JSON.stringify(exportJson(asBlackDone))).toBe(JSON.stringify(exportJson(asBlackDone)))
  })
})
