/**
 * §6 升變 (with §1 and §5).
 *
 * The three load-bearing sentences:
 *   「升變只改變載體層。兵種層不變，翻明狀態不變。」
 *   「僅存活的 pawn 升變。… 落敗或同階雙亡者已離場，不升變。」
 *   「『存活』包含 §5 的爆裂物落敗（有煙無傷）。… 故升變。」
 */

import { describe, expect, it } from 'vitest'
import { applyMove } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import type { GameState, Rank } from '../src/types.js'
import { at, isEmpty, lastEvent, mv, pieceById, position, rankSeenBy, sq } from './helpers.js'

const P = 'P'   // the promoting pawn
const D = 'D'   // whatever is standing on a8
const WK = 'WK'
const BK = 'BK'

/** White pawn on a7, a8 empty. */
function quietRunner(pawnRank: Rank): GameState {
  return position(
    [
      { at: 'a7', color: 'white', carrier: 'pawn', rank: pawnRank, id: P, hasMoved: true },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: WK },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: BK },
    ],
    { toMove: 'white' },
  )
}

/** White pawn on b7 with an enemy on a8 to capture. */
function capturingRunner(pawnRank: Rank, targetRank: Rank): GameState {
  return position(
    [
      { at: 'b7', color: 'white', carrier: 'pawn', rank: pawnRank, id: P, hasMoved: true },
      { at: 'a8', color: 'black', carrier: 'knight', rank: targetRank, id: D },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: WK },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: BK },
    ],
    { toMove: 'white' },
  )
}

describe('§6 升變 by quiet move', () => {
  it('offers all four carriers on the last rank and nothing else', () => {
    const s = quietRunner('battalion')
    const promos = legalMoves(s, 'white').filter(
      (m) => m.kind === 'move' && m.from === sq('a7') && m.to === sq('a8'),
    )
    expect(promos).toEqual([
      mv('a7', 'a8', 'queen'),
      mv('a7', 'a8', 'rook'),
      mv('a7', 'a8', 'bishop'),
      mv('a7', 'a8', 'knight'),
    ])
  })

  it.each(['queen', 'rook', 'bishop', 'knight'] as const)(
    'changes the carrier layer to %s and NOTHING else (§1)',
    (choice) => {
      const before = quietRunner('battalion')
      const s = applyMove(before, mv('a7', 'a8', choice))
      const p = pieceById(s, P)
      expect(p.carrier).toBe(choice)
      expect(p.square).toBe(sq('a8'))
      // 「兵種層不變，翻明狀態不變」— 營長 pawn 升變 queen 後仍是營長.
      expect(p.rank).toBe('battalion')
      expect(p.revealed).toBe(false)
      expect(rankSeenBy(s, 'black', P)).toBeNull()
      expect(lastEvent(s).promoted).toBe(choice)
      expect(lastEvent(s).combat).toBeUndefined()
    },
  )

  it('promotes a black pawn on rank 1', () => {
    const before = position(
      [
        { at: 'a2', color: 'black', carrier: 'pawn', rank: 'regiment', id: P, hasMoved: true },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: WK },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: BK },
      ],
      { toMove: 'black', ply: 2 },
    )
    const s = applyMove(before, mv('a2', 'a1', 'rook'))
    expect(pieceById(s, P).carrier).toBe('rook')
    expect(pieceById(s, P).square).toBe(sq('a1'))
    expect(pieceById(s, P).rank).toBe('regiment')
  })
})

describe('§6 升變 by a WINNING capture', () => {
  const s = applyMove(capturingRunner('general', 'company'), mv('b7', 'a8', 'knight'))

  it('promotes the surviving pawn on the target square', () => {
    expect(pieceById(s, P).carrier).toBe('knight')
    expect(pieceById(s, P).square).toBe(sq('a8'))
    expect(at(s, 'a8')?.id).toBe(P)
    expect(pieceById(s, D).square).toBeNull()
    expect(lastEvent(s).promoted).toBe('knight')
  })

  it('still 翻明s the winner, and still leaves the 兵種 unchanged', () => {
    expect(pieceById(s, P).rank).toBe('general')
    expect(pieceById(s, P).revealed).toBe(true)
    expect(rankSeenBy(s, 'black', P)).toBe('general')
  })
})

