/**
 * §7.3 吃子得分 — the ① 行動階段 half of the score.
 *
 *   「除了佔領計分格，吃子本身也給分。於行動階段①即時結算。」
 *
 *   | 決定性勝負 | 勝方得 k ×（勝方階級數字）。階級數字越大代表越弱，故弱者獲勝得分越高 |
 *   | 有煙無傷   | 存活方得一筆固定額。該數額不得因存活者為工兵或軍旗而異 |
 *   | 同歸於盡   | 雙方皆零分 |
 *
 * Three things make this rule different from ② 結算, and every block below is
 * pointed at one of them.
 *
 * FIRST: the payment does not follow the mover. 決定性勝負 pays the WINNER, so a
 * defender that holds its square is credited on the OPPONENT's ply, and 有煙無傷
 * pays 存活方, which is the idle side whenever a 爆裂物 attacked and fizzled.
 * "Only the mover's column can move in a ply" was true of the engine before this
 * rule existed and is asserted in four other files; it is a statement about ②
 * alone, and this file is where the other half lives.
 *
 * SECOND: it is the one scoring rule that reads a 兵種 at all, so 附錄 A(d) is
 * the whole design. `captureScore` takes the public announcement and the config
 * and NOTHING else — no board, no piece list, no loser — which makes the
 * constraint checkable by inspection: the only 兵種 in scope is `winnerRank`,
 * which §4.3 forced 翻明 in the same event. The consequence is a property, and
 * it is the strongest test here: the score delta of every ply in every game is
 * reproducible by the strictest viewer in the system from its own copy of the
 * log. If a payment ever came off the loser's rank, or told a 工兵 survivor from
 * a 軍旗 one, that property is what fails.
 *
 * THIRD: it is paid in ①, so it survives 奪旗. §7.6 skips 「結算階段」 and only
 * that, so the ply that takes a 軍旗 banks its capture points and no 佔領分.
 *
 * All of it is OFF at the shipped default (附錄 B lists k and 有煙無傷獎勵 as
 * 待定, so both default to 0). That is why the rest of the suite needed no
 * expectation changed — and it is also why every test here sets the knobs
 * explicitly. At k = 0 this entire file would pass against an engine that never
 * implemented §7.3 at all.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_RANKS,
  DEFAULT_CONFIG,
  RANK_ORDER,
  applyMove,
  captureScore,
  createGame,
  defaultAssignment,
  legalMoves,
  replayGame,
  resign,
  resolveCombat,
  stateForViewer,
  submitAssignment,
} from '../src/index.js'
import type {
  Color,
  CombatOutcome,
  GameConfig,
  GameState,
  Move,
  Rank,
  RankDistribution,
  ViewerState,
} from '../src/index.js'
import { PASS, lastEvent, mv, position, snapshot, sq } from './helpers.js'

/**
 * The knobs under test.
 *
 * k = 3 rather than 1 so that k and the 階級 number cannot be swapped without a
 * failure, and FIZZLE = 5 because 5 is not a multiple of 3: no fizzle bonus can
 * be mistaken for some k × 階級, and no decisive payment for a fizzle.
 */
const K = 3
const FIZZLE = 5
const SCORED: Partial<GameConfig> = { captureScoreK: K, fizzleBonus: FIZZLE }
const CONFIG: GameConfig = { ...DEFAULT_CONFIG, ...SCORED }

/** k × 階級, spelled out so the tests below quote the rule rather than a helper. */
const decisive = (rank: Exclude<Rank, 'bomb'>) => K * RANK_ORDER[rank]

const ZERO = { white: 0, black: 0 }

// ---------------------------------------------------------------------------
// §7.3 的三列表格
// ---------------------------------------------------------------------------

