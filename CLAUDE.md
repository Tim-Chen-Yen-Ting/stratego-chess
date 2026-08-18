# CLAUDE.md

行軍西洋棋 — a two-player hidden-information chess variant, plus the web app,
bot and research notes around it. This file is the map: what each file is for,
which invariants must not break, and the mistakes that have already been made
here so they are not made again.

---

## 1. The document set

**The split that matters: normative vs. everything else.** Exactly one file says
what the game *is*. Everything else describes, argues about, or measures it.

| File | Role | Normative? |
|---|---|---|
| `gamebook_v05.md` | **The rules.** What is legal, what wins, what is public. | **Yes** |
| `techspec_v01.md` | Structure, types, APIs. Loses to the gamebook on rules. | For code |
| `notebook_v01.md` | Derivations, emergent interactions, playtest data, rule history. | No |
| `strategy_v01.md` | Player-facing 攻略 — how to play well. | No |
| `fogofwar_v01.md` | Design doc for an unbuilt optional mode. | No |
| `games/` | Exported game records. **Gitignored** — carries full deployments. | No |
| `gamebook.md`, `_v02`, `_v03`, `_v04`, `plan_v01.md` | Superseded. Kept for history. | No |

### The rulebook contains no "why"

It reads as though the rules were always this way. **No version history, no
rationale, no measurements, no "this was changed because".** A reader should be
able to implement the game from it without knowing anything happened before.

This has been violated twice and corrected twice — first with version-comparison
tables, then with design rationale for a new rule. Both times the fix was to move
the prose to `notebook_v01.md` and leave the rule.

What legitimately stays in the rulebook:

- A constraint that binds **future** rules (附錄 A, and 附錄 A(d) on scoring)
- A one-line note where an implementer would otherwise get it wrong
  (e.g. 「第 1 項與西洋棋相同，列出僅為使清單完整」)

Rule history goes in `notebook_v01.md` §8, one subsection per version bump,
including reasoning that was later overturned — the overturning is the useful part.

### Ruleset versions are hard boundaries for data

v03 → v04 changed settlement (both sides scored every ply → only the mover) and
made 同歸於盡 silent. **Points-per-ply figures across that boundary are not
comparable** — the rate halved. `games/README.md` marks which ruleset each game
was played under, and notebook §6/§9 say so where relevant. Never pool them.

---

## 2. Code invariants

These are the ones that have actually been broken or nearly broken. Breaking any
of them is a defect regardless of whether tests pass.

### `stateForViewer` is the only way state leaves the engine

`packages/rules/src/redact.ts`. Everything outbound — Socket.IO, `GET /api/game`,
the LLM render, the export — goes through it. `packages/server/src/rooms.ts`
funnels this into a single `serialiseFor`, and nothing else in that package may
touch `room.state` on its way out.

It is built so that **omitting a rank is the default and disclosing one is the
exception**. There is no `{...piece}` spread anywhere in that file, deliberately.

Failure mode seen in practice: the redactor worked perfectly and the server
handed the creator the *opponent's* spectator token. **A correct redactor given
the wrong `Viewer` leaks everything.** Check who is being handed which token.

### 附錄 A: no rule may produce tribe-dependent observable behaviour

The hidden 兵種 layer is the whole design. Any rule that fires differently for one
tribe leaks it the moment it fires.

Consequences already load-bearing: 爆裂物 immunity covers 工兵 **and** 軍旗 (one
alone would name it); suicidal moves are legal (a ban would show up as observable
turn-skipping); 有煙無傷 does not reveal the survivor; 同歸於盡 pays zero to both
sides (a tribe-derived payment would name the victim).

The constraint protects **hidden** tribes. Deriving something from a tribe the
rules just revealed (§4.3 forces the winner face-up) adds no leak — that is why
§7.3 may score by the winner's rank.

### The engine owns state transitions and movement

Do not hand-roll movement geometry. It has happened twice and been removed twice.

- `packages/rules/src/publicmoves.ts` — `carrierMoves(view, color)` gives legal
  moves for **either** side from a redacted view. Sound because legality never
  touches the 兵種 layer; `publicmoves.test.ts` asserts exact equality with the
  authoritative generator.
- `packages/rules/src/replay.ts` — `replayGame` rebuilds a finished game by
  re-applying its log with the real `applyMove` and redacting with the real
  `stateForViewer`.

If you need the opponent's moves, or a past position, call these. If you find
yourself writing knight offsets or slider rays, stop.

### `GameEvent` is public by construction

The log is safe because the redactor **copies** events and never rewrites them.
Any feature that needs the redactor to *synthesise* an event (fog direction hints
would) is a significant increase in security surface and needs its own property
tests.

---

## 3. Working conventions

### Verify independently — agent reports are not evidence

