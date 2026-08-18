/**
 * Exhaustive invariants over the whole 兵種 × 兵種 matrix, plus the 附錄 A
 * anti-leak constraints.
 *
 *   §2  「一律大吃小，無兵種例外。」
 *   §5  「爆裂物…一次性消耗品。」 — it never survives a contact.
 *   §5  「此為軍旗唯一可能獲勝的接觸」 — 軍旗 wins only against 爆裂物.
 *   附錄 A 「任何規則都不得產生依兵種而異的可觀測行為。」
 */

import { describe, expect, it } from 'vitest'
import { RANK_ORDER } from '../src/constants.js'
import { resolveCombat } from '../src/combat.js'
import { applyMove } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import type { CombatOutcome, Rank } from '../src/types.js'
import { at, lastEvent, mv, pieceById, position, sq } from './helpers.js'

const ALL: Rank[] = [
  'commander', 'general', 'division', 'brigade', 'regiment',
  'battalion', 'company', 'platoon', 'engineer', 'flag', 'bomb',
]

/** Every ordered pair, both colours in the attacker seat. */
const PAIRS = ALL.flatMap((a) => ALL.map((d) => [a, d] as const))

describe('§2 一律大吃小, 無兵種例外', () => {
  it.each(PAIRS)('%s vs %s resolves by RANK_ORDER alone when no 爆裂物 is involved', (a, d) => {
    if (a === 'bomb' || d === 'bomb') return
    const r = resolveCombat(a, d, 'white', 'black')
    const av = RANK_ORDER[a as Exclude<Rank, 'bomb'>]
    const dv = RANK_ORDER[d as Exclude<Rank, 'bomb'>]
    expect(r.attackerSurvives).toBe(av < dv)
    expect(r.defenderSurvives).toBe(dv < av)
  })
})

describe('§5 爆裂物 never survives a contact, in either seat', () => {
  it.each(ALL)('as attacker against %s', (other) => {
    expect(resolveCombat('bomb', other, 'white', 'black').attackerSurvives).toBe(false)
  })

  it.each(ALL)('as defender against %s', (other) => {
    expect(resolveCombat(other, 'bomb', 'white', 'black').defenderSurvives).toBe(false)
  })
})

describe('§5 爆裂物 is neutralised by 工兵 and 軍旗 ONLY, in both directions', () => {
  it.each(ALL)('a %s meeting a bomb survives iff it is 工兵 or 軍旗', (other) => {
    const immune = other === 'engineer' || other === 'flag'
    expect(resolveCombat(other, 'bomb', 'white', 'black').attackerSurvives).toBe(immune)
    expect(resolveCombat('bomb', other, 'white', 'black').defenderSurvives).toBe(immune)
  })

  it('附錄 A(a): both are immune, so the event only narrows to 「工兵 or 軍旗」', () => {
    const a = resolveCombat('engineer', 'bomb', 'white', 'black')
    const b = resolveCombat('flag', 'bomb', 'white', 'black')
    expect(a.outcome).toEqual(b.outcome)
  })
})

describe('§5 「此為軍旗唯一可能獲勝的接觸」', () => {
  it.each(ALL)('軍旗 attacking a %s survives only if it is a 爆裂物', (other) => {
    expect(resolveCombat('flag', other, 'white', 'black').attackerSurvives).toBe(other === 'bomb')
  })

  it.each(ALL)('軍旗 defending against a %s survives only if it is a 爆裂物', (other) => {
    expect(resolveCombat(other, 'flag', 'white', 'black').defenderSurvives).toBe(other === 'bomb')
  })
})

describe('§4 every contact removes at least one piece', () => {
  it.each(PAIRS)('%s vs %s', (a, d) => {
    const r = resolveCombat(a, d, 'white', 'black')
    expect(r.attackerSurvives && r.defenderSurvives).toBe(false)
  })
})

