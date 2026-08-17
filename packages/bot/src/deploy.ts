/**
 * 佈署 (§9) that plays the 攻略 instead of rolling dice.
 *
 * ---------------------------------------------------------------------------
 * Why a deployment policy is worth writing at all
 * ---------------------------------------------------------------------------
 *
 * Notebook §9.5 lists it as the arena's biggest blind spot in one line:
 * 「佈署為均勻隨機——真人不會（見 2.1 載體–先驗耦合）。因此這裡的**佈署層資訊博弈
 * 完全沒有被測到**。」 Every existing policy (`random`, `greedy`, `contest`) deals
 * its 16 兵種 uniformly over its 16 載體, so half the game — the half that is
 * decided before the first ply and cannot be revised afterwards — has never been
 * measured against anything but noise.
 *
 * This module is the other half. It reads 攻略 §9 (軍旗放哪裡), §5 (爆裂物的載體),
 * §7 (司令的鏡像交換) and §8 (工兵), all of which say the same structural thing
 * from four directions: **兵種 and 載體 do not decouple in the inference layer**
 * (notebook §2), so which carrier a 兵種 rides is itself information, given away
 * for free at setup and never recoverable.
 *
 * ---------------------------------------------------------------------------
 * The five rules, and where each one lives below
 * ---------------------------------------------------------------------------
 *
 *   1. 軍旗 never on the queen ............ `FLAG_WEIGHTS.queen === 0`
 *   2. 軍旗 prefers a knight .............. `FLAG_WEIGHTS.knight`, the modal weight
 *   3. 爆裂物 never on a rook .............. `BOMB_WEIGHTS.rook === 0`
 *   4. 軍旗 never on a pawn about to march . `Doctrine.marching`, weight 0
 *   5. 工兵 spread, never clustered ........ `spread: true` + `minSeparation`
 *
 * ---------------------------------------------------------------------------
 * Why WEIGHTS and not a priority list
 * ---------------------------------------------------------------------------
 *
 * §9 requires a deployment to be random: 「配置必須為隨機，不得為固定的預設值——
 * 固定值等同公開該方全軍。」 A strict preference order satisfies the letter of
 * every rule above and violates that sentence completely — "the 軍旗 is on a
 * knight" is as good as publishing it, and worse than uniform random, because an
 * opponent who has read the same 攻略 gets the answer for nothing.
 *
 * So each doctrine is a WEIGHT over carriers, not a ranking. A weight of 0 is a
 * ban (rule 1, 3, 4); everything else is a bias. The 軍旗 rides a knight about a
 * third of the time on the standard table — the modal carrier by a wide margin,
 * which is what 「prefer」 means, and nowhere near a certainty, which is what §9
 * demands. Two seeds produce two different armies, and a hundred games produce a
 * distribution rather than an opening book.
 *
 * ---------------------------------------------------------------------------
 * Hidden information
 * ---------------------------------------------------------------------------
 *
 * Nothing here reads a 兵種, not even its own: during 佈署 `stateForViewer`
 * returns `rank: null` for every piece on the board including the caller's own
 * (§10.1 「佈署前不公開」 — the engine's placeholders are nobody's army). The only
 * inputs are the PUBLIC 載體層 (§1: carrier and square, 雙方公開), this side's own
 * piece ids, and `view.config` — the 結算格 shape and the 數量表, both 附錄 B
 * tunables that are shown to both players before the game starts.
 *
 * It never looks at the opponent's half of `view.pieces` for anything but
 * ignoring it: `ownPieces` filters by colour on the way in, and the opponent has
 * not deployed yet in any case (佈署 is simultaneous, §9).
 *
 * Determinism: every draw comes from the `Rng` handed in. No `Math.random`, no
 * clock, no module-level mutable state — same seed, same army, byte for byte.
 * Candidate lists are sorted by piece id before any draw, so the result cannot
 * depend on the order the payload happened to arrive in.
 */

import { fileOf } from '@xiyang/rules'
import type { Carrier, Color, PieceId, Rank, ViewerPiece, ViewerState } from '@xiyang/rules'

import type { Rng } from './prng.js'
import {
  ownPieceIds,
  ownPieces,
  pawnReachesScoring,
  rankPool,
  scoringSet,
  shuffled,
} from './policy.js'

