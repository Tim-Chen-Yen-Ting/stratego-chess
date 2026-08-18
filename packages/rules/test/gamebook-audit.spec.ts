/**
 * INDEPENDENT AUDIT — written against gamebook_v04.md directly, not against the
 * engine's behaviour. Every expectation below quotes the gamebook clause it
 * enforces. Temporary integration-agent probe.
 */

import { describe, expect, it } from 'vitest'

import { applyMove } from '../src/game.js'
import { legalMoves as lm } from '../src/moves.js'
import { stateForViewer } from '../src/redact.js'
import { isEmpty, lastEvent, mv, PASS, pieceById, position, sq } from './helpers.js'

// --------------------------------------------------------------------------
// §4 位置結算
// --------------------------------------------------------------------------

describe('§4 位置結算', () => {
  it('攻方勝 → 守方移除；攻方佔據目標格', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'general', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'company', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(pieceById(n, 'A').square).toBe(sq('a5'))
    expect(pieceById(n, 'D').square).toBeNull()
  })

  it('攻方敗 → 攻方由其原格移除；守方留在原格；目標格不變', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'company', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'general', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(pieceById(n, 'A').square).toBeNull()
    expect(pieceById(n, 'D').square).toBe(sq('a5'))
    expect(isEmpty(n, 'a1')).toBe(true)
  })

  it('同階雙亡 → 雙方移除；目標格淨空', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'brigade', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'brigade', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(pieceById(n, 'A').square).toBeNull()
    expect(pieceById(n, 'D').square).toBeNull()
    expect(isEmpty(n, 'a5')).toBe(true)
  })
})

// --------------------------------------------------------------------------
// §4 En passant — 接觸格 ≠ 目的格
// --------------------------------------------------------------------------

