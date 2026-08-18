/**
 * THE INSTRUMENT. Pure scoring, no combat.
 *
 * ---------------------------------------------------------------------------
 * What it is for
 * ---------------------------------------------------------------------------
 *
 * Notebook §3.3c reads: 「GPT 在下西洋棋，人類在下計分遊戲。」 This policy is that
 * sentence turned into a control. It cannot develop, it cannot attack, it cannot
 * defend, it has no opening book and no idea what a 兵種 is worth. It does
 * exactly one thing: it stands on 結算格 and collects (§7).
 *
 * That makes it the denominator for every question in notebook §7 that is
 * really a question about the SCORING RATE rather than about play:
 *
 *   · 側翼八格 amplifier or balancer (§3.3b) — run it on both boards;
 *   · X = 60 or 80 (§3.4) — read the ply count off a pure race;
 *   · 貼目 0.5 against the first-move tempo (§7) — mirror it against itself and
 *     see who crosses X first;
 *   · N = 30 (§3.5) — it is the most 龜縮 player that can exist, so if the
 *     停滯 fuse never blows against it, it never blows.
 *
 * It is expected to be embarrassingly strong. That is the measurement, not a
 * bug. If never attacking beats a competent player, the finding is about the
 * scoring rate, and the right response is to retune 附錄 B — not to teach this
 * bot to fight, which would destroy the very thing it measures.
 *
 * ---------------------------------------------------------------------------
 * The five rules, verbatim, and where each lives below
 * ---------------------------------------------------------------------------
 *
 *   1. never initiate a capture ................ `initiatesContact`
 *   2. prefer a scoring square not already held . `gainOf` > 0
 *   3. never step OFF a 結算格 without gain ..... `vacatesScoring` + `gainOf`
 *   4. never move the 軍旗, anywhere ............ `movesTheFlag`
 *   5. pass when nothing improves ............... the empty-candidates return
 *
 * Deterministic apart from tie-breaking, which draws from the seeded rng.
 *
 * ---------------------------------------------------------------------------
 * Hidden information
 * ---------------------------------------------------------------------------
 *
 * The one 兵種 this policy reads is its OWN 軍旗 — which it is entitled to
 * (§10.1 玩家: 己方全部) and which it needs, because moving that piece loses the
 * game on the spot (§5.3, §7.5①). It reads no enemy rank, revealed or otherwise,
 * and would behave identically if every enemy rank in the payload were null.
 */

import type { Color, Move, PieceId, Rank, ViewerPiece, ViewerState } from '@xiyang/rules'
import type { Rng } from '../prng.js'
import type { MoveShape, Policy } from '../policy.js'
import {
  heldScoring,
  heldScoringAfter,
  moveKey,
  ownPieceIds,
  ownPieces,
  pawnReachesScoring,
  rankPool,
  scoringSet,
  shapeOfMove,
  shuffled,
} from '../policy.js'

const PASS: Move = { kind: 'pass' }

/**
 * Rule 1 — never initiate a capture.
 *
 * Any contact at all, not just a losing one. This bot has no combat model and is
 * not allowed one: the moment it starts guessing at enemy 兵種 it stops being a
 * pure scoring baseline and its results stop isolating the scoring rate.
 *
 * `shape.contact` counts the en-passant victim too (§4.2), which is the capture
 * a "is the destination square occupied?" test misses — the victim stands beside
 * the destination, not on it.
 */
function initiatesContact(shape: MoveShape): boolean {
  return shape.contact !== undefined
}

/**
 * Rule 4 — never move the 軍旗.
 *
 * 「軍旗以任何方式離開棋盤，該方立即判負」 (§5.3). Sitting still is the only way to
 * be sure, and notebook §1.3 says the same thing from the other end: 「保護軍旗的
 * 最佳方式因此是『什麼仗都不打』」. This bot is the only player that can afford to
 * take that advice literally, because it never needs the piece for anything.
 *
 * 王車易位 counts. §5.3 is explicit that castling does NOT take a 軍旗 off the
 * board, so a flag-carrying king could legally castle — but a castle relocates
 * two pieces and this rule is meant to be verifiable from the outside, by a test
 * that checks no logged move was made with the flag piece. Allowing the one
 * legal exception would make that check conditional, so the flag never moves at
 * all, by any route.
 *
 * A piece whose rank the view does not disclose is treated as if it might be the
 * flag. During play a side always sees its own 兵種, so this never fires; if it
 * ever did — a degraded or mis-scoped view — the bot would freeze rather than
 * risk the one move that loses instantly.
 */
function movesTheFlag(view: ViewerState, color: Color, shape: MoveShape): boolean {
  for (const id of shape.relocations.keys()) {
    const piece = view.pieces.find((p) => p.id === id)
    if (!piece) return true
    if (piece.color !== color) return true
    if (piece.rank === null || piece.rank === 'flag') return true
  }
  return false
}

/**
 * Rule 3 — would this move step off a 結算格?
 *
 * Implied by `gain > 0` today: one mover can add at most one square, so a move
 * that vacates one nets zero at best, and 王車易位 happens on the back rank where
 * no 結算格 preset reaches. It is stated separately anyway, because the
 * implication runs through the arithmetic of `gainOf` — change that function and
 * the rule would disappear silently, which is exactly how a measuring instrument
 * starts lying.
 */
