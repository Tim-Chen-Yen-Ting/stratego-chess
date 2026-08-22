/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * sibling of `sweep-forced-deploy.ts`, built to close a gap that script's own
 * A/B left open. Experiment A there pooled "flag on any non-pawn carrier"
 * into one treatment arm and beat "flag on a pawn" control by +8.0pp
 * (n=2000/arm, z=5.10) — but never recorded WHICH of the 5 non-pawn carriers
 * the flag landed on per game, so the passive (self-play, randomized-both-
 * sides) sweep's suggested gradient among carriers (king > bishop > rook >
 * knight > queen) was never tested against a real opponent.
 *
 * This script pins the flag onto exactly ONE named carrier (not a predicate
 * over several), one arm per invocation, and plays it against belief's real,
 * unmodified doctrine deployment on the other side — same shape as
 * `sweep-forced-deploy.ts`'s Experiment A, just narrowed from "any of 5" to
 * "exactly this 1". `forcedAssignment` already picks uniformly among ALL
 * carriers satisfying the predicate, so for rook/knight/bishop (2 squares
 * each) this automatically covers "either square, uniformly" with no extra
 * code — the predicate is just `c === carrier`.
 *
 * The control arm (flag forced onto a random PAWN carrier, n=2000) is REUSED
 * from the earlier run, not replayed here — same config, same seed
 * convention, so it's a valid comparator without spending wall-clock on it
 * again.
 *
 * Run (single process):
 *   node dist/sweep-carrier-arms.js <carrier> <gamesPerArm> <masterSeed> <sampleSize> [shardIndex numShards]
 *
 * carrier ∈ queen | king | rook | knight | bishop
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

/** identical to sweep-forced-deploy.ts's forcedAssignment — kept in lockstep deliberately. */
function forcedAssignment(
  pinnedRank: Rank,
  carrierPredicate: (carrier: Carrier) => boolean,
  view: ViewerState,
  color: Color,
  rng: Rng,
): Record<PieceId, Rank> {
  const pieces = ownPieces(view, color)
  const eligible = pieces.filter((p) => carrierPredicate(p.carrier))
  if (eligible.length === 0) {
    throw new Error(`forcedAssignment: no own carrier satisfies the predicate for ${color}`)
  }
  const pinnedPiece = rng.pick(eligible)

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

function makePinnedPolicy(name: string, pinnedRank: Rank, predicate: (c: Carrier) => boolean): Policy {
  return {
    name,
    deploy: (view, color, rng) => forcedAssignment(pinnedRank, predicate, view, color, rng),
    move: beliefPolicy.move,
  }
}

const CARRIER_ARMS: readonly Carrier[] = ['queen', 'king', 'rook', 'knight', 'bishop']

interface ArmDef {
  armName: string
  pinnedRank: Rank
  policy: Policy
  expectedPredicate: (c: Carrier) => boolean
}

function armDef(carrier: Carrier): ArmDef {
  if (!CARRIER_ARMS.includes(carrier)) {
    throw new Error(`unknown carrier arm '${carrier}'. Known: ${CARRIER_ARMS.join(', ')}`)
  }
  const predicate = (c: Carrier) => c === carrier
  return {
    armName: `flag-${carrier}`,
    pinnedRank: 'flag',
    policy: makePinnedPolicy(`flag-${carrier}`, 'flag', predicate),
    expectedPredicate: predicate,
  }
}

// ---------------------------------------------------------------------------
// Arm runner (one shard) — identical shape to sweep-forced-deploy.ts
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

    const outcome = playGame({
      seed,
      white,
      black,
      config: CONFIG,
      id: `${def.armName}-${i}`,
    })

    if (outcome.truncated) truncated++

    const won = outcome.winner === subjectColor
    if (won) wins++
    byColor[subjectColor].n++
    if (won) byColor[subjectColor].wins++

    if (sample.length < sampleSize) {
      const assignment = outcome.deployment[subjectColor]
      const pinnedId = Object.entries(assignment).find(([, rank]) => rank === def.pinnedRank)?.[0] as
        | PieceId
        | undefined
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
  const carrier = (process.argv[2] ?? 'queen') as Carrier
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
if (entry !== undefined && entry.endsWith('sweep-carrier-arms.js')) {
  main()
}
