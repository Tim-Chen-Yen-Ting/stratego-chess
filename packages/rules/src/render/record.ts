/**
 * 棋譜 export — the record a human takes away from a game. Gamebook §10.
 *
 *   「紀錄給，解算不給。」
 *
 * Three pure functions over a **ViewerState** and nothing else:
 *
 *   exportMarkdown — what you paste into a chat window to discuss the game
 *   exportJson     — the same content as a plain object, for a script
 *   gameStats      — the analysis summary both of the above embed
 *
 * The redaction contract, in full:
 *
 *  · The input is ALREADY redacted. `stateForViewer` decided what this viewer
 *    may see; a hidden 兵種 arrives here as `rank: null`. Nothing in this file
 *    imports `GameState`, `entitledToRank` or the piece table, so there is no
 *    path by which it could reach around that boundary.
 *  · A rank is printed only when it came from `ViewerPiece.rank` (non-null) or
 *    from a `CombatOutcome` field, which §4「翻明總表」defines as announced to
 *    everyone. 爆裂物 is named on a 有煙無傷 for the same reason: that event
 *    公告s that a bomb was lost. It is now the ONLY event that does — 同歸於盡
 *    carries nothing, so a bomb that worked is not in the record at all.
 *  · No candidate sets, no ranges, no "the survivor must be 工兵 or 軍旗". That
 *    is 推論輔助 (§10) and it is the reader's job, not the record's — even
 *    though the deduction is trivial and even though a spectator UI is allowed
 *    to show it. A record that solves for you turns 讀盤 into reading.
 *  · The statistics are aggregates over the PUBLIC log and the PUBLIC carrier
 *    layer: how many contacts, how they were announced, how many of a side's own
 *    結算 paid nothing, how many squares it held, where its moves landed, which
 *    piece moved. They are statements about what happened, not about who anyone
 *    is. Nothing here narrows, eliminates or ranges over a 兵種 — that is 解算,
 *    and no aggregate of squares can produce it. The one figure that does read a
 *    兵種 — the true 爆裂物 count — is taken only at 終局, when §10.5 has already
 *    opened every rank to every viewer.
 *  · At game end the ViewerState carries every rank (§10 終局公開全部兵種), so a
 *    finished game exports in full with no special-casing anywhere below.
 *
 * Everything here is deterministic: no clock is read, no `Date` is touched, so
 * the same ViewerState always exports the same bytes.
 */

import { castlePlan, opposite, squareName } from '../board.js'
import {
  ALL_RANKS,
  CARRIER_LETTER,
  RANK_NAMES_ZH,
  RANK_ORDER,
} from '../constants.js'
import { viewerColor } from '../redact.js'
import { encodeSetupCode, setupCodeSlots } from '../setupcode.js'
import type {
  Carrier,
  Color,
  CombatOutcome,
  GameEvent,
  PieceId,
  Rank,
  Result,
  Square,
  ViewerPiece,
  ViewerState,
} from '../types.js'

// ---------------------------------------------------------------------------
// Statistics — the numbers the owner actually reads
// ---------------------------------------------------------------------------

/**
 * 同歸於盡 over every contact, kept as a RAW FRACTION.
 *
 * **This replaces `tiesPerContest`, and it is not the same number.** The old one
 * was 同階雙亡 over 階級對決 — rank ties over the contacts where two ranks were
 * actually compared — which is the figure notebook §4.1 checks against its ~18%
 * expectation. That number is no longer observable, and the rename is deliberate
 * so that nothing keeps quoting it against the old expectation:
 *
 *   · the NUMERATOR is gone. A rank tie, a 爆裂物 taking an ordinary piece and
 *     爆裂物 vs 爆裂物 all announce the same contentless 同歸於盡, by design, so
 *     the log no longer says which of the three happened.
 *   · the DENOMINATOR is gone with it. 階級對決 meant "contacts that compared
 *     ranks", and the bomb contacts can no longer be split out of 同歸於盡 to be
 *     excluded from it.
 *
 * What remains observable is this: how often a contact removed both pieces. It
 * runs HIGHER than the old rank-tie rate — every bomb contact that used to be
 * excluded is now inside both terms — so comparing it with ~18% is meaningless.
 * The rank-tie rate is now measurable only by instrumenting the engine (or by
 * re-resolving every contact at 終局 against the opened 兵種, which is combat
 * logic and does not belong in a record). A record reports what was announced.
 *
 * Both terms are always carried and the ratio is `null` — never 0, never NaN —
 * when there were no contacts at all: a percentage without a denominator is how
 * two playtest games got argued about in the first place.
 */
export interface MutualDestruction {
  /** contacts announced as 同歸於盡 */
  mutual: number
  /** contacts of every kind */
  contests: number
  /** mutual / contests, or null when contests === 0 */
  ratio: number | null
}

/**
 * The longest streak of consecutive OWN SETTLEMENTS crediting nothing.
 *
 * Own settlements, not plies: §7 settles after every ply but credits only the
 * mover, so a side is never credited on the opponent's plies and counting those
 * zeros would report half of every game as a drought for both sides.
 */
export interface ZeroRun {
  length: number
  /** ply the run started on; null when the side never settled for zero */
  startPly: number | null
  /**
   * Ply the run ended on; null likewise. It CANNOT be derived as
   * `startPly + length - 1`: a side's settlements are its own plies, which are
   * two apart, so a run of 3 from ply 1 ends on ply 5.
   */
  endPly: number | null
}

/**
 * The most 結算格 a side stood on at the same moment.
 *
 * §7② credits exactly +1 per own piece standing on a scoring square, so a
 * settlement's income IS the number of squares held at that settlement, and this
 * is the maximum of that series. It is the one figure a score column will not
 * give up at a glance: notebook §3.3b's whole finding — White reaching six of
 * eight at once while Black never held two — had to be hand-derived from a
 * running total.
 *
 * Sampled on the side's OWN plies, because those are the only plies it is
 * credited on (§7: only the mover settles). A square held across the opponent's
 * reply is still held when the side's next settlement comes round.
 *
 * Nothing here is about identity. It counts squares.
 */
export interface PeakHold {
  /** squares held simultaneously at the peak; 0 when the side never scored */
  count: number
  /** the FIRST ply the peak was reached; null when `count` is 0 */
  ply: number | null
}

/**
 * Moves that ended on a 結算格, over that side's moves.
 *
 * Playing the objective, as opposed to merely playing. A move counts by the
 * square it was played TO — including one that then lost the contact standing
 * there. Whether the attack came off is the outcome column's business, and
 * folding it in here would fuse two measurements into one number, which is the
 * mistake this block exists to avoid.
 */
export interface ObjectiveMoves {
  /** moves whose destination was a scoring square */
  count: number
  /** the side's moves. A pass is an action, not a move (§3④), and is not here. */
  total: number
  /** count / total, or null — never 0 — when the side made no move at all */
  ratio: number | null
}

/** The longest streak of consecutive moves by one side played with one piece. */
export interface PieceRun {
  length: number
  /** ply the run started on; null when the side never moved a piece */
  startPly: number | null
}

