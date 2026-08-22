# 行軍西洋棋

以西洋棋的棋盤與移動規則作為載體，承載行軍棋的兵種階級、隱藏資訊與吃子判定。

每顆棋子都有**兩個互不相關的層**：

| 層 | 內容 | 對誰可見 | 決定 |
|---|---|---|---|
| 載體 | 兵／馬／象／車／后／王 | 雙方皆可見 | 這顆棋**怎麼移動** |
| 兵種 | 司令…工兵、軍旗、爆裂物 | 僅自己可見 | 這顆棋**打得贏誰** |

兩層互不掛鉤：軍旗可以騎在后上，司令可以騎在兵上。你看得到每顆敵棋的位置與移動方式，但看不
到它打得贏誰，除非它贏了一場戰鬥。

**這不是西洋棋。** 沒有將軍、沒有將死、沒有和棋、沒有子力不足、沒有三次重複。王只是一顆普
通、可以被吃的棋子，易位無條件合法，進攻方可能反而輸掉，「跳過」永遠合法。規則見
[`gamebook.md`](gamebook.md)；實作規格見 [`techspec.md`](techspec.md)。兩者衝突時，以規則書
為準。

---

## 戰鬥怎麼判定

每個兵種都有一個階級數字，司令（1，最強）到工兵（9）；軍旗與爆裂物不在這個序列裡。

- **數字小的贏。** 輸的一方從牠原本攻擊的那一格被移除——攻方輸了就不會真的進入目標格。贏的
  一方永久翻明；輸的一方不論勝負都不會被公開。
- **同階，以及爆裂物碰到非免疫的棋子，兩者的公告都是同歸於盡**——雙方棋子都移除，都不翻明。
  這兩種情況故意做成看起來一樣：如果公告能區分，本身就會洩漏一個隱藏的兵種。
- **工兵與軍旗都對爆裂物免疫**——刻意成對設計，因為只有其中一個免疫，等於直接點名是誰。工兵
  撞到爆裂物會存活，爆裂物則消耗掉（有煙無傷）——這是唯一設計好、可以低風險試探可疑格子的方
  法。
- **軍旗離開棋盤，該方立即判負**（奪旗）。軍旗不只是貴重的棋子，它本身就是勝負條件——沒有其
  他和棋、認輸或無法動彈的結局。另一種結束方式是任一方先達到目標分數。

## 計分

每一手結束都會結算，但**只有剛行動的一方計分**——牠目前站在計分格上的每顆棋，一格一分，每完
整回合每方各算一次。貼目（開局前先給黑方 0.5 分）純粹是為了讓比分永遠不會打平。

吃子得分（§7.3）是第二個、非必要的收入來源，預設關閉：一場有勝負的戰鬥可以額外付給贏方
「k ×（贏方自己的階級數字）」，有煙無傷的存活方也可以額外拿一筆固定獎勵。兩者都設為零的話，
分數就只來自佔領計分格，沒有別的。

版面本身也不是固定的。計分格、兵種數量、目標分數全部是每局各自的設定：

- **計分區**——中央四格（預設）或側翼八格（中央加兩側，戰線更廣、衝突更多）。八格版每次結算
  的收入大約是四格版的兩倍，所以目標分數也大約要設兩倍，長度才會接近。
- **兵種配置**——標準規則書表，或兩個實驗性版本：工兵更多、試探成本更低；或高階棋子加倍，減
  少昂貴的同階互換。
- **X（目標分數）、N（無進展回合數）、吃子得分係數 k、有煙無傷獎勵、貼目、時鐘**——都在建立
  對局時設定。

## 佈署階段

雙方**同時、祕密**把各自的 16 個兵種指派到各自的 16 顆棋子上——在有棋子交手或對局結束前，任
何一方都看不到另一方的指派。佈署時間用盡的話，伺服器會替你擲出**隨機、合法的佈署**，而不是套
用固定預設——一支可預測的軍隊，跟公開的軍隊是同一種洩漏。

---

## Features

- **Hidden-information redaction is structural, not a display filter.** Every payload leaving the
  server — browser client, LLM text interface, exported game record — goes through one function
  that *omits* secret ranks by default; disclosing one is the exception, coded explicitly, never
  the other way around.
- **Two board variants, three rank-distribution presets, tunable capture scoring**, all set at
  game creation, in the advanced settings panel on the create screen.
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
2. Keep your own link, send the **guest link** to your opponent — or pick the bot option instead
   of a human opponent and skip the invite entirely (see *The bot*, below). Possession of a token
   is the only authentication; there are no accounts.
3. Both sides assign their 16 ranks to their 16 carriers, simultaneously and in secret. Click a
   rank in the tray, then click one of your pieces. Submit unlocks once the assignment is an exact
   bijection onto the game's rank-count table.
4. Play. Your own ranks show on your own pieces; enemy ranks appear only once revealed by winning
   a fight. Scoring squares are highlighted on the board.

The interface itself is in Chinese throughout — this section describes the flow, not the exact
button labels.

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
fixed heuristic. On top of that it runs a reactive flag-defense check (does anything reach my flag
next move, and is fleeing or blocking worth it), a deployment doctrine for what to put where, and
mixed-strategy play — it deliberately randomizes between near-equal moves, because a fully
deterministic policy leaks its own hidden ranks over enough games just by which move it reliably
picks in a given shape of position.

It receives exactly the same redacted view a human browser player gets — no hidden ranks, no
engine internals, no lookahead into a position it hasn't actually reached.

Play it from the create screen's bot option, or run it from the command line for self-play
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
list of **fully-built move URLs** — the model picks one rather than constructing it. This is a raw
excerpt of what the server actually returns, so its labels are the game's own Chinese terms, not
translated:

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
`.../3/e4d5`. White's e-pawn turns out to be rank 8 (排長); Black's d-pawn, rank 7 (連長). Lower
number wins, so the attacker loses:

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
