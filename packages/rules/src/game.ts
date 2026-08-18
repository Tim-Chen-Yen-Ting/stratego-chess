/**
 * The state machine. Gamebook §4 (位置結算), §5, §6, §7, §8.
 *
 * Every ply is two sub-steps, in this order (§7.1):
 *
 *   ① 行動階段 — move / capture / castle / pass. Two things happen here, and
 *      the order between them matters: a contact pays its 吃子得分 (§7.3), and
 *      奪旗 is decided, ending the game immediately.
 *   ② 結算階段 — the SIDE THAT JUST MOVED scores its 結算格 (§7.2). The score
 *      target (§7.5②) is then tested only when the TURN is complete — after the
 *      second player's ply, never after the first player's — and the stagnation
 *      counter (§7.5③) is likewise reckoned per full turn.
 *
 * §7.1: 分數有兩個來源. ① pays for CAPTURING, ② pays for STANDING, and the two
 * are independent. 奪旗 skips ② and only ② (§7.6「① 觸發的該手不執行結算階段」),
 * so a ply that takes the 軍旗 still banks the capture points it just earned; it
 * simply never settles and never reaches the score line.
 *
 * Two separate symmetries are being defended here, and they need two separate
 * rules: settle per PLY, decide per TURN.
 *
 * Settlement crediting the mover alone is what keeps the INCOME even. Score
 * both every ply and white banks a square from ply 2m-1 where black banks the
 * mirror-image square from ply 2m — one extra settlement per acquiring move,
 * compounding all game. Settle once per FULL TURN instead and the counting
 * evens out but the exposure does not: white's placement can be evicted before
 * it is ever counted, black's never can. Mover-only is neutral on both axes,
 * because each side banks once before the opponent can reply.
 *
 * Testing the target per turn is what keeps the MOVE COUNT even. Even settlement
 * still lets white reach X first simply by moving first: white crosses on ply
 * 2m-1 and, tested there, the game stops with black's m-th move unplayed — white
 * winning on one move it was never owed. That move is worth exactly one
 * settlement's income, which is why a komi sweep put the "fair" 貼目 at one
 * settlement's income: the same quantity, priced instead of removed. Deferring
 * the test to the close of the turn removes it, and leaves 貼目 to do its one
 * real job (§7.4), making a tie impossible.
 *
 * `applyMove` is pure: the input state is never mutated, and every mutable
 * sub-object of the returned state is freshly allocated.
 */

import { opposite, promotionRank, rankOf } from './board.js'
import { resolveCombat } from './combat.js'
import { RANK_ORDER } from './constants.js'
import { hasAnyPieceMove, matchMove, type ResolvedMove } from './moves.js'
import type {
  Color,
  CombatOutcome,
  GameConfig,
  GameEvent,
  GameState,
  Move,
  Piece,
  Rank,
  Result,
  Square,
} from './types.js'

function clonePieces(pieces: readonly Piece[]): Piece[] {
  return pieces.map((p) => ({ ...p }))
}

function initialScore(s: GameState): { white: number; black: number } {
  return { white: 0, black: s.config.komi }
}

/**
 * ② 結算 (§7.2): +1 per own piece standing on a scoring square.
 *
 * Answers "what would `color` bank right now", for any colour — `applyMove`
 * asks it about the mover only (§7.1), but a UI previewing either side's
 * holdings is a fair use of it. It reads the position it is given and nothing
 * else.
 *
 * The square list is a PARAMETER, never a module constant — callers pass
 * `state.config.scoringSquares` (附錄 B: 必須為設定值，不得寫死), so a game
 * scores the shape it was created with. This counts PIECES, not squares, so a
 * duplicate in the list cannot pay twice.
 */
export function scoringPoints(
  pieces: readonly Piece[],
  color: Color,
  scoringSquares: readonly Square[],
): number {
  let n = 0
  for (const p of pieces) {
    if (p.color === color && p.square !== null && scoringSquares.includes(p.square)) n++
  }
  return n
}

/**
 * @deprecated Former name of {@link scoringPoints}, when the squares were fixed
 * at 中央四格. Kept so existing imports resolve; the square list is now required.
 */
export const centerPoints = scoringPoints

