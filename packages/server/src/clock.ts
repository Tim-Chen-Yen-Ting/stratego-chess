/**
 * Server-authoritative clock — techspec §5, gamebook §8.
 *
 * One `GameClock` per active game. It ticks the side to move and calls back on
 * expiry so the room can run `flagFall()`.
 *
 * This is a SCHEDULER, not a rules component. It answers exactly one question —
 * "how much wall-clock time has this side burned since it became their turn?" —
 * and it does not even do that arithmetic itself: the subtraction goes through
 * the engine's `tickClock`, which owns the flooring behaviour.
 *
 * In particular it does NOT grant the §8 增秒. That is a rules question
 * ("完成一次移動，或強制 pass；主動 pass 不給增秒") and `applyMove` already answers
 * it. The ordering that makes the two cooperate lives in rooms.ts: pause() folds
 * the elapsed time in *before* `applyMove` reads `clockMs`, so the engine adds the
 * increment on top of an already-settled number.
 *
 * When `config.clockEnabled` is false the whole thing is inert: no timers, no
 * writes to `clockMs`, nothing (techspec §5, "skip entirely").
 */

import { tickClock } from '@xiyang/rules'
import type { Color, GameState } from '@xiyang/rules'

/** Wiring back to whoever owns the authoritative state (rooms.ts). */
export interface ClockHost {
  /** Read the current authoritative state. */
  read(): GameState
  /** Replace the authoritative state. The clock only ever rewrites `clockMs`. */
  write(next: GameState): void
  /** `color` ran out of time. The host is expected to call `flagFall(state, color)`. */
  onExpiry(color: Color): void
}

/** Node timers may fire a hair early; re-arm rather than flagging someone unfairly. */
const EARLY_FIRE_SLACK_MS = 2

export class GameClock {
  readonly #host: ClockHost
  /** the side currently burning time, or null when nothing is ticking */
  #runningColor: Color | null = null
  /** Date.now() at the last sync/resume */
  #since = 0
  #timer: NodeJS.Timeout | null = null
  #stopped = false

  constructor(host: ClockHost) {
    this.#host = host
  }

  get enabled(): boolean {
    return this.#host.read().config.clockEnabled
  }

  get running(): boolean {
    return this.#runningColor !== null
  }

  /**
   * Fold the time burned since the last sync into `clockMs`, without stopping.
   * Called before every serialisation so that every payload carries a live clock.
   */
  sync(): void {
    const color = this.#runningColor
    if (color === null) return
    const now = Date.now()
    const elapsed = now - this.#since
    this.#since = now
    if (elapsed <= 0) return
    this.#burn(color, elapsed)
  }

  /** Start (or restart) ticking whichever side is to move. */
  resume(): void {
    if (this.#stopped) return
    const state = this.#host.read()
    if (!state.config.clockEnabled) return
    if (state.status.kind !== 'playing') return
    this.#runningColor = state.toMove
    this.#since = Date.now()
    this.#arm()
  }

  /** Settle the elapsed time and stop ticking. Reversible via `resume()`. */
  pause(): void {
    this.sync()
    this.#disarm()
    this.#runningColor = null
  }

  /** Permanent stop — the game is over. */
  stop(): void {
    this.pause()
    this.#stopped = true
  }

  /** Drop timers without touching state, for room teardown. */
  dispose(): void {
    this.#disarm()
    this.#runningColor = null
    this.#stopped = true
  }

  // ---------- internals ----------

  #remaining(color: Color): number {
    return this.#host.read().clockMs[color]
  }

  /** Subtract burned time. `tickClock` is pure and floors at zero. */
  #burn(color: Color, elapsedMs: number): void {
    this.#host.write(tickClock(this.#host.read(), color, elapsedMs))
  }

  #arm(): void {
    this.#disarm()
    const color = this.#runningColor
    if (color === null) return
    const remaining = Math.max(0, this.#remaining(color))
    this.#timer = setTimeout(() => this.#fire(), remaining)
  }

  #disarm(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #fire(): void {
    this.#timer = null
    const color = this.#runningColor
    if (color === null) return
    this.sync()
    const remaining = this.#remaining(color)
    if (remaining > EARLY_FIRE_SLACK_MS) {
      // fired early — put it back on the wire for the remainder
      this.#arm()
      return
    }
    this.#burn(color, remaining)
    this.#runningColor = null
    this.#stopped = true
    this.#host.onExpiry(color)
  }
}
