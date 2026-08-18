/**
 * 佈署 (§9) as CONSTRAINED RANDOMISATION: doctrine as constraints, dice inside them.
 *
 * ---------------------------------------------------------------------------
 * Why a deployment policy is worth writing at all
 * ---------------------------------------------------------------------------
 *
 * Notebook §9.5 lists it as the arena's biggest blind spot in one line:
 * 「佈署為均勻隨機——真人不會（見 2.1 載體–先驗耦合）。因此這裡的**佈署層資訊博弈
 * 完全沒有被測到**。」 Every baseline policy (`random`, `greedy`, `contest`) deals
 * its 16 兵種 uniformly over its 16 載體, so half the game — the half decided
 * before the first ply and never revisable afterwards — has only ever been
 * measured against noise.
 *
 * ---------------------------------------------------------------------------
 * Why CONSTRAINED RANDOMISATION and not either extreme
 * ---------------------------------------------------------------------------
 *
 * Both extremes are known-bad, from opposite directions:
 *
 *   · A FIXED deployment is equivalent to publishing your army (gamebook §9:
 *     「配置必須為隨機，不得為固定的預設值——固定值等同公開該方全軍」), and notebook
 *     §1.3 shows why that is fatal rather than merely careless: 軍旗 is found by
 *     ELIMINATION, not by search. Every piece the opponent identifies deletes a
 *     candidate for free, so a deterministic placement hands them the answer
 *     before ply 1 and the hidden layer stops existing.
 *   · UNIFORM randomness throws away everything §2.3/§2.3c/§2.3d established —
 *     deliverability, the c/f 工兵 system, the carriers a 爆裂物 can actually be
 *     pressed on. That is the straw man 真人不會 attacks.
 *
 * So the doctrine is expressed as a SET of allowed carriers per 兵種, and the
 * choice inside the set is a draw from the seeded `Rng`. A ban is not a low
 * weight, it is absence from every set (plus a `never` list that survives even
 * the fallback); a preference is not a rank order, it is a `share` between sets,
 * so 「prefer a knight」 comes out as the modal carrier and never as a certainty.
 * Two seeds produce two armies; a hundred games produce a distribution rather
 * than an opening book.
 *
 * ---------------------------------------------------------------------------
 * The doctrine, and where each line of it lives
 * ---------------------------------------------------------------------------
 *
 * It is one human player's observed system (notebook §2.3c/§2.3d, 攻略 §5-2), not
 * theory — a sample of one, but a sample of one PLAYER beats a sample of zero:
 *
 *   軍旗    knight, quiet pawn, or (dully) a rook ... `FLAG`
 *   司令    queen, or an aggressive pawn ........... `COMMANDER`
 *   爆裂物  king · d/e pawn · knight · bishop · queen `BOMB`
 *   旅長    d/e pawns .............................. `BRIGADE`
 *   工兵    c/f pawns, then b/g .................... `ENGINEER`
 *   軍長/師長 bishops ............................... `STAFF`
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
 * tunables shown to both players before the game starts. The opponent's half of
 * `view.pieces` is filtered out on the way in and never consulted.
 *
 * Determinism: every draw comes from the `Rng` handed in. No `Math.random`, no
 * clock, no module-level mutable state — same seed, same army, byte for byte.
 * Candidate lists are built in piece-id order before any draw, so the result
 * cannot depend on the order the payload happened to arrive in.
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
// The shape of a constraint
// ---------------------------------------------------------------------------

/**
 * One allowed set of 載體 for one 兵種 — the unit of this whole module.
 *
 * Everything a set can test is PUBLIC at 佈署 time (§1 載體層): which piece a
 * carrier is, which file it stands on, and whether this deployment is about to
 * march it at a 結算格. There is deliberately no hook for anything else, because
 * anything else would have to come from a 兵種 nobody is allowed to see.
 */
