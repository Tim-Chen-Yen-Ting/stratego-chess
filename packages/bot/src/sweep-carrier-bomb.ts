/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * sibling of `sweep-forced-deploy.ts` and `sweep-carrier-arms.ts`, built to
 * give 爆裂物 (bomb) the same directly-controlled, real-opponent treatment
 * flag and commander already got.
 *
 * The passive (self-play, both-sides-randomized) carrier/rank sweep
 * (`sweep-carrier-rank.ts`) found no carrier for bomb clearing even the
 * uncorrected |z|=3 bar — queen was the largest deviation at z=-2.58. That is
 * a genuine unresolved null, not a confirmed absence: the same passive method
 * gave flag and commander WEAKER signals than the controlled A/B later
 * confirmed (commander went from a shaky n=466/z=3.61 passive lead to a
 * rock-solid +18.4pp controlled effect). Bomb has never had the controlled
 * treatment. This script gives it one.
 *
 * Design: bomb has 2 instances per side, unlike flag/commander's 1. To stay
 * on the same single-rank-forcing convention already used for those two, each
 * arm pins exactly ONE bomb instance onto the named carrier; the second bomb
 * instance and all 14 other ranks are randomly assigned as usual, exactly as
 * `forcedAssignment` (copied verbatim from the two prior scripts) already
 * does for a single `pinnedRank`. Controlling both bomb instances at once is
 * a different, more complex question, not this one.
 *
 * Arms: all 6 carriers (pawn, knight, bishop, rook, queen, king) — unlike the
 * flag carrier-arms script, which only ran the 5 non-pawn carriers because it
 * could reuse an existing flag-on-pawn control from `sweep-forced-deploy.ts`.
 * No such reusable control exists for bomb, so this script adds a 7th arm,
 * `any`: the pinned bomb instance is forced onto a uniformly random OWN
 * carrier out of all 16 (predicate `() => true`). Because `forcedAssignment`
 * already picks the pinned piece uniformly among everything satisfying the
 * predicate and then randomly permutes the rest, `any` with an always-true
 * predicate is mathematically identical to plain unconstrained random
 * assignment — it is the "genuine fully-random-bomb baseline" and is used as
 * the primary comparator for all 6 carrier arms. The `pawn` arm (also run as
 * one of the 6) is additionally reported as a secondary comparator, matching
 * flag's "off-pawn" framing, at no extra wall-clock cost since it is already
 * one of the 6 arms being played.
 *
 * Run (single process):
 *   node dist/sweep-carrier-bomb.js <carrier> <gamesPerArm> <masterSeed> <sampleSize> [shardIndex numShards]
 *
 * carrier ∈ pawn | knight | bishop | rook | queen | king | any
 */
import {
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
} from '@xiyang/rules'
import type { Carrier, Color, PieceId, Rank, ViewerState } from '@xiyang/rules'

import { deriveSeed, playGame } from './index.js'
import { ownPieces, rankPool, shuffled } from './policy.js'
import { beliefPolicy } from './policies/belief.js'
import type { Policy } from './policy.js'
import type { Rng } from './prng.js'

export const CONFIG = {
  scoringSquares: SCORING_WIDE_8,
  distribution: DISTRIBUTION_SCOUTS,
  scoreTarget: 120,
  noProgressTurns: 30,
  komi: 0.5,
  captureScoreK: 1,
  fizzleBonus: 5,
}

/**
 * Same as sweep-forced-deploy.ts / sweep-carrier-arms.ts's forcedAssignment,
 * with one addition: an optional `onPinned` callback fired with the pinned
 * piece's id right after it is chosen (before the rng touches anything else,
 * so nothing about the resulting distribution changes). Flag and commander
 * never needed this because they have exactly 1 instance, so
 * `rank === pinnedRank` was unambiguous when reading it back out of the
 * final deployment. Bomb has 2 instances per side (DISTRIBUTION_SCOUTS), so
 * after the random remainder shuffle the SECOND, unpinned bomb can land on
 * some other carrier — `Object.entries(assignment).find(([, rank]) => rank
 * === 'bomb')` would then be ambiguous between the two. `onPinned` sidesteps
 * that by recording the actually-pinned id directly, with no inference.
 */
