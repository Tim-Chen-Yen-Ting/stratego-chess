/**
 * 遮蔽層 property tests — gamebook §10, 附錄 A; techspec §3 (ViewerState), §4.
 *
 * The entire design of 行軍西洋棋 rests on one sentence:
 *
 *   「用戶端永不接收其無權查看的兵種資料——不是『收到但不顯示』。」  (§10)
 *
 * So this file does not check that ranks are *displayed* correctly. It checks
 * that ranks a viewer is not entitled to are **absent from the payload**, by
 * three independent methods, over a randomly generated corpus of games:
 *
 *   A. DEEP WALK — every leaf of the returned object graph is visited and any
 *      string that happens to be a Rank must sit at a path that justifies it.
 *      Not just `pieces[].rank`: the event log, nested fields and stray
 *      references are exactly where a leak would hide.
 *   B. RAW TEXT — the JSON.stringify round-trip is searched as *text*, after
 *      the handful of legitimately-entitled slots have been blanked out. Any
 *      surviving rank token is a leak, wherever it came from.
 *   C. INDISTINGUISHABILITY — the strongest form. Permute the hidden ranks of
 *      the pieces the viewer may NOT see. The serialised view must come out
 *      byte-identical. If any bit of the payload varies with a hidden rank,
 *      the payload carries information about it.
 *
 * (C) is what makes (A) and (B) safe from their own blind spots: each side
 * owns at least one piece of every 兵種 (§2 table), so "does the string
 * 'commander' appear at all" can never be a meaningful question for a player
 * viewer. Only the *association* between a rank and a piece can leak, and only
 * (C) tests that directly.
 *
 * NOTE ON FILE LAYOUT: vitest is configured with
 * `include: ['test/**\/*.{test,spec}.ts']`, so this file is not collected on
 * its own. It registers its suites at module scope and `redaction.test.ts`
 * imports it, which is what makes them run. Do not "fix" that by renaming —
 * the vitest config belongs to another owner.
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_RANKS,
  CENTER_SQUARES,
  DISTRIBUTION,
  RANK_NAMES_ZH,
  applyMove,
  createGame,
  entitledToRank,
  flagFall,
  legalMoves,
  parseSquare,
  renderForLLM,
  resign,
  squareName,
  stateForViewer,
  submitAssignment,
  validateAssignment,
} from '@xiyang/rules'
import type {
  Carrier,
  Color,
  CombatOutcome,
  GameConfig,
  GameState,
  Move,
  PieceId,
  Rank,
  Viewer,
  ViewerState,
} from '@xiyang/rules'

// ---------------------------------------------------------------------------
// Deterministic PRNG — a failing seed must be reproducible.
// ---------------------------------------------------------------------------

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(xs: readonly T[], rng: Rng): T {
  return xs[Math.floor(rng() * xs.length) % xs.length]!
}

function shuffled<T>(xs: readonly T[], rng: Rng): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1)
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

// ---------------------------------------------------------------------------
// Assignment helpers
// ---------------------------------------------------------------------------

/** The 16-rank multiset of §2, as a flat list. */
export function rankPool(): Rank[] {
  const pool: Rank[] = []
  for (const r of ALL_RANKS) for (let i = 0; i < DISTRIBUTION[r]; i++) pool.push(r)
  return pool
}

export function randomAssignment(color: Color, s: GameState, rng: Rng): Record<PieceId, Rank> {
  const own = s.pieces.filter((p) => p.color === color)
  const pool = shuffled(rankPool(), rng)
  const out: Record<PieceId, Rank> = {}
  own.forEach((p, i) => { out[p.id] = pool[i]! })
  return out
}

/**
 * A full, valid assignment that honours `overrides` and fills the rest
 * deterministically. Used to build the exact contact scenarios of §4/§5.
 */
export function completeAssignment(
  color: Color,
  s: GameState,
  overrides: Record<PieceId, Rank> = {},
): Record<PieceId, Rank> {
  const counts = new Map<Rank, number>(ALL_RANKS.map((r) => [r, DISTRIBUTION[r]]))
  const own = s.pieces.filter((p) => p.color === color)
  const out: Record<PieceId, Rank> = {}

  for (const p of own) {
    const forced = overrides[p.id]
    if (forced === undefined) continue
    const left = counts.get(forced) ?? 0
    if (left <= 0) throw new Error(`override for ${p.id} exhausts ${forced}`)
    counts.set(forced, left - 1)
    out[p.id] = forced
  }
  for (const id of Object.keys(overrides)) {
    if (out[id] === undefined) throw new Error(`override for unknown ${color} piece: ${id}`)
  }
  for (const p of own) {
    if (out[p.id] !== undefined) continue
    const next = ALL_RANKS.find((r) => (counts.get(r) ?? 0) > 0)
    if (!next) throw new Error('rank pool exhausted')
    counts.set(next, counts.get(next)! - 1)
    out[p.id] = next
  }
  return out
}

