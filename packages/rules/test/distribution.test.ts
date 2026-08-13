/**
 * §2 兵種數量配置 — HOW MANY of each 兵種 a side gets.
 *
 *   「數量配置為可調參數，見附錄 B。」
 *
 * 附錄 B lists 兵種數量配置 as a tunable and says every tunable 「必須為設定值，
 * 不得寫死」. It is now `config.distribution`, defaulting to the gamebook table,
 * exactly as the 結算格 shape became `config.scoringSquares` before it.
 *
 * WHY it had to move (notebook §4.5): four playtests produced ZERO 有煙無傷, so
 * 附錄 A(a) — the joint 工兵/軍旗 immunity the entire hidden layer is built on —
 * has never once fired in play. The hypothesis is that 工兵2 = 爆裂物2 leaves
 * both 工兵 earmarked against the two 爆裂物, so neither is ever spent scouting.
 * Testing that needs 工兵4 to be a SETTING, not an edit.
 *
 * What is checked here:
 *   1. every preset is a legal §2 table — it sums to 16, and nothing can build
 *      one that does not;
 *   2. the multiset `validateAssignment` demands is the configured one;
 *   3. a code legal under one table is REJECTED under another, naming the 兵種;
 *   4. the combinations figure moves with the table and equals 16!/∏(nᵣ!)
 *      computed independently, in BigInt;
 *   5. a default game is byte-for-byte the game it was before the change.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_RANKS,
  DEFAULT_ASSIGNMENT_BY_HOME_SQUARE,
  DEFAULT_CONFIG,
  DISTRIBUTION,
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  PIECES_PER_SIDE,
  checkDistribution,
  distributionTotal,
} from '../src/constants.js'
import { applyMove } from '../src/game.js'
import { legalMoves } from '../src/moves.js'
import { stateForViewer } from '../src/redact.js'
import { exportJson, exportMarkdown } from '../src/render/record.js'
import { renderForLLM, renderRulesForLLM } from '../src/render/text.js'
import {
  createGame,
  defaultAssignment,
  defaultRankByHomeKey,
  startingSlot,
  submitAssignment,
  validateAssignment,
} from '../src/setup.js'
import {
  SETUP_CODE_ALPHABET,
  SETUP_CODE_COMBINATIONS,
  SETUP_CODE_EXAMPLE,
  SETUP_CODE_LEGEND,
  SETUP_CODE_LENGTH,
  decodeSetupCode,
  encodeSetupCode,
  setupCodeCombinations,
  setupCodeCountsText,
  setupCodeExample,
  setupCodeLegend,
  setupCodeLength,
  setupCodeSlots,
} from '../src/setupcode.js'
import type {
  Color,
  GameConfig,
  GameState,
  Move,
  PieceId,
  Rank,
  RankDistribution,
  ViewerState,
} from '../src/types.js'
import { position } from './helpers.js'

const COLORS: Color[] = ['white', 'black']
const RENDER = { baseUrl: 'https://example.test', token: 'TOK' }

/**
 * The table the engine carried as a module constant before it became a setting.
 *
 * Hard-coded, and deliberately not derived from anything: it is the oracle for
 * "a default game is the game it always was". If `DISTRIBUTION_STANDARD` ever
 * drifts off this, every deployment, every setup code and every 同階 probability
 * in every default game silently changes, and this literal is what notices.
 */
const OLD_DISTRIBUTION: Record<Rank, number> = {
  commander: 1, general: 1, division: 1, brigade: 2, regiment: 2,
  battalion: 2, company: 1, platoon: 1, engineer: 2, flag: 1, bomb: 2,
}

/** The pre-change fallback deployment, home key → 兵種. Same oracle, same reason. */
const OLD_DEFAULT_ASSIGNMENT: Record<string, Rank> = {
  a1: 'flag', b1: 'bomb', c1: 'brigade', d1: 'commander',
  e1: 'general', f1: 'brigade', g1: 'bomb', h1: 'division',
  a2: 'engineer', b2: 'regiment', c2: 'battalion', d2: 'company',
  e2: 'platoon', f2: 'battalion', g2: 'regiment', h2: 'engineer',
}

/** The 653,837,184,000 the LLM view has always quoted for the §2 table. */
const OLD_COMBINATIONS = 653_837_184_000

const PRESETS: [string, RankDistribution][] = [
  ['STANDARD', DISTRIBUTION_STANDARD],
  ['SCOUTS', DISTRIBUTION_SCOUTS],
  ['TOP_HEAVY', DISTRIBUTION_TOP_HEAVY],
]

