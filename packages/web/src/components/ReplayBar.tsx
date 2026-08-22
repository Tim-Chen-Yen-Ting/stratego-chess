import { useCallback, useEffect } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Color } from '@xiyang/rules'
import { colorLabel } from '../format.js'
import { fill, useLang, type Lang, type Strings } from '../i18n.js'

const STR = {
  zh: {
    finished: '對局已結束——這個棋盤現在可以逐手重看。',
    replay: '回放',
    replayViewer: '對局回放',
    backToStart: '回到開局（Home）',
    backToStartLabel: '回到開局',
    prevMove: '上一手（←）',
    prevMoveLabel: '上一手',
    nextMove: '下一手（→）',
    nextMoveLabel: '下一手',
    toEnd: '跳到最後一手（End）',
    toEndLabel: '跳到最後一手',
    playPause: '自動播放／暫停（空白鍵）',
    pause: '暫停',
    play: '自動播放',
    ofTotal: '共 {{n}} 手',
    moverSuffix: '行動',
    opening: '開局（尚未行動）',
    ply: '第 {{n}} 手',
    progress: '回放進度',
    perspectiveGroup: '回放視角',
    blackPerspective: '黑方視角',
    whitePerspective: '白方視角',
    omniscient: '全知',
    blackTitle: '只顯示黑方在該手當時知道的兵種：黑方全部，加上當時已翻明的白方兵種（規則書 §10.1）',
    whiteTitle: '只顯示白方在該手當時知道的兵種：白方全部，加上當時已翻明的黑方兵種（規則書 §10.1）',
    omniscientTitle: '雙方全部兵種（規則書 §10.1 全知者）。終局後這本來就是公開的（§10.5）',
    omniscientNote: '全知視角：雙方全部兵種（規則書 §10.1）。',
    playerNote:
      '{{color}}方視角：只顯示該方在那一手當時知道的兵種——己方全部，加上當時已翻明的敵方兵種。這是它下那一手時手上的資訊。',
    endNote: ' 最後一手為終局，依 §10.5 雙方兵種全部公開，三個視角在該手相同。',
    keysHint: '逐手 · ',
    homeEndHint: '首尾 · ',
    spaceHint: '自動播放 · 點「公開紀錄」任何一列可直接跳到那一手',
    black: '黑',
    white: '白',
  },
  en: {
    finished: 'The game has ended — this board can now be reviewed move by move.',
    replay: 'Replay',
    replayViewer: 'Game replay',
    backToStart: 'Back to the start (Home)',
    backToStartLabel: 'Back to the start',
    prevMove: 'Previous move (←)',
    prevMoveLabel: 'Previous move',
    nextMove: 'Next move (→)',
    nextMoveLabel: 'Next move',
    toEnd: 'Jump to the last move (End)',
    toEndLabel: 'Jump to the last move',
    playPause: 'Play / pause (Space)',
    pause: 'Pause',
    play: 'Auto-play',
    ofTotal: 'of {{n}}',
    moverSuffix: ' to move',
    opening: 'Opening (no move yet)',
    ply: 'Ply {{n}}',
    progress: 'Replay progress',
    perspectiveGroup: 'Replay perspective',
    blackPerspective: "Black's perspective",
    whitePerspective: "White's perspective",
    omniscient: 'Omniscient',
    blackTitle:
      "Shows only what Black knew about ranks at that ply: all of Black's own pieces, plus whichever White ranks had already been revealed (gamebook §10.1).",
    whiteTitle:
      "Shows only what White knew about ranks at that ply: all of White's own pieces, plus whichever Black ranks had already been revealed (gamebook §10.1).",
    omniscientTitle:
      'All ranks on both sides (gamebook §10.1, the omniscient viewer). This is public anyway once the game has ended (§10.5).',
    omniscientNote: 'Omniscient view: every rank on both sides (gamebook §10.1).',
    playerNote:
      "{{color}}'s perspective: shows only the ranks that side actually knew at that ply — all of its own pieces, plus whichever enemy ranks had already been revealed. This is the information it had when it made that move.",
    endNote:
      ' The last ply is the end of the game, so per §10.5 every rank on both sides is public — the three perspectives agree at that ply.',
    keysHint: 'step · ',
    homeEndHint: 'start/end · ',
    spaceHint: 'auto-play · click any row in the public log to jump straight to that ply',
    black: 'Black',
    white: 'White',
  },
} satisfies Strings<
  | 'finished'
  | 'replay'
  | 'replayViewer'
  | 'backToStart'
  | 'backToStartLabel'
  | 'prevMove'
  | 'prevMoveLabel'
  | 'nextMove'
  | 'nextMoveLabel'
  | 'toEnd'
  | 'toEndLabel'
  | 'playPause'
  | 'pause'
  | 'play'
  | 'ofTotal'
  | 'moverSuffix'
  | 'opening'
  | 'ply'
  | 'progress'
  | 'perspectiveGroup'
  | 'blackPerspective'
  | 'whitePerspective'
  | 'omniscient'
  | 'blackTitle'
  | 'whiteTitle'
  | 'omniscientTitle'
  | 'omniscientNote'
  | 'playerNote'
  | 'endNote'
  | 'keysHint'
  | 'homeEndHint'
  | 'spaceHint'
  | 'black'
  | 'white'
