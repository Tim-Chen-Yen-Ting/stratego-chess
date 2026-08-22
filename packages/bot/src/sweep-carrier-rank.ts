/**
 * ONE-OFF experiment script (not part of the package's permanent surface):
 * does WHICH carrier a secret 兵種 rank is deployed on correlate with that
 * side winning the game, when deployment is randomized and move selection is
 * left at `belief`'s normal doctrine?
 *
 * `belief-randeploy` composes `randomAssignment` (policy.ts, already used by
 * the `random` policy) for `deploy` with `beliefPolicy.move` (belief.ts,
 * UNMODIFIED) for `move`. Built here, not in belief.ts, and type-checked
 * against the real `Policy` interface by this file's own compilation as part
 * of `npm run build -w @xiyang/bot`.
 *
 * Run: node dist/sweep-carrier-rank.js <games> <masterSeed>
 */
import {
  ALL_RANKS,
  DISTRIBUTION_SCOUTS,
  SCORING_WIDE_8,
} from '@xiyang/rules'
import type { Carrier, Color, Rank } from '@xiyang/rules'

import { deriveSeed, playGame } from './index.js'
import { randomAssignment } from './policy.js'
import { beliefPolicy } from './policies/belief.js'
import type { Policy } from './policy.js'

const beliefRandeployPolicy: Policy = {
  name: 'belief-randeploy',
  deploy: randomAssignment,
  move: beliefPolicy.move,
}

const CARRIERS: readonly Carrier[] = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']
const COLORS: readonly Color[] = ['white', 'black']

const CONFIG = {
  scoringSquares: SCORING_WIDE_8,
  distribution: DISTRIBUTION_SCOUTS,
  scoreTarget: 120,
  noProgressTurns: 30,
  komi: 0.5,
  captureScoreK: 1,
  fizzleBonus: 5,
}

function key(rank: Rank, carrier: Carrier): string {
  return `${rank}|${carrier}`
}

async function main(): Promise<void> {
  const games = Number(process.argv[2] ?? '100')
  const masterSeed = Number(process.argv[3] ?? '1')

  const cells = new Map<string, { n: number; wins: number }>()
  for (const rank of ALL_RANKS) {
    for (const carrier of CARRIERS) cells.set(key(rank, carrier), { n: 0, wins: 0 })
  }

  let decisiveGames = 0
  let nonDecisiveGames = 0
  let pooledObservations = 0
  let pooledWins = 0
  let totalPlies = 0

  const t0 = Date.now()

  for (let i = 0; i < games; i++) {
    const seed = deriveSeed(masterSeed, i)
    const outcome = playGame({
      seed,
      white: beliefRandeployPolicy,
      black: beliefRandeployPolicy,
      config: CONFIG,
      id: `sweep-${i}`,
    })
    totalPlies += outcome.plies

    // Only decisive games (a real winner, not a truncation and not the
    // 雙方軍旗同時離場 draw) go into the correlation — a draw or a truncation
    // has no "won" to correlate a deployment with, and folding either into
    // "did not win" would silently relabel a draw as a loss.
    if (outcome.winner === null) {
      nonDecisiveGames++
      continue
    }
    decisiveGames++

    for (const color of COLORS) {
      const won = outcome.winner === color
      for (const piece of outcome.final.pieces) {
        if (piece.color !== color) continue
        // omniscient view (§10.5) — every piece's rank is disclosed at game end.
        if (piece.rank === null) throw new Error(`omniscient view withheld a rank: ${piece.id}`)
        const cell = cells.get(key(piece.rank, piece.carrier))!
        cell.n++
        if (won) cell.wins++
        pooledObservations++
        if (won) pooledWins++
      }
    }

    if ((i + 1) % 20 === 0) {
      process.stderr.write(`... ${i + 1}/${games} games, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
    }
  }

  const elapsedMs = Date.now() - t0

  const table = ALL_RANKS.flatMap((rank) =>
    CARRIERS.map((carrier) => {
      const c = cells.get(key(rank, carrier))!
      return {
        rank,
        carrier,
        n: c.n,
        wins: c.wins,
        winRate: c.n > 0 ? c.wins / c.n : null,
      }
    }),
  )

  const result = {
    gamesRequested: games,
    decisiveGames,
    nonDecisiveGames,
    meanPlies: totalPlies / games,
    elapsedMs,
    msPerGame: elapsedMs / games,
    pooledObservations,
    pooledWins,
    pooledWinRate: pooledObservations > 0 ? pooledWins / pooledObservations : null,
    config: CONFIG,
    masterSeed,
    table,
  }

  console.log(JSON.stringify(result, null, 2))
}

main()
