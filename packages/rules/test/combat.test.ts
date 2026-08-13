/**
 * §4 吃子判定 — the reveal table and 位置結算, exhaustively, in both directions.
 *
 * Every case asserts three separate things, because the gamebook defines three
 * separate things:
 *
 *   1. WHO WAS REMOVED        §4.2 / §4.5 / §5
 *   2. WHICH SQUARE the survivor stands on   §4「位置結算」 / §5 表
 *   3. WHAT GOT REVEALED      §4「翻明總表」 / 附錄 A
 *
 * (2) is the part with no chess analogue: a losing attacker is removed FROM ITS
 * ORIGIN and never enters the target square, so the target square is unchanged.
 *
 * (3) is asserted twice over: once on the public announcement (the CombatOutcome
 * in the log) and once through the real redaction boundary, which is what a
 * player actually reads off the board.
 */

import { describe, expect, it } from 'vitest'
import { applyMove, resign } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import { stateForViewer } from '../src/redact.js'
import { opposite } from '../src/board.js'
import type { Color, GameState, Rank, Square } from '../src/types.js'
import { at, isEmpty, lastEvent, mv, pieceById, position, rankSeenBy, sq } from './helpers.js'

const ATT = 'ATT'
const DEF = 'DEF'

interface Direction {
  attacker: Color
  defender: Color
  fromName: string
  toName: string
  ply: number
}

/**
 * b2 ↔ b7 on an otherwise bare board. Rook carriers, so the slide is legal in
 * both directions, and neither square is a 中央格, so §7 settlement never
 * perturbs the numbers under test.
 */
const DIRECTIONS: Direction[] = [
  { attacker: 'white', defender: 'black', fromName: 'b2', toName: 'b7', ply: 1 },
  { attacker: 'black', defender: 'white', fromName: 'b7', toName: 'b2', ply: 2 },
]

interface Duel {
  before: GameState
  after: GameState
  from: Square
  to: Square
  dir: Direction
}

function duel(dir: Direction, attackerRank: Rank, defenderRank: Rank): Duel {
  const before = position(
    [
      { at: dir.fromName, color: dir.attacker, carrier: 'rook', rank: attackerRank, id: ATT },
      { at: dir.toName, color: dir.defender, carrier: 'rook', rank: defenderRank, id: DEF },
    ],
    { toMove: dir.attacker, ply: dir.ply },
  )
  const after = applyMove(before, mv(dir.fromName, dir.toName))
  return { before, after, from: sq(dir.fromName), to: sq(dir.toName), dir }
}

