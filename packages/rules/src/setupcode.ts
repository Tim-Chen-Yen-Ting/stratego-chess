/**
 * Setup codes — one short string that names a whole deployment (gamebook §9).
 *
 * A setup code is 16 characters, one per own piece:
 *
 *   '1' 司令 commander   '2' 軍長 general    '3' 師長 division   '4' 旅長 brigade
 *   '5' 團長 regiment    '6' 營長 battalion  '7' 連長 company    '8' 排長 platoon
 *   '9' 工兵 engineer    'F' 軍旗 flag       'X' 爆裂物 bomb
 *
 * Position i is the i-th piece of `setupCodeSlots(color)`, which is the very
 * list the LLM view prints while a side is still deploying — the renderer reads
 * its order from here, so the printed order and the decoded order cannot drift.
 *
 * This module is the ONE implementation of the format. A renderer-side encoder
 * plus a server-side parser would be two implementations and would eventually
 * disagree; there is exactly one of each function and both live here.
 *
 * It decides nothing about the game. Whether a decoded assignment is *legal* is
 * answered by the existing `validateAssignment` (§9 一對一 bijection onto the
 * game's 數量配置) — this file never re-implements that check, it only reports
 * what that function said. Whether a deployment may be *submitted* (still in
 * setup, not already submitted) is the caller's question, not this file's.
 *
 * The ALPHABET is fixed: eleven characters, one per 兵種, the same in every
 * game. The COUNTS are not — 兵種數量配置 is a 附錄 B tunable, so how many of
 * each character a code must carry comes from `config.distribution`. Everything
 * here that quotes a count therefore takes a distribution, and the exported
 * constants are the DEFAULT preset's values, kept for display code that has no
 * game in hand.
 */

import { fileOf, rankOf } from './board.js'
import { ALL_RANKS, DEFAULT_CONFIG, RANK_NAMES_ZH } from './constants.js'
import { STARTING_LAYOUT, validateAssignment } from './setup.js'
import type { StartingSlot } from './setup.js'
import type { Color, GameState, PieceId, Rank, RankDistribution, Square } from './types.js'

// ---------------------------------------------------------------------------
// alphabet
// ---------------------------------------------------------------------------

/**
 * One character per 兵種. `Record<Rank, string>` makes the table exhaustive at
 * compile time: adding a 兵種 to `Rank` fails to build until it gets a letter.
 */
const LETTER_BY_RANK: Record<Rank, string> = {
  commander: '1',
  general: '2',
  division: '3',
  brigade: '4',
  regiment: '5',
  battalion: '6',
  company: '7',
  platoon: '8',
  engineer: '9',
  flag: 'F',
  bomb: 'X',
}

const RANK_BY_LETTER = new Map<string, Rank>(
  ALL_RANKS.map((rank) => [LETTER_BY_RANK[rank], rank] as const),
)

// Two 兵種 sharing a letter would make the code ambiguous and silently lose one
// of them from the reverse map. Cheap guard against a bad edit above.
if (RANK_BY_LETTER.size !== ALL_RANKS.length) {
  throw new Error('setup code alphabet: two 兵種 share a letter')
}

/**
 * The code alphabet, in 階級 order — for display.
 *
 * `123456789FX`, and it does not move with the 數量配置: a 兵種 that a given
 * game happens to deploy zero of still has its letter, because the alphabet is
 * a property of the RANK LADDER (§2), not of any one game's counts. Only how
 * many times each character must appear is a setting.
 */
export const SETUP_CODE_ALPHABET: string = ALL_RANKS.map((rank) => LETTER_BY_RANK[rank]).join('')

export interface SetupCodeLegendEntry {
  readonly letter: string
  readonly rank: Rank
  /** 兵種 name, gamebook §2 */
  readonly zh: string
  /** how many of this 兵種 every code must contain, in the game asked about */
  readonly count: number
}

/** Characters in a setup code = pieces per side, i.e. the distribution's total. */
export function setupCodeLength(distribution: RankDistribution): number {
  return ALL_RANKS.reduce((n, rank) => n + distribution[rank], 0)
}