/**
 * 階級 number for a 決定性勝負 winner, refusing 爆裂物 loudly.
 *
 * `CombatOutcome.winnerRank` is typed as the whole `Rank` union, so 'bomb' is
 * type-legal there even though `resolveCombat` provably never emits one: every
 * branch touching a 爆裂物 returns 同歸於盡 or 有煙無傷 (§5, combat.ts). RANK_ORDER
 * has no 'bomb' entry, so indexing it with one yields `undefined`, `k * undefined`
 * is NaN, and NaN would flow into `score`, into every later `scoreAfter`, and
 * into a `NaN >= scoreTarget` test that is always false — a game that silently
 * can never end on points. Throwing turns that into a visible defect.
 */
function decisiveRankOrder(winnerRank: Rank): number {
  if (winnerRank === 'bomb') {
    throw new Error('captureScore: 爆裂物 has no 階級 and never wins a 決定性勝負 (§5)')
  }
  return RANK_ORDER[winnerRank]
}

/**
 * ① 吃子得分 (§7.3): what one contact pays, to whom.
 *
 * | 事件 | 得分 |
 * |---|---|
 * | 決定性勝負 | 勝方得 k ×（勝方階級數字） |
 * | 有煙無傷   | 存活方得固定額 |
 * | 同歸於盡   | 雙方皆零分 |
 *
 * Deliberately takes the PUBLIC announcement and nothing else — no board, no
 * piece list, no loser. That is 附錄 A(d) made checkable by inspection: the only
 * 兵種 this function can see is `winnerRank`, which §4.3 forced 翻明 in the very
 * event carrying it, so the score delta of any contact is reproducible by the
 * strictest viewer in the system from its own copy of the log. The two silent
 * outcomes are silent in the score too — 同歸於盡 pays zero to BOTH sides, which
 * is what stops a 爆裂物 from being counted out of the score column, and the
 * fizzle bonus is flat, so a 工兵 survivor and a 軍旗 survivor are worth exactly
 * the same number (附錄 A(a)).
 *
 * On the direction of the multiplier: 階級 numbers run 司令 1 … 軍旗 10, so a
 * larger number is a WEAKER piece and a weak winner is paid MORE. §7.3 says so
 * outright —「階級數字越大代表越弱，故弱者獲勝得分越高」.
 *
 * `attacker` is the colour that moved into the contact; the defender is by
 * construction the other colour (a move never contacts a friendly piece).
 * Amounts come from `config`, never from a module literal (附錄 B).
 */
export function captureScore(
  outcome: CombatOutcome,
  attacker: Color,
  config: GameConfig,
): { white: number; black: number } {
  const pay = { white: 0, black: 0 }
  switch (outcome.kind) {
    case 'attacker-wins':
      pay[attacker] = config.captureScoreK * decisiveRankOrder(outcome.winnerRank)
      return pay
    case 'defender-wins':
      pay[opposite(attacker)] = config.captureScoreK * decisiveRankOrder(outcome.winnerRank)
      return pay
    case 'fizzle':
      pay[outcome.survivorColor] = config.fizzleBonus
      return pay
    case 'mutual-destruction':
      // 同歸於盡 — zero to both, and not because the amount happens to be zero:
      // §7.3 has no knob here at all. Any tribe-derived payment would name the
      // victim of a contact that announces nobody (附錄 A(d)).
      return pay
    default: {
      // A fifth CombatOutcome variant must fail the BUILD here rather than
      // quietly pay nothing.
      const unreachable: never = outcome
      throw new Error(`captureScore: unhandled outcome ${JSON.stringify(unreachable)}`)
    }
  }
}

/**
 * Did the given ply move the needle for §7.5③ — a capture, or any point scored?
 *
 * Reads the difference between consecutive `scoreAfter` entries rather than
 * asking who was to move, so it does not care that a settlement now touches one
 * side: whichever number moved, it moved.
 */
function plyHadProgress(
  log: readonly GameEvent[],
  index: number,
  base: { white: number; black: number },
): boolean {
  const e = log[index]
  if (!e) return false
  if (e.combat) return true
  const before = index > 0 ? log[index - 1]!.scoreAfter : base
  return e.scoreAfter.white !== before.white || e.scoreAfter.black !== before.black
}

/**
 * §7.5② / §7.5③ 分數高者獲勝. 貼目 is meant to make an exact tie impossible; komi is
 * a configurable knob (附錄 B) so a caller can set it to 0 and produce one
 * anyway. Deterministic fallback: the tie goes to black, the side komi exists
 * to favour.
 *
 * It also answers §7.5② correctly when only ONE side is at or past X, without
 * needing to be told which: a side under X is by definition below every side at
 * or past it, so the leader is always among the crossers.
 */
