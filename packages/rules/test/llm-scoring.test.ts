/**
 * §7.1's TWO sources of points, as the LLM text interface states them.
 *
 * The engine half of §7.3 is `capturescore.test.ts`. This file is about the only
 * thing a model playing over the text interface can actually read, and about one
 * specific failure it produced.
 *
 * `/llm/:token` — the POSITION view — is the URL a model re-fetches every ply.
 * The settings table that carries k and the 有煙無傷 amount is on
 * `/llm/:token/rules`, which a model fetches once at most. So at any k > 0 the
 * looped view described 佔領計分格 as the whole of §7.1 and never named 吃子:
 *
 *   1. a model joining mid-game, or one whose context had rolled past the
 *      one-time primer, could not see that a contact pays, and under-valued
 *      every trade it was offered;
 *   2. worse, that view states settlement credits ONLY the player who just
 *      moved. §7.1 scopes those words to ② — 「只有剛行動的一方計分」**只適用於階段
 *      ②的佔領分」 — and §7.3 pays the WINNER or the SURVIVOR, which is the idle
 *      side whenever a defender holds its square or a 爆裂物 fizzles. A payment
 *      landing in the idle column therefore read to a model as a server bug,
 *      which it may contest instead of playing.
 *
 * Two things are asserted here that are easy to lose later.
 *
 * FIRST, at the shipped k = 0 / bonus = 0 the position view is UNCHANGED, down
 * to the line. ① is identically zero in such a game, the squares block really is
 * the whole scoring rule, and every archived LLM transcript was produced by that
 * exact text — a paragraph about a rule that could not have fired would date all
 * of them for nothing. The legacy block is pinned verbatim below.
 *
 * SECOND, every line the view adds is a function of `config` and of §7.3 alone.
 * No 兵種 is read: the 決定性勝負 row states a FORMULA over the winner's 階級 —
 * the one §4.3 forces 翻明 in the very announcement that pays — and never a
 * value. That is asserted the strong way, by rendering the same position to
 * every kind of viewer in the system and requiring the block to come out
 * identical.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  RANK_NAMES_ZH,
  RANK_ORDER,
  captureScore,
  renderForLLM,
  renderRulesForLLM,
  stateForViewer,
} from '../src/index.js'
import type { GameConfig, Rank, Viewer } from '../src/types.js'
import { position } from './helpers.js'

const RENDER = { baseUrl: 'https://example.test', token: 'tok' }
const WHITE: Viewer = { kind: 'player', color: 'white' }

/**
 * A live position with nothing on any 結算格.
 *
 * What is on the board is deliberately irrelevant: every line under test is a
 * function of `config`, so the fixture only has to be a legal state to render.
 */
function view(config: Partial<GameConfig>, viewer: Viewer = WHITE): string {
  const s = position(
    [
      { at: 'e1', color: 'white', carrier: 'king', rank: 'commander' },
      { at: 'a1', color: 'white', carrier: 'rook', rank: 'flag' },
      { at: 'e8', color: 'black', carrier: 'king', rank: 'commander' },
      { at: 'a8', color: 'black', carrier: 'rook', rank: 'flag' },
    ],
    { config },
  )
  return renderForLLM(stateForViewer(s, viewer), RENDER)
}

/** The 吃子得分 paragraph, or '' when the view does not print one. */
function captureBlock(text: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('吃子得分 (§7.3)'))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && l.trim() === '')
  return lines.slice(start, end).join('\n')
}

/**
 * The squares block exactly as it read before §7.3 reached this view.
 *
 * Pinned as a literal on purpose. Its job is to fail if anyone reflows these
 * three lines: every LLM game in `games/` was played against this wording, and
 * the promise made when §7.3 was added to the view was that a k = 0 game would
 * still render it byte for byte.
 */
const LEGACY_SQUARES_BLOCK = [
  'Scoring squares — settlement runs after EVERY ply, but credits ONLY the player who',
  'just moved: +1 for each own piece of theirs standing on one. Your own squares pay',
  "you on your own plies, not on the opponent's, so each side banks once per turn.",
].join('\n')

// ---------------------------------------------------------------------------
// 1. k = 0: nothing moved
// ---------------------------------------------------------------------------

describe('at the shipped defaults the position view is unchanged', () => {
  it('§7.3 is not mentioned at all', () => {
    // 附錄 B ships both knobs 待定 at 0. A game played there has one source of
    // points, and the view says so by saying nothing about the other.
    expect(DEFAULT_CONFIG.captureScoreK).toBe(0)
    expect(DEFAULT_CONFIG.fizzleBonus).toBe(0)

    const text = view({})
    expect(text).not.toContain('§7.3')
    expect(text).not.toContain('吃子得分')
    expect(captureBlock(text)).toBe('')
  })

  it('the squares block is the legacy three lines, with nothing inserted', () => {
    // Not just "contains": the occupancy line has to follow IMMEDIATELY, which
    // is what rules out a scoping sentence being spliced in at k = 0.
    expect(view({})).toContain(`${LEGACY_SQUARES_BLOCK}\nd4 EMPTY`)
  })

  it('explicit zeros render identically to the defaults', () => {
    expect(view({ captureScoreK: 0, fizzleBonus: 0 })).toBe(view({}))
  })
})