function forcedAssignment(
  pinnedRank: Rank,
  carrierPredicate: (carrier: Carrier) => boolean,
  view: ViewerState,
  color: Color,
  rng: Rng,
  onPinned?: (id: PieceId) => void,
): Record<PieceId, Rank> {
  const pieces = ownPieces(view, color)
  const eligible = pieces.filter((p) => carrierPredicate(p.carrier))
  if (eligible.length === 0) {
    throw new Error(`forcedAssignment: no own carrier satisfies the predicate for ${color}`)
  }
  const pinnedPiece = rng.pick(eligible)
  onPinned?.(pinnedPiece.id)

  const pool = [...rankPool(view)]
  const idx = pool.indexOf(pinnedRank)
  if (idx < 0) throw new Error(`forcedAssignment: rank '${pinnedRank}' not in this game's distribution`)
  pool.splice(idx, 1)

  const remainingIds = pieces.filter((p) => p.id !== pinnedPiece.id).map((p) => p.id)
  const shuffledPool = shuffled(pool, rng)

  const out: Record<PieceId, Rank> = { [pinnedPiece.id]: pinnedRank }
  remainingIds.forEach((id, i) => {
    const rank = shuffledPool[i]
    if (rank !== undefined) out[id] = rank
  })
  return out
}

/**
 * `lastPinnedId` is a mutable box the caller reads immediately after
 * `playGame` returns for one game. Safe because `runShard` below plays games
 * strictly sequentially in one process (no concurrency within a shard), so
 * deploy() for this policy always runs-then-is-read before the next game's
 * deploy() overwrites it.
 */
function makePinnedPolicy(
  name: string,
  pinnedRank: Rank,
  predicate: (c: Carrier) => boolean,
  lastPinnedId: { current: PieceId | undefined },
): Policy {
  return {
    name,
    deploy: (view, color, rng) =>
      forcedAssignment(pinnedRank, predicate, view, color, rng, (id) => {
        lastPinnedId.current = id
      }),
    move: beliefPolicy.move,
  }
}

const REAL_CARRIERS: readonly Carrier[] = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']
type ArmKey = Carrier | 'any'
const ARM_KEYS: readonly ArmKey[] = [...REAL_CARRIERS, 'any']

interface ArmDef {
  armName: string
  pinnedRank: Rank
  policy: Policy
  expectedPredicate: (c: Carrier) => boolean
  lastPinnedId: { current: PieceId | undefined }
}

function armDef(arm: ArmKey): ArmDef {
  if (!ARM_KEYS.includes(arm)) {
    throw new Error(`unknown carrier arm '${arm}'. Known: ${ARM_KEYS.join(', ')}`)
  }
  const predicate = arm === 'any' ? () => true : (c: Carrier) => c === arm
  const lastPinnedId: { current: PieceId | undefined } = { current: undefined }
  return {
    armName: `bomb-${arm}`,
    pinnedRank: 'bomb',
    policy: makePinnedPolicy(`bomb-${arm}`, 'bomb', predicate, lastPinnedId),
    expectedPredicate: predicate,
    lastPinnedId,
  }
}

// ---------------------------------------------------------------------------
// Arm runner (one shard) — identical shape to sweep-carrier-arms.ts
// ---------------------------------------------------------------------------

interface ColorAcc {
  n: number
  wins: number
}

interface SampleRow {
  gameIndex: number
  seed: number
  subjectColor: Color
  pinnedRank: Rank
  pinnedCarrier: Carrier
  predicateHeld: boolean
}

export interface ShardSummary {
  armName: string
  pinnedRank: Rank
  gamesPerArm: number
  shardIndex: number
  numShards: number
  gamesInShard: number
  wins: number
  truncated: number
  byColor: Record<Color, ColorAcc>
  msTotal: number
  sample: SampleRow[]
}

/**
 * Safety net, not a fix for anything specific: the 2026-08-21 incident (see
 * `run-bomb-main.sh`'s history) had 21 shard processes sit at 0 bytes of
 * output for 3+ hours with nothing on stderr to say why. Post-mortem found no
 * actual unbounded loop — every code path in this file and its shared
 * dependencies (`forcedAssignment`, `belief.ts`'s sampler, `lookahead.ts`) is
 * boundedly retried or plainly O(board) — and an instrumented sequential
 * re-run of 2500+ games per arm never produced a game slower than ~1s or any
 * super-linear drift in per-game time or RSS. The likely cause was ordinary
 * resource contention from running 21 heavy processes at once, not a bug in
 * this file. But "likely" is not "certain", and a silent multi-hour stall is
 * a bad failure mode regardless of cause, so this file now narrates itself:
 * a per-game duration warning catches a genuinely slow game the moment it
 * happens (rather than 3 hours of silence), and a periodic progress line
 * makes a killed/timed-out shard's progress legible from its .err file
 * instead of forcing a re-diagnosis from scratch. Both go to stderr only —
 * stdout stays pure JSON for the shell script to redirect into the .json file.
 */
