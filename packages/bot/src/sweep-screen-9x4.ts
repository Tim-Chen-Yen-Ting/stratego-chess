/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * a SCREEN (not a confirmation) of the 9 non-pinned ranks against the 4
 * remaining carrier TYPES, with the two already-confirmed deployment effects
 * held fixed: 司令 (commander) pinned onto the queen carrier AND 軍旗 (flag)
 * pinned onto the king carrier, exactly as `sweep-joint-deploy.ts`'s `joint`
 * arm did (63.64% win rate, n=2500, vs belief's real doctrine). This script
 * reuses that file's `jointForcedAssignment` verbatim — see the comment on
 * that function there for what it generalises and why it's safe to reuse.
 *
 * With commander→queen and flag→king both taken, the OTHER 14 rank-instances
 * (12 distinct ranks minus... no: 9 distinct ranks, 14 instances — see the
 * arithmetic note below) Fisher-Yates onto the 14 remaining squares (8 pawn,
 * 2 knight, 2 bishop, 2 rook). This script records, per game, which CARRIER
 * TYPE each of those 14 instances landed on and whether the subject won,
 * pooling observations across games exactly as the original passive sweep
 * (`sweep-carrier-rank.ts`) pooled multi-instance ranks — every instance of
 * брigade/engineer/bomb is a separate observation in the same cell.
 *
 * DISTRIBUTION_SCOUTS arithmetic (packages/rules/src/constants.ts), checked
 * against the table rather than assumed: commander 1, general 1, division 1,
 * brigade 2, regiment 1, battalion 1, company 1, platoon 1, engineer 4,
 * flag 1, bomb 2 — 16 total. Pinning commander and flag leaves 14 instances
 * across 9 distinct ranks: general(1) + division(1) + brigade(2) +
 * regiment(1) + battalion(1) + company(1) + platoon(1) + engineer(4) +
 * bomb(2) = 14, matching the 14 non-king/non-queen carriers exactly. (The
 * task brief guessed "engineer x2"; the real table has engineer x4 — this is
 * exactly the kind of arithmetic worth checking against the source rather
 * than trusting blind.)
 *
 * Opponent = beliefPolicy, completely unmodified (real doctrine deployment,
 * real move selection) — identical shape to sweep-joint-deploy's `joint` arm,
 * so this run's pooled overall win rate is a direct sanity check against that
 * 63.64% benchmark: if deployment is genuinely screening 9 ranks x 4 carriers
 * with no bug, the pooled rate here should land close to it (the 14 free
 * ranks are, in aggregate, exactly the same random remainder the joint test
 * already measured — this script just breaks the aggregate down by cell).
 *
 * Every game also re-verifies (never merely samples) that commander really
 * landed on queen and flag really landed on king, off the 全知者 (final)
 * view — `jointForcedAssignment` guarantees this by construction, so any
 * miss here is a hard bug in the harness or this script, not sampling noise,
 * and the shard throws immediately rather than recording a false cell.
 *
 * Run (single process):
 *   node dist/sweep-screen-9x4.js <gamesTotal> <masterSeed> [shardIndex numShards]
 *
 * Output: one JSON line per shard to stdout (progress + warnings go to
 * stderr so stdout stays parseable). `merge-screen-9x4.ts` sums shard files.
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

// The 9 screened ranks (commander and flag are pinned, not screened) and the
// 4 carrier types still available to them (queen and king are claimed).
export const SCREENED_RANKS: readonly Rank[] = [
  'general', 'division', 'brigade', 'regiment', 'battalion',
  'company', 'platoon', 'engineer', 'bomb',
]
export const SCREENED_CARRIERS: readonly Carrier[] = ['pawn', 'knight', 'bishop', 'rook']

interface Pin {
  readonly rank: Rank
  readonly predicate: (carrier: Carrier) => boolean
}

/**
 * Copied verbatim from `sweep-joint-deploy.ts` per this session's brief
 * ("reuse it ... do not rebuild this primitive"). See that file for the full
 * rationale; this is the same function, same behaviour.
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

const screenPolicy: Policy = {
  name: 'screen_commander-queen_flag-king',
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

// ---------------------------------------------------------------------------
// Shard runner
// ---------------------------------------------------------------------------

function cellKey(rank: Rank, carrier: Carrier): string {
  return `${rank}|${carrier}`
}

interface ColorAcc {
  n: number
  wins: number
}

export interface ShardSummary {
  gamesTotal: number
  shardIndex: number
  numShards: number
  gamesInShard: number
  wins: number
  truncated: number
  decisive: number
  byColor: Record<Color, ColorAcc>
  msTotal: number
  slowGames: number
  cells: { rank: Rank; carrier: Carrier; n: number; wins: number }[]
  pinMismatches: number
}

function runShard(
  gamesTotal: number,
  masterSeed: number,
  shardIndex: number,
  numShards: number,
): ShardSummary {
  const byColor: Record<Color, ColorAcc> = {
    white: { n: 0, wins: 0 },
    black: { n: 0, wins: 0 },
  }
  const cells = new Map<string, { n: number; wins: number }>()
  for (const rank of SCREENED_RANKS) {
    for (const carrier of SCREENED_CARRIERS) cells.set(cellKey(rank, carrier), { n: 0, wins: 0 })
  }

  let wins = 0
  let truncated = 0
  let decisive = 0
  let gamesInShard = 0
  let slowGames = 0
  let pinMismatches = 0

  const t0 = Date.now()

  for (let i = shardIndex; i < gamesTotal; i += numShards) {
    gamesInShard++
    const seed = deriveSeed(masterSeed, `screen:${i}`)
    const subjectIsWhite = i % 2 === 0
    const white = subjectIsWhite ? screenPolicy : beliefPolicy
    const black = subjectIsWhite ? beliefPolicy : screenPolicy
    const subjectColor: Color = subjectIsWhite ? 'white' : 'black'

    const gt0 = Date.now()
    const outcome = playGame({
      seed,
      white,
      black,
      config: CONFIG,
      id: `screen-${i}`,
    })
    const gameMs = Date.now() - gt0
    if (gameMs > 5000) {
      slowGames++
      process.stderr.write(
        `WARNING slow game: shard ${shardIndex}/${numShards} i=${i} seed=${seed} took ${gameMs}ms\n`,
      )
    }

    if (outcome.truncated) truncated++
    else decisive++

    const won = outcome.winner === subjectColor
    if (won) wins++
    byColor[subjectColor].n++
    if (won) byColor[subjectColor].wins++

    // Every game, not a sample: verify the two pins actually held, and bucket
    // the other 14 rank-instances by carrier type. `final` is the omniscient
    // view (§10.5), so every piece's rank is disclosed regardless of capture.
    let sawCommander = false
    let sawFlag = false
    for (const piece of outcome.final.pieces) {
      if (piece.color !== subjectColor) continue
      if (piece.rank === null) throw new Error(`omniscient view withheld a rank: ${piece.id}`)
      if (piece.rank === 'commander') {
        sawCommander = true
        if (piece.carrier !== 'queen') {
          pinMismatches++
          throw new Error(
            `PIN MISMATCH game screen-${i} (seed ${seed}): commander landed on '${piece.carrier}', not queen`,
          )
        }
        continue
      }
      if (piece.rank === 'flag') {
        sawFlag = true
        if (piece.carrier !== 'king') {
          pinMismatches++
          throw new Error(
            `PIN MISMATCH game screen-${i} (seed ${seed}): flag landed on '${piece.carrier}', not king`,
          )
        }
        continue
      }
      const cell = cells.get(cellKey(piece.rank, piece.carrier))
      if (cell === undefined) {
        throw new Error(`unexpected rank/carrier combo in game screen-${i}: ${piece.rank}/${piece.carrier}`)
      }
      cell.n++
      if (won) cell.wins++
    }
    if (!sawCommander || !sawFlag) {
      throw new Error(`game screen-${i} (seed ${seed}): missing commander or flag piece in final view`)
    }

    if (gamesInShard % 100 === 0) {
      process.stderr.write(
        `... shard ${shardIndex}/${numShards}: ${gamesInShard} games done, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
      )
    }
  }

  return {
    gamesTotal,
    shardIndex,
    numShards,
    gamesInShard,
    wins,
    truncated,
    decisive,
    byColor,
    msTotal: Date.now() - t0,
    slowGames,
    cells: SCREENED_RANKS.flatMap((rank) =>
      SCREENED_CARRIERS.map((carrier) => {
        const c = cells.get(cellKey(rank, carrier))!
        return { rank, carrier, n: c.n, wins: c.wins }
      }),
    ),
    pinMismatches,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const gamesTotal = Number(process.argv[2] ?? '100')
  const masterSeed = Number(process.argv[3] ?? '1')
  const shardIndex = Number(process.argv[4] ?? '0')
  const numShards = Number(process.argv[5] ?? '1')

  const result = runShard(gamesTotal, masterSeed, shardIndex, numShards)
  console.log(JSON.stringify(result))
}

const entry = process.argv[1]
if (entry !== undefined && entry.endsWith('sweep-screen-9x4.js')) {
  main()
}
