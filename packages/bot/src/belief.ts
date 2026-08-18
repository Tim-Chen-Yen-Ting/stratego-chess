/**
 * The belief state — everything a bot is ALLOWED to think it knows about the
 * enemy army, and nothing more.
 *
 * ---------------------------------------------------------------------------
 * The input is a ViewerState. That is the whole of it.
 * ---------------------------------------------------------------------------
 *
 * `policy.ts` states the rule; this file is where it would be tempting to break
 * it, so it is worth restating. Everything below is computed from
 *
 *   · `view.pieces` — the carrier layer, which is public (§1), plus whatever
 *     兵種 the redaction layer chose to disclose: 翻明 winners (§4.3) and, once
 *     the game is over, everybody (§10.5);
 *   · `view.log` — the public 事件紀錄 (§10.3), replayed forward from the fixed
 *     §9 opening layout so that a square in an event can be turned back into the
 *     piece standing on it;
 *   · `view.config.distribution` — the 數量表 this game was created with (附錄 B).
 *
 * There is no import of `GameState`, no `entitledToRank`, no access to any
 * side's hidden assignment. What comes out is exactly what §10.3 calls 推論輔助
 * — 「其輸出完全由公開資訊推得」— which the gamebook is happy to hand a
 * spectator and refuses to render for a player. A bot computing it for itself is
 * the same act as a human keeping notes, which §10.4 explicitly permits.
 *
 * ---------------------------------------------------------------------------
 * Why particles and not algebra
 * ---------------------------------------------------------------------------
 *
 * The posterior is a distribution over BIJECTIONS: every consistent deployment
 * of the 16 兵種 onto the 16 enemy carriers. For the standard table that is
 *
 *     16! / (1!·1!·1!·2!·2!·2!·1!·1!·2!·1!·2!) = 16!/32 ≈ 6.5 × 10^11
 *
 * assignments, and the interesting facts do not factorise over pieces: 「這一顆
 * 是工兵」 and 「那一顆是工兵」 compete for the same two tokens, which is exactly
 * what notebook §1.2 means by 確定性會沿階梯往上爬 — 「此集合隨場上兵種被指認而
 * 收窄」. A per-piece candidate SET can be maintained analytically (that is all
 * §10.3's solver promises a spectator); a per-piece PROBABILITY cannot, because
 * the coupling runs through the shared pool.
 *
 * So: draw N whole deployments that satisfy every public fact at once, and read
 * the marginals off the sample. Every particle is a legal deployment, therefore
 * every marginal is automatically consistent with the pool, and the sum of a
 * rank's probability over all 16 enemy pieces is exactly its configured count.
 *
 * ---------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------
 *
 * `Math.random` appears nowhere. Every draw comes from the seeded `Rng` the
 * caller threads in, including the sampler's, so a game replays byte for byte —
 * which is the entire reason `prng.ts` exists (see its header). Iteration order
 * is pinned everywhere it could vary: pieces are walked in sorted id order,
 * ranks in `ALL_RANKS` order, and the sampler's most-constrained-first tie-break
 * falls back to that same id order rather than to map insertion order.
 */

import {
  ALL_RANKS,
  BOMB_IMMUNE,
  RANK_ORDER,
  STARTING_LAYOUT,
  castlePlan,
  forwardDir,
  opposite,
  rankOf,
  resolveCombat,
  startingSlot,
} from '@xiyang/rules'
import type {
  Carrier,
  Color,
  CombatOutcome,
  PieceId,
  Rank,
  Square,
  ViewerState,
} from '@xiyang/rules'
import type { Rng } from './prng.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One enemy piece's posterior: a probability per 兵種, over `ALL_RANKS`, summing
 * to 1. A 翻明 piece is a point mass (§4.3) and needs no special case anywhere
 * downstream — it is simply a distribution that happens to be certain.
 */
export type RankBelief = Readonly<Record<Rank, number>>

/** The whole enemy army, by piece id. */
export type Belief = Map<PieceId, RankBelief>

/**
 * What the public record says about one enemy piece.
 *
 * Split out from the belief itself because these are FACTS — a candidate set and
 * a movement history, both derivable by any spectator — whereas the belief is an
 * estimate built on top of them plus a prior. Keeping them apart is what makes
 * the prior measurable: turn it off and the facts are unchanged.
 */