export interface ScenarioOptions {
  white?: Record<PieceId, Rank>
  black?: Record<PieceId, Rank>
  config?: Partial<GameConfig>
}

/** A game in `playing` status with both assignments locked in. */
export function startedGame(id: string, o: ScenarioOptions = {}): GameState {
  const fresh = createGame(id, o.config)
  const w = completeAssignment('white', fresh, o.white ?? {})
  const b = completeAssignment('black', fresh, o.black ?? {})
  if (validateAssignment(w, 'white', fresh) !== null) throw new Error('bad white assignment')
  if (validateAssignment(b, 'black', fresh) !== null) throw new Error('bad black assignment')
  return submitAssignment(submitAssignment(fresh, 'white', w), 'black', b)
}

export type PromotionCarrier = Exclude<Carrier, 'pawn' | 'king'>

export function mv(from: string, to: string, promote?: PromotionCarrier): Move {
  const f = parseSquare(from)
  const t = parseSquare(to)
  if (f === null || t === null) throw new Error(`bad square in ${from}${to}`)
  return promote === undefined
    ? { kind: 'move', from: f, to: t }
    : { kind: 'move', from: f, to: t, promote }
}

export function playAll(s: GameState, moves: readonly Move[]): GameState {
  let cur = s
  for (const m of moves) cur = applyMove(cur, m)
  return cur
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

/**
 * EVERY viewer the system can construct. This array is the spine of the file:
 * each suite below loops over it, so a viewer added here is immediately put
 * through the raw-text grep, the structural deep walk, the rank permutation and
 * the render checks. A viewer that is not in this list is a viewer nothing tests.
 *
 * `spectator-public` is the strictest of them — it owns no colour and is
 * entitled to a rank only by §4.3 翻明 or §10.5 終局 — so it is also the one most
 * of these properties bite hardest on.
 */
export const ALL_VIEWERS: readonly Viewer[] = [
  { kind: 'player', color: 'white' },
  { kind: 'player', color: 'black' },
  { kind: 'spectator', bound: 'white' },
  { kind: 'spectator', bound: 'black' },
  { kind: 'spectator-public' },
  { kind: 'omniscient' },
  { kind: 'replay-player', color: 'white' },
  { kind: 'replay-player', color: 'black' },
]

export function viewerLabel(v: Viewer): string {
  if ('color' in v) return `${v.kind}:${v.color}`
  if ('bound' in v) return `${v.kind}:${v.bound}`
  // The colourless viewers: the omniscient replay view, which needs no colour
  // because it sees them all, and 公開觀戰者, which needs none because it sees
  // no hidden 兵種 at all. Their kind alone names them.
  return v.kind
}

/**
 * Per-piece entitlement, indexed exactly like `state.pieces` / `view.pieces`.
 *
 * It asks `entitledToRank` rather than restating the policy, so a new viewer is
 * scored by the very predicate under test — for `spectator-public` that yields
 * an all-false array until the first 翻明, and an all-true one at 終局.
 */
export function entitlement(s: GameState, v: Viewer): boolean[] {
  return s.pieces.map((p) => entitledToRank(s, v, p))
}

// ---------------------------------------------------------------------------
// Random games
// ---------------------------------------------------------------------------

/**
 * Does this move make contact?
 *
 * The occupancy check alone is not enough: en passant is the one move in the
 * game where 接觸格 ≠ 目的格 (§4), so its destination is empty while it still
 * fights a pawn standing beside it. A pawn changing file is always a capture.
 */
function isCapture(s: GameState, m: Move): boolean {
  if (m.kind !== 'move') return false
  if (s.pieces.some((p) => p.square === m.to && p.color !== s.toMove)) return true
  const mover = s.pieces.find((p) => p.square === m.from)
  return mover?.carrier === 'pawn' && (m.from & 7) !== (m.to & 7)
}

function toCenter(m: Move): boolean {
  return m.kind === 'move' && CENTER_SQUARES.includes(m.to)
}

/**
 * Random but not uniform: contact and centre occupation are what make the
 * interesting states (reveals, 有煙無傷, 奪旗, 計分), so they get weighted up.
 */
function chooseMove(s: GameState, moves: readonly Move[], rng: Rng): Move {
  const active = moves.filter((m) => m.kind !== 'pass')
  if (active.length === 0) return { kind: 'pass' }
  const r = rng()
  if (r < 0.04) return { kind: 'pass' }
  if (r < 0.46) {
    const caps = active.filter((m) => isCapture(s, m))
    if (caps.length > 0) return pick(caps, rng)
  }
  if (r < 0.66) {
    const mid = active.filter(toCenter)
    if (mid.length > 0) return pick(mid, rng)
  }
  return pick(active, rng)
}

export interface CorpusEntry {
  label: string
  state: GameState
}

/**
 * Random assignments, random legal play, games sampled at every stage
 * including finished ones, plus the deliberately-constructed §4/§5 contacts
 * that random play reaches only rarely.
 */
export function buildCorpus(opts: { games: number; maxPlies: number; seed: number }): CorpusEntry[] {
  const rng = mulberry32(opts.seed)
  const out: CorpusEntry[] = []

  // --- setup stage: the ranks are already inside GameState before either side
  //     has submitted, so the boundary has to hold here too.
  const fresh = createGame('setup-none')
  out.push({ label: 'setup/none-submitted', state: fresh })
  const half = submitAssignment(fresh, 'white', randomAssignment('white', fresh, rng))
  out.push({ label: 'setup/white-submitted', state: half })
  out.push({ label: 'setup/resigned-mid-setup', state: resign(half, 'black') })

  for (let g = 0; g < opts.games; g++) {
    const cfg: Partial<GameConfig> =
      g % 3 === 0 ? { scoreTarget: 8, noProgressTurns: 4 }
        : g % 3 === 1 ? { clockEnabled: false }
          : {}
    let s = startedGameFromRng(`rnd-${g}`, rng, cfg)
    out.push({ label: `rnd-${g}/ply${s.ply}`, state: s })

    for (let i = 0; i < opts.maxPlies && s.status.kind === 'playing'; i++) {
      s = applyMove(s, chooseMove(s, legalMoves(s, s.toMove), rng))
      if (i % 4 === 0 || s.status.kind === 'over') out.push({ label: `rnd-${g}/ply${s.ply}`, state: s })
    }

    if (s.status.kind === 'playing') {
      out.push({ label: `rnd-${g}/resign`, state: resign(s, rng() < 0.5 ? 'white' : 'black') })
      out.push({ label: `rnd-${g}/timeout`, state: flagFall(s, rng() < 0.5 ? 'white' : 'black') })
    }
  }

  out.push(...scenarioCorpus())
  return out
}

function startedGameFromRng(id: string, rng: Rng, config: Partial<GameConfig>): GameState {
  const fresh = createGame(id, config)
  const w = randomAssignment('white', fresh, rng)
  const b = randomAssignment('black', fresh, rng)
  return submitAssignment(submitAssignment(fresh, 'white', w), 'black', b)
}

// ---------------------------------------------------------------------------
// Constructed contacts — one per row of gamebook §4「翻明總表」and §7 result kind
// ---------------------------------------------------------------------------

/**
 * Every scenario runs the same three plies:
 *   1. w e2-e4   2. b d7-d5   3. w e4xd5
 * so the only thing that varies between them is the 兵種 pair in contact —
 * which is precisely the variable the redaction layer must not expose.
 */
export const CONTACT_SEQUENCE: readonly Move[] = [mv('e2', 'e4'), mv('d7', 'd5'), mv('e4', 'd5')]

export function contactGame(id: string, whiteRank: Rank, blackRank: Rank, config?: Partial<GameConfig>): GameState {
  const s = startedGame(id, {
    white: { 'w-e2': whiteRank },
    black: { 'b-d7': blackRank },
    ...(config ? { config } : {}),
  })
  return playAll(s, CONTACT_SEQUENCE)
}

export function scenarioCorpus(): CorpusEntry[] {
  const out: CorpusEntry[] = []

  // §4 翻明總表, row by row. The four 同歸於盡 rows are labelled by the 兵種 pair
  // that PRODUCED them, not by the announcement — all four announce the same
  // thing, which is exactly what the suites below have to hold true.
  out.push({ label: 'contact/attacker-wins', state: contactGame('c-aw', 'commander', 'platoon') })
  out.push({ label: 'contact/defender-wins', state: contactGame('c-dw', 'platoon', 'commander') })
  out.push({ label: 'contact/mutual(equal ranks)', state: contactGame('c-mr', 'brigade', 'brigade') })
  out.push({ label: 'contact/mutual(white bomb)', state: contactGame('c-bd', 'bomb', 'brigade') })
  out.push({ label: 'contact/mutual(black bomb)', state: contactGame('c-bd2', 'brigade', 'bomb') })
  out.push({ label: 'contact/mutual(bomb vs bomb)', state: contactGame('c-bb', 'bomb', 'bomb') })
  // 有煙無傷 — both directions, and both possible survivors (附錄 A(a)).
  out.push({ label: 'contact/fizzle(engineer attacks bomb)', state: contactGame('c-fz', 'engineer', 'bomb') })
  out.push({ label: 'contact/fizzle(flag attacks bomb)', state: contactGame('c-fz', 'flag', 'bomb') })
  out.push({ label: 'contact/fizzle(bomb attacks engineer)', state: contactGame('c-fz2', 'bomb', 'engineer') })
  out.push({ label: 'contact/fizzle(bomb attacks flag)', state: contactGame('c-fz2', 'bomb', 'flag') })

  // §7① 奪旗 and the only draw in the game.
  out.push({ label: 'result/flag', state: contactGame('r-flag', 'commander', 'flag') })
  out.push({ label: 'result/flag-both', state: contactGame('r-flag-both', 'flag', 'flag') })

  // §7② 計分 — a low target so two plies settle it.
  out.push({
    label: 'result/score',
    state: playAll(startedGame('r-score', { config: { scoreTarget: 2 } }), [mv('e2', 'e4'), mv('d7', 'd5')]),
  })

  // §7③ 停滯 — two quiet plies with N = 1.
  out.push({
    label: 'result/no-progress',
    state: playAll(startedGame('r-stall', { config: { noProgressTurns: 1 } }), [mv('b1', 'c3'), mv('b8', 'c6')]),
  })

  // §7④/§7⑤
  out.push({ label: 'result/timeout', state: flagFall(startedGame('r-time'), 'white') })
  out.push({ label: 'result/resign', state: resign(startedGame('r-resign'), 'black') })

  // A promotion, a castle and an en-passant window, for shape coverage.
  out.push({
    label: 'shape/castle',
    state: playAll(startedGame('s-castle'), [
      mv('g1', 'f3'), mv('g8', 'f6'), mv('g2', 'g3'), mv('g7', 'g6'),
      mv('f1', 'g2'), mv('f8', 'g7'), { kind: 'castle', side: 'king' },
    ]),
  })
  out.push({
    label: 'shape/en-passant-window',
    state: playAll(startedGame('s-ep'), [mv('e2', 'e4'), mv('a7', 'a6'), mv('e4', 'e5'), mv('d7', 'd5')]),
  })

  return out
}

// ---------------------------------------------------------------------------
// A. Deep walk
// ---------------------------------------------------------------------------

const RANKS = new Set<string>(ALL_RANKS)

/**
 * Every legal value of every `kind` discriminant in the ViewerState graph.
 * Asserting against this closes the obvious hiding place: a rank smuggled out
 * as a discriminant would otherwise be waved through by the `.kind` exemption.
 */
export const KIND_VOCAB: ReadonlySet<string> = new Set([
  'move', 'castle', 'pass',                                                    // Move
  'attacker-wins', 'defender-wins',
  'mutual-destruction', 'fizzle',                                              // CombatOutcome
  'flag', 'flag-both', 'score', 'no-progress', 'timeout', 'resign',            // Result
  'setup', 'playing', 'over',                                                  // GameStatus
  'player', 'spectator', 'spectator-public',
  'omniscient', 'replay-player',                                        // Viewer
])

type Leaf = { path: string; value: string }

/** Visit EVERY leaf of the object graph, not just the fields we expect. */
export function stringLeaves(node: unknown, path = '', out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push({ path, value: node })
    return out
  }
  if (typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((v, i) => stringLeaves(v, `${path}[${i}]`, out))
    return out
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    stringLeaves(v, path === '' ? k : `${path}.${k}`, out)
  }
  return out
}

