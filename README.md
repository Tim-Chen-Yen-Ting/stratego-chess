# 行軍西洋棋

Chess board and chess movement, carrying 行軍棋 ranks, hidden information and rank-based capture.

Every piece has **two independent layers**:

| Layer | Values | Visible to | Decides |
|---|---|---|---|
| 載體 carrier | pawn / knight / bishop / rook / queen / king | both players | how it **moves** |
| 兵種 rank | 司令 … 工兵 / 軍旗 / 爆裂物 | its owner only | what it **beats** |

The layers are uncoupled: 軍旗 can ride a queen, 司令 can ride a pawn. You can see where every
enemy piece is and how it moves; you cannot see what it beats until it wins a fight.

**This is not chess.** There is no check, no checkmate, no stalemate, no insufficient material and
no threefold repetition. The king is an ordinary capturable piece, castling is unconditional, a
capture can lose for the attacker, and `pass` is always legal. The rules are
[`gamebook.md`](gamebook.md); the implementation contract is
[`techspec.md`](techspec.md). Where the two disagree about a rule, the gamebook wins.

---

## How a fight resolves

Every 兵種 has a rank number, 司令 (1, strongest) down to 工兵 (9); 軍旗 and 爆裂物 sit outside
the ladder entirely.

- **Lower number wins.** The loser is removed from the square it attacked *from* — the attacker
  never enters the target square on a loss. The winner is permanently revealed (翻明); the loser's
  rank is never disclosed, win or lose.
- **Equal ranks, and any contact between 爆裂物 and a non-immune piece, both announce as
  同歸於盡** — both pieces removed, neither revealed. The two cases are made to look identical on
  purpose: a distinguishable announcement would tell you which one just happened, and that alone
  would leak a hidden rank.
- **工兵 and 軍旗 are both immune to 爆裂物** — paired deliberately, because immunity for only one
  of them would identify it. A 工兵 that walks into a bomb survives and the bomb is spent
  (有煙無傷, "smoke but no wound") — the one designed way to probe a suspicious square at low risk.
- **軍旗 leaving the board loses the game outright** (奪旗). It isn't just a valuable piece, it
  *is* the win condition — there's no other draw, resignation, or stalemate state. The other way a
  game ends is a side reaching the score target first.

## Scoring

Settlement runs after every ply, but **only the side that just moved scores** — one point per
piece it currently has standing on a scoring square (結算格), once per side per full turn. 貼目
(0.5, credited to Black before move 1) exists purely so a score-decided game can never end level.

Capture scoring (§7.3) is a second, optional income source, off by default: a decisive fight can
additionally pay the winner `k × (the winner's own rank number)`, and surviving a 有煙無傷 fizzle
can pay a flat bonus. Leave both at zero and every point comes from holding squares, nothing else.

None of the geometry is fixed. Scoring squares, 兵種 counts, and the score target are all per-game
configuration:

- **計分區** — 中央四格 (the default four centre squares) or 側翼八格 (centre plus both flanks,
  more contested, more simultaneous fronts). The wide board pays roughly double per settlement, so
  it needs roughly double the score target to run a comparable length.
- **兵種配置** — the 標準 gamebook table, or two experimental presets: more 工兵 for cheaper
  probing, or doubled high ranks to cut down on expensive equal-rank trades.
- **X (score target), N (no-progress length), 吃子得分係數 k, 有煙無傷獎勵, 貼目, clock** — all
  set at game creation.

## Deployment (setup phase)

Both sides assign their 16 兵種 to their own 16 carriers **simultaneously and in secret** —
neither side sees the other's assignment until a piece fights or the game ends. Run out the setup
clock and the server rolls a **random legal deployment** for you rather than falling back to a
fixed default — a predictable army is the same leak as a published one.

---

## Features

- **Hidden-information redaction is structural, not a display filter.** Every payload leaving the
  server — browser client, LLM text interface, exported game record — goes through one function
  that *omits* secret ranks by default; disclosing one is the exception, coded explicitly, never
  the other way around.
- **Two board variants, three rank-distribution presets, tunable capture scoring**, all set at
  game creation (進階設定 on the create screen).