/**
 * 爆裂物 lost by one side — what the log proves, and what the record can prove.
 *
 * These are two different numbers now and they are kept apart on purpose. 同歸於盡
 * announces nothing, so a 爆裂物 that did its job is indistinguishable from an
 * equal-兵種 trade; the only contact that still names one is 有煙無傷, where it
 * fizzled against 工兵/軍旗 and the other piece survived.
 *
 * So `known` is a FLOOR, not a count, and it is the only figure available while
 * the game is live. `actual` is the truth, and it exists only at 終局 (§10.5
 * 終局公開全部兵種), counted off the piece list. Never compare one game's
 * `known` against another's `actual` — that is the mistake the split exists to
 * make impossible.
 */
export interface BombsLost {
  /** 爆裂物 this side is KNOWN to have lost: 有煙無傷 contacts only */
  known: number
  /** the plies those fizzles happened on */
  knownPlies: number[]
  /**
   * The true number, or null when this view cannot derive it — which is every
   * view while the game is running. See {@link bombsActuallyLost}.
   */
  actual: number | null
}

export interface SideStats {
  color: Color
  /** final score as the ViewerState reports it — 貼目 included for black */
  score: number
  /** points credited by 結算, i.e. `score` minus the starting 貼目 credit */
  earned: number
  /**
   * This side's own 結算 — one per ply it moved, and the only plies it is
   * credited on (§7: settlement runs after every ply but credits only the
   * mover). It is the denominator of `earnedPerSettlement` and of
   * `zeroSettlements`, and it is carried so a reader can convert between the
   * two rates below without knowing whose ply came last.
   */
  settlements: number
  /** score / plies — the headline rate over GAME LENGTH, 貼目 included */
  pointsPerPly: number
  /**
   * earned / plies — the same series with 貼目 taken out.
   *
   * This is not a second name for `pointsPerPly`. That one answers "how fast did
   * the score move", which is what 分數線 X is checked against, and it carries
   * Black's head start for the whole game. This one is the figure that survives
   * comparison ACROSS games, where 貼目 and length differ — notebook §3.3b lines
   * three games up by per-ply rate and every Black entry in it is shifted by
   * komi/plies.
   *
   * It is NOT the mean number of squares held: a side settles on half the plies,
   * so this runs at about half of `earnedPerSettlement`. Comparing it with
   * numbers from before settlement became mover-only will read as a collapse in
   * play that is really just the rule change.
   */
  earnedPerPly: number
  /**
   * earned / settlements — the MEAN number of squares this side held at its own
   * settlements, of which `peakSquaresHeld` is the maximum. Max and mean of one
   * series; read together they say how much was held and how steadily.
   */
  earnedPerSettlement: number
  /** the most scoring squares held at once, and when — see {@link PeakHold} */
  peakSquaresHeld: PeakHold
  /**
   * Own settlements that credited nothing, out of `settlements`.
   *
   * Not "plies scoring zero", which is what this used to be. Under mover-only
   * settlement every one of the opponent's plies credits this side nothing, so
   * counting plies would bury a real drought under a structural one.
   */
  zeroSettlements: number
  longestZeroRun: ZeroRun
  /** moves that landed on a scoring square — see {@link ObjectiveMoves} */
  objectiveMoves: ObjectiveMoves
  /**
   * How many distinct pieces this side moved at all. 王車易位 counts the king
   * only: it is one move and §3② calls it the king's, so the rook rides along
   * rather than becoming a second mover.
   */
  distinctPiecesMoved: number
  /** longest streak of consecutive own moves made with one piece */
  longestSinglePieceRun: PieceRun
  /** 爆裂物 this side lost — see {@link BombsLost}, which is two numbers now */
  bombsLost: BombsLost
}

export interface GameStats {
  pliesPlayed: number
  contacts: number
  contactsByOutcome: Record<CombatOutcome['kind'], number>
  /** 同歸於盡 over all contacts — NOT the old tie rate, see {@link MutualDestruction} */
  mutualDestruction: MutualDestruction
  sides: Record<Color, SideStats>
}

/**
 * Display labels for every announced outcome.
 *
 * Typed as a total `Record` over the outcome union on purpose: adding a
 * CombatOutcome variant fails to compile until it is given a label here, and
 * `OUTCOME_KINDS` below is derived from this table, so a new variant is counted
 * by `gameStats` and printed by the renderer without a second edit.
 */
const OUTCOME_LABEL: Record<CombatOutcome['kind'], string> = {
  'attacker-wins': '攻方勝 attacker-wins',
  'defender-wins': '守方勝 defender-wins',
  'mutual-destruction': '同歸於盡 mutual-destruction',
  'fizzle': '有煙無傷 fizzle',
}

const OUTCOME_KINDS = Object.keys(OUTCOME_LABEL) as CombatOutcome['kind'][]

/** Both colours, in a fixed order. Local so this file never depends on mutable state. */
const COLORS: readonly Color[] = ['white', 'black']

/**
 * Which side is KNOWN to have lost a 爆裂物 in this contact — from the
 * announcement alone, which is all a record ever gets.
 *
 *   fizzle              有煙無傷 removes ONLY the 爆裂物 (§5) and the event names
 *                       the colour that survived, so the loser is the other one.
 *   mutual-destruction  says nothing. It covers an equal-兵種 trade, a 爆裂物
 *                       taking an ordinary piece, and 爆裂物 vs 爆裂物 under one
 *                       announcement that carries no rank and no colour. A bomb
 *                       may well have been spent here; the log cannot say so, and
 *                       neither may this function.
 *   the two decisive kinds  no bomb: a 爆裂物 never wins and never loses alone.
 *
 * Returning null for 同歸於盡 is the whole point of the change. Counting bombs
 * off the log is exactly the inference that made 爆裂物 inventory public and let
 * a revealed 司令 be run to provably unkillable.
 */
function knownBombLoser(outcome: CombatOutcome): Color | null {
  return outcome.kind === 'fizzle' ? opposite(outcome.survivorColor) : null
}

/**
 * The TRUE number of 爆裂物 a side has lost, or null when it is not derivable.
 *
 * Derivable only at 終局: §10.5 opens every 兵種, so bomb-ranked pieces that are
 * off the board (`square === null`) can simply be counted. Two deliberate
 * refusals:
 *
 *  · Not attempted while the game is live, even for the exporter's own side,
 *    whose bombs it can of course see. A live export is meant to be safe to
 *    paste into the window the opponent is reading (see deploymentLines), and
 *    "White has one 爆裂物 left" is exactly the sort of thing 同歸於盡 was made
 *    silent to protect.
 *  · Null, not a partial count, if any of that side's 兵種 is redacted. A number
 *    assembled out of the ranks that happen to be visible would differ from
 *    viewer to viewer, and every other figure in `gameStats` is the same for
 *    everyone.
 */
function bombsActuallyLost(vs: ViewerState, color: Color): number | null {
  if (vs.status.kind !== 'over') return null
  let lost = 0
  for (const p of vs.pieces) {
    if (p.color !== color) continue
    if (p.rank === null) return null
    if (p.rank === 'bomb' && p.square === null) lost++
  }
  return lost
}

/** Score at ply 0: white 0, black 貼目 — the same baseline `createGame` sets. */
function startingScore(vs: ViewerState): Record<Color, number> {
  return { white: 0, black: vs.config.komi }
}