const SLOW_GAME_WARN_MS = 5_000
const PROGRESS_EVERY = 100

function runShard(
  def: ArmDef,
  gamesPerArm: number,
  masterSeed: number,
  sampleSize: number,
  shardIndex: number,
  numShards: number,
): ShardSummary {
  const byColor: Record<Color, ColorAcc> = {
    white: { n: 0, wins: 0 },
    black: { n: 0, wins: 0 },
  }
  let wins = 0
  let truncated = 0
  let gamesInShard = 0
  const sample: SampleRow[] = []

  const t0 = Date.now()

  for (let i = shardIndex; i < gamesPerArm; i += numShards) {
    gamesInShard++
    const seed = deriveSeed(masterSeed, `${def.armName}:${i}`)
    const subjectIsWhite = i % 2 === 0
    const white = subjectIsWhite ? def.policy : beliefPolicy
    const black = subjectIsWhite ? beliefPolicy : def.policy
    const subjectColor: Color = subjectIsWhite ? 'white' : 'black'

    const gameT0 = Date.now()
    const outcome = playGame({
      seed,
      white,
      black,
      config: CONFIG,
      id: `${def.armName}-${i}`,
    })

    const gameMs = Date.now() - gameT0
    if (gameMs > SLOW_GAME_WARN_MS) {
      console.error(
        `[${def.armName} shard ${shardIndex}/${numShards}] SLOW GAME: index ${i} `
        + `(seed ${seed}) took ${gameMs}ms — ${outcome.plies} plies, truncated=${outcome.truncated}. `
        + `Normal is ~0.2-0.7s; this is ${(gameMs / 300).toFixed(0)}x that. If this recurs the `
        + `same index+seed replays exactly (deriveSeed is deterministic), so it is reproducible.`,
      )
    }
    if (gamesInShard % PROGRESS_EVERY === 0) {
      const elapsed = Date.now() - t0
      console.error(
        `[${def.armName} shard ${shardIndex}/${numShards}] ${gamesInShard} games done `
        + `(index ${i}) in ${(elapsed / 1000).toFixed(1)}s — ${(elapsed / gamesInShard).toFixed(0)}ms/game avg`,
      )
    }

    if (outcome.truncated) truncated++

    const won = outcome.winner === subjectColor
    if (won) wins++
    byColor[subjectColor].n++
    if (won) byColor[subjectColor].wins++

    if (sample.length < sampleSize) {
      // Bomb has 2 instances per side; only ONE was pinned. Use the id
      // `forcedAssignment`'s onPinned callback recorded for THIS game (set
      // during this game's own deploy() call, read immediately below, before
      // the next iteration's deploy() overwrites it) rather than scanning the
      // final assignment for rank === 'bomb', which would be ambiguous
      // between the pinned instance and the second, randomly-placed one.
      const pinnedId = def.lastPinnedId.current
      const pinnedPiece = pinnedId
        ? outcome.final.pieces.find((p) => p.id === pinnedId && p.color === subjectColor)
        : undefined
      if (pinnedId === undefined || pinnedPiece === undefined) {
        throw new Error(`spot-check: could not locate the pinned '${def.pinnedRank}' in game ${def.armName}-${i}`)
      }
      sample.push({
        gameIndex: i,
        seed,
        subjectColor,
        pinnedRank: def.pinnedRank,
        pinnedCarrier: pinnedPiece.carrier,
        predicateHeld: def.expectedPredicate(pinnedPiece.carrier),
      })
    }
  }

  return {
    armName: def.armName,
    pinnedRank: def.pinnedRank,
    gamesPerArm,
    shardIndex,
    numShards,
    gamesInShard,
    wins,
    truncated,
    byColor,
    msTotal: Date.now() - t0,
    sample,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const carrier = (process.argv[2] ?? 'queen') as ArmKey
  const gamesPerArm = Number(process.argv[3] ?? '100')
  const masterSeed = Number(process.argv[4] ?? '1')
  const sampleSize = Number(process.argv[5] ?? '20')
  const shardIndex = Number(process.argv[6] ?? '0')
  const numShards = Number(process.argv[7] ?? '1')

  const def = armDef(carrier)
  const result = runShard(def, gamesPerArm, masterSeed, sampleSize, shardIndex, numShards)
  console.log(JSON.stringify(result))
}

const entry = process.argv[1]
if (entry !== undefined && entry.endsWith('sweep-carrier-bomb.js')) {
  main()
}