const PIECE_RANK_PATH = /^pieces\[(\d+)\]\.rank$/
const LOG_WINNER_PATH = /^log\[(\d+)\]\.combat\.outcome\.winnerRank$/
const KIND_PATH = /(^|\.)kind$/

/**
 * The invariant, stated once:
 *
 *   a Rank may appear in a ViewerState ONLY as
 *     • `pieces[i].rank` for a piece this viewer is entitled to
 *       (owns it / 已翻明 / omniscient replay / 終局), or
 *     • the `winnerRank` of a DECISIVE contact (§4「翻明總表」), which by
 *       construction belongs to a piece flagged `revealed`.
 *
 * There is no third slot any more. 同歸於盡 used to announce the shared 階級 and
 * a detonation used to announce a colour; both are gone, so a rank anywhere in a
 * combat outcome other than `winnerRank` is a leak by definition — a nested
 * field, an unexpected key, or a stray reference dragged along by a spread.
 */
export function deepWalkViolations(s: GameState, v: Viewer, vs: ViewerState): string[] {
  const entitled = entitlement(s, v)
  const revealedRanks = new Set<Rank>(s.pieces.filter((p) => p.revealed).map((p) => p.rank))
  const bad: string[] = []

  for (const { path, value } of stringLeaves(vs)) {
    if (KIND_PATH.test(path)) {
      if (!KIND_VOCAB.has(value)) {
        bad.push(`${path} = ${JSON.stringify(value)} is not a known discriminant`)
      } else if (RANKS.has(value) && !(path === 'status.result.kind' && vs.status.kind === 'over')) {
        // 'flag' is both a Rank and a Result kind. It may only ever be the
        // latter, and only on a finished game (where §10 opens everything).
        bad.push(`rank ${value} appearing as a discriminant at ${path}`)
      }
      continue
    }

    if (!RANKS.has(value)) continue

    const pieceMatch = PIECE_RANK_PATH.exec(path)
    if (pieceMatch) {
      const i = Number(pieceMatch[1])
      if (!entitled[i]) {
        const p = s.pieces[i]!
        bad.push(
          `NOT ENTITLED: ${path} = ${value} (piece ${p.id}, ${p.color}, revealed=${p.revealed}, status=${s.status.kind})`,
        )
      }
      continue
    }

    const winner = LOG_WINNER_PATH.exec(path)
    if (winner) {
      const e = vs.log[Number(winner[1])]!
      const k = e.combat?.outcome.kind
      if (k !== 'attacker-wins' && k !== 'defender-wins') bad.push(`winnerRank on a ${String(k)} outcome at ${path}`)
      else if (!revealedRanks.has(value as Rank)) bad.push(`${path} announces ${value} but no piece is 翻明 with it`)
      continue
    }

    bad.push(`UNEXPECTED rank ${value} at ${path}`)
  }

  return bad
}