function leader(score: { white: number; black: number }): Color {
  return score.white > score.black ? 'white' : 'black'
}

/**
 * Does a ply by `mover` complete the turn?
 *
 * §9 白方先行 — white is the first player, so white opens every turn and black
 * closes it. Asked by the §7.5② score test, which may only run when both sides
 * have had the same number of moves. §7.5③ decides the same thing from ply parity
 * instead, since it is counting turns rather than judging one.
 */
function closesTurn(mover: Color): boolean {
  return mover === 'black'
}

export function isGameOver(s: GameState): boolean {
  return s.status.kind === 'over'
}

// ---------------------------------------------------------------------------
// applyMove
// ---------------------------------------------------------------------------

export function applyMove(s: GameState, move: Move): GameState {
  if (s.status.kind !== 'playing') throw new Error('game is not accepting moves')

  const mover: Color = s.toMove
  const pieces = clonePieces(s.pieces)
  const byId = new Map(pieces.map((p) => [p.id, p]))

  let resolved: ResolvedMove | null = null
  let forcedPass = false

  if (move.kind === 'pass') {
    // §3④ pass is always legal. §8: the increment is only granted when the
    // pass was FORCED, and "forced" is decided purely by carrier-layer
    // geometry, which both players can verify — it leaks no 兵種.
    forcedPass = !hasAnyPieceMove(s, mover)
  } else {
    resolved = matchMove(s, mover, move)
    if (!resolved) throw new Error(`illegal move: ${JSON.stringify(move)}`)
  }

  let combat: GameEvent['combat']
  let promoted: GameEvent['promoted']
  const recordedMove: Move = resolved ? resolved.move : { kind: 'pass' }

  // The running score. Declared up here, above ①, because §7.1 gives the score
  // TWO sources and the first of them is paid inside the action sub-step: a
  // contact's 吃子得分 (§7.3) lands in this object before 奪旗 is even decided.
  // A fresh copy — `applyMove` is pure and `s.score` is never touched.
  const score = { ...s.score }

  // ---------------------------------------------------------------- ① ACTION
  if (resolved?.castle) {
    // §1 / §5: castling only relocates the carrier layer. The 兵種 layer is
    // untouched, and this is explicitly NOT "leaving the board" for a 軍旗.
    const king = byId.get(resolved.castle.kingId)!
    const rook = byId.get(resolved.castle.rookId)!
    king.square = resolved.castle.kingTo
    king.hasMoved = true
    rook.square = resolved.castle.rookTo
    rook.hasMoved = true
  } else if (resolved) {
    const attacker = byId.get(resolved.moverId)!
    const defender = resolved.contactSquare === null
      ? undefined
      : pieces.find((p) => p.square === resolved!.contactSquare && p.id !== attacker.id)

    let attackerSurvives = true

    if (defender) {
      const r = resolveCombat(attacker.rank, defender.rank, attacker.color, defender.color)
      attackerSurvives = r.attackerSurvives

      // §4 位置結算. The losing attacker is removed FROM ITS ORIGIN and never
      // enters the target square; the defender does not move at all. For en
      // passant this also means the skipped square simply stays empty.
      if (r.attackerSurvives) {
        attacker.square = resolved.to
      } else {
        attacker.square = null
      }
      if (!r.defenderSurvives) {
        defender.square = null
      }

      // §4.3 / §4 翻明總表. Losers are never revealed, and 工兵/軍旗 beating a
      // 爆裂物 reveals nothing at all (附錄 A) — resolveCombat already encodes
      // that, so this stays a dumb transcription.
      if (r.revealAttacker) attacker.revealed = true
      if (r.revealDefender) defender.revealed = true

      // §7.3 吃子得分, paid HERE — inside ①, from the announcement that was just
      // built and from the config, never from the board or from either piece's
      // hidden 兵種. Note the payment does not follow the mover: 決定性勝負 pays
      // the WINNER, so a defender that holds its square is credited on the
      // opponent's ply, and 有煙無傷 pays whichever colour survived.
      const pay = captureScore(r.outcome, attacker.color, s.config)
      score.white += pay.white
      score.black += pay.black

      combat = {
        outcome: r.outcome,
        attackerSquare: resolved.from,
        defenderSquare: resolved.contactSquare!,
        survivorSquare: r.attackerSurvives
          ? resolved.to
          : r.defenderSurvives
            ? resolved.contactSquare!
            : null,
      }
    } else {
      attacker.square = resolved.to
    }

    attacker.hasMoved = true

    // §6 升變. Only a SURVIVING pawn promotes, and "surviving" includes the
    // 有煙無傷 case where a 工兵/軍旗 walked over a 爆裂物 onto the last rank
    // (§5) — no rank comparison happened, but the pawn is standing there.
    if (
      attackerSurvives
      && attacker.carrier === 'pawn'
      && rankOf(resolved.to) === promotionRank(attacker.color)
    ) {
      const choice = resolved.promoteTo ?? 'queen'
      attacker.carrier = choice
      promoted = choice
    }
  }

  // §7.5① 奪旗 — decided inside the ACTION sub-step, and therefore before ②
  // 結算 but AFTER the 吃子得分 above: both live in ①, and §7.6 skips 「結算階段」
  // alone. So the ply that takes a 軍旗 keeps the capture points it just earned
  // — it simply banks no 佔領分 and never reaches the score line.
  // Promotion and castling above never null a square, so they can never
  // trigger this (§5).
  const whiteFlagGone = flagIsOff(pieces, 'white')
  const blackFlagGone = flagIsOff(pieces, 'black')
  let result: Result | null = null
  if (whiteFlagGone && blackFlagGone) {
    result = { kind: 'flag-both' }            // the only draw in the game
  } else if (whiteFlagGone) {
    result = { kind: 'flag', winner: 'black' }
  } else if (blackFlagGone) {
    result = { kind: 'flag', winner: 'white' }
  }

  // ------------------------------------------------------------ ② SETTLEMENT
  let noProgressTurns = s.noProgressTurns

  if (!result) {
    // §7.2 — settlement runs after every ply, and credits ONLY the side that
    // just moved. The opponent's 結算格 are not counted here; they were counted
    // at its own last ply and will be again at its next. A piece captured in ①
    // is already off the board and does not score for this ply — including the
    // mover's own piece, if it attacked and lost. The board shape comes from
    // THIS game's config, never from a constant.
    //
    // This ADDS to whatever ① already paid: 佔領 and 吃子 are two independent
    // sources (§7.1) and a ply can collect both — an attacker that wins onto a
    // 結算格 is paid for the kill and then for standing there.
    //
    // A pass settles like anything else (§3④): the passer is the mover.
    score[mover] += scoringPoints(pieces, mover, s.config.scoringSquares)
  }

  const event: GameEvent = {
    ply: s.ply,
    color: mover,
    move: recordedMove,
    ...(combat ? { combat } : {}),
    ...(promoted ? { promoted } : {}),
    scoreAfter: { white: score.white, black: score.black },
  }
  const log = [...s.log, event]

  if (!result && closesTurn(mover)) {
    // §7.5② 先達 X 分者獲勝 — asked ONLY here, at the close of a full turn, and
    // asked of the TOTAL, which since §7.3 includes points banked from captures
    // as well as from 結算格. A capture can therefore carry a side over X — and
    // because 決定性勝負 pays the winner rather than the mover, the side carried
    // over can be the one that did not move.
    //
    // Asking it after every settlement instead ends the game on ply 2m-1 the
    // moment white crosses, with black's m-th move unplayed: white wins having
    // had one more move than black. That is not a small edge. Over 300 bot games
    // it is 55/45 on 中央四格 and 68/32 on 中央＋側翼八格, and it is worth exactly
    // one settlement's income — which is why the empirically "fair" 貼目 came out
    // at one settlement's income too. Deferring the question to the turn's close
    // deletes the extra move rather than pricing it: whenever this runs, both
    // sides have played the same number of moves.
    //
    // A side that crosses X mid-turn simply keeps playing to the end of the
    // turn. There is deliberately no 'pending win' status — scores only ever
    // rise, so a crossing cannot be undone, and the only thing the rest of the
    // turn can do is let the opponent answer: catch up on points, or end the
    // game outright with 奪旗 (§7.5①), which is decided in ① and never reaches
    // this line.
    //
    // Which makes 「若雙方於同一次結算同時越過 X」 the live case it is written as,
    // not a defensive one: white crosses on its ply, black replies over the line
    // on its own, and both are at or past X when the turn closes. 分數高者獲勝 —
    // and since 貼目 is non-integer the two scores cannot be equal.
    if (score.white >= s.config.scoreTarget || score.black >= s.config.scoreTarget) {
      result = { kind: 'score', winner: leader(score) }
    }
  }

  // §7.5③ 停滯. The counter measures FULL TURNS (white ply + black ply) in which
  // nothing was captured and neither side scored. Unchanged in meaning by
  // mover-only settlement: each side now settles exactly once per turn, so a
  // turn with no captured piece and no point is still a turn in which neither
  // side scored — it just takes one settlement per side to say so instead of
  // two. Any capture or any point zeroes it. Turns close on even plies, because
  // ply 1 is white's.
  const thisIndex = log.length - 1
  const base = initialScore(s)
  const progressNow = plyHadProgress(log, thisIndex, base)
  if (progressNow) {
    noProgressTurns = 0
  } else if (s.ply % 2 === 0 && !plyHadProgress(log, thisIndex - 1, base)) {
    noProgressTurns = s.noProgressTurns + 1
  }

  if (!result && noProgressTurns >= s.config.noProgressTurns) {
    result = { kind: 'no-progress', winner: leader(score) }
  }

  // §8 增秒: granted on a completed move, or on a forced pass. Never on a
  // voluntary pass.
  const clockMs = { ...s.clockMs }
  if (s.config.clockEnabled && (resolved !== null || forcedPass)) {
    clockMs[mover] += s.config.clockIncrementMs
  }

  return {
    id: s.id,
    pieces,
    toMove: opposite(mover),
    ply: s.ply + 1,
    score,
    log,
    clockMs,
    noProgressTurns,
    status: result ? { kind: 'over', result } : { kind: 'playing' },
    config: { ...s.config },
  }
}

