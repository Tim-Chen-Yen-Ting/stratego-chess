/**
 * Setup codes — the 16-character deployment format (gamebook §9).
 *
 * The format is a shared contract: the LLM view prints it, the server parses it.
 * Two things therefore have to hold, and both are tested here.
 *
 *   1. encode ∘ decode = identity, and a decoded code is a legal assignment —
 *      i.e. it survives the ONE validator, `validateAssignment` (§9 一對一).
 *   2. Position i of a code is the i-th piece the view lists under
 *      "## Your pieces". If those two orders ever drift, every code silently
 *      deploys a different army than the one the player wrote, so the order is
 *      asserted against the actual rendered text rather than against a copy of
 *      the ordering rule.
 *
 * Rejection is also part of the contract: 11^16 strings exist and only
 * 653,837,184,000 of them are deployments, so almost everything a model can type
 * is invalid and must come back saying what was wrong.
 */

import { describe, expect, it } from 'vitest'
import { DISTRIBUTION, RANK_NAMES_ZH } from '../src/constants.js'
import { squareName } from '../src/board.js'
import { stateForViewer } from '../src/redact.js'
import { renderForLLM } from '../src/render/text.js'
import { createGame, submitAssignment, validateAssignment } from '../src/setup.js'
import {
  SETUP_CODE_ALPHABET,
  SETUP_CODE_COMBINATIONS,
  SETUP_CODE_EXAMPLE,
  SETUP_CODE_LEGEND,
  SETUP_CODE_LENGTH,
  decodeSetupCode,
  encodeSetupCode,
  setupCodeSlots,
} from '../src/setupcode.js'
import type { Color, GameState, PieceId, Rank } from '../src/types.js'

const COLORS: Color[] = ['white', 'black']
const RENDER = { baseUrl: 'https://example.test', token: 'TOK' }

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

/** Deploy `code` and return the resulting state. */
function deploy(s: GameState, color: Color, code: string): GameState {
  return submitAssignment(s, color, decoded(code, color, s))
}

// ---------------------------------------------------------------------------
// deterministic PRNG — the rules package stays reproducible (no Math.random)
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

/** `count` valid codes: the required multiset of letters, shuffled. */
function shuffledCodes(count: number, seed: number): string[] {
  const rnd = rng(seed)
  const letters = SETUP_CODE_LEGEND.flatMap((e) => new Array<string>(e.count).fill(e.letter))
  const out: string[] = []
  for (let n = 0; n < count; n++) {
    const bag = [...letters]
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const held = bag[i]!
      bag[i] = bag[j]!
      bag[j] = held
    }
    out.push(bag.join(''))
  }
  return out
}

// ---------------------------------------------------------------------------

describe('the alphabet and the shape of a code', () => {
  it('has one distinct character per 兵種', () => {
    const ranks = Object.keys(DISTRIBUTION).length
    expect(SETUP_CODE_ALPHABET).toBe('123456789FX')
    expect(SETUP_CODE_ALPHABET).toHaveLength(ranks)
    expect(new Set(SETUP_CODE_ALPHABET).size).toBe(ranks)
    expect(SETUP_CODE_LEGEND.map((e) => e.letter).join('')).toBe(SETUP_CODE_ALPHABET)
  })

  it('is one character per piece — §2 sums to 16', () => {
    expect(SETUP_CODE_LENGTH).toBe(16)
    expect(SETUP_CODE_LENGTH).toBe(Object.values(DISTRIBUTION).reduce((a, b) => a + b, 0))
    for (const entry of SETUP_CODE_LEGEND) {
      expect(entry.count).toBe(DISTRIBUTION[entry.rank])
      expect(entry.zh).toBe(RANK_NAMES_ZH[entry.rank])
    }
  })

  it('counts 16!/(2!)^5 = 653,837,184,000 deployments', () => {
    expect(SETUP_CODE_COMBINATIONS).toBe(653_837_184_000)
  })

  it('orders each colour’s 16 pieces exactly once', () => {
    const s = createGame('g')
    for (const color of COLORS) {
      const slots = setupCodeSlots(color)
      expect(slots).toHaveLength(SETUP_CODE_LENGTH)
      const ids = new Set(slots.map((slot) => slot.id))
      expect(ids.size).toBe(SETUP_CODE_LENGTH)
      const own = s.pieces.filter((p) => p.color === color).map((p) => p.id)
      expect([...ids].sort()).toEqual([...own].sort())
    }
  })

  it('ships a worked example that is itself valid', () => {
    const s = createGame('g')
    expect(SETUP_CODE_EXAMPLE).toHaveLength(SETUP_CODE_LENGTH)
    for (const color of COLORS) {
      expect(validateAssignment(decoded(SETUP_CODE_EXAMPLE, color, s), color, s)).toBeNull()
    }
  })
})