// ---------------------------------------------------------------------------
// B. Raw text of the serialised payload
// ---------------------------------------------------------------------------

const RANK_TOKEN = new RegExp(`"(${ALL_RANKS.join('|')})"`, 'g')

/**
 * Search the wire format as TEXT.
 *
 * The entitled slots are blanked first, so anything the regex still finds is
 * by definition a rank string the viewer has no claim to — no matter which
 * field, key or nesting level dragged it there. Blanking is done on a
 * JSON round-tripped clone, so getters, `toJSON` and prototype tricks are all
 * flattened out before the search.
 */
/**
 * Serialise a ViewerState for a raw-text rank grep, with the §2 count table
 * lifted out.
 *
 * `config.distribution` is keyed by the eleven rank identifiers, so it puts
 * every rank name into the JSON while attributing none of them to any piece.
 * It is public (gamebook §2), printed in the rulebook, and identical for every
 * viewer — see the viewer-invariance test, which is what licenses this.
 * NOTHING ELSE may be lifted out: the point of the grep is that it does not
 * care which field dragged a rank in.
 */
export function greppableJson(vs: ViewerState): string {
  return JSON.stringify({ ...vs, config: { ...vs.config, distribution: {} } })
}

export function rawJsonViolations(s: GameState, v: Viewer, vs: ViewerState): string[] {
  const entitled = entitlement(s, v)
  const clone = JSON.parse(JSON.stringify(vs)) as ViewerState

  // config.distribution is the §2 count table. Its KEYS are the eleven rank
  // identifiers, so a raw-text grep trips on it — but it attributes no rank to
  // any piece, it is printed in the rulebook, and it is byte-identical for every
  // viewer. `distributionIsViewerInvariant` below asserts that last property
  // directly, which is what makes blanking it here safe rather than convenient:
  // anything that made this table viewer-dependent would fail that test.
  clone.config = { ...clone.config, distribution: {} as never }

  clone.pieces.forEach((p, i) => { if (entitled[i]) p.rank = null })
  for (const e of clone.log) {
    const o = e.combat?.outcome as (CombatOutcome & Record<string, unknown>) | undefined
    if (!o) continue
    // `winnerRank` is the ONLY announced rank left: 同歸於盡 carries none and a
    // 有煙無傷 carries only a colour. Blanking anything else would blank a leak.
    if (o.kind === 'attacker-wins' || o.kind === 'defender-wins') o.winnerRank = null as never
  }

  const text = JSON.stringify(clone)
  const bad: string[] = []
  RANK_TOKEN.lastIndex = 0
  for (let m = RANK_TOKEN.exec(text); m !== null; m = RANK_TOKEN.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 7), m.index)
    const isDiscriminant = before.endsWith('"kind":')
    if (isDiscriminant && m[1] === 'flag' && vs.status.kind === 'over') continue
    bad.push(`raw JSON carries ${m[0]} at offset ${m.index}: …${text.slice(Math.max(0, m.index - 60), m.index + 20)}…`)
  }
  return bad
}