export interface EnemyFacts {
  readonly id: PieceId
  /**
   * The 載體 this piece was DEPLOYED on (§9), not the one it carries now.
   *
   * 升變 changes the carrier layer and nothing else (§1, §6), so a promoted pawn
   * is a queen on the board but was a pawn when its owner chose what 兵種 to put
   * on it. Every carrier-based prior below is about that CHOICE, so it has to
   * read the choice's carrier — notebook §2.5 makes the same point from the
   * other side: a promoted queen is precisely the piece whose 兵種 you cannot
   * guess from its carrier.
   */
  readonly deployedAs: Carrier
  /** where it stands now, or null once removed */
  readonly square: Square | null
  /** the 兵種 the ViewerState discloses — 翻明 (§4.3) or 終局 (§10.5) — else null */
  readonly disclosed: Rank | null
  /** every 兵種 this piece could still be, in `ALL_RANKS` order */
  readonly allowed: readonly Rank[]
  /** why the set is what it is; one line per fact that narrowed it */
  readonly reasons: readonly string[]
  /** how many times this piece has moved, per the log */
  readonly movesMade: number
  /** the ply of its last move, or null if it has never moved */
  readonly lastMovedPly: number | null
  /** has it ever stood on one of THIS game's 結算格 (附錄 B)? */
  readonly everOnScoringSquare: boolean
  /** the furthest it has ever been from its own back rank, in ranks */
  readonly maxAdvance: number
}

/**
 * The behavioural prior — the layer that separates a bot from a constraint
 * solver, and the layer most likely to be wrong.
 *
 * Uniform-over-consistent is not the absence of an assumption. It is the
 * assumption that the opponent deployed by dice roll, and notebook §2.1 spends a
 * section arguing that nobody does: 「規則層兩層解耦，推論層與執行層都不解耦」.
 * Every constant below is one of those arguments, priced.
 *
 * All of them are MULTIPLIERS on a particle's weight, applied per piece and per
 * assigned 兵種; 1 means "no opinion". They are exposed, named and switchable
 * (`BeliefOptions.behavioural`) for one reason: an unmeasured prior is a story.
 * Run the arena with it off and with it on, and the difference is a number.
 *
 * A caveat that belongs on the tin: these model a THINKING opponent. Against
 * `random` — which deploys uniformly, exactly the straw man §2.1 attacks — the
 * prior is actively wrong and should cost the bot something. That is not a bug
 * in the prior, it is the measurement working.
 */
export interface BehaviouralWeights {
  /**
   * 軍旗 on a piece deployed as a queen.
   *
   * Notebook §2.1 / 攻略 §9: 「queen 旗——最脆弱，不是最強」. A 有煙無傷 on a queen
   * is close to a name badge, because 工兵 on a queen is a waste nobody commits,
   * so the opponent buys near-certainty for one 爆裂物. A competent deployer
   * avoids it; a random one does not, which is what makes this constant a test
   * of the opponent model rather than of the rules.
   */
  readonly flagOnQueen: number
  /**
   * 工兵 on a piece deployed as a queen — the other half of the same argument
   * (§2.1: 無攻擊價值、免疫為被動、不需機動性). Down-weighting BOTH is what keeps
   * the 有煙無傷 ambiguity of 附錄 A(a) from being decided by the carrier alone.
   */
  readonly engineerOnQueen: number
  /**
   * Ceiling of the bonus applied to 軍旗 on a piece that has never moved.
   *
   * 「保護軍旗的最佳方式因此是『什麼仗都不打』」 (notebook §1.3), and §5.1 records
   * the one real 奪旗 in six games landing on a bishop's home square that had not
   * moved all game. The bonus ramps rather than jumping, because at ply 2 almost
   * nothing has moved and the observation is worth nothing.
   */
  readonly flagUnmovedMax: number
  /** Full turns of sitting still at which `flagUnmovedMax` is reached. */
  readonly flagUnmovedTurns: number
  /**
   * Applied once per rank of forward progress the piece has ever made.
   *
   * A 軍旗 marching up the board is a piece being walked towards the one event
   * that loses the game outright (§7.5①), and 攻略 §9 is blunt about it: 「絕對不要
   * 拿軍旗去撞任何東西」. Below 1, so advance is evidence AGAINST 軍旗; mild,
   * because a pawn 旗 that stepped once is a real and recommended deployment.
   */
  readonly flagPerRankAdvanced: number
  /**
   * Applied when the piece has ever stood on a 結算格.
   *
   * The strongest behavioural signal on the board and the cheapest to read.
   * A 結算格 is where the opponent's pieces come to take your income off you
   * (攻略 §4之二), so parking the one piece that cannot afford a fight there is a
   * plan nobody has. Much stronger than mere advance, hence its own constant.
   */
  readonly flagOnScoringSquare: number
}

/**
 * Defaults. Deliberately round numbers: they are priors, not measurements, and
 * printing 0.3 rather than 0.2887 stops anyone reading them as fitted.
 */
export const DEFAULT_BEHAVIOURAL_WEIGHTS: BehaviouralWeights = {
  flagOnQueen: 0.3,
  engineerOnQueen: 0.3,
  flagUnmovedMax: 2.5,
  flagUnmovedTurns: 16,
  flagPerRankAdvanced: 0.75,
  flagOnScoringSquare: 0.15,
}

