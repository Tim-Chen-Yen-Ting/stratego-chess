/**
 * The harness — 行軍西洋棋 as a measuring instrument.
 *
 * Six hand-played games produced conclusions that were reversed twice, because
 * every comparison moved the board, the model and the dice at the same time
 * (notebook §6.6). This file exists so that exactly one variable can move: it
 * plays N games from one seed under one config, and hands the games to
 * `report.ts` to pool.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MAKES THE NUMBERS MEAN ANYTHING
 * ---------------------------------------------------------------------------
 *
 * A policy receives a **ViewerState** — the same redacted payload a human
 * player is sent — and nothing else. The harness owns the `GameState`; it calls
 * `stateForViewer(state, { kind: 'player', color })` for the side to move and
 * passes only that. There is no path from a policy back to authoritative state:
 *
 *   · `Policy.move` and `Policy.deploy` take a `ViewerState`, the colour of the
 *     seat they are sitting in, and an `Rng`. None of those is a `GameState`,
 *     and the harness never puts one in a closure a policy can reach.
 *   · `stateForViewer` deep-copies everything it returns (rules/redact.ts), so a
 *     policy cannot reach back through an alias or corrupt the game by writing
 *     to the view it was handed.
 *   · Both deployment views are taken from the SAME pre-submission state, so
 *     neither side learns anything from the other's setup (§9 同時且互不可見).
 *   · Nothing here reads `piece.rank` off the GameState on a policy's behalf.
 *     The one place the harness DOES read hidden ranks is `tallyContact`, which
 *     runs after `applyMove` and writes only into the statistics — see the
 *     comment there for why that is the job rather than a leak.
 *
 * A bot that peeks produces self-play statistics about a different game.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 *
 * `Math.random` is never called, here or anywhere reachable from here. Every
 * draw comes from `prng.ts`, and the streams are SPLIT by label so that a run
 * stays comparable when one thing changes:
 *
 *   seed ─┬─ match i = deriveSeed(seed, i)
 *         │      ├─ deploy:white   ├─ move:white
 *         │      └─ deploy:black   └─ move:black
 *
 * Because a sub-seed is derived from its parent SEED and not from a parent's
 * consumed state, swapping Black's policy does not shift White's dice, and a
 * policy that draws a different number of randoms while deploying does not
 * shift its own play stream.
 *
 * The labels are deliberately the same four `index.ts`'s `playGame` uses, so a
 * game replayed through either driver at the same seed is the same game.
 */

import {
  applyMove,
  createGame,
  legalMoves,
  matchMove,
  moveToNotation,
  stateForViewer,
  submitAssignment,
  validateAssignment,
} from '@xiyang/rules'
import type {
  Color,
  GameConfig,
  GameState,
  Move,
  Piece,
  Rank,
  Result,
  Square,
} from '@xiyang/rules'
import { deriveSeed, makeRng } from './prng.js'
import type { Rng } from './prng.js'
import type { Policy } from './policy.js'

const COLORS: readonly Color[] = ['white', 'black']

// ---------------------------------------------------------------------------
// Faults — loud, never silent
// ---------------------------------------------------------------------------

/**
 * A policy returned a move the engine will not accept.
 *
 * This is a HARD ERROR and it must stay one. Substituting a pass would turn a
 * broken policy into a quiet one that merely scores badly, and the run would
 * report a strategy result for what is actually a bug. `applyMove` would throw
 * on its own; this throws first, so the message names the policy, the seat and
 * the ply instead of just the move — in a thousand-game run that is the
 * difference between a reproducible report and a scavenger hunt.
 */
export class IllegalMoveError extends Error {
  readonly policy: string
  readonly color: Color
  readonly ply: number
  readonly move: unknown

  constructor(policy: string, color: Color, ply: number, move: unknown, legal: readonly Move[]) {
    const shown = legal.slice(0, 24).map(moveToNotation).join(' ')
    const more = legal.length > 24 ? ` … (+${legal.length - 24} more)` : ''
    super(
      `policy "${policy}" (${color}) returned an illegal move at ply ${ply}: ${describe(move)}.`
      + ` ${legal.length} legal moves: ${shown}${more}`,
    )
    this.name = 'IllegalMoveError'
    this.policy = policy
    this.color = color
    this.ply = ply
    this.move = move
  }
}

/** A policy returned a deployment that is not a bijection onto the §2 table. */
export class IllegalDeploymentError extends Error {
  readonly policy: string
  readonly color: Color

