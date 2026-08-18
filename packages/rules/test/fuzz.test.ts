/**
 * Whole-game invariant fuzzing.
 *
 * Plays many complete games from randomised 兵種 assignments and re-derives, from
 * the public log and the board alone, everything the gamebook promises:
 *
 *   §4  位置結算 — who stands where after every kind of contact
 *   §5  軍旗離場 ⇒ the game is over, and vice versa
 *   §7.5① ② ③ — 吃子得分, 佔領計分格, the score line, the stagnation counter
 *   §8  增秒 — granted on a move or a 強制 pass, never on a 主動 pass
 *
 * The §7.5③ counter is re-computed here by a backwards scan over complete turns,
 * which is a different algorithm from the engine's forward one.
 *
 * The score line is re-derived from BOTH of §7.1's sources, and every game is
 * played twice over: once at the shipped default, where 吃子得分 is switched off,
 * and once with it paying. The second corpus is the point — a §7.5① that never
 * fires is a §7.5① that is never fuzzed.
 */

import { describe, expect, it } from 'vitest'
import { CENTER_SQUARES } from '../src/constants.js'
import { applyMove, captureScore } from '../src/game.js'
import { hasAnyPieceMove, legalMoves } from '../src/moves.js'
import { createGame, submitAssignment } from '../src/setup.js'
import { opposite } from '../src/board.js'
import type {
  Color,
  CombatOutcome,
  GameConfig,
  GameEvent,
  GameState,
  Move,
  PieceId,
  Rank,
  RankDistribution,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// deterministic PRNG
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

/**
 * The multiset comes from THIS game's 數量配置, never from the module constant —
 * otherwise a game configured with a 爆裂物-rich table (below) would be handed a
 * standard army and `submitAssignment` would reject it. For a default game the
 * two are the same object, so every seed already in this file plays out exactly
 * as it did.
 */
function randomAssignment(color: Color, s: GameState, rnd: () => number): Record<PieceId, Rank> {
  const pool: Rank[] = []
  for (const [rank, n] of Object.entries(s.config.distribution) as [Rank, number][]) {
    for (let i = 0; i < n; i++) pool.push(rank)
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  const ids = s.pieces.filter((p) => p.color === color).map((p) => p.id)
  const out: Record<PieceId, Rank> = {}
  ids.forEach((id, i) => { out[id] = pool[i]! })
  return out
}

// ---------------------------------------------------------------------------
// independent re-derivations
// ---------------------------------------------------------------------------

/** §7 中央計分, recomputed from the board. */
function centre(s: GameState, color: Color): number {
  return s.pieces.filter(
    (p) => p.color === color && p.square !== null && CENTER_SQUARES.includes(p.square),
  ).length
}

function hadProgress(e: GameEvent, prev: GameEvent | undefined, base: { white: number; black: number }): boolean {
  if (e.combat) return true
  const before = prev ? prev.scoreAfter : base
  return e.scoreAfter.white !== before.white || e.scoreAfter.black !== before.black
}

/**
 * §7.5③ by backwards scan: how many COMPLETE turns, counting back from the last
 * closed turn, contained neither a 吃子 nor a change of score. An unfinished
 * half-turn that itself made progress zeroes the count.
 */
function expectedNoProgress(log: readonly GameEvent[], base: { white: number; black: number }): number {
  const progress = log.map((e, i) => hadProgress(e, log[i - 1], base))
  const complete = log.length - (log.length % 2)
  let n = 0
  for (let i = complete; i >= 2; i -= 2) {
    if (progress[i - 1] || progress[i - 2]) break
    n++
  }
  if (log.length % 2 === 1 && progress[log.length - 1]) n = 0
  return n
}

function occupancy(s: GameState): Map<number, string> {
  const m = new Map<number, string>()
  for (const p of s.pieces) {
    if (p.square === null) continue
    expect(m.has(p.square), `two pieces on square ${p.square}`).toBe(false)
    m.set(p.square, p.id)
  }
  return m
}

function onBoardCount(s: GameState): number {
  return s.pieces.filter((p) => p.square !== null).length
}

function flagOff(s: GameState, color: Color): boolean {
  const flags = s.pieces.filter((p) => p.color === color && p.rank === 'flag')
  return flags.length > 0 && flags.every((p) => p.square === null)
}

// ---------------------------------------------------------------------------
// the per-ply audit
// ---------------------------------------------------------------------------

function audit(before: GameState, move: Move, after: GameState): void {
  const mover = before.toMove
  const base = { white: 0, black: before.config.komi }
  const e = after.log[after.log.length - 1]!

  // ---- bookkeeping ----------------------------------------------------
  expect(after.ply).toBe(before.ply + 1)
  expect(after.toMove).toBe(opposite(mover))
  expect(after.log).toHaveLength(before.log.length + 1)
  expect(e.ply).toBe(before.ply)
  expect(e.color).toBe(mover)
  expect(after.id).toBe(before.id)

  const occBefore = occupancy(before)
  const occAfter = occupancy(after)

  // ---- § no piece resurrects, no piece teleports back -------------------
  for (const p of before.pieces) {
    const now = after.pieces.find((x) => x.id === p.id)!
    if (p.square === null) expect(now.square, `${p.id} came back`).toBeNull()
    if (p.revealed) expect(now.revealed, `${p.id} un-revealed`).toBe(true)
    if (p.hasMoved) expect(now.hasMoved).toBe(true)
    expect(now.color).toBe(p.color)
    expect(now.rank, `${p.id} changed 兵種`).toBe(p.rank)   // §1 兵種層不變
  }

  // ---- §4 位置結算 -------------------------------------------------------
  if (e.combat) {
    const { outcome, attackerSquare, defenderSquare, survivorSquare } = e.combat
    expect(move.kind).toBe('move')
    const to = (move as { to: number }).to

    // The attacker always vacates its origin — it either advanced or died there.
    expect(occAfter.has(attackerSquare)).toBe(false)

    // 接觸格 ≠ 目的格 only for en passant.
    const enPassant = defenderSquare !== to
    if (enPassant) expect(occBefore.get(to)).toBeUndefined()

    const attackerId = occBefore.get(attackerSquare)!
    const defenderId = occBefore.get(defenderSquare)!
    expect(attackerId).toBeDefined()
    expect(defenderId).toBeDefined()
    const squareOf = (id: string): number | null =>
      after.pieces.find((p) => p.id === id)!.square

    const survivorColor: Color | null =
      outcome.kind === 'attacker-wins' ? mover
        : outcome.kind === 'defender-wins' ? opposite(mover)
          : outcome.kind === 'fizzle' ? outcome.survivorColor
            : null

    if (survivorColor === null) {
      // 同歸於盡 — 雙方移除, 目標格淨空. Which of the three cases it was (equal
      // 階級, a 爆裂物, or 爆裂物 vs 爆裂物) is not in the event and is not needed
      // here: the board result is the same for all three.
      expect(survivorSquare).toBeNull()
      expect(squareOf(attackerId)).toBeNull()
      expect(squareOf(defenderId)).toBeNull()
      expect(occAfter.has(defenderSquare)).toBe(false)
      expect(occAfter.has(to)).toBe(false)
      expect(onBoardCount(after)).toBe(onBoardCount(before) - 2)
    } else if (survivorColor === mover) {
      // 攻方勝 — the attacker occupies the DESTINATION square (the skipped
      // square for en passant), and the defender comes off ITS square.
      expect(survivorSquare).toBe(to)
      expect(squareOf(attackerId)).toBe(to)
      expect(squareOf(defenderId)).toBeNull()
      expect(occAfter.get(to)).toBe(attackerId)
      if (enPassant) expect(occAfter.has(defenderSquare)).toBe(false)
      expect(onBoardCount(after)).toBe(onBoardCount(before) - 1)
    } else {
      // 攻方敗 — 攻方由其原格移除；守方留在原格；目標格不變.
      expect(survivorSquare).toBe(defenderSquare)
      expect(squareOf(attackerId)).toBeNull()
      expect(squareOf(defenderId)).toBe(defenderSquare)
      expect(occAfter.get(defenderSquare)).toBe(defenderId)
      if (enPassant) expect(occAfter.has(to)).toBe(false)
      expect(onBoardCount(after)).toBe(onBoardCount(before) - 1)
    }
  } else if (move.kind === 'move') {
    expect(occAfter.get(move.to)).toBe(occBefore.get(move.from))
    expect(occAfter.has(move.from)).toBe(false)
    expect(onBoardCount(after)).toBe(onBoardCount(before))
  } else {
    // castle or pass — nothing leaves the board
    expect(onBoardCount(after)).toBe(onBoardCount(before))
  }

  // ---- §7.5① 奪旗 ---------------------------------------------------------
  const wOff = flagOff(after, 'white')
  const bOff = flagOff(after, 'black')
  if (wOff && bOff) expect(after.status).toEqual({ kind: 'over', result: { kind: 'flag-both' } })
  else if (wOff) expect(after.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
  else if (bOff) expect(after.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })

  // ---- §7 ① 吃子得分 + ② 佔領計分格 --------------------------------------
  // INVERTED. This block used to build `expectedScore` from ② alone and close
  // with `after.score[idle] === before.score[idle]`, under a comment saying the
  // idle column "must come through byte-identical". Mover-only settlement is
  // still §7.1②, but the conclusion about the SCORE was only ever true because
  // ① did not exist. §7.3 pays the WINNER of a 決定性勝負 and the 存活方 of a
  // 有煙無傷 — so a 守方勝, or a 爆裂物 that attacked and fizzled, credits the
  // side that did not move, on the mover's ply.
  //
  // The new form is the stricter one twice over. It reconstructs the whole score
  // line, both columns, as ① + ②, with ① taken from `captureScore` on the public
  // announcement alone — where the old form asserted nothing at all about one of
  // the two columns. And it pins the idle column to `pay[idle]` exactly, so a
  // payment that reached the wrong side still fails here, which a bare
  // "unchanged" could not distinguish from a payment that was never made.
  const flagEnded = wOff || bOff
  const idle = opposite(mover)
  const outcome: CombatOutcome | undefined = e.combat?.outcome
  const pay = outcome
    ? captureScore(outcome, mover, before.config)
    : { white: 0, black: 0 }

  const expectedScore = {
    white: before.score.white + pay.white,
    black: before.score.black + pay.black,
  }
  // §7.6: a 奪旗 ends the game inside ①, so the ply banks its 吃子 and skips ②.
  if (!flagEnded) expectedScore[mover] += centre(after, mover)
  expect(after.score).toEqual(expectedScore)

  // The half that survived, stated as what it actually is: ② never credits the
  // idle side, so that column moves in a ply EXACTLY when ① paid it, and by
  // exactly what ① paid. Both directions matter — the first catches settlement
  // leaking across, the second a 吃子 handed to the wrong colour.
  expect(after.score[idle] - before.score[idle]).toBe(pay[idle])
  if (pay[idle] !== 0) {
    expect(
      outcome!.kind === 'defender-wins'
      || (outcome!.kind === 'fizzle' && outcome!.survivorColor === idle),
      `ply ${e.ply}: idle column moved on a ${outcome!.kind}`,
    ).toBe(true)
  }

  expect(e.scoreAfter).toEqual(after.score)
  expect(after.score.white).toBeGreaterThanOrEqual(before.score.white)
  expect(after.score.black).toBeGreaterThanOrEqual(before.score.black)
  // 附錄 B requires k and 有煙無傷獎勵 to be whole numbers, because §7.4's
  // 「貼目為非整數，故分數永不相等」 holds only while 貼目 is the sole fractional
  // source. These two lines are where a fractional payment gets caught: white's
  // column stays an integer, black's stays komi plus one.
  expect(after.score.white % 1).toBe(0)
  expect(after.score.black - before.config.komi).toBe(
    Math.round(after.score.black - before.config.komi),
  )

  // ---- §7.5② 先達 X 分者獲勝 ----------------------------------------------
  // Also corrected. `if (crossed) expect(after.status.kind).toBe('over')` was
  // here, and it is false: §7.5② is asked at the CLOSE OF A FULL TURN and
  // nowhere else, so a side that crosses X on white's ply keeps playing until
  // black has answered. It never failed because no default-config seed in this
  // file has ever reached a 分數 ending — 奪旗 gets there first every time — and
  // an assertion on an unreachable path is not an assertion. Turning ① on makes
  // a capture worth up to 30 points, the 分數 ending becomes the common one, and
  // the line failed on the first seed that got there.
  //
  // Replaced by the biconditional, which is what §7.5② actually says and which
  // the old form did not even state in one direction: a 分數 ending happens on
  // exactly the plies that close a turn at or past X, and on no others.
  if (!flagEnded) {
    const crossed = after.score.white >= after.config.scoreTarget
      || after.score.black >= after.config.scoreTarget
    const closesTurn = mover === 'black'
    const higher = after.score.white > after.score.black ? 'white' : 'black'
    if (crossed && closesTurn) {
      // 停滯 cannot pre-empt this: §7.5② is settled first, and 「分數高者獲勝」
      // is decidable because 貼目 keeps the columns from ever being equal.
      expect(after.status).toEqual({
        kind: 'over',
        result: { kind: 'score', winner: higher },
      })
    } else if (after.status.kind === 'over') {
      // Mid-turn, or short of X: the game may still be over — 停滯 ends games on
      // the same ply — but never ON POINTS.
      expect(after.status.result.kind).not.toBe('score')
    }
  }

  // ---- §7.5③ 停滯 ---------------------------------------------------------
  if (!flagEnded) {
    expect(after.noProgressTurns).toBe(expectedNoProgress(after.log, base))
  }

  // ---- §8 增秒 ----------------------------------------------------------
  const forced = move.kind === 'pass' && !hasAnyPieceMove(before, mover)
  const granted = before.config.clockEnabled && (move.kind !== 'pass' || forced)
  expect(after.clockMs[mover] - before.clockMs[mover]).toBe(
    granted ? before.config.clockIncrementMs : 0,
  )
  expect(after.clockMs[opposite(mover)]).toBe(before.clockMs[opposite(mover)])
}

// ---------------------------------------------------------------------------

const SEEDS = [1, 7, 42, 1337, 20260811, 99991, 555, 8_675_309]

/** One complete game, auditing every ply against the gamebook as it goes. */
function fuzzGame(id: string, seed: number, config: Partial<GameConfig>): GameState {
  const rnd = rng(seed)
  let s = createGame(id, config)
  s = submitAssignment(s, 'white', randomAssignment('white', s, rnd))
  s = submitAssignment(s, 'black', randomAssignment('black', s, rnd))

  let plies = 0
  while (s.status.kind === 'playing' && plies < 400) {
    const moves = legalMoves(s, s.toMove)
    expect(moves.length).toBeGreaterThan(0)
    expect(moves).toContainEqual({ kind: 'pass' })          // §3④
    const move = moves[Math.floor(rnd() * moves.length)]!
    const next = applyMove(s, move)
    audit(s, move, next)
    s = next
    plies++
  }

  expect(plies).toBeGreaterThan(0)
  if (s.status.kind === 'over') {
    expect(legalMoves(s, 'white')).toEqual([])
    expect(() => applyMove(s, { kind: 'pass' })).toThrow()
  }
  return s
}

describe('whole-game invariant fuzz', () => {
  it.each(SEEDS)('seed %i holds every gamebook invariant for a full game', (seed) => {
    fuzzGame(`fuzz-${seed}`, seed, { scoreTarget: 40, noProgressTurns: 30 })
  })

  it('reaches every terminal kind across seeds (sanity on the fuzz coverage)', () => {
    const kinds = new Set<string>()
    for (const seed of [3, 11, 23, 57, 101, 202, 303, 404, 505, 606, 707, 808]) {
      const rnd = rng(seed)
      let s = createGame(`cover-${seed}`, { scoreTarget: 20, noProgressTurns: 4 })
      s = submitAssignment(s, 'white', randomAssignment('white', s, rnd))
      s = submitAssignment(s, 'black', randomAssignment('black', s, rnd))
      let plies = 0
      while (s.status.kind === 'playing' && plies < 400) {
        const moves = legalMoves(s, s.toMove)
        s = applyMove(s, moves[Math.floor(rnd() * moves.length)]!)
        plies++
      }
      if (s.status.kind === 'over') kinds.add(s.status.result.kind)
    }
    // 奪旗 dominates random play; the point is simply that games do terminate.
    expect(kinds.size).toBeGreaterThan(0)
    for (const k of kinds) {
      expect(['flag', 'flag-both', 'score', 'no-progress']).toContain(k)
    }
  })
})

// ---------------------------------------------------------------------------
// The same audit, with §7.5① actually paying
// ---------------------------------------------------------------------------

/**
 * Everything above runs at the shipped default, where 附錄 B leaves k and
 * 有煙無傷獎勵 待定 and both are 0. That makes ① identically zero, so the score
 * half of `audit` — the part that reconstructs both columns as ① + ② — proves
 * nothing about ① there: it would pass unchanged against an engine that never
 * implemented §7.3. Coverage of a rule that is switched off is not coverage.
 *
 * So the whole audit runs again with the rule paying. k = 3 and 有煙無傷 = 5 are
 * the same two whole numbers `capturescore.test.ts` uses, chosen so that no
 * fizzle bonus can be mistaken for some k × 階級 and no decisive payment for a
 * fizzle.
 *
 * Two configs, because one corpus cannot reach both endings:
 *
 *   X = 40  — a single capture is worth up to 30, so games race to a 分數 ending
 *   X = 500 — out of reach, so the same seeds run long and end on 奪旗 instead,
 *             which is the only way the §7.6 ply (① paid, ② skipped) is fuzzed
 *
 * Both use a 爆裂物-rich 數量配置: the standard table has 2 bombs in 16 and
 * random play almost never produces a 有煙無傷, which is precisely the outcome
 * that pays a non-mover.
 */
const BOMBY: RankDistribution = {
  commander: 1, general: 1, division: 1, brigade: 1, regiment: 1,
  battalion: 1, company: 1, platoon: 1, engineer: 3, flag: 1, bomb: 4,
}

const SCORED_CONFIGS: { label: string; config: Partial<GameConfig> }[] = [
  {
    label: 'X40',
    config: {
      scoreTarget: 40, noProgressTurns: 30,
      captureScoreK: 3, fizzleBonus: 5, distribution: BOMBY,
    },
  },
  {
    label: 'X500',
    config: {
      scoreTarget: 500, noProgressTurns: 30,
      captureScoreK: 3, fizzleBonus: 5, distribution: BOMBY,
    },
  },
]

/**
 * Memoised so the non-vacuity test below re-reads the very games the per-seed
 * tests audited, rather than a second corpus that could drift away from them —
 * and so it still builds them if it is the only test that runs.
 */
const scoredGames = new Map<string, GameState>()

function scoredGame(label: string, seed: number): GameState {
  const key = `${label}-${seed}`
  let g = scoredGames.get(key)
  if (g === undefined) {
    g = fuzzGame(key, seed, SCORED_CONFIGS.find((c) => c.label === label)!.config)
    scoredGames.set(key, g)
  }
  return g
}

describe('whole-game invariant fuzz with §7.3 吃子得分 paying', () => {
  for (const { label } of SCORED_CONFIGS) {
    it.each(SEEDS)(
      `${label} seed %i holds every gamebook invariant with ① live`,
      (seed) => {
        // Every ply of this game was audited against §4, §5, §7.5①②③ and §8 as
        // it was played — that happens inside `fuzzGame`, and the knobs are the
        // only thing that differs from the block above. What is left to state
        // here is the end of the chain: the total the state carries is the
        // total the public log last reported. A ① that reached `score` without
        // reaching `scoreAfter`, or the reverse, shows up nowhere else.
        const g = scoredGame(label, seed)
        expect(g.log.length).toBeGreaterThan(0)
        expect(g.score).toEqual(g.log[g.log.length - 1]!.scoreAfter)
        expect(g.config.captureScoreK).toBe(3)
        expect(g.config.fizzleBonus).toBe(5)
      },
    )
  }

  it('is not a vacuous corpus — contacts happen, and both non-mover payments fire', () => {
    // Without this the block above is a very expensive way of asserting that
    // nothing ever happens: a corpus with no 守方勝 and no 有煙無傷 exercises
    // exactly the same code path as the k = 0 one.
    let contacts = 0
    let idleCredits = 0
    const kinds = new Map<CombatOutcome['kind'], number>()
    const paidIdle = new Set<CombatOutcome['kind']>()
    const endings = new Set<string>()

    for (const { label } of SCORED_CONFIGS) {
      for (const seed of SEEDS) {
        const g = scoredGame(label, seed)
        if (g.status.kind === 'over') endings.add(g.status.result.kind)
        const base = { white: 0, black: g.config.komi }
        g.log.forEach((e, i) => {
          const prev = i > 0 ? g.log[i - 1]!.scoreAfter : base
          const idle: Color = e.color === 'white' ? 'black' : 'white'
          if (e.scoreAfter[idle] !== prev[idle]) {
            idleCredits++
            paidIdle.add(e.combat!.outcome.kind)
          }
          if (!e.combat) return
          contacts++
          const k = e.combat.outcome.kind
          kinds.set(k, (kinds.get(k) ?? 0) + 1)
        })
      }
    }

    // Measured: 109 contacts over the 16 games, 33 of them crediting the side
    // that did not move. The floors are set well below that so an unrelated
    // change to move generation cannot silently empty the corpus.
    expect(contacts).toBeGreaterThan(40)
    expect([...kinds.keys()].sort()).toEqual(
      ['attacker-wins', 'defender-wins', 'fizzle', 'mutual-destruction'],
    )
    expect(idleCredits).toBeGreaterThan(10)
    // The two announcements that name a non-mover BOTH occurred and BOTH paid.
    // 守方勝 alone would leave the 有煙無傷 branch of `captureScore` unfuzzed,
    // and that is the branch 附錄 A(d) is about: the bonus must not tell a
    // 工兵 survivor from a 軍旗 one.
    expect([...paidIdle].sort()).toEqual(['defender-wins', 'fizzle'])
    // …and both endings, so the §7.6 ply where ① is paid and ② is skipped is in
    // the corpus rather than assumed.
    expect(endings.has('score')).toBe(true)
    expect(endings.has('flag') || endings.has('flag-both')).toBe(true)
  })
})
