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
[`gamebook_v02.md`](gamebook_v02.md); the implementation contract is
[`techspec_v01.md`](techspec_v01.md). Where the two disagree about a rule, the gamebook wins.

---

## Layout

```
packages/
  rules/     pure TypeScript rules engine, zero runtime dependencies — the authority
  server/    Fastify 5 + Socket.IO 4 + the GET-only LLM routes
  web/       React 19 + Vite 6 + Zustand client
```

`packages/rules` is the only place a rule is decided. The server sequences calls into it and owns
the clock; the client renders `ViewerState` and sends `Move`s. Hidden ranks never leave the server
except through `stateForViewer()`, which is the single serialisation path in the system.

Requires **Node 24+**.

---

## Install, build, test

```bash
npm install          # npm workspaces; installs all three packages
npm run build        # rules → server → web, in that order
npm test             # 1001 vitest cases against the rules engine
```

`npm run build` must run before `npm start`: the server serves the web client's `dist/` from its
own origin, and imports the compiled rules package.

## Run locally

```bash
npm start            # http://localhost:3000
```

One process serves the JSON API, the WebSocket and the built client from a single origin — no CORS,
no second service.

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

Games live **in memory only**. There is no database, and a server restart drops every game in
progress. That is a deliberate v1 decision, not an oversight.

---

## Play in a browser (invite link)

1. Open `http://localhost:3000` and press **create**. The server flips a coin for colours and mints
   four unguessable tokens: one per player seat, plus a spectator token bound to each colour.
2. Keep your own link, send the **guest link** to your opponent. Possession of a token is the only
   authentication — there are no accounts.
3. Both sides now assign their 16 兵種 to their 16 carriers, **simultaneously and in secret**. Click
   a rank in the tray, then click one of your pieces. Submit unlocks once the assignment is an exact
   bijection onto the §2 count table. If you run out the setup clock (default 3 minutes) the server
   assigns a fixed default for you and starts the game anyway.
4. Play. Own ranks show on your own pieces; enemy ranks appear only once 翻明 (permanently revealed)
   by winning a fight. The centre squares d4/e4/d5/e5 are highlighted — **every piece you have
   standing on one scores you 1 point after every single ply, yours and your opponent's.** First to
   40 wins. Black starts at 0.5 (貼目), which is what makes an exact tie impossible.

To let someone watch a LIVE game, share the **public spectator link** — it carries the board, the public log and 翻明 兵種 only, and hands over nobody's army. The **bound spectator link** shows one player's entire hand and must not go to a third party mid-game.
more, so relaying cannot leak anything you do not already know.

The client never receives a rank it is not entitled to. It is not "sent but hidden" — it is absent
from the payload.

---

## Play over HTTP (the LLM interface)

GET-only, because web chatbots can fetch but cannot POST.

```
GET /llm/:token                current position, text/plain
GET /llm/:token/rules          rules primer + this game's tunable numbers
GET /llm/:token/:ply/:move     play the move, return the new position
```

`:move` is `e2e4`, `e7e8q` (promotion), `O-O`, `O-O-O`, or `pass`.

**The `:ply` segment is an idempotency guard.** If it does not match the game's current ply the move
is *not* applied and you simply get the current position back with a note. Link previews, retries
and eager re-fetching are therefore harmless. Every response is `Cache-Control: no-store`.

The rendered view goes through the same redaction boundary as the browser client. The model gets the
public log but **no solver** — reading the board is the game.

### Worked example

Create a game. `clockEnabled: false` suits an LLM; the short setup timeout makes both sides take the
default rank assignment so play can start immediately.

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

Hand each `llmUrls` entry to a different model. Fetching one returns the position, ending in a list
of **fully-built move URLs** — the model picks one rather than constructing it:

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

Fetch the `e2e4` URL and White plays it:

```
> NOTE: played e2e4.

# 行軍西洋棋 — you are WHITE
Ply 2 · Black to move · W 1 – B 0.5
```

White is already on 1 point: the pawn landed on e4, a centre square, and settlement runs after every
ply. Fetching that **same URL again** changes nothing:

```
> NOTE: that URL plays at ply 1, but the game is at ply 2. Nothing was played —
  this move was probably already made. Use one of the URLs listed below.
```

Now Black plays `d7d5` at ply 2, and White tries to take it at ply 3 — `.../3/e4d5`. White's e-pawn
is 排長 (8); Black's d-pawn turns out to be 連長 (7). **Lower number wins, so the attacker loses:**

```
> NOTE: played e4d5.

Ply 4 · Black to move · W 2 – B 2.5

## Known enemy ranks
d5 pawn 連長(7)  (revealed ply 3)

## Public log
  1  W e2-e4
  2  B d7-d5
  3  W e4xd5         Black pawn revealed 連長; White piece removed
```

Three things happened there, and all three are the point of the game:

- The attacker was removed **from the square it came from**. It never entered d5, and Black's pawn
  never moved.
- The **winner** is revealed permanently. The loser's rank is never revealed — Black still has no
  idea what that pawn was.
- Both sides scored their centre occupation for the ply: Black's surviving d5 pawn took it to 2.5.

Other useful endpoints:

```
GET  /healthz            liveness
GET  /api/game/:token    the same redacted ViewerState as JSON
GET  /api/links/:token   the share / spectator / LLM links for this token
```

---

## Deployment

[`render.yaml`](render.yaml) is a **placeholder** and is not wired up — every value in it is tagged
`TODO(render)`. Nothing in this build contacts Render.