// ---------------------------------------------------------------------------
// 2. k > 0: the second source appears, with THIS game's numbers
// ---------------------------------------------------------------------------

describe('when 吃子 can pay, the position view states §7.3', () => {
  const LIVE = { captureScoreK: 3, fizzleBonus: 2 }

  it('names all three rows of the §7.3 table', () => {
    const block = captureBlock(view(LIVE))
    expect(block).toContain('決定性勝負')
    expect(block).toContain('有煙無傷')
    expect(block).toContain('同歸於盡')
  })

  it('the amounts come from config, never from a literal (附錄 B)', () => {
    const block = captureBlock(view({ captureScoreK: 7, fizzleBonus: 4 }))
    expect(block).toContain('k = 7 here')
    expect(block).toContain('+4 to the side')
    // the numbers of some OTHER game must not survive into this one
    expect(block).not.toContain('k = 3')
    expect(block).not.toContain('+2 ')
  })

  it('states the direction of the multiplier off RANK_ORDER, not off prose', () => {
    // 「階級數字越大代表越弱，故弱者獲勝得分越高」. A model that reads this backwards
    // values a 司令 kill highest and plays a different game, so the span is
    // derived from the same table the primer prints rather than retyped.
    const ranks = (Object.keys(RANK_ORDER) as Exclude<Rank, 'bomb'>[])
      .sort((a, b) => RANK_ORDER[a] - RANK_ORDER[b])
    const strongest = ranks[0]
    const weakest = ranks[ranks.length - 1]
    const span =
      `${RANK_NAMES_ZH[strongest]} ${RANK_ORDER[strongest]}`
      + ` … ${RANK_NAMES_ZH[weakest]} ${RANK_ORDER[weakest]}`

    const block = captureBlock(view(LIVE))
    expect(block).toContain(`階級 runs ${span}`)
    expect(block).toContain('WEAKER piece and a weak winner is paid MORE')
  })

  it('says 同歸於盡 pays zero to both sides, unconditionally', () => {
    // 附錄 A(d): a tribe-derived payment would name the victim of a contact that
    // announces nobody. The view must not leave a model expecting a trade to pay.
    expect(captureBlock(view(LIVE)))
      .toContain('同歸於盡 — ZERO to both sides. Always')
    expect(captureScore({ kind: 'mutual-destruction' }, 'white', { ...DEFAULT_CONFIG, ...LIVE }))
      .toEqual({ white: 0, black: 0 })
  })

  it('a knob that is off gets a row saying so, not a 0 dressed as a payment', () => {
    const noFizzle = captureBlock(view({ captureScoreK: 3 }))
    expect(noFizzle).toContain('有煙無傷 (§5.4 — a 爆裂物 hit a 工兵 or 軍旗) — 0 here')
    expect(noFizzle).not.toContain('a flat +0')

    const noDecisive = captureBlock(view({ fizzleBonus: 2 }))
    expect(noDecisive).toContain('k = 0 here')
    expect(noDecisive).toContain('a flat +2 to the side')
  })

  it('appears even with no 結算格 configured — then ① is the only way to score', () => {
    const block = captureBlock(view({ scoringSquares: [], captureScoreK: 3 }))
    expect(block).not.toBe('')
    expect(block).toContain('k = 3 here')
  })
})

// ---------------------------------------------------------------------------
// 3. The two claims a model was previously given wrong
// ---------------------------------------------------------------------------