interface PlyIncome {
  white: number
  black: number
}

/**
 * Per-ply income for both sides, parallel to `vs.log`.
 *
 * Derived by differencing the log's `scoreAfter`, which is public. Two entries
 * are structurally zero and neither is a fact about play:
 *
 *  · the side that did NOT move. §7 settles after every ply but credits only the
 *    mover, so a ply's income belongs to `e.color` and the other column is 0 on
 *    every single ply. Everything downstream that asks "how much was held" reads
 *    the mover's column only.
 *  · a ply that ended the game by 奪旗 ran no 結算 at all (§7①), so it shows 0
 *    for both — that is what the record says happened, and the record is what
 *    this file reports.
 */
function incomePerPly(vs: ViewerState): PlyIncome[] {
  const out: PlyIncome[] = []
  let prev = startingScore(vs)
  for (const e of vs.log) {
    out.push({ white: e.scoreAfter.white - prev.white, black: e.scoreAfter.black - prev.black })
    prev = { white: e.scoreAfter.white, black: e.scoreAfter.black }
  }
  return out
}

/** 貼目 can be any rational (附錄 B), so compare against a tolerance, not 0. */
function isZero(n: number): boolean {
  return Math.abs(n) < 1e-9
}

// ---------------------------------------------------------------------------
// Public-carrier replay — WHICH piece moved
//
// The log records squares, not piece ids, so the three counters that ask about
// pieces (`objectiveMoves`, `distinctPiecesMoved`, `longestSinglePieceRun`) need
// the carrier layer walked forward. ONE pass produces all three; nothing below
// replays anything a second time.
//
// Redaction-wise this is the cheapest block in the file. It reads `move`, the
// three contact squares, `e.color`, `outcome.kind` and — on a 有煙無傷 — the
// announced `survivorColor`: every one a field of a public event, all four
// outcome kinds already公告 by §4「翻明總表」. No rank is read, so none can
// leak, and what it produces are opaque tokens that say only "this is the same
// piece as that", never what that piece is.
// ---------------------------------------------------------------------------

/**
 * Opaque per-piece identity, only ever compared for equality.
 *
 * A piece that has not yet moved is named by the square it started on, so this
 * needs no opening layout — which matters, because a ViewerState carries the
 * CURRENT position and §9's is not the only position this file is ever handed.
 * A square can only be vacated by the piece on it moving, so a token is minted
 * exactly once per piece and follows it for the rest of the game.
 */
type PieceToken = string

interface PlyMover {
  /** who moved; null on a pass, which moves nobody */
  token: PieceToken | null
  /** the square the move was played TO; null on a pass */
  landedOn: Square | null
}

/**
 * Who is left standing after a contact, from the announcement alone.
 *
 *   attacker-wins / defender-wins  the announcement names the winner's side
 *   fizzle                         有煙無傷 removes only the 爆裂物 (§5), and
 *                                  the event names the colour that survived
 *   mutual-destruction             nobody stands (§4, §5) — and which of the
 *                                  three ways it happened is not in the event,
 *                                  which is fine here: the board is the same
 *                                  either way, both pieces are gone
 *
 * No rank is compared here; `resolveCombat` already did that, privately.
 */
function survivorToken(
  outcome: CombatOutcome,
  mover: Color,
  attacker: PieceToken,
  defender: PieceToken | undefined,
): PieceToken | undefined {
  switch (outcome.kind) {
    case 'attacker-wins': return attacker
    case 'defender-wins': return defender
    case 'fizzle': return outcome.survivorColor === mover ? attacker : defender
    case 'mutual-destruction': return undefined
  }
}

/** Mover + landing square for every logged ply, parallel to `vs.log`. */
function replayMovers(log: readonly GameEvent[]): PlyMover[] {
  const on: (PieceToken | undefined)[] = Array.from({ length: 64 }, (_, sq) => `sq${sq}`)
  let minted = 0
  /**
   * A move can only start from an occupied square, so this is unreachable on any
   * log the engine produced. It exists so a malformed one degrades into "some
   * piece we have not seen before" rather than merging two pieces into one.
   */
  const stranger = (): PieceToken => `x${minted++}`

  const out: PlyMover[] = []

  for (const e of log) {
    if (e.move.kind === 'pass') {
      out.push({ token: null, landedOn: null })
      continue
    }

    if (e.move.kind === 'castle') {
      // 王車易位 relocates two carriers but is ONE move, and §3② calls it the
      // king's — so the king is the mover and its destination is where the move
      // landed. The rook rides along and is not a second mover.
      const plan = castlePlan(e.color, e.move.side)
      const king = on[plan.kingFrom] ?? stranger()
      const rook = on[plan.rookFrom] ?? stranger()
      on[plan.kingFrom] = undefined
      on[plan.rookFrom] = undefined
      on[plan.kingTo] = king
      on[plan.rookTo] = rook
      out.push({ token: king, landedOn: plan.kingTo })
      continue
    }

    const { from, to } = e.move
    const attacker = on[from] ?? stranger()
    out.push({ token: attacker, landedOn: to })

    if (!e.combat) {
      on[from] = undefined
      on[to] = attacker             // 升變 swaps the carrier, not the piece (§6)
      continue
    }

    // §4 位置結算: a losing attacker is removed from the square it came FROM and
    // never enters the target, so every square touched is cleared first and only
    // the announced survivor is put back.
    const { outcome, attackerSquare, defenderSquare, survivorSquare } = e.combat
    const defender = on[defenderSquare]
    on[from] = undefined
    on[attackerSquare] = undefined
    on[defenderSquare] = undefined
    on[to] = undefined              // en passant: `to` is neither contact square
    const survivor = survivorToken(outcome, e.color, attacker, defender)
    if (survivor !== undefined && survivorSquare !== null) on[survivorSquare] = survivor
  }

  return out
}