/**
 * §7.5① — a side loses the instant its 軍旗 leaves the board, by any route:
 * captured, thrown at another piece, or traded off against the enemy 軍旗.
 */
function flagIsOff(pieces: readonly Piece[], color: Color): boolean {
  const flags = pieces.filter((p) => p.color === color && p.rank === 'flag')
  if (flags.length === 0) return false
  // §5.3 is「軍旗以任何方式離開棋盤，該方立即判負」— ANY, not all. `every` was
  // indistinguishable from `some` while every preset dealt exactly one 軍旗, but
  // 附錄 B made the 兵種 table a per-game setting and checkDistribution accepts
  // any table summing to 16, so a two-flag game is reachable from the API.
  return flags.some((p) => p.square === null)
}

// ---------------------------------------------------------------------------
// Terminations that do not come from a move
// ---------------------------------------------------------------------------

/** §7.5⑤ 認輸 — available at any time, including during setup. */
export function resign(s: GameState, color: Color): GameState {
  if (s.status.kind === 'over') return s
  return {
    ...s,
    pieces: clonePieces(s.pieces),
    score: { ...s.score },
    log: [...s.log],
    clockMs: { ...s.clockMs },
    config: { ...s.config },
    status: { kind: 'over', result: { kind: 'resign', winner: opposite(color) } },
  }
}