describe.each(DIRECTIONS)('§4 combat matrix — $attacker attacks $defender', (dir) => {
  const { attacker, defender, fromName, toName } = dir

  describe('高階勝低階 — attacker outranks defender', () => {
    const d = duel(dir, 'general', 'company')

    it('removes the defender and leaves the attacker on the target square', () => {
      expect(pieceById(d.after, DEF).square).toBeNull()
      expect(pieceById(d.after, ATT).square).toBe(d.to)
      expect(at(d.after, toName)?.id).toBe(ATT)
      expect(isEmpty(d.after, fromName)).toBe(true)
    })

    it('announces attacker-wins with the winner rank and the survivor square', () => {
      expect(lastEvent(d.after).combat).toEqual({
        outcome: { kind: 'attacker-wins', winnerRank: 'general' },
        attackerSquare: d.from,
        defenderSquare: d.to,
        survivorSquare: d.to,
      })
    })

    it('翻明s the winner only — the loser 兵種 stays secret from the winner', () => {
      expect(pieceById(d.after, ATT).revealed).toBe(true)
      expect(pieceById(d.after, DEF).revealed).toBe(false)
      expect(rankSeenBy(d.after, defender, ATT)).toBe('general')
      expect(rankSeenBy(d.after, attacker, DEF)).toBeNull()
    })
  })

  describe('低階撞高階 — attacker is outranked (§4「攻方由其原格移除」)', () => {
    const d = duel(dir, 'company', 'general')

    it('removes the attacker FROM ITS ORIGIN; the defender never moves', () => {
      expect(pieceById(d.after, ATT).square).toBeNull()
      expect(pieceById(d.after, DEF).square).toBe(d.to)
      expect(at(d.after, toName)?.id).toBe(DEF)
      expect(isEmpty(d.after, fromName)).toBe(true)
    })

    it('announces defender-wins with the defender square as survivor square', () => {
      expect(lastEvent(d.after).combat).toEqual({
        outcome: { kind: 'defender-wins', winnerRank: 'general' },
        attackerSquare: d.from,
        defenderSquare: d.to,
        survivorSquare: d.to,
      })
    })

    it('翻明s the defending winner only (§4.3 「防守方獲勝時翻明的是防守方」)', () => {
      expect(pieceById(d.after, DEF).revealed).toBe(true)
      expect(pieceById(d.after, ATT).revealed).toBe(false)
      expect(rankSeenBy(d.after, attacker, DEF)).toBe('general')
      expect(rankSeenBy(d.after, defender, ATT)).toBeNull()
    })
  })

  describe.each([
    ['同階相遇 — equal ranks', 'brigade', 'brigade'],
    ['爆裂物 vs 一般兵種 — bomb is the attacker', 'bomb', 'division'],
    ['爆裂物 vs 一般兵種 — bomb is the defender (§5「主動或被動觸發皆同」)', 'division', 'bomb'],
    ['爆裂物 vs 爆裂物', 'bomb', 'bomb'],
  ] as [string, Rank, Rank][])('同歸於盡: %s', (_label, attackerRank, defenderRank) => {
    const d = duel(dir, attackerRank, defenderRank)

    it('removes both; the target square is left empty (目標格淨空)', () => {
      expect(pieceById(d.after, ATT).square).toBeNull()
      expect(pieceById(d.after, DEF).square).toBeNull()
      expect(isEmpty(d.after, fromName)).toBe(true)
      expect(isEmpty(d.after, toName)).toBe(true)
    })

    it('announces a bare mutual-destruction — no rank, no colour, no discriminator', () => {
      expect(lastEvent(d.after).combat).toEqual({
        outcome: { kind: 'mutual-destruction' },
        attackerSquare: d.from,
        defenderSquare: d.to,
        survivorSquare: null,
      })
      // The outcome carries exactly one field. A discriminator that redaction
      // then had to strip would already be a leak: GameEvent is public by
      // construction (techspec §3).
      expect(Object.keys(lastEvent(d.after).combat!.outcome)).toEqual(['kind'])
    })

    it('翻明s NOBODY — neither side learns what it traded with', () => {
      expect(pieceById(d.after, ATT).revealed).toBe(false)
      expect(pieceById(d.after, DEF).revealed).toBe(false)
      expect(rankSeenBy(d.after, defender, ATT)).toBeNull()
      expect(rankSeenBy(d.after, attacker, DEF)).toBeNull()
    })
  })

  describe.each(['engineer', 'flag'] as const)(
    '爆裂物 vs %s — bomb attacks the immune piece (有煙無傷)',
    (immune) => {
      const d = duel(dir, 'bomb', immune)

      it('removes ONLY the bomb; the immune piece is 毫髮無傷 and does not move', () => {
        expect(pieceById(d.after, ATT).square).toBeNull()
        expect(pieceById(d.after, DEF).square).toBe(d.to)
        expect(at(d.after, toName)?.id).toBe(DEF)
        expect(isEmpty(d.after, fromName)).toBe(true)
      })

      it('announces a fizzle naming the survivor COLOUR only', () => {
        expect(lastEvent(d.after).combat).toEqual({
          outcome: { kind: 'fizzle', survivorColor: defender },
          attackerSquare: d.from,
          defenderSquare: d.to,
          survivorSquare: d.to,
        })
      })

      it('公開s NOTHING — not even the bomb (§4 表「不公開任何一方」)', () => {
        expect(pieceById(d.after, ATT).revealed).toBe(false)
        expect(pieceById(d.after, DEF).revealed).toBe(false)
        expect(rankSeenBy(d.after, defender, ATT)).toBeNull()
        expect(rankSeenBy(d.after, attacker, DEF)).toBeNull()
      })
    },
  )

  describe.each(['engineer', 'flag'] as const)(
    '%s attacks 爆裂物 — the immune piece is the attacker (§5 雙向)',
    (immune) => {
      const d = duel(dir, immune, 'bomb')

      it('removes ONLY the bomb; the attacker ADVANCES onto the target square', () => {
        expect(pieceById(d.after, DEF).square).toBeNull()
        expect(pieceById(d.after, ATT).square).toBe(d.to)
        expect(at(d.after, toName)?.id).toBe(ATT)
        expect(isEmpty(d.after, fromName)).toBe(true)
      })

      it('announces a fizzle naming the attacker colour as survivor', () => {
        expect(lastEvent(d.after).combat).toEqual({
          outcome: { kind: 'fizzle', survivorColor: attacker },
          attackerSquare: d.from,
          defenderSquare: d.to,
          survivorSquare: d.to,
        })
      })

      it('is the ONE winner that is not 翻明 (附錄 A 唯一例外)', () => {
        expect(pieceById(d.after, ATT).revealed).toBe(false)
        expect(pieceById(d.after, DEF).revealed).toBe(false)
        expect(rankSeenBy(d.after, defender, ATT)).toBeNull()
        expect(rankSeenBy(d.after, attacker, DEF)).toBeNull()
      })

      it('does NOT end the game — the 軍旗 never left the board', () => {
        expect(d.after.status.kind).toBe('playing')
      })
    },
  )

  describe('工兵 vs 軍旗 — 軍旗 has no protection beyond bomb immunity (§5)', () => {
    it('工兵 (9) beats 軍旗 (10) when attacking', () => {
      const d = duel(dir, 'engineer', 'flag')
      expect(pieceById(d.after, DEF).square).toBeNull()
      expect(pieceById(d.after, ATT).square).toBe(d.to)
      expect(lastEvent(d.after).combat?.outcome).toEqual({
        kind: 'attacker-wins',
        winnerRank: 'engineer',
      })
      expect(pieceById(d.after, ATT).revealed).toBe(true)
      // §7① — the 軍旗 left the board, so its owner loses on the spot.
      expect(d.after.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: attacker } })
    })

    it('工兵 (9) beats 軍旗 (10) when defending', () => {
      const d = duel(dir, 'flag', 'engineer')
      expect(pieceById(d.after, ATT).square).toBeNull()
      expect(pieceById(d.after, DEF).square).toBe(d.to)
      expect(lastEvent(d.after).combat?.outcome).toEqual({
        kind: 'defender-wins',
        winnerRank: 'engineer',
      })
      expect(pieceById(d.after, DEF).revealed).toBe(true)
      expect(d.after.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: defender } })
    })
  })

  it('司令 (1) beats everything ordinary; 排長 (8) loses to everything above it', () => {
    const win = duel(dir, 'commander', 'platoon')
    expect(pieceById(win.after, ATT).square).toBe(win.to)
    expect(pieceById(win.after, DEF).square).toBeNull()

    const lose = duel(dir, 'platoon', 'commander')
    expect(pieceById(lose.after, ATT).square).toBeNull()
    expect(pieceById(lose.after, DEF).square).toBe(lose.to)
  })
})