- **A bot opponent that plays for real**, not just a human invite link — see below.
- **A public, no-account spectator link** carrying exactly what both players already know (board,
  carriers, public log, revealed ranks, score, clock) and nothing else — distinct from a *bound*
  spectator link, which hands over one player's entire hidden hand and must never go to a third
  party mid-game.
- **A GET-only text interface for LLM opponents** — a chatbot can fetch a URL and get back the
  position plus a list of pre-built move URLs; no POST support required on the model's end.
- **Full disclosure at game end** — every hidden rank opens to every viewer once a game is over,
  including in the exported record.

## Play in a browser (invite link)

1. Open the site and press **create**. The server flips a coin for colours and mints four
   unguessable tokens: one per player seat, plus a spectator token bound to each colour.
2. Keep your own link, send the **guest link** to your opponent — or pick 機器人 instead of a
   human opponent and skip the invite entirely (see *The bot*, below). Possession of a token is
   the only authentication; there are no accounts.
3. Both sides assign their 16 兵種 to their 16 carriers, simultaneously and in secret. Click a
   rank in the tray, then click one of your pieces. Submit unlocks once the assignment is an exact
   bijection onto the game's rank-count table.
4. Play. Your own ranks show on your own pieces; enemy ranks appear only once 翻明 by winning a
   fight. Scoring squares are highlighted on the board.

To let someone watch a live game without handing over an army, share the **public spectator
link**. The client never receives a rank it isn't entitled to — it's absent from the payload
entirely, not sent-but-hidden.

## The bot

`packages/bot` — four policies, only one of which is meant to be a real opponent:

| Policy | What it is |
|---|---|
| `random` | Uniform over legal moves. The floor. |
| `greedy` | Takes scoring squares, **never attacks**. A measuring instrument, not a player. |
| `contest` | greedy + contests squares the opponent already holds. The standard yardstick this project's own self-play measurements are calibrated against. |
| `belief` | The actual opponent, and the default in the browser. |

`belief` tracks a running probability distribution over each enemy piece's hidden rank —
particle-filtered, updated by every contact and by moves that would make sense for some ranks and
not others — and prices every candidate move by expected value under that belief rather than a
fixed heuristic. On top of that it runs a reactive 軍旗-defense check (does anything reach my flag
next move, and is fleeing or blocking worth it), a deployment doctrine for what to put where, and
mixed-strategy play — it deliberately randomizes between near-equal moves, because a fully
deterministic policy leaks its own hidden ranks over enough games just by which move it reliably
picks in a given shape of position.

It receives exactly the same redacted view a human browser player gets — no hidden ranks, no
engine internals, no lookahead into a position it hasn't actually reached.

Play it from the create screen (機器人 → 推測), or run it from the command line for self-play
measurement:

```bash
npm run bot -- --white belief --black contest --games 1000 --seed 1
```

Deterministic from the seed; prints a report over the batch — win rate, plies, contact rate,
capture-score split. `random`, `greedy` and `contest` exist to be measured against, not played;
`belief` is the one worth actually facing.

## Play over HTTP (the LLM interface)

GET-only, because web chatbots can fetch but cannot POST.

```
GET /llm/:token                current position, text/plain
GET /llm/:token/rules          rules primer + this game's tunable numbers
GET /llm/:token/:ply/:move     play the move, return the new position
```

`:move` is `e2e4`, `e7e8q` (promotion), `O-O`, `O-O-O`, or `pass`.

**The `:ply` segment is an idempotency guard.** If it doesn't match the game's current ply, the
move is *not* applied — you simply get the current position back with a note. Link previews,
retries and eager re-fetching are therefore harmless. Every response is `Cache-Control: no-store`.

The rendered view goes through the same redaction boundary as the browser client. The model gets
the public log but **no solver** — reading the board is the game.

### Worked example

```bash
curl -X POST http://localhost:3000/api/game \
     -H 'Content-Type: application/json' \
     -d '{"config":{"setupTimeoutMs":1000,"clockEnabled":false}}'
```

```json
{
  "gameId": "jNvQRNA1TNg",
  "hostToken": "eeLxIK2KYALoQWXEoDaFnY76-bdb2uyd",
  "guestToken": "tMGiVt4GRTu6hOxyitgP3EFewaLK0Yek",
  "hostColor": "black",
  "guestColor": "white",
  "llmUrls": {
    "host":  "http://localhost:3000/llm/eeLxIK2KYALoQWXEoDaFnY76-bdb2uyd",
    "guest": "http://localhost:3000/llm/tMGiVt4GRTu6hOxyitgP3EFewaLK0Yek"
  }
}
```