// ---------------------------------------------------------------------------
// The doctrine tables
//
// One `Record<Carrier, number>` per 兵種 that has an argument attached to it in
// the 攻略. They are exported and frozen so a reader can check the bans by
// inspection (`FLAG_WEIGHTS.queen === 0`) and an experiment can quote them.
//
// Relative magnitudes are what matter; the absolute scale is arbitrary.
// ---------------------------------------------------------------------------

/**
 * 軍旗 (攻略 §9, notebook §2.1–2.2).
 *
 * **queen = 0 is the load-bearing entry.** 工兵配 queen 在任何合理配置下皆屬浪費
 * (§2.1: 無攻擊價值、免疫為被動、不需機動性), so a 有煙無傷 on a queen is not a
 * smoke screen — the posterior collapses onto 軍旗 almost immediately. That makes
 * 「queen 旗為最脆弱的配置，而非最強」: the opponent buys a near-certain answer for
 * one 爆裂物, and a located 軍旗 can neither hide forever nor hit back (階級 10 is
 * the floor of the ladder, §2).
 *
 * **knight is the modal carrier** (§2.2 燈下黑的最佳載體是 knight): it jumps, it
 * reroutes around a blockade, it RETREATS — the three things a pawn cannot do —
 * and it reads as a minor piece, so nobody spends a 爆裂物 probing it.
 *
 * bishop / rook / king sit between: all three retreat and reroute, and a rook has
 * the trick 攻略 §11 points out — 王車易位 is the only move that relocates two
 * pieces at once and it has no check restriction here (§3②), so a 軍旗 rook can
 * be teleported off a threatened file in one ply. They rank under the knight
 * because a 工兵 on a rook is already a slightly wasteful placement, which tips
 * a 有煙無傷 there towards 軍旗 by the same §2.1 argument that condemns the queen,
 * only far more weakly.
 *
 * pawn stays in the mix at a real weight: 「pawn 旗的低關注度在此框架下更值錢——
 * 沒人會為試探一顆 pawn 而燒掉一顆爆裂物」 (§2.1). Its cost is that it cannot
 * retreat, so being identified is being dead (§2.2).
 */
export const FLAG_WEIGHTS: Readonly<Record<Carrier, number>> = Object.freeze({
  knight: 8,
  bishop: 4,
  rook: 4,
  king: 4,
  pawn: 2,
  queen: 0,   // §2.1 — never. The one placement the opponent can buy outright.
})

/**
 * 爆裂物 (攻略 §5, notebook §2.3).
 *
 * **rook = 0 is the load-bearing entry**, and it is the only entry in this file
 * backed by measurement rather than derivation. Notebook §2.3 is 「實測中最重要的
 * 發現，且原始設計文件完全沒有提到」, observed twice: a rook 爆裂物 is expensive AND
 * undeliverable for the opening ten plies — 「被自己的兵擋死，開線公開且緩慢」 — so
 * White spent seven plies walking one to a target that had been dead for eight.
 * 「打得贏」不等於「打得到」.
 *
 * pawn and knight carry it because they are the two 高早期可送達性 rows of the same
 * table: a pawn threatens from where it stands (原地即威脅) and is cheap enough to
 * lose, and a knight jumps the unopened pawn line. bishop keeps a thin tail
 * (中 — 需開一條斜線): the point of a tail is that 「the 爆裂物 is on a pawn or a
 * knight」 must not be a free deduction, which would hand the opponent the §9
 * gift this whole module exists to avoid.
 *
 * queen = 0 for cost rather than reach — §2.3b watched a queen 爆裂物, the best
 * carrier on the board, still fail to catch a 司令 that kept moving, and the
 * queen is wanted for the 司令 itself (see `COMMANDER_WEIGHTS`).
 */
export const BOMB_WEIGHTS: Readonly<Record<Carrier, number>> = Object.freeze({
  pawn: 6,
  knight: 6,
  bishop: 1,
  king: 0,
  queen: 0,
  rook: 0,    // §2.3 — never. Expensive and undeliverable, measured twice.
})

