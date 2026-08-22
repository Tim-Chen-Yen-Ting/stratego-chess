/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * two DIRECTLY CONTROLLED A/B experiments, each pinning one hidden 兵種 rank
 * onto a chosen carrier at deployment time, then playing out the game with
 * belief's REAL move logic on the subject side and belief's REAL, unmodified
 * doctrine deployment on the opponent side (no self-play, no randomized
 * opponent — that gap was flagged after the earlier passive sweep).
 *
 * Experiment A — 軍旗 (flag) off the pawn carrier:
 *   treatment: flag forced onto a uniformly random NON-pawn carrier (one of
 *   the 8 back-rank squares). control: flag forced onto a uniformly random
 *   pawn carrier (8 choices). Every other rank random over what remains.
 *
 * Experiment B — 司令 (commander) on the queen carrier:
 *   treatment: commander forced onto the queen carrier. control: commander
 *   forced onto a uniformly random NON-queen carrier (15 choices). Every
 *   other rank random over what remains.
 *
 * Colour balance: within each arm, the subject plays white on the
 * even-indexed games and black on the odd-indexed games (i % 2), so every
 * arm is exactly half-white / half-black by construction — the earlier
 * sweep's verification pass found a real, unexplained ~52-53% white win rate
 * in this population and this is what keeps it from confounding either
 * experiment.
 *
 * `forcedAssignment` is the only new deployment logic. It is the same shape
 * as `randomAssignment` (policy.ts): pick uniformly among eligible carriers
 * for the pinned rank, then Fisher-Yates the remaining ranks onto the
 * remaining carriers. No movement, scoring or replay logic is touched.
 *
 * SHARDING: each game is fully independent (its own seed), so this process
 * can be invoked many times in parallel, each handling every `numShards`-th
 * game index for one (experiment, arm) pair, to use more than one CPU core.
 * A small merge step (merge-forced-deploy.mjs) sums the resulting shard
 * files. Sharding changes nothing about which games get played or what seed
 * they use — `i % numShards === shardIndex` just partitions the same
 * i = 0..gamesPerArm-1 range that a single unsharded process would loop over
 * sequentially, so a merged run and a sequential run of the same
 * (gamesPerArm, masterSeed) are identical game-for-game.
 *
 * Run (single process): node dist/sweep-forced-deploy.js <A|B> <treatment|control> <gamesPerArm> <masterSeed> <sampleSize> [shardIndex numShards]
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
 * Pin `pinnedRank` onto a uniformly random own carrier satisfying
 * `carrierPredicate`, then randomly assign every other rank in this game's
 * distribution to the remaining carriers.
 */
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

const isPawn = (c: Carrier) => c === 'pawn'
const isNonPawn = (c: Carrier) => c !== 'pawn'
const isQueen = (c: Carrier) => c === 'queen'
const isNonQueen = (c: Carrier) => c !== 'queen'

interface ArmDef {
  armName: string
  pinnedRank: Rank
  policy: Policy
  expectedPredicate: (c: Carrier) => boolean
}

function armDef(experiment: 'A' | 'B', arm: 'treatment' | 'control'): ArmDef {
  if (experiment === 'A') {
    return arm === 'treatment'
      ? { armName: 'A-treatment', pinnedRank: 'flag', policy: makePinnedPolicy('flag-nonpawn', 'flag', isNonPawn), expectedPredicate: isNonPawn }
      : { armName: 'A-control', pinnedRank: 'flag', policy: makePinnedPolicy('flag-pawn', 'flag', isPawn), expectedPredicate: isPawn }
  }
  return arm === 'treatment'
    ? { armName: 'B-treatment', pinnedRank: 'commander', policy: makePinnedPolicy('commander-queen', 'commander', isQueen), expectedPredicate: isQueen }
    : { armName: 'B-control', pinnedRank: 'commander', policy: makePinnedPolicy('commander-nonqueen', 'commander', isNonQueen), expectedPredicate: isNonQueen }
}

// ---------------------------------------------------------------------------
// Arm runner (one shard)
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
      // Find the piece the subject's OWN deployment assigned pinnedRank to,
      // and read its carrier off the omniscient final view (carrier never
      // changes even if the piece was later captured) — a direct check that
      // the pin actually took, not an inference from the outcome.
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
  const experiment = (process.argv[2] ?? 'A').toUpperCase() as 'A' | 'B'
  const armName = (process.argv[3] ?? 'treatment') as 'treatment' | 'control'
  const gamesPerArm = Number(process.argv[4] ?? '100')
  const masterSeed = Number(process.argv[5] ?? '1')
  const sampleSize = Number(process.argv[6] ?? '20')
  const shardIndex = Number(process.argv[7] ?? '0')
  const numShards = Number(process.argv[8] ?? '1')

  if (experiment !== 'A' && experiment !== 'B') throw new Error(`unknown experiment '${experiment}'`)
  if (armName !== 'treatment' && armName !== 'control') throw new Error(`unknown arm '${armName}'`)

  const def = armDef(experiment, armName)
  const result = runShard(def, gamesPerArm, masterSeed, sampleSize, shardIndex, numShards)
  console.log(JSON.stringify(result))
}

const entry = process.argv[1]
if (entry !== undefined && entry.endsWith('sweep-forced-deploy.js')) {
  main()
}
