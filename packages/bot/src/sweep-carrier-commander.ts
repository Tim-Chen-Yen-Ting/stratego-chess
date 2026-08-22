/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * sibling of `sweep-carrier-arms.ts` (which did this for 軍旗/flag) and
 * `sweep-carrier-bomb.ts` (which did this for 爆裂物/bomb), now closing the
 * same gap for 司令 (commander).
 *
 * `sweep-forced-deploy.ts` Experiment B already confirmed a real, large
 * effect for commander-on-queen: 58.4% vs a POOLED "any of the other 15
 * carriers" control at 40.0% (n=3000/arm, z=14.28). That comparison never
 * broke down which of the other 5 carrier TYPES (pawn, knight, bishop, rook,
 * king — queen's own square is excluded, being the treatment) are individually
 * good or bad for commander, unlike flag, whose per-carrier breakdown
 * (`sweep-carrier-arms.ts`) turned up a real finding: king and knight tied for
 * best, a genuine same-strength rotation pair rather than one fixed answer.
 *
 * This script gives commander the same per-carrier breakdown, run against
 * belief's real, unmodified doctrine deployment on the other side — same
 * shape as `sweep-carrier-arms.ts`, just pinning 'commander' instead of
 * 'flag', and covering all 6 carrier types (not just the 5 non-pawn ones,
 * since unlike flag there is no pre-existing single-carrier "pawn" arm to
 * reuse as a control — commander's only prior baseline is the POOLED
 * non-queen control, which mixes pawn in with the other 5).
 *
 * Commander has exactly 1 instance per side in DISTRIBUTION_SCOUTS (same as
 * flag), so the plain single-pinnedRank `forcedAssignment` — reading the
 * pinned piece back out of the final deployment by `rank === pinnedRank` — is
 * unambiguous and needs none of `sweep-carrier-bomb.ts`'s `onPinned` callback
 * machinery, which exists only because bomb has 2 instances per side.
 *
 * Operational lessons folded in from `sweep-carrier-bomb.ts` (its header
 * documents a 2026-08-21 incident where 21 unthrottled shard processes sat
 * silent for 3+ hours from ordinary CPU contention, not a code bug):
 *   - a stderr warning fires on any single game exceeding 5s, with its seed,
 *     so a stall is diagnosable in seconds rather than hours;
 *   - a progress line every 100 games/shard makes a killed/timed-out shard's
 *     progress legible from its own .err file;
 *   - the run script wrapping this file caps total concurrent processes at
 *     ~24 and wraps every shard in a hard `timeout`.
 * Both stderr behaviours are pure diagnostics: stdout carries nothing but the
 * final JSON summary, so shell redirection into a per-shard .json file stays
 * clean.
 *
 * Run (single process):
 *   node dist/sweep-carrier-commander.js <carrier> <gamesPerArm> <masterSeed> <sampleSize> [shardIndex numShards]
 *
 * carrier ∈ pawn | knight | bishop | rook | queen | king
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

/** identical to sweep-carrier-arms.ts's forcedAssignment — kept in lockstep deliberately. */
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

const CARRIER_ARMS: readonly Carrier[] = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']

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
    armName: `commander-${carrier}`,
    pinnedRank: 'commander',
    policy: makePinnedPolicy(`commander-${carrier}`, 'commander', predicate),
    expectedPredicate: predicate,
  }
}

// ---------------------------------------------------------------------------
// Arm runner (one shard) — identical shape to sweep-carrier-bomb.ts, minus
// the onPinned machinery (unneeded: commander has exactly 1 instance).
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
 * Same stderr instrumentation as sweep-carrier-bomb.ts, folded in from the
 * start per this run's operating instructions rather than added reactively
 * after a stall. See that file's header for the 2026-08-21 incident this is
 * a safety net for.
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
if (entry !== undefined && entry.endsWith('sweep-carrier-commander.js')) {
  main()
}