// ---------------------------------------------------------------------------
// The three both-die cases are ONE observation
// ---------------------------------------------------------------------------

describe('§4 同歸於盡 — rank tie, detonation and bomb-vs-bomb are indistinguishable', () => {
  const DIR = DIRECTIONS[0]!

  /** The three ways a contact takes both pieces, plus the fourth spelling of one. */
  const BOTH_DIE: [string, Rank, Rank][] = [
    ['同階相遇', 'brigade', 'brigade'],
    ['爆裂物 attacks', 'bomb', 'division'],
    ['爆裂物 defends', 'division', 'bomb'],
    ['爆裂物 vs 爆裂物', 'bomb', 'bomb'],
  ]

  const played = BOTH_DIE.map(([label, a, b]) => ({ label, after: duel(DIR, a, b).after }))
  const fizzled = duel(DIR, 'bomb', 'engineer').after

  it('produces a byte-identical outcome object', () => {
    const outcomes = played.map((p) => JSON.stringify(lastEvent(p.after).combat!.outcome))
    for (const [i, s] of outcomes.entries()) {
      expect(s, `${played[i]!.label} announces something different`).toBe('{"kind":"mutual-destruction"}')
    }
  })

  it('produces a byte-identical LOG ENTRY — same geometry, same score, same everything', () => {
    const entries = played.map((p) => JSON.stringify(lastEvent(p.after)))
    for (const [i, s] of entries.entries()) {
      expect(s, `${played[i]!.label} logs something different`).toBe(entries[0])
    }
  })

  it('produces a byte-identical view for the strictest viewer (§10.1 公開觀戰者)', () => {
    // The real claim, made through the real boundary: an observer holding no
    // private information cannot tell the four positions apart at all — not from
    // the log, and not from the piece list either, which is where a lingering
    // 翻明 flag would have republished what the outcome withheld.
    const views = played.map((p) =>
      JSON.stringify(stateForViewer(p.after, { kind: 'spectator-public' })),
    )
    for (const [i, s] of views.entries()) {
      expect(s, `${played[i]!.label} is visibly different to a 公開觀戰者`).toBe(views[0])
    }
  })

  it('tells NEITHER player what they traded with', () => {
    for (const p of played) {
      expect(rankSeenBy(p.after, DIR.defender, ATT), p.label).toBeNull()
      expect(rankSeenBy(p.after, DIR.attacker, DEF), p.label).toBeNull()
    }
  })

  it('leaves 爆裂物 uncountable during play, and countable only at 終局 (§10.5)', () => {
    const detonated = duel(DIR, 'bomb', 'division').after
    const bomb = () => stateForViewer(detonated, { kind: 'spectator-public' })
      .pieces.find((p) => p.id === ATT)!

    // Mid-game: the spent 爆裂物 is a dead piece of unknown 兵種, exactly like
    // the 旅長 that died in a rank tie.
    expect(bomb().rank).toBeNull()
    expect(bomb().square).toBeNull()

    // 終局: every 兵種 opens, so the true count is derivable from the piece list
    // — bomb-ranked pieces with square === null.
    const over = resign(detonated, DIR.defender)
    const spent = stateForViewer(over, { kind: 'spectator-public' })
      .pieces.filter((p) => p.rank === 'bomb' && p.square === null)
    expect(spent).toHaveLength(1)
    expect(spent[0]!.id).toBe(ATT)
  })

  it('does NOT collapse 有煙無傷 — a fizzle stays a separate, visible event', () => {
    // A piece SURVIVES a fizzle, so it is observably different whatever the
    // announcement says. It stays the one event that identifies a 爆裂物: a bomb
    // that works keeps its secret, a bomb that fizzles announces itself.
    expect(lastEvent(fizzled).combat!.outcome.kind).toBe('fizzle')
    expect(JSON.stringify(lastEvent(fizzled))).not.toBe(JSON.stringify(lastEvent(played[0]!.after)))
    expect(lastEvent(fizzled).combat!.survivorSquare).not.toBeNull()
    expect(
      JSON.stringify(stateForViewer(fizzled, { kind: 'spectator-public' })),
    ).not.toBe(JSON.stringify(stateForViewer(played[0]!.after, { kind: 'spectator-public' })))
  })
})