>

/**
 * The transport for a finished game (gamebook §10.1「回放觀看者」).
 *
 * This component moves an INDEX and names a PERSPECTIVE. It holds no position,
 * reads no piece, and knows nothing about 兵種 — the frames it is stepping
 * through were built by the engine (`replayGame`), which is the only thing in
 * the system entitled to decide what a given viewer may see at a given ply. If
 * anything here ever starts filtering ranks, that is the bug: this bar's whole
 * contribution to the information model is choosing which `Viewer` to ask for.
 *
 * WHY THE BAR IS LOUD. The board it sits under stops responding the moment the
 * game ends — no legal moves arrive, no square does anything. A player who does
 * not notice this bar reads that as a frozen page, which is the same thing a
 * dropped connection looks like. So it announces itself in words, carries a
 * visible play control (Space alone would be undiscoverable), and prints its
 * keyboard map rather than hiding it in tooltips.
 */

/** 黑方視角 ← 全知 → 白方視角. 全知 sits in the middle and is the default. */
export type Perspective = 'black' | 'omniscient' | 'white'

interface PerspectiveOption {
  id: Perspective
  label: string
  title: string
}

/**
 * Display order IS the spatial metaphor: one side, the truth, the other side.
 * 全知 in the middle because it is the neutral reading and the default; a player
 * perspective is a deliberate step to one side of it.
 */
function perspectives(s: (typeof STR)['zh']): readonly PerspectiveOption[] {
  return [
    { id: 'black', label: s.blackPerspective, title: s.blackTitle },
    { id: 'omniscient', label: s.omniscient, title: s.omniscientTitle },
    { id: 'white', label: s.whitePerspective, title: s.whiteTitle },
  ]
}

/** One ply per this many ms while auto-advancing. */
const STEP_MS = 750

export interface ReplayBarProps {
  /** which frame is on the board, 0 … maxIndex */
  index: number
  /** the last valid frame index */
  maxIndex: number
  /** the ply number the current frame just played, or null at the opening */
  ply: number | null
  /** who played it */
  mover: Color | null
  /** plies in the whole game — the M of 第 N / 共 M 手 */
  totalPlies: number
  onIndex: (index: number) => void
  perspective: Perspective
  onPerspective: (perspective: Perspective) => void
  playing: boolean
  onPlayingChange: (playing: boolean) => void
  /**
   * False while a dialog owns the keyboard. The shortcuts below are hung off
   * the window, so the export and share panels have to be able to take them
   * back — otherwise Space scrolls nothing and steps the board behind the modal.
   */
  keyboard?: boolean
}