describe('§7.3 the table — what a contact pays, read off the announcement alone', () => {
  it('決定性勝負 攻方勝: k × 勝方階級 to the ATTACKER’s side', () => {
    const pay = captureScore({ kind: 'attacker-wins', winnerRank: 'general' }, 'white', CONFIG)
    expect(pay).toEqual({ white: decisive('general'), black: 0 })
    expect(pay).toEqual({ white: 6, black: 0 })
  })

  it('決定性勝負 守方勝: k × 勝方階級 to the DEFENDER’s side — the side that did NOT move', () => {
    const pay = captureScore({ kind: 'defender-wins', winnerRank: 'general' }, 'white', CONFIG)
    expect(pay).toEqual({ white: 0, black: decisive('general') })
  })

  it('pays the same amount to whichever colour happens to be attacking', () => {
    const asWhite = captureScore({ kind: 'attacker-wins', winnerRank: 'division' }, 'white', CONFIG)
    const asBlack = captureScore({ kind: 'attacker-wins', winnerRank: 'division' }, 'black', CONFIG)
    expect(asWhite).toEqual({ white: decisive('division'), black: 0 })
    expect(asBlack).toEqual({ white: 0, black: decisive('division') })
  })

  it('有煙無傷: the flat bonus to 存活方, whichever colour that is', () => {
    expect(captureScore({ kind: 'fizzle', survivorColor: 'white' }, 'white', CONFIG))
      .toEqual({ white: FIZZLE, black: 0 })
    // The bomb attacked and fizzled: the survivor is the DEFENDER, i.e. the side
    // that is not moving. The bonus follows the survivor, not the mover.
    expect(captureScore({ kind: 'fizzle', survivorColor: 'black' }, 'white', CONFIG))
      .toEqual({ white: 0, black: FIZZLE })
  })

  it('同歸於盡: zero to both, from either seat', () => {
    expect(captureScore({ kind: 'mutual-destruction' }, 'white', CONFIG)).toEqual(ZERO)
    expect(captureScore({ kind: 'mutual-destruction' }, 'black', CONFIG)).toEqual(ZERO)
  })

  it('prices every 階級 at exactly k × its number', () => {
    for (const rank of ALL_RANKS) {
      if (rank === 'bomb') continue
      const pay = captureScore({ kind: 'attacker-wins', winnerRank: rank }, 'white', CONFIG)
      expect(pay).toEqual({ white: K * RANK_ORDER[rank], black: 0 })
    }
  })

  it('pays MORE for a WEAKER winner — 階級數字越大代表越弱，故弱者獲勝得分越高', () => {
    // The direction is the rule, not an oversight. 司令 is 1 and 軍旗 is 10, so
    // the 工兵 that takes a 軍旗 out-earns the 司令 that takes anything.
    const ladder: Exclude<Rank, 'bomb'>[] = [
      'commander', 'general', 'division', 'brigade', 'regiment',
      'battalion', 'company', 'platoon', 'engineer', 'flag',
    ]
    const paid = ladder.map((r) => decisive(r))
    expect(paid).toEqual([...paid].sort((a, b) => a - b))
    expect(paid[0]).toBeLessThan(paid[paid.length - 1]!)
    expect(decisive('engineer')).toBeGreaterThan(decisive('commander'))
  })

  it('reads amounts from the CONFIG, never from a module literal (附錄 B)', () => {
    const doubled: GameConfig = { ...DEFAULT_CONFIG, captureScoreK: 6, fizzleBonus: 11 }
    expect(captureScore({ kind: 'attacker-wins', winnerRank: 'general' }, 'white', doubled))
      .toEqual({ white: 12, black: 0 })
    expect(captureScore({ kind: 'fizzle', survivorColor: 'black' }, 'white', doubled))
      .toEqual({ white: 0, black: 11 })
  })

  it('pays nothing at the shipped default — 附錄 B lists both knobs as 待定', () => {
    expect(DEFAULT_CONFIG.captureScoreK).toBe(0)
    expect(DEFAULT_CONFIG.fizzleBonus).toBe(0)
    for (const rank of ALL_RANKS) {
      if (rank === 'bomb') continue
      expect(captureScore({ kind: 'attacker-wins', winnerRank: rank }, 'white', DEFAULT_CONFIG))
        .toEqual(ZERO)
      expect(captureScore({ kind: 'defender-wins', winnerRank: rank }, 'white', DEFAULT_CONFIG))
        .toEqual(ZERO)
    }
    expect(captureScore({ kind: 'fizzle', survivorColor: 'white' }, 'white', DEFAULT_CONFIG))
      .toEqual(ZERO)
    expect(captureScore({ kind: 'mutual-destruction' }, 'white', DEFAULT_CONFIG)).toEqual(ZERO)
  })

  it('refuses a 爆裂物 "winner" loudly instead of paying NaN', () => {
    // 爆裂物 has no 階級 and RANK_ORDER has no entry for it, so an unguarded
    // lookup returns undefined, k × undefined is NaN, and NaN poisons `score`,
    // every later `scoreAfter`, and the `>= scoreTarget` test — which is false
    // for NaN, so the game would silently lose its ability to end on points.
    // `resolveCombat` provably never announces one; the type system does not
    // know that, so the guard is real.
    expect(() => captureScore({ kind: 'attacker-wins', winnerRank: 'bomb' }, 'white', CONFIG))
      .toThrow(/爆裂物/)
    expect(() => captureScore({ kind: 'defender-wins', winnerRank: 'bomb' }, 'white', CONFIG))
      .toThrow(/爆裂物/)
  })
})

// ---------------------------------------------------------------------------
// 附錄 A(d) — over every ordered 兵種 pair that exists
// ---------------------------------------------------------------------------

const PAIRS: [Rank, Rank][] = ALL_RANKS.flatMap((a) => ALL_RANKS.map((d) => [a, d] as [Rank, Rank]))