const SCOUTS: Partial<GameConfig> = { distribution: DISTRIBUTION_SCOUTS }
const TOP_HEAVY: Partial<GameConfig> = { distribution: DISTRIBUTION_TOP_HEAVY }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

/** The multiset a table demands, as a sorted list of 16 ranks. */
function multiset(d: RankDistribution): Rank[] {
  const out: Rank[] = []
  for (const rank of ALL_RANKS) for (let i = 0; i < d[rank]; i++) out.push(rank)
  return out.sort()
}

function randomAssignment(color: Color, s: GameState, rnd: () => number): Record<PieceId, Rank> {
  const pool = multiset(s.config.distribution)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  const out: Record<PieceId, Rank> = {}
  s.pieces.filter((p) => p.color === color).forEach((p, i) => { out[p.id] = pool[i]! })
  return out
}

function decoded(code: string, color: Color, s: GameState): Record<PieceId, Rank> {
  const out = decodeSetupCode(code, color, s)
  if ('error' in out) throw new Error(`expected "${code}" to decode, got: ${out.error}`)
  return out.assignment
}

function rejection(code: string, color: Color, s: GameState): string {
  const out = decodeSetupCode(code, color, s)
  if ('assignment' in out) throw new Error(`expected "${code}" to be rejected`)
  return out.error
}

function deploy(s: GameState, color: Color, code: string): GameState {
  return submitAssignment(s, color, decoded(code, color, s))
}

/** Both sides deployed with the ladder-order example for that game's table. */
function deployedGame(id: string, config?: Partial<GameConfig>): GameState {
  let s = createGame(id, config)
  const code = setupCodeExample(s.config.distribution)
  for (const color of COLORS) s = deploy(s, color, code)
  return s
}

/**
 * A whole game, deterministic in `seed`. Move choice depends only on the seed
 * and on `legalMoves`, which reads the carrier layer alone — so two traces run
 * with the same seed differ only where the CONFIG makes them differ.
 */
function trace(seed: number, maxPlies: number, config?: Partial<GameConfig>): GameState[] {
  const rnd = rng(seed)
  let s = createGame('trace', config)
  s = submitAssignment(s, 'white', randomAssignment('white', s, rnd))
  s = submitAssignment(s, 'black', randomAssignment('black', s, rnd))

  const states: GameState[] = [s]
  while (s.status.kind === 'playing' && states.length <= maxPlies) {
    const options = legalMoves(s, s.toMove).filter((m) => m.kind !== 'pass')
    const move: Move = options.length > 0
      ? options[Math.floor(rnd() * options.length)]!
      : { kind: 'pass' }
    s = applyMove(s, move)
    states.push(s)
  }
  return states
}

// ---------------------------------------------------------------------------
// 1. Every preset is a legal §2 table
// ---------------------------------------------------------------------------