/**
 * ~200 particles. Enough that a 1-in-16 marginal has a standard error near 0.017
 * — finer than any decision a 1-ply policy makes off it — and cheap enough to
 * run every ply of a thousand-game arena.
 */
export const DEFAULT_SAMPLES = 200

/**
 * Redraws allowed per particle before it is abandoned.
 *
 * The sampler can paint itself into a corner (see `drawAssignment`), and the
 * cure is to throw the particle away and start it again. The cap is what makes
 * that a bounded operation rather than a hang — a policy that spins forever on
 * one ply is worse than a policy with a slightly noisy belief.
 */
export const DEFAULT_ATTEMPTS_PER_SAMPLE = 8

export interface BeliefOptions {
  /** particles to draw. Default {@link DEFAULT_SAMPLES}. */
  readonly samples?: number
  /** apply the behavioural prior at all. Default true. */
  readonly behavioural?: boolean
  /** override individual {@link BehaviouralWeights}; the rest keep their defaults */
  readonly weights?: Partial<BehaviouralWeights>
  /** redraws per particle. Default {@link DEFAULT_ATTEMPTS_PER_SAMPLE}. */
  readonly attemptsPerSample?: number
}

/**
 * How much of the evidence survived into the sample.
 *
 * A legal game always yields `'none'`. The other two are safety valves for a
 * self-contradictory record — which would be a bug in the extraction below, not
 * a position — and they exist so that the failure degrades into a vaguer belief
 * instead of a thrown exception in the middle of a thousand-game run.
 */
export type Relaxation = 'none' | 'derived-dropped' | 'pool-only'

export interface BeliefSample {
  readonly assignment: ReadonlyMap<PieceId, Rank>
  /** the behavioural weight; 1 for every particle when the prior is off */
  readonly weight: number
}

export interface BeliefSamples {
  readonly facts: ReadonlyMap<PieceId, EnemyFacts>
  readonly samples: readonly BeliefSample[]
  /** draws attempted, successful or not — a dead-end rate, for diagnostics */
  readonly attempts: number
  readonly relaxation: Relaxation
}

// ---------------------------------------------------------------------------
// The public record, replayed
// ---------------------------------------------------------------------------

const RANK_INDEX: Readonly<Record<Rank, number>> = (() => {
  const out = {} as Record<Rank, number>
  ALL_RANKS.forEach((r, i) => { out[r] = i })
  return out
})()

/** 階級 comparison over the union, with 爆裂物 answering false to everything (§2). */
function isWeakerThan(candidate: Rank, winner: Rank): boolean {
  if (candidate === 'bomb' || winner === 'bomb') return false
  return RANK_ORDER[candidate] > RANK_ORDER[winner]
}

/**
 * The candidate set for a piece that LOST a decisive contact to a 翻明 winner of
 * rank `winner` — notebook §1.2's (R, 工兵].
 *
 * Three exclusions, and each is a rule rather than a guess:
 *
 *  · anything at or above `winner`, by §2 一律大吃小. This is the whole content
 *    of the announcement.
 *  · 爆裂物, because a 爆裂物 never loses a rank duel. Touching an ordinary 兵種
 *    removes both and announces 同歸於盡 (§4.3); touching 工兵/軍旗 makes it the
 *    loser but announces 有煙無傷 (§5.4). A decisive outcome therefore proves two
 *    階級 were compared, and 爆裂物 has none.
 *  · 軍旗, because 「軍旗以任何方式離開棋盤，該方立即判負」 (§5.3, §7.5①). Had the
 *    loser been the 軍旗 the game would have stopped on that ply; the game went
 *    on, so it was not. This is the inference notebook §1.2 turns into a
 *    certainty for 排長: below 排長(8) sit only 工兵(9) and 軍旗(10), and one of
 *    them is impossible.
 *
 * A game that ends ON this contact is the one case where the 軍旗 exclusion is
 * wrong — and it costs nothing, because §10.5 opens every 兵種 at 終局, so that
 * piece arrives disclosed and `enemyFacts` pins it to its disclosed rank without
 * ever consulting this set.
 */
function beatenBy(winner: Rank): Rank[] {
  return ALL_RANKS.filter((r) => r !== 'flag' && isWeakerThan(r, winner))
}

interface Track {
  movesMade: number
  lastMovedPly: number | null
  everOnScoringSquare: boolean
  maxAdvance: number
  /** null while nothing has narrowed this piece */
  allowed: Rank[] | null
  reasons: string[]
}