function vacatesScoring(view: ViewerState, color: Color, shape: MoveShape): boolean {
  const scoring = scoringSet(view)
  for (const p of ownPieces(view, color)) {
    if (p.square === null || !scoring.has(p.square)) continue
    const to = shape.relocations.get(p.id)
    if (to !== undefined && to !== p.square) return true
  }
  return false
}

/** Rule 2 — the change in 結算格 held, i.e. the change in income per settlement (§7). */
function gainOf(view: ViewerState, color: Color, shape: MoveShape, held: number): number {
  return heldScoringAfter(view, color, shape) - held
}

function chooseMove(view: ViewerState, color: Color, rng: Rng): Move {
  const moves = view.legalMoves
  if (!moves || moves.length === 0) return PASS

  const held = heldScoring(view, color)
  let best = 0
  let candidates: Move[] = []

  for (const move of moves) {
    if (move.kind === 'pass') continue
    const shape = shapeOfMove(view, color, move)
    if (!shape) continue
    if (initiatesContact(shape)) continue            // 1
    if (movesTheFlag(view, color, shape)) continue   // 4
    const gain = gainOf(view, color, shape, held)    // 2
    if (gain <= 0) continue                          // 5 — nothing improves
    if (vacatesScoring(view, color, shape)) continue // 3
    if (gain > best) {
      best = gain
      candidates = [move]
    } else if (gain === best) {
      candidates.push(move)
    }
  }

  // 5 — pass rather than move for the sake of moving. A pass still settles
  // (§7.1 「跳過回合（pass）仍然結算」), so standing still banks the full holding
  // and exposes nothing: no square vacated, no contact offered, no 軍旗 candidate
  // eliminated by winning a fight (notebook §1.3).
  if (candidates.length === 0) return PASS

  // Deterministic apart from the tie-break. Sorting on a canonical key first
  // means the draw depends on the seed and the position only — never on the
  // order `legalMoves` happened to arrive in.
  candidates.sort((a, b) => (moveKey(a) < moveKey(b) ? -1 : moveKey(a) > moveKey(b) ? 1 : 0))
  return rng.pick(candidates)
}

/**
 * Deployment: random, except that the 軍旗 is kept off the pieces this policy is
 * about to march into the centre.
 *
 * Random for the §9 reason — a fixed deployment is equivalent to publishing the
 * army — but not blindly random, because of rule 4. Dropping the 軍旗 on a piece
 * that was about to take a 結算格 costs that square for the entire game, and a
 * naive random deployment would therefore randomise the very quantity this
 * instrument was built to measure.
 *
 * The reservation covers PAWNS that can step onto a 結算格 — the d/e pawns on
 * 中央四格, plus the a/h pawns on 側翼八格. It is deliberately not exhaustive:
 * on the wide board the queen can also reach a flank square (self-play throws up
 * `1.h4 d5 2.e4 e5 3.Qd1-h5`, which denies Black a quarter of its income for the
 * rest of the game), and a bot cannot enumerate that from a ViewerState — move
 * generation lives behind `GameState`, and reimplementing sliding geometry here
 * would be a second rules engine. Pawns are the cases that always matter and the
 * only ones derivable from carrier and square alone.
 *
 * Reading carrier and square is not peeking: both layers are public (§1), and it
 * only looks at its own side. Everything else stays uniform, and if a config
 * leaves no unreserved slot the reservation is dropped rather than producing an
 * invalid deployment.
 */
function chooseDeployment(view: ViewerState, color: Color, rng: Rng): Record<PieceId, Rank> {
  const ids = ownPieceIds(view, color)
  const byId = new Map<PieceId, ViewerPiece>(ownPieces(view, color).map((p) => [p.id, p]))
  const scoring = scoringSet(view)

  const pool = rankPool(view)
  const flags = pool.filter((r) => r === 'flag')
  const rest = pool.filter((r) => r !== 'flag')

  const isMobile = (id: PieceId): boolean => {
    const piece = byId.get(id)
    return piece !== undefined && pawnReachesScoring(piece, scoring)
  }
  const reserved = shuffled(ids.filter((id) => !isMobile(id)), rng)
  const spare = shuffled(ids.filter((id) => isMobile(id)), rng)

  const hosts = reserved.slice(0, flags.length)
  if (hosts.length < flags.length) hosts.push(...spare.slice(0, flags.length - hosts.length))

  const taken = new Set(hosts)
  const others = ids.filter((id) => !taken.has(id))
  const shuffledRest = shuffled(rest, rng)

  const out: Record<PieceId, Rank> = {}
  hosts.forEach((id) => { out[id] = 'flag' })
  others.forEach((id, i) => {
    const rank = shuffledRest[i]
    if (rank !== undefined) out[id] = rank
  })
  return out
}

export function makeGreedyPolicy(name = 'greedy'): Policy {
  return { name, deploy: chooseDeployment, move: chooseMove }
}

export const greedyPolicy: Policy = makeGreedyPolicy()