export interface CarrierSet {
  /** 載體 admitted by this set. A carrier in NO set of a slot is banned outright. */
  readonly carriers: readonly Carrier[]
  /**
   * File letters the piece may stand on ('de', 'cf', 'bg'). Omitted means any
   * file. This is how the 工兵 and 旅長 systems are stated: they are claims about
   * SQUARES, not about carriers — 「c 兵攻擊 b/d，f 兵攻擊 e/g」 is geometry.
   */
  readonly files?: string
  /**
   * Admit only a pawn this deployment is NOT sending at a 結算格.
   *
   * The 軍旗 may never move into anything (§7.5①), so parking it on the pawn that
   * was about to take a 結算格 forfeits that square for the whole game.
   */
  readonly quiet?: boolean
  /**
   * Relative chance of drawing from this set, among the sets that still have a
   * free piece. Non-negative integer.
   *
   * **0 means RESERVE**: the set is used only once every positive-share set in
   * the slot is exhausted. That is what makes 工兵 c/f-then-b/g an ordered system
   * rather than a lottery, while 軍旗 knight-or-pawn stays a genuine coin.
   */
  readonly share: number
  /** The argument, in one line, with its citation. Read by humans only. */
  readonly why: string
}

/** The 兵種 this module has an opinion about. Everything else is dealt uniformly. */
export type DoctrineKey = 'bomb' | 'brigade' | 'engineer' | 'flag' | 'commander' | 'staff'

/** One 兵種 (or a group of them that share an argument) and the sets it may ride. */
export interface DoctrineSlot {
  readonly key: DoctrineKey
  /**
   * 兵種 placed by this slot. More than one only when the same argument covers
   * them (軍長 and 師長 both want range); which host gets which of them is itself
   * drawn from the `Rng`.
   */
  readonly ranks: readonly Rank[]
  /** Allowed sets, in reading order. Order is documentation; `share` decides. */
  readonly sets: readonly CarrierSet[]
  /**
   * Carriers this 兵種 must not ride even when the sets above cannot be
   * satisfied. The sets already exclude them; this is the guard on the graceful
   * fallback, so a pathological 數量表 degrades into a dull deployment rather
   * than into the one placement the notebook says loses outright.
   */
  readonly never?: readonly Carrier[]
  /**
   * Keep this 兵種 off a pawn the deployment is marching at a 結算格, even in the
   * fallback. The `quiet` flag above says the same thing about ONE set; this says
   * it about the 兵種, and that is a different claim.
   *
   * 軍旗 is the case and it is not a preference. §5.3 is 「軍旗以任何方式離開棋盤，
   * 該方立即判負（含被吃、主動撞擊他子）」, so a 軍旗 cannot capture to contest a
   * square and loses the game outright if anything captures it — and a 結算格 is
   * the one square on the board both sides are guaranteed to fight over. A slot
   * whose sets go unsatisfiable must not quietly relax that into 「march the flag
   * into the centre」; the bans and this are the two things degradation keeps.
   */
  readonly neverMarching?: boolean
}

// ---------------------------------------------------------------------------
// The doctrine
//
// Exported, frozen, and switchable (`DeploymentOptions`) for the same reason
// belief.ts exports its behavioural prior: an unmeasured doctrine is a story.
// Run the arena with a slot off and with it on, and the difference is a number.
// ---------------------------------------------------------------------------

/**
 * 爆裂物 (攻略 §5, §5-2, notebook §2.3, §2.3d).
 *
 * **rook is the ban, and it is the one entry here backed by measurement rather
 * than by derivation.** §2.3 is 「實測中最重要的發現，且原始設計文件完全沒有提到」,
 * observed twice: a rook 爆裂物 is 「被自己的兵擋死，開線公開且緩慢」, so White spent
 * seven plies walking one to a target that had been dead for eight. Across the
 * whole game archive it is measured at about 1 placement in 20. 「打得贏」不等於
 * 「打得到」.
 *
 * **The axis is STARTING PROXIMITY to ranks 4-5, not mobility.** §2.3 was
 * rewritten around the king, which refutes the mobility reading outright: it is
 * the least mobile piece on the board and one of the best carriers, because it
 * sits one step behind the centre pawns and the fighting all happens on ranks 4
 * and 5. Everything in this slot is a distance claim.
 *
 * The d/e pawn is the same argument at distance zero — it IS the piece going to
 * the 結算格, and §2.3d records 「爆裂物放 d/e pawn：它衝到計分格上蹲著。你要拿格子
 * 就得碰它，碰它就一換一」 as one of the three hardest things to face. It competes
 * with 旅長 for those two pawns and wins about a third of the time, which is the
 * point: a pawn on d4 that is USUALLY 旅長 and sometimes 爆裂物 is exactly the
 * ambiguity §2.3d is describing.
 *
 * queen keeps the smallest share: reach is fine (§2.3b watched one fail anyway,
 * because a moving target beats a fast carrier), but it is the most expensive
 * piece on the board and `COMMANDER` wants it.
 */