export function ReplayBar({
  index,
  maxIndex,
  ply,
  mover,
  totalPlies,
  onIndex,
  perspective,
  onPerspective,
  playing,
  onPlayingChange,
  keyboard = true,
}: ReplayBarProps) {
  const { lang } = useLang()
  const s = STR[lang]
  const PERSPECTIVES = perspectives(s)
  const atStart = index <= 0
  const atEnd = index >= maxIndex

  /** Manual navigation. Always stops the auto-advance: you took the wheel. */
  const seek = useCallback(
    (next: number) => {
      onPlayingChange(false)
      onIndex(Math.max(0, Math.min(maxIndex, next)))
    },
    [maxIndex, onIndex, onPlayingChange],
  )

  const togglePlay = useCallback(() => {
    if (playing) {
      onPlayingChange(false)
      return
    }
    // Play from the end would have nothing to play, and the end is where the
    // board starts — so this rewinds rather than doing nothing.
    if (index >= maxIndex) onIndex(0)
    onPlayingChange(true)
  }, [playing, index, maxIndex, onIndex, onPlayingChange])

  // The auto-advance. A timeout keyed on `index` rather than an interval, so it
  // re-arms from wherever the position actually is: a manual seek mid-playback
  // restarts the clock instead of firing early against a stale index.
  useEffect(() => {
    if (!playing) return
    if (index >= maxIndex) {
      onPlayingChange(false)
      return
    }
    const id = window.setTimeout(() => onIndex(index + 1), STEP_MS)
    return () => window.clearTimeout(id)
  }, [playing, index, maxIndex, onIndex, onPlayingChange])

  useEffect(() => {
    if (!keyboard) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      // Anything that eats keys for its own purpose keeps them — including the
      // scrubber below, whose native ←/→ already moves one step and reports it.
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (target.isContentEditable) return
      }
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          seek(index - 1)
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(index + 1)
          break
        case 'Home':
          e.preventDefault()
          seek(0)
          break
        case 'End':
          e.preventDefault()
          seek(maxIndex)
          break
        case ' ':
        case 'Spacebar':
          // The bar owns Space while it is on screen. preventDefault stops both
          // the page scroll and a focused button firing a second time.
          e.preventDefault()
          togglePlay()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, index, maxIndex, seek, togglePlay])

  /**
   * A mouse click leaves focus on the button it hit, which would then swallow
   * the next Space. `detail === 0` is a keyboard activation, and that focus is
   * the user's place in the page — it stays.
   */
  function dropMouseFocus(e: ReactMouseEvent<HTMLButtonElement>) {
    if (e.detail > 0) e.currentTarget.blur()
  }

  const positionText = ply === null ? s.opening : fill(s.ply, { n: ply })

  return (
    <section className="xy-rp" aria-label={s.replayViewer}>
      <style>{STYLE}</style>

      <div className="xy-rp-title">
        <span className="xy-rp-badge">{s.replay}</span>
        <span>{s.finished}</span>
      </div>

      <div className="xy-rp-row">
        <div className="xy-rp-buttons">
          <button
            type="button"
            className="xy-rp-step"
            disabled={atStart}
            title={s.backToStart}
            aria-label={s.backToStartLabel}
            onClick={(e) => {
              dropMouseFocus(e)
              seek(0)
            }}
          >
            ⏮
          </button>
          <button
            type="button"
            className="xy-rp-step"
            disabled={atStart}
            title={s.prevMove}
            aria-label={s.prevMoveLabel}
            onClick={(e) => {
              dropMouseFocus(e)
              seek(index - 1)
            }}
          >
            ◀
          </button>
          <button
            type="button"
            className="xy-rp-step"
            disabled={atEnd}
            title={s.nextMove}
            aria-label={s.nextMoveLabel}
            onClick={(e) => {
              dropMouseFocus(e)
              seek(index + 1)
            }}
          >
            ▶
          </button>
          <button
            type="button"
            className="xy-rp-step"
            disabled={atEnd}
            title={s.toEnd}
            aria-label={s.toEndLabel}
            onClick={(e) => {
              dropMouseFocus(e)
              seek(maxIndex)
            }}
          >
            ⏭
          </button>
          <button
            type="button"
            className={playing ? 'xy-rp-play xy-rp-play-on' : 'xy-rp-play'}
            disabled={maxIndex === 0}
            aria-pressed={playing}
            title={s.playPause}
            onClick={(e) => {
              dropMouseFocus(e)
              togglePlay()
            }}
          >
            <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
            {playing ? s.pause : s.play}
          </button>
        </div>

        <div className="xy-rp-readout" role="status">
          <strong className="xy-rp-n">{positionText}</strong>
          <span className="muted"> / {fill(s.ofTotal, { n: totalPlies })}</span>
          {mover !== null && (
            <span className={`xy-rp-mover xy-rp-mover-${mover}`}>
              {colorLabel(mover, lang)}
              {s.moverSuffix}
            </span>
          )}
        </div>
      </div>

      <input
        className="xy-rp-range"
        type="range"
        min={0}
        max={Math.max(maxIndex, 1)}
        step={1}
        value={index}
        disabled={maxIndex === 0}
        aria-label={s.progress}
        aria-valuetext={positionText}
        onChange={(e) => seek(Number(e.currentTarget.value))}
      />

      {/*
       * A pressed-button group rather than a radiogroup: `role="radio"` promises
       * arrow-key navigation within the group, and ←/→ are the transport's here.
       * Three toggle buttons, one of them pressed, promises exactly what this
       * offers and no more.
       */}
      <div className="xy-rp-persp" role="group" aria-label={s.perspectiveGroup}>
        {PERSPECTIVES.map((option) => (
          <button
            type="button"
            key={option.id}
            aria-pressed={perspective === option.id}
            className={
              perspective === option.id ? 'xy-rp-persp-btn xy-rp-persp-on' : 'xy-rp-persp-btn'
            }
            title={option.title}
            onClick={(e) => {
              dropMouseFocus(e)
              onPerspective(option.id)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/*
       * What a perspective MEANS, said plainly, because the whole feature turns
       * on it: a player view is not the finished game with two pieces hidden,
       * it is what that side actually held at that ply. And the last ply is
       * deliberately the same in all three — §10.5 opens every 兵種 at 終局, so
       * a viewer arriving at the end and seeing everything is the rule working,
       * not the perspective leaking.
       */}
      <p className="xy-rp-note muted small">
        {perspective === 'omniscient'
          ? s.omniscientNote
          : fill(s.playerNote, { color: perspective === 'black' ? s.black : s.white })}
        {s.endNote}
      </p>
      <p className="xy-rp-keys muted small">
        <kbd>←</kbd> <kbd>→</kbd> {s.keysHint}
        <kbd>Home</kbd> <kbd>End</kbd> {s.homeEndHint}
        <kbd>{lang === 'zh' ? '空白鍵' : 'Space'}</kbd> {s.spaceHint}
      </p>
    </section>
  )
}

/**
 * Scoped to this component. The shared stylesheet is owned elsewhere, so
 * everything the bar needs lives here under an `xy-` prefix.
 */
const STYLE = `
.xy-rp {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--panel);
  /* the accent border is the whole point: this bar has to read as a new,
     live thing appearing under a board that just went quiet */
  border: 1px solid var(--accent);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.xy-rp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.86rem;
}
.xy-rp-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #12161c;
  background: var(--accent);
}
.xy-rp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.xy-rp-buttons {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.xy-rp-step {
  min-width: 2.4em;
  padding: 3px 8px;
  font-size: 0.95rem;
  line-height: 1.3;
}
.xy-rp-play {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 0.82rem;
  line-height: 1.3;
  margin-left: 4px;
}
.xy-rp-play-on {
  border-color: var(--accent);
  color: var(--accent);
}
.xy-rp-readout {
  margin-left: auto;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 0.86rem;
  white-space: nowrap;
}
.xy-rp-n { font-variant-numeric: tabular-nums; }
.xy-rp-mover {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 0.74rem;
  border: 1px solid var(--line);
}
.xy-rp-mover-white { color: #fdfaf3; }
.xy-rp-mover-black { color: #9fb0c8; }
.xy-rp-range {
  width: 100%;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.xy-rp-range:disabled { cursor: default; opacity: 0.5; }
/* the three-position toggle, drawn as one segmented control so that 全知 is
   visibly BETWEEN the two player views rather than one option among three */
.xy-rp-persp {
  display: flex;
  align-self: flex-start;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.xy-rp-persp-btn {
  flex: 1 1 auto;
  padding: 4px 14px;
  font-size: 0.82rem;
  line-height: 1.4;
  white-space: nowrap;
  background: var(--panel-2);
  border: 0;
  border-radius: 0;
  color: var(--muted);
}
.xy-rp-persp-btn + .xy-rp-persp-btn { border-left: 1px solid var(--line); }
.xy-rp-persp-on {
  background: #2a4d6e;
  color: var(--fg);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent);
}
.xy-rp-note { margin: 0; line-height: 1.55; }
.xy-rp-keys { margin: 0; }
.xy-rp-keys kbd {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
  padding: 0 4px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--fg);
}
`
