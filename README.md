# Minichess — 3×6 Bishops & Queens

### ▶ Play the live demo: **https://sr123.github.io/minichess-3x6/**

The live demo is the **featherweight, browser-only** build — it runs entirely in
your browser with no server and covers endgames with **≤ 3 pieces** (longest
forced win: 20 plies / 10 moves). The **full version** (≤ 5 pieces, with deeper
forced wins up to **54 plies / 27 moves**, plus the playable engine and web UI)
runs **locally from this repo**:

```sh
npm start          # then open http://localhost:8080  (study tool at /study)
```

A complete, **playable** engine for a small chess variant, plus a web UI to play
against it.

## The variant

* **Board:** 3 columns (a–c) × 6 rows (1–6) = 18 squares.
* **Pieces:** bishops and queens only. They move and capture exactly as in
  standard chess. No kings, no check, no castling, no en passant.
* **Start:** White fills rows 1–2 (queen on b1, bishops on a1 a2 b2 c1 c2);
  Black fills rows 5–6 (queen on b6, bishops on a5 b5 c5 a6 c6).
* **Promotion:** a bishop reaching the far rank (white → row 6, black → row 1)
  becomes a queen.
* **Goal:** capture *all* enemy pieces. A side with zero pieces has lost.
* **Draw:** a position (board layout + side to move) occurring for the **second**
  time is an immediate draw (twofold repetition). Stalemate is impossible on this
  board.

The full game is too large to solve outright on this machine, so the engine
**plays** rather than looking everything up: a search that is backed by an exact
endgame tablebase once few enough pieces remain.

## How to play

```sh
node --max-old-space-size=2048 server.js [port]      # default port 8080
```

Then open `http://localhost:<port>`. Pick your colour and the engine's thinking
time, click a piece, then a highlighted square. `THINK_MS=<ms>` sets the default
move budget.

### Endgame study

Open `http://localhost:<port>/study` (or the "endgame study →" link) for a
tablebase-driven study of every material class: each class's **longest forced
win** (max distance-to-win), a **play/pause/step** walkthrough of the optimal
line under best play by *both* sides (winner minimising DTW, loser stalling)
ending in a wipeout in exactly DTW plies, and — for every position along the way
— a list of **every legal move with its exact outcome** ("win in 19 plies",
"draw", "loss in 28 plies"), sorted best-first. All values come from real probes
(`tbstudy.js`), validated by `study.test.js`.

#### Featherweight (static, browser-only) version — `docs/`

`docs/` is a **no-server, fully browser-side** build of the study tool that uses
only the small **K3** tablebase (≤ 3 pieces, 237 KB), so it can deploy to GitHub
Pages as-is. The probe, per-move analysis, optimal-line playthrough, and the
ranked per-move outcome list all run client-side (`docs/{engine,tablebase,study,
ui}.js` fetch `docs/tb.K3.bin`). It carries a banner noting it's the ≤ 3-piece
build and that the full **K5** version (≤ 5 pieces, deepest wins **54 plies / 27
moves**) runs locally from this repo.

* **Deploy:** repo *Settings → Pages → Build and deployment → Deploy from a
  branch → `main` / `/docs`*. The site is then served at the Pages URL.
* **Run locally:** any static server over the `docs/` folder, e.g.
  `cd docs && python3 -m http.server` then open `localhost:8000`. (Opening
  `index.html` via `file://` won't work — browsers block the `tb.K3.bin` fetch.)
* **Parity:** `docs-parity.test.js` (in `npm test`) proves the browser port's
  probe, `analyze`, optimal lines, and class index match the server code exactly
  on every K3 position. The full server-based K5 study page is left untouched.

The UI also shows, whenever the position is within the endgame tablebase, the
**exact verdict and distance** — e.g. "White wins — mate in 7 moves (13 plies,
optimal play)" or "Theoretical draw". Every move is recorded in a **move list**
(click any move to jump to it); the arrows / ← → keys **replay** the game, and
**Save game** / **Load game** download and reload a game as JSON for later
replay.