describe('the presets are legal §2 tables', () => {
  it.each(PRESETS)('%s sums to 16', (_name, d) => {
    expect(ALL_RANKS.reduce((n, r) => n + d[r], 0)).toBe(16)
    expect(distributionTotal(d)).toBe(PIECES_PER_SIDE)
    expect(PIECES_PER_SIDE).toBe(16)
    expect(checkDistribution(d)).toBeNull()
  })

  it.each(PRESETS)('%s covers every 兵種 with a non-negative integer', (_name, d) => {
    for (const rank of ALL_RANKS) {
      expect(Number.isInteger(d[rank]), `${rank} is not an integer`).toBe(true)
      expect(d[rank]).toBeGreaterThanOrEqual(0)
    }
    expect(Object.keys(d).sort()).toEqual([...ALL_RANKS].sort())
  })

  it('spells out each preset, so a silent edit to one has to be an edit to this file', () => {
    expect(DISTRIBUTION_STANDARD).toEqual(OLD_DISTRIBUTION)
    expect(DISTRIBUTION_SCOUTS).toEqual({
      commander: 1, general: 1, division: 1, brigade: 2, regiment: 1,
      battalion: 1, company: 1, platoon: 1, engineer: 4, flag: 1, bomb: 2,
    })
    expect(DISTRIBUTION_TOP_HEAVY).toEqual({
      commander: 1, general: 2, division: 2, brigade: 2, regiment: 1,
      battalion: 1, company: 1, platoon: 1, engineer: 2, flag: 1, bomb: 2,
    })
  })

  it('SCOUTS is 工兵4, paid for by one 團長 and one 營長 (notebook §4.5)', () => {
    const moved = ALL_RANKS.filter((r) => DISTRIBUTION_SCOUTS[r] !== DISTRIBUTION_STANDARD[r])
    expect(moved.sort()).toEqual(['battalion', 'engineer', 'regiment'])
    expect(DISTRIBUTION_SCOUTS.engineer).toBe(4)
    // the point of the variant: more 工兵 than 爆裂物, so a 工兵 is spendable
    expect(DISTRIBUTION_SCOUTS.engineer).toBeGreaterThan(DISTRIBUTION_SCOUTS.bomb)
    expect(DISTRIBUTION_STANDARD.engineer).toBe(DISTRIBUTION_STANDARD.bomb)
    // 有煙無傷 narrows the survivor to 工兵-or-軍旗: three candidates, now five
    expect(DISTRIBUTION_STANDARD.engineer + DISTRIBUTION_STANDARD.flag).toBe(3)
    expect(DISTRIBUTION_SCOUTS.engineer + DISTRIBUTION_SCOUTS.flag).toBe(5)
  })

  it('TOP_HEAVY moves the doubles onto ranks nobody risks (notebook §4.4)', () => {
    const moved = ALL_RANKS.filter((r) => DISTRIBUTION_TOP_HEAVY[r] !== DISTRIBUTION_STANDARD[r])
    expect(moved.sort()).toEqual(['battalion', 'division', 'general', 'regiment'])
    for (const high of ['general', 'division'] as Rank[]) expect(DISTRIBUTION_TOP_HEAVY[high]).toBe(2)
    for (const mid of ['regiment', 'battalion'] as Rank[]) expect(DISTRIBUTION_TOP_HEAVY[mid]).toBe(1)
  })

  it('DISTRIBUTION is an alias of DISTRIBUTION_STANDARD', () => {
    expect(DISTRIBUTION).toBe(DISTRIBUTION_STANDARD)
    expect({ ...DISTRIBUTION }).toEqual(OLD_DISTRIBUTION)
  })

  it('a preset is frozen — nobody can retune a running game by mutating a constant', () => {
    for (const [, d] of PRESETS) expect(Object.isFrozen(d)).toBe(true)
  })
})

