import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { castlePlan, replayGame } from '@xiyang/rules'
import type { Carrier, Color, Move, Rank, Square, Viewer, ViewerState } from '@xiyang/rules'
import { Board, type BoardProps, type MoveMarks } from '../components/Board.js'
import { CapturedTray } from '../components/CapturedTray.js'
import { SharePanel } from '../components/SharePanel.js'
import { EventLog } from '../components/EventLog.js'
import { ExportButton, ExportPanel } from '../components/ExportPanel.js'
import { PencilPanel, readDraggedRank } from '../components/PencilPanel.js'
import { RankTable } from '../components/RankTable.js'
import { ReplayBar, type Perspective } from '../components/ReplayBar.js'
import {
  CARRIER_LABEL,
  COLOR_LABEL,
  PROMOTION_CHOICES,
  RANK_LABEL,
} from '../constants.js'
import { colorLabel, formatClock, formatScore, other, resultText, squareName } from '../format.js'
import { botPolicyLabel, fetchOpponent, readBotSeat, recallBotGame } from '../socket.js'
import type { BotSeat, OpponentAnswer } from '../socket.js'
import {
  canAct,
  captureRecords,
  isPublicSpectator,
  myLegalMoves,
  pencilSeatKey,
  useStore,
  viewerColor,
} from '../store.js'

/**
 * Game screen (techspec §7).
 *
 * Everything clickable here is derived from `view.legalMoves`, which the server
 * sends only to the player to move. The client computes no legality, no
 * combat forecast and no candidate-rank sets (gamebook §10) — it renders the
 * ViewerState and emits Moves.
 *
 * Layout: move history left, board centre, captured pieces right, with the
 * static 兵種 reference under the history and the player's own pencil notepad
 * under the captured tray. The board keeps its natural size — `--sq` is a vmin
 * clamp, and the centre grid column is `min-content`, so the side columns give
 * way first and the whole thing folds to one column when it no longer fits.
 *
 * `captures` is the one derived structure this screen builds: piece id → the
 * public event that removed it, replayed off `view.log` (see `captureRecords`).
 * It is the log re-indexed, so the captured tray can put an announcement beside
 * the piece it was about. Nothing downstream turns it into a candidate set.
 *
 * THREE KINDS OF VIEWER REACH THIS SCREEN (gamebook §10.1): a player, a
 * 綁定觀戰者 tied to one player's view, and the 公開觀戰者 — which owns no
 * colour and is therefore the strictest of the three. What the last one gets is
 * what both players commonly know and nothing else: the board, the public log,
 * the 翻明 ranks, the captured tray, the score and the clock. Every subtraction
 * below (`publicView`) removes an affordance that presumes a seat — moving,
 * passing, resigning, promoting, annotating — and removes no information, since
 * the payload never held any it should not have: `stateForViewer` already
 * decided that server-side, which is why 匯出 stays available untouched.
 *
 * ── ONCE THE GAME IS OVER: the same board becomes a replay ─────────────────
 *
 * `status.kind === 'over'` and nothing else switches this on. Not a second
 * screen, not a second link — the board in the middle of this page starts
 * stepping. §10.1 lists 回放觀看者 as a viewer type that may switch between
 * 全知者視角 and either player's, and that is exactly the three-position toggle
 * under the board.
 *
 * THE ONE RULE THAT MATTERS HERE, and every line below is arranged to make
 * breaking it awkward: **a rank on screen at ply N must be one the chosen
 * viewer was entitled to at ply N**, decided by the engine's own rule.
 *
 *   · `replayGame(view, viewer)` returns one `ViewerState` per position, each
 *     already redacted for that viewer at that ply by `stateForViewer` →
 *     `entitledToRank`. THAT is where entitlement is decided. This file owns no
 *     copy of the policy, does not filter `pieces`, does not consult
 *     `revealed`, and does not know what §10 says about who may see what.
 *   · Everything the board and the side panels draw comes from `shownView` —
 *     the frame — and never from `view`, which is the finished game and
 *     therefore holds every 兵種 (§10.5). Reading a rank off `view` while
 *     showing ply 10 is the single mistake this feature can make, and it is
 *     the reason `shownView` exists as one binding rather than a per-panel
 *     choice. `view` survives only for things that are not the position: which
 *     mode we are in, the game id, the seat, the share token, the bot chip.
 *   · A player perspective therefore shows less than the finished game, on
 *     purpose. That is the whole point of it: replaying through the loser's
 *     eyes answers「它下那一手時知道什麼」, which is what debugging a bot needs.
 *   · The last ply is the exception and it is the rules', not ours: §10.5 opens
 *     every 兵種 at 終局, so all three perspectives agree there. The bar says so
 *     rather than leaving it looking like a leak.
 *
 * The 公開紀錄 is a different question and stays whole — see EventLog.
 */

interface GameProps {
  view: ViewerState
}

/** The board-click subset of Move; castling and passing use buttons. */
type BoardMove = Extract<Move, { kind: 'move' }>

interface PendingPromotion {
  from: Square
  to: Square
  options: BoardMove[]
}