/**
 * 工兵 (攻略 §8, notebook §4.5).
 *
 * 「你有幾顆工兵，就等於你能安全猜幾次」 — the 工兵 is the ONLY piece that can walk
 * into a suspected 爆裂物 and come back (§5.4, immunity in both directions). That
 * makes each one a probe, and a probe is worth exactly as much as the part of the
 * board it can reach, which is why these are spread by file rather than merely
 * weighted (see `spread` below). Two 工兵 stacked on b2 and c2 are one probe with
 * a spare, not two probes.
 *
 * A pawn that can step onto a 結算格 this ply gets a BONUS instead of the penalty
 * the 軍旗 gets there, because 攻略 §8② is the other half of the 工兵's job:
 * 「工兵免疫，所以工兵蹲在計分格上，對手只能用真正的階級攻擊來處理」. The cheapest way
 * to evict a piece from a 結算格 is to trade a 爆裂物 into it, and a 工兵 is the one
 * tenant that cannot be evicted that way.
 *
 * queen = 0: this is the placement §2.1 calls a waste, and making it never happen
 * is what keeps the 軍旗 doctrine above honest — a side that would not put a 工兵
 * on a queen must not put its 軍旗 there either.
 */
export const ENGINEER_WEIGHTS: Readonly<Record<Carrier, number>> = Object.freeze({
  pawn: 6,
  knight: 3,
  bishop: 2,
  rook: 1,
  king: 1,
  queen: 0,   // §2.1 — the wasted placement. Never generate the pattern.
})

/** Bonus weight for a 工兵 on a pawn that can step onto a 結算格 (攻略 §8② 防爆佔格). */
export const ENGINEER_SQUATTER_WEIGHT = 9

/**
 * 司令 (攻略 §7, notebook §2.4).
 *
 * 「攜帶你司令的那顆載體，同時也是你對付對方司令的答案。」 Each side has exactly one
 * 司令, so 司令 against 司令 is a guaranteed 同階雙亡 — the only DETERMINISTIC answer
 * to a revealed 司令 that exists, where a 爆裂物 is merely probabilistic. But the
 * answer has to be delivered: 「司令放 queen 上，你隨時可以換掉對方翻明的司令；司令放
 * pawn 上，你就只能看著」.
 *
 * A soft preference, not a rule. It is also the most STEREOTYPED placement in the
 * game — an opponent who has read the same page suspects the queen first — so the
 * weight is a lean, not a habit, and the rooks, bishops and knights between them
 * outweigh it.
 */
export const COMMANDER_WEIGHTS: Readonly<Record<Carrier, number>> = Object.freeze({
  queen: 6,
  rook: 3,
  bishop: 3,
  knight: 3,
  king: 2,
  pawn: 1,
})

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The four 兵種 this module has an opinion about. */
export type DoctrineKey = 'flag' | 'bomb' | 'engineer' | 'commander'