  constructor(policy: string, color: Color, problem: string) {
    super(`policy "${policy}" (${color}) returned an illegal deployment: ${problem}`)
    this.name = 'IllegalDeploymentError'
    this.policy = policy
    this.color = color
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value !== 'object') return `${typeof value} ${String(value)}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserialisable object]'
  }
}

// ---------------------------------------------------------------------------
// Contact instrumentation
// ---------------------------------------------------------------------------

/**
 * What actually happened in every contact of a match.
 *
 * **This cannot come from the log, and that is the point.** Under gamebook v04
 * §4.3 an equal-兵種 trade, a 爆裂物 detonation and 爆裂物-vs-爆裂物 all announce
 * the same contentless 同歸於盡, so `gameStats` reports only the pooled
 * mutual-destruction rate and warns — at length — against reading it as the
 * 同階雙亡 figure of notebook §4.1: the numerator and the denominator are both
 * gone from the public record. That note ends 「measuring it takes an
 * instrumented engine」.
 *
 * This is the instrument. The harness owns the GameState, so after each ply it
 * reads the two true 兵種 that met and classifies the contact. Those ranks go
 * into these counters and nowhere else: no policy is called again with them, no
 * ViewerState is built from them, and nothing here writes back to the game.
 * Peeking for the scoreboard is the job; peeking for a move would be the fraud.
 */
export interface DuelTally {
  /** every contact, of every kind */
  contacts: number
  /** 階級對決 — contacts where two 階級 were actually compared (no 爆裂物) */
  rankDuels: number
  /** 同階雙亡 — rank duels where the two 階級 were equal */
  rankTies: number
  /** rank duels decided one way or the other */
  rankDecisive: number
  /** 爆裂物 vs an ordinary 兵種 — both removed, announced as 同歸於盡 */
  bombDetonations: number
  /** 爆裂物 vs 爆裂物 — both removed, announced as 同歸於盡 */
  bombVsBomb: number
  /** 有煙無傷 — 爆裂物 against 工兵/軍旗; the bomb alone is lost (§5.4) */
  fizzles: number
}

function emptyTally(): DuelTally {
  return {
    contacts: 0,
    rankDuels: 0,
    rankTies: 0,
    rankDecisive: 0,
    bombDetonations: 0,
    bombVsBomb: 0,
    fizzles: 0,
  }
}

function pieceOn(state: GameState, square: Square): Piece | undefined {
  return state.pieces.find((p) => p.square === square)
}

/** §5: 工兵 and 軍旗, the two 兵種 a 爆裂物 loses to in both directions. */
const BOMB_IMMUNE_RANKS: readonly Rank[] = ['engineer', 'flag']

/**
 * Classify the contact the last ply produced, if it made one.
 *
 * `before` is the state the move was played from, so both pieces are still on
 * the board there: the attacker on `attackerSquare` — §4 位置結算 removes a
 * losing attacker from its ORIGIN, which is the square the event records — and
 * the defender on `defenderSquare`, which differs from the destination only on
 * an en passant. Both squares come off the PUBLIC event; only the two ranks
 * come from the authoritative state.
 */
function tallyContact(before: GameState, after: GameState, tally: DuelTally): void {
  const event = after.log[after.log.length - 1]
  if (!event?.combat) return

  const attacker = pieceOn(before, event.combat.attackerSquare)
  const defender = pieceOn(before, event.combat.defenderSquare)
  if (!attacker || !defender) {
    throw new Error(
      `harness: cannot instrument the contact at ply ${event.ply} —`
      + ` no piece on ${event.combat.attackerSquare}/${event.combat.defenderSquare} before the move`,
    )
  }

  tally.contacts++

  const attackerBomb = attacker.rank === 'bomb'
  const defenderBomb = defender.rank === 'bomb'

  if (attackerBomb && defenderBomb) {
    tally.bombVsBomb++
    return
  }
  if (attackerBomb || defenderBomb) {
    const other = attackerBomb ? defender.rank : attacker.rank
    if (BOMB_IMMUNE_RANKS.includes(other)) tally.fizzles++
    else tally.bombDetonations++
    return
  }

  // 階級對決: two 階級 were compared. Equal rank names mean equal RANK_ORDER, so
  // 同階 is exactly rank equality here.
  tally.rankDuels++
  if (attacker.rank === defender.rank) tally.rankTies++
  else tally.rankDecisive++
}

// ---------------------------------------------------------------------------
// Running one match
// ---------------------------------------------------------------------------

/** Overrides on top of the engine defaults (附錄 B tunables). */
export type MatchConfig = Partial<GameConfig>

/** Every way a match can stop, including the one the rules do not know about. */
export type MatchOutcomeKind = Result['kind'] | 'max-plies'

export interface MatchOutcome {
  kind: MatchOutcomeKind
  /** null for the 雙旗 draw and for a match that simply ran out of plies */
  winner: Color | null
}

export interface MatchResult {
  /** the per-match seed — this match alone replays exactly from it */
  seed: number
  outcome: MatchOutcome
  /** plies actually played */
  plies: number
  /** true when the match stopped on `maxPlies` instead of ending */
  unfinished: boolean
  /** the true 階級 classification of every contact — see {@link DuelTally} */
  duels: DuelTally
  names: Record<Color, string>
}

export interface Match {
  /**
   * The authoritative final state. The harness owns it and no policy ever saw
   * it; `report.ts` reads it through `stateForViewer(..., { kind:'omniscient' })`.
   */
  state: GameState
  result: MatchResult
}

/**
 * Play one match to the end, or to `maxPlies`.
 *
 * The loop is the whole contract: take the authoritative state, redact it for
 * the side to move, ask that side for a move, verify the move against the
 * authoritative state, apply it, instrument the contact. Nothing else touches
 * a policy.
 */
export function runMatch(
  white: Policy,
  black: Policy,
  config: MatchConfig,
  seed: number,
  maxPlies: number,
): Match {
  if (!Number.isInteger(maxPlies) || maxPlies < 1) {
    throw new Error(`runMatch: maxPlies must be a positive integer, got ${String(maxPlies)}`)
  }

  const matchSeed = seed >>> 0
  const policies: Record<Color, Policy> = { white, black }

  // The clock is off unless a caller insists: nothing here burns wall time, so
  // §7④ 超時 is unreachable and 增秒 would tick on every ply for no reason.
  let state = createGame(`bot-${matchSeed}`, { clockEnabled: false, ...config })

  // --- ① 佈署 (§9: 同時且互不可見) -------------------------------------------
  // BOTH views come from the same pre-submission state. Submitting White first
  // would leak no rank — `entitledToRank` refuses another colour's 兵種 outright,
  // and withholds even one's own placeholders before submission — but it would
  // leak the FACT of submission through `status.submitted`, and simultaneity
  // costs nothing here.
  const preDeployment = state
  for (const color of COLORS) {
    const policy = policies[color]
    const view = stateForViewer(preDeployment, { kind: 'player', color })
    const assignment = policy.deploy(view, color, makeRng(deriveSeed(matchSeed, `deploy:${color}`)))
    const problem = validateAssignment(assignment, color, state)
    if (problem !== null) throw new IllegalDeploymentError(policy.name, color, problem)
    state = submitAssignment(state, color, assignment)
  }

  // --- ② plies ---------------------------------------------------------------
  const moveRng: Record<Color, Rng> = {
    white: makeRng(deriveSeed(matchSeed, 'move:white')),
    black: makeRng(deriveSeed(matchSeed, 'move:black')),
  }
  const duels = emptyTally()

  while (state.status.kind === 'playing' && state.log.length < maxPlies) {
    const color = state.toMove
    const policy = policies[color]

    // THE boundary. This object is the only thing a policy is ever given.
    const view = stateForViewer(state, { kind: 'player', color })
    const move = policy.move(view, color, moveRng[color]) as unknown

    assertLegal(state, color, policy.name, move)

    const before = state
    state = applyMove(state, move as Move)
    tallyContact(before, state, duels)
  }

  const outcome: MatchOutcome = state.status.kind === 'over'
    ? { kind: state.status.result.kind, winner: winnerOf(state.status.result) }
    : { kind: 'max-plies', winner: null }

  return {
    state,
    result: {
      seed: matchSeed,
      outcome,
      plies: state.log.length,
      unfinished: state.status.kind !== 'over',
      duels,
      names: { white: white.name, black: black.name },
    },
  }
}

function winnerOf(result: Result): Color | null {
  return result.kind === 'flag-both' ? null : result.winner
}

/**
 * Verify a policy's move against the AUTHORITATIVE state, not against the view
 * the policy was handed. The two agree today; checking the authoritative one
 * means they still have to agree tomorrow.
 *
 * Promotion is matched the way the engine matches it (`matchMove`): a pawn move
 * onto the last rank with no `promote` is a queen promotion, not an error.
 */
function assertLegal(state: GameState, color: Color, policy: string, move: unknown): void {
  const legal = (): Move[] => legalMoves(state, color)

  if (move === null || typeof move !== 'object') {
    throw new IllegalMoveError(policy, color, state.ply, move, legal())
  }
  const kind = (move as { kind?: unknown }).kind
  if (kind !== 'move' && kind !== 'castle' && kind !== 'pass') {
    throw new IllegalMoveError(policy, color, state.ply, move, legal())
  }
  // §3④ pass is always legal while the game is running.
  if (kind === 'pass') return
  if (matchMove(state, color, move as Move) === null) {
    throw new IllegalMoveError(policy, color, state.ply, move, legal())
  }
}

// ---------------------------------------------------------------------------
// Running N matches
// ---------------------------------------------------------------------------

/**
 * Play `games` matches from one root seed.
 *
 * Match i takes `deriveSeed(seed, i)` — not `seed + i`, which would correlate
 * neighbouring games — so match 7 of a 10-game run and match 7 of a 1000-game
 * run are the SAME game. Shortening a run truncates it rather than resampling
 * it, and any suspicious game replays on its own through
 * `runMatch(..., result.seed, ...)`.
 */
export function runMatches(
  white: Policy,
  black: Policy,
  config: MatchConfig,
  seed: number,
  games: number,
  maxPlies: number,
): Match[] {
  if (!Number.isInteger(games) || games < 1) {
    throw new Error(`runMatches: games must be a positive integer, got ${String(games)}`)
  }
  const out: Match[] = []
  for (let i = 0; i < games; i++) {
    out.push(runMatch(white, black, config, matchSeedFor(seed, i), maxPlies))
  }
  return out
}

/** The seed match `index` of a run will use. Same rule as `index.ts`'s batch. */
export function matchSeedFor(seed: number, index: number): number {
  return deriveSeed(seed >>> 0, index)
}