describe('附錄 A(d) — the payment is a function of the ANNOUNCEMENT, over all 121 pairs', () => {
  it('never produces NaN, and never indexes RANK_ORDER with 爆裂物', () => {
    for (const [a, d] of PAIRS) {
      const { outcome } = resolveCombat(a, d, 'white', 'black')
      if (outcome.kind === 'attacker-wins' || outcome.kind === 'defender-wins') {
        expect(outcome.winnerRank).not.toBe('bomb')
      }
      const pay = captureScore(outcome, 'white', CONFIG)
      expect(Number.isFinite(pay.white)).toBe(true)
      expect(Number.isFinite(pay.black)).toBe(true)
    }
  })

  it('matches §7.3’s table for every pair, and credits the winner’s side', () => {
    for (const [a, d] of PAIRS) {
      const { outcome } = resolveCombat(a, d, 'white', 'black')
      const pay = captureScore(outcome, 'white', CONFIG)
      switch (outcome.kind) {
        case 'attacker-wins':
          expect(pay).toEqual({ white: decisive(outcome.winnerRank as Exclude<Rank, 'bomb'>), black: 0 })
          expect(outcome.winnerRank).toBe(a)
          break
        case 'defender-wins':
          expect(pay).toEqual({ white: 0, black: decisive(outcome.winnerRank as Exclude<Rank, 'bomb'>) })
          expect(outcome.winnerRank).toBe(d)
          break
        case 'fizzle':
          expect(pay[outcome.survivorColor]).toBe(FIZZLE)
          expect(pay.white + pay.black).toBe(FIZZLE)
          break
        case 'mutual-destruction':
          expect(pay).toEqual(ZERO)
          break
      }
    }
  })

  it('pays IDENTICALLY for every pair that makes the same announcement', () => {
    // This is 附錄 A(d) in its operational form. Two contacts a viewer cannot
    // tell apart must not be told apart by the score column either — otherwise
    // the score is a side channel for the 兵種 the announcement withheld. It
    // covers the loser directly: many different losers produce one announcement,
    // so a payment that read the loser would split this grouping.
    const byAnnouncement = new Map<string, { pay: string; pairs: [Rank, Rank][] }>()
    for (const [a, d] of PAIRS) {
      const { outcome } = resolveCombat(a, d, 'white', 'black')
      const key = JSON.stringify(outcome)
      const pay = JSON.stringify(captureScore(outcome, 'white', CONFIG))
      const seen = byAnnouncement.get(key)
      if (!seen) {
        byAnnouncement.set(key, { pay, pairs: [[a, d]] })
      } else {
        seen.pairs.push([a, d])
        expect(pay, `announcement ${key} paid two different amounts`).toBe(seen.pay)
      }
    }
    // The grouping must be non-trivial, or the assertion above proved nothing:
    // 同歸於盡 alone covers 同階相遇, 爆裂物 vs 一般兵種 and 爆裂物 vs 爆裂物.
    const mutual = byAnnouncement.get(JSON.stringify({ kind: 'mutual-destruction' }))
    expect(mutual!.pairs.length).toBeGreaterThan(3)
    expect(mutual!.pay).toBe(JSON.stringify(ZERO))
  })

  it('keeps 爆裂物 uncountable: a detonation costs exactly what a 同階相遇 costs', () => {
    // If a bomb going off paid anything at all, a player could subtract the
    // 佔領分 from the score column and count how many 爆裂物 the opponent has
    // left. 同歸於盡 pays zero precisely so that arithmetic yields nothing.
    const sameRank = resolveCombat('brigade', 'brigade', 'white', 'black').outcome
    const bombVsPiece = resolveCombat('bomb', 'commander', 'white', 'black').outcome
    const pieceVsBomb = resolveCombat('commander', 'bomb', 'white', 'black').outcome
    const bombVsBomb = resolveCombat('bomb', 'bomb', 'white', 'black').outcome
    for (const outcome of [sameRank, bombVsPiece, pieceVsBomb, bombVsBomb]) {
      expect(outcome).toEqual({ kind: 'mutual-destruction' })
      expect(captureScore(outcome, 'white', CONFIG)).toEqual(ZERO)
    }
  })

  it('有煙無傷 pays the same whether the survivor is 工兵 or 軍旗 (附錄 A(a))', () => {
    // The event narrows the survivor to "工兵 or 軍旗" and stops there. A bonus
    // that differed between the two would finish the sentence the rule refuses
    // to finish.
    for (const immune of ['engineer', 'flag'] as const) {
      const bombAttacked = resolveCombat('bomb', immune, 'white', 'black').outcome
      const immuneAttacked = resolveCombat(immune, 'bomb', 'white', 'black').outcome
      expect(captureScore(bombAttacked, 'white', CONFIG)).toEqual({ white: 0, black: FIZZLE })
      expect(captureScore(immuneAttacked, 'white', CONFIG)).toEqual({ white: FIZZLE, black: 0 })
    }
  })
})

// ---------------------------------------------------------------------------
// Through applyMove — the payment actually reaches the score
// ---------------------------------------------------------------------------

/** Two pieces on d1 / d4, so the contact happens ON a 計分格. */
function contact(whiteRank: Rank, blackRank: Rank, config: Partial<GameConfig> = SCORED): GameState {
  return position(
    [
      { at: 'd1', color: 'white', carrier: 'rook', rank: whiteRank, id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: blackRank, id: 'BN' },
    ],
    { config },
  )
}

const START = { white: 0, black: DEFAULT_CONFIG.komi }

