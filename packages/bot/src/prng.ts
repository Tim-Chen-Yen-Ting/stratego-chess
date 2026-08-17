/**
 * The one source of randomness in this package.
 *
 * `Math.random` is banned here, and not as a style rule. A bot arena exists to
 * settle arguments that six hand-played games could not settle — notebook §6.6
 * lists three variables that moved at once and §3.3b records a conclusion that
 * had to be reversed. A run that cannot be replayed exactly reproduces that
 * failure at a thousand times the volume: a surprising number appears, and
 * nobody can go back and look at the game that produced it.
 *
 * So randomness is a VALUE that gets threaded, never an ambient capability:
 *
 *   · every draw comes from an `Rng` someone was handed;
 *   · an `Rng` is fully described by `seed` plus the number of draws taken, so
 *     `state()` plus `makeRng` reconstructs any point in any stream;
 *   · streams are SPLIT rather than shared (`deriveSeed`), so moving one
 *     variable in an experiment does not shift the dice under the others.
 *
 * That last point is the whole reason `deriveSeed` exists. If White and Black
 * drew from one stream, swapping Black's policy would change which moves White
 * picked among its ties, and the comparison would once again have two things
 * moving at once — the exact defect this package was built to remove.
 */

/**
 * A seeded pseudo-random stream. Explicit state, no globals, no ambient entropy.
 *
 * Every method that consumes randomness advances the stream by a fixed number of
 * draws, so a policy that calls `pick` once per move keeps its stream aligned
 * with the ply count.
 */
export interface Rng {
  /** the seed this stream was constructed from */
  readonly seed: number
  /** uniform in [0, 1) */
  next(): number
  /** uniform integer in [0, n). Throws for n < 1 — an empty range has no answer. */
  int(n: number): number
  /** uniform element. Throws on an empty array, for the same reason. */
  pick<T>(xs: readonly T[]): T
  /** a shuffled COPY (Fisher-Yates). The input is never mutated. */
  shuffled<T>(xs: readonly T[]): T[]
  /** the internal state right now — `makeRng(seed)` advanced this far equals this */
  state(): number
  /** an independent stream resuming from this one's current state */
  clone(): Rng
  /** how many values have been drawn from this stream */
  draws(): number
}

/**
 * mulberry32 — 32 bits of state, one multiply-xorshift round.
 *
 * Chosen over a bigger generator because the properties that matter here are
 * reproducibility and independence of streams, not cryptographic quality: this
 * decides which of several equally-scored moves a bot plays. It passes gjrand's
 * basic suite, has a 2^32 period (far beyond the ~10^3 draws a game takes), and
 * fits in one integer, which is what makes `state()` a plain number a report can
 * print.
 */
class Mulberry32 implements Rng {
  readonly seed: number
  private s: number
  private n: number

  constructor(seed: number, state?: number, draws?: number) {
    this.seed = seed >>> 0
    this.s = (state ?? seed) >>> 0
    this.n = draws ?? 0
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    this.n++
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(n: number): number {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`Rng.int needs a positive integer bound, got ${String(n)}`)
    }
    return Math.floor(this.next() * n)
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new RangeError('Rng.pick on an empty array')
    return xs[this.int(xs.length)]!
  }

  shuffled<T>(xs: readonly T[]): T[] {
    const out = [...xs]
    // Descending Fisher-Yates. Draw count is length-1 regardless of contents, so
    // two shuffles of equal-length arrays leave the stream in the same place.
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const tmp = out[i]!
      out[i] = out[j]!
      out[j] = tmp
    }
    return out
  }

  state(): number {
    return this.s
  }

  draws(): number {
    return this.n
  }

  clone(): Rng {
    return new Mulberry32(this.seed, this.s, this.n)
  }
}

/** Build a stream. The same seed always produces the same sequence, on any host. */
export function makeRng(seed: number): Rng {
  return new Mulberry32(seed)
}

/**
 * Split a seed into a labelled sub-seed: `deriveSeed(7, 'move:white')`.
 *
 * FNV-1a over the label, mixed with the seed, then run through the murmur3
 * finalizer so that neighbouring seeds (1, 2, 3 — which is how a match numbers
 * its games) do not produce correlated streams.
 *
 * This is what keeps an experiment honest. One master seed fans out into one
 * stream per (game, side, phase), so re-running with a different policy on one
 * side leaves every other stream byte-identical.
 */
export function deriveSeed(seed: number, label: string | number): number {
  let h = (seed >>> 0) ^ 0x811c9dc5
  const text = String(label)
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h >>> 0
}