Every workflow report in this project has been checked by running the build, both
test suites, and the measurement again. Twice that caught a green report over
broken code. Once an agent died mid-run and the report never arrived while the
work had landed.

- `npm run build` — rules → server → web, and **the bot too**: `@xiyang/server`'s
  build is `tsc -b ../bot && tsc -p tsconfig.json`, so the server's dependency on
  the bot drags it into the type-check. This was not always true — the note that
  the build omits the bot is obsolete, and was obsoleted silently by a dependency
  change rather than by anyone deciding it
- `npm test` — rules package **only**; the root script is `-w @xiyang/rules`
- `npm test -w @xiyang/bot` — bot package, and nothing else runs it
- Tests pass while the build is red: vitest strips types with esbuild and never
  type-checks. A green suite says nothing about compilation.

### A rule change touches every test that encodes the rule

Under-scoping an agent's file list has caused this four times. A change to
settlement or to `CombatOutcome` breaks tests in files whose names have nothing to
do with either — `gamebook-audit.spec.ts`, `fuzz.test.ts`, `redaction*.ts`.
Exhaustive `switch` statements over a union will catch the source side; nothing
catches the test side but looking.

### Tests are updated, never weakened or deleted

When a rule changes, a test asserting the old behaviour is **inverted**, with a
comment saying what changed and why the new assertion is the strict one. A test
that asserted a now-fixed leak becomes a test asserting the leak is gone.

### Archive every game

Exports go in `games/NNN-<white>-vs-<black>-<board>.md`, numbered in play order,
and get an index row in `games/README.md`. They feed notebook §6 (human/LLM) and
§9–§16 (bot). Gitignored: every finished export carries both deployments.

---

## 4. The bot

`packages/bot`. A policy receives a `ViewerState` — the same redacted payload a
human gets — **and nothing else**. No `GameState`, no hidden rank. A policy that
peeks produces statistics about a different game.

| Policy | What it is |
|---|---|
| `random` | Uniform over legal moves. The floor. |
| `greedy` | Takes squares, **never attacks**. A measuring instrument. |
| `contest` | greedy + contests occupied squares. The standard yardstick. |
| `belief` | The actual opponent: particle-filtered belief, EV captures, mixed strategy, doctrine deployment, flag defence. Default in the browser. |

**`contest` must not be improved.** Every balance number in the notebook is
calibrated against it as it currently stands — komi sweeps, the complete-the-turn
verification, the n=2000 doctrine ablation. Changing it orphans all of them. It
has a known weakness (no flag defence) and that is documented, not fixed.

Determinism: no `Math.random` anywhere in the bot. A seeded `Rng` is threaded
explicitly so a run replays exactly.

---

## 5. Mistakes already made here

Recorded because each cost real time and each is easy to repeat.

**A weight must be smaller than the signal it competes with, and must fire less
often than it matters.** Twice a clever term silently swamped the policy: the
approach gradient sat exactly at the mixing-band width so every positional
decision came out of the dice (notebook §11.4), and flag-threat anticipation
fired in nearly every opening position and cost 2–4 points of win rate while
saving no flags (§14.2). Both were fixed by making the term *smaller*, not smarter.

**Do not tune against the measuring instrument.** `contest` is 1-ply and never
sets a recapture trap, so reply-aware lookahead is structurally unmeasurable
against it. An agent spent six hours iterating on weights against a yardstick that
could not move (§16.3).

**Do not read intent into an outcome.** Three separate game analyses attributed a
plan to a move that was forced, lucky, or the only legal option. Ask what the
player could see and what alternatives existed before calling something strategy.

**A guarantee stated in one section can be load-bearing three sections away.**
§7.4's 「貼目為非整數，故分數永不相等」 is not self-supporting — it holds only while
貼目 is the *only* non-integer source of points. That was silently true for four
ruleset versions because 佔領分 are counts. §7.3 capture scoring was then given a
fractional coefficient, with a reasonable-sounding comment at all three config
entry points, and at k=0.5 a 司令 win pays exactly 貼目: both columns land level and
`leader()` awards the game to black on a comparison, in a game the rulebook says
cannot tie. When adding a new source of anything, find what the existing invariants
quietly assume about the old sources.

**Check what is actually wired up.** `belief` was built, tested and registered in
the bot CLI while being absent from the browser's policy roster — four human games
were played against `contest` and written up as `belief`. A feature that compiles
is not a feature that is reachable.

---

## 6. Deployment

Render, one Web Service serving API, WebSocket and the built client from one
origin. `npm ci && npm run build` / `npm start`, health check `/healthz`, and
`PUBLIC_BASE_URL` must be set — the LLM interface builds absolute move URLs from
it. Games live in memory; a restart loses them, which is accepted for v1.
