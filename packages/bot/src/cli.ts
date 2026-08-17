/**
 * `npm run bot -- --white greedy --black random --games 1000 --seed 1`
 *
 * The command line over `harness.ts` + `report.ts`: parse flags strictly,
 * resolve two policy names, play the run, print one report.
 *
 * **Unknown flags are an error.** A typo in `--sqaures` that silently kept the
 * default would produce a run labelled with settings it was not played under,
 * and the entire value of this tool is that the label is trustworthy. The same
 * goes for a value that does not parse: nothing here falls back.
 */

import {
  DEFAULT_CONFIG,
  DISTRIBUTION_SCOUTS,
  DISTRIBUTION_STANDARD,
  DISTRIBUTION_TOP_HEAVY,
  SCORING_CENTRE_4,
  SCORING_WIDE_8,
} from '@xiyang/rules'
import type { GameConfig, RankDistribution, Square } from '@xiyang/rules'
import { pathToFileURL } from 'node:url'

import { runMatches } from './harness.js'
import { aggregate, formatReport } from './report.js'
// The policy registry (`index.ts`) is the one place policies are named; a second
// list here would drift the moment somebody adds a bot.
import { POLICIES } from './index.js'
import type { Policy } from './policy.js'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const SQUARE_PRESETS: Readonly<Record<string, readonly Square[]>> = Object.freeze({
  centre4: SCORING_CENTRE_4,
  center4: SCORING_CENTRE_4,
  wide8: SCORING_WIDE_8,
})

const DIST_PRESETS: Readonly<Record<string, RankDistribution>> = Object.freeze({
  standard: DISTRIBUTION_STANDARD,
  scouts: DISTRIBUTION_SCOUTS,
  topheavy: DISTRIBUTION_TOP_HEAVY,
  'top-heavy': DISTRIBUTION_TOP_HEAVY,
})

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface Options {
  white: string
  black: string
  games: number
  seed: number
  maxPlies: number
  config: Partial<GameConfig>
  list: boolean
  help: boolean
}

const KNOWN_FLAGS = [
  'white', 'black', 'games', 'seed', 'squares', 'dist', 'x', 'n', 'komi',
  'max-plies', 'list', 'help',
]

/** A bad command line. Exported so a test can tell it from a crash. */
export class UsageError extends Error {}

export const USAGE = `行軍西洋棋 bot harness — self-play measurement over @xiyang/rules

  npm run bot -- --white greedy --black random --games 1000 --seed 1

  --white <policy>     policy for white              (default random)
  --black <policy>     policy for black              (default random)
  --games <n>          matches to play               (default 100)
  --seed <n>           root seed; the run replays exactly from it (default 1)
  --squares <preset>   centre4 | wide8               (default centre4)
  --dist <preset>      standard | scouts | topheavy  (default standard)
  --x <n>              X, 分數線                      (default ${DEFAULT_CONFIG.scoreTarget})
  --n <n>              N, 停滯回合數                   (default ${DEFAULT_CONFIG.noProgressTurns})
  --komi <n>           貼目, credited to black        (default ${DEFAULT_CONFIG.komi})
  --max-plies <n>      ply cap per match             (default 400)
  --list               list the policies this build knows
  --help               this text

Every flag also accepts --flag=value. Unknown flags are an error, not a default.`

function integer(flag: string, raw: string, min: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new UsageError(`--${flag}: expected an integer >= ${min}, got "${raw}"`)
  }
  return value
}

function decimal(flag: string, raw: string): number {
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value)) {
    throw new UsageError(`--${flag}: expected a number, got "${raw}"`)
  }
  return value
}

function preset<T>(flag: string, raw: string, table: Readonly<Record<string, T>>): T {
  const found = table[raw.toLowerCase()]
  if (found === undefined) {
    throw new UsageError(
      `--${flag}: unknown preset "${raw}". Choose one of: ${Object.keys(table).join(' | ')}`,
    )
  }
  return found
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    white: 'random',
    black: 'random',
    games: 100,
    seed: 1,
    maxPlies: 400,
    config: {},
    list: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      throw new UsageError(`unexpected argument "${token}" — every option is a --flag`)
    }
    const eq = token.indexOf('=')
    const flag = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase()
    const inline = eq === -1 ? null : token.slice(eq + 1)

    if (!KNOWN_FLAGS.includes(flag)) {
      throw new UsageError(
        `unknown flag "--${flag}". Known flags: ${KNOWN_FLAGS.map((f) => `--${f}`).join(' ')}`,
      )
    }

    if (flag === 'list' || flag === 'help') {
      if (inline !== null) throw new UsageError(`--${flag} takes no value`)
      if (flag === 'list') options.list = true
      else options.help = true
      continue
    }

    const value = inline ?? argv[++i]
    if (value === undefined) throw new UsageError(`--${flag} needs a value`)

    switch (flag) {
      case 'white': options.white = value; break
      case 'black': options.black = value; break
      case 'games': options.games = integer('games', value, 1); break
      // any 32-bit pattern is a valid seed, 0 included
      case 'seed': options.seed = integer('seed', value, 0); break
      case 'max-plies': options.maxPlies = integer('max-plies', value, 1); break
      case 'squares': options.config.scoringSquares = preset('squares', value, SQUARE_PRESETS); break
      case 'dist': options.config.distribution = preset('dist', value, DIST_PRESETS); break
      case 'x': options.config.scoreTarget = decimal('x', value); break
      case 'n': options.config.noProgressTurns = integer('n', value, 1); break
      case 'komi': options.config.komi = decimal('komi', value); break
    }
  }

  return options
}

/** Look a policy up by the name the flag asked for. */
export function policyNamed(name: string): Policy {
  const policy = POLICIES[name]
  if (!policy) {
    throw new UsageError(
      `unknown policy "${name}". Known policies: ${Object.keys(POLICIES).join(' | ')}`,
    )
  }
  return policy
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function run(argv: readonly string[]): string {
  const options = parseArgs(argv)
  if (options.help) return USAGE
  if (options.list) return `policies: ${Object.keys(POLICIES).join(' ')}`

  const white = policyNamed(options.white)
  const black = policyNamed(options.black)

  const matches = runMatches(
    white, black, options.config, options.seed, options.games, options.maxPlies,
  )
  return formatReport(aggregate(matches, { seed: options.seed, maxPlies: options.maxPlies }))
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    process.stdout.write(`${run(process.argv.slice(2))}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`)
    process.exitCode = 1
  }
}