/**
 * The literal reading of the requirement, kept for completeness: a rank string
 * held by no entitled piece must not appear at all.
 *
 * It is honest to note this is nearly always vacuous — §2's distribution gives
 * every side at least one piece of all eleven 兵種, so a player viewer is
 * legitimately entitled to all eleven strings from ply one. It is the
 * *association* that leaks, which is what `rawJsonViolations` and the
 * indistinguishability suite below actually test.
 */
export function forbiddenRankStrings(s: GameState, v: Viewer): Rank[] {
  const entitled = entitlement(s, v)
  const allowed = new Set<Rank>()
  s.pieces.forEach((p, i) => { if (entitled[i]) allowed.add(p.rank) })
  return ALL_RANKS.filter((r) => !allowed.has(r))
}

// ---------------------------------------------------------------------------
// C. Indistinguishability
// ---------------------------------------------------------------------------

/**
 * Rewrite the state into an alternative world that is identical in everything
 * the viewer may see, and differs only in the hidden 兵種 assignment. The rank
 * multiset is preserved, so the alternative world is a perfectly legal §2
 * assignment — a real possibility the viewer must not be able to rule out.
 *
 * `onBoardOnly` keeps the permutation inside the surviving pieces. That matters
 * only when the alternative world is going to be fed back into `applyMove`:
 * moving 軍旗 onto an already-captured piece describes a game that should have
 * ended at §7① several plies ago, so the engine — correctly — reports it as
 * over, and the comparison would be against an impossible history rather than
 * against a leak. `stateForViewer` is a pure projection and needs no such
 * restriction, so the redaction suites use the unrestricted form.
 */