/** The alphabet with names and required counts, in 階級 order — for display. */
export function setupCodeLegend(distribution: RankDistribution): readonly SetupCodeLegendEntry[] {
  return ALL_RANKS.map((rank) => ({
    letter: LETTER_BY_RANK[rank],
    rank,
    zh: RANK_NAMES_ZH[rank],
    count: distribution[rank],
  }))
}

/**
 * A valid code for `distribution`, built by walking the 階級 ladder in order.
 * Illustrative only: it is the same string for every reader of every game with
 * this table, so playing it verbatim hands the opponent the whole army. Derived
 * from the table, so it is valid by construction rather than by a comment
 * promising it is.
 */
export function setupCodeExample(distribution: RankDistribution): string {
  return setupCodeLegend(distribution).map((e) => e.letter.repeat(e.count)).join('')
}

function factorial(n: number): number {
  let out = 1
  for (let i = 2; i <= n; i++) out *= i
  return out
}

/**
 * How many distinct deployments exist: 16! / ∏(nᵣ!).
 *
 * It MOVES with the 數量配置 and is not a constant of the game: 653,837,184,000
 * for the §2 table (five doubled 兵種), 217,945,728,000 with 工兵4, and
 * 1,307,674,368,000 for the top-heavy variant. The code space is 11^16 either
 * way, vastly larger, which is why most strings are rejected.
 *
 * 16! is 2.09e13 and every division below is exact, so this stays an exact
 * integer in a double for any table summing to 16.
 */
export function setupCodeCombinations(distribution: RankDistribution): number {
  let out = factorial(setupCodeLength(distribution))
  for (const rank of ALL_RANKS) out /= factorial(distribution[rank])
  return out
}

/**
 * The DEFAULT preset's code length — 16, and 16 for every legal table, since
 * §2 合計 is an invariant `checkDistribution` enforces.
 *
 * @deprecated Prefer `setupCodeLength(config.distribution)` where a game is in
 * hand; this is here for display code that has none.
 */
export const SETUP_CODE_LENGTH: number = setupCodeLength(DEFAULT_CONFIG.distribution)

/**
 * The DEFAULT preset's legend.
 *
 * @deprecated The counts are a setting (附錄 B) — anything telling a PLAYER what
 * to type must use `setupCodeLegend(config.distribution)`, or it will state the
 * wrong counts and every code the player writes from them will be rejected.
 */
export const SETUP_CODE_LEGEND: readonly SetupCodeLegendEntry[] =
  setupCodeLegend(DEFAULT_CONFIG.distribution)

/** @deprecated The DEFAULT preset's worked example — see `setupCodeExample`. */
export const SETUP_CODE_EXAMPLE: string = setupCodeExample(DEFAULT_CONFIG.distribution)

/** @deprecated The DEFAULT preset's figure — see `setupCodeCombinations`. */
export const SETUP_CODE_COMBINATIONS: number =
  setupCodeCombinations(DEFAULT_CONFIG.distribution)

// ---------------------------------------------------------------------------
// piece order
// ---------------------------------------------------------------------------

/** Board reading order: rank 8 first, then a-file first. Same order the view prints. */
function readingOrder(a: Square, b: Square): number {
  const dr = rankOf(b) - rankOf(a)
  return dr !== 0 ? dr : fileOf(a) - fileOf(b)
}

const SLOT_ORDER: Record<Color, readonly StartingSlot[]> = {
  white: orderFor('white'),
  black: orderFor('black'),
}

function orderFor(color: Color): readonly StartingSlot[] {
  return STARTING_LAYOUT.filter((slot) => slot.color === color).sort((a, b) =>
    readingOrder(a.square, b.square),
  )
}

/**
 * The 16 own pieces in code order — position 1 of the code is slot 0 here.
 *
 * Derived from the fixed opening position (§9), so it is total and stable even
 * after pieces have left the board. During setup every piece is still on its
 * starting square, so this is exactly what the view lists.
 */