describe("the view no longer states ②'s scoping as the whole rule", () => {
  it('「ONLY the player who just moved」 is scoped to ② when ① is live', () => {
    // §7.1:「只有剛行動的一方計分」**只適用於階段②的佔領分**. Before this, the
    // sentence stood alone and a 決定性勝負 paying the idle side contradicted it.
    const text = view({ captureScoreK: 3, fizzleBonus: 2 })
    expect(text).toContain('「ONLY the player who just moved」 scopes to THIS source alone')
    expect(text).toContain('can pay the side that did not move')
  })

  it('and the engine really does pay the side that did not move', () => {
    // The prose above is only worth printing if it is true. 決定性勝負 pays the
    // WINNER: white attacks, black's 工兵 holds the square, black is paid on
    // WHITE's ply. Same for a fizzle where the 爆裂物 was the attacker.
    const config: GameConfig = { ...DEFAULT_CONFIG, captureScoreK: 3, fizzleBonus: 2 }
    const held = captureScore({ kind: 'defender-wins', winnerRank: 'engineer' }, 'white', config)
    expect(held).toEqual({ white: 0, black: 3 * RANK_ORDER.engineer })

    const fizzled = captureScore({ kind: 'fizzle', survivorColor: 'black' }, 'white', config)
    expect(fizzled).toEqual({ white: 0, black: 2 })
  })

  it('says ① is paid in the ACTION phase and therefore survives 奪旗', () => {
    // §7.6:「① 觸發的該手不執行結算階段」 skips ② and only ②. The ply that takes a
    // 軍旗 keeps what its capture just paid, and a model that assumed otherwise
    // would misprice the last contact of every game.
    const block = captureBlock(view({ captureScoreK: 3, fizzleBonus: 2 }))
    expect(block).toContain('ACTION phase')
    expect(block).toContain('奪旗 (§7.6)')
    expect(block).toContain('banks no ② 佔領分, but keeps what its capture just paid')
  })
})

// ---------------------------------------------------------------------------
// 4. Nothing in the block depends on who is reading
// ---------------------------------------------------------------------------

describe('the §7.3 block is config, not state', () => {
  it('renders identically to every viewer in the system', () => {
    // The strongest available statement that no 兵種 reached this text: the
    // omniscient viewer holds every rank, the public observer holds none, and
    // they must produce the same paragraph.
    const LIVE = { captureScoreK: 3, fizzleBonus: 2 }
    const viewers: Viewer[] = [
      { kind: 'player', color: 'white' },
      { kind: 'player', color: 'black' },
      { kind: 'spectator', bound: 'white' },
      { kind: 'spectator-public' },
      { kind: 'omniscient' },
      { kind: 'replay-player', color: 'black' },
    ]
    const blocks = viewers.map((v) => captureBlock(view(LIVE, v)))
    expect(blocks[0]).not.toBe('')
    for (const b of blocks) expect(b).toBe(blocks[0])
  })

  it('names no 兵種 other than the two 爆裂物 immunity already announces', () => {
    // 有煙無傷 is public as「工兵 or 軍旗」 (§5.4, 附錄 A) — naming the pair is
    // what keeps it from naming either. Nothing else may appear.
    const block = captureBlock(view({ captureScoreK: 3, fizzleBonus: 2 }))
    const allowed = new Set(['司令', '工兵', '軍旗', '爆裂物'])
    for (const rank of Object.keys(RANK_NAMES_ZH) as Rank[]) {
      const zh = RANK_NAMES_ZH[rank]
      if (allowed.has(zh)) continue
      expect(block).not.toContain(zh)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The rules primer says the same thing
// ---------------------------------------------------------------------------

describe('renderRulesForLLM and the position view agree', () => {
  const primer = renderRulesForLLM(RENDER)

  it('the primer presents §7.1 as two sources, not one', () => {
    expect(primer).toContain('## Scoring — TWO sources (§7.1)')
    expect(primer).toContain('② 佔領計分格')
    expect(primer).toContain('① 吃子 (§7.3)')
  })

  it('the primer scopes 「only the player who just moved」 to ② as well', () => {
    expect(primer).toContain("「ONLY the player who just moved」 above is ②'s rule alone")
    expect(primer).toContain('column of the side that did not move is ① doing its job')
  })

  it('the primer states the three rows and that the amounts may be zero', () => {
    // The primer takes no config — it cannot name k — so the one thing it must
    // not do is imply a capture always pays. The numbers live in the settings
    // block the server appends to this same page.
    expect(primer).toContain('同歸於盡 pays ZERO to both sides, always')
    expect(primer).toContain('MAY BE ZERO')
    expect(primer).toContain("This game's settings")
  })

  it('both texts state the multiplier direction with the same words', () => {
    // One derivation, two readers. If the primer and the looped view ever
    // disagreed about which end of 階級 is strong, the looped one would win by
    // sheer repetition — so neither is allowed to drift.
    const ranks = (Object.keys(RANK_ORDER) as Exclude<Rank, 'bomb'>[])
      .sort((a, b) => RANK_ORDER[a] - RANK_ORDER[b])
    const span =
      `${RANK_NAMES_ZH[ranks[0]]} ${RANK_ORDER[ranks[0]]}`
      + ` … ${RANK_NAMES_ZH[ranks[ranks.length - 1]]} ${RANK_ORDER[ranks[ranks.length - 1]]}`
    expect(primer).toContain(`階級 runs ${span}`)
    expect(captureBlock(view({ captureScoreK: 1 }))).toContain(`階級 runs ${span}`)
  })
})