describe('sum-16 is enforced, never assumed', () => {
  const short: RankDistribution = { ...DISTRIBUTION_STANDARD, engineer: 1 }   // 15
  const long: RankDistribution = { ...DISTRIBUTION_STANDARD, engineer: 4 }    // 18

  it('names the total when a table does not sum to 16', () => {
    expect(checkDistribution(short)).toMatch(/sums to 15/)
    expect(checkDistribution(long)).toMatch(/sums to 18/)
    expect(distributionTotal(short)).toBe(15)
  })

  it('rejects a missing 兵種, a fraction and a negative count', () => {
    const missing = { ...DISTRIBUTION_STANDARD } as Record<string, number>
    delete missing['flag']
    expect(checkDistribution(missing as RankDistribution)).toMatch(/flag/)
    expect(checkDistribution({ ...DISTRIBUTION_STANDARD, company: 1.5 })).toMatch(/company/)
    expect(checkDistribution({ ...DISTRIBUTION_STANDARD, company: -1 })).toMatch(/company/)
  })

  it('createGame refuses a config whose table is not 16', () => {
    expect(() => createGame('bad', { distribution: short })).toThrow(/sums to 15/)
    expect(() => createGame('bad', { distribution: long })).toThrow(/sums to 18/)
    // …and the message says it is the DISTRIBUTION that is wrong, not the player
    expect(() => createGame('bad', { distribution: short })).toThrow(/兵種 distribution/)
  })

  it('a game holds a frozen copy, so the caller cannot retune it afterwards', () => {
    const mine: Record<Rank, number> = { ...DISTRIBUTION_SCOUTS }
    const s = createGame('copy', { distribution: mine })
    mine.engineer = 9
    expect(s.config.distribution.engineer).toBe(4)
    expect(Object.isFrozen(s.config.distribution)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. validateAssignment demands exactly the configured multiset
// ---------------------------------------------------------------------------

describe('§9 validateAssignment reads config.distribution', () => {
  it.each(PRESETS)('%s: accepts every permutation of its own multiset', (_name, d) => {
    const s = createGame('v', { distribution: d })
    const rnd = rng(20260812)
    for (let n = 0; n < 25; n++) {
      for (const color of COLORS) {
        expect(validateAssignment(randomAssignment(color, s, rnd), color, s)).toBeNull()
      }
    }
  })

  it.each(PRESETS)('%s: rejects the multiset of every OTHER preset, naming a 兵種', (name, d) => {
    const s = createGame('v', { distribution: d })
    for (const [otherName, other] of PRESETS) {
      if (otherName === name) continue
      const foreign = createGame('other', { distribution: other })
      const a = randomAssignment('white', foreign, rng(7))
      const problem = validateAssignment(a, 'white', s)
      expect(problem, `${otherName} multiset accepted in a ${name} game`).not.toBeNull()
      const named = ALL_RANKS.filter((r) => problem!.includes(r))
      expect(named.length).toBeGreaterThan(0)
      // the 兵種 it names really is one whose count differs
      for (const rank of named) expect(other[rank]).not.toBe(d[rank])
    }
  })

  it('the accepted multiset IS the table — one too many of a 兵種 is rejected', () => {
    const s = createGame('v', SCOUTS)
    const a = randomAssignment('white', s, rng(3))
    const ids = Object.keys(a)
    // swap one 工兵 for a second 團長: still 16 pieces, no longer the table
    const anEngineer = ids.find((id) => a[id] === 'engineer')!
    const bad = { ...a, [anEngineer]: 'regiment' as Rank }
    const problem = validateAssignment(bad, 'white', s)
    expect(problem).toMatch(/rank regiment: expected 1, got 2/)
  })

  it('the same assignment can be legal in one game and illegal in another', () => {
    const standard = createGame('a')
    const scouts = createGame('b', SCOUTS)
    const a = randomAssignment('white', standard, rng(11))
    expect(validateAssignment(a, 'white', standard)).toBeNull()
    expect(validateAssignment(a, 'white', scouts)).toMatch(/rank /)
  })
})

describe('the deterministic fallback follows the table too', () => {
  it.each(PRESETS)('%s: defaultAssignment is accepted by its own game', (_name, d) => {
    const s = createGame('d', { distribution: d })
    for (const color of COLORS) {
      expect(validateAssignment(defaultAssignment(color, s), color, s)).toBeNull()
    }
  })

  it('reproduces the historical table EXACTLY under the standard distribution', () => {
    expect(defaultRankByHomeKey(DISTRIBUTION_STANDARD)).toEqual(OLD_DEFAULT_ASSIGNMENT)
    expect(DEFAULT_ASSIGNMENT_BY_HOME_SQUARE).toEqual(OLD_DEFAULT_ASSIGNMENT)

    const s = createGame('d')
    for (const color of COLORS) {
      const a = defaultAssignment(color, s)
      for (const [id, rank] of Object.entries(a)) {
        expect(rank).toBe(OLD_DEFAULT_ASSIGNMENT[startingSlot(id)!.homeKey])
      }
    }
  })

  it('keeps every seed slot the table can still afford, and fills the rest in 階級 order', () => {
    // SCOUTS: 團長 and 營長 drop to one each, so the SECOND of each (g2, f2 in
    // home-key order) loses its seed and is refilled from what is left — 工兵.
    const scouts = defaultRankByHomeKey(DISTRIBUTION_SCOUTS)
    expect(scouts).toEqual({ ...OLD_DEFAULT_ASSIGNMENT, f2: 'engineer', g2: 'engineer' })
    expect(Object.values(scouts).filter((r) => r === 'engineer')).toHaveLength(4)
  })

  it('is a bijection onto the table for every preset', () => {
    for (const [, d] of PRESETS) {
      const byHomeKey = defaultRankByHomeKey(d)
      expect(Object.keys(byHomeKey)).toHaveLength(16)
      expect(Object.values(byHomeKey).sort()).toEqual(multiset(d))
    }
  })

  it('refuses to invent a fallback for an impossible table', () => {
    expect(() => defaultRankByHomeKey({ ...DISTRIBUTION_STANDARD, bomb: 5 })).toThrow(/sums to 19/)
  })

  it('a fresh game carries placeholders that are themselves a legal army', () => {
    for (const [, d] of PRESETS) {
      const s = createGame('p', { distribution: d })
      for (const color of COLORS) {
        const own = s.pieces.filter((p) => p.color === color).map((p) => p.rank)
        expect(own.sort()).toEqual(multiset(d))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Setup codes: same alphabet, different required counts
// ---------------------------------------------------------------------------

describe('the setup code alphabet does not move — only the counts do', () => {
  it.each(PRESETS)('%s: the alphabet is 123456789FX and the length is 16', (_name, d) => {
    expect(SETUP_CODE_ALPHABET).toBe('123456789FX')
    expect(setupCodeLegend(d).map((e) => e.letter).join('')).toBe(SETUP_CODE_ALPHABET)
    expect(setupCodeLength(d)).toBe(16)
    expect(setupCodeExample(d)).toHaveLength(16)
  })

  it('the legend counts are the configured ones', () => {
    for (const [, d] of PRESETS) {
      for (const entry of setupCodeLegend(d)) expect(entry.count).toBe(d[entry.rank])
    }
    expect(setupCodeLegend(DISTRIBUTION_SCOUTS).find((e) => e.rank === 'engineer')!.count).toBe(4)
    expect(setupCodeCountsText(DISTRIBUTION_SCOUTS)).toContain('4×工兵(9)')
    expect(setupCodeCountsText(DISTRIBUTION_STANDARD)).toContain('2×工兵(9)')
  })

  it('each example is valid in its own game and only there', () => {
    for (const [name, d] of PRESETS) {
      const s = createGame('x', { distribution: d })
      expect(validateAssignment(decoded(setupCodeExample(d), 'white', s), 'white', s)).toBeNull()
      for (const [otherName, other] of PRESETS) {
        if (otherName === name) continue
        expect(rejection(setupCodeExample(other), 'white', s)).toMatch(/wrong counts/)
      }
    }
  })
})

describe('a code valid under one table is rejected under another, naming the 兵種', () => {
  const standard = createGame('s')
  const scouts = createGame('s2', SCOUTS)
  const STANDARD_CODE = '1234455667899FXX'      // 團長2 營長2 工兵2
  const SCOUTS_CODE = '1234456789999FXX'        // 團長1 營長1 工兵4

  it('the two codes are the ladder examples of their own tables', () => {
    expect(setupCodeExample(DISTRIBUTION_STANDARD)).toBe(STANDARD_CODE)
    expect(setupCodeExample(DISTRIBUTION_SCOUTS)).toBe(SCOUTS_CODE)
  })

  it('standard-valid → rejected in a SCOUTS game, naming 團長', () => {
    expect(validateAssignment(decoded(STANDARD_CODE, 'white', standard), 'white', standard))
      .toBeNull()
    const error = rejection(STANDARD_CODE, 'white', scouts)
    expect(error).toMatch(/wrong counts/)
    expect(error).toMatch(/rank regiment: expected 1, got 2/)
    // and the message tells the player what this game actually wants
    expect(error).toContain('4×工兵(9)')
  })

  it('SCOUTS-valid → rejected in a standard game, naming 團長', () => {
    expect(validateAssignment(decoded(SCOUTS_CODE, 'white', scouts), 'white', scouts)).toBeNull()
    const error = rejection(SCOUTS_CODE, 'white', standard)
    expect(error).toMatch(/wrong counts/)
    expect(error).toMatch(/rank regiment: expected 2, got 1/)
    expect(error).toContain('2×工兵(9)')
  })

  it('names 工兵 when 工兵 is the first count that is wrong', () => {
    // everything above 工兵 matches SCOUTS; 工兵2 with 爆裂物4 still totals 16.
    const error = rejection('12344567899FXXXX', 'white', scouts)
    expect(error).toMatch(/rank engineer: expected 4, got 2/)
  })

  it('is still a LENGTH complaint when the code is not 16 characters', () => {
    for (const s of [standard, scouts]) {
      expect(rejection('123', 'white', s)).toMatch(/bad length/)
      expect(rejection(`${STANDARD_CODE}9`, 'white', s)).toMatch(/bad length/)
    }
  })

  it('an out-of-alphabet character is still that, and quotes THIS game’s counts', () => {
    const error = rejection('1234456789999FXZ', 'white', scouts)
    expect(error).toMatch(/bad character/)
    expect(error).toContain(SETUP_CODE_ALPHABET)
    expect(error).toContain('4×工兵(9)')
  })

  it('round-trips under a retuned table', () => {
    for (const [, d] of PRESETS) {
      let s = createGame('rt', { distribution: d })
      const code = setupCodeExample(d)
      for (const color of COLORS) {
        s = deploy(s, color, code)
        expect(encodeSetupCode(s, color)).toBe(code)
      }
      expect(s.status.kind).toBe('playing')
      expect(setupCodeSlots('white')).toHaveLength(16)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. The combinations figure — 16!/∏(nᵣ!), recomputed independently
// ---------------------------------------------------------------------------

/** 16!/∏(nᵣ!) in BigInt: no floating point, no shared code with the engine. */
function multinomial(d: RankDistribution): bigint {
  const fact = (n: number): bigint => {
    let out = 1n
    for (let i = 2n; i <= BigInt(n); i++) out *= i
    return out
  }
  let out = fact(ALL_RANKS.reduce((n, r) => n + d[r], 0))
  for (const rank of ALL_RANKS) out /= fact(d[rank])
  return out
}

describe('how many deployments exist moves with the table', () => {
  it.each(PRESETS)('%s matches 16!/∏(nᵣ!) computed in BigInt', (_name, d) => {
    expect(BigInt(setupCodeCombinations(d))).toBe(multinomial(d))
    expect(Number.isSafeInteger(setupCodeCombinations(d))).toBe(true)
  })

  it('工兵4 is a SMALLER space, and the figure depends on the counts alone', () => {
    const [std, scouts, top] = PRESETS.map(([, d]) => setupCodeCombinations(d))
    expect(std).toBe(OLD_COMBINATIONS)                 // 16!/(2!)^5
    expect(scouts).toBe(217_945_728_000)               // 16!/(2!·2!·4!·2!)
    // Fewer, not more: four interchangeable 工兵 collapse 4!=24 orderings into
    // one, where the two 團長/營長 they were taken from collapsed only 2·2.
    expect(scouts).toBeLessThan(std!)
    expect(scouts! * 3).toBe(std)

    // TOP_HEAVY is five doubled 兵種 again — 軍長/師長 instead of 團長/營長 — so it
    // is the SAME figure as the standard table. The multinomial counts how many
    // pieces share a 兵種, not which 兵種 they are; that the two tables play
    // completely differently is a fact about the ladder, not about the count.
    expect(top).toBe(OLD_COMBINATIONS)
    expect(new Set([std, scouts, top]).size).toBe(2)
  })

  it('the LLM deployment screen quotes the figure of the game it is rendering', () => {
    const view = (s: GameState): string =>
      renderForLLM(stateForViewer(s, { kind: 'player', color: 'white' }), RENDER)

    expect(view(createGame('a'))).toContain('653,837,184,000')
    const scouts = view(createGame('b', SCOUTS))
    expect(scouts).toContain('217,945,728,000')
    expect(scouts).not.toContain('653,837,184,000')
    expect(view(createGame('c', TOP_HEAVY))).toContain('653,837,184,000')
  })

  it('and quotes the counts, the example and the ×table of that game too', () => {
    const render = (config: Partial<GameConfig>): string =>
      renderForLLM(
        stateForViewer(createGame('b', config), { kind: 'player', color: 'white' }),
        RENDER,
      )

    const scouts = render(SCOUTS)
    expect(scouts).toContain(setupCodeExample(DISTRIBUTION_SCOUTS))
    expect(scouts).not.toContain(SETUP_CODE_EXAMPLE)
    for (const e of setupCodeLegend(DISTRIBUTION_SCOUTS)) {
      expect(scouts).toContain(`${e.letter}  ${e.zh}`)
    }
    expect(scouts).toMatch(/工兵\s+engineer\s+×4/)
    expect(scouts).toMatch(/團長\s+regiment\s+×1/)
    expect(scouts).toContain(`${RENDER.baseUrl}/llm/${RENDER.token}/setup/1234456789999FXX`)

    // TOP_HEAVY quotes the same TOTAL as the standard table, so the ×counts are
    // the only thing that tells the reader which game they are in.
    expect(render(TOP_HEAVY)).toMatch(/軍長\s+general\s+×2/)
    expect(render(TOP_HEAVY)).toMatch(/團長\s+regiment\s+×1/)
  })

  it('the rules primer states the counts it is given', () => {
    expect(renderRulesForLLM(RENDER, DISTRIBUTION_SCOUTS)).toMatch(/工兵\s+engineer\s+×4/)
    expect(renderRulesForLLM(RENDER)).toMatch(/工兵\s+engineer\s+×2/)
  })
})

// ---------------------------------------------------------------------------
// 5. The record says which table the game was played under
// ---------------------------------------------------------------------------

describe('the 棋譜 records the table the game was actually played with', () => {
  const line = (s: GameState): string => {
    const md = exportMarkdown(stateForViewer(s, { kind: 'replay-omniscient' }))
    const found = md.split('\n').filter((l) => l.startsWith('- 兵種 distribution (§2, per side):'))
    expect(found).toHaveLength(1)
    return found[0]!
  }

  it('a default game reads exactly as it always did', () => {
    expect(line(deployedGame('r1'))).toBe(
      '- 兵種 distribution (§2, per side): 司令×1 · 軍長×1 · 師長×1 · 旅長×2 · 團長×2 · 營長×2 '
      + '· 連長×1 · 排長×1 · 工兵×2 · 軍旗×1 · 爆裂物×2 — 16 per side',
    )
  })

  it('a retuned game reads as the table it was retuned to', () => {
    const scouts = line(deployedGame('r2', SCOUTS))
    expect(scouts).toContain('工兵×4')
    expect(scouts).toContain('團長×1')
    expect(scouts).toContain('— 16 per side')
  })

  it('the JSON carries the same table', () => {
    const json = exportJson(
      stateForViewer(deployedGame('r3', TOP_HEAVY), { kind: 'replay-omniscient' }),
    ) as { config: { distribution: { rank: Rank; count: number }[] } }
    const counts = Object.fromEntries(json.config.distribution.map((e) => [e.rank, e.count]))
    expect(counts).toEqual({ ...DISTRIBUTION_TOP_HEAVY })
  })
})

// ---------------------------------------------------------------------------
// 6. A default game is the game it was before the change
// ---------------------------------------------------------------------------

describe('a default game is unchanged', () => {
  it('DEFAULT_CONFIG keeps the §2 table', () => {
    expect(DEFAULT_CONFIG.distribution).toEqual(OLD_DISTRIBUTION)
    expect(createGame('g').config.distribution).toEqual(OLD_DISTRIBUTION)
  })

  it('the default-preset constants still read as they always did', () => {
    expect(SETUP_CODE_LENGTH).toBe(16)
    expect(SETUP_CODE_EXAMPLE).toBe('1234455667899FXX')
    expect(SETUP_CODE_COMBINATIONS).toBe(OLD_COMBINATIONS)
    for (const e of SETUP_CODE_LEGEND) expect(e.count).toBe(OLD_DISTRIBUTION[e.rank])
  })

  it.each([1, 2, 3])(
    'seed %i: a game configured with the OLD literal table is state-for-state identical',
    (seed) => {
      const byDefault = trace(seed, 80)
      const byLiteral = trace(seed, 80, { distribution: { ...OLD_DISTRIBUTION } })
      expect(byLiteral.length).toBe(byDefault.length)
      for (let i = 0; i < byDefault.length; i++) expect(byLiteral[i]).toEqual(byDefault[i])
    },
  )

  it.each([1, 2, 3])('seed %i: every deployment in the trace is the §2 multiset', (seed) => {
    const states = trace(seed, 60)
    const start = states[0]!
    expect(states.length).toBeGreaterThan(1)
    for (const color of COLORS) {
      const own = start.pieces.filter((p) => p.color === color).map((p) => p.rank)
      expect(own.sort()).toEqual(multiset(DISTRIBUTION_STANDARD))
    }
  })

  it('the rendered views of a default game are byte-identical to the explicit-table game', () => {
    const a = createGame('same')
    const b = createGame('same', { distribution: { ...OLD_DISTRIBUTION } })
    const asWhite = (s: GameState): ViewerState => stateForViewer(s, { kind: 'player', color: 'white' })
    expect(renderForLLM(asWhite(b), RENDER)).toBe(renderForLLM(asWhite(a), RENDER))
    expect(exportMarkdown(asWhite(b))).toBe(exportMarkdown(asWhite(a)))
    expect(JSON.stringify(exportJson(asWhite(b)))).toBe(JSON.stringify(exportJson(asWhite(a))))
  })
})

// ---------------------------------------------------------------------------
// 7. A retuned game is a whole, playable game
// ---------------------------------------------------------------------------

describe('a retuned game plays', () => {
  it.each(PRESETS)('%s: a full random game, start to finish', (_name, d) => {
    // Random play walks 軍旗 into things, so most traces end on 奪旗 well before
    // the ply cap. What matters is that the game RAN under a retuned table.
    const states = trace(4242, 60, { distribution: d })
    expect(states.length).toBeGreaterThan(5)
    const last = states[states.length - 1]!
    expect(['playing', 'over']).toContain(last.status.kind)
    // the 兵種 layer never gains or loses a piece: what is on the board plus
    // what has left it is still the configured army
    for (const color of COLORS) {
      const own = last.pieces.filter((p) => p.color === color).map((p) => p.rank)
      expect(own.sort()).toEqual(multiset(d))
    }
  })

  it('SCOUTS really does put four 工兵 on the board', () => {
    const s = deployedGame('scouts', SCOUTS)
    const own = s.pieces.filter((p) => p.color === 'white' && p.rank === 'engineer')
    expect(own).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// 8. §10 — the table is public, and it is the ONLY rank text on the wire
//
// `config.distribution` is keyed by 兵種, so the serialised ViewerState now
// carries all eleven rank identifiers as KEYS. That is the §2 table — public by
// §2, attached to nobody, identical for both seats — and it is exactly the
// exemption the 棋譜 export already grants it (`record.test.ts`: "config
// .distribution is the §2 table again — same exemption, same reason").
//
// The property that matters is unchanged and is asserted here: with the public
// table lifted out, no rank string the viewer is not entitled to appears, and
// the table itself never varies with anybody's hidden 兵種.
// ---------------------------------------------------------------------------

describe('§10 the wire carries the public table and nothing else about 兵種', () => {
  /** The payload with the public §2 table lifted out — everything else verbatim. */
  const payloadWithoutTable = (vs: ViewerState): string =>
    JSON.stringify({ ...vs, config: { ...vs.config, distribution: {} } })

  it('a setup-phase payload names no 兵種 once the table is lifted out', () => {
    const s = createGame('t')
    for (const viewer of [
      { kind: 'player', color: 'white' },
      { kind: 'spectator', bound: 'white' },
    ] as const) {
      const text = payloadWithoutTable(stateForViewer(s, viewer))
      for (const rank of ALL_RANKS) expect(text, `${rank} leaked`).not.toContain(`"${rank}"`)
    }
  })

  it('a mid-game payload names no 兵種 the viewer has no claim to', () => {
    // The §2 table gives every side at least one of all eleven 兵種, so in a real
    // game "does 'commander' appear?" is meaningless — a hand-built position
    // with a narrow rank set makes the question real again (redaction.test.ts
    // does the same, for the same reason).
    const narrow = position([
      { at: 'b2', color: 'white', carrier: 'rook', rank: 'general', id: 'W1' },
      { at: 'g2', color: 'white', carrier: 'knight', rank: 'company', id: 'W2' },
      { at: 'b7', color: 'black', carrier: 'rook', rank: 'flag', id: 'B1' },
      { at: 'g7', color: 'black', carrier: 'knight', rank: 'bomb', id: 'B2' },
      { at: 'h8', color: 'black', carrier: 'king', rank: 'commander', id: 'B3' },
    ])

    for (const viewer of [
      { kind: 'player', color: 'white' },
      { kind: 'spectator', bound: 'white' },
    ] as const) {
      const text = payloadWithoutTable(stateForViewer(narrow, viewer))
      for (const r of ['flag', 'bomb', 'commander'] as Rank[]) {
        expect(text, `black's ${r} leaked`).not.toContain(`"${r}"`)
      }
      // …while what white IS entitled to is present, so the grep is not passing
      // merely because the payload is empty.
      for (const r of ['general', 'company'] as Rank[]) expect(text).toContain(`"${r}"`)
    }

    const asBlack = payloadWithoutTable(stateForViewer(narrow, { kind: 'player', color: 'black' }))
    for (const r of ['general', 'company'] as Rank[]) {
      expect(asBlack, `white's ${r} leaked`).not.toContain(`"${r}"`)
    }
  })

  it('the table is the same for both seats and does not move with the armies', () => {
    const s = deployedGame('t2', SCOUTS)
    const white = stateForViewer(s, { kind: 'player', color: 'white' })
    const black = stateForViewer(s, { kind: 'player', color: 'black' })
    expect(white.config.distribution).toEqual(black.config.distribution)
    expect(white.config.distribution).toEqual({ ...DISTRIBUTION_SCOUTS })
    // the same table survives play
    const later = applyMove(s, { kind: 'pass' })
    expect(later.config.distribution).toEqual({ ...DISTRIBUTION_SCOUTS })
  })
})