describe('§4.3 翻明 — only a WINNER is ever revealed, and only when there is one', () => {
  it.each(PAIRS)('%s vs %s', (a, d) => {
    const r = resolveCombat(a, d, 'white', 'black')

    // 敗方棋子的兵種層不公開 — a piece that died is never revealed for dying.
    if (!r.attackerSurvives && r.outcome.kind === 'defender-wins') {
      expect(r.revealAttacker).toBe(false)
    }
    if (!r.defenderSurvives && r.outcome.kind === 'attacker-wins') {
      expect(r.revealDefender).toBe(false)
    }

    switch (r.outcome.kind) {
      case 'attacker-wins':
        expect(r.revealAttacker).toBe(true)
        break
      case 'defender-wins':
        expect(r.revealDefender).toBe(true)
        break
      case 'mutual-destruction':
        // Nobody, for any of the three cases this one announcement covers.
        // 翻明 is not a second, milder announcement: a revealed piece hands its
        // rank to every viewer through the piece list, dead or alive, so a
        // reveal flag here would republish through `stateForViewer` precisely
        // what the contentless outcome exists to withhold.
        expect(r.revealAttacker).toBe(false)
        expect(r.revealDefender).toBe(false)
        break
      case 'fizzle':
        // 附錄 A 唯一例外 — the winning 工兵/軍旗 is not revealed either, because
        // revealing it would name it and destroy the two-way ambiguity.
        expect(r.revealAttacker).toBe(false)
        expect(r.revealDefender).toBe(false)
        break
    }
  })

  it('every both-die contact in the whole matrix reveals nobody', () => {
    for (const [a, d] of PAIRS) {
      const r = resolveCombat(a, d, 'white', 'black')
      if (r.attackerSurvives || r.defenderSurvives) continue
      expect(r.outcome, `${a} vs ${d}`).toEqual({ kind: 'mutual-destruction' })
      expect(r.revealAttacker, `${a} vs ${d}`).toBe(false)
      expect(r.revealDefender, `${a} vs ${d}`).toBe(false)
    }
  })
})

describe('附錄 A — what each announcement is allowed to carry', () => {
  const keysOf = (o: CombatOutcome): string[] => Object.keys(o).sort()

  it.each(PAIRS)('%s vs %s announces no more than the gamebook permits', (a, d) => {
    const outcome = resolveCombat(a, d, 'white', 'black').outcome
    switch (outcome.kind) {
      case 'attacker-wins':
      case 'defender-wins':
        expect(keysOf(outcome)).toEqual(['kind', 'winnerRank'])
        break
      case 'mutual-destruction':
        // The whole announcement. No rank, no colour, and no discriminator for
        // a redaction layer to strip — the distinction between an equal-兵種
        // trade, a detonation and 爆裂物 vs 爆裂物 must not exist in the event.
        expect(keysOf(outcome)).toEqual(['kind'])
        break
      case 'fizzle':
        // MUST NOT say which of 工兵/軍旗 survived.
        expect(keysOf(outcome)).toEqual(['kind', 'survivorColor'])
        break
    }
  })

  /**
   * Inverted from the v02 constraint, which required exactly the opposite.
   *
   * Making a detonation distinguishable protected the victim from concluding
   * "so it was my own 階級" — but it did so by publishing that a 爆裂物 had been
   * spent, which let an opponent count both of a side's bombs off the log and
   * then treat a revealed 司令 as provably unkillable. Collapsing the three
   * announcements costs the victim that one inference and takes the whole
   * counting attack off the table with it.
   */
  it('a bomb victim CANNOT tell a detonation from 同階雙亡 — one announcement, both ways', () => {
    const detonateAttacking = resolveCombat('bomb', 'division', 'white', 'black').outcome
    const detonateDefending = resolveCombat('division', 'bomb', 'white', 'black').outcome
    const bombVsBomb = resolveCombat('bomb', 'bomb', 'white', 'black').outcome
    const rankTie = resolveCombat('division', 'division', 'white', 'black').outcome

    for (const o of [detonateAttacking, detonateDefending, bombVsBomb, rankTie]) {
      expect(JSON.stringify(o)).toBe(JSON.stringify(rankTie))
    }

    // …and a fizzle is still its own event, because a piece visibly survives it.
    expect(resolveCombat('bomb', 'engineer', 'white', 'black').outcome.kind).toBe('fizzle')
  })

  it('the winner rank announced is exactly the survivor rank', () => {
    for (const [a, d] of PAIRS) {
      const r = resolveCombat(a, d, 'white', 'black')
      if (r.outcome.kind === 'attacker-wins') expect(r.outcome.winnerRank).toBe(a)
      if (r.outcome.kind === 'defender-wins') expect(r.outcome.winnerRank).toBe(d)
    }
  })
})