## Pieces

| File | What it is |
|------|------------|
| `engine.js` | Rules: board, move generation, application, terminal/repetition, perft, `Game` driver. |
| `tablebase.js` | Retrograde **exact** WLD + distance-to-win solver (`solveAll`) over piece-count-bounded layers, with combinatorial ranking and a packed hash set. |
| `build-tablebase.js` | Enumerate every position with ≤ K pieces, solve it, and write a dense `tb.K{K}.bin`. |
| `tbprobe.js` | O(1) loader/probe of a `tb.K*.bin` for an engine board + side to move → `{result, dtw}`. |
| `eval.js` | Heuristic evaluation above the tablebase frontier: material + promotion-race proximity + mobility. |
| `search.js` | Iterative-deepening alpha-beta (negamax) with quiescence over captures/promotions, an exact tablebase cutoff, a bounded transposition table in typed arrays, path repetition detection, and MVV-LVA + killer move ordering. |
| `server.js` | HTTP server: serves the UI and exposes `/api/newgame` and `/api/move`. All rules and the engine run server-side. |
| `public/` | Thin browser client (board renderer + click handling). |
| `hardest.js` | Scans the tablebase for the **longest forced wins** (max DTW) and prints the top-N hardest positions + per-signature maxima. |

### The tablebase is exact, and provably so

The set *{positions with ≤ K total pieces}* is **closed under move-making** — a
move never increases the piece count (captures decrease it, promotions keep it
equal, quiet moves keep it the same). So every ≤ K position's value depends only
on other ≤ K positions, and the retrograde solver computes the exact
win/loss/draw verdict — with a true **distance-to-win** (DTW: plies to wipeout
under optimal play) — for all of them. No reachability argument or move history
is needed. DTW is what drives the search to make progress: a win is scored
`TBWIN − DTW`, so shorter wins strictly dominate and the engine is always pulled
toward converting (promoting, then finishing) rather than shuffling. (Storing a
distance-to-*conversion* instead, flattened to 1 for every winning conversion,
breaks this and causes "knows it's winning but never makes progress" draws.)

Shipped tablebases:

* `tb.K3.bin` — ≤ 3 pieces (242 KB), maxDTW = 20.
* `tb.K5.bin` — ≤ 5 pieces, **17,902,224 probed positions**, maxDTW = 54 (54 MB).

The search uses the largest available (`loadDefault`), so endgames with ≤ 5
pieces are played **perfectly**.

## Tests

```sh
node engine.test.js                                  # rules / perft / repetition
node tablebase.test.js                               # ranking, predecessors, packed set
node --max-old-space-size=2048 solver.test.js        # solveAll vs brute-force minimax (slow)
node --max-old-space-size=2048 search.test.js        # search: legality, TB agreement, self-play, endgame conversion
node --max-old-space-size=2048 dtw.test.js tb.K5.bin 5  # distance-to-win recurrence holds for every probed position
node --max-old-space-size=2048 dtw-forceplay.test.js tb.K5.bin 5  # DTW confirmed by direct forced-play: optimal games last exactly DTW plies
```

`dtw.test.js` checks the local one-ply DTW recurrence everywhere; `dtw-forceplay.test.js`
is the end-to-end cross-check — it *plays games out* on `engine.js` (winner
minimising distance, loser stalling) for the longest wins plus a strided sweep,
and confirms each forced game ends in a wipeout in **exactly** the stored DTW
number of plies. Together they are why the "longest win" figures below are trusted.

Rebuild and re-validate a tablebase (round-trips solver ↔ file, must report 0
mismatches):

```sh
node --max-old-space-size=2048 build-tablebase.js 5 tb.K5.bin
node --max-old-space-size=2048 _validate_probe.js tb.K5.bin 5
```

Every build/solve/validation run stays under the 2 GB heap cap
(`--max-old-space-size=2048`).
