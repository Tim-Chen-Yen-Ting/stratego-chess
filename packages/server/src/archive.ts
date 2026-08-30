/**
 * Auto-archive — write every finished game's export to disk. techspec §5/§8.
 *
 * Same content a human gets from `ExportPanel`'s omniscient/game-over export,
 * written once automatically for every finished game this server plays a part
 * in, so notebook analysis and bot/model training have a corpus that does not
 * depend on someone remembering to click "export" before closing the tab.
 *
 * Disabled unless `GAMES_ARCHIVE_DIR` is set: local dev and the test suite
 * must never write files nobody asked for. When set, this is best-effort — a
 * disk failure here must never be mistaken for a game failure (rooms.ts's
 * `notify` calls this the same way it calls the broadcaster, wrapped so a
 * failure here cannot abort the state change that triggered it).
 *
 * Deliberately NOT `games/`: that directory is a human-curated, hand-indexed
 * archive (games/README.md) with per-game analysis annotations and a version
 * note for every ruleset change. Auto-writing every finished game — test
 * games, aborted bot self-play, all of it — into that same directory would
 * bury the curation under noise nobody chose. An interesting game still gets
 * copied there by hand, same as today; this is the uncurated raw feed.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exportJson, exportMarkdown } from '@xiyang/rules'
import type { ExportOpponent } from '@xiyang/rules'

import { serialiseFor, type Room } from './rooms.js'

export interface ArchiveLog {
  warn: (message: string) => void
}

const ARCHIVE_DIR = process.env['GAMES_ARCHIVE_DIR']?.trim() || null

/** Bot policy name, verbatim — this is a filesystem record for offline use, not
 *  a UI string, so it takes the same bare label the API already echoes back
 *  from `describeOpponent` rather than a bilingual display label. */
function opponentFor(room: Room): ExportOpponent | null {
  const bot = room.bot
  return bot === null ? null : { color: bot.color, label: bot.name }
}

/**
 * Called once per finished game (rooms.ts guards re-entry with `room.archived`).
 * Never throws — every failure is caught and logged, never propagated.
 */
export async function archiveFinishedGame(room: Room, log: ArchiveLog): Promise<void> {
  if (ARCHIVE_DIR === null) return
  if (room.state.status.kind !== 'over') return

  try {
    // §10.5 終局公開全部兵種: the game is over, so the omniscient view already
    // holds every rank — the same full disclosure a human gets from the
    // omniscient export link. Nothing here reaches around that; this is the
    // same redacted-then-fully-disclosed view `serialiseFor` always produces.
    const view = serialiseFor(room, { kind: 'omniscient' })
    const opponent = opponentFor(room)
    const json = JSON.stringify(exportJson(view, opponent), null, 2)
    const markdown = exportMarkdown(view, opponent)

    await mkdir(ARCHIVE_DIR, { recursive: true })
    await Promise.all([
      writeFile(join(ARCHIVE_DIR, `${room.id}.json`), json, 'utf8'),
      writeFile(join(ARCHIVE_DIR, `${room.id}.md`), markdown, 'utf8'),
    ])
  } catch (error) {
    log.warn(
      `archive failed for game ${room.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
