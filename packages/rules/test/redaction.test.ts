/**
 * 遮蔽層 — targeted attacks on `stateForViewer`. Gamebook §4, §5, §10, 附錄 A;
 * techspec §3 (ViewerPiece / ViewerState), §4 note 4, §9 done-item 2.
 *
 *   「隱藏層由伺服器權威持有。用戶端永不接收其無權查看的兵種資料——
 *     不是『收到但不顯示』。」  (§10)
 *
 * The randomised half of this suite lives in `redaction.property.ts` and is
 * registered by the import below: vitest's `include` glob only collects
 * `*.test.ts`, so that file rides in here rather than being picked up directly.
 * Everything in THIS file is a hand-built position aimed at one specific way
 * the hidden layer could be blown open.
 */

import './redaction.property.js'

import { describe, expect, it } from 'vitest'
import {
  ALL_RANKS,
  RANK_NAMES_ZH,
  applyMove,
  createGame,
  entitledToRank,
  legalMoves,
  renderForLLM,
  resign,
  squareName,
  stateForViewer,
  submitAssignment,
} from '@xiyang/rules'
import type { Color, GameEvent, GameState, Piece, Rank, Viewer, ViewerState } from '@xiyang/rules'
import { position } from './helpers.js'
import {
  ALL_VIEWERS,
  CONTACT_SEQUENCE,
  completeAssignment,
  contactGame,
  deepWalkViolations,
  entitlement,
  greppableJson,
  listedPieceLines,
  mv,
  playAll,
  rawJsonViolations,
  renderViolations,
  section,
  startedGame,
  viewerLabel,
} from './redaction.property.js'

const RENDER_OPTS = { baseUrl: 'http://localhost:3000', token: 'tok' }

const WHITE: Viewer = { kind: 'player', color: 'white' }
const BLACK: Viewer = { kind: 'player', color: 'black' }
const OMNISCIENT: Viewer = { kind: 'replay-omniscient' }

function lastEvent(s: GameState): GameEvent {
  const e = s.log[s.log.length - 1]
  if (!e) throw new Error('no events')
  return e
}

function pieceAtSquare(s: GameState, name: string): Piece {
  const found = s.pieces.find((p) => p.square !== null && squareName(p.square) === name)
  if (!found) throw new Error(`no piece on ${name}`)
  return found
}