export interface DeploymentOptions {
  /**
   * Turn individual doctrines off. A 兵種 whose doctrine is `false` is placed
   * uniformly at random with everything else.
   *
   * This exists for one reason, and notebook §6.6 is the reason: 「兩局之間同時
   * 改變了三件事」, which is why two conclusions had to be reversed. Asking 「how
   * much is the 軍旗 rule worth?」 means running informed-vs-informed with
   * `{ flag: false }` on one side and NOTHING else different — one variable at a
   * time, which the arena's per-side seed streams already guarantee for the moves.
   *
   * Omitted keys default to on.
   */
  readonly doctrine?: Partial<Record<DoctrineKey, boolean>>
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Everything a weight function may consult, all of it derived from public layers. */
interface Context {
  /**
   * Pawns that can step onto a 結算格 this ply — the d/e pawns on 中央四格, plus
   * the a/h pawns on 側翼八格 (§7.2 is a 附錄 B setting, so this is read from
   * `config.scoringSquares` and never from a constant).
   *
   * Deliberately pawns only, exactly as `greedy`'s deployment is: a bot cannot
   * enumerate 「which piece will this policy march where」 from a ViewerState —
   * move generation lives behind `GameState` and reimplementing sliding geometry
   * here would be a second rules engine (techspec §7). Pawns are the cases that
   * always matter and the only ones derivable from carrier and square alone.
   */
  readonly marching: ReadonlySet<PieceId>
}

interface Doctrine {
  readonly key: DoctrineKey
  readonly rank: Rank
  /**
   * Keep hosts of this 兵種 apart by file.
   *
   * For 工兵 it is the point of the piece (攻略 §8① — a probe is worth its reach).
   * For 爆裂物 it is §2.3b restated: both playtest failures were a correct answer
   * that could not travel, and two 爆裂物 in the same corner are one answer with a
   * spare. Spreading them means whichever wing a target reveals on, one of them
   * starts near it.
   */
  readonly spread: boolean
  weight(piece: ViewerPiece, ctx: Context): number
}

/**
 * The order placements are decided in — most constrained first.
 *
 * 軍旗 leads because misplacing it loses the game outright (§7①) and its ban list
 * is the tightest; 爆裂物 next because deliverability is the one finding here that
 * came out of real games; 工兵 next because spreading needs room; 司令 last,
 * because it is a lean rather than a rule and can take whatever is left.
 */
const DOCTRINES: readonly Doctrine[] = [
  {
    key: 'flag',
    rank: 'flag',
    spread: false,
    weight: (piece, ctx) => (ctx.marching.has(piece.id) ? 0 : FLAG_WEIGHTS[piece.carrier]),
  },
  {
    key: 'bomb',
    rank: 'bomb',
    spread: true,
    weight: (piece) => BOMB_WEIGHTS[piece.carrier],
  },
  {
    key: 'engineer',
    rank: 'engineer',
    spread: true,
    weight: (piece, ctx) =>
      piece.carrier === 'pawn' && ctx.marching.has(piece.id)
        ? ENGINEER_SQUATTER_WEIGHT
        : ENGINEER_WEIGHTS[piece.carrier],
  },
  {
    key: 'commander',
    rank: 'commander',
    spread: false,
    weight: (piece) => COMMANDER_WEIGHTS[piece.carrier],
  },
]

/**
 * File distance between two pieces; 0 when either is not on the board.
 *
 * Files, not squares. 佈署 happens on the opening position, where every piece of
 * one colour sits on one of two adjacent ranks — the only axis along which two
 * hosts can be meaningfully far apart is the file, and the file is also what
 * decides which side of the board a piece can influence in the opening plies.
 */
function separation(a: ViewerPiece, b: ViewerPiece): number {
  if (a.square === null || b.square === null) return 0
  return Math.abs(fileOf(a.square) - fileOf(b.square))
}

/**
 * How far this candidate sits from the nearest host already chosen for this 兵種.
 *
 * Zero for a candidate on the same file as one of them, which is what makes the
 * multiplier in `pickHosts` a same-file ban rather than a mere discount.
 */
function minSeparation(piece: ViewerPiece, chosen: readonly ViewerPiece[]): number {
  let best = Infinity
  for (const other of chosen) best = Math.min(best, separation(piece, other))
  return best === Infinity ? 0 : best
}

/**
 * Draw one candidate with probability proportional to its weight, relaxing down
 * a ladder of weight functions until one of them has something positive to say.
 *
 * `candidates` must already be in a stable order (piece id), because that order
 * is what the integer draw indexes into — otherwise the same seed would produce
 * different armies on hosts that enumerate the payload differently.
 *
 * The ladder is how a preference stays a preference and a ban stays a ban. The
 * caller passes the strictest reading first (doctrine × geometry), then the
 * doctrine alone; a rung that zeroes out every remaining candidate is skipped
 * rather than obeyed. The last resort is a UNIFORM draw, which can violate a ban
 * — reachable only on a 數量表 that leaves no legal alternative, since the bans
 * above still leave ten or more hosts on the standard, 偵察兵 and 高階雙份 tables.
 * Legality outranks doctrine: an invalid assignment is refused by
 * `validateAssignment` and then there is no game at all.
 */
function weightedPick(
  candidates: readonly ViewerPiece[],
  ladder: readonly ((piece: ViewerPiece) => number)[],
  rng: Rng,
): ViewerPiece {
  for (const weightOf of ladder) {
    const weights = candidates.map((p) => Math.max(0, Math.floor(weightOf(p))))
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) continue

    let draw = rng.int(total)
    for (let i = 0; i < candidates.length; i++) {
      draw -= weights[i]!
      if (draw < 0) return candidates[i]!
    }
    return candidates[candidates.length - 1]!
  }
  return rng.pick(candidates)
}

/**
 * Choose `n` hosts for one 兵種, removing each from `remaining` as it is taken.
 *
 * With `spread`, every host after the first has its weight MULTIPLIED by its file
 * distance from the hosts already chosen — zero on the same file, so two 工兵 or
 * two 爆裂物 never share one — and the doctrine weights are then tried again on
 * their own if that leaves nothing. Distance and doctrine argue with each other
 * rather than one silencing the other.
 *
 * The obvious implementation — restrict to the candidates at maximum distance,
 * then draw by weight — was tried first and is wrong, in a way worth recording.
 * The argmax set is almost always ONE file, an outside file at that, and the two
 * pieces on an outside file are a rook and a pawn; with the 爆裂物 (also spread,
 * also fond of pawns) having eaten the pawn first, the only candidate left at
 * maximum distance is the rook. Measured over 800 deployments: 34% of 工兵 landed
 * on a rook, having been walked there by a rule that says nothing about rooks.
 * A hard geometric filter overrides every weight in the file, bans included.
 *
 * Multiplying keeps the bans intact (0 × anything is 0) and keeps the carrier
 * argument alive: a pawn four files away still outdraws a rook seven files away.
 */