function sideStats(
  vs: ViewerState,
  color: Color,
  income: readonly PlyIncome[],
  movers: readonly PlyMover[],
): SideStats {
  const plies = income.length
  const score = vs.score[color]
  const earned = score - startingScore(vs)[color]
  // §7.1: 奪旗 fires in the action phase and stops the game, so the winning ply
  // never reached 結算.
  const endedOnFlag =
    vs.status.kind === 'over' &&
    (vs.status.result.kind === 'flag' || vs.status.result.kind === 'flag-both')

  // The 結算 series and the move series are both walked here, in ONE pass over
  // the log. They share a filter — `e.color === color` — because under §7 a side
  // settles on exactly the plies it moves on: settlement follows every ply and
  // credits the mover, so this side's settlements and this side's actions are
  // the same list of plies. A pass is one of them (the passer is the mover), and
  // it settles like any other; what it is NOT is a move (§3④), which is why the
  // move counters below sit past an extra early return.
  let settlements = 0
  let zeroSettlements = 0
  let longest = 0
  let longestStart: number | null = null
  let longestEnd: number | null = null
  let run = 0
  let runStart = 0

  let peak = 0
  let peakPly: number | null = null

  const scoring = new Set<Square>(vs.config.scoringSquares)

  let objective = 0
  let moves = 0
  const moved = new Set<PieceToken>()
  let pieceRun = 0
  let pieceRunStart: number | null = null
  let pieceRunToken: PieceToken | null = null
  let longestPieceRun = 0
  let longestPieceRunStart: number | null = null

  const bombPlies: number[] = []

  vs.log.forEach((e, i) => {
    // Read off EVERY ply, the opponent's included: 有煙無傷 names the side whose
    // 爆裂物 was lost regardless of who was moving.
    if (e.combat && knownBombLoser(e.combat.outcome) === color) bombPlies.push(e.ply)
    if (e.color !== color) return

    // A ply that ended the game on 奪旗 ran NO settlement at all (§7.1: the
    // 奪旗 判定 fires in the action phase and the game stops there). Counting it
    // would report a settlement that paid zero, inventing a zero-income run out
    // of the winning move.
    if (endedOnFlag && i === vs.log.length - 1) return

    // --- this side's 結算 ------------------------------------------------
    const inc = income[i]?.[color] ?? 0
    settlements++

    // §7② credits +1 per own piece standing on a 結算格, so this settlement's
    // income IS the count of squares held at it — an integer by construction.
    // Rounding clears the float dust a rational 貼目 (附錄 B) leaves behind.
    const held = Math.round(inc)
    // strictly greater: a repeat of the peak keeps the FIRST ply that reached it
    if (held > peak) {
      peak = held
      peakPly = e.ply
    }

    if (isZero(inc)) {
      zeroSettlements++
      if (run === 0) runStart = e.ply
      run++
      // strictly greater: a tie keeps the FIRST run of that length
      if (run > longest) {
        longest = run
        longestStart = runStart
        // the end is carried, not derived: own plies are two apart
        longestEnd = e.ply
      }
    } else {
      run = 0
    }

    // --- this side's moves -----------------------------------------------
    // A pass is a legal ACTION, not a move (§3④): it is out of the denominator,
    // and since it moves nobody it does not interrupt a one-piece run either.
    const m = movers[i]
    if (m === undefined || m.token === null) return

    moves++
    moved.add(m.token)
    if (m.landedOn !== null && scoring.has(m.landedOn)) objective++

    if (m.token === pieceRunToken) {
      pieceRun++
    } else {
      pieceRunToken = m.token
      pieceRun = 1
      pieceRunStart = e.ply
    }
    // strictly greater: a tie keeps the FIRST run of that length
    if (pieceRun > longestPieceRun) {
      longestPieceRun = pieceRun
      longestPieceRunStart = pieceRunStart
    }
  })

  return {
    color,
    score,
    earned,
    settlements,
    pointsPerPly: plies === 0 ? 0 : score / plies,
    earnedPerPly: plies === 0 ? 0 : earned / plies,
    earnedPerSettlement: settlements === 0 ? 0 : earned / settlements,
    peakSquaresHeld: { count: peak, ply: peakPly },
    zeroSettlements,
    longestZeroRun: { length: longest, startPly: longestStart, endPly: longestEnd },
    objectiveMoves: {
      count: objective,
      total: moves,
      ratio: moves === 0 ? null : objective / moves,
    },
    distinctPiecesMoved: moved.size,
    longestSinglePieceRun: { length: longestPieceRun, startPly: longestPieceRunStart },
    bombsLost: {
      known: bombPlies.length,
      knownPlies: bombPlies,
      actual: bombsActuallyLost(vs, color),
    },
  }
}