export function permuteHiddenRanks(
  s: GameState,
  v: Viewer,
  opts: { onBoardOnly?: boolean } = {},
): { state: GameState; changed: boolean } {
  const entitled = entitlement(s, v)
  const hidden: number[] = []
  s.pieces.forEach((p, i) => {
    if (entitled[i]) return
    if (opts.onBoardOnly && p.square === null) return
    hidden.push(i)
  })

  const ranks = hidden.map((i) => s.pieces[i]!.rank)
  const rotated = ranks.length > 1 ? [...ranks.slice(1), ranks[0]!] : ranks
  const nextRank = new Map<number, Rank>()
  hidden.forEach((pieceIndex, k) => nextRank.set(pieceIndex, rotated[k]!))

  let changed = false
  const pieces = s.pieces.map((p, i) => {
    const r = nextRank.get(i)
    if (r === undefined || r === p.rank) return { ...p }
    changed = true
    return { ...p, rank: r }
  })

  return { state: { ...s, pieces }, changed }
}

// ---------------------------------------------------------------------------
// D. renderForLLM
// ---------------------------------------------------------------------------

const RENDER_OPTS = { baseUrl: 'http://localhost:3000', token: 'test-token' }

/** The part of the render that lists pieces — everything above the public log. */
export function pieceSections(text: string): string {
  const cut = text.indexOf('## Public log')
  return cut >= 0 ? text.slice(0, cut) : text
}

/** The body under a `## …` heading, up to the next heading. */
export function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim() === heading)
  if (i < 0) return ''
  const rest = lines.slice(i + 1)
  const j = rest.findIndex((l) => l.startsWith('## '))
  return (j < 0 ? rest : rest.slice(0, j)).join('\n').trim()
}

/**
 * The per-piece lines of a rendered listing. The renderer appends a prose
 * summary under the same heading ("N enemy piece(s) … unknown 兵種"), so a
 * line has to look like `<square> <carrier> …` to count as a listed piece.
 */
export function listedPieceLines(text: string, heading: string): string[] {
  return section(text, heading)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-h][1-8] /.test(l))
}

/**
 * Grep the rendered text for every 兵種 name — Chinese and identifier — and
 * fail if one is printed on the same line as the square of a piece this viewer
 * may not see.
 *
 * Restricted to the piece listings: the 公開事件紀錄 below them is public by
 * §10 and deliberately prints 「工兵 or 軍旗」 next to a 有煙無傷 survivor's
 * square — that two-way ambiguity is the designed signal of 附錄 A(a), not a
 * leak. The log is instead covered by the indistinguishability suite, which
 * would catch it the moment it became one-way.
 */
export function renderViolations(s: GameState, v: Viewer, text: string): string[] {
  const entitled = entitlement(s, v)
  const lines = pieceSections(text).split('\n')
  const bad: string[] = []

  s.pieces.forEach((p, i) => {
    if (entitled[i] || p.square === null) return
    const sq = squareName(p.square)
    for (const line of lines) {
      if (!line.includes(sq)) continue
      for (const r of ALL_RANKS) {
        if (line.includes(RANK_NAMES_ZH[r]) || new RegExp(`\\b${r}\\b`).test(line)) {
          bad.push(`hidden ${p.color} piece on ${sq} is on a line naming ${r}/${RANK_NAMES_ZH[r]}: ${line.trim()}`)
        }
      }
    }
  })
  return bad
}