function viewOf(vs: ViewerState, id: string) {
  const p = vs.pieces.find((x) => x.id === id)
  if (!p) throw new Error(`no viewer piece ${id}`)
  return p
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

// ===========================================================================
// 1. The shape of the payload
// ===========================================================================

describe('ViewerState shape — techspec §3', () => {
  const s = playAll(startedGame('shape'), CONTACT_SEQUENCE.slice(0, 2))

  it('ViewerPiece carries exactly the six declared fields', () => {
    // A `{ ...piece }` spread inside redact.ts would silently add `hasMoved`
    // today and `rank` forever after. Pinning the key set is what catches it.
    for (const v of ALL_VIEWERS) {
      for (const p of stateForViewer(s, v).pieces) {
        expect(Object.keys(p).sort(), viewerLabel(v)).toEqual(
          ['carrier', 'color', 'id', 'rank', 'revealed', 'square'],
        )
      }
    }
  })

  it('ViewerState carries exactly the declared fields', () => {
    const declared = [
      'clockMs', 'config', 'id', 'log', 'noProgressTurns', 'ply',
      'pieces', 'score', 'status', 'toMove', 'viewer',
    ]
    for (const v of ALL_VIEWERS) {
      const keys = Object.keys(stateForViewer(s, v)).sort()
      const extra = keys.filter((k) => !declared.includes(k) && k !== 'legalMoves')
      expect(extra, `${viewerLabel(v)} has undeclared fields`).toEqual([])
    }
  })

  it('never carries a rank field that leaked through a spread', () => {
    const vs = stateForViewer(s, WHITE)
    const raw = JSON.stringify(vs.pieces.filter((p) => p.color === 'black'))
    expect(raw).not.toMatch(/"rank":"[a-z]/)
    expect(raw).not.toContain('hasMoved')
  })

  it('shares no object reference with the authoritative GameState', () => {
    // A stray reference is a leak with a delay: the consumer holds a live
    // handle back into the server's own state.
    const g = contactGame('refs', 'commander', 'platoon')
    const vs = stateForViewer(g, BLACK)

    expect(vs.pieces).not.toBe(g.pieces)
    expect(vs.log).not.toBe(g.log)
    expect(vs.score).not.toBe(g.score)
    expect(vs.clockMs).not.toBe(g.clockMs)
    expect(vs.config).not.toBe(g.config)
    expect(vs.status).not.toBe(g.status)
    vs.pieces.forEach((p, i) => expect(p as unknown).not.toBe(g.pieces[i] as unknown))
    vs.log.forEach((e, i) => {
      const src = g.log[i]!
      expect(e).not.toBe(src)
      expect(e.move).not.toBe(src.move)
      expect(e.scoreAfter).not.toBe(src.scoreAfter)
      if (src.combat) {
        expect(e.combat).not.toBe(src.combat)
        expect(e.combat!.outcome).not.toBe(src.combat.outcome)
      }
    })
    expect(g.log.some((e) => e.combat)).toBe(true)
  })

  it('never mutates the state it is given', () => {
    const frozen = deepFreeze(contactGame('frozen', 'commander', 'platoon'))
    for (const v of ALL_VIEWERS) expect(() => stateForViewer(frozen, v)).not.toThrow()
  })
})

// ===========================================================================
// 2. entitledToRank — the whole policy, checked directly
// ===========================================================================

describe('entitledToRank — gamebook §10', () => {
  it('a player sees own ranks and no others, until a piece is 翻明', () => {
    const s = contactGame('ent', 'commander', 'platoon')
    const winner = pieceAtSquare(s, 'd5')          // white commander, 翻明 by §4.3
    expect(winner.color).toBe('white')
    expect(winner.revealed).toBe(true)

    for (const p of s.pieces) {
      expect(entitledToRank(s, WHITE, p)).toBe(p.color === 'white' || p.revealed)
      expect(entitledToRank(s, BLACK, p)).toBe(p.color === 'black' || p.revealed)
      expect(entitledToRank(s, { kind: 'spectator', bound: 'white' }, p))
        .toBe(entitledToRank(s, WHITE, p))
      expect(entitledToRank(s, { kind: 'replay-player', color: 'white' }, p))
        .toBe(entitledToRank(s, WHITE, p))
      expect(entitledToRank(s, OMNISCIENT, p)).toBe(true)
    }
  })

  it('公開觀戰者 is entitled to 翻明 pieces and NOTHING else — checked independently', () => {
    // This assertion cannot be replaced by the property suites, and that is the
    // point. `entitlement()` in redaction.property.ts IS `entitledToRank` — the
    // very predicate `stateForViewer` consults — so suites A/B/D score the
    // payload against the rule that produced it. A widened predicate handing
    // this viewer a whole army would satisfy every one of them: 0 deep-walk
    // violations, 0 raw-text violations, 0 variation under permutation. They
    // prove the payload is CONSISTENT with the policy, never that the policy is
    // right. So the policy gets stated here, in literal terms, once per state.
    const pub: Viewer = { kind: 'spectator-public' }
    const s = contactGame('pub-ent', 'commander', 'platoon')
    expect(s.pieces.some((p) => p.revealed)).toBe(true)
    expect(s.pieces.some((p) => !p.revealed)).toBe(true)

    for (const p of s.pieces) {
      expect(entitledToRank(s, pub, p), `${p.id} mid-game`).toBe(p.revealed)
    }

    // and it is strictly narrower than every other live viewer
    for (const p of s.pieces.filter((p) => !p.revealed)) {
      expect(entitledToRank(s, pub, p)).toBe(false)
      const owner: Viewer = { kind: 'player', color: p.color }
      expect(entitledToRank(s, owner, p)).toBe(true)
      expect(entitledToRank(s, { kind: 'spectator', bound: p.color }, p)).toBe(true)
    }

    // §10.5 still opens everything at 終局, for this viewer too
    const over = resign(s, 'white')
    for (const p of over.pieces) expect(entitledToRank(over, pub, p)).toBe(true)
  })

  it('公開觀戰者 never receives a move list — §10.1 沒有座位', () => {
    const s = startedGame('pub-legal')
    expect(stateForViewer(s, { kind: 'spectator-public' }).legalMoves).toBeUndefined()
    // the player on turn does get one, so the assertion above is not vacuous
    expect(stateForViewer(s, { kind: 'player', color: s.toMove }).legalMoves).toBeDefined()
  })

  it('終局公開全部兵種 — a finished game opens every rank to everyone', () => {
    const over = resign(startedGame('over'), 'white')
    expect(over.status.kind).toBe('over')
    for (const v of ALL_VIEWERS) {
      const vs = stateForViewer(over, v)
      expect(vs.pieces.every((p) => p.rank !== null), viewerLabel(v)).toBe(true)
    }
  })

  it('opens everything the instant §7① 奪旗 ends the game, not before', () => {
    const before = position([
      { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: 'W' },
      { at: 'b7', color: 'black', carrier: 'rook', rank: 'flag', id: 'B' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'bomb', id: 'BK' },
    ])
    expect(viewOf(stateForViewer(before, WHITE), 'BK').rank).toBeNull()

    const after = applyMove(before, mv('b2', 'b7'))
    expect(after.status.kind).toBe('over')
    expect(stateForViewer(after, WHITE).pieces.every((p) => p.rank !== null)).toBe(true)
    expect(stateForViewer(after, BLACK).legalMoves).toBeUndefined()
  })

  it('DOCUMENTS: 終局公開 collapses replay-player into replay-omniscient', () => {
    // §10 offers the replay viewer a switch: 「全知者視角／任一方玩家視角」.
    // `entitledToRank` short-circuits on `status.kind === 'over'` before it
    // ever looks at the viewer, and a replay is by definition of a finished
    // game — so the player-perspective replay is unreachable through
    // stateForViewer alone. Not a leak (§10 終局公開全部兵種 authorises it),
    // but the switch will need replaying the log, not redacting the end state.
    const over = resign(contactGame('replay', 'commander', 'platoon'), 'black')
    const asWhite = stateForViewer(over, { kind: 'replay-player', color: 'white' })
    const asOmniscient = stateForViewer(over, OMNISCIENT)
    expect(asWhite.pieces).toEqual(asOmniscient.pieces)
  })

  it('DOCUMENTS: resigning during setup publishes the opponent\'s assignment', () => {
    // A side that submits first and is then resigned on has its whole army
    // disclosed, because the game is over and §10 opens everything. Harmless
    // in v1 (no accounts, no persistence, no rematch), but it does mean
    // "resign to read the opponent's setup" costs nothing — worth revisiting
    // if rematches or ratings ever land.
    const fresh = createGame('setup-resign')
    const half = submitAssignment(fresh, 'white', completeAssignment('white', fresh, { 'w-e2': 'commander' }))
    expect(viewOf(stateForViewer(half, BLACK), 'w-e2').rank).toBeNull()

    const over = resign(half, 'black')   // black never submitted an assignment
    expect(over.status.kind).toBe('over')
    expect(viewOf(stateForViewer(over, BLACK), 'w-e2').rank).toBe('commander')
  })

  it('hides placeholder ranks during setup — from BOTH sides, not just the opponent', () => {
    // createGame() pre-loads every piece with the default-assignment rank so
    // that Piece.rank can stay non-nullable. That placeholder is deterministic
    // and therefore publicly predictable — it is nobody's army, so it must not
    // be readable across the boundary NOR reported back to its own side as if
    // it were their deployment. Disclosure starts when a side submits.
    const fresh = createGame('setup')
    const half = submitAssignment(
      fresh,
      'white',
      completeAssignment('white', fresh, { 'w-e2': 'commander' }),
    )

    // nobody has deployed: every rank is hidden from everyone
    for (const [viewer, mine] of [[WHITE, 'white'], [BLACK, 'black']] as const) {
      const vs = stateForViewer(fresh, viewer)
      for (const p of vs.pieces) {
        expect(p.rank === null, `${p.id} for ${mine} before any deployment`).toBe(true)
      }
    }

    // white has deployed: white sees its own, black still sees nothing at all
    const asWhite = stateForViewer(half, WHITE)
    for (const p of asWhite.pieces) {
      expect(p.rank === null, `${p.id} for white after deploying`).toBe(p.color !== 'white')
    }
    expect(viewOf(asWhite, 'w-e2').rank).toBe('commander')

    const asBlack = stateForViewer(half, BLACK)
    for (const p of asBlack.pieces) {
      expect(p.rank === null, `${p.id} for black, still undeployed`).toBe(true)
    }

    for (const s of [fresh, half]) {
      expect(stateForViewer(s, WHITE).legalMoves).toBeUndefined()
    }
  })
})

// ===========================================================================
// 3. A rank string the viewer has no claim to is absent from the wire format
// ===========================================================================

describe('serialised payload — raw text search', () => {
  /**
   * The §2 distribution gives every side at least one piece of all eleven
   * 兵種, so in a real game a player is legitimately entitled to every rank
   * *string* from ply one and "does 'commander' appear?" is meaningless. A
   * hand-built position with a narrow rank set makes the question real again.
   */
  const narrow = position([
    { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: 'W1' },
    { at: 'g2', color: 'white', carrier: 'knight', rank: 'company', id: 'W2' },
    { at: 'b7', color: 'black', carrier: 'rook', rank: 'flag', id: 'B1' },
    { at: 'g7', color: 'black', carrier: 'knight', rank: 'bomb', id: 'B2' },
    { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'B3' },
  ])

  it('white\'s payload contains no black rank token at all', () => {
    const text = greppableJson(stateForViewer(narrow, WHITE))
    for (const r of ['flag', 'bomb', 'commander'] as Rank[]) {
      expect(text, `black's ${r} leaked`).not.toContain(`"${r}"`)
    }
    for (const r of ['general', 'company'] as Rank[]) {
      expect(text).toContain(`"${r}"`)
    }
  })

  it('black\'s payload contains no white rank token at all', () => {
    const text = greppableJson(stateForViewer(narrow, BLACK))
    for (const r of ['general', 'company'] as Rank[]) {
      expect(text, `white's ${r} leaked`).not.toContain(`"${r}"`)
    }
  })

  it('the same holds through a JSON.parse round-trip and in the LLM render', () => {
    const round = JSON.parse(greppableJson(stateForViewer(narrow, WHITE))) as ViewerState
    expect(JSON.stringify(round)).not.toContain('"bomb"')
    const text = renderForLLM(stateForViewer(narrow, WHITE), RENDER_OPTS)
    for (const r of ['flag', 'bomb', 'commander'] as Rank[]) {
      expect(text, `black's ${r} leaked into the render`).not.toContain(RANK_NAMES_ZH[r])
    }
  })

  it('a spectator bound to white is bound by the same text search', () => {
    const text = greppableJson(stateForViewer(narrow, { kind: 'spectator', bound: 'white' }))
    for (const r of ['flag', 'bomb', 'commander'] as Rank[]) expect(text).not.toContain(`"${r}"`)
  })
})

// ===========================================================================
// 4. Spectator == the player it is bound to
// ===========================================================================

describe('現場觀戰者 — §10「與其進入時所綁定玩家的視角完全相同」', () => {
  const states: Array<[string, GameState]> = [
    ['fresh', startedGame('spec')],
    ['after contact', contactGame('spec2', 'commander', 'platoon')],
    ['fizzled', contactGame('spec3', 'engineer', 'bomb')],
    ['finished', resign(startedGame('spec4'), 'black')],
  ]

  for (const bound of ['white', 'black'] as const) {
    for (const [label, s] of states) {
      it(`spectator bound to ${bound} sees exactly what ${bound} sees — ${label}`, () => {
        const player = stateForViewer(s, { kind: 'player', color: bound })
        const spectator = stateForViewer(s, { kind: 'spectator', bound })

        // NO MORE: not one extra rank, anywhere.
        expect(spectator.pieces).toEqual(player.pieces)
        expect(JSON.stringify(spectator.pieces)).toBe(JSON.stringify(player.pieces))
        expect(spectator.log).toEqual(player.log)

        // NO LESS: every other field is identical too. `viewer` differs by
        // construction, and `legalMoves` is not part of the 兵種 view — techspec
        // §3 declares it "present only for a player whose turn it is".
        const strip = (x: ViewerState): Record<string, unknown> => {
          const { viewer: _v, legalMoves: _m, ...rest } = x
          return rest
        }
        expect(strip(spectator)).toEqual(strip(player))
        expect(spectator.viewer).toEqual({ kind: 'spectator', bound })
        expect('legalMoves' in spectator).toBe(false)
      })
    }
  }

  it('the spectator render matches the bound player\'s, section for section', () => {
    const s = contactGame('spec-render', 'commander', 'platoon')
    const player = renderForLLM(stateForViewer(s, WHITE), RENDER_OPTS)
    const spectator = renderForLLM(stateForViewer(s, { kind: 'spectator', bound: 'white' }), RENDER_OPTS)
    for (const heading of ['## Your pieces', '## Known enemy ranks', '## Public log']) {
      expect(section(spectator, heading), heading).toBe(section(player, heading))
    }
  })

  it('a spectator bound to white learns nothing about black', () => {
    const s = contactGame('spec-hidden', 'commander', 'platoon')
    const vs = stateForViewer(s, { kind: 'spectator', bound: 'white' })
    const leaked = vs.pieces.filter((p) => p.color === 'black' && p.rank !== null && !p.revealed)
    expect(leaked).toEqual([])
  })
})

// ===========================================================================
// 5. 有煙無傷 — a fizzle reveals nothing
// ===========================================================================

describe('有煙無傷 — §5, 附錄 A(a): the fizzle survivor stays hidden', () => {
  it('工兵 attacking a 爆裂物 wins, advances, and is NOT 翻明', () => {
    const s = contactGame('fz-eng', 'engineer', 'bomb')
    const e = lastEvent(s)
    expect(e.combat?.outcome).toEqual({ kind: 'fizzle', survivorColor: 'white' })
    expect(e.combat?.survivorSquare).toBe(35)  // d5

    const survivor = pieceAtSquare(s, 'd5')
    expect(survivor.id).toBe('w-e2')
    expect(survivor.rank).toBe('engineer')
    expect(survivor.revealed).toBe(false)      // ← the whole point

    // The opponent gets nothing.
    const black = stateForViewer(s, BLACK)
    expect(viewOf(black, 'w-e2').rank).toBeNull()
    expect(black.pieces.filter((p) => p.color === 'white' && p.rank !== null)).toEqual([])

    // The owner still sees it.
    expect(viewOf(stateForViewer(s, WHITE), 'w-e2').rank).toBe('engineer')
  })

  it('a 爆裂物 attacking 工兵 dies, the defender stands and is NOT 翻明', () => {
    const s = contactGame('fz-def', 'bomb', 'engineer')
    const e = lastEvent(s)
    expect(e.combat?.outcome).toEqual({ kind: 'fizzle', survivorColor: 'black' })
    expect(e.combat?.survivorSquare).toBe(35)

    const survivor = pieceAtSquare(s, 'd5')
    expect(survivor.id).toBe('b-d7')
    expect(survivor.revealed).toBe(false)
    expect(viewOf(stateForViewer(s, WHITE), 'b-d7').rank).toBeNull()
  })

  it('the fizzle event carries nothing but the survivor\'s colour', () => {
    for (const [w, b] of [['engineer', 'bomb'], ['flag', 'bomb'], ['bomb', 'engineer'], ['bomb', 'flag']] as const) {
      const s = contactGame('fz-shape', w, b)
      const outcome = lastEvent(s).combat!.outcome
      expect(outcome.kind).toBe('fizzle')
      expect(Object.keys(outcome).sort()).toEqual(['kind', 'survivorColor'])
      expect(JSON.stringify(outcome)).not.toMatch(/"(engineer|flag|bomb)"/)
    }
  })

  it('工兵 and 軍旗 are indistinguishable to the opponent — the ambiguity of 附錄 A(a)', () => {
    // Two worlds that differ ONLY in whether white's surviving piece is 工兵 or
    // 軍旗. If black's payload can tell them apart, the smoke bomb is useless
    // and the flag has been named.
    const asEngineer = contactGame('fz-amb', 'engineer', 'bomb')
    const asFlag = contactGame('fz-amb', 'flag', 'bomb')

    expect(JSON.stringify(stateForViewer(asEngineer, BLACK)))
      .toBe(JSON.stringify(stateForViewer(asFlag, BLACK)))
    expect(renderForLLM(stateForViewer(asEngineer, BLACK), RENDER_OPTS))
      .toBe(renderForLLM(stateForViewer(asFlag, BLACK), RENDER_OPTS))

    // …and the two worlds really are different, so the assertion above is not
    // passing by accident.
    expect(JSON.stringify(stateForViewer(asEngineer, OMNISCIENT)))
      .not.toBe(JSON.stringify(stateForViewer(asFlag, OMNISCIENT)))
  })

  it('the same holds when the 爆裂物 is the attacker', () => {
    const asEngineer = contactGame('fz-amb2', 'bomb', 'engineer')
    const asFlag = contactGame('fz-amb2', 'bomb', 'flag')
    expect(JSON.stringify(stateForViewer(asEngineer, WHITE)))
      .toBe(JSON.stringify(stateForViewer(asFlag, WHITE)))
    expect(JSON.stringify(stateForViewer(asEngineer, OMNISCIENT)))
      .not.toBe(JSON.stringify(stateForViewer(asFlag, OMNISCIENT)))
  })

  it('the surviving 工兵/軍旗 is not named even after it promotes (§5, §6)', () => {
    // A pawn that walks over a 爆裂物 onto the 8th rank survives and promotes.
    // The promotion is public; the 兵種 that made it possible is not.
    const asEngineer = position([
      { at: 'e7', color: 'white', carrier: 'pawn', rank: 'engineer', id: 'W1' },
      { at: 'd8', color: 'black', carrier: 'rook', rank: 'bomb', id: 'B1' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'flag', id: 'WK' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
    ])
    const asFlag = position([
      { at: 'e7', color: 'white', carrier: 'pawn', rank: 'flag', id: 'W1' },
      { at: 'd8', color: 'black', carrier: 'rook', rank: 'bomb', id: 'B1' },
      { at: 'a1', color: 'white', carrier: 'king', rank: 'engineer', id: 'WK' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'flag', id: 'BK' },
    ])
    const a = applyMove(asEngineer, mv('e7', 'd8', 'queen'))
    const b = applyMove(asFlag, mv('e7', 'd8', 'queen'))

    expect(lastEvent(a).combat!.outcome.kind).toBe('fizzle')
    expect(lastEvent(a).promoted).toBe('queen')
    expect(a.pieces.find((p) => p.id === 'W1')!.revealed).toBe(false)
    expect(a.status.kind).toBe('playing')
    expect(JSON.stringify(stateForViewer(a, BLACK))).toBe(JSON.stringify(stateForViewer(b, BLACK)))
  })
})

// ===========================================================================
// 6. 同階雙亡 vs 爆裂物引爆 must be distinguishable
// ===========================================================================

describe('§4「翻明總表」— mutual-rank and bomb detonation are distinct announcements', () => {
  const mutual = contactGame('ev-mutual', 'brigade', 'brigade')
  const detonated = contactGame('ev-bomb', 'bomb', 'brigade')

  it('produces two different outcome kinds', () => {
    const m = lastEvent(mutual).combat!.outcome
    const d = lastEvent(detonated).combat!.outcome
    expect(m.kind).toBe('mutual-rank')
    expect(d.kind).toBe('bomb-detonate')
    expect(m.kind).not.toBe(d.kind)
    expect(JSON.stringify(m)).not.toBe(JSON.stringify(d))
  })

  it('mutual-rank announces the shared 階級; detonation announces only the 爆裂物', () => {
    expect(lastEvent(mutual).combat!.outcome).toEqual({ kind: 'mutual-rank', rank: 'brigade' })
    expect(lastEvent(detonated).combat!.outcome).toEqual({ kind: 'bomb-detonate', bombColor: 'white' })
    // The victim's 兵種 appears nowhere in the detonation event.
    expect(JSON.stringify(lastEvent(detonated))).not.toContain('brigade')
  })

  it('the bomb\'s victim is not 翻明 and its rank never crosses the boundary', () => {
    const victim = detonated.pieces.find((p) => p.id === 'b-d7')!
    expect(victim.rank).toBe('brigade')
    expect(victim.square).toBeNull()
    expect(victim.revealed).toBe(false)
    expect(viewOf(stateForViewer(detonated, WHITE), 'b-d7').rank).toBeNull()

    // The bomb itself IS announced (§4 table row 3).
    const bomb = detonated.pieces.find((p) => p.id === 'w-e2')!
    expect(bomb.revealed).toBe(true)
    expect(viewOf(stateForViewer(detonated, BLACK), 'w-e2').rank).toBe('bomb')
  })

  it('the victim cannot mistake a detonation for an equal-rank trade', () => {
    // Black lost a 旅長 in both games. If the two announcements collapsed,
    // black would read the detonation as "the attacker was also 旅長".
    const asMutual = renderForLLM(stateForViewer(mutual, BLACK), RENDER_OPTS)
    const asBomb = renderForLLM(stateForViewer(detonated, BLACK), RENDER_OPTS)
    expect(asMutual).not.toBe(asBomb)
    expect(section(asMutual, '## Public log')).toContain('同階雙亡')
    expect(section(asBomb, '## Public log')).toContain('爆裂物')
    expect(section(asBomb, '## Public log')).not.toContain('同階雙亡')
    expect(section(asBomb, '## Public log')).not.toContain(RANK_NAMES_ZH.brigade)
  })

  it('爆裂物 vs 爆裂物 announces both, and is its own kind', () => {
    const both = contactGame('ev-bb', 'bomb', 'bomb')
    expect(lastEvent(both).combat!.outcome).toEqual({ kind: 'bomb-vs-bomb' })
    for (const id of ['w-e2', 'b-d7']) {
      expect(both.pieces.find((p) => p.id === id)!.revealed).toBe(true)
      expect(viewOf(stateForViewer(both, WHITE), id).rank).toBe('bomb')
      expect(viewOf(stateForViewer(both, BLACK), id).rank).toBe('bomb')
    }
  })

  it('the loser of an ordinary capture is never 翻明', () => {
    const s = contactGame('ev-plain', 'commander', 'platoon')
    expect(lastEvent(s).combat!.outcome).toEqual({ kind: 'attacker-wins', winnerRank: 'commander' })
    const loser = s.pieces.find((p) => p.id === 'b-d7')!
    expect(loser.revealed).toBe(false)
    expect(viewOf(stateForViewer(s, WHITE), 'b-d7').rank).toBeNull()
    expect(JSON.stringify(stateForViewer(s, WHITE).log)).not.toContain('platoon')
  })

  it('all five §4 outcomes stay pairwise distinct on the wire', () => {
    const shapes = [
      contactGame('d1', 'commander', 'platoon'),
      contactGame('d2', 'platoon', 'commander'),
      contactGame('d3', 'brigade', 'brigade'),
      contactGame('d4', 'bomb', 'brigade'),
      contactGame('d5', 'bomb', 'bomb'),
      contactGame('d6', 'bomb', 'engineer'),
    ].map((g) => JSON.stringify(lastEvent(g).combat!.outcome))
    expect(new Set(shapes).size).toBe(shapes.length)
  })
})

// ===========================================================================
// 7. renderForLLM — grep the text
// ===========================================================================

describe('renderForLLM — no 兵種 the reader is not entitled to', () => {
  const cases: Array<[string, GameState]> = [
    ['opening', startedGame('r1')],
    ['after a reveal', contactGame('r2', 'commander', 'platoon')],
    ['after 有煙無傷', contactGame('r3', 'engineer', 'bomb')],
    ['after a detonation', contactGame('r4', 'bomb', 'brigade')],
    ['after 同階雙亡', contactGame('r5', 'brigade', 'brigade')],
    ['mid game', playAll(startedGame('r6'), [
      mv('e2', 'e4'), mv('d7', 'd5'), mv('g1', 'f3'), mv('b8', 'c6'), mv('f1', 'c4'), mv('c8', 'f5'),
    ])],
    ['finished', resign(contactGame('r7', 'commander', 'platoon'), 'black')],
  ]

  for (const [label, s] of cases) {
    for (const v of ALL_VIEWERS) {
      it(`${label} — ${viewerLabel(v)}`, () => {
        const text = renderForLLM(stateForViewer(s, v), RENDER_OPTS)
        const entitled = entitlement(s, v)

        // Every Chinese 兵種 name and every Rank identifier in the piece
        // listings must belong to a piece this reader may see. (The public log
        // below them is excluded on purpose: §5's 「工兵 or 軍旗」 line is the
        // designed two-way signal of 附錄 A(a), not a leak.)
        const listings = text.split('## Public log')[0]!
        const bad: string[] = []
        s.pieces.forEach((p, i) => {
          if (entitled[i] || p.square === null) return
          const sq = squareName(p.square)
          for (const line of listings.split('\n')) {
            if (!line.includes(sq)) continue
            for (const r of ALL_RANKS) {
              if (line.includes(RANK_NAMES_ZH[r]) || new RegExp(`\\b${r}\\b`).test(line)) {
                bad.push(`${sq} (hidden ${p.color}) named ${r} on: ${line.trim()}`)
              }
            }
          }
        })
        expect(bad).toEqual([])

        // The "Known enemy ranks" block lists exactly the entitled enemy
        // pieces still on the board — no more.
        const self = v.kind === 'player' ? v.color
          : v.kind === 'spectator' ? v.bound
            : v.kind === 'replay-player' ? v.color : null
        if (self !== null) {
          const enemy: Color = self === 'white' ? 'black' : 'white'
          const shouldList = s.pieces.filter(
            (p, i) => p.color === enemy && p.square !== null && entitled[i],
          )
          const listed = listedPieceLines(text, '## Known enemy ranks')
          expect(listed.length, `${label}/${viewerLabel(v)} enemy listing`).toBe(shouldList.length)
          for (const p of shouldList) {
            expect(listed.some((l) => l.startsWith(`${squareName(p.square!)} `))).toBe(true)
          }
        }
      })
    }
  }

  it('a hidden enemy piece is rendered as ??? and never by name', () => {
    const s = playAll(startedGame('r-unknown'), [mv('e2', 'e4'), mv('d7', 'd5')])
    const text = renderForLLM(stateForViewer(s, WHITE), RENDER_OPTS)
    expect(listedPieceLines(text, '## Known enemy ranks')).toEqual([])
    expect(section(text, '## Known enemy ranks')).toContain('(none yet)')
    expect(text).toContain('16 enemy piece(s) on the board still have an unknown 兵種')
    // white's own listing is fully named, so ??? must not appear there
    expect(section(text, '## Your pieces')).not.toContain('???')
  })

  it('the omniscient replay view is the only one that names everything', () => {
    const s = playAll(startedGame('r-omni'), [mv('e2', 'e4'), mv('d7', 'd5')])
    const omni = renderForLLM(stateForViewer(s, OMNISCIENT), RENDER_OPTS)
    expect(omni).toContain('## White pieces')
    expect(omni).toContain('## Black pieces')
    expect(omni).not.toContain('???')
    for (const v of [WHITE, BLACK]) {
      expect(renderForLLM(stateForViewer(s, v), RENDER_OPTS)).not.toContain('## Black pieces')
    }
  })
})

// ===========================================================================
// 8. The move list is not an oracle
// ===========================================================================

describe('legalMoves in the payload — §3, 附錄 A(b)', () => {
  it('is offered only to the player on turn', () => {
    const s = startedGame('lm')
    // 8 pawns × 2 steps + 2 knights × 2 squares + pass
    expect(stateForViewer(s, WHITE).legalMoves).toHaveLength(21)
    expect(stateForViewer(s, BLACK).legalMoves).toBeUndefined()
    expect(stateForViewer(s, { kind: 'spectator', bound: 'white' }).legalMoves).toBeUndefined()
    expect(stateForViewer(s, OMNISCIENT).legalMoves).toBeUndefined()
    expect(stateForViewer(s, { kind: 'replay-player', color: 'white' }).legalMoves).toBeUndefined()
    expect(stateForViewer(resign(s, 'black'), WHITE).legalMoves).toBeUndefined()
  })

  it('offers suicidal moves — a filtered list would leak the 兵種 layer', () => {
    // §4: moving your 軍旗 into another piece is legal and loses the game on
    // the spot. If the engine hid such moves, the absence would name the flag.
    const withFlag = playAll(
      startedGame('suicide', { white: { 'w-e2': 'flag' }, black: { 'b-d7': 'commander' } }),
      [mv('e2', 'e4'), mv('d7', 'd5')],
    )
    const moves = legalMoves(withFlag, 'white')
    expect(moves.some((m) => m.kind === 'move' && m.from === 28 && m.to === 35)).toBe(true)

    const withCommander = playAll(
      startedGame('suicide', { white: { 'w-e2': 'commander' }, black: { 'b-d7': 'commander' } }),
      [mv('e2', 'e4'), mv('d7', 'd5')],
    )
    expect(JSON.stringify(legalMoves(withCommander, 'white'))).toBe(JSON.stringify(moves))
  })

  it('pass is always present, and its presence never depends on a rank', () => {
    const s = startedGame('pass')
    expect(legalMoves(s, 'white').some((m) => m.kind === 'pass')).toBe(true)
    expect(stateForViewer(s, WHITE).legalMoves!.some((m) => m.kind === 'pass')).toBe(true)
  })
})

// ===========================================================================
// 9. Every announced rank is backed by a 翻明 piece
// ===========================================================================

describe('the public log announces only what §4 says it may', () => {
  const games: GameState[] = [
    contactGame('log1', 'commander', 'platoon'),
    contactGame('log2', 'platoon', 'commander'),
    contactGame('log3', 'brigade', 'brigade'),
    contactGame('log4', 'bomb', 'brigade'),
    contactGame('log5', 'bomb', 'bomb'),
    contactGame('log6', 'engineer', 'bomb'),
    contactGame('log7', 'bomb', 'flag'),
  ]

  it('a rank in the log always belongs to a piece flagged revealed', () => {
    for (const g of games) {
      const revealed = new Set(g.pieces.filter((p) => p.revealed).map((p) => p.rank))
      for (const e of g.log) {
        const o = e.combat?.outcome
        if (!o) continue
        if (o.kind === 'attacker-wins' || o.kind === 'defender-wins') {
          expect(revealed.has(o.winnerRank)).toBe(true)
        } else if (o.kind === 'mutual-rank') {
          expect(revealed.has(o.rank)).toBe(true)
        } else {
          // 爆裂物 outcomes name a colour, never a 階級.
          expect(JSON.stringify(o)).not.toMatch(
            new RegExp(`"(${ALL_RANKS.filter((r) => r !== 'bomb').join('|')})"`),
          )
        }
      }
    }
  })

  it('applyMove leaves the source state untouched — techspec §4 note 10', () => {
    const s = deepFreeze(startedGame('pure'))
    const before = JSON.stringify(s)
    const after = applyMove(s, mv('e2', 'e4'))
    expect(JSON.stringify(s)).toBe(before)
    expect(after.pieces).not.toBe(s.pieces)
  })
})

// ===========================================================================
// 10. Who watches the watchmen
//
// A property test that cannot fail is worse than no test — it reports safety
// it never checked. Every detector used by redaction.property.ts is fired at a
// ViewerState with a leak planted in it, and must catch it.
// ===========================================================================

describe('the leak detectors catch a planted leak', () => {
  const s = playAll(startedGame('plant'), [mv('e2', 'e4'), mv('d7', 'd5')])
  const hidden = s.pieces.findIndex((p) => p.color === 'white' && !p.revealed)
  const leakedRank: Rank = s.pieces[hidden]!.rank

  function blackView(): ViewerState {
    return JSON.parse(JSON.stringify(stateForViewer(s, BLACK))) as ViewerState
  }

  it('is clean to begin with', () => {
    const vs = blackView()
    expect(deepWalkViolations(s, BLACK, vs)).toEqual([])
    expect(rawJsonViolations(s, BLACK, vs)).toEqual([])
    expect(hidden).toBeGreaterThanOrEqual(0)
  })

  it('catches a rank written onto a piece the viewer may not see', () => {
    const vs = blackView()
    vs.pieces[hidden]!.rank = leakedRank
    expect(deepWalkViolations(s, BLACK, vs).join()).toContain('NOT ENTITLED')
    expect(rawJsonViolations(s, BLACK, vs).length).toBeGreaterThan(0)
  })

  it('catches a rank smuggled into an undeclared field', () => {
    const vs = blackView() as ViewerState & Record<string, unknown>
    vs.solverHint = { e2: leakedRank }
    expect(deepWalkViolations(s, BLACK, vs).join()).toContain('UNEXPECTED')
    expect(rawJsonViolations(s, BLACK, vs).length).toBeGreaterThan(0)
  })

  it('catches a stray reference back into the authoritative piece list', () => {
    // The exact bug redact.ts's header warns about: one alias and the whole
    // hidden layer rides along.
    const vs = blackView() as ViewerState & Record<string, unknown>
    vs.source = s.pieces
    expect(deepWalkViolations(s, BLACK, vs).join()).toContain('UNEXPECTED')
    expect(rawJsonViolations(s, BLACK, vs).length).toBeGreaterThan(0)
  })

  it('catches a rank buried deep inside a log entry', () => {
    const withCombat = contactGame('plant2', 'commander', 'platoon')
    const vs = JSON.parse(JSON.stringify(stateForViewer(withCombat, BLACK))) as ViewerState
    const combat = vs.log.find((e) => e.combat)!.combat as unknown as Record<string, unknown>
    combat.loserRank = 'platoon'
    expect(deepWalkViolations(withCombat, BLACK, vs).join()).toContain('UNEXPECTED')
    expect(rawJsonViolations(withCombat, BLACK, vs).length).toBeGreaterThan(0)
  })

  it('catches a rank hiding in a discriminant', () => {
    const vs = blackView() as ViewerState & Record<string, unknown>
    ;(vs.status as unknown as Record<string, unknown>).kind = 'commander'
    expect(deepWalkViolations(s, BLACK, vs).join()).toMatch(/not a known discriminant/)
    expect(rawJsonViolations(s, BLACK, vs).length).toBeGreaterThan(0)
  })

  it('catches a 兵種 printed next to a hidden piece in the LLM render', () => {
    const text = renderForLLM(stateForViewer(s, BLACK), RENDER_OPTS)
    expect(renderViolations(s, BLACK, text)).toEqual([])

    const doctored = text.replace(
      '## Known enemy ranks',
      `## Known enemy ranks\ne4 pawn ${RANK_NAMES_ZH[leakedRank]}`,
    )
    expect(renderViolations(s, BLACK, doctored).length).toBeGreaterThan(0)
  })
})