/** The analysis summary. Aggregates over the public log; infers nothing. */
export function gameStats(vs: ViewerState): GameStats {
  const income = incomePerPly(vs)
  const movers = replayMovers(vs.log)

  const contactsByOutcome = {} as Record<CombatOutcome['kind'], number>
  for (const kind of OUTCOME_KINDS) contactsByOutcome[kind] = 0

  let contacts = 0
  for (const e of vs.log) {
    if (!e.combat) continue
    contacts++
    contactsByOutcome[e.combat.outcome.kind]++
  }

  // No rank-duel denominator is computed. It used to be attacker-wins +
  // defender-wins + mutual-rank — the contacts where two 階級 were compared —
  // and it cannot be rebuilt: the bomb contacts that must be excluded from it
  // are now inside 同歸於盡, unlabelled. See {@link MutualDestruction}.
  const mutual = contactsByOutcome['mutual-destruction']

  return {
    pliesPlayed: vs.log.length,
    contacts,
    contactsByOutcome,
    mutualDestruction: {
      mutual,
      contests: contacts,
      ratio: contacts === 0 ? null : mutual / contacts,
    },
    sides: {
      white: sideStats(vs, 'white', income, movers),
      black: sideStats(vs, 'black', income, movers),
    },
  }
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function colorLabel(c: Color): string {
  return c === 'white' ? 'White' : 'Black'
}

/** Trim the float noise a tunable 貼目 can introduce, without padding integers. */
function fmt(n: number): string {
  return String(Number(n.toFixed(3)))
}

function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 司令(1) … 軍旗(10), 爆裂物(—). Only ever called with an ANNOUNCED rank. */
function rankText(rank: Rank): string {
  const zh = RANK_NAMES_ZH[rank]
  return rank === 'bomb' ? `${zh}(—)` : `${zh}(${RANK_ORDER[rank as Exclude<Rank, 'bomb'>]})`
}

function scorePair(score: { white: number; black: number }): string {
  return `${fmt(score.white)} – ${fmt(score.black)}`
}

function plyList(plies: readonly number[]): string {
  return plies.length === 0 ? '—' : plies.join(', ')
}

// ---------------------------------------------------------------------------
// Move notation
// ---------------------------------------------------------------------------

/**
 * Coordinate notation for one logged ply: `e2e4`, `b7a8q`, `O-O`, `pass`.
 *
 * `moveToNotation` is deliberately NOT used here. It renders `Move.promote`,
 * which is the promotion the mover ASKED for — and a pawn that loses or ties on
 * the 8th rank never promotes (§6：僅存活的 pawn 升變). Printing `b7a8q` for a
 * pawn that died on a8 would put a queen in the record that never existed, and
 * a record that lies about the board is worse than no record. The suffix comes
 * from `GameEvent.promoted`, which the engine writes only when the promotion
 * actually happened.
 */
function plyNotation(e: GameEvent): string {
  switch (e.move.kind) {
    case 'pass':
      return 'pass'
    case 'castle':
      return e.move.side === 'king' ? 'O-O' : 'O-O-O'
    case 'move': {
      const suffix = e.promoted ? CARRIER_LETTER[e.promoted].toLowerCase() : ''
      return `${squareName(e.move.from)}${squareName(e.move.to)}${suffix}`
    }
  }
}

/**
 * The public announcement for a contact, in words.
 *
 * Every rank named below is a field of the outcome, i.e. 公告 by §4「翻明總表」.
 * The 有煙無傷 line states what was announced (a 爆裂物 was lost, nobody was
 * 翻明) and stops there: naming the survivor as "工兵 or 軍旗" would be 解算.
 *
 * The 同歸於盡 line names 爆裂物 without attributing one to anybody, which is
 * the opposite of 解算: the event carries no rank and no colour, and the line
 * exists to say so. A reader who is not told that the announcement is ambiguous
 * by construction will read it as a rank tie and start counting bombs off the
 * log — the exact inference the single announcement was introduced to kill.
 */
function outcomeText(e: GameEvent): string {
  if (!e.combat) return ''
  const { outcome, defenderSquare, survivorSquare } = e.combat
  // en passant is the one capture whose contact square is not the destination,
  // so naming only the defender's square reads as two unrelated squares
  const to = e.move.kind === 'move' ? e.move.to : null
  const where =
    to !== null && to !== defenderSquare
      ? `${squareName(defenderSquare)} (en passant, ${squareName(e.move.kind === 'move' ? e.move.from : defenderSquare)}→${squareName(to)})`
      : squareName(defenderSquare)
  const mover = colorLabel(e.color)
  const other = colorLabel(opposite(e.color))

  switch (outcome.kind) {
    case 'attacker-wins':
      return `${where}: ${mover} wins — 翻明 ${rankText(outcome.winnerRank)}; ${other}'s piece removed`
    case 'defender-wins':
      return `${where}: ${other} holds — 翻明 ${rankText(outcome.winnerRank)}; ${mover}'s piece removed`
    case 'mutual-destruction':
      return `${where}: 同歸於盡 — both removed, nobody is 翻明. An equal 兵種 and a 爆裂物 announce identically; the record cannot say which this was`
    case 'fizzle': {
      const stands = survivorSquare === null ? where : squareName(survivorSquare)
      const survivor = colorLabel(outcome.survivorColor)
      const loser = colorLabel(opposite(outcome.survivorColor))
      return `${where}: 有煙無傷 — ${loser}'s 爆裂物 is lost, ${survivor}'s piece survives on ${stands}; nobody is 翻明`
    }
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

interface ResultLabel {
  /** the win condition by name: 奪旗 / 分數 / 停滯 / 超時 / 認輸 */
  condition: string
  /** what that condition means, in one clause */
  gloss: string
  winner: Color | null
  draw: boolean
}

function resultLabel(r: Result): ResultLabel {
  switch (r.kind) {
    case 'flag':
      return {
        condition: '奪旗',
        gloss: "the loser's 軍旗 left the board",
        winner: r.winner,
        draw: false,
      }
    case 'flag-both':
      return {
        condition: '奪旗',
        gloss: 'both 軍旗 left the board on the same ply — the only draw in the game',
        winner: null,
        draw: true,
      }
    case 'score':
      return { condition: '分數', gloss: 'the score target was reached', winner: r.winner, draw: false }
    case 'no-progress':
      return {
        condition: '停滯',
        gloss: 'the stagnation limit ran out; the higher score took it',
        winner: r.winner,
        draw: false,
      }
    case 'timeout':
      return { condition: '超時', gloss: 'the clock ran out', winner: r.winner, draw: false }
    case 'resign':
      return { condition: '認輸', gloss: 'the opponent resigned', winner: r.winner, draw: false }
  }
}

/** Who was ahead on points, or null when the score was exactly level. */
function pointLeader(vs: ViewerState): Color | null {
  if (vs.score.white > vs.score.black) return 'white'
  if (vs.score.black > vs.score.white) return 'black'
  return null
}

/**
 * Result + final score + the relation between them.
 *
 * The third line is the whole reason this block is not just "White wins 8–6.5":
 * a game can end on 奪旗, 超時 or 認輸 while the LOSER is far ahead on points,
 * and a record that prints only the score hides the most interesting thing that
 * happened in it.
 */
/**
 * The board as it stood when the record was taken.
 *
 * Added because a real game turned on something no move log makes visible: a
 * player parked their 軍旗 on a 結算格 and collected income from it for 21 plies.
 * Reading that off 48 rows of coordinates means replaying the game by hand. One
 * diagram shows it at a glance.
 *
 * 兵種 are printed exactly where `ViewerState` carries one, so a live export
 * shows only 翻明 pieces and the viewer's own, and a finished one shows
 * everything (§10.5). Nothing is inferred.
 */
function finalBoardLines(vs: ViewerState): string[] {
  const bySquare = new Map<Square, ViewerPiece>()
  for (const p of vs.pieces) if (p.square !== null) bySquare.set(p.square, p)

  const scoring = new Set(vs.config.scoringSquares)
  const out: string[] = []
  out.push('```')
  out.push('    a   b   c   d   e   f   g   h')
  for (let rank = 7; rank >= 0; rank--) {
    const cells: string[] = []
    for (let file = 0; file < 8; file++) {
      const sq = rank * 8 + file
      const piece = bySquare.get(sq)
      const mark = scoring.has(sq) ? '*' : ' '
      if (piece === undefined) {
        cells.push(`${mark}.  `)
        continue
      }
      const letter = CARRIER_LETTER[piece.carrier as Carrier]
      const glyph = piece.color === 'white' ? letter.toUpperCase() : letter.toLowerCase()
      cells.push(`${mark}${glyph}${piece.revealed ? '!' : ' '} `)
    }
    out.push(`${rank + 1}  ${cells.join('')}`)
  }
  out.push('```')
  out.push('')
  out.push(
    'UPPERCASE = White · `*` marks a 結算格 · `!` marks a piece whose 兵種 is 翻明.',
  )
  out.push('')

  const listed = [...bySquare.entries()]
    .filter(([, p]) => p.rank !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([sq, p]) => `${squareName(sq)} ${p.carrier} ${RANK_NAMES_ZH[p.rank as Rank]}`)
  for (let i = 0; i < listed.length; i += 4) {
    out.push(listed.slice(i, i + 4).join(' · '))
  }
  if (listed.length > 0) out.push('')
  return out
}

function resultLines(vs: ViewerState): string[] {
  const out: string[] = []

  if (vs.status.kind !== 'over') {
    out.push(
      vs.status.kind === 'setup'
        ? 'Not started — both sides are still assigning 兵種 (§9).'
        : `In progress — ply ${vs.ply}, ${colorLabel(vs.toMove)} to move.`,
    )
    out.push('')
    out.push(`Score so far: White ${fmt(vs.score.white)} – Black ${fmt(vs.score.black)}.`)
    return out
  }

  const label = resultLabel(vs.status.result)
  out.push(
    label.draw
      ? `**Draw** — ${label.condition} (${label.gloss}).`
      : `**${colorLabel(label.winner!)} wins** — ${label.condition} (${label.gloss}).`,
  )
  out.push('')
  out.push(`Final score: White ${fmt(vs.score.white)} – Black ${fmt(vs.score.black)}.`)

  const leader = pointLeader(vs)
  if (leader === null) {
    out.push('The score was level at the end.')
  } else if (label.winner === null) {
    out.push(`${colorLabel(leader)} led on points at the end.`)
  } else if (leader === label.winner) {
    out.push(`Won on ${label.condition}; ${colorLabel(label.winner)} also led on points.`)
  } else {
    const margin = Math.abs(vs.score.white - vs.score.black)
    out.push(
      `Won on ${label.condition} while ${colorLabel(leader)} led on points by ${fmt(margin)}`
      + ' — the score alone hides that.',
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Deployments (§9)
// ---------------------------------------------------------------------------

export interface DeploymentPiece {
  square: Square
  square_name: string
  carrier: Carrier
  rank: Rank
}

export interface Deployment {
  color: Color
  /** the 16-character setup code, the same format the LLM interface deploys with */
  code: string
  pieces: DeploymentPiece[]
}

/**
 * A side's whole deployment, or null when this view is not entitled to all of it.
 *
 * `encodeSetupCode` throws the moment one of the 16 兵種 is redacted, and that
 * throw IS the entitlement check — there is no path here that assembles a
 * partial army out of the ranks that happen to be visible.
 *
 * Callers withhold deployments entirely until 終局 — see deploymentLines() for
 * why. This function stays willing; the decision is made one level up, in both
 * the markdown and the JSON path.
 *
 * Squares and carriers come from the fixed §9 opening layout, not from the
 * pieces' current state: a deployment is what was assigned before ply 1, and
 * 升變 changes the carrier layer afterwards (§1).
 */
function deploymentFor(vs: ViewerState, color: Color): Deployment | null {
  let code: string
  try {
    code = encodeSetupCode(vs, color)
  } catch {
    return null
  }

  const rankById = new Map<PieceId, Rank | null>()
  for (const p of vs.pieces) {
    if (p.color === color) rankById.set(p.id, p.rank)
  }

  const pieces: DeploymentPiece[] = []
  for (const slot of setupCodeSlots(color)) {
    const rank = rankById.get(slot.id) ?? null
    if (rank === null) return null      // unreachable: encodeSetupCode already threw
    pieces.push({
      square: slot.square,
      square_name: squareName(slot.square),
      carrier: slot.carrier,
      rank,
    })
  }
  return { color, code, pieces }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function viewerLine(vs: ViewerState): string {
  const self = viewerColor(vs.viewer)
  switch (vs.viewer.kind) {
    case 'player':
      return `Exported from ${colorLabel(self!)}'s own view (player).`
    case 'spectator':
      return `Exported from a spectator bound to ${colorLabel(self!)} — identical to that player's view (§10).`
    case 'spectator-public':
      // The strictest viewer there is: 翻明 兵種 and announced events, nothing
      // else. Worth stating on the record itself, because it is the one export
      // that is safe to hand to anyone while the game is still running.
      return "Exported from the public spectator view — only 翻明 兵種 and announced events (§10.1). No side's hidden army is in this record."
    case 'omniscient':
      return 'Exported from the omniscient replay view — every 兵種 is public here.'
    case 'replay-player':
      return `Exported from the replay view of ${colorLabel(self!)}.`
  }
}

function provenanceLines(vs: ViewerState): string[] {
  const out = [viewerLine(vs)]
  out.push(
    vs.status.kind === 'over'
      ? 'The game is finished, so every 兵種 is in this record (§10 終局公開全部兵種).'
      : '兵種 this view is not entitled to are absent from this record — not hidden in it.'
      + ' 紀錄給，解算不給 (§10): the log is here, the reading of it is yours.',
  )
  return out
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The 兵種 table THIS game was played with (§2, 附錄 B).
 *
 * Read off `config.distribution`, not the default preset: 兵種數量配置 is a
 * tunable, and the whole point of recording it is that a record played under
 * 工兵4 must not claim it was played under 工兵2. A game tuned to test a
 * distribution is exactly the game whose record is worth keeping.
 *
 * Kept to ONE line on purpose. It names every 兵種 that exists, so it is the one
 * place in the record where a rank name appears without belonging to anybody —
 * a reader (or a test) grepping the record for a rank must be able to lift this
 * single line out and know the rest is attribution.
 */
const DISTRIBUTION_LINE_PREFIX = '- 兵種 distribution (§2, per side):'

function distributionLine(vs: ViewerState): string {
  const d = vs.config.distribution
  const items = ALL_RANKS.map((r) => `${RANK_NAMES_ZH[r]}×${d[r]}`).join(' · ')
  const total = ALL_RANKS.reduce((n, r) => n + d[r], 0)
  return `${DISTRIBUTION_LINE_PREFIX} ${items} — ${total} per side`
}

/**
 * The settings the game was played under.
 *
 * A recorded game is worthless for tuning if you cannot tell which knobs
 * produced it (附錄 B), so every tunable is printed, and the scoring squares are
 * printed BY NAME — `[27,28,35,36]` is unreadable and an off-by-one in it is
 * invisible.
 */
function configLines(vs: ViewerState): string[] {
  const c = vs.config
  const squares = c.scoringSquares.length === 0
    ? 'none — no piece scores by standing anywhere'
    : `${c.scoringSquares.map(squareName).join(' ')} (${c.scoringSquares.length})`

  const clock = c.clockEnabled
    ? `${clockText(c.clockInitialMs)} + ${clockText(c.clockIncrementMs)} per move`
      + ` · setup limit ${clockText(c.setupTimeoutMs)}`
    : `disabled · setup limit ${clockText(c.setupTimeoutMs)}`

  return [
    `- 分數線 X (score target): ${fmt(c.scoreTarget)}`,
    `- 停滯 N (no-progress full turns): ${fmt(c.noProgressTurns)}`,
    `- 貼目 komi: ${fmt(c.komi)}, credited to Black before ply 1`,
    `- Scoring squares (結算格): ${squares}`,
    `- Clock (讀秒): ${clock}`,
    distributionLine(vs),
  ]
}

// ---------------------------------------------------------------------------
// exportMarkdown
// ---------------------------------------------------------------------------

function moveLogLines(vs: ViewerState): string[] {
  if (vs.log.length === 0) return ['(no moves yet)']

  const out = [
    '| Ply | Side | Move | Announced outcome | Score W–B |',
    '| ---: | :---: | :--- | :--- | :--- |',
  ]
  for (const e of vs.log) {
    const outcome = e.combat ? outcomeText(e) : '—'
    out.push(
      `| ${e.ply} | ${e.color === 'white' ? 'W' : 'B'} | ${plyNotation(e)} `
      + `| ${outcome} | ${scorePair(e.scoreAfter)} |`,
    )
  }
  return out
}

/**
 * Deployments are withheld while the game is live.
 *
 * The intended use of this export is pasting it into a chat window — which,
 * when the opponent is an LLM, is the very window the opponent reads. A
 * mid-game record carrying the exporter's own 16 兵種 hands over their entire
 * army, and no footer warning survives a copy-paste. Nothing is lost by
 * waiting: you already know your own deployment, and at 終局 the view carries
 * both sides in full (gamebook §10.5), which is when a record is worth keeping
 * anyway.
 */
function deploymentLines(vs: ViewerState): string[] {
  if (vs.status.kind !== 'over') {
    return [
      '_Withheld while the game is live._ This record is therefore safe to paste'
      + ' anywhere, including a chat window your opponent can read. Both'
      + ' deployments appear here once the game ends.',
      '',
    ]
  }

  const out: string[] = []
  for (const color of COLORS) {
    const d = deploymentFor(vs, color)
    if (d === null) {
      out.push(
        `**${colorLabel(color)}** — not in this record: this view does not hold all 16 兵種`
        + ' for that side.',
      )
      out.push('')
      continue
    }
    out.push(`**${colorLabel(color)}** — setup code \`${d.code}\``)
    out.push('')
    const cells = d.pieces.map(
      (p) => `${p.square_name} ${p.carrier} ${RANK_NAMES_ZH[p.rank]}`,
    )
    for (let i = 0; i < cells.length; i += 4) {
      out.push(cells.slice(i, i + 4).join(' · '))
      out.push('')
    }
  }
  return out
}

function statsLines(vs: ViewerState, stats: GameStats): string[] {
  const w = stats.sides.white
  const b = stats.sides.black
  const out: string[] = []

  out.push(
    `${stats.pliesPlayed} plies · ${stats.contacts} contacts.`
    + ' All of it read off the public log.',
  )
  out.push('')

  out.push('| Contact outcome | Count |')
  out.push('| :--- | ---: |')
  for (const kind of OUTCOME_KINDS) {
    out.push(`| ${OUTCOME_LABEL[kind]} | ${stats.contactsByOutcome[kind]} |`)
  }
  out.push('')

  const m = stats.mutualDestruction
  out.push(
    `**同歸於盡 ${m.mutual}/${m.contests} 全部接觸**`
    + (m.ratio === null ? '' : ` (${fmt(m.ratio)})`),
  )
  out.push('')
  out.push(
    '> This is NOT the 同階雙亡/階級對決 tie rate this line used to carry, and it'
    + ' must not be checked against the ~18% expectation in notebook §4.1.'
    + ' 同歸於盡 is one announcement covering an equal 兵種, a 爆裂物 taking an'
    + ' ordinary piece, and 爆裂物 vs 爆裂物, and it carries nothing — so the rank'
    + ' ties can no longer be lifted out of the numerator, nor the bomb contacts'
    + ' out of the denominator. It runs higher than the old figure for exactly that'
    + ' reason. The rank-tie rate is not derivable from a log any more; measuring'
    + ' it takes an instrumented engine. Read the fraction, not the ratio — the'
    + ' denominator is small and this is the noisiest number in the system.',
  )
  out.push('')

  // Own settlements, which are two plies apart, so the span is read off the run
  // rather than derived from its length.
  const zeroRun = (s: SideStats): string => {
    if (s.longestZeroRun.length === 0) return '0 — never settled for zero'
    return `${s.longestZeroRun.length} (plies ${s.longestZeroRun.startPly!}–${s.longestZeroRun.endPly!})`
  }

  const bombsKnown = (s: SideStats): string => `${s.bombsLost.known}`

  const bombsActual = (s: SideStats): string =>
    s.bombsLost.actual === null ? 'not derivable yet' : `${s.bombsLost.actual}`

  const peakHeld = (s: SideStats): string =>
    s.peakSquaresHeld.ply === null
      ? '0 — never held one'
      : `${s.peakSquaresHeld.count} (first on ply ${s.peakSquaresHeld.ply})`

  const objective = (s: SideStats): string =>
    s.objectiveMoves.ratio === null
      ? '— (no moves)'
      : `${s.objectiveMoves.count} of ${s.objectiveMoves.total} (${fmt(s.objectiveMoves.ratio)})`

  const pieceRun = (s: SideStats): string =>
    s.longestSinglePieceRun.startPly === null
      ? '0 — never moved a piece'
      : `${s.longestSinglePieceRun.length} (from ply ${s.longestSinglePieceRun.startPly})`

  out.push('| Per side | White | Black |')
  out.push('| :--- | ---: | ---: |')
  out.push(`| Total score (貼目 included) | ${fmt(w.score)} | ${fmt(b.score)} |`)
  // TWO rate rows, and they are two measurements now. They were one when both
  // sides settled on every ply: a piece on a scoring square scored a point per
  // ply, so "squares held" and "points per ply" differed only by 貼目/plies and
  // printing both invited a reader to hunt for a difference that was not there.
  // Under mover-only settlement a side is settled on half the plies, so the two
  // stand about a factor of two apart — points per ply keeps GAME LENGTH as its
  // denominator, which is what 分數線 X is checked against, while the mean below
  // is per own 結算 and is the mean of the same series `peakSquaresHeld` maxes.
  out.push(
    `| Points per ply (貼目 included) | ${fmt(w.pointsPerPly)} | ${fmt(b.pointsPerPly)} |`,
  )
  out.push(
    `| Mean squares held per own 結算 | ${fmt(w.earnedPerSettlement)} `
    + `| ${fmt(b.earnedPerSettlement)} |`,
  )
  out.push(`| Peak scoring squares held at once | ${peakHeld(w)} | ${peakHeld(b)} |`)
  out.push(
    `| Own 結算 scoring zero | ${w.zeroSettlements} of ${w.settlements} `
    + `| ${b.zeroSettlements} of ${b.settlements} |`,
  )
  out.push(`| Longest zero-income run (own 結算) | ${zeroRun(w)} | ${zeroRun(b)} |`)
  out.push(`| Moves ending on a scoring square | ${objective(w)} | ${objective(b)} |`)
  out.push(`| Distinct pieces moved | ${w.distinctPiecesMoved} | ${b.distinctPiecesMoved} |`)
  out.push(`| Longest run on one piece | ${pieceRun(w)} | ${pieceRun(b)} |`)
  out.push(`| 爆裂物 KNOWN lost (有煙無傷 only) | ${bombsKnown(w)} | ${bombsKnown(b)} |`)
  out.push(`| …on plies | ${plyList(w.bombsLost.knownPlies)} | ${plyList(b.bombsLost.knownPlies)} |`)
  out.push(`| 爆裂物 truly lost (終局 only) | ${bombsActual(w)} | ${bombsActual(b)} |`)
  out.push('')
  out.push(
    '> The two 爆裂物 rows answer different questions, and the top one is a FLOOR,'
    + ' not a count. 同歸於盡 announces nothing, so a 爆裂物 that did its job is'
    + ' indistinguishable from an equal-兵種 trade and never appears in the log at'
    + ' all; the one contact that still names a 爆裂物 is 有煙無傷, where it was'
    + ' lost and the other piece survived. The true row is counted off the piece'
    + ' list and exists only at 終局, where §10.5 opens every 兵種. Never read a'
    + ' live figure against a finished one.',
  )
  out.push('')
  out.push(
    '> §7 settles after every ply but credits only the side that just moved, so a'
    + ' side is settled on its OWN plies and on no others. The mean and the peak'
    + ' above are the mean and the max of that one series — the squares a side was'
    + ' standing on at each of its settlements — and the zero rows count the'
    + ' settlements that paid nothing, out of the settlements it had. A pass'
    + ' settles too (the passer is the mover) but is not a move, so it is in'
    + ' neither move row: it costs a side nothing in the ratio and does not break a'
    + ' one-piece run. 王車易位 counts once, by the square the king landed on.',
  )
  return out
}

/**
 * The whole record as Markdown — the thing the owner pastes into a chat window
 * and argues with a model about. Order is fixed and load-bearing: result, then
 * the settings that produced it, then the log, then the deployments, then the
 * numbers.
 */
export function exportMarkdown(vs: ViewerState): string {
  const stats = gameStats(vs)
  const lines: string[] = []

  lines.push(`# 行軍西洋棋 — game ${vs.id}`)
  lines.push('')
  lines.push(...provenanceLines(vs))
  lines.push('')

  lines.push('## Result')
  lines.push('')
  lines.push(...resultLines(vs))
  lines.push('')

  lines.push('## Configuration')
  lines.push('')
  lines.push(...configLines(vs))
  lines.push('')

  lines.push('## Move log')
  lines.push('')
  lines.push(
    'Coordinate notation. A promotion suffix appears only where the pawn actually'
    + ' promoted — a pawn that lost or tied on the 8th rank did not (§6).',
  )
  lines.push('')
  lines.push(...moveLogLines(vs))
  lines.push('')

  lines.push('## Final position')
  lines.push('')
  lines.push(...finalBoardLines(vs))

  lines.push('## Deployments')
  lines.push('')
  lines.push(...deploymentLines(vs))

  lines.push('## Statistics')
  lines.push('')
  lines.push(...statsLines(vs, stats))
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// exportJson
// ---------------------------------------------------------------------------

export interface RecordMoveJson {
  ply: number
  color: Color
  notation: string
  move_kind: 'move' | 'castle' | 'pass'
  from: Square | null
  from_name: string | null
  to: Square | null
  to_name: string | null
  castle_side: 'king' | 'queen' | null
  /** the carrier the pawn ACTUALLY became, null when nothing promoted */
  promoted: Carrier | null
  combat: {
    outcome: CombatOutcome
    attacker_square: Square
    attacker_square_name: string
    defender_square: Square
    defender_square_name: string
    survivor_square: Square | null
    survivor_square_name: string | null
  } | null
  score_after: { white: number; black: number }
  /**
   * Points credited by this ply's 結算. §7 credits only the side that just
   * moved, so the other colour's entry is 0 on every ply — a structural zero,
   * not a statement that the side held nothing.
   */
  income: { white: number; black: number }
}

export interface RecordJson {
  format: 'xiyang-record'
  version: 1
  id: string
  viewer: { kind: string; color: Color | null }
  ply: number
  to_move: Color
  status: string
  result: { kind: string; condition: string; winner: Color | null; draw: boolean } | null
  score: { white: number; black: number }
  config: {
    score_target: number
    no_progress_turns: number
    komi: number
    scoring_squares: { square: Square; name: string }[]
    clock_enabled: boolean
    clock_initial_ms: number
    clock_increment_ms: number
    setup_timeout_ms: number
    distribution: { rank: Rank; count: number }[]
  }
  moves: RecordMoveJson[]
  deployments: { white: Deployment | null; black: Deployment | null }
  /** the position as this viewer holds it; `rank` is null where it is redacted */
  position: {
    id: PieceId
    color: Color
    carrier: Carrier
    square: Square | null
    square_name: string | null
    revealed: boolean
    rank: Rank | null
  }[]
  stats: {
    plies_played: number
    contacts: number
    contacts_by_outcome: { outcome: CombatOutcome['kind']; count: number }[]
    /** renamed from `ties_per_contest`, which measured something no longer
     *  observable — see {@link MutualDestruction} */
    mutual_destruction: MutualDestruction
    sides: SideStats[]
  }
}

/**
 * The same content as the Markdown, as a plain object — for a script, not for a
 * reader. Arrays of records rather than prose, stable snake_case keys, no
 * rendering. Redaction-wise it is the Markdown's twin: every field is copied
 * from the ViewerState or derived from the public log.
 *
 * Declared `unknown` because callers should not build a hard dependency on the
 * shape; `RecordJson` is exported for the ones that want to.
 */
export function exportJson(vs: ViewerState): unknown {
  const stats = gameStats(vs)
  const income = incomePerPly(vs)

  const moves: RecordMoveJson[] = vs.log.map((e, i) => {
    const inc = income[i] ?? { white: 0, black: 0 }
    return {
      ply: e.ply,
      color: e.color,
      notation: plyNotation(e),
      move_kind: e.move.kind,
      from: e.move.kind === 'move' ? e.move.from : null,
      from_name: e.move.kind === 'move' ? squareName(e.move.from) : null,
      to: e.move.kind === 'move' ? e.move.to : null,
      to_name: e.move.kind === 'move' ? squareName(e.move.to) : null,
      castle_side: e.move.kind === 'castle' ? e.move.side : null,
      promoted: e.promoted ?? null,
      combat: e.combat
        ? {
          outcome: { ...e.combat.outcome },
          attacker_square: e.combat.attackerSquare,
          attacker_square_name: squareName(e.combat.attackerSquare),
          defender_square: e.combat.defenderSquare,
          defender_square_name: squareName(e.combat.defenderSquare),
          survivor_square: e.combat.survivorSquare,
          survivor_square_name:
            e.combat.survivorSquare === null ? null : squareName(e.combat.survivorSquare),
        }
        : null,
      score_after: { white: e.scoreAfter.white, black: e.scoreAfter.black },
      income: { white: inc.white, black: inc.black },
    }
  })

  const label = vs.status.kind === 'over' ? resultLabel(vs.status.result) : null

  const out: RecordJson = {
    format: 'xiyang-record',
    version: 1,
    id: vs.id,
    viewer: { kind: vs.viewer.kind, color: viewerColor(vs.viewer) },
    ply: vs.ply,
    to_move: vs.toMove,
    status: vs.status.kind,
    result: vs.status.kind === 'over' && label !== null
      ? {
        kind: vs.status.result.kind,
        condition: label.condition,
        winner: label.winner,
        draw: label.draw,
      }
      : null,
    score: { white: vs.score.white, black: vs.score.black },
    config: {
      score_target: vs.config.scoreTarget,
      no_progress_turns: vs.config.noProgressTurns,
      komi: vs.config.komi,
      scoring_squares: vs.config.scoringSquares.map((sq) => ({ square: sq, name: squareName(sq) })),
      clock_enabled: vs.config.clockEnabled,
      clock_initial_ms: vs.config.clockInitialMs,
      clock_increment_ms: vs.config.clockIncrementMs,
      setup_timeout_ms: vs.config.setupTimeoutMs,
      distribution: ALL_RANKS.map((rank) => ({
        rank,
        count: vs.config.distribution[rank],
      })),
    },
    moves,
    // Withheld while the game is live, exactly as in the markdown — see
    // deploymentLines(). A JSON export is if anything MORE likely to be pasted
    // somewhere mechanical, so it must not be the softer path out.
    deployments:
      vs.status.kind === 'over'
        ? { white: deploymentFor(vs, 'white'), black: deploymentFor(vs, 'black') }
        : { white: null, black: null },
    // Copied straight from the redacted view: `rank` is whatever `stateForViewer`
    // put there, null included. Nothing here re-derives one.
    position: vs.pieces.map((p) => ({
      id: p.id,
      color: p.color,
      carrier: p.carrier,
      square: p.square,
      square_name: p.square === null ? null : squareName(p.square),
      revealed: p.revealed,
      rank: p.rank,
    })),
    stats: {
      plies_played: stats.pliesPlayed,
      contacts: stats.contacts,
      contacts_by_outcome: OUTCOME_KINDS.map((kind) => ({
        outcome: kind,
        count: stats.contactsByOutcome[kind],
      })),
      mutual_destruction: stats.mutualDestruction,
      sides: [stats.sides.white, stats.sides.black],
    },
  }
  return out
}