// ===========================================================================
// Suites
// ===========================================================================

const CORPUS = buildCorpus({ games: 96, maxPlies: 60, seed: 0x5eed })

describe('遮蔽層 property — corpus', () => {
  it('covers every stage, every §4 outcome and every §7 result kind', () => {
    const statuses = new Set(CORPUS.map((c) => c.state.status.kind))
    const results = new Set(
      CORPUS.flatMap((c) => (c.state.status.kind === 'over' ? [c.state.status.result.kind] : [])),
    )
    const outcomes = new Set(
      CORPUS.flatMap((c) => c.state.log.flatMap((e) => (e.combat ? [e.combat.outcome.kind] : []))),
    )

    expect([...statuses].sort()).toEqual(['over', 'playing', 'setup'])
    // FOUR announcements, not six. The corpus still builds all three both-die
    // 兵種 pairings (see scenarioCorpus) — they simply announce as one kind now,
    // which is why this list shrank rather than the coverage.
    expect([...outcomes].sort()).toEqual([
      'attacker-wins', 'defender-wins', 'fizzle', 'mutual-destruction',
    ])
    for (const kind of ['flag', 'flag-both', 'no-progress', 'resign', 'score', 'timeout']) {
      expect(results.has(kind as never), `corpus never produces result ${kind}`).toBe(true)
    }
    expect(CORPUS.length).toBeGreaterThan(500)
  })
})

describe('遮蔽層 property — A. deep walk of the whole ViewerState', () => {
  for (const v of ALL_VIEWERS) {
    it(`never carries an unentitled 兵種 anywhere in the graph — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const vs = stateForViewer(state, v)
        for (const problem of deepWalkViolations(state, v, vs)) bad.push(`[${label}] ${problem}`)
      }
      expect(bad.slice(0, 12)).toEqual([])
    })

    it(`survives a JSON round-trip with the same guarantee — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const vs = stateForViewer(state, v)
        const round = JSON.parse(JSON.stringify(vs)) as ViewerState
        for (const problem of deepWalkViolations(state, v, round)) bad.push(`[${label}] ${problem}`)
      }
      expect(bad.slice(0, 12)).toEqual([])
    })
  }
})

describe('遮蔽層 property — B. raw serialised text', () => {
  for (const v of ALL_VIEWERS) {
    it(`the JSON text holds no unentitled rank token — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const vs = stateForViewer(state, v)
        for (const problem of rawJsonViolations(state, v, vs)) bad.push(`[${label}] ${problem}`)
      }
      expect(bad.slice(0, 6)).toEqual([])
    })

    it(`a rank belonging to no entitled piece never appears — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const forbidden = forbiddenRankStrings(state, v)
        if (forbidden.length === 0) continue
        const text = greppableJson(stateForViewer(state, v))
        for (const r of forbidden) {
          if (text.includes(`"${r}"`)) bad.push(`[${label}] forbidden rank token "${r}" in payload`)
        }
      }
      expect(bad.slice(0, 6)).toEqual([])
    })
  }
})

/**
 * The licence for lifting `config.distribution` out of every raw-text grep.
 *
 * Blanking a field before a leak search is exactly the move that hides a real
 * leak, so the exemption has to be earned rather than asserted. It is earned by
 * this: the table is byte-identical for every viewer AND unchanged by permuting
 * the hidden 兵種. A field with both properties cannot carry information about
 * who is who. If anything ever makes it viewer-dependent, this fails first and
 * the exemption stops being safe — which is the whole point of having it.
 */
describe('遮蔽層 property — B2. the §2 table is viewer-invariant', () => {
  it('every viewer receives byte-identical counts, on every corpus state', () => {
    const bad: string[] = []
    for (const { label, state } of CORPUS) {
      const seen = ALL_VIEWERS.map((v) =>
        JSON.stringify(stateForViewer(state, v).config.distribution),
      )
      const first = seen[0]!
      seen.forEach((t, i) => {
        if (t !== first) bad.push(`[${label}] ${viewerLabel(ALL_VIEWERS[i]!)} differs`)
      })
    }
    expect(bad.slice(0, 6)).toEqual([])
  })

  it('permuting hidden 兵種 does not move it', () => {
    const bad: string[] = []
    for (const v of ALL_VIEWERS) {
      for (const { label, state } of CORPUS) {
        const { state: alt, changed } = permuteHiddenRanks(state, v)
        if (!changed) continue
        const a = JSON.stringify(stateForViewer(state, v).config.distribution)
        const b = JSON.stringify(stateForViewer(alt, v).config.distribution)
        if (a !== b) bad.push(`[${label}] ${viewerLabel(v)} table moved under permutation`)
      }
    }
    expect(bad.slice(0, 6)).toEqual([])
  })
})