describe('round trip — encode ∘ decode = identity', () => {
  it('round-trips the worked example for both colours', () => {
    let s = createGame('g')
    for (const color of COLORS) {
      s = deploy(s, color, SETUP_CODE_EXAMPLE)
      expect(encodeSetupCode(s, color)).toBe(SETUP_CODE_EXAMPLE)
    }
  })

  it('round-trips 200 deployments per colour', () => {
    for (const color of COLORS) {
      for (const code of shuffledCodes(200, 20260811)) {
        const s = deploy(createGame('g'), color, code)
        expect(encodeSetupCode(s, color)).toBe(code)
      }
    }
  })

  it('produces an assignment the existing validator accepts', () => {
    const s = createGame('g')
    for (const color of COLORS) {
      for (const code of shuffledCodes(50, 7)) {
        expect(validateAssignment(decoded(code, color, s), color, s)).toBeNull()
      }
    }
  })

  it('touches only its own colour’s pieces', () => {
    const s = createGame('g')
    const code = shuffledCodes(1, 99)[0]!
    for (const color of COLORS) {
      const ids = Object.keys(decoded(code, color, s))
      expect(ids).toHaveLength(SETUP_CODE_LENGTH)
      expect(ids.every((id) => id.startsWith(color === 'white' ? 'w-' : 'b-'))).toBe(true)
    }
  })

  it('leaves the other colour’s deployment alone', () => {
    const a = shuffledCodes(2, 11)[0]!
    const b = shuffledCodes(2, 11)[1]!
    let s = createGame('g')
    s = deploy(s, 'white', a)
    s = deploy(s, 'black', b)
    expect(encodeSetupCode(s, 'white')).toBe(a)
    expect(encodeSetupCode(s, 'black')).toBe(b)
  })
})

describe('case-insensitivity and whitespace', () => {
  const s = createGame('g')
  const code = '1234455667899FXX'

  it('accepts lower case', () => {
    expect(decoded(code.toLowerCase(), 'white', s)).toEqual(decoded(code, 'white', s))
  })

  it('accepts mixed case', () => {
    expect(decoded('1234455667899fXx', 'white', s)).toEqual(decoded(code, 'white', s))
  })

  it('ignores surrounding and embedded whitespace', () => {
    expect(decoded('  1234 4556 6789 9FXX \n', 'white', s)).toEqual(decoded(code, 'white', s))
  })

  it('re-encodes to the canonical upper-case form', () => {
    expect(encodeSetupCode(deploy(s, 'black', code.toLowerCase()), 'black')).toBe(code)
  })
})

describe('rejection — most strings are not deployments', () => {
  const s = createGame('g')

  it('rejects a short code, naming the length', () => {
    const error = rejection('12345', 'white', s)
    expect(error).toMatch(/bad length/)
    expect(error).toContain('16')
    expect(error).toContain('got 5')
  })

  it('rejects a long code', () => {
    expect(rejection(`${SETUP_CODE_EXAMPLE}X`, 'white', s)).toMatch(/bad length/)
  })

  it('rejects an empty code', () => {
    expect(rejection('', 'white', s)).toMatch(/bad length/)
    expect(rejection('    ', 'white', s)).toMatch(/bad length/)
  })

  it('rejects a character outside the alphabet, naming it and its position', () => {
    const error = rejection('1234455667899FZX', 'white', s)
    expect(error).toMatch(/bad character/)
    expect(error).toContain('"Z"')
    expect(error).toContain('position 15')
    expect(error).toContain(SETUP_CODE_ALPHABET)
  })

  it("rejects '0' — the ladder starts at 1", () => {
    expect(rejection('0234455667899FXX', 'white', s)).toMatch(/bad character/)
  })

  it('rejects a non-ASCII character without echoing it raw', () => {
    const error = rejection('司234455667899FXX', 'white', s)
    expect(error).toMatch(/bad character/)
    expect(error).toContain('U+53F8')
    expect(error).not.toContain('司2')
  })

  it('rejects wrong counts, naming the offending 兵種', () => {
    // two 軍旗: the second F displaces a 爆裂物
    const error = rejection('1234455667899FFX', 'white', s)
    expect(error).toMatch(/wrong counts/)
    expect(error).toMatch(/flag/)
  })

  it('rejects a missing 兵種, naming it', () => {
    // no 司令 at all: '1' replaced by a third 爆裂物
    const error = rejection('X234455667899FXX', 'white', s)
    expect(error).toMatch(/wrong counts/)
    expect(error).toMatch(/commander/)
  })

  it('rejects all 16 of one character', () => {
    expect(rejection('9'.repeat(16), 'white', s)).toMatch(/wrong counts/)
  })

  it('never throws — every rejection is a returned message', () => {
    const nasty = ['', 'random', '../../etc/passwd', '<script>', '9'.repeat(500), '🙂'.repeat(16)]
    for (const code of nasty) {
      const out = decodeSetupCode(code, 'white', s)
      expect('error' in out && out.error.length > 0).toBe(true)
    }
  })
})