describe('§4 — the full ordinary rank ladder, 一律大吃小', () => {
  const LADDER: Exclude<Rank, 'bomb'>[] = [
    'commander', 'general', 'division', 'brigade', 'regiment',
    'battalion', 'company', 'platoon', 'engineer', 'flag',
  ]

  it('every strictly-higher rank beats every strictly-lower one, both as attacker and defender', () => {
    for (let i = 0; i < LADDER.length; i++) {
      for (let j = 0; j < LADDER.length; j++) {
        const high = LADDER[i]!
        const low = LADDER[j]!
        const attackerWins = duel(DIRECTIONS[0]!, high, low)
        const kind = lastEvent(attackerWins.after).combat!.outcome.kind
        if (i < j) expect(kind, `${high} attacks ${low}`).toBe('attacker-wins')
        else if (i > j) expect(kind, `${high} attacks ${low}`).toBe('defender-wins')
        else expect(kind, `${high} attacks ${low}`).toBe('mutual-destruction')
      }
    }
  })
})

describe('§4 — 任何棋子移動至敵子所在格皆為合法移動', () => {
  it('a known-losing capture is generated as a legal move (附錄 A(b) 自殺移動合法)', () => {
    const d = duel(DIRECTIONS[0]!, 'platoon', 'commander')
    // It was accepted by applyMove without throwing, and it is in the move list.
    expect(d.after.log).toHaveLength(1)
  })

  it('legal move generation is identical under any permutation of 兵種 (附錄 A)', () => {
    // The move list is carrier-layer only. If it ever depended on 兵種 the list
    // itself would leak the hidden layer.
    const layout = (r1: Rank, r2: Rank): GameState =>
      position([
        { at: 'b2', color: 'white', carrier: 'rook', rank: r1, id: ATT },
        { at: 'b7', color: 'black', carrier: 'rook', rank: r2, id: DEF },
        { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'K' },
      ])
    const a = layout('commander', 'flag')
    const b = layout('bomb', 'engineer')
    expect(legalMoves(a, 'white')).toEqual(legalMoves(b, 'white'))
    expect(legalMoves(a, 'black')).toEqual(legalMoves(b, 'black'))
  })
})

describe('§4 — contact never disturbs a third piece', () => {
  it('leaves bystanders exactly where they were', () => {
    const before = position(
      [
        { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: ATT },
        { at: 'b7', color: 'black', carrier: 'rook', rank: 'company', id: DEF },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'WK' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'BK' },
      ],
      { toMove: 'white' },
    )
    const after = applyMove(before, mv('b2', 'b7'))
    expect(pieceById(after, 'WK').square).toBe(sq('h1'))
    expect(pieceById(after, 'BK').square).toBe(sq('h8'))
    expect(pieceById(after, 'WK').revealed).toBe(false)
    expect(pieceById(after, 'BK').revealed).toBe(false)
    expect(opposite(after.toMove)).toBe('white')
  })
})