const BOMB: DoctrineSlot = {
  key: 'bomb',
  ranks: ['bomb'],
  never: ['rook'],
  sets: [
    {
      carriers: ['king'],
      share: 3,
      why: '§2.3: 一步就到戰場——全場機動力最低，卻是最快按得下去的爆裂物',
    },
    {
      carriers: ['pawn'],
      files: 'de',
      share: 2,
      why: '§2.3d: 蹲在計分格上，對手要拿格子就得碰它（與旅長爭這兩顆）',
    },
    { carriers: ['knight'], share: 3, why: '§2.3: 近，且能跳過未開的兵線' },
    { carriers: ['bishop'], share: 2, why: '§2.3d: 看起來只是在發展，卻會出現在爭奪點' },
    { carriers: ['queen'], share: 1, why: '§2.3: 送得到，但最貴，而且司令要用（§2.4）' },
  ],
}

/**
 * 旅長 (notebook §2.3c, 攻略 §5-2).
 *
 * 「旅長 ×2 → d/e pawn：直接搶中央格，階級 4 打得贏大部分接觸」. Two 旅長, two centre
 * pawns, and rank 4 beats thirteen of the sixteen 兵種 — the front half of the
 * division of labour whose back half is the 工兵 slot below.
 *
 * The only thing that displaces a 旅長 from d/e is a 爆裂物 that got there first,
 * which is the §2.3d variant and is supposed to happen sometimes. When both are
 * gone the slot degrades to a plain legal placement rather than inventing a
 * second-best square the notebook never observed.
 */
const BRIGADE: DoctrineSlot = {
  key: 'brigade',
  ranks: ['brigade'],
  sets: [
    { carriers: ['pawn'], files: 'de', share: 1, why: '§2.3c: 直接搶中央格，階級 4 打得贏大部分接觸' },
  ],
}

/**
 * 工兵 (notebook §2.3c, 攻略 §8, §5-2).
 *
 * **This is a SYSTEM, not a preference**, and the geometry is the whole of it:
 * pawns capture diagonally, so a c pawn attacks b/d and an f pawn attacks e/g —
 * which points the 工兵 straight at the enemy's d/e pawns, and the enemy's d/e
 * pawns are exactly where `BOMB` above likes to sit. 工兵 is immune in both
 * directions (§5.4), so it is 「唯一能安全地去戳那兩顆的棋」.
 *
 * The two halves fit together: 旅長 takes d/e and fights, 工兵 waits on c/f to
 * dismantle the opposing d/e. The centre is not diluted by a 階級 9 piece, and
 * the opponent's best defensive placement is answered before it is made.
 *
 * b/g is a RESERVE set (`share: 0`), not an alternative: it is only reached once
 * c/f are taken, i.e. by the third and fourth 工兵 of the 偵察兵 table, where
 * 「多出來的兩顆放 b/g，斜線覆蓋 a/c 與 f/h」 — in a 側翼八格 game that is the a and
 * h files, which are 結算格 there. Read the count from `view.config.distribution`
 * and this needs no special case.
 */
const ENGINEER: DoctrineSlot = {
  key: 'engineer',
  ranks: ['engineer'],
  never: ['queen'],
  sets: [
    { carriers: ['pawn'], files: 'cf', share: 1, why: '§2.3c: c 攻 b/d、f 攻 e/g，正對敵方 d/e 兵' },
    { carriers: ['pawn'], files: 'bg', share: 0, why: '§2.3c: 工兵4 的延伸，斜線覆蓋 a/c 與 f/h' },
  ],
}