export function setupCodeSlots(color: Color): readonly StartingSlot[] {
  return SLOT_ORDER[color]
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * The minimum a state must expose to be encodable. Written structurally so both
 * `GameState` (ranks always present) and `ViewerState` (rank `null` where the
 * viewer is not entitled) satisfy it — a caller on the server side can therefore
 * encode from the redacted view and never reach around the security boundary.
 */
export interface SetupCodeSource {
  readonly pieces: readonly {
    readonly id: PieceId
    readonly color: Color
    readonly rank: Rank | null
  }[]
}

/**
 * The current assignment of `color`, as a 16-character code.
 *
 * Throws when the state cannot express one: a missing piece, or a 兵種 this
 * source has redacted. Both are caller bugs — ask only for a colour you are
 * entitled to see.
 */
export function encodeSetupCode(state: SetupCodeSource, color: Color): string {
  const rankById = new Map<PieceId, Rank | null>()
  for (const piece of state.pieces) {
    if (piece.color === color) rankById.set(piece.id, piece.rank)
  }

  let code = ''
  for (const slot of setupCodeSlots(color)) {
    if (!rankById.has(slot.id)) {
      throw new Error(`cannot encode a setup code: ${color} piece ${slot.id} is not in this state`)
    }
    const rank = rankById.get(slot.id) ?? null
    if (rank === null) {
      throw new Error(`cannot encode a setup code: the 兵種 of ${slot.id} is hidden from this viewer`)
    }
    code += LETTER_BY_RANK[rank]
  }
  return code
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

export type SetupCodeResult =
  | { assignment: Record<PieceId, Rank> }
  | { error: string }

/** Never echo raw input back into a text/plain body unsanitised. */
function showChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x20 && code <= 0x7e
    ? ch
    : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function showCode(code: string): string {
  const printable = code.replace(/[^\x20-\x7e]/g, '?')
  return printable.length <= 32 ? printable : `${printable.slice(0, 32)}...`
}

/**
 * "1×司令 1×軍長 …" — the counts every code must hit exactly, in the game asked
 * about. Takes the table rather than reading a constant: this string is what a
 * rejected player is told to type next, so it has to describe THEIR game.
 */
export function setupCodeCountsText(distribution: RankDistribution): string {
  return setupCodeLegend(distribution).map((e) => `${e.count}×${e.zh}(${e.letter})`).join(' ')
}

/**
 * Read a setup code into an assignment.
 *
 * Case-insensitive; surrounding or embedded whitespace is ignored. Rejection is
 * a returned `{ error }`, never a throw — the message names what was wrong so a
 * model can fix its own string without a second round trip.
 *
 * Every count quoted here comes from `state.config.distribution`, so the same
 * string can be a legal deployment in one game and a named rejection in another
 * ("rank engineer: expected 4, got 2") without either game being wrong.
 */
export function decodeSetupCode(
  code: string,
  color: Color,
  state: GameState,
): SetupCodeResult {
  const distribution = state.config.distribution
  const length = setupCodeLength(distribution)
  const counts = setupCodeCountsText(distribution)

  if (typeof code !== 'string') {
    return { error: `bad setup code: expected ${length} characters, got nothing.` }
  }

  // Split by code point, so one astral character counts as one character rather
  // than skewing the length arithmetic into a misleading complaint.
  const chars = Array.from(code.replace(/\s+/g, '').toUpperCase())

  if (chars.length !== length) {
    return {
      error:
        `bad length: a setup code is exactly ${length} characters, ` +
        `one per piece — got ${chars.length}` +
        (chars.length === 0 ? '.' : ` ("${showCode(chars.join(''))}").`),
    }
  }

  const ranks: Rank[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    const rank = RANK_BY_LETTER.get(ch)
    if (rank === undefined) {
      return {
        error:
          `bad character "${showChar(ch)}" at position ${i + 1}: ` +
          `the alphabet is ${SETUP_CODE_ALPHABET} (${counts}).`,
      }
    }
    ranks.push(rank)
  }

  const assignment: Record<PieceId, Rank> = {}
  setupCodeSlots(color).forEach((slot, i) => {
    assignment[slot.id] = ranks[i]!
  })

  // The one validator. §9's bijection-onto-數量配置 question is answered where it
  // is already answered — and `validateAssignment` reads the same
  // `state.config.distribution`, so the rank it names in `problem` is the rank
  // THIS game is short of or over on.
  const problem = validateAssignment(assignment, color, state)
  if (problem !== null) {
    return {
      error: `wrong counts — ${problem}. A code must use exactly ${counts}.`,
    }
  }

  return { assignment }
}