describe('§7.3 through applyMove — ① pays into the same score ② settles into', () => {
  it('攻方勝 credits the mover, and the arriving winner ALSO banks the 計分格', () => {
    // The two sources are independent (§7.1) and this ply collects both: k × 軍長
    // for the kill, then +1 for standing on d4 when ② runs.
    const s = applyMove(contact('general', 'company'), mv('d1', 'd4'))
    expect(s.score).toEqual({ white: decisive('general') + 1, black: 0.5 })
    expect(lastEvent(s).scoreAfter).toEqual(s.score)
  })

  it('守方勝 credits the side that did NOT move, on the mover’s ply', () => {
    // The invariant "only the mover's column can move in a ply" belongs to ②.
    // Here white attacks, white loses, and BLACK's column is the one that moves.
    const s = applyMove(contact('company', 'general'), mv('d1', 'd4'))
    expect(s.score).toEqual({ white: 0, black: 0.5 + decisive('general') })
    expect(lastEvent(s).color).toBe('white')
    expect(lastEvent(s).scoreAfter).toEqual(s.score)
    // Black's surviving d4 piece is still not settled here — that is ②'s job and
    // ② credits the mover only. It arrives one ply later.
    const t = applyMove(s, PASS)
    expect(t.score).toEqual({ white: 0, black: 0.5 + decisive('general') + 1 })
  })

  it('同歸於盡 on a 計分格 pays nobody anything', () => {
    for (const [w, b] of [['brigade', 'brigade'], ['bomb', 'commander'], ['bomb', 'bomb']] as const) {
      const s = applyMove(contact(w, b), mv('d1', 'd4'))
      expect(s.score).toEqual(START)
    }
  })

  it('有煙無傷 pays 存活方 in both directions, and the same for 工兵 and 軍旗', () => {
    for (const immune of ['engineer', 'flag'] as const) {
      // The 爆裂物 attacked: the survivor is black, the idle side. White's own
      // piece is gone, so ② pays white nothing.
      const bombAttacks = applyMove(contact('bomb', immune), mv('d1', 'd4'))
      expect(bombAttacks.score).toEqual({ white: 0, black: 0.5 + FIZZLE })

      // The 工兵/軍旗 attacked: it survives, so white takes the bonus AND stands
      // on d4 to be settled.
      const immuneAttacks = applyMove(contact(immune, 'bomb'), mv('d1', 'd4'))
      expect(immuneAttacks.score).toEqual({ white: FIZZLE + 1, black: 0.5 })
    }
  })

  it('leaves the 爆裂物 owner’s WHOLE view identical whether it hit a 工兵 or a 軍旗', () => {
    // The strict form of 附錄 A(a)+(d). Comparing scores catches a bonus that
    // differs by tribe; comparing the entire redacted payload also catches one
    // that leaks through the log, the piece list or a 翻明 flag. The viewer is
    // the side that spent the bomb — the one player with a reason to want to
    // know, and the one the ambiguity is aimed at.
    const bombOwnerView = (defenderRank: Rank) => {
      const s = applyMove(contact('bomb', defenderRank), mv('d1', 'd4'))
      return JSON.stringify(stateForViewer(s, { kind: 'player', color: 'white' }))
    }
    expect(bombOwnerView('engineer')).toBe(bombOwnerView('flag'))

    // And the other direction: black spent the bomb, black must not learn which
    // of its opponent's two immune 兵種 walked over it.
    const attackedOwnerView = (attackerRank: Rank) => {
      const s = applyMove(contact(attackerRank, 'bomb'), mv('d1', 'd4'))
      return JSON.stringify(stateForViewer(s, { kind: 'player', color: 'black' }))
    }
    expect(attackedOwnerView('engineer')).toBe(attackedOwnerView('flag'))
  })

  it('fires identically on the en-passant path, where 接觸格 ≠ 目的格', () => {
    // The only move in the game whose contact square is not its destination. A
    // payment computed from the destination, or from occupancy, would be wrong
    // or absent here and correct everywhere else. b5/a5/a6 are outside the 計分格
    // set, so what is left in the delta is the capture payment alone.
    const ep = position(
      [
        { at: 'b5', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP', hasMoved: true },
        { at: 'a7', color: 'black', carrier: 'pawn', rank: 'company', id: 'BP' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { toMove: 'black', ply: 2, config: SCORED },
    )
    const window = applyMove(ep, mv('a7', 'a5'))
    const taken = applyMove(window, mv('b5', 'a6'))

    const c = lastEvent(taken).combat!
    expect(c.defenderSquare).toBe(sq('a5'))
    expect(c.survivorSquare).toBe(sq('a6'))
    expect(c.defenderSquare).not.toBe(c.survivorSquare)
    expect(taken.score).toEqual({ white: decisive('general'), black: 0.5 })

    // Same 兵種 pair, ordinary geometry, same payment.
    const plain = applyMove(
      position(
        [
          { at: 'b5', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
          { at: 'b7', color: 'black', carrier: 'knight', rank: 'company', id: 'BN' },
        ],
        { config: SCORED },
      ),
      mv('b5', 'b7'),
    )
    expect(plain.score.white).toBe(taken.score.white)
  })

  it('leaves the 停滯 counter exactly where it was — any contact already zeroes it', () => {
    // §7.5③ resets on ANY capture, before the score is consulted, so 同歸於盡
    // paying zero still counts as progress and a capture payment cannot count
    // twice.
    const quiet = contact('brigade', 'brigade')
    const s = applyMove({ ...quiet, noProgressTurns: 7 }, mv('d1', 'd4'))
    expect(s.score).toEqual(START)
    expect(s.noProgressTurns).toBe(0)
  })

  it('does not mutate the input state — applyMove is still pure at non-zero k', () => {
    for (const [w, b] of [
      ['general', 'company'], ['company', 'general'],
      ['brigade', 'brigade'], ['bomb', 'engineer'], ['engineer', 'bomb'],
    ] as const) {
      const before = contact(w, b)
      const frozen = snapshot(before)
      const after = applyMove(before, mv('d1', 'd4'))
      expect(before).toEqual(frozen)
      expect(after.score).not.toBe(before.score)
    }
  })
})

// ---------------------------------------------------------------------------
// §7.6 — ① is paid, ② is skipped
// ---------------------------------------------------------------------------

describe('§7.6 奪旗 skips 結算階段② and ONLY ② — the ① payment stands', () => {
  it('pays the 軍旗-taker its capture points while banking no 佔領分', () => {
    // White's 軍長 takes the black 軍旗 standing on d4 and ends the game. Had ②
    // run, white would also have banked d4 — the missing +1 is exactly the
    // settlement §7.6 skips.
    const s = applyMove(contact('general', 'flag'), mv('d1', 'd4'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })
    expect(s.score).toEqual({ white: decisive('general'), black: 0.5 })
    expect(lastEvent(s).scoreAfter).toEqual(s.score)

    // Same capture against a non-軍旗 defender: the game continues and ② pays
    // the extra point. The difference between the two IS 「不執行結算階段」.
    const alive = applyMove(contact('general', 'company'), mv('d1', 'd4'))
    expect(alive.score.white).toBe(s.score.white + 1)
  })

  it('pays a 工兵 that takes the 軍旗 — the weakest winner, the biggest payment', () => {
    const s = applyMove(contact('engineer', 'flag'), mv('d1', 'd4'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })
    expect(s.score).toEqual({ white: decisive('engineer'), black: 0.5 })
    expect(decisive('engineer')).toBe(27)
  })

  it('pays a DEFENDER on a ply that ends the game — idle side, ② skipped, all at once', () => {
    // White throws its own 軍旗 at a 排長 and loses it. Three of this rule's
    // corners meet on one ply: the payment goes to the defender (not the mover),
    // the defender is the side that did not move, and the game ends in ① so no
    // settlement runs for anybody.
    const s = applyMove(contact('flag', 'platoon'), mv('d1', 'd4'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
    expect(s.score).toEqual({ white: 0, black: 0.5 + decisive('platoon') })
    expect(lastEvent(s).color).toBe('white')
    expect(lastEvent(s).scoreAfter).toEqual(s.score)
  })

  it('pays nothing extra when both 軍旗 leave at once — 同歸於盡 is still zero', () => {
    const s = applyMove(contact('flag', 'flag'), mv('d1', 'd4'))
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag-both' } })
    expect(s.score).toEqual(START)
  })
})

// ---------------------------------------------------------------------------
// §7.5② — capture points count toward X, on the same schedule as everything else
// ---------------------------------------------------------------------------

/** A board with no 軍旗 anywhere, so nothing can end in ①. */
function race(whiteRank: Rank, blackRank: Rank, scoreTarget: number): GameState {
  return position(
    [
      { at: 'd1', color: 'white', carrier: 'rook', rank: whiteRank, id: 'WR' },
      { at: 'd4', color: 'black', carrier: 'knight', rank: blackRank, id: 'BN' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
    ],
    { config: { ...SCORED, scoreTarget } },
  )
}

describe('§7.5② capture points count toward X, but the line is still read at the close of a TURN', () => {
  it('does not end the game when WHITE crosses X on its own ply', () => {
    // 排長 beats 工兵: k × 8 = 24, plus d4 = 25, against X = 20. White is over
    // the line on ply 1 and the game continues anyway — the check point is the
    // close of the turn, and black has not moved.
    const crossed = applyMove(race('platoon', 'engineer', 20), mv('d1', 'd4'))
    expect(crossed.score.white).toBe(decisive('platoon') + 1)
    expect(crossed.score.white).toBeGreaterThanOrEqual(20)
    expect(crossed.status).toEqual({ kind: 'playing' })

    const closed = applyMove(crossed, PASS)
    expect(closed.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
  })

  it('lets a WHITE ply carry BLACK over X, and still waits for the turn to close', () => {
    // 守方勝 pays the idle side, so the opponent's move is now a way to score.
    // The check point does not move for it: black crosses on white's ply and the
    // game runs on until black has played.
    const crossed = applyMove(race('platoon', 'company', 20), mv('d1', 'd4'))
    expect(crossed.score).toEqual({ white: 0, black: 0.5 + decisive('company') })
    expect(crossed.score.black).toBeGreaterThanOrEqual(20)
    expect(crossed.status).toEqual({ kind: 'playing' })

    const closed = applyMove(crossed, PASS)
    expect(closed.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })
  })

  it('is not reached at all when the same ply ends the game by 奪旗 (§7.6 跨手)', () => {
    // White is already past X, but crossing is not winning until the line is
    // read. Black answers by taking white's 軍旗 in ①, so the check point is
    // never reached — and black keeps the capture points from doing it.
    const start = position(
      [
        { at: 'd1', color: 'white', carrier: 'rook', rank: 'platoon', id: 'WR' },
        { at: 'd4', color: 'black', carrier: 'knight', rank: 'engineer', id: 'BN' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'WF' },
        { at: 'a8', color: 'black', carrier: 'rook', rank: 'general', id: 'BR' },
      ],
      { config: { ...SCORED, scoreTarget: 20 } },
    )
    const crossed = applyMove(start, mv('d1', 'd4'))
    expect(crossed.score.white).toBeGreaterThanOrEqual(20)
    expect(crossed.status).toEqual({ kind: 'playing' })

    const flagged = applyMove(crossed, mv('a8', 'a1'))
    expect(flagged.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
    expect(flagged.score.black).toBe(crossed.score.black + decisive('general'))
    expect(flagged.score.white).toBe(crossed.score.white)
  })
})

// ---------------------------------------------------------------------------
// THE KEY PROPERTY — every point ever paid is reproducible from the public log
// ---------------------------------------------------------------------------

/** 爆裂物-rich so 有煙無傷 actually happens; the standard table almost never fizzles. */
const BOMBY: RankDistribution = {
  commander: 1, general: 1, division: 1, brigade: 1, regiment: 1,
  battalion: 1, company: 1, platoon: 1, engineer: 3, flag: 1, bomb: 4,
}

function started(id: string, config: Partial<GameConfig>): GameState {
  let s = createGame(id, { clockEnabled: false, ...config })
  s = submitAssignment(s, 'white', defaultAssignment('white', s))
  s = submitAssignment(s, 'black', defaultAssignment('black', s))
  return s
}

/** Random legal play to a finish, or a resignation if the budget runs out. */
function playOut(id: string, config: Partial<GameConfig>, seed: number): GameState {
  let state = started(id, config)
  let r = seed >>> 0
  for (let i = 0; i < 80 && state.status.kind === 'playing'; i++) {
    const ms: Move[] = legalMoves(state, state.toMove).filter((m) => m.kind !== 'pass')
    if (ms.length === 0) break
    r = (r * 1664525 + 1013904223) >>> 0
    state = applyMove(state, ms[r % ms.length]!)
  }
  return state.status.kind === 'over' ? state : resign(state, 'black')
}

/**
 * Rebuild the ENTIRE score chain from public information only.
 *
 * The viewer here is `spectator-public` — the strictest one in the system, with
 * no colour and no seat. It gets three things and nothing else: the config, the
 * public log, and the sequence of redacted boards `replayGame` reconstructs by
 * re-applying that log. From those it computes both of §7.1's sources:
 *
 *   ① `captureScore(outcome, mover, config)` — reads only the announcement;
 *   ② the count of the mover's own pieces standing on 計分格, which needs the
 *      board but never a 兵種, and is skipped on a 奪旗-ending ply (§7.6).
 *
 * If the engine's payment ever depended on something this viewer cannot see —
 * the loser's rank, whether a fizzle survivor was 工兵 or 軍旗, which of the
 * three 同歸於盡 cases fired — the chain diverges and the test fails. That is
 * 附錄 A(d) expressed as an executable property rather than a promise.
 */
function publicChain(vs: ViewerState): { white: number; black: number }[] {
  const frames = replayGame(vs, { kind: 'spectator-public' })
  expect(frames.length).toBe(vs.log.length + 1)

  const endedInAction = vs.status.kind === 'over'
    && (vs.status.result.kind === 'flag' || vs.status.result.kind === 'flag-both')

  const chain = [{ white: 0, black: vs.config.komi }]
  vs.log.forEach((e, i) => {
    const prev = chain[i]!
    const next = { white: prev.white, black: prev.black }

    if (e.combat) {
      const pay = captureScore(e.combat.outcome, e.color, vs.config)
      next.white += pay.white
      next.black += pay.black
    }

    if (!(endedInAction && i === vs.log.length - 1)) {
      next[e.color] += frames[i + 1]!.pieces.filter(
        (p) => p.color === e.color
          && p.square !== null
          && vs.config.scoringSquares.includes(p.square),
      ).length
    }

    chain.push(next)
  })
  return chain
}

describe('附錄 A(d) as a property — the score chain is derivable from the public log alone', () => {
  /**
   * Two halves, and the corpus needs both or the property has a blind spot.
   *
   * At the default X = 40, k = 3 makes a single capture worth up to 30, so every
   * game races to a 分數 ending and NO game ever ends in ① — the §7.6 interaction
   * (奪旗 pays ① and skips ②) would never appear in a single frame. Lifting X out
   * of reach turns the same seeds into 奪旗 endings instead. Measured: the first
   * block ends 16/16 on score, the second 11/16 on 奪旗 with a contact on the
   * final ply, 5/16 on the resignation fallback.
   */
  const CORPUS = [
    ...Array.from({ length: 6 }, (_, g) => playOut(`std${g}`, SCORED, 1000 + g * 7919)),
    ...Array.from(
      { length: 6 },
      (_, g) => playOut(`bmb${g}`, { ...SCORED, distribution: BOMBY }, 1000 + g * 7919),
    ),
    ...Array.from(
      { length: 8 },
      (_, g) => playOut(
        `flg${g}`,
        { ...SCORED, distribution: BOMBY, scoreTarget: 500 },
        1000 + g * 7919,
      ),
    ),
  ]

  it('exercises all four CombatOutcome variants — otherwise the property is vacuous', () => {
    const kinds = new Set<CombatOutcome['kind']>()
    let contacts = 0
    for (const g of CORPUS) {
      for (const e of g.log) {
        if (!e.combat) continue
        contacts++
        kinds.add(e.combat.outcome.kind)
      }
    }
    expect(contacts).toBeGreaterThan(40)
    expect([...kinds].sort()).toEqual(
      ['attacker-wins', 'defender-wins', 'fizzle', 'mutual-destruction'],
    )
  })

  it('exercises BOTH endings, including a 奪旗 that landed on a contact (§7.6)', () => {
    // Without this the corpus can silently drift into "every game ends on
    // points", and the ply where ① is paid but ② is skipped never gets checked
    // by the property at all — which is exactly the case §7.6 exists to settle.
    let onScore = 0
    let flagOnContact = 0
    for (const g of CORPUS) {
      if (g.status.kind !== 'over') continue
      if (g.status.result.kind === 'score') onScore++
      if (g.status.result.kind === 'flag' || g.status.result.kind === 'flag-both') {
        if (g.log[g.log.length - 1]?.combat) flagOnContact++
      }
    }
    expect(onScore).toBeGreaterThan(0)
    expect(flagOnContact).toBeGreaterThan(0)
  })

  it('pays SOMETHING — a corpus in which every payment is zero proves nothing', () => {
    const moved = CORPUS.some((g) =>
      g.log.some((e, i) => {
        if (!e.combat) return false
        const pay = captureScore(e.combat.outcome, e.color, g.config)
        return pay.white !== 0 || pay.black !== 0
      }),
    )
    expect(moved).toBe(true)
  })

  it('reproduces every scoreAfter, and the final score, for every game', () => {
    for (const g of CORPUS) {
      const vs = stateForViewer(g, { kind: 'spectator-public' })
      const chain = publicChain(vs)
      vs.log.forEach((e, i) => {
        expect(chain[i + 1], `${g.id} ply ${e.ply}`).toEqual(e.scoreAfter)
      })
      expect(chain[chain.length - 1], `${g.id} final`).toEqual(vs.score)
    }
  })

  it('credits the non-mover EXACTLY when the announcement says so, and never otherwise', () => {
    // The sharp half of the property. ② is mover-only, so the idle column may
    // move on a ply if and only if ① paid it: a 守方勝, or a 有煙無傷 whose
    // survivor is the idle colour. Anything else moving that column is a leak or
    // a misdirected payment.
    let idleCredits = 0
    for (const g of CORPUS) {
      const base = { white: 0, black: g.config.komi }
      g.log.forEach((e, i) => {
        const prev = i > 0 ? g.log[i - 1]!.scoreAfter : base
        const idle: Color = e.color === 'white' ? 'black' : 'white'
        const delta = e.scoreAfter[idle] - prev[idle]
        if (delta === 0) return
        idleCredits++
        const outcome = e.combat?.outcome
        expect(outcome, `${g.id} ply ${e.ply}: idle column moved with no contact`).toBeDefined()
        expect(delta).toBe(captureScore(outcome!, e.color, g.config)[idle])
        expect(
          outcome!.kind === 'defender-wins'
          || (outcome!.kind === 'fizzle' && outcome!.survivorColor === idle),
        ).toBe(true)
      })
    }
    expect(idleCredits).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The default is a no-op
// ---------------------------------------------------------------------------

describe('§7.3 at the shipped default — the engine behaves exactly as it did before', () => {
  it('leaves the idle column frozen for whole games, contacts and all', () => {
    // This is the pre-§7.3 invariant, restated as what the ZERO default buys:
    // with k = 0 and 有煙無傷獎勵 = 0 the only live source is ②, which credits
    // the mover alone, so no ply can move the other column. It is the reason
    // every existing expectation in the suite survived this change untouched.
    let contacts = 0
    for (let g = 0; g < 6; g++) {
      const played = playOut(`dflt${g}`, {}, 1000 + g * 7919)
      expect(played.config.captureScoreK).toBe(0)
      expect(played.config.fizzleBonus).toBe(0)
      const base = { white: 0, black: played.config.komi }
      played.log.forEach((e, i) => {
        if (e.combat) contacts++
        const prev = i > 0 ? played.log[i - 1]!.scoreAfter : base
        const idle: Color = e.color === 'white' ? 'black' : 'white'
        expect(e.scoreAfter[idle], `${played.id} ply ${e.ply}`).toBe(prev[idle])
      })
    }
    expect(contacts).toBeGreaterThan(10)
  })

  it('plays a game byte-identically with the knobs written out as zero', () => {
    const implicit = playOut('same-a', {}, 424242)
    const explicit = playOut('same-a', { captureScoreK: 0, fizzleBonus: 0 }, 424242)
    expect(explicit.score).toEqual(implicit.score)
    expect(explicit.log).toEqual(implicit.log)
    expect(explicit.status).toEqual(implicit.status)
  })
})

// ---------------------------------------------------------------------------
// §7.4 — 吃子得分 must not break the no-tie guarantee
// ---------------------------------------------------------------------------

/**
 * §7.4:「貼目為非整數，故分數永不相等，所有以分數判定的結局皆有勝方。」
 *
 * That guarantee is not self-supporting — it holds only while 貼目 is the ONLY
 * non-integer source of points. §7.1's 佔領分 are counts, so they always are.
 * §7.3 is the first rule that could break it, which is why 附錄 B requires k and
 * 有煙無傷獎勵 to be whole numbers.
 *
 * The failure it prevents is silent, not loud. At k = 0.5 a white 司令 win pays
 * 0.5, black sits on 貼目 0.5 alone, and a 停滯 or 分數 finish arrives with the
 * two columns exactly equal — at which point `leader()` returns black because
 * `score.white > score.black` is false. Black wins on a comparison, with no rule
 * behind it, in a game the rulebook says cannot be tied.
 *
 * The engine deliberately does NOT enforce this: 附錄 B says the rules layer must
 * not depend on a parameter's value, so the constraint is applied where config is
 * accepted — the server's `clampWholeNumber`, the two bot CLIs, and the create
 * form. Those are three separate doors and none of them is type-checked into the
 * others, so the tests below pin the GUARANTEE rather than any one of the clamps:
 * if a fourth door is ever added, this is what should fail.
 */
describe('§7.4 無平局保證 — 貼目 stays the only non-integer source (附錄 B)', () => {
  const isHalf = (n: number) => Number.isInteger(n - 0.5)

  it('keeps white integral and black half-integral all game, at whole-number knobs', () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 25; seed++) {
      const g = playOut(`tie-${seed}`, { captureScoreK: K, fizzleBonus: FIZZLE }, seed * 7717)
      // komi is DEFAULT_CONFIG's 0.5, so black carries the half and white cannot.
      if (!Number.isInteger(g.score.white)) bad.push(`seed ${seed}: white ${g.score.white}`)
      if (!isHalf(g.score.black)) bad.push(`seed ${seed}: black ${g.score.black}`)
      if (g.score.white === g.score.black) bad.push(`seed ${seed}: TIED at ${g.score.white}`)
      for (const e of g.log) {
        if (!Number.isInteger(e.scoreAfter.white) || !isHalf(e.scoreAfter.black)) {
          bad.push(`seed ${seed} ply ${e.ply}: ${JSON.stringify(e.scoreAfter)}`)
          break
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('never ties on any ply of any game, so §7.5②/§7.5③ always have a winner', () => {
    let plies = 0
    for (let seed = 1; seed <= 25; seed++) {
      const g = playOut(`notie-${seed}`, { captureScoreK: K, fizzleBonus: FIZZLE }, seed * 104729)
      for (const e of g.log) {
        plies++
        expect(e.scoreAfter.white, `seed ${seed} ply ${e.ply}`).not.toBe(e.scoreAfter.black)
      }
    }
    // non-vacuous: the corpus really did play games
    expect(plies).toBeGreaterThan(200)
  })

  it('is what a FRACTIONAL k destroys — the reason 附錄 B says whole numbers', () => {
    // Not a wish: at k = 0.5 the engine really does produce an exact tie, and
    // this is the shape of it. 司令 = 階級 1, so a single decisive win pays
    // 0.5 × 1 = 0.5 — precisely 貼目, and precisely the collision.
    const pay = captureScore(
      { kind: 'attacker-wins', winnerRank: 'commander' },
      'white',
      { ...DEFAULT_CONFIG, captureScoreK: 0.5 },
    )
    expect(pay.white).toBe(0.5)
    expect(pay.white).toBe(DEFAULT_CONFIG.komi)
    expect(Number.isInteger(pay.white)).toBe(false)

    // …and with the whole number 附錄 B requires, the collision cannot be built:
    // every payment is an integer, so white's column never reaches 貼目's half.
    for (const rank of ALL_RANKS) {
      if (rank === 'bomb') continue
      const whole = captureScore({ kind: 'attacker-wins', winnerRank: rank }, 'white', CONFIG)
      expect(Number.isInteger(whole.white), `k × ${rank}`).toBe(true)
    }
  })
})