/**
 * Who is left standing after a contact, from the announcement alone.
 *
 * The same three-line reading `record.ts` does for the 棋譜, and for the same
 * reason: the log records SQUARES, so the board has to be walked forward to turn
 * one back into a piece. No 兵種 is read here — 同歸於盡 carries none by design
 * (§4.3), and the board is the same whichever of its three causes it was.
 */
function survivorOf(
  outcome: CombatOutcome,
  mover: Color,
  attacker: PieceId | undefined,
  defender: PieceId | undefined,
): PieceId | undefined {
  switch (outcome.kind) {
    case 'attacker-wins': return attacker
    case 'defender-wins': return defender
    case 'fizzle': return outcome.survivorColor === mover ? attacker : defender
    case 'mutual-destruction': return undefined
  }
}

/**
 * Walk the public log and produce, for every enemy piece, its candidate set and
 * its movement history.
 *
 * The replay starts from `STARTING_LAYOUT` — the fixed §9 opening position,
 * which is public and identical in every game — and a square can only be vacated
 * by the piece on it moving, so following the log forward identifies every piece
 * in every event without ever consulting a 兵種.
 */
export function enemyFacts(view: ViewerState, color: Color): Map<PieceId, EnemyFacts> {
  const enemy = opposite(color)
  const scoring = new Set<Square>(view.config.scoringSquares)

  const board = new Array<PieceId | undefined>(64)
  const track = new Map<PieceId, Track>()
  const homeRank = new Map<PieceId, number>()
  const colorOf = new Map<PieceId, Color>()

  for (const slot of STARTING_LAYOUT) {
    board[slot.square] = slot.id
    homeRank.set(slot.id, rankOf(slot.square))
    colorOf.set(slot.id, slot.color)
    track.set(slot.id, {
      movesMade: 0,
      lastMovedPly: null,
      everOnScoringSquare: scoring.has(slot.square),
      maxAdvance: 0,
      allowed: null,
      reasons: [],
    })
  }

  const moved = (id: PieceId | undefined, ply: number): void => {
    const t = id === undefined ? undefined : track.get(id)
    if (!t) return
    t.movesMade++
    t.lastMovedPly = ply
  }

  const landed = (id: PieceId | undefined, square: Square): void => {
    const t = id === undefined ? undefined : track.get(id)
    if (!t || id === undefined) return
    if (scoring.has(square)) t.everOnScoringSquare = true
    const home = homeRank.get(id)
    const side = colorOf.get(id)
    if (home !== undefined && side !== undefined) {
      const advance = (rankOf(square) - home) * forwardDir(side)
      if (advance > t.maxAdvance) t.maxAdvance = advance
    }
  }

  /** Intersect a piece's candidate set with `ranks`, keeping the log's order. */
  const narrow = (id: PieceId | undefined, ranks: readonly Rank[], why: string): void => {
    const t = id === undefined ? undefined : track.get(id)
    if (!t) return
    const next = t.allowed === null
      ? ALL_RANKS.filter((r) => ranks.includes(r))
      : t.allowed.filter((r) => ranks.includes(r))
    if (next.length === 0) {
      // Unreachable on a log the engine produced: two public facts about one
      // piece cannot contradict each other. Keeping the older set rather than
      // an empty one means a malformed record produces a vaguer belief instead
      // of a sampler that can never terminate.
      t.reasons.push(`contradiction ignored — ${why}`)
      return
    }
    t.allowed = next
    t.reasons.push(why)
  }

  for (const e of view.log) {
    if (e.move.kind === 'pass') continue

    if (e.move.kind === 'castle') {
      // §3② relocates two carriers and can make no contact. Both count as having
      // moved: this asks 「has this piece sat still all game」 for the 軍旗 prior,
      // not 「how many moves were made」 the way the 棋譜 counts them, and a rook
      // that has castled is emphatically not a piece that never budged.
      const plan = castlePlan(e.color, e.move.side)
      const king = board[plan.kingFrom]
      const rook = board[plan.rookFrom]
      board[plan.kingFrom] = undefined
      board[plan.rookFrom] = undefined
      board[plan.kingTo] = king
      board[plan.rookTo] = rook
      moved(king, e.ply)
      moved(rook, e.ply)
      landed(king, plan.kingTo)
      landed(rook, plan.rookTo)
      continue
    }

    const { from, to } = e.move
    const attacker = board[from]
    moved(attacker, e.ply)

    if (!e.combat) {
      board[from] = undefined
      board[to] = attacker
      landed(attacker, to)
      continue
    }

    const { outcome, attackerSquare, defenderSquare, survivorSquare } = e.combat
    const defender = board[defenderSquare]

    // §4.1 位置結算: a losing attacker is removed from the square it came FROM
    // and never enters the target, so clear every square the contact touched and
    // put back only the announced survivor. `to` is cleared as well because on an
    // en passant it is neither contact square (§4.2).
    board[from] = undefined
    board[attackerSquare] = undefined
    board[defenderSquare] = undefined
    board[to] = undefined
    const survivor = survivorOf(outcome, e.color, attacker, defender)
    if (survivor !== undefined && survivorSquare !== null) {
      board[survivorSquare] = survivor
      if (survivor === attacker) landed(attacker, survivorSquare)
    }

    switch (outcome.kind) {
      case 'attacker-wins':
        narrow(defender, beatenBy(outcome.winnerRank),
          `lost to a 翻明 ${outcome.winnerRank} at ply ${e.ply} (§4.3, §1.2)`)
        break
      case 'defender-wins':
        narrow(attacker, beatenBy(outcome.winnerRank),
          `lost to a 翻明 ${outcome.winnerRank} at ply ${e.ply} (§4.3, §1.2)`)
        break
      case 'fizzle': {
        // 有煙無傷 — the ONE contact that still identifies a 爆裂物 under v04
        // (§4.3: 爆裂物成功時無聲，失敗時自曝). It names two pieces at once: the
        // survivor is 工兵 or 軍旗 (§5.4, 附錄 A(a)), and the piece that lost is
        // the 爆裂物 itself, which is a pool constraint worth as much as the
        // ambiguity is worth information.
        const attackerSurvived = outcome.survivorColor === e.color
        const survived = attackerSurvived ? attacker : defender
        const bombed = attackerSurvived ? defender : attacker
        narrow(survived, BOMB_IMMUNE, `有煙無傷 survivor at ply ${e.ply} — 工兵 or 軍旗 (§5.4)`)
        narrow(bombed, ['bomb'], `有煙無傷 loser at ply ${e.ply} — the 爆裂物 (§5.4)`)
        break
      }
      case 'mutual-destruction':
        // Nothing. §4.3 makes 同階相遇, 爆裂物 vs 一般 and 爆對爆 one announcement
        // carrying no rank and no colour, so it says nothing about either piece's
        // 兵種. It still removes two pieces, which tightens everything else
        // through the shared pool — and that happens in the sampler, not here.
        break
    }
  }

  // ---- facts that come off the position rather than off an event -----------
  //
  // 「己方任何一顆棋子陣亡而遊戲繼續，該子必定不是軍旗」 (notebook §1.3, from §7.5①).
  // This is NOT an inference from any particular announcement — it applies to
  // every removal, 同歸於盡 included — which is why it is applied here, once,
  // over the final position rather than inside the switch above. It is also the
  // mechanism behind §1.3's harder line: 「贏一場仗就等於公開刪掉自己軍旗的一個
  // 候選位置」. The 軍旗 hiding-set only ever shrinks, and combat survival is
  // public.
  const gameOver = view.status.kind === 'over'
  const notFlag = ALL_RANKS.filter((r) => r !== 'flag')

  const out = new Map<PieceId, EnemyFacts>()
  const pieces = view.pieces.filter((p) => p.color === enemy).sort((a, b) => cmp(a.id, b.id))

  for (const piece of pieces) {
    const t = track.get(piece.id)
    if (!t) continue
    if (!gameOver && piece.square === null && piece.rank === null) {
      narrow(piece.id, notFlag, 'removed while the game continued — not the 軍旗 (§7.5①, §1.3)')
    }
    const slot = startingSlot(piece.id)
    out.set(piece.id, {
      id: piece.id,
      deployedAs: slot?.carrier ?? piece.carrier,
      square: piece.square,
      // 翻明 (§4.3) and 終局 (§10.5) arrive by the same door: the redaction layer
      // put a rank in the payload, so it is ours to read. Nothing else here does.
      disclosed: piece.rank,
      allowed: piece.rank !== null ? [piece.rank] : (t.allowed ?? ALL_RANKS),
      reasons: t.reasons,
      movesMade: t.movesMade,
      lastMovedPly: t.lastMovedPly,
      everOnScoringSquare: t.everOnScoringSquare,
      maxAdvance: t.maxAdvance,
    })
  }

  return out
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

interface Candidate {
  readonly id: PieceId
  /** allowed ranks as indices into ALL_RANKS, ascending */
  readonly allowed: number[]
  /** the same set as a bitmask, so "does this piece allow rank r" is one AND */
  readonly mask: number
}

/**
 * Draw one consistent deployment, or null if this attempt painted itself into a
 * corner.
 *
 * Most-constrained-first: at every step the piece with the fewest remaining
 * 兵種 tokens available to it is assigned next, and its rank is drawn from the
 * ranks it allows, WEIGHTED BY HOW MANY OF EACH ARE LEFT. Assigning the tightly
 * constrained pieces while the pool is still full is what keeps dead ends rare,
 * and weighting by the remaining counts is what makes a doubled 兵種 twice as
 * likely as a single one — the §2 table is the prior, so it has to be in the
 * draw and not bolted on afterwards.
 *
 * **This is close to uniform over consistent deployments, but it is NOT exactly
 * uniform, and nothing downstream should claim it is.** Sequential draws of this
 * shape are exact whenever the candidate sets nest (which the common cases do:
 * a set of unconstrained pieces plus a few tight ones), and biased by a small
 * amount when several partially-overlapping sets compete for the same tokens.
 * Making it exact would take an importance weight of 1/(proposal probability),
 * which is cheap to compute and expensive in variance — and would tangle with
 * the behavioural weights, which are a different quantity that must stay
 * separately measurable. The bias is far below the sampling noise of 200
 * particles, so it is documented rather than corrected.
 *
 * A returned null means this attempt dead-ended, not that the position is
 * impossible; the caller redraws, up to a bounded count.
 *
 * `tokens[i]` — how many 兵種 piece i could still take — is carried forward
 * rather than recomputed, because this runs sixteen times per particle, two
 * hundred particles per ply, forty plies per game and a thousand games per
 * experiment. Consuming one token of rank r lowers exactly the pieces that allow
 * r, which the bitmask answers in one AND. The arithmetic is identical to
 * re-summing, so the draw sequence — and therefore the replay — is unchanged.
 */
function drawAssignment(
  candidates: readonly Candidate[],
  counts: readonly number[],
  rng: Rng,
): Map<PieceId, Rank> | null {
  const n = candidates.length
  const remaining = counts.slice()
  const done = new Array<boolean>(n).fill(false)
  const tokens = new Array<number>(n).fill(0)
  const out = new Map<PieceId, Rank>()

  for (let i = 0; i < n; i++) {
    let t = 0
    for (const r of candidates[i]!.allowed) t += remaining[r]!
    tokens[i] = t
  }

  for (let step = 0; step < n; step++) {
    // MRV. Ties go to the lowest index, and `candidates` is in sorted id order,
    // so the walk is a pure function of the position.
    let best = -1
    let bestTokens = Infinity
    for (let i = 0; i < n; i++) {
      if (done[i]) continue
      if (tokens[i] === 0) return null
      if (tokens[i]! < bestTokens) {
        bestTokens = tokens[i]!
        best = i
      }
    }
    if (best < 0) return null

    const pick = candidates[best]!
    let x = rng.next() * bestTokens
    let chosen = -1
    for (const r of pick.allowed) {
      x -= remaining[r]!
      if (x < 0) {
        chosen = r
        break
      }
    }
    if (chosen < 0) {
      // Float dust only: `rng.next() < 1` guarantees x < bestTokens going in.
      for (const r of pick.allowed) if (remaining[r]! > 0) chosen = r
      if (chosen < 0) return null
    }

    remaining[chosen] -= 1
    out.set(pick.id, ALL_RANKS[chosen]!)
    done[best] = true

    const bit = 1 << chosen
    for (let i = 0; i < n; i++) {
      if (!done[i] && (candidates[i]!.mask & bit) !== 0) tokens[i] -= 1
    }
  }

  return out
}

function candidatesFrom(
  facts: ReadonlyMap<PieceId, EnemyFacts>,
  level: Relaxation,
): Candidate[] {
  const out: Candidate[] = []
  for (const id of [...facts.keys()].sort(cmp)) {
    const f = facts.get(id)!
    const allowed = level === 'pool-only'
      ? ALL_RANKS
      : level === 'derived-dropped'
        // Keep only what the redaction layer handed over — 翻明 and 終局 — and
        // drop every inference. A disclosed rank cannot contradict the pool, so
        // this level is reachable by construction.
        ? (f.disclosed !== null ? [f.disclosed] : ALL_RANKS)
        : f.allowed
    const indices = allowed.map((r) => RANK_INDEX[r])
    let mask = 0
    for (const i of indices) mask |= 1 << i
    out.push({ id, allowed: indices, mask })
  }
  return out
}

/**
 * The ramp for 「this piece has never moved」.
 *
 * Linear from 1 to `flagUnmovedMax` over `flagUnmovedTurns` full turns, then
 * flat. It ramps because at ply 2 nothing has moved and the observation carries
 * no information at all; it flattens because after enough turns "still hasn't
 * moved" stops getting more surprising and a runaway multiplier would let one
 * quiet piece eat the entire 軍旗 mass.
 */
function unmovedBonus(turns: number, w: BehaviouralWeights): number {
  if (w.flagUnmovedTurns <= 0) return w.flagUnmovedMax
  const t = Math.min(1, Math.max(0, turns) / w.flagUnmovedTurns)
  return 1 + (w.flagUnmovedMax - 1) * t
}

/** The behavioural multiplier for putting `rank` on this piece. 1 = no opinion. */
function pieceWeight(f: EnemyFacts, rank: Rank, turns: number, w: BehaviouralWeights): number {
  // A disclosed 兵種 is not a choice the sampler made, so pricing it would apply
  // the same constant to every particle and merely shrink the effective sample.
  if (f.disclosed !== null) return 1

  if (rank === 'engineer') {
    return f.deployedAs === 'queen' ? w.engineerOnQueen : 1
  }
  if (rank !== 'flag') return 1

  let weight = 1
  if (f.deployedAs === 'queen') weight *= w.flagOnQueen
  if (f.movesMade === 0) weight *= unmovedBonus(turns, w)
  if (f.maxAdvance > 0) weight *= w.flagPerRankAdvanced ** f.maxAdvance
  if (f.everOnScoringSquare) weight *= w.flagOnScoringSquare
  return weight
}

/**
 * Draw N consistent deployments of the enemy army, with their weights.
 *
 * Exported because it is the honest unit to test: 「every particle is a legal
 * deployment」 is a statement about these, and a belief that passes a marginal
 * check while sampling illegal armies would be a belief that happens to be right.
 */
export function sampleEnemyDeployments(
  view: ViewerState,
  color: Color,
  rng: Rng,
  opts: BeliefOptions = {},
): BeliefSamples {
  const facts = enemyFacts(view, color)
  const wanted = Math.max(1, Math.floor(opts.samples ?? DEFAULT_SAMPLES))
  const perSample = Math.max(1, Math.floor(opts.attemptsPerSample ?? DEFAULT_ATTEMPTS_PER_SAMPLE))
  const behavioural = opts.behavioural ?? true
  const weights: BehaviouralWeights = { ...DEFAULT_BEHAVIOURAL_WEIGHTS, ...opts.weights }
  const turns = Math.floor(view.log.length / 2)

  const counts = ALL_RANKS.map((r) => view.config.distribution[r] ?? 0)

  // The relaxation ladder. A legal game never leaves the first rung; the other
  // two exist so a self-contradictory record degrades into a vaguer belief
  // rather than an exception thrown from inside a policy's move.
  const ladder: Relaxation[] = ['none', 'derived-dropped', 'pool-only']
  let attempts = 0

  for (const level of ladder) {
    const candidates = candidatesFrom(facts, level)
    const samples: BeliefSample[] = []

    for (let i = 0; i < wanted; i++) {
      for (let attempt = 0; attempt < perSample; attempt++) {
        attempts++
        const assignment = drawAssignment(candidates, counts, rng)
        if (assignment === null) continue
        let weight = 1
        if (behavioural) {
          for (const [id, rank] of assignment) {
            const f = facts.get(id)
            if (f) weight *= pieceWeight(f, rank, turns, weights)
          }
        }
        samples.push({ assignment, weight })
        break
      }
    }

    if (samples.length > 0) return { facts, samples, attempts, relaxation: level }
  }

  // Unreachable: 'pool-only' allows every rank for every piece, and a table that
  // sums to 16 always has a token for every piece.
  return { facts, samples: [], attempts, relaxation: 'pool-only' }
}

// ---------------------------------------------------------------------------
// The belief
// ---------------------------------------------------------------------------

function zeroBelief(): Record<Rank, number> {
  const out = {} as Record<Rank, number>
  for (const r of ALL_RANKS) out[r] = 0
  return out
}

/**
 * The posterior over every enemy 兵種, one distribution per enemy piece.
 *
 * `color` is the seat asking; the map covers the sixteen pieces of the OTHER
 * colour, alive and dead alike. The dead are in it because they are what makes
 * the living tighten: a piece removed from the board still consumed a 兵種 from
 * the §2 table, so the marginals of the survivors are conditioned on it. That is
 * also why the sum of any rank's probability across all sixteen entries is
 * exactly its configured count — every particle is a whole legal deployment, and
 * the average of legal deployments preserves the table.
 */
export function beliefFor(
  view: ViewerState,
  color: Color,
  rng: Rng,
  opts: BeliefOptions = {},
): Belief {
  const drawn = sampleEnemyDeployments(view, color, rng, opts)

  const tally = new Map<PieceId, Record<Rank, number>>()
  for (const id of drawn.facts.keys()) tally.set(id, zeroBelief())

  let total = 0
  for (const { weight } of drawn.samples) total += weight
  // A prior can be configured to zero everything it touched. Falling back to
  // unweighted particles keeps a degenerate configuration from producing NaN
  // beliefs, which would propagate silently into every move a policy makes.
  const useWeights = total > 0

  total = 0
  for (const { assignment, weight } of drawn.samples) {
    const w = useWeights ? weight : 1
    total += w
    for (const [id, rank] of assignment) {
      const row = tally.get(id)
      if (row) row[rank] += w
    }
  }

  const out: Belief = new Map()
  for (const id of [...drawn.facts.keys()].sort(cmp)) {
    const row = tally.get(id) ?? zeroBelief()
    const norm = zeroBelief()
    if (total > 0) {
      for (const r of ALL_RANKS) norm[r] = row[r] / total
    }
    out.set(id, norm)
  }
  return out
}

/**
 * The flat prior: every piece equally likely to be anything, in the proportions
 * of THIS game's 數量表.
 *
 * Not used by `beliefFor` — the sampler produces it naturally when nothing has
 * happened yet — but exported because it is the baseline every other number
 * should be read against, and because 附錄 B makes the table a per-game setting
 * that nothing may hard-code.
 */
export function priorBelief(view: ViewerState): RankBelief {
  const out = zeroBelief()
  let total = 0
  for (const r of ALL_RANKS) total += view.config.distribution[r] ?? 0
  if (total <= 0) return out
  for (const r of ALL_RANKS) out[r] = (view.config.distribution[r] ?? 0) / total
  return out
}

// ---------------------------------------------------------------------------
// Reading a belief — the small questions a policy actually asks
// ---------------------------------------------------------------------------

/**
 * P(this piece sits strictly lower on the §2 ladder than `rank`).
 *
 * The literal (R, 工兵] mass of notebook §1.2, 軍旗 included — hitting the 軍旗
 * ends the game on the spot (§7.5①), so a policy weighing an attack wants it
 * inside the "I win" bucket, not outside.
 *
 * 爆裂物 is excluded because it HAS no 階級 (§2): it is neither weaker nor
 * stronger, it ties. Which is why this is not the same number as
 * `contactOdds().win` — see there.
 */
export function pWeakerThan(belief: RankBelief, rank: Rank): number {
  if (rank === 'bomb') return 0
  let p = 0
  for (const r of ALL_RANKS) {
    if (r === 'bomb') continue
    if (RANK_ORDER[r] > RANK_ORDER[rank]) p += belief[r]
  }
  return p
}

/** P(爆裂物). The number that decides whether a 結算格 is worth stepping onto. */
export function pBomb(belief: RankBelief): number {
  return belief.bomb
}

/** P(軍旗). Taking this piece ends the game immediately (§7.5①). */
export function pFlag(belief: RankBelief): number {
  return belief.flag
}

/**
 * What happens if a piece of MY rank `mine` meets this one.
 *
 * Every branch is decided by the engine's own `resolveCombat` (§4, §5), once per
 * candidate 兵種, rather than by a second copy of the combat table living here.
 * techspec §7 — 「The client must not implement rules」 — and a bot is a client:
 * a private reimplementation would be a second set of bugs, and the two would
 * disagree exactly on the 爆裂物 cases that matter most.
 *
 * The three outcomes are from MY piece's point of view and hold in both
 * directions, attacking or defending: §5.4's immunity is explicitly 雙向 and
 * 一律大吃小 has no attacker bonus, so survival depends on the pair of 兵種 and
 * not on who moved. Where the survivor ends up does depend on that (§4.1), but
 * that is a question about squares, not about who is left.
 *
 * `win` is not `pWeakerThan`: my 工兵 beats a 爆裂物 (§5.4) although a 爆裂物 is
 * not "weaker", and my 爆裂物 beats nothing at all while losing to almost
 * nothing either.
 */
export function contactOdds(
  belief: RankBelief,
  mine: Rank,
): { win: number; mutual: number; lose: number } {
  let win = 0
  let mutual = 0
  let lose = 0
  for (const r of ALL_RANKS) {
    const p = belief[r]
    if (p === 0) continue
    // Colours only label a 有煙無傷's announced survivor, which is not read here;
    // the survival flags are the same whichever pair is passed.
    const res = resolveCombat(mine, r, 'white', 'black')
    if (res.attackerSurvives && !res.defenderSurvives) win += p
    else if (!res.attackerSurvives && res.defenderSurvives) lose += p
    else mutual += p
  }
  return { win, mutual, lose }
}

/**
 * P(the contact removes both pieces) for my rank `mine` — 同歸於盡 in all three
 * of its indistinguishable forms (§4.3): equal 階級, my piece meeting a 爆裂物,
 * and 爆裂物 against 爆裂物.
 *
 * This is the number notebook §4.1 puts near 18% for the pieces that actually
 * get sent out, and 攻略 §4 turns into advice: a trade favours whoever is ahead
 * on points, so the side that is behind should be reading this before attacking.
 */
export function pMutualAgainst(belief: RankBelief, mine: Rank): number {
  return contactOdds(belief, mine).mutual
}
