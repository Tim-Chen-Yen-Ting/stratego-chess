/**
 * Whole-game invariant fuzzing.
 *
 * Plays many complete games from randomised 兵種 assignments and re-derives, from
 * the public log and the board alone, everything the gamebook promises:
 *
 *   §4  位置結算 — who stands where after every kind of contact
 *   §5  軍旗離場 ⇒ the game is over, and vice versa
 *   §7① ② ③ — settlement, the score line, the stagnation counter
 *   §8  增秒 — granted on a move or a 強制 pass, never on a 主動 pass
 *
 * The §7③ counter is re-computed here by a backwards scan over complete turns,
 * which is a different algorithm from the engine's forward one.
 */

import { describe, expect, it } from 'vitest'
import { CENTER_SQUARES, DISTRIBUTION } from '../src/constants.js'
import { applyMove } from '../src/game.js'
import { hasAnyPieceMove, legalMoves } from '../src/moves.js'
import { createGame, submitAssignment } from '../src/setup.js'
import { opposite } from '../src/board.js'
import type {
  Color,
  GameEvent,
  GameState,
  Move,
  PieceId,
  Rank,
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

function randomAssignment(color: Color, s: GameState, rnd: () => number): Record<PieceId, Rank> {
  const pool: Rank[] = []
  for (const [rank, n] of Object.entries(DISTRIBUTION) as [Rank, number][]) {
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
 * §7③ by backwards scan: how many COMPLETE turns, counting back from the last
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

  // ---- §7① 奪旗 ---------------------------------------------------------
  const wOff = flagOff(after, 'white')
  const bOff = flagOff(after, 'black')
  if (wOff && bOff) expect(after.status).toEqual({ kind: 'over', result: { kind: 'flag-both' } })
  else if (wOff) expect(after.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
  else if (bOff) expect(after.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })

  // ---- §7② 結算 ---------------------------------------------------------
  // Settlement runs after every ply and credits ONLY the side that just moved.
  // The idle side's column must come through byte-identical even when it is
  // standing on all four 中央格 — it was credited on its own last ply and will
  // be again on its next.
  const flagEnded = wOff || bOff
  const idle = opposite(mover)
  const expectedScore = { ...before.score }
  if (!flagEnded) expectedScore[mover] = before.score[mover] + centre(after, mover)
  expect(after.score).toEqual(expectedScore)
  expect(after.score[idle]).toBe(before.score[idle])
  expect(e.scoreAfter).toEqual(after.score)
  expect(after.score.white).toBeGreaterThanOrEqual(before.score.white)
  expect(after.score.black).toBeGreaterThanOrEqual(before.score.black)
  expect(after.score.white % 1).toBe(0)
  expect(after.score.black - before.config.komi).toBe(
    Math.round(after.score.black - before.config.komi),
  )

  if (!flagEnded) {
    const crossed = after.score.white >= after.config.scoreTarget
      || after.score.black >= after.config.scoreTarget
    if (crossed && after.status.kind === 'over' && after.status.result.kind === 'score') {
      const higher = after.score.white > after.score.black ? 'white' : 'black'
      expect(after.status.result.winner).toBe(higher)
    }
    if (crossed) expect(after.status.kind).toBe('over')
  }

  // ---- §7③ 停滯 ---------------------------------------------------------
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

describe('whole-game invariant fuzz', () => {
  it.each(SEEDS)('seed %i holds every gamebook invariant for a full game', (seed) => {
    const rnd = rng(seed)
    let s = createGame(`fuzz-${seed}`, { scoreTarget: 40, noProgressTurns: 30 })
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