export function Game({ view }: GameProps) {
  const [shareOpen, setShareOpen] = useState(false)
  const shareToken = useStore((st) => st.token)
  const sendMove = useStore((s) => s.sendMove)
  const sendResign = useStore((s) => s.sendResign)
  const viewAt = useStore((s) => s.viewAt)

  // 玩家標記 — client-only guesses (gamebook §10). Never sent anywhere.
  const pencilMarks = useStore((s) => s.pencilMarks)
  const loadPencilMarks = useStore((s) => s.loadPencilMarks)
  const addPencilMark = useStore((s) => s.addPencilMark)
  const togglePencilMark = useStore((s) => s.togglePencilMark)
  const clearPencilMark = useStore((s) => s.clearPencilMark)
  const clearPencilMarks = useStore((s) => s.clearPencilMarks)

  const [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<PendingPromotion | null>(null)
  /** 匯出 — the record, for reading elsewhere. See ExportPanel. */
  const [exportOpen, setExportOpen] = useState(false)
  const [draggingRank, setDraggingRank] = useState<Rank | null>(null)
  /** which enemy square has the notepad popover open on the board, if any */
  const [pencilOpen, setPencilOpen] = useState<Square | null>(null)

  const me = viewerColor(view.viewer)
  const seated = canAct(view)
  /** no colour, no seat, no army — see the header note */
  const publicView = isPublicSpectator(view)
  const playing = view.status.kind === 'playing'
  // `me === view.toMove` and not `me ?? …`: a null colour is nobody's turn.
  const myTurn = seated && me === view.toMove && playing

  const moves = myLegalMoves(view)

  /*
   * ---- 回放 (§10.1 回放觀看者) ---------------------------------------------
   *
   * See the header note for the entitlement contract. In short: `replayGame`
   * decides what each frame may contain, this screen decides which frame is on
   * screen, and the two jobs do not overlap.
   */
  const over = view.status.kind === 'over'
  const [perspective, setPerspective] = useState<Perspective>('omniscient')
  const [autoPlay, setAutoPlay] = useState(false)

  /**
   * Which viewer the frames are built for. This is the ENTIRE information-model
   * consequence of the toggle: pick a `Viewer`, hand it to the engine, draw what
   * comes back. `replay-player` is the §10.1 回放觀看者 in player mode and is
   * already part of the engine's `Viewer` union — not a client invention.
   */
  const replayViewer: Viewer = useMemo(
    () =>
      perspective === 'omniscient'
        ? { kind: 'omniscient' }
        : { kind: 'replay-player', color: perspective },
    [perspective],
  )

  /**
   * One redacted state per position. Null while the game is live — this whole
   * mode exists only after 終局, when §10.5 has opened every 兵種 and the payload
   * in hand therefore contains enough to rebuild the game from ply 1.
   *
   * The catch is not distrust of the engine, it is a promise about this screen:
   * a throw here would white-screen a finished game for everyone looking at it,
   * including the two people who just played it. The fallback is precisely
   * today's behaviour — the static final board — so it cannot show anything the
   * viewer is not entitled to; it can only fail to offer the transport.
   */
  const frames = useMemo<ViewerState[] | null>(() => {
    if (!over) return null
    try {
      const built = replayGame(view, replayViewer)
      return built.length > 0 ? built : null
    } catch (err) {
      console.error('replayGame failed; falling back to the static final board', err)
      return null
    }
  }, [over, view, replayViewer])

  /**
   * -1 means「the end」. A finished game must open on the position it already
   * ended at — the board must not jump back to the opening the instant the last
   * move lands — and the sentinel says that without needing a frame count at
   * `useState` time, which would flash the opening for one paint on a page load
   * that arrives to an already-finished game.
   */
  const [replayIndex, setReplayIndex] = useState(-1)
  useEffect(() => {
    setReplayIndex(-1)
    setAutoPlay(false)
  }, [view.id])

  const replaying = frames !== null
  const lastIndex = frames === null ? 0 : frames.length - 1
  const frameIndex = frames === null ? 0 : replayIndex < 0 ? lastIndex : Math.min(replayIndex, lastIndex)

  const seekReplay = useCallback(
    (next: number) => setReplayIndex(Math.max(0, next)),
    [],
  )

  /**
   * THE position on screen. Live: the payload. Replay: the frame, redacted for
   * the chosen perspective at that ply by the engine.
   *
   * Everything positional below reads THIS and not `view` — see the header note.
   */
  const shownView: ViewerState = frames === null ? view : (frames[frameIndex] ?? view)

  /**
   * The colour whose knowledge the frames were built for, or null for 全知.
   * Read off the `Viewer` this screen constructed, so it cannot drift from what
   * was actually asked for. Live, it is just the seat.
   */
  const shownMe = replaying ? viewerColor(replayViewer) : me

  /**
   * frame index → the ply that frame just played, and back again.
   *
   * Derived from the frames' own logs rather than assumed from the index, so
   * this survives any reasonable choice `replayGame` makes about whether the
   * opening position is a frame of its own.
   */
  const plyOfFrame = useMemo<(number | null)[]>(
    () => (frames ?? []).map((f) => (f.log.length === 0 ? null : f.log[f.log.length - 1].ply)),
    [frames],
  )
  const frameOfPly = useMemo(() => {
    const map = new Map<number, number>()
    plyOfFrame.forEach((ply, i) => {
      if (ply !== null && !map.has(ply)) map.set(ply, i)
    })
    return map
  }, [plyOfFrame])

  /** A clicked log row. Unknown plies are ignored rather than guessed at. */
  const jumpToPly = useCallback(
    (ply: number) => {
      const target = frameOfPly.get(ply)
      if (target === undefined) return
      setAutoPlay(false)
      setReplayIndex(target)
    },
    [frameOfPly],
  )

  const currentPly = replaying ? (plyOfFrame[frameIndex] ?? null) : null
  /** the event the board is showing, i.e. the last one in the frame's own log */
  const currentEvent =
    shownView.log.length > 0 ? shownView.log[shownView.log.length - 1] : undefined

  /**
   * THIS ply's income (§7.1 — only the side that just moved settles, so one of
   * these is always 0). The running totals are already on every log row; the
   * per-ply delta is the number that is nowhere else, which is why it goes in
   * the scoreboard and why the 結算格 are left alone — the piece standing on one
   * already carries its own colour, and tinting the square would fight the
   * 結算格 highlight that is telling you it is a scoring square at all.
   */
  const income = useMemo(() => {
    if (frames === null || frameIndex === 0) return null
    const prev = frames[frameIndex - 1]
    if (prev === undefined) return null
    return {
      white: shownView.score.white - prev.score.white,
      black: shownView.score.black - prev.score.black,
    }
  }, [frames, frameIndex, shownView.score.white, shownView.score.black])

  /*
   * ---- 機器人對局 -------------------------------------------------------
   *
   * Two facts, and only two: that the other chair holds a bot, and which policy
   * is driving it. Both are public in the sense that matters — they are how the
   * game was created, not anything about the position. The bot's 兵種 are not in
   * this payload and this screen would have nothing to draw them with if they
   * were: a bot is a PLAYER (規則書 §10.1), served
   * `stateForViewer(state, {kind:'player', color})` exactly like the human, and
   * neither side is ever handed the other's army.
   *
   * Three sources, strongest first, because this screen is reached by a fresh
   * page load that knows only its token:
   *
   *   1. a marker on the state itself, if a build ever puts one there;
   *   2. `GET /api/links/:token` — the server's own answer, and the only one
   *      that works in a browser that did not create the game;
   *   3. the local memo the create screen wrote, which paints immediately while
   *      (2) is still in flight.
   *
   * (2) is allowed to say 「human」 and retire the memo. An answer of null from
   * any of them means "did not say", never "no bot" — so a failed fetch leaves
   * whatever the weaker source knew rather than erasing it.
   */
  const [fetchedOpponent, setFetchedOpponent] = useState<OpponentAnswer>(null)
  useEffect(() => {
    if (shareToken === null) return
    let live = true
    void fetchOpponent(shareToken).then((answer) => {
      if (live) setFetchedOpponent(answer)
    })
    return () => {
      live = false
    }
  }, [shareToken])

  const rememberedBot = useMemo(
    () => (shareToken === null ? null : recallBotGame(shareToken)),
    [shareToken],
  )
  const confirmedBot: BotSeat | null =
    fetchedOpponent === null
      ? rememberedBot
      : fetchedOpponent === 'human'
        ? null
        : fetchedOpponent
  const bot = readBotSeat(view) ?? confirmedBot
  /** which seat the bot sits in: what it said, else the side I am not */
  const botColor: Color | null = bot === null ? null : (bot.color ?? (me === null ? null : other(me)))
  /** the bot is on the clock right now, and the board is waiting for it */
  const botThinking = bot !== null && playing && botColor !== null && view.toMove === botColor

  // The notepad belongs to THIS game AND THIS seat: two tabs of one browser are
  // two seats, and they must not share (or overwrite) one notepad. The
  // 公開觀戰者 draws a key of its own (`…::public`) and then never writes to it,
  // because it is shown no notepad at all — see the note beside `PencilPanel`.
  const seat = pencilSeatKey(view.viewer)
  useEffect(() => {
    loadPencilMarks(view.id, seat)
  }, [view.id, seat, loadPencilMarks])

  // piece id → the public event that removed it. Pure log bookkeeping; see the
  // header note and `captureRecords`. Built from the log of the position on
  // screen, so during a replay the tray accounts for the pieces that had left
  // BY THAT PLY and no further.
  const captures = useMemo(() => captureRecords(shownView.log), [shownView.log])

  const movesFrom = useMemo(() => {
    const m = new Map<Square, BoardMove[]>()
    for (const mv of moves) {
      if (mv.kind !== 'move') continue
      const list = m.get(mv.from)
      if (list) list.push(mv)
      else m.set(mv.from, [mv])
    }
    return m
  }, [moves])

  const castleMoves = moves.filter((m): m is Extract<Move, { kind: 'castle' }> => m.kind === 'castle')
  const passMove = moves.find((m) => m.kind === 'pass')
  const forcedPass = moves.length === 1 && passMove !== undefined

  const selectedMoves: BoardMove[] = selected === null ? [] : (movesFrom.get(selected) ?? [])
  const targets = Array.from(new Set(selectedMoves.map((m) => m.to)))

  // clear a stale selection whenever a new position arrives
  useEffect(() => {
    setSelected(null)
    setPromotion(null)
    setPencilOpen(null)
  }, [view.ply, view.status.kind])

  // --- clock ---------------------------------------------------------------
  // The server is authoritative (techspec §5). This only interpolates the
  // running side's clock between pushes so the display does not look frozen.
  const [nowPerf, setNowPerf] = useState(() => performance.now())
  useEffect(() => {
    if (!view.config.clockEnabled || !playing) return
    const id = window.setInterval(() => setNowPerf(performance.now()), 100)
    return () => window.clearInterval(id)
  }, [view.config.clockEnabled, playing])

  // CLOCKS DO NOT STEP WITH THE PLY, and must not be shown as though they do.
  // `GameEvent` records no timing, so a per-ply reading is unrecoverable —
  // `replayGame` therefore gives every frame the FINAL clock (see replay.ts §2).
  // The interpolation below only runs while `playing`, i.e. never in a replay,
  // so what a replay shows is the game's ending clock, held constant.
  const elapsed = view.config.clockEnabled && playing ? Math.max(0, nowPerf - viewAt) : 0
  const shownClock = (color: Color) =>
    Math.max(0, shownView.clockMs[color] - (shownView.toMove === color ? elapsed : 0))

  /**
   * The move the board marks. Live: from/to of the last ply, faint, as before.
   * Replay: the ply being examined, with its squares' roles named so `Board`
   * can draw it emphatically — including the §4.2 contact square, the one case
   * in the game where the fight did not happen on the destination.
   *
   * Both forms come from the same place, the last entry of the log the board is
   * rendering, and a castle is expanded through the engine's own `castlePlan`
   * (§3②) rather than by restating the geometry here.
   */
  const boardMarks = useMemo<readonly Square[] | MoveMarks>(() => {
    const ev = currentEvent
    if (ev === undefined) return []
    if (!replaying) {
      return ev.move.kind === 'move' ? [ev.move.from, ev.move.to] : []
    }
    if (ev.move.kind === 'pass') return []
    if (ev.move.kind === 'castle') {
      const plan = castlePlan(ev.color, ev.move.side)
      return {
        squares: [plan.kingFrom, plan.kingTo, plan.rookFrom, plan.rookTo],
        from: plan.kingFrom,
        to: plan.kingTo,
      }
    }
    const { from, to } = ev.move
    // en passant, and only en passant: everywhere else contact IS the
    // destination and a third mark would say nothing (§4.2).
    const contact =
      ev.combat !== undefined && ev.combat.defenderSquare !== to ? ev.combat.defenderSquare : null
    return {
      squares: contact === null ? [from, to] : [from, to, contact],
      from,
      to,
      contact,
    }
  }, [currentEvent, replaying])

  /**
   * 翻明 ranks still on the board. For a seated viewer that means the ENEMY's —
   * your own ranks are written on your own pieces already. The 公開觀戰者 has no
   * enemy, and `shownMe === null` lets both colours through, which is exactly
   * the right list for it: everything that has been announced out loud, either
   * side. The heading and the rows below say which of the two lists is on
   * screen. 全知 replay lands in the same branch for the same reason.
   *
   * `revealed` is the frame's own flag, so during a replay this is what had
   * been announced BY THAT PLY — not what the finished game knows.
   */
  const revealedRanks = shownView.pieces.filter(
    (p) => p.color !== shownMe && p.revealed && p.rank !== null && p.square !== null,
  )

  /**
   * Squares that accept a dropped pencil mark: enemy pieces on the board whose
   * 兵種 the payload does not carry. This is entitlement bookkeeping — which
   * pieces the player is allowed to scribble on — and says nothing about what
   * rank they hold. `rank === null` rather than `!revealed` so the final reveal
   * at game end (§10 終局公開全部兵種) retires the notepad too: once every rank
   * is a fact there is nothing left to guess at.
   *
   * Captured pieces are annotatable as well, but they have no square; the
   * captured tray and the pencil panel open their picker inline.
   *
   * A viewer with no colour has no enemy, so this set comes out empty — the
   * 公開觀戰者 is offered nothing to scribble on, by the same rule and not by a
   * special case.
   */
  const pencilSquares = useMemo(() => {
    const set = new Set<Square>()
    if (me === null) return set
    for (const p of view.pieces) {
      if (p.color === me || p.square === null || p.rank !== null) continue
      set.add(p.square)
    }
    return set
  }, [view.pieces, me])

  /**
   * The popover only stays open while the square is still annotatable — a piece
   * that gets captured or 翻明 takes its notepad page with it. Derived, so the
   * state can never point at a square the board no longer offers.
   */
  const pencilOpenSquare = pencilOpen !== null && pencilSquares.has(pencilOpen) ? pencilOpen : null

  // stable identity: the board hangs document listeners off this while open
  const closePencil = useCallback(() => setPencilOpen(null), [])
  // likewise — the export panel keeps an Escape listener on the document
  const closeExport = useCallback(() => setExportOpen(false), [])
  const openExport = useCallback(() => setExportOpen(true), [])

  function play(move: Move) {
    setSelected(null)
    setPromotion(null)
    setPencilOpen(null)
    sendMove(move)
  }

  function onSquareClick(sq: Square) {
    if (promotion) return

    /*
     * Left-click routing. With one of my pieces selected the click keeps its
     * move meaning — an enemy square is a capture target and the move flow is
     * never intercepted. With nothing selected there is no move in flight, so a
     * click on an annotatable enemy piece opens the notepad instead.
     */
    if (selected === null && pencilSquares.has(sq)) {
      setPencilOpen(pencilOpen === sq ? null : sq)
      return
    }
    setPencilOpen(null)

    if (!myTurn) {
      setSelected(selected === sq ? null : sq)
      return
    }
    if (selected === sq) {
      setSelected(null)
      return
    }
    if (selected !== null) {
      const candidates = (movesFrom.get(selected) ?? []).filter((m) => m.to === sq)
      if (candidates.length === 1) {
        play(candidates[0])
        return
      }
      if (candidates.length > 1) {
        // several moves share a destination: a promotion choice (techspec §3)
        setPromotion({ from: selected, to: sq, options: candidates })
        return
      }
    }
    if (movesFrom.has(sq)) setSelected(sq)
    else setSelected(null)
  }

  /** Right-click or long-press on an enemy piece: open the notepad popover. */
  function onPencilRequest(sq: Square) {
    if (!pencilSquares.has(sq)) return
    setPencilOpen(sq)
  }

  /** A rank chip dropped on an enemy piece: write the guess down, verbatim. */
  function onSquareDrop(sq: Square, e: DragEvent<HTMLElement>) {
    setDraggingRank(null)
    const rank = readDraggedRank(e.dataTransfer)
    if (rank === null) return
    const piece = view.pieces.find((p) => p.square === sq)
    if (piece === undefined) return
    addPencilMark(piece.id, rank)
  }

  function onResign() {
    if (window.confirm('確定認輸？此動作不可回復。')) sendResign()
  }

  /**
   * Everything on the board that presumes a seat, in one bundle — the move
   * flow and the notepad. The 公開觀戰者 is handed none of it and is left with
   * pieces, orientation and the last move: a board to read.
   *
   * Withholding `onSquareClick` is what makes it read-only rather than
   * politely-ignored — `Board` renders every square as a disabled button, so
   * there is no selection, no move in flight (hence no promotion picker can
   * ever be raised), no popover, no drop target, and no click that looks like
   * it did something.
   *
   * This subtracts affordances, never information: the same pieces are drawn
   * from the same payload. `origins` and `targets` are empty for this viewer
   * anyway — they are read off `legalMoves`, which the server sends only to the
   * player on turn — so what is withheld is the handles, not the view.
   *
   * A REPLAY TAKES THE SAME BUNDLE AWAY, for a different reason: the board is
   * showing a position that is over, so every handle on it would be a lie. It
   * also closes a trap. The notepad's targets are「enemy pieces whose rank the
   * payload does not carry」; at 終局 that set is empty and the notepad has
   * retired itself (§10.5), but a player-perspective FRAME has null ranks again,
   * and offering to scribble guesses onto a finished game — writing into the
   * live seat's notepad while the board shows ply 10 — is nonsense. Handing the
   * whole bundle over at once means there is no second place to get this wrong.
   */
  const seatedBoardProps: Partial<BoardProps> = publicView || replaying
    ? {}
    : {
        selected,
        targets,
        origins: myTurn ? Array.from(movesFrom.keys()) : [],
        pencilMarks,
        pencilTargets: pencilSquares,
        pencilOpen: pencilOpenSquare,
        onPencilRequest,
        onPencilClose: closePencil,
        onPencilToggle: togglePencilMark,
        onPencilClearPiece: clearPencilMark,
        dropTargets: draggingRank ? pencilSquares : undefined,
        dragActive: draggingRank !== null,
        onSquareClick,
        onSquareDrop,
      }

  /**
   * The one line under the board. It answers "what can I do right now", so the
   * seatless viewer gets the shortest answer of the three: whose move it is.
   * What the view does and does not contain is the banner's job, not this
   * line's — repeating it here would bury the only part that changes each ply.
   */
  function hintText(): string {
    // Over: the replay bar directly above this line is now the answer to「what
    // can I do」, at length. A second sentence here would only compete with it.
    if (replaying) return ''
    if (publicView) return playing ? `輪到${colorLabel(view.toMove)}行動 — 你在觀看，不參與。` : ''
    // a 綁定觀戰者 always has a colour; anything else read-only and colourless
    // says so plainly rather than printing an empty bracket
    if (!seated) {
      return me === null ? '觀看視角，僅供觀看。' : `觀戰視角（綁定${colorLabel(me)}），僅供觀看。`
    }
    if (myTurn) {
      return selected === null
        ? '點一顆有亮框的棋子，再點目標格。'
        : `已選 ${squareName(selected)} — 點目標格，或再點一次取消。`
    }
    if (!playing) return ''
    // the bot's turn already has a line of its own directly above this one
    return botThinking ? '' : '等待對手行動…'
  }

  const hint = hintText()

  return (
    <main className="screen screen-game">
      <style>{STYLE}</style>

      <header className="topbar">
        {/* Scores, clocks and — while replaying — the income of the ply on the
            board. Everything positional here reads `shownView`, so stepping a
            ply steps the scoreboard with it. */}
        <div className="scoreboard">
          <SidePanel
            color="white"
            score={shownView.score.white}
            clockMs={shownClock('white')}
            clockEnabled={view.config.clockEnabled}
            toMove={playing && shownView.toMove === 'white'}
            isMe={me === 'white'}
            income={replaying ? (income?.white ?? null) : undefined}
            justMoved={replaying && currentEvent?.color === 'white'}
          />
          <SidePanel
            color="black"
            score={shownView.score.black}
            clockMs={shownClock('black')}
            clockEnabled={view.config.clockEnabled}
            toMove={playing && shownView.toMove === 'black'}
            isMe={me === 'black'}
            income={replaying ? (income?.black ?? null) : undefined}
            justMoved={replaying && currentEvent?.color === 'black'}
          />
        </div>
        <div className="meta">
          <div>
            {/* The game's own length once it is over — 「第 87 手」 beside a
                board parked on ply 10 reads as a contradiction, and the ply the
                board IS showing is the replay bar's job to say. */}
            {replaying ? `共 ${view.log.length} 手` : `第 ${view.ply} 手`} ·{' '}
            {view.status.kind === 'over'
              ? '對局結束'
              : `輪到${colorLabel(view.toMove)}${myTurn ? '（你）' : ''}`}
          </div>
          <div className="muted small">
            分數線 {view.config.scoreTarget} · 黑方貼目 +{formatScore(view.config.komi)} · 停滯{' '}
            {shownView.noProgressTurns}/{view.config.noProgressTurns} 回合
            {/*
             * 吃子得分 (§7.3), and ONLY when this game actually pays it. Both
             * ship at 0 (附錄 B: 待定), and a permanent 「吃子 k 0」 on the
             * scoreboard would tell every existing game about a source of points
             * it does not have. Rendered as a comparison, never as the value
             * itself — `{n && …}` would print a bare 0 for the default.
             */}
            {view.config.captureScoreK > 0 && (
              <span title="決定性勝負時，勝方得 k ×（勝方階級數字）；階級 司令 1 … 軍旗 10，越弱得分越高（規則書 §7.3）">
                {' '}
                · 吃子 k {view.config.captureScoreK}
              </span>
            )}
            {view.config.fizzleBonus > 0 && (
              <span title="有煙無傷時存活方得的固定額，與存活者是工兵或軍旗無關；同歸於盡雙方皆零分（規則書 §7.3）">
                {' '}
                · 有煙無傷 +{view.config.fizzleBonus}
              </span>
            )}
          </div>
          {/* who is across the table. Says it once, permanently, so the
              thinking indicator below reads as an opponent and not a stall */}
          {bot !== null && (
            <div className="xy-bot-chip" title="機器人只收到自己視角的盤面（規則書 §10），與你拿到的是同一種資料">
              <span className="xy-bot-mark" aria-hidden="true">
                ⌬
              </span>
              <span>
                {seated ? '對手：' : ''}機器人
                {botColor === null ? '' : `（${colorLabel(botColor)}）`} ·{' '}
                {botPolicyLabel(bot.policy)}
              </span>
            </div>
          )}
        </div>
      </header>

      {/*
       * Says what this view is before anything else on the screen does. A
       * spectator who is not told they are one reads a board with no marks of
       * their own as a board where nothing has been deduced yet, and reads
       * missing controls as a bug.
       */}
      {publicView && (
        <div className="banner xy-public">
          <div className="xy-public-title">公開觀戰視角 — 你沒有陣營</div>
          {/*
           * Two truths, because 終局公開全部兵種 (§10.5) changes what this view
           * holds. Saying「未翻明的兵種一個也沒有」over a finished game, whose
           * payload now carries all thirty-two, would be the screen lying about
           * itself in the one place that exists to explain itself.
           */}
          <p className="xy-public-body">
            {view.status.kind === 'over' ? (
              <>
                對局已結束。依規則書 §10「終局公開全部兵種」，雙方的兵種現在對所有人公開，這個視角一併看到。
                對局進行中它只有<strong>雙方共同知道</strong>的部分——棋盤與載體、公開事件紀錄、已翻明的兵種、比分與時鐘——所以當時轉發這條連結不會洩漏任何一方的軍容。
              </>
            ) : (
              <>
                這個畫面只有<strong>雙方共同知道</strong>的東西：棋盤與載體、公開事件紀錄、已翻明的兵種、已離場的棋子、比分與時鐘。
                未翻明的兵種一個也沒有，兩方都沒有——不是收到了不顯示，是伺服器根本沒送（規則書 §10）。
                所以這裡不能落子、不能跳過、不能認輸，也沒有「你的棋子」可看；你手上這條連結不含任何一方的軍容，轉發出去也不會洩漏誰是什麼。
                終局時雙方兵種全部公開，這個視角會一起看到。
              </>
            )}
          </p>
        </div>
      )}

      {view.status.kind === 'over' && (
        <div className="banner xy-over">
          <span>
            {resultText(view.status.result)}
            {/* Said at the top too, not only on the bar itself. This banner is
                where the eye goes the moment a game ends, and「the board stopped
                responding」is the wrong conclusion to let anyone reach. */}
            {replaying && <span className="xy-over-replay">棋盤已切換為回放 — 見下方的回放列</span>}
          </span>
          {/* the moment the record is actually wanted — put it in the banner */}
          <ExportButton onClick={openExport} prominent />
        </div>
      )}

      <div className="xy-grid">
        {/* ---- left: the public record, then the static rules card ---- */}
        <div className="xy-col xy-col-left">
          {/*
           * THE WHOLE log, always — `view.log`, not the frame's. It is the
           * public record (§10.3, techspec §3) and it is also the index into the
           * replay: a row you cannot see is a ply you cannot jump to, and
           * jumping is how「這一手發生時盤面長什麼樣」gets answered. The panel
           * dims the rows after the position and says why.
           */}
          <EventLog
            log={view.log}
            currentPly={replaying ? currentPly : undefined}
            onSelectPly={replaying ? jumpToPly : undefined}
          />
          <RankTable />
        </div>

        {/* ---- centre: the board ---- */}
        <div className="xy-col xy-col-board">
          {/*
           * `shownView.pieces`, never `view.pieces`. During a replay those two
           * differ by exactly the ranks the chosen viewer had not earned yet —
           * which is the entire feature. See the header note.
           *
           * Orientation stays put across a perspective change on purpose:
           * flipping the board under someone who only wanted to ask what black
           * knew costs them the position they were reading.
           */}
          <Board
            pieces={shownView.pieces}
            /* A seatless viewer is not White. White at the bottom is the
               drawing convention every chess diagram uses, and orientation
               grants nothing — it is the one place a null colour may fall back
               to a side. */
            orientation={me ?? 'white'}
            lastMove={boardMarks}
            {...seatedBoardProps}
          />

          {replaying && (
            <ReplayBar
              index={frameIndex}
              maxIndex={lastIndex}
              ply={currentPly}
              mover={currentEvent?.color ?? null}
              totalPlies={view.log.length}
              onIndex={seekReplay}
              perspective={perspective}
              onPerspective={setPerspective}
              playing={autoPlay}
              onPlayingChange={setAutoPlay}
              /* a modal owns the keyboard while it is up */
              keyboard={!exportOpen && !shareOpen}
            />
          )}

          {/* seat-only by construction, with no test of its own: `promotion` is
              raised from the move flow, and a viewer whose board has no
              `onSquareClick` can never enter it (see `seatedBoardProps`) */}
          {promotion && (
            <div className="promotion">
              <span>升變為：</span>
              {PROMOTION_CHOICES.map((carrier) => {
                const move = promotion.options.find((m) => m.promote === carrier)
                if (!move) return null
                return (
                  <button type="button" key={carrier} onClick={() => play(move)}>
                    {CARRIER_LABEL[carrier]}
                  </button>
                )
              })}
              <button type="button" onClick={() => setPromotion(null)}>
                取消
              </button>
            </div>
          )}

          <div className="controls">
            {/* Share links live here as well as on the create screen: once you
                are inside your own game that screen is gone, and with it the
                only way to hand someone the public-watch link. */}
            {shareToken !== null && (
              <button type="button" onClick={() => setShareOpen(true)}>分享／觀戰連結</button>
            )}
            {/*
             * A seat's controls, and only a seat gets them. Rendering them
             * disabled for the 公開觀戰者 would advertise a chair that does not
             * exist; the server refuses these actions from a seatless token in
             * any case, so a greyed-out 認輸 would be a button that could never
             * become live.
             */}
            {!publicView && (
              <>
                <button
                  className="primary"
                  type="button"
                  disabled={!myTurn || passMove === undefined}
                  onClick={() => passMove && play(passMove)}
                  title={
                    forcedPass
                      ? '無合法移動，強制 pass — 給予增秒（§8）'
                      : '主動 pass 永遠合法，但不給增秒（§8）'
                  }
                >
                  {forcedPass ? '跳過（無合法移動）' : '跳過（pass）'}
                </button>
                {castleMoves.map((m) => (
                  <button
                    type="button"
                    key={m.side}
                    disabled={!myTurn}
                    onClick={() => play(m)}
                    title="無條件易位：雙方皆未動過且中間無子即可（規則書 §3②）"
                  >
                    {m.side === 'king' ? 'O-O 王翼易位' : 'O-O-O 后翼易位'}
                  </button>
                ))}
              </>
            )}
            {/* always available, to every viewer: the export is built from the
                ViewerState this screen already holds — redacted by the same
                path, so it can only ever contain what is on screen (規則書 §10) */}
            <ExportButton onClick={openExport} />
            {!publicView && (
              <button
                className="danger"
                type="button"
                disabled={!seated || view.status.kind === 'over'}
                onClick={onResign}
              >
                認輸
              </button>
            )}
          </div>

          {/*
           * The bot is on the clock. Without this the board simply stops
           * responding for however long the server takes, which reads as a
           * frozen page rather than as an opponent thinking — the same thing a
           * human opponent's absence would look like, and the one state where
           * this game gives no other signal.
           *
           * A pure reflection of `view.toMove`: it appears when the state says
           * the bot is to move and disappears when the next state arrives. It
           * runs no timer of its own and predicts nothing, so it can never
           * claim the bot is thinking when the server thinks otherwise.
           */}
          {botThinking && (
            <div className="xy-bot-thinking" role="status">
              <span className="xy-bot-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>機器人思考中…</span>
            </div>
          )}

          <p className="muted small">{hint}</p>

          {/*
           * 玩家標記 (§10.4) is a player writing guesses onto ENEMY pieces. The
           * 公開觀戰者 has no enemy, so there is nothing here to hide and nobody
           * to hide it from — the notepad simply has no subject and is not
           * shown. `me !== null` is the same test the notepad itself uses.
           *
           * A replay has nothing left to guess at either: the game is over and
           * §10.5 has already opened every 兵種.
           */}
          {me !== null && !replaying && (
            <p className="muted small">
              右鍵或長按敵方棋子可寫下猜測（未選取自己棋子時，左鍵點擊亦可）。已離場的棋子在「已離場棋子」面板按「標記」即可標。一顆棋子可標多個兵種；系統不驗證、不推論。
            </p>
          )}
        </div>

        {/* ---- right: what has left the board, what is known, what is guessed ---- */}
        <div className="xy-col xy-col-right">
          {/*
           * Follows the replay: at ply 10 this is what had left the board by
           * ply 10, with the announcement that took each piece. `me={null}`
           * while replaying because a replay has no seat — nobody is「你」here,
           * and the null is also what keeps the notepad's「標記」buttons off a
           * finished game whose frames have null ranks again.
           */}
          <CapturedTray
            pieces={shownView.pieces}
            me={replaying ? null : me}
            captures={captures}
            marks={pencilMarks}
            onToggleMark={togglePencilMark}
            onClearMark={clearPencilMark}
          />

          <section className="panel">
            {/* `shownMe === null` is the same question `publicView` used to ask
                here — no colour means no enemy, so the list is both sides —
                and it answers it for the 全知 replay as well. */}
            <h2>{shownMe === null ? '已翻明的兵種（雙方）' : '已翻明的敵方兵種'}</h2>
            {revealedRanks.length === 0 ? (
              <p className="muted small">尚無。</p>
            ) : (
              <ul className="revealed-list">
                {revealedRanks.map((p) => (
                  <li key={p.id}>
                    <code>{p.square !== null ? squareName(p.square) : '—'}</code>{' '}
                    {/* with both colours in one list, whose piece it is has to be
                        on the row — it is public either way (§4.3) */}
                    {shownMe === null && <span className="muted">{COLOR_LABEL[p.color]}方</span>}{' '}
                    <span className="muted">{carrierShort(p.carrier)}</span>{' '}
                    <strong>{p.rank ? RANK_LABEL[p.rank] : ''}</strong>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">
              {replaying
                ? '這是回放位置當下已經翻明的兵種（§4.3）——不是終局的全貌。棋盤上其餘的兵種是否顯示，由上方的視角決定。'
                : publicView
                  ? '本遊戲不提供推論輔助；未翻明的兵種不在這個視角的資料裡，請自行由公開紀錄推得（規則書 §10）。'
                  : '本遊戲不提供推論輔助；其餘敵方兵種請自行由公開紀錄推得（規則書 §10）。'}
            </p>
          </section>

          {/* no seat, no enemy, no notepad — see the note under the board.
              A replay has no seat either, and nothing left to annotate. */}
          {me !== null && !replaying && (
            <PencilPanel
              pieces={view.pieces}
              me={me}
              marks={pencilMarks}
              captures={captures}
              onAdd={addPencilMark}
              onToggle={togglePencilMark}
              onClear={clearPencilMark}
              onClearAll={clearPencilMarks}
              onOpenPicker={(sq) => setPencilOpen(sq)}
              onDragRankStart={(rank) => setDraggingRank(rank)}
              onDragRankEnd={() => setDraggingRank(null)}
            />
          )}
        </div>
      </div>

      {/*
       * Handed the ViewerState this screen already renders. It is the redacted
       * one (stateForViewer, 規則書 §10) — no fetch, no server call, nothing
       * re-derived, which is exactly what makes exporting it safe.
       */}
      {exportOpen && <ExportPanel view={view} bot={bot} onClose={closeExport} />}
      {shareOpen && shareToken !== null && (
        <SharePanel token={shareToken} onClose={() => setShareOpen(false)} />
      )}
    </main>
  )
}

function carrierShort(carrier: Carrier): string {
  return CARRIER_LABEL[carrier].split(' ')[0]
}

interface SidePanelProps {
  color: Color
  score: number
  clockMs: number
  clockEnabled: boolean
  toMove: boolean
  isMe: boolean
  /**
   * Replay only: what THIS ply paid this side (§7.1 — only the mover settles,
   * so one side is always 0 and showing both is what makes that legible).
   * `undefined` during a live game, where the row does not exist at all; `null`
   * at the opening, where there is no previous position to differ from — the
   * row is still drawn, so stepping off ply 0 does not shift the layout.
   */
  income?: number | null
  /** replay only: this side made the move on the board */
  justMoved?: boolean
}

function SidePanel({
  color,
  score,
  clockMs,
  clockEnabled,
  toMove,
  isMe,
  income,
  justMoved = false,
}: SidePanelProps) {
  return (
    <div className={`side side-${color}${toMove ? ' side-active' : ''}`}>
      <div className="side-name">
        {COLOR_LABEL[color]}方{isMe ? '（你）' : ''}
        {justMoved && <span className="xy-moved">本手</span>}
      </div>
      <div className="side-score">{formatScore(score)}</div>
      {income !== undefined && (
        <div className={income ? 'xy-income xy-income-paid' : 'xy-income'}>
          本手 {income === null ? '—' : `+${formatScore(income)}`}
        </div>
      )}
      <div className={clockMs < 30_000 && clockEnabled ? 'clock urgent' : 'clock'}>
        {clockEnabled ? formatClock(clockMs) : '無限'}
      </div>
    </div>
  )
}

/**
 * Scoped to this screen. The shared stylesheet is owned elsewhere, so the
 * three-column shell lives here under an `xy-` prefix.
 */
const STYLE = `
.screen.screen-game { max-width: 1560px; }
/* the 公開觀戰 banner: .banner is bold by default, which is right for the title
   line and wrong for three sentences of explanation under it */
.screen-game .banner.xy-public { font-weight: 400; }
.screen-game .xy-public-title { font-weight: 600; }
.screen-game .xy-public-body {
  margin: 4px 0 0;
  font-size: 0.86rem;
  line-height: 1.6;
  color: var(--fg);
}
/* the result banner also carries the export button once the game is over */
.screen-game .banner.xy-over {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.screen-game .xy-over-replay {
  margin-left: 10px;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--accent);
  border: 1px solid #3d6d97;
  background: rgba(110, 193, 255, 0.08);
  white-space: nowrap;
}
/* 回放: this ply's income, in the scoreboard. §7.1 credits only the side that
   just moved, so one of the two is always +0 — which is precisely what makes
   the pair readable. The running totals are on every log row already; this
   number is nowhere else. The 結算格 themselves are deliberately NOT tinted by
   owner: the piece standing on one carries its own colour, and a tint would
   fight the gold 結算格 outline that says it is a scoring square at all. */
.screen-game .xy-income {
  font-size: 0.78rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}
.screen-game .xy-income-paid { color: var(--gold); font-weight: 600; }
.screen-game .xy-moved {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 0.68rem;
  color: var(--accent);
  border: 1px solid #3d6d97;
}
/* 機器人對局: who is across the table, and whether they are thinking */
.screen-game .xy-bot-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 1px 10px;
  font-size: 0.8rem;
  color: var(--fg);
  background: rgba(110, 193, 255, 0.08);
  border: 1px solid #3d6d97;
  border-radius: 999px;
}
.screen-game .xy-bot-mark { color: var(--accent); }
.screen-game .xy-bot-thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.86rem;
  color: var(--accent);
}
.screen-game .xy-bot-dots { display: inline-flex; gap: 4px; }
.screen-game .xy-bot-dots > i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: xy-bot-blink 1.1s ease-in-out infinite;
}
.screen-game .xy-bot-dots > i:nth-child(2) { animation-delay: 0.18s; }
.screen-game .xy-bot-dots > i:nth-child(3) { animation-delay: 0.36s; }
@keyframes xy-bot-blink {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}
/* the indicator must still be legible as text when animation is unwelcome */
@media (prefers-reduced-motion: reduce) {
  .screen-game .xy-bot-dots > i { animation: none; opacity: 0.7; }
}
.xy-grid {
  display: grid;
  /* the centre column is min-content: it is exactly the board's natural width,
     so the side columns are what give way when the viewport tightens. */
  grid-template-columns: minmax(240px, 400px) min-content minmax(240px, 400px);
  align-items: start;
  justify-content: center;
  gap: 18px;
}
.xy-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.xy-col > .panel { margin: 0; }
.xy-col-board { justify-self: center; }
.xy-col-board .controls { margin-top: 0; }
.xy-col-board > p { margin: 0; }
@media (max-width: 1180px) {
  .xy-grid {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
  .xy-col { width: 100%; max-width: 620px; }
  .xy-col-board { order: -1; }
}
`
