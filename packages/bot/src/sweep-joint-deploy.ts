/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * third sibling of `sweep-forced-deploy.ts` / `sweep-carrier-arms.ts`. Both of
 * those experiments pinned exactly ONE hidden 兵種 rank per game and left every
 * OTHER rank — including the other special rank — fully random. Neither ever
 * measured:
 *
 *   (a) a genuinely unconstrained deployment (`randomAssignment`, nothing
 *       pinned) against belief's REAL doctrine specifically — every baseline
 *       measured so far was against a randomised opponent, or was itself
 *       constrained on one rank (e.g. sweep-forced-deploy's A-control pins
 *       軍旗 onto a random pawn, it doesn't leave it unconstrained);
 *   (b) 軍旗→king AND 司令→queen pinned SIMULTANEOUSLY in the same game, to
 *       see whether the two individually-best-carrier effects (flag=king
 *       alone, commander=queen alone) compose additively, super-additively or
 *       sub-additively.
 *
 * This script adds exactly those two arms:
 *
 *   baseline — plain `randomAssignment` (policy.ts). No rank is pinned at all.
 *   joint    — 軍旗 forced onto the king carrier AND 司令 forced onto the queen
 *              carrier, in the SAME game. The other 14 ranks Fisher-Yates onto
 *              the remaining 14 carriers.
 *
 * Both play belief's real move logic on the subject side against belief's
 * real, unmodified doctrine deployment on the opponent side — identical shape
 * to the two sibling scripts: same CONFIG, same subject-colour-by-parity
 * convention, same seed derivation (`deriveSeed(masterSeed, `${armName}:${i}`)`),
 * same sharding contract (`i % numShards === shardIndex` partitions the same
 * i = 0..gamesPerArm-1 a sequential run would use, so sharded and unsharded
 * runs of the same (gamesPerArm, masterSeed) are game-for-game identical),
 * same in-run pin-verification `sample` array.
 *
 * `jointForcedAssignment` generalises `forcedAssignment` (copied verbatim into
 * both prior scripts, kept in lockstep deliberately) from ONE pin to an
 * ORDERED LIST of pins. King and queen carriers can never collide — a piece
 * has exactly one carrier — so which pin in the list is resolved first never
 * matters for this experiment's two predicates specifically.
 *
 * Run (single process):
 *   node dist/sweep-joint-deploy.js <baseline|joint> <gamesPerArm> <masterSeed> <sampleSize> [shardIndex numShards]
 */
import {
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
} from '@xiyang/rules'
import type { Carrier, Color, PieceId, Rank, ViewerState } from '@xiyang/rules'

import { deriveSeed, playGame } from './index.js'
import { ownPieces, randomAssignment, rankPool, shuffled } from './policy.js'
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

interface Pin {
  readonly rank: Rank
  readonly predicate: (carrier: Carrier) => boolean
}

/**
 * Generalises `forcedAssignment` from one pin to an ORDERED LIST of pins: for
 * each pin in order, choose uniformly among this side's own carriers
 * satisfying its predicate that were not already claimed by an earlier pin in
 * the same call, assign it that rank, then Fisher-Yates every remaining rank
 * onto every remaining carrier. With a single-element `pins` this is exactly
 * `forcedAssignment`.
 */
function jointForcedAssignment(
  pins: readonly Pin[],
  view: ViewerState,
  color: Color,
  rng: Rng,
): Record<PieceId, Rank> {
  const pieces = ownPieces(view, color)
  const claimed = new Set<PieceId>()
  const out: Record<PieceId, Rank> = {}
  const pool = [...rankPool(view)]

  for (const pin of pins) {
    const eligible = pieces.filter((p) => !claimed.has(p.id) && pin.predicate(p.carrier))
    if (eligible.length === 0) {
      throw new Error(`jointForcedAssignment: no unclaimed own carrier satisfies the predicate for '${pin.rank}' (${color})`)
    }
    const piece = rng.pick(eligible)
    claimed.add(piece.id)
    out[piece.id] = pin.rank

    const idx = pool.indexOf(pin.rank)
    if (idx < 0) throw new Error(`jointForcedAssignment: rank '${pin.rank}' not in this game's distribution`)
    pool.splice(idx, 1)
  }

  const remainingIds = pieces.filter((p) => !claimed.has(p.id)).map((p) => p.id)
  const shuffledPool = shuffled(pool, rng)
  remainingIds.forEach((id, i) => {
    const rank = shuffledPool[i]
    if (rank !== undefined) out[id] = rank
  })
  return out
}

const isKing = (c: Carrier) => c === 'king'
const isQueen = (c: Carrier) => c === 'queen'

const baselinePolicy: Policy = {
  name: 'baseline-random',
  deploy: (view, color, rng) => randomAssignment(view, color, rng),
  move: beliefPolicy.move,
}

const jointPolicy: Policy = {
  name: 'flag-king_commander-queen',
  deploy: (view, color, rng) =>
    jointForcedAssignment(
      [
        { rank: 'flag', predicate: isKing },
        { rank: 'commander', predicate: isQueen },
      ],
      view,
      color,
      rng,
    ),
  move: beliefPolicy.move,
}

type ArmName = 'baseline' | 'joint'

interface ArmDef {
  armName: ArmName
  policy: Policy
  /** does this arm's deployment satisfy its own constraint (baseline: vacuously yes; joint: both pins landed) */
  checkPins: (flagCarrier: Carrier, commanderCarrier: Carrier) => boolean
}

function armDef(arm: ArmName): ArmDef {
  if (arm === 'baseline') return { armName: 'baseline', policy: baselinePolicy, checkPins: () => true }
  return { armName: 'joint', policy: jointPolicy, checkPins: (f, c) => f === 'king' && c === 'queen' }
}

// ---------------------------------------------------------------------------
// Arm runner (one shard) — identical shape to the two sibling scripts
// ---------------------------------------------------------------------------

interface ColorAcc {
  n: number
  wins: number
}

interface SampleRow {
  gameIndex: number
  seed: number
  subjectColor: Color
  flagCarrier: Carrier
  commanderCarrier: Carrier
  pinsHeld: boolean
}

export interface ShardSummary {
  armName: ArmName
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
      // Same discipline as the two sibling scripts: read the pinned ranks'
      // carriers off the subject's OWN deployment and the omniscient final
      // view (carrier never changes even if the piece was later captured) —
      // a direct check that the pin(s) actually took, not an inference from
      // the outcome.
      const assignment = outcome.deployment[subjectColor]
      const flagId = Object.entries(assignment).find(([, rank]) => rank === 'flag')?.[0] as PieceId | undefined
      const commanderId = Object.entries(assignment).find(([, rank]) => rank === 'commander')?.[0] as
        | PieceId
        | undefined
      const flagPiece = flagId
        ? outcome.final.pieces.find((p) => p.id === flagId && p.color === subjectColor)
        : undefined
      const commanderPiece = commanderId
        ? outcome.final.pieces.find((p) => p.id === commanderId && p.color === subjectColor)
        : undefined
      if (flagPiece === undefined || commanderPiece === undefined) {
        throw new Error(`spot-check: could not locate 軍旗/司令 in game ${def.armName}-${i}`)
      }
      sample.push({
        gameIndex: i,
        seed,
        subjectColor,
        flagCarrier: flagPiece.carrier,
        commanderCarrier: commanderPiece.carrier,
        pinsHeld: def.checkPins(flagPiece.carrier, commanderPiece.carrier),
      })
    }
  }

  return {
    armName: def.armName,
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
  const armName = (process.argv[2] ?? 'baseline') as ArmName
  const gamesPerArm = Number(process.argv[3] ?? '100')
  const masterSeed = Number(process.argv[4] ?? '1')
  const sampleSize = Number(process.argv[5] ?? '20')
  const shardIndex = Number(process.argv[6] ?? '0')
  const numShards = Number(process.argv[7] ?? '1')

  if (armName !== 'baseline' && armName !== 'joint') throw new Error(`unknown arm '${armName}'`)

  const def = armDef(armName)
  const result = runShard(def, gamesPerArm, masterSeed, sampleSize, shardIndex, numShards)
  console.log(JSON.stringify(result))
}

const entry = process.argv[1]
if (entry !== undefined && entry.endsWith('sweep-joint-deploy.js')) {
  main()
}