/**
 * 軍旗 (notebook §1.3, §2.1, §2.2, §2.3c, 攻略 §9).
 *
 * **queen is the ban and it is load-bearing.** 工兵配 queen 在任何合理配置下皆屬浪費
 * (§2.1: 無攻擊價值、免疫為被動、不需機動性), so a 有煙無傷 on a queen is not a smoke
 * screen — the posterior collapses onto 軍旗 almost outright. 「queen 旗為最脆弱的
 * 配置，而非最強」: the opponent buys a near-certain answer for one 爆裂物, and a
 * located 軍旗 can neither hide forever nor hit back (階級 10 is the floor).
 * `ENGINEER` bans the queen too, in the other direction — a side that would never
 * put a 工兵 there must not put its 軍旗 there either, or the ban leaks.
 *
 * **knight is the modal carrier**, and §2.3c is the observation rather than the
 * guess: 「軍旗 → knight：整局沒被迫移動過。§2.2 猜對了」. It jumps, it reroutes
 * around a blockade, it RETREATS — the three things a pawn cannot do — and it
 * reads as a minor piece, so nobody spends a 爆裂物 probing it.
 *
 * A QUIET pawn is the other half of the coin, at nearly the same share: 「pawn 旗
 * 的低關注度在此框架下更值錢——沒人會為試探一顆 pawn 而燒掉一顆爆裂物」 (§2.1). Quiet
 * means this deployment is not sending it at a 結算格, which is read off
 * `config.scoringSquares` and therefore differs between 中央四格 and 側翼八格.
 *
 * rook is acceptable and dull, and it earns its place structurally: nothing
 * before this slot ever takes a rook, so the rook set is always non-empty, and
 * the queen ban is therefore unconditional — the fallback below is unreachable
 * for the 軍旗 on any table.
 *
 * **The shares are 6 : 4 : 1 and not 5 : 4 : 1, and the extra point is paid to
 * `BOMB` rather than argued from the notebook.** 爆裂物 draws first and likes
 * knights (share 3 of 11, twice over), so it takes BOTH of them in about one
 * deployment in ten — measured over the sweep, not estimated — and in those the
 * 軍旗's preferred set does not exist at all. At 5 : 4 : 1 that erosion lands the
 * knight at ~45% against the quiet pawn's ~44%, i.e. 「prefers a knight」 stops
 * being true of the OUTPUT while still being true of the table. The share a slot
 * declares is worth nothing on its own; what it is worth is what survives the
 * slots that resolve before it. 6 : 4 : 1 comes out at roughly 49 / 41 / 10.
 */
const FLAG: DoctrineSlot = {
  key: 'flag',
  ranks: ['flag'],
  never: ['queen'],
  neverMarching: true,
  sets: [
    { carriers: ['knight'], share: 6, why: '§2.2/§2.3c: 能跳、能繞、能撤，且刻板印象上是小子力' },
    { carriers: ['pawn'], quiet: true, share: 4, why: '§2.1: 沒人會為試探一顆 pawn 燒掉一顆爆裂物' },
    { carriers: ['rook'], share: 1, why: '可以，但無聊：能撤能易位，卻離戰場遠' },
  ],
}

/**
 * 司令 (notebook §2.3c, §2.3d, §2.4, 攻略 §7, §5-2).
 *
 * queen is preferred because it doubles as the ANSWER to the enemy's revealed
 * 司令: each side has exactly one, so 司令 against 司令 is a guaranteed 同階雙亡 —
 * the only DETERMINISTIC answer to a revealed 司令 there is, where a 爆裂物 is
 * merely probabilistic. But an answer has to be delivered: 「司令放 queen 上，你
 * 隨時可以換掉對方翻明的司令；司令放 pawn 上，你就只能看著」 (§2.4).
 *
 * A pawn 司令 is the aggressive reading and it is not a concession — §2.3d lists
 * it first under 「最難對付」: 「司令放 pawn：它會一路吃過來」, and the reason it is
 * hard is that the defender's 爆裂物 is usually undeliverable (§2.3 again, from
 * the other side). It stays at a real share also because the queen is the most
 * STEREOTYPED placement in the game — an opponent who has read the same page
 * checks the queen first.
 */