describe('附錄 A — no observable behaviour may vary with 兵種', () => {
  it('the move list depends only on the carrier layer', () => {
    const build = (r1: Rank, r2: Rank) =>
      position([
        { at: 'e1', color: 'white', carrier: 'king', rank: r1, id: 'WK' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: r2, id: 'WR' },
        { at: 'd5', color: 'black', carrier: 'queen', rank: 'commander', id: 'BQ' },
      ])
    const base = legalMoves(build('commander', 'general'), 'white')
    for (const [r1, r2] of PAIRS) {
      expect(legalMoves(build(r1, r2), 'white')).toEqual(base)
    }
  })

  it('a 軍旗 may legally be thrown at a piece (附錄 A(b) 自殺移動合法)', () => {
    const s = position([
      { at: 'b2', color: 'white', carrier: 'rook', rank: 'flag', id: 'W' },
      { at: 'b7', color: 'black', carrier: 'rook', rank: 'commander', id: 'B' },
    ])
    expect(legalMoves(s, 'white')).toContainEqual(mv('b2', 'b7'))
  })

  it('the 增秒 rule depends only on whether piece moves exist', () => {
    const build = (r: Rank) =>
      position([
        { at: 'a2', color: 'white', carrier: 'pawn', rank: r, id: 'WP' },
        { at: 'a3', color: 'black', carrier: 'pawn', rank: 'division', id: 'BP' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ])
    const deltas = ALL.map((r) => {
      const before = build(r)
      return applyMove(before, { kind: 'pass' }).clockMs.white - before.clockMs.white
    })
    expect(new Set(deltas).size).toBe(1)
  })
})

describe('§4 「攻方失敗時…此點影響升變與易位權」', () => {
  it('a rook that survives a losing attack never moved, so castling stays available', () => {
    const before = position(
      [
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
        { at: 'h5', color: 'black', carrier: 'rook', rank: 'platoon', id: 'BR' },
      ],
      { toMove: 'black', ply: 2 },
    )
    const after = applyMove(before, mv('h5', 'h1'))       // black attacks and loses
    expect(pieceById(after, 'BR').square).toBeNull()
    expect(pieceById(after, 'WR').square).toBe(sq('h1'))
    expect(pieceById(after, 'WR').hasMoved).toBe(false)
    expect(legalMoves(after, 'white')).toContainEqual({ kind: 'castle', side: 'king' })
  })

  it('a rook that WINS a capture has moved, so castling is gone', () => {
    const before = position([
      { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
      { at: 'h1', color: 'white', carrier: 'rook', rank: 'general', id: 'WR' },
      { at: 'h5', color: 'black', carrier: 'rook', rank: 'platoon', id: 'BR' },
    ])
    const after = applyMove(before, mv('h1', 'h5'))
    expect(pieceById(after, 'WR').hasMoved).toBe(true)
    expect(legalMoves(after, 'white').filter((m) => m.kind === 'castle')).toEqual([])
  })
})

describe('§7.5③ 「本計數僅在中央四格完全淨空…時前進」', () => {
  it('never advances while anybody holds a 中央格', () => {
    let s = position(
      [
        { at: 'd5', color: 'black', carrier: 'knight', rank: 'general', id: 'BN' },
        { at: 'b1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'b8', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ],
      { config: { noProgressTurns: 2, scoreTarget: 10_000 } },
    )
    for (const m of [
      mv('b1', 'a1'), mv('b8', 'a8'), mv('a1', 'b1'), mv('a8', 'b8'),
      mv('b1', 'a1'), mv('b8', 'a8'), mv('a1', 'b1'), mv('a8', 'b8'),
    ]) {
      s = applyMove(s, m)
      expect(s.noProgressTurns).toBe(0)
      expect(s.status).toEqual({ kind: 'playing' })
    }
  })
})

describe('§7 settlement through the en-passant path', () => {
  it('a pawn captured en passant off d5 scores nothing for that ply', () => {
    const before = position(
      [
        { at: 'c5', color: 'white', carrier: 'pawn', rank: 'general', id: 'WP', hasMoved: true },
        { at: 'd7', color: 'black', carrier: 'pawn', rank: 'company', id: 'BP' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'division', id: 'BK' },
      ],
      { toMove: 'black', ply: 2 },
    )
    const dropped = applyMove(before, mv('d7', 'd5'))
    expect(dropped.score).toEqual({ white: 0, black: 1.5 })   // black holds d5

    const taken = applyMove(dropped, mv('c5', 'd6'))
    expect(at(taken, 'd5')).toBeUndefined()
    expect(pieceById(taken, 'WP').square).toBe(sq('d6'))
    expect(lastEvent(taken).combat?.defenderSquare).toBe(sq('d5'))
    // The black pawn was removed in ①, so it does not score d5 for this ply,
    // and the white pawn landed on d6, which is not a 中央格.
    expect(taken.score).toEqual({ white: 0, black: 1.5 })
  })
})