/** §7.5④ 超時 — `color`'s clock hit zero. Nothing to do with 軍旗. */
export function flagFall(s: GameState, color: Color): GameState {
  if (s.status.kind !== 'playing') return s
  return {
    ...s,
    pieces: clonePieces(s.pieces),
    score: { ...s.score },
    log: [...s.log],
    clockMs: { ...s.clockMs, [color]: 0 },
    config: { ...s.config },
    status: { kind: 'over', result: { kind: 'timeout', winner: opposite(color) } },
  }
}

/**
 * Subtract elapsed time from one side's clock, floored at zero. Pure; the
 * server owns the timer and decides when to call `flagFall`.
 */
export function tickClock(s: GameState, color: Color, elapsedMs: number): GameState {
  if (!s.config.clockEnabled) return s
  const remaining = Math.max(0, s.clockMs[color] - Math.max(0, elapsedMs))
  return {
    ...s,
    pieces: clonePieces(s.pieces),
    score: { ...s.score },
    log: [...s.log],
    clockMs: { ...s.clockMs, [color]: remaining },
    config: { ...s.config },
  }
}

/**
 * Squares that score this ply, for UI highlighting. Reads the game's own
 * config, so a board created with a different preset highlights that preset.
 *
 * Takes anything carrying a config — `GameState` and `ViewerState` both fit, so
 * a client can ask the same question of the redacted state it actually holds.
 * Returns a fresh mutable copy; the config's own list is frozen.
 */
export function scoringSquares(s: { config: GameConfig }): Square[] {
  return [...s.config.scoringSquares]
}

/**
 * @deprecated Former name of {@link scoringSquares}, when it answered from a
 * constant and took no argument. Kept so existing imports resolve.
 */
export const centerSquares = scoringSquares