Hand each `llmUrls` entry to a different model. Fetching one returns the position, ending in a
list of **fully-built move URLs** — the model picks one rather than constructing it:

```
# 行軍西洋棋 — you are WHITE
Ply 1 · your turn · W 0 – B 0.5

## Board  (UPPERCASE = White, lowercase = black, . = empty)
  a b c d e f g h
8 r n b q k b n r
7 p p p p p p p p
6 . . . . . . . .
5 . . . . . . . .
4 . . . . . . . .
3 . . . . . . . .
2 P P P P P P P P
1 R N B Q K B N R

## Your pieces
a2 pawn 工兵(9) · b2 pawn 團長(5) · c2 pawn 營長(6) · d2 pawn 連長(7)
e2 pawn 排長(8) · ...

## Known enemy ranks
(none yet)

16 enemy piece(s) on the board still have an unknown 兵種.

## Legal moves — fetch one to play
e2e4   http://localhost:3000/llm/tMGiVt.../1/e2e4
pass   http://localhost:3000/llm/tMGiVt.../1/pass
```

Fetch the `e2e4` URL and White plays it, then Black plays `d7d5`, then White tries to take it —
`.../3/e4d5`. White's e-pawn is 排長 (8); Black's d-pawn turns out to be 連長 (7). **Lower number
wins, so the attacker loses:**

```
Ply 4 · Black to move · W 2 – B 2.5

## Known enemy ranks
d5 pawn 連長(7)  (revealed ply 3)

## Public log
  1  W e2-e4
  2  B d7-d5
  3  W e4xd5         Black pawn revealed 連長; White piece removed
```

Three things happened there, and all three are the point of the game: the attacker was removed
from the square it came *from*, never entering d5; only the **winner** was revealed, permanently —
Black still has no idea what that pawn actually was; and both sides banked their own scoring-square
occupation on their own ply.

Other useful endpoints:

```
GET  /healthz            liveness
GET  /api/game/:token    the same redacted ViewerState as JSON
GET  /api/links/:token   the share / spectator / LLM links for this token
```

---

## Layout

```
packages/
  rules/     pure TypeScript rules engine, zero runtime dependencies — the authority
  server/    Fastify 5 + Socket.IO 4 + the GET-only LLM routes
  web/       React 19 + Vite 6 + Zustand client
  bot/       self-play harness and the four policies above; depends on rules only
```

`packages/rules` is the only place a rule is decided. The server sequences calls into it and owns
the clock; the client renders `ViewerState` and sends `Move`s. Hidden ranks never leave the server
except through `stateForViewer()`, the single serialisation path in the system.

Requires **Node 24+**.

## Install, build, test

```bash
npm install                # npm workspaces; installs all four packages
npm run build               # rules → server → web
npm test                    # vitest against the rules engine
npm test -w @xiyang/bot     # vitest against the bot package
```

`npm run build` must run before `npm start`. Note that `@xiyang/server`'s own build also
type-checks `@xiyang/bot` (the server depends on it), so a red bot build fails `npm run build`
even though the top-level script doesn't name the bot package.

## Run locally

```bash
npm start            # http://localhost:3000
```

One process serves the JSON API, the WebSocket and the built client from a single origin — no
CORS, no second service. Games live **in memory only**; a server restart drops every game in
progress. That's a deliberate v1 decision, not an oversight.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Render supplies this in production |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | only used to build the absolute LLM move URLs |
| `HOST` | `0.0.0.0` | listen address |
| `LOG_LEVEL` | `info` | Fastify logger level |

For hot reload while developing:

```bash
npm run dev          # server on :3000 with tsx watch, Vite on :5173 proxying to it
```

## Deployment

The project runs on Render in practice: one Web Service serving API, WebSocket and the built
client from a single origin (`npm ci && npm run build`, `npm start`, health check `/healthz`,
`PUBLIC_BASE_URL` set to the deployed origin).

[`render.yaml`](render.yaml) checked into this repo is still a **placeholder** — every value in it
is a `TODO(render)` stand-in, not real service configuration. The actual deployment isn't wired
through that file.