describe('§6 升變 DENIED on a losing capture', () => {
  const s = applyMove(capturingRunner('company', 'general'), mv('b7', 'a8', 'queen'))

  it('removes the pawn from its origin — it never reached the 8th rank', () => {
    expect(pieceById(s, P).square).toBeNull()
    expect(isEmpty(s, 'b7')).toBe(true)
  })

  it('does not change the carrier layer of the dead pawn', () => {
    expect(pieceById(s, P).carrier).toBe('pawn')
  })

  it('records no promotion', () => {
    expect(lastEvent(s).promoted).toBeUndefined()
    expect('promoted' in lastEvent(s)).toBe(false)
  })

  it('leaves the defender standing on a8, unmoved', () => {
    expect(pieceById(s, D).square).toBe(sq('a8'))
    expect(pieceById(s, D).carrier).toBe('knight')
  })
})

describe('§6 升變 DENIED on 同階雙亡', () => {
  const s = applyMove(capturingRunner('brigade', 'brigade'), mv('b7', 'a8', 'queen'))

  it('removes both and promotes neither', () => {
    expect(pieceById(s, P).square).toBeNull()
    expect(pieceById(s, D).square).toBeNull()
    expect(pieceById(s, P).carrier).toBe('pawn')
    expect(isEmpty(s, 'a8')).toBe(true)
    expect(lastEvent(s).promoted).toBeUndefined()
  })
})

describe('§6 升變 GRANTED on a 爆裂物 fizzle, with no 翻明 (§5)', () => {
  const s = applyMove(capturingRunner('engineer', 'bomb'), mv('b7', 'a8', 'queen'))

  it('promotes: no rank comparison happened, but the pawn is standing there', () => {
    expect(pieceById(s, P).square).toBe(sq('a8'))
    expect(pieceById(s, P).carrier).toBe('queen')
    expect(lastEvent(s).promoted).toBe('queen')
    expect(pieceById(s, D).square).toBeNull()
  })

  it('reveals nothing at all — 附錄 A 唯一例外 survives promotion', () => {
    expect(lastEvent(s).combat?.outcome).toEqual({ kind: 'fizzle', survivorColor: 'white' })
    expect(pieceById(s, P).revealed).toBe(false)
    expect(rankSeenBy(s, 'black', P)).toBeNull()
    expect(pieceById(s, P).rank).toBe('engineer')
  })
})

describe('§5 升變 does not count as 離開棋盤 for a 軍旗', () => {
  it('a 軍旗 pawn promoting by quiet move does NOT lose the game', () => {
    const before = quietRunner('flag')
    const s = applyMove(before, mv('a7', 'a8', 'queen'))
    expect(s.status).toEqual({ kind: 'playing' })
    expect(pieceById(s, P).square).toBe(sq('a8'))
    expect(pieceById(s, P).rank).toBe('flag')
    expect(pieceById(s, P).carrier).toBe('queen')
  })

  it('a 軍旗 pawn promoting by beating a 爆裂物 does NOT lose the game and stays hidden', () => {
    const s = applyMove(capturingRunner('flag', 'bomb'), mv('b7', 'a8', 'queen'))
    expect(s.status).toEqual({ kind: 'playing' })
    expect(pieceById(s, P).square).toBe(sq('a8'))
    expect(pieceById(s, P).carrier).toBe('queen')
    expect(pieceById(s, P).rank).toBe('flag')
    expect(pieceById(s, P).revealed).toBe(false)
    expect(rankSeenBy(s, 'black', P)).toBeNull()
    expect(lastEvent(s).promoted).toBe('queen')
  })

  it('a 軍旗 pawn LOSING on the 8th rank still loses the game (§7.5①)', () => {
    const s = applyMove(capturingRunner('flag', 'general'), mv('b7', 'a8', 'queen'))
    expect(pieceById(s, P).square).toBeNull()
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
    expect(lastEvent(s).promoted).toBeUndefined()
  })
})

describe('promotion — engine API leniency (not a gamebook rule)', () => {
  it('treats a promotion move with no `promote` field as a queen promotion', () => {
    const s = applyMove(quietRunner('battalion'), mv('a7', 'a8'))
    expect(pieceById(s, P).carrier).toBe('queen')
    expect(lastEvent(s).promoted).toBe('queen')
  })
})