describe('遮蔽層 property — C. hidden ranks are indistinguishable', () => {
  for (const v of ALL_VIEWERS) {
    it(`permuting hidden 兵種 leaves the payload byte-identical — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      let exercised = 0

      for (const { label, state } of CORPUS) {
        const { state: alt, changed } = permuteHiddenRanks(state, v)
        if (!changed) continue
        exercised++

        const a = JSON.stringify(stateForViewer(state, v))
        const b = JSON.stringify(stateForViewer(alt, v))
        if (a !== b) bad.push(`[${label}] view varies with a hidden rank at offset ${firstDiff(a, b)}`)

        // Non-vacuity: the permutation really did change the underlying world,
        // so an omniscient viewer must be able to see the difference.
        const oa = JSON.stringify(stateForViewer(state, { kind: 'omniscient' }))
        const ob = JSON.stringify(stateForViewer(alt, { kind: 'omniscient' }))
        if (oa === ob) bad.push(`[${label}] permutation was a no-op — the test would be vacuous`)
      }

      expect(bad.slice(0, 6)).toEqual([])
      // Omniscient / finished games have nothing hidden; everyone else must
      // have been exercised on a large part of the corpus.
      if (v.kind !== 'omniscient') expect(exercised).toBeGreaterThan(100)
    })
  }
})

describe('遮蔽層 property — D. renderForLLM', () => {
  for (const v of ALL_VIEWERS) {
    it(`prints no 兵種 next to a hidden piece — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const text = renderForLLM(stateForViewer(state, v), RENDER_OPTS)
        for (const problem of renderViolations(state, v, text)) bad.push(`[${label}] ${problem}`)
      }
      expect(bad.slice(0, 6)).toEqual([])
    })

    it(`renders identically across permuted hidden 兵種 — ${viewerLabel(v)}`, () => {
      const bad: string[] = []
      for (const { label, state } of CORPUS) {
        const { state: alt, changed } = permuteHiddenRanks(state, v)
        if (!changed) continue
        const a = renderForLLM(stateForViewer(state, v), RENDER_OPTS)
        const b = renderForLLM(stateForViewer(alt, v), RENDER_OPTS)
        if (a !== b) bad.push(`[${label}] rendered text varies with a hidden rank`)
      }
      expect(bad.slice(0, 6)).toEqual([])
    })
  }
})

describe('遮蔽層 property — E. 附錄 A: no rank-dependent observable behaviour', () => {
  it('the legal move list never depends on the 兵種 layer', () => {
    const bad: string[] = []
    for (const { label, state } of CORPUS) {
      if (state.status.kind !== 'playing') continue
      const { state: alt, changed } = permuteHiddenRanks(state, { kind: 'replay-player', color: 'white' })
      if (!changed) continue
      for (const color of ['white', 'black'] as const) {
        const a = JSON.stringify(legalMoves(state, color))
        const b = JSON.stringify(legalMoves(alt, color))
        if (a !== b) bad.push(`[${label}] ${color}'s move list changed when black's hidden ranks were permuted`)
      }
    }
    expect(bad.slice(0, 6)).toEqual([])
  })

  it('中央計分 counts pieces, not 兵種', () => {
    const bad: string[] = []
    for (const { label, state } of CORPUS) {
      if (state.status.kind !== 'playing') continue
      const quiet = legalMoves(state, state.toMove).find((m) => m.kind === 'move' && !isCapture(state, m))
      if (!quiet) continue
      // onBoardOnly: see permuteHiddenRanks. Relocating 軍旗 onto a captured
      // piece would describe a game §7① should already have ended, and the
      // engine says so — that is the rule, not a leak.
      const { state: alt, changed } = permuteHiddenRanks(
        state, { kind: 'replay-player', color: state.toMove }, { onBoardOnly: true },
      )
      if (!changed) continue
      const a = applyMove(state, quiet)
      const b = applyMove(alt, quiet)
      // Belt and braces: if the engine says contact happened, the move was not
      // quiet after all and 兵種 legitimately decides the outcome.
      if (a.log[a.log.length - 1]?.combat) continue
      for (const [what, x, y] of [
        ['score', a.score, b.score],
        ['status', a.status, b.status],
        ['noProgressTurns', a.noProgressTurns, b.noProgressTurns],
        ['clockMs', a.clockMs, b.clockMs],
      ] as const) {
        if (JSON.stringify(x) !== JSON.stringify(y)) {
          bad.push(
            `[${label}] ${what} after a quiet move depends on the opponent's hidden 兵種: `
            + `${JSON.stringify(x)} vs ${JSON.stringify(y)}`,
          )
        }
      }
    }
    expect(bad.slice(0, 6)).toEqual([])
  })
})

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}