function epPosition(attackerRank: 'general' | 'company' | 'brigade') {
  // black has just played d7d5; white pawn on e5 may take en passant onto d6.
  const s = position(
    [
      { at: 'e5', color: 'white', carrier: 'pawn', rank: attackerRank, id: 'A' },
      { at: 'd5', color: 'black', carrier: 'pawn', rank: 'brigade', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ],
    {
      toMove: 'white',
      ply: 2,
      log: [
        {
          ply: 1,
          color: 'black',
          move: { kind: 'move', from: sq('d7'), to: sq('d5') },
          scoreAfter: { white: 0, black: 0.5 },
        },
      ],
    },
  )
  return s
}

describe('§4 en passant 結算', () => {
  it('攻方勝 → 被吃 pawn 由其所在格移除；攻方落在被越過的格', () => {
    const n = applyMove(epPosition('general'), mv('e5', 'd6'))
    expect(pieceById(n, 'A').square).toBe(sq('d6'))
    expect(pieceById(n, 'D').square).toBeNull()
    expect(isEmpty(n, 'd5')).toBe(true)
  })

  it('攻方敗 → 攻方由其原格移除；被吃 pawn 留在原格；被越過的格維持淨空', () => {
    const n = applyMove(epPosition('company'), mv('e5', 'd6'))
    expect(pieceById(n, 'A').square).toBeNull()
    expect(pieceById(n, 'D').square).toBe(sq('d5'))
    expect(isEmpty(n, 'd6')).toBe(true)
    expect(isEmpty(n, 'e5')).toBe(true)
  })

  it('同階雙亡 → 雙方移除；被越過的格維持淨空', () => {
    const n = applyMove(epPosition('brigade'), mv('e5', 'd6'))
    expect(pieceById(n, 'A').square).toBeNull()
    expect(pieceById(n, 'D').square).toBeNull()
    expect(isEmpty(n, 'd6')).toBe(true)
  })
})

// --------------------------------------------------------------------------
// §5 爆裂物
// --------------------------------------------------------------------------

describe('§5 爆裂物', () => {
  it('爆裂物 vs 一般兵種 — 雙方移除，不公告任何一方', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'bomb', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'commander', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(pieceById(n, 'A').square).toBeNull()
    expect(pieceById(n, 'D').square).toBeNull()
    // The 爆裂物 is NOT 翻明. 翻明 is not merely a second announcement — a
    // revealed piece hands its rank to every viewer through the piece list, so
    // revealing it would republish exactly what the opaque outcome withholds.
    expect(pieceById(n, 'A').revealed).toBe(false)
    expect(pieceById(n, 'D').revealed).toBe(false)
    expect(lastEvent(n).combat?.outcome).toEqual({ kind: 'mutual-destruction' })
  })

  /**
   * §4.3 — 同階雙亡, 爆裂物引爆 and 爆裂物對爆 are ONE announcement.
   *
   * This inverts the v02 clause it replaces, which required 同階雙亡 and 引爆 to
   * be distinguishable. Naming the tied 階級 handed both players an exact rank,
   * and announcing a detonation made 爆裂物 publicly countable — count both of a
   * side's bombs off the log and its revealed 司令 is known-unkillable. The three
   * now announce identically, so a player who trades into you cannot tell whether
   * they met their own rank or a bomb.
   */
  it('同階雙亡、爆裂物引爆、爆裂物對爆 — 三者公告完全相同，無從分辨', () => {
    const bothDie = [
      ['brigade', 'brigade'],   // 同階相遇
      ['bomb', 'brigade'],      // 爆裂物 vs 一般兵種, bomb attacking
      ['brigade', 'bomb'],      // 爆裂物 vs 一般兵種, bomb defending
      ['bomb', 'bomb'],         // 爆裂物 vs 爆裂物
    ] as const

    const announcements = bothDie.map(([ar, dr]) => {
      const s = position([
        { at: 'a1', color: 'white', carrier: 'rook', rank: ar, id: 'A' },
        { at: 'a5', color: 'black', carrier: 'rook', rank: dr, id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ])
      const n = applyMove(s, mv('a1', 'a5'))
      // both gone, and neither 翻明, in every one of the four
      expect(pieceById(n, 'A').square).toBeNull()
      expect(pieceById(n, 'D').square).toBeNull()
      expect(pieceById(n, 'A').revealed).toBe(false)
      expect(pieceById(n, 'D').revealed).toBe(false)
      return n.log[0]!.combat!.outcome
    })

    // Not just the same `kind` — the same OBJECT, field for field. A
    // discriminator hidden in a second field would be exactly as fatal, and
    // there must be nothing for a redaction layer to have to strip.
    for (const a of announcements) {
      expect(a).toEqual({ kind: 'mutual-destruction' })
      expect(Object.keys(a)).toEqual(['kind'])
    }
    expect(new Set(announcements.map((a) => JSON.stringify(a))).size).toBe(1)
  })

  it('工兵/軍旗為攻方 → 爆裂物移除，工兵/軍旗佔據目標格，不翻明', () => {
    for (const rank of ['engineer', 'flag'] as const) {
      const s = position([
        { at: 'a1', color: 'white', carrier: 'rook', rank, id: 'A' },
        { at: 'a5', color: 'black', carrier: 'rook', rank: 'bomb', id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'wk' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ])
      const n = applyMove(s, mv('a1', 'a5'))
      expect(pieceById(n, 'A').square).toBe(sq('a5'))
      expect(pieceById(n, 'D').square).toBeNull()
      expect(pieceById(n, 'A').revealed).toBe(false)
      expect(pieceById(n, 'D').revealed).toBe(false)
      expect(n.status.kind).toBe('playing')
    }
  })

  it('爆裂物為攻方 → 爆裂物由其原格移除；工兵/軍旗不移動、不翻明', () => {
    for (const rank of ['engineer', 'flag'] as const) {
      const s = position([
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'bomb', id: 'A' },
        { at: 'a5', color: 'black', carrier: 'rook', rank, id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'bk' },
      ])
      const n = applyMove(s, mv('a1', 'a5'))
      expect(pieceById(n, 'A').square).toBeNull()
      expect(pieceById(n, 'D').square).toBe(sq('a5'))
      expect(pieceById(n, 'D').revealed).toBe(false)
      expect(n.status.kind).toBe('playing')
    }
  })

  it('§5/§6 工兵攻擊爆裂物抵達第 8 排 → 照常升變，且不翻明', () => {
    const s = position([
      { at: 'b7', color: 'white', carrier: 'pawn', rank: 'engineer', id: 'A' },
      { at: 'c8', color: 'black', carrier: 'rook', rank: 'bomb', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, { kind: 'move', from: sq('b7'), to: sq('c8'), promote: 'queen' })
    const a = pieceById(n, 'A')
    expect(a.square).toBe(sq('c8'))
    expect(a.carrier).toBe('queen')
    expect(a.rank).toBe('engineer')
    expect(a.revealed).toBe(false)
  })
})

// --------------------------------------------------------------------------
// §4 翻明總表
// --------------------------------------------------------------------------

describe('§4 翻明總表', () => {
  // 翻明 now happens on exactly one kind of contact: one that has a WINNER.
  // Every both-die contact reveals nobody, because all three of them share the
  // one contentless 同歸於盡 announcement (§4.3) and a 翻明 flag would leak
  // through the piece list what the announcement itself refuses to carry.
  const cases: Array<[string, 'commander' | 'company' | 'brigade' | 'bomb', 'commander' | 'company' | 'brigade' | 'bomb' | 'engineer', boolean, boolean]> = [
    ['高階勝低階 — 勝方翻明，敗方不公開', 'commander', 'company', true, false],
    ['守方勝 — 守方翻明，攻方不公開', 'company', 'commander', false, true],
    ['同階相遇 — 不公開任何一方', 'brigade', 'brigade', false, false],
    ['爆裂物 vs 一般 — 不公開任何一方', 'bomb', 'commander', false, false],
    ['爆裂物 vs 爆裂物 — 不公開任何一方', 'bomb', 'bomb', false, false],
    ['爆裂物 vs 工兵 — 不公開任何一方', 'bomb', 'engineer', false, false],
  ]

  for (const [label, ar, dr, revA, revD] of cases) {
    it(label, () => {
      const s = position([
        { at: 'a1', color: 'white', carrier: 'rook', rank: ar, id: 'A' },
        { at: 'a5', color: 'black', carrier: 'rook', rank: dr, id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'wk' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'bk' },
        { at: 'g1', color: 'white', carrier: 'bishop', rank: 'flag', id: 'wf' },
        { at: 'g8', color: 'black', carrier: 'bishop', rank: 'flag', id: 'bf' },
      ])
      const n = applyMove(s, mv('a1', 'a5'))
      expect(pieceById(n, 'A').revealed).toBe(revA)
      expect(pieceById(n, 'D').revealed).toBe(revD)
    })
  }
})

// --------------------------------------------------------------------------
// §7.5① 奪旗
// --------------------------------------------------------------------------

describe('§7.5① 奪旗', () => {
  it('軍旗被吃 → 該方立即判負', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'flag', id: 'bf' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(n.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'white' } })
  })

  it('主動以軍旗撞擊他子而落敗 → 該方立即判負', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'flag', id: 'wf' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'commander', id: 'D' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(n.status).toEqual({ kind: 'over', result: { kind: 'flag', winner: 'black' } })
  })

  it('雙方軍旗同時離場 → 判和（全遊戲唯一的和局）', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'flag', id: 'wf' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'flag', id: 'bf' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'wk' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'bk' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(n.status).toEqual({ kind: 'over', result: { kind: 'flag-both' } })
  })

  it('奪旗於階段①觸發，先於結算 — 該手不計分', () => {
    const s = position([
      { at: 'd4', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'd5', color: 'black', carrier: 'rook', rank: 'flag', id: 'bf' },
      { at: 'e4', color: 'white', carrier: 'bishop', rank: 'general', id: 'C' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
    ])
    const before = { ...s.score }
    const n = applyMove(s, mv('d4', 'd5'))
    expect(n.status.kind).toBe('over')
    expect(n.score).toEqual(before)
  })

  it('升變不構成離開棋盤 — 軍旗 pawn 升變不判負', () => {
    const s = position([
      { at: 'b7', color: 'white', carrier: 'pawn', rank: 'flag', id: 'wf' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'commander', id: 'wk' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, { kind: 'move', from: sq('b7'), to: sq('b8'), promote: 'queen' })
    expect(n.status.kind).toBe('playing')
    expect(pieceById(n, 'wf').carrier).toBe('queen')
    expect(pieceById(n, 'wf').rank).toBe('flag')
  })

  it('王車易位不構成離開棋盤 — 軍旗 rook 可藉易位移動', () => {
    const s = position([
      { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'wk' },
      { at: 'h1', color: 'white', carrier: 'rook', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, { kind: 'castle', side: 'king' })
    expect(n.status.kind).toBe('playing')
    expect(pieceById(n, 'wf').square).toBe(sq('f1'))
    expect(pieceById(n, 'wf').rank).toBe('flag')
  })
})

// --------------------------------------------------------------------------
// §7 結算階段
// --------------------------------------------------------------------------

describe('§7 結算', () => {
  it('黑方開局即得 0.5 分（貼目）', () => {
    const s = position([{ at: 'a1', color: 'white', carrier: 'king', rank: 'commander' }])
    expect(s.score).toEqual({ white: 0, black: 0.5 })
  })

  /**
   * §7 — 每一手結束後皆執行結算，但只有剛行動的一方計分.
   *
   * This inverts the v02 clause 「雙方同時計分」. Crediting both every ply put
   * white one settlement ahead for every acquiring move: a square white takes on
   * move m is counted from ply 2m-1, black's mirror-image square from ply 2m.
   * Mover-only settles that, and settles the exposure question with it — each
   * side banks once before the opponent can reply.
   *
   * A pass settles like anything else (§3④): the passer is the mover.
   */
  it('只有剛行動的一方計分 — 對手行棋時我方中央子不計分', () => {
    const s = position(
      [
        { at: 'e4', color: 'white', carrier: 'rook', rank: 'commander', id: 'W' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'general', id: 'bk' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'a8', color: 'black', carrier: 'rook', rank: 'flag', id: 'bf' },
      ],
      { toMove: 'black' },
    )
    // black passes: black is the mover and settles for 0; white's e4 is untouched
    const n = applyMove(s, PASS)
    expect(n.score).toEqual({ white: 0, black: 0.5 })

    // white's own ply is when white's e4 pays
    const n2 = applyMove(n, PASS)
    expect(n2.score).toEqual({ white: 1, black: 0.5 })
  })

  it('棋子若在①被吃掉，該手不計入其佔領分', () => {
    const s = position([
      { at: 'd1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'd4', color: 'black', carrier: 'rook', rank: 'company', id: 'D' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'a8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('d1', 'd4'))
    expect(n.score.black).toBe(0.5) // black's d4 piece died in ①: no point
    expect(n.score.white).toBe(1) // white's attacker now occupies d4
  })

  it('§7.5② 先達 X 分者獲勝', () => {
    const s = position(
      [
        { at: 'e4', color: 'white', carrier: 'rook', rank: 'commander', id: 'W' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ],
      { score: { white: 39, black: 0.5 }, config: { scoreTarget: 40 } },
    )
    // §7.5② is checked at the END OF THE TURN, never mid-turn. White crossing X
    // on its own ply does NOT stop the game — Black still gets its reply, so both
    // sides always finish on an equal number of moves. Ending on White's ply gave
    // White a win with one more move than Black had, worth 55/45 and 68/32 on the
    // two boards in bot measurement.
    const afterWhite = applyMove(s, PASS)
    expect(afterWhite.score.white).toBe(40)
    expect(afterWhite.status).toEqual({ kind: 'playing' })
    expect(afterWhite.toMove).toBe('black')

    // Black replies; the turn is now complete and the target is checked.
    const afterBlack = applyMove(afterWhite, PASS)
    expect(afterBlack.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'white' } })
  })

  it('§7.5② 黑方越線立刻結束 — 它是後手，回合已經完整', () => {
    const s = position(
      [
        { at: 'e5', color: 'black', carrier: 'rook', rank: 'commander', id: 'B' },
        { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'a8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ],
      { score: { white: 10, black: 39.5 }, config: { scoreTarget: 40 }, toMove: 'black' },
    )
    const n = applyMove(s, PASS)
    expect(n.score.black).toBe(40.5)
    expect(n.status).toEqual({ kind: 'over', result: { kind: 'score', winner: 'black' } })
  })
})

// --------------------------------------------------------------------------
// §7.5③ 停滯
// --------------------------------------------------------------------------

describe('§7.5③ 停滯', () => {
  it('連續 N 個完整回合無吃子且無得分 → 結束，分數高者獲勝', () => {
    let s = position(
      [
        { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ],
      { config: { noProgressTurns: 3 } },
    )
    // 6 plies = 3 full turns of pure passing: no capture, no point.
    for (let i = 0; i < 6; i++) {
      expect(s.status.kind).toBe('playing')
      s = applyMove(s, PASS)
    }
    expect(s.noProgressTurns).toBe(3)
    expect(s.status).toEqual({ kind: 'over', result: { kind: 'no-progress', winner: 'black' } })
  })

  it('任何一次吃子使計數歸零', () => {
    let s = position(
      [
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
        { at: 'a5', color: 'black', carrier: 'rook', rank: 'company', id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ],
      { noProgressTurns: 7, config: { noProgressTurns: 30 } },
    )
    s = applyMove(s, mv('a1', 'a5'))
    expect(s.noProgressTurns).toBe(0)
  })
})

// --------------------------------------------------------------------------
// §3 移動覆蓋
// --------------------------------------------------------------------------

describe('§3 對西洋棋的覆蓋', () => {
  it('§3② 王車易位為無條件版本 — 經過與目標格被攻擊皆不影響', () => {
    const s = position([
      { at: 'e1', color: 'white', carrier: 'king', rank: 'commander', id: 'wk' },
      { at: 'h1', color: 'white', carrier: 'rook', rank: 'general', id: 'wr' },
      // black rooks bearing down on f1 and g1, and on e1 itself
      { at: 'f8', color: 'black', carrier: 'rook', rank: 'commander', id: 'b1' },
      { at: 'g7', color: 'black', carrier: 'rook', rank: 'commander', id: 'b2' },
      { at: 'e8', color: 'black', carrier: 'rook', rank: 'commander', id: 'b3' },
      { at: 'a1', color: 'white', carrier: 'bishop', rank: 'flag', id: 'wf' },
      { at: 'a8', color: 'black', carrier: 'bishop', rank: 'flag', id: 'bf' },
    ])
    const moves = lm(s, 'white')
    expect(moves).toContainEqual({ kind: 'castle', side: 'king' })
  })

  it('§3① king 無特殊地位 — 吃掉 king 一樣比階級，且不判終局', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'king', rank: 'company', id: 'bk' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'bishop', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a5'))
    expect(pieceById(n, 'bk').square).toBeNull()
    expect(n.status.kind).toBe('playing')
  })

  it('§3④ pass 永遠合法，即使存在其他合法移動', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const moves = lm(s, 'white')
    expect(moves.length).toBeGreaterThan(1)
    expect(moves).toContainEqual({ kind: 'pass' })
  })

  it('§4 明知必敗的移動仍為合法，且移動軍旗撞擊他子亦為合法', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'flag', id: 'wf' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'commander', id: 'D' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    expect(lm(s, 'white')).toContainEqual({ kind: 'move', from: sq('a1'), to: sq('a5') })
  })

  it('附錄 A — 合法移動集合不得依兵種而異', () => {
    const build = (r1: 'commander' | 'flag' | 'bomb', r2: 'commander' | 'engineer') =>
      position([
        { at: 'e4', color: 'white', carrier: 'queen', rank: r1, id: 'A' },
        { at: 'e7', color: 'black', carrier: 'rook', rank: r2, id: 'D' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ])
    const a = JSON.stringify(lm(build('commander', 'commander'), 'white'))
    const b = JSON.stringify(lm(build('flag', 'engineer'), 'white'))
    const c = JSON.stringify(lm(build('bomb', 'engineer'), 'white'))
    expect(b).toBe(a)
    expect(c).toBe(a)
  })
})

// --------------------------------------------------------------------------
// §6 升變
// --------------------------------------------------------------------------

describe('§6 升變', () => {
  it('僅存活的 pawn 升變 — 落敗者不升變', () => {
    const s = position([
      { at: 'b7', color: 'white', carrier: 'pawn', rank: 'company', id: 'A' },
      { at: 'c8', color: 'black', carrier: 'rook', rank: 'commander', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, { kind: 'move', from: sq('b7'), to: sq('c8'), promote: 'queen' })
    expect(pieceById(n, 'A').square).toBeNull()
    expect(pieceById(n, 'A').carrier).toBe('pawn')
    expect(lastEvent(n).promoted).toBeUndefined()
  })

  it('同階雙亡者不升變', () => {
    const s = position([
      { at: 'b7', color: 'white', carrier: 'pawn', rank: 'brigade', id: 'A' },
      { at: 'c8', color: 'black', carrier: 'rook', rank: 'brigade', id: 'D' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, { kind: 'move', from: sq('b7'), to: sq('c8'), promote: 'queen' })
    expect(pieceById(n, 'A').carrier).toBe('pawn')
    expect(lastEvent(n).promoted).toBeUndefined()
  })

  it('§1 升變只改變載體層，兵種層與翻明狀態不變', () => {
    const s = position([
      { at: 'b7', color: 'white', carrier: 'pawn', rank: 'battalion', id: 'A', revealed: true },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, { kind: 'move', from: sq('b7'), to: sq('b8'), promote: 'knight' })
    const a = pieceById(n, 'A')
    expect(a.carrier).toBe('knight')
    expect(a.rank).toBe('battalion')
    expect(a.revealed).toBe(true)
  })
})

// --------------------------------------------------------------------------
// §8 讀秒
// --------------------------------------------------------------------------

describe('§8 增秒', () => {
  const inc = 10_000

  it('完成一次移動 → 給增秒', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, mv('a1', 'a2'))
    expect(n.clockMs.white).toBe(s.clockMs.white + inc)
  })

  it('主動 pass（有其他合法移動）→ 不給增秒', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    const n = applyMove(s, PASS)
    expect(n.clockMs.white).toBe(s.clockMs.white)
  })

  it('強制 pass（無任何合法移動）→ 給增秒', () => {
    // white pawns on the 8th rank have no forward square and no capture square
    const s = position([
      { at: 'a8', color: 'white', carrier: 'pawn', rank: 'engineer', id: 'p1' },
      { at: 'b8', color: 'white', carrier: 'pawn', rank: 'company', id: 'p2' },
      { at: 'h5', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
    ])
    expect(lm(s, 'white')).toEqual([PASS])
    const n = applyMove(s, PASS)
    expect(n.clockMs.white).toBe(s.clockMs.white + inc)
  })

  it('clockEnabled 為 false 時完全不動讀秒', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
        { at: 'h1', color: 'white', carrier: 'king', rank: 'flag', id: 'wf' },
        { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'bf' },
      ],
      { config: { clockEnabled: false } },
    )
    const n = applyMove(s, mv('a1', 'a2'))
    expect(n.clockMs).toEqual(s.clockMs)
  })
})

// --------------------------------------------------------------------------
// §10 資訊模型
// --------------------------------------------------------------------------

describe('§10 遮蔽層', () => {
  it('對手未翻明的兵種完全不在 payload 內', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'bomb', id: 'D' },
    ])
    const vs = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(vs.pieces.find((p) => p.id === 'D')!.rank).toBeNull()
    expect(vs.pieces.find((p) => p.id === 'A')!.rank).toBe('commander')
  })

  it('現場觀戰者與其綁定玩家的視角完全相同', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'bomb', id: 'D' },
    ])
    const player = stateForViewer(s, { kind: 'player', color: 'white' })
    const spec = stateForViewer(s, { kind: 'spectator', bound: 'white' })
    expect(spec.pieces).toEqual(player.pieces)
  })

  it('終局公開全部兵種', () => {
    const s = position(
      [
        { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
        { at: 'a5', color: 'black', carrier: 'rook', rank: 'bomb', id: 'D' },
      ],
      { status: { kind: 'over', result: { kind: 'resign', winner: 'white' } } },
    )
    const vs = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(vs.pieces.find((p) => p.id === 'D')!.rank).toBe('bomb')
  })

  it('玩家不提供推論輔助 — ViewerState 只有 legalMoves，無候選集合', () => {
    const s = position([
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'commander', id: 'A' },
      { at: 'a5', color: 'black', carrier: 'rook', rank: 'bomb', id: 'D' },
    ])
    const vs = stateForViewer(s, { kind: 'player', color: 'white' })
    const keys = Object.keys(vs).sort()
    expect(keys).not.toContain('candidates')
    expect(keys).not.toContain('solver')
  })
})