function pickHosts(
  doctrine: Doctrine,
  n: number,
  remaining: ViewerPiece[],
  ctx: Context,
  rng: Rng,
): ViewerPiece[] {
  const chosen: ViewerPiece[] = []

  const doctrinal = (piece: ViewerPiece): number => doctrine.weight(piece, ctx)
  const spreadOut = (piece: ViewerPiece): number =>
    doctrinal(piece) * minSeparation(piece, chosen)

  for (let k = 0; k < n && remaining.length > 0; k++) {
    const ladder = doctrine.spread && chosen.length > 0 ? [spreadOut, doctrinal] : [doctrinal]
    const host = weightedPick(remaining, ladder, rng)
    chosen.push(host)
    remaining.splice(remaining.indexOf(host), 1)
  }

  return chosen
}

// ---------------------------------------------------------------------------
// The deployment
// ---------------------------------------------------------------------------

/**
 * A legal §9 deployment that follows the 攻略 rather than the dice.
 *
 * Returns a bijection from this side's 16 載體 onto `view.config.distribution` —
 * the game's OWN 數量表, never the module constant, because 兵種數量配置 is a 附錄 B
 * tunable and the 偵察兵 preset deals four 工兵. Everything not covered by a
 * doctrine is dealt uniformly over what is left, which is not laziness: the
 * 兵種 nobody has an argument about must carry no signal either, or the doctrine
 * would leak through the pieces it does not mention.
 *
 * Shape of the result is identical to `randomAssignment`'s, so it drops into any
 * `Policy.deploy` (see `makeInformedDeploy`).
 */
export function informedDeployment(
  view: ViewerState,
  color: Color,
  rng: Rng,
  opts: DeploymentOptions = {},
): Record<PieceId, Rank> {
  // Sorted ids, so nothing below depends on the order `view.pieces` arrived in.
  const ids = ownPieceIds(view, color)
  const byId = new Map<PieceId, ViewerPiece>(ownPieces(view, color).map((p) => [p.id, p]))

  const scoring = scoringSet(view)
  const marching = new Set<PieceId>()
  for (const id of ids) {
    const piece = byId.get(id)
    if (piece && pawnReachesScoring(piece, scoring)) marching.add(id)
  }
  const ctx: Context = { marching }

  const remaining: ViewerPiece[] = []
  for (const id of ids) {
    const piece = byId.get(id)
    if (piece) remaining.push(piece)
  }

  // The 數量表 as 16 individual 兵種. Ranks come out of here and go onto pieces;
  // when it is empty the deployment is complete and exactly uses up the table.
  const unplaced: Rank[] = rankPool(view)
  const out: Record<PieceId, Rank> = {}

  for (const doctrine of DOCTRINES) {
    if (opts.doctrine?.[doctrine.key] === false) continue
    const wanted = unplaced.filter((r) => r === doctrine.rank).length
    if (wanted === 0) continue

    const hosts = pickHosts(doctrine, Math.min(wanted, remaining.length), remaining, ctx, rng)
    for (const host of hosts) {
      out[host.id] = doctrine.rank
      const at = unplaced.indexOf(doctrine.rank)
      if (at >= 0) unplaced.splice(at, 1)
    }
  }

  // Everything with no argument attached to it, dealt uniformly (§9 隨機).
  const rest = shuffled(unplaced, rng)
  remaining.forEach((piece, i) => {
    const rank = rest[i]
    if (rank !== undefined) out[piece.id] = rank
  })

  return out
}

/**
 * Bind options once and hand back something with a `Policy['deploy']` shape.
 *
 * `informedDeployment` takes a fourth argument, which `Policy.deploy` does not,
 * so an experiment that wants `{ doctrine: { flag: false } }` on one side wraps
 * it here rather than teaching the harness about deployment options.
 */
export function makeInformedDeploy(
  opts: DeploymentOptions = {},
): (view: ViewerState, color: Color, rng: Rng) => Record<PieceId, Rank> {
  return (view, color, rng) => informedDeployment(view, color, rng, opts)
}