const COMMANDER: DoctrineSlot = {
  key: 'commander',
  ranks: ['commander'],
  sets: [
    { carriers: ['queen'], share: 3, why: '§2.4: 載你司令的那顆，同時是你對付對方司令的答案' },
    { carriers: ['pawn'], share: 2, why: '§2.3d: 它會一路吃過來——對手若沒答案就處理不掉' },
  ],
}

/**
 * 軍長・師長 (notebook §2.3c, 攻略 §5-2).
 *
 * 「軍長・師長 → bishop：長斜線，高階需要射程」. Two ranks, one argument, so one slot:
 * which bishop carries 軍長 and which carries 師長 is drawn, because there is no
 * argument distinguishing them and a fixed answer would be free information.
 *
 * Bishops are also good 爆裂物 carriers, so `BOMB` occasionally takes one first
 * and a 高階雙份 game asks for four of these ranks against two bishops either
 * way. Both cases land in the fallback, which is intended: this is the softest
 * claim in the file and the first one that should give way.
 */
const STAFF: DoctrineSlot = {
  key: 'staff',
  ranks: ['general', 'division'],
  sets: [{ carriers: ['bishop'], share: 1, why: '§2.3c: 長斜線，高階需要射程' }],
}

/**
 * The doctrine, in RESOLUTION order — narrowest and most systemic first.
 *
 * Order matters because the slots compete for the same pieces, and the rule is
 * that a slot whose argument names SQUARES resolves before a slot whose argument
 * names a carrier class:
 *
 *   爆裂物 first, because deliverability is the finding that came out of real
 *   games (§2.3) and because it is supposed to be able to outbid 旅長 for a
 *   centre pawn sometimes (§2.3d);
 *   旅長 then 工兵, the two halves of the c/f–d/e system (§2.3c), which stops
 *   working if a single file goes missing;
 *   軍旗 next: it has the widest allowed set of anything here (two knights, the
 *   quiet pawns, two rooks) and therefore loses least by drawing late — and its
 *   ban survives regardless, because nothing above it ever takes a rook;
 *   司令, then 軍長/師長, the two softest claims.
 *
 * Everything not named here — 團長 down to 排長 — is dealt uniformly over what is
 * left. That is not laziness: a 兵種 nobody has an argument about must carry no
 * signal either, or the doctrine leaks through the pieces it does not mention.
 */
export const DEFAULT_DOCTRINE: readonly DoctrineSlot[] = Object.freeze([
  BOMB,
  BRIGADE,
  ENGINEER,
  FLAG,
  COMMANDER,
  STAFF,
])

/** The slot for a key, or undefined when a custom doctrine omits it. */
export function slotFor(
  key: DoctrineKey,
  doctrine: readonly DoctrineSlot[] = DEFAULT_DOCTRINE,
): DoctrineSlot | undefined {
  return doctrine.find((slot) => slot.key === key)
}