describe('encode refuses to invent a 兵種 it cannot see', () => {
  it('throws when the source redacted the rank (§10 遮蔽層)', () => {
    let s = createGame('g')
    s = deploy(s, 'white', SETUP_CODE_EXAMPLE)
    s = deploy(s, 'black', SETUP_CODE_EXAMPLE)

    const asWhite = stateForViewer(s, { kind: 'player', color: 'white' })
    expect(encodeSetupCode(asWhite, 'white')).toBe(SETUP_CODE_EXAMPLE)
    expect(() => encodeSetupCode(asWhite, 'black')).toThrow(/hidden/)

    const omniscient = stateForViewer(s, { kind: 'omniscient' })
    expect(encodeSetupCode(omniscient, 'black')).toBe(SETUP_CODE_EXAMPLE)
  })
})

// ---------------------------------------------------------------------------
// The order contract, checked against the rendered text itself.
// ---------------------------------------------------------------------------

/** The entries printed under "## Your pieces", in printed order. */
function ownPieceEntries(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf('## Your pieces')
  expect(start).toBeGreaterThanOrEqual(0)
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') break
    out.push(...line.split(' · '))
  }
  return out
}

/** Read the printed 兵種 back out as a setup code. */
function codeFromRenderedView(text: string): string {
  const letterByZh = new Map(SETUP_CODE_LEGEND.map((e) => [e.zh, e.letter] as const))
  return ownPieceEntries(text)
    .map((entry) => {
      const zh = (entry.split(' ')[2] ?? '').replace(/\(.*\)$/, '')
      const letter = letterByZh.get(zh)
      if (letter === undefined) throw new Error(`unreadable rendered piece: "${entry}"`)
      return letter
    })
    .join('')
}

describe('position i of a code is the i-th piece the view prints', () => {
  it.each(COLORS)('matches "## Your pieces" for %s', (color) => {
    const code = shuffledCodes(1, 4242)[0]!
    let s = createGame('g')
    for (const c of COLORS) s = deploy(s, c, c === color ? code : SETUP_CODE_EXAMPLE)

    const text = renderForLLM(stateForViewer(s, { kind: 'player', color }), RENDER)
    expect(codeFromRenderedView(text)).toBe(code)
  })

  it('lists the code positions on the deployment screen in the same order', () => {
    const s = createGame('g')
    const text = renderForLLM(stateForViewer(s, { kind: 'player', color: 'black' }), RENDER)
    for (const [i, slot] of setupCodeSlots('black').entries()) {
      expect(text).toContain(`${i + 1} ${squareName(slot.square)} ${slot.carrier}`)
    }
  })
})

describe('the setup view says nothing is deployed and how to deploy', () => {
  const s = createGame('g')
  const text = renderForLLM(stateForViewer(s, { kind: 'player', color: 'white' }), RENDER)

  it('does not present the placeholder assignment as the player’s own', () => {
    expect(text).toContain('NO 兵種 ASSIGNED YET')
    expect(text).not.toContain('## Your pieces\n')
    // createGame seeds every piece with the deterministic default so `rank` can
    // be non-nullable; a1 rook 軍旗 is what leaked before.
    expect(text).not.toMatch(/a1 rook 軍旗/)
  })

  it('carries everything needed to deploy without out-of-band help', () => {
    expect(text).toContain(SETUP_CODE_ALPHABET)
    for (const entry of SETUP_CODE_LEGEND) {
      expect(text).toContain(`${entry.letter}  ${entry.zh}`)
      expect(text).toContain(`×${entry.count}`)
    }
    expect(text).toContain(SETUP_CODE_EXAMPLE)
    expect(text).toContain(`${RENDER.baseUrl}/llm/${RENDER.token}/setup/${SETUP_CODE_EXAMPLE}`)
    expect(text).toContain(`${RENDER.baseUrl}/llm/${RENDER.token}/setup/random`)
    expect(text).toContain('653,837,184,000')
  })

  it('shows a player their own army once they have deployed', () => {
    const after = deploy(s, 'white', SETUP_CODE_EXAMPLE)
    const view = renderForLLM(stateForViewer(after, { kind: 'player', color: 'white' }), RENDER)
    expect(view).toContain('deployed — waiting for the opponent')
    expect(view).toContain(`Setup code: ${SETUP_CODE_EXAMPLE}`)
    expect(view).not.toContain('NO 兵種 ASSIGNED YET')
  })

  it('offers a spectator no deployment URLs', () => {
    const watching = renderForLLM(stateForViewer(s, { kind: 'spectator', bound: 'white' }), RENDER)
    expect(watching).toContain('NO 兵種 ASSIGNED YET')
    expect(watching).not.toContain('/setup/random')
  })
})