/** Every 載體 a slot admits anywhere. A carrier absent from this list is banned. */
export function allowedCarriers(slot: DoctrineSlot): Carrier[] {
  const seen = new Set<Carrier>()
  for (const set of slot.sets) for (const carrier of set.carriers) seen.add(carrier)
  return [...seen]
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeploymentOptions {
  /**
   * Turn individual slots off. A 兵種 whose slot is `false` is dealt uniformly
   * with everything else — i.e. the arena's old behaviour for that one 兵種.
   *
   * This exists for one reason, and notebook §6.6 is the reason: 「兩局之間同時
   * 改變了三件事」, which is why two conclusions had to be reversed. Asking 「how
   * much is the 軍旗 rule worth?」 means running informed-vs-informed with
   * `{ flag: false }` on one side and NOTHING else different — one variable at a
   * time, which the arena's per-side seed streams already guarantee for the
   * moves. Omitted keys default to on.
   */
  readonly doctrine?: Partial<Record<DoctrineKey, boolean>>
  /**
   * Replace the doctrine wholesale. Defaults to {@link DEFAULT_DOCTRINE}.
   *
   * The switch above answers 「what is this rule worth?」; this answers 「what is
   * a DIFFERENT rule worth?」 — a rival deployment system can be written as data
   * and put in the arena against this one without touching any code here.
   */
  readonly rules?: readonly DoctrineSlot[]
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const FILES = 'abcdefgh'

/** Everything a set may consult, all of it derived from the public layers. */
interface Context {
  /**
   * Pawns that can step onto a 結算格 this ply — the d/e pawns on 中央四格, plus
   * the a/h pawns on 側翼八格 (§7.2 is a 附錄 B setting, so this comes from
   * `config.scoringSquares` and never from a constant).
   *
   * Deliberately pawns only, exactly as `greedy`'s deployment is: a bot cannot
   * enumerate 「which piece will this policy march where」 from a ViewerState —
   * move generation lives behind `GameState`, and reimplementing sliding geometry
   * here would be a second rules engine (techspec §7). Pawns are the cases that
   * always matter and the only ones derivable from carrier and square alone.
   */
  readonly marching: ReadonlySet<PieceId>
}

/** Does this piece belong to this allowed set? Public facts only. */
function inSet(set: CarrierSet, piece: ViewerPiece, ctx: Context): boolean {
  if (!set.carriers.includes(piece.carrier)) return false
  if (set.files !== undefined) {
    if (piece.square === null) return false
    if (!set.files.includes(FILES[fileOf(piece.square)] ?? '')) return false
  }
  if (set.quiet === true && ctx.marching.has(piece.id)) return false
  return true
}

interface Bucket {
  readonly set: CarrierSet
  readonly pieces: readonly ViewerPiece[]
}

/**
 * Draw one host for `slot` out of `remaining`, or null when no set can be met.
 *
 * Two draws, in this order: WHICH SET, by `share` among the sets that still have
 * a free piece, and then WHICH PIECE, uniformly inside it. Splitting it that way
 * is what keeps a preference from turning into a rule — with the 軍旗's 5 : 4 : 1
 * the knight is modal at about half, which is 「prefers a knight」 and is nowhere
 * near 「the 軍旗 is on a knight」.
 *
 * A `share` of 0 marks a RESERVE set: it is invisible while any positive-share
 * set has room, which is how 工兵 fill c/f before b/g without a second mechanism.
 */
function drawFromSets(
  slot: DoctrineSlot,
  remaining: readonly ViewerPiece[],
  ctx: Context,
  rng: Rng,
): ViewerPiece | null {
  const buckets: Bucket[] = []
  for (const set of slot.sets) {
    const pieces = remaining.filter((piece) => inSet(set, piece, ctx))
    if (pieces.length > 0) buckets.push({ set, pieces })
  }

  const live = buckets.filter((b) => b.set.share > 0)
  const pool = live.length > 0 ? live : buckets
  if (pool.length === 0) return null

  const weights = pool.map((b) => Math.max(0, Math.floor(b.set.share)))
  const total = weights.reduce((a, b) => a + b, 0)
  // Only reserve sets are available, and they are all equally reserved.
  let chosen = total > 0 ? pool[pool.length - 1]! : pool[rng.int(pool.length)]!
  if (total > 0) {
    let draw = rng.int(total)
    for (let i = 0; i < pool.length; i++) {
      draw -= weights[i]!
      if (draw < 0) {
        chosen = pool[i]!
        break
      }
    }
  }
  return chosen.pieces[rng.int(chosen.pieces.length)]!
}

/**
 * Place a 兵種 whose sets could not be met: a uniform draw over what is left,
 * minus `slot.never` and minus the marching pawns when `slot.neverMarching`.
 *
 * Only the PREFERENCE degrades. The ban does not — 軍旗 off the queen, 爆裂物 off
 * a rook, 軍旗 off a pawn walking at a 結算格 — because those are the placements
 * the notebook and §5.3 say are lost outright rather than merely poor, and a slot
 * that cannot get its FIRST choice has no more reason to accept its worst.
 *
 * The two guards drop in that order, and legality outranks both: a deployment
 * `validateAssignment` refuses is not a game at all, so the last resort is a
 * draw over everything left. Reaching it takes a custom doctrine — under
 * {@link DEFAULT_DOCTRINE} nothing above `FLAG` ever takes a rook, so its sets
 * are satisfiable on every table and this path stays unreachable for the 軍旗.
 */
function drawFallback(
  slot: DoctrineSlot,
  remaining: readonly ViewerPiece[],
  ctx: Context,
  rng: Rng,
): ViewerPiece {
  const banned = slot.never ?? []
  const allowed = remaining.filter((piece) => !banned.includes(piece.carrier))
  if (slot.neverMarching === true) {
    const quiet = allowed.filter((piece) => !ctx.marching.has(piece.id))
    if (quiet.length > 0) return rng.pick(quiet)
  }
  return rng.pick(allowed.length > 0 ? allowed : remaining)
}

// ---------------------------------------------------------------------------
// The deployment
// ---------------------------------------------------------------------------

/**
 * A legal §9 deployment: doctrine as constraints, dice inside them.
 *
 * Returns a bijection from this side's 16 載體 onto `view.config.distribution` —
 * the game's OWN 數量表, never the module constant, because 兵種數量配置 is a 附錄 B
 * tunable and the 偵察兵 preset deals four 工兵 (which is precisely what turns the
 * `ENGINEER` reserve set on).
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
  const remaining: ViewerPiece[] = []
  for (const id of ids) {
    const piece = byId.get(id)
    if (!piece) continue
    remaining.push(piece)
    if (pawnReachesScoring(piece, scoring)) marching.add(id)
  }
  const ctx: Context = { marching }

  // The 數量表 as 16 individual 兵種. Ranks come out of here and go onto pieces;
  // when it is empty the deployment is complete and exactly uses up the table.
  const unplaced: Rank[] = rankPool(view)
  const out: Record<PieceId, Rank> = {}

  const place = (host: ViewerPiece, rank: Rank): void => {
    out[host.id] = rank
    remaining.splice(remaining.indexOf(host), 1)
    const at = unplaced.indexOf(rank)
    if (at >= 0) unplaced.splice(at, 1)
  }

  /**
   * 兵種 whose slot could not be satisfied, held over to a second pass.
   *
   * They WAIT rather than grabbing something immediately, and that ordering is
   * load-bearing rather than tidy. A 旅長 whose two centre pawns were both taken
   * by 爆裂物 (the §2.3d variant) used to fall straight to a uniform draw over
   * everything still free — which meant it could take a c/f pawn out from under
   * the 工兵 system, or the queen out from under the 司令, and one slot failing
   * quietly broke three that were perfectly satisfiable. Measured at the time:
   * about one deployment in twenty, all three systems damaged at once.
   *
   * Deferring inverts that. Every slot that CAN be satisfied is satisfied first;
   * a slot that cannot then takes from what is genuinely left over.
   */
  const deferred: { slot: DoctrineSlot; rank: Rank }[] = []

  for (const slot of opts.rules ?? DEFAULT_DOCTRINE) {
    if (opts.doctrine?.[slot.key] === false) continue

    const wanted = unplaced.filter((rank) => slot.ranks.includes(rank))
    if (wanted.length === 0) continue
    // Which host gets 軍長 and which gets 師長 is a draw, not a convention; for a
    // single-rank slot there is nothing to shuffle and the stream stays untouched.
    const ranks = slot.ranks.length > 1 ? shuffled(wanted, rng) : wanted

    const n = Math.min(wanted.length, remaining.length)
    for (let k = 0; k < n; k++) {
      const rank = ranks[k]!
      const host = drawFromSets(slot, remaining, ctx, rng)
      if (host === null) {
        // Reserve the 兵種 so the uniform deal below cannot spend it twice.
        deferred.push({ slot, rank })
        const at = unplaced.indexOf(rank)
        if (at >= 0) unplaced.splice(at, 1)
        continue
      }
      place(host, rank)
    }
  }

  for (const { slot, rank } of deferred) {
    if (remaining.length === 0) break
    place(drawFallback(slot, remaining, ctx, rng), rank)
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
