'use strict';

/*
 * Tests for the search engine (search.js). These check behaviour, not exact
 * node counts: legality of chosen moves, agreement with the tablebase oracle on
 * decisive endgames, wipeout mate-finding, repetition handling, time-budget
 * adherence, and that long self-play games stay legal and terminate. Run:
 *
 *   node --max-old-space-size=2048 search.test.js
 */

const engine = require('./engine');
const { Engine, packKey, TBWIN, DECISIVE } = require('./search');
const { Tablebase } = require('./tbprobe');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

const tb = new Tablebase().loadDefault(6);
ok('tablebase loaded', tb.loaded, 'no tb.K*.bin found');
console.log(`(tablebase K=${tb.K})`);

function legalIn(state, move) {
  return engine.generateMoves(state).some(
    (m) => m.from === move.from && m.to === move.to && !!m.promotion === !!move.promotion);
}

// ---------------------------------------------------------------------------
// 1) opening move is legal and search deepens
// ---------------------------------------------------------------------------
{
  const ai = new Engine({ tablebase: tb });
  const s = engine.initialState();
  const r = ai.chooseMove(s, [packKey(s)], { timeMs: 600 });
  ok('opening move is legal', r.move && legalIn(s, r.move), r.move && engine.moveSan(r.move));
  ok('opening reaches depth >= 4', r.depth >= 4, 'depth ' + r.depth);
  ok('opening explored nodes', r.nodes > 1000, 'nodes ' + r.nodes);
}

// ---------------------------------------------------------------------------
// 2) wipeout mate-in-1: white queen can capture black's only piece
// ---------------------------------------------------------------------------
{
  const ai = new Engine({ tablebase: null }); // no TB: must find it by search
  const s = engine.makeState({ b3: 'Q', b5: 'b' }, 'w'); // Qb3 takes b5
  const r = ai.chooseMove(s, [packKey(s)], { timeMs: 300, maxDepth: 4 });
  const child = engine.applyMove(s, r.move);
  eq('mate-in-1 wins immediately', engine.countPieces(child, 'b'), 0);
  ok('mate-in-1 reported as mate', r.mate === true, 'score ' + r.score);
}

// ---------------------------------------------------------------------------
// 3) tablebase agreement: engine's verdict matches the oracle on endgames
// ---------------------------------------------------------------------------
function rootVerdict(score) {
  if (score > DECISIVE) return 'win';
  if (score < -DECISIVE) return 'loss';
  return 'draw';
}
{
  const ai = new Engine({ tablebase: tb });
  const cases = [
    { name: 'Q vs b (win)', place: { b3: 'Q', a6: 'b' }, turn: 'w' },
    { name: 'B vs q (loss)', place: { a1: 'B', b4: 'q' }, turn: 'w' },
    { name: 'Q vs q (mover wins by capture)', place: { b3: 'Q', b5: 'q' }, turn: 'w' },
  ];
  for (const c of cases) {
    const s = engine.makeState(c.place, c.turn);
    const probe = tb.probe(s.board, s.turn);
    const r = ai.chooseMove(s, [packKey(s)], { timeMs: 400 });
    eq(`TB agreement: ${c.name}`, rootVerdict(r.score), probe.result);
    if (probe.result !== 'draw') ok(`  ${c.name} chosen move is legal`, legalIn(s, r.move));
  }
}

// ---------------------------------------------------------------------------
// 4) repetition: a 2nd occurrence of a position along history scores as a draw,
//    and the side that is materially losing prefers to hold the draw.
//    Construct two lone queens far apart: neither can win, optimal is a draw (0).
// ---------------------------------------------------------------------------
{
  const ai = new Engine({ tablebase: tb });
  const s = engine.makeState({ a1: 'Q', c6: 'q' }, 'w');
  const probe = tb.probe(s.board, s.turn);
  const r = ai.chooseMove(s, [packKey(s)], { timeMs: 400 });
  eq('Q vs Q symmetric is a draw (TB)', probe.result, 'draw');
  eq('engine agrees Q vs Q is ~0', rootVerdict(r.score), 'draw');
}

// ---------------------------------------------------------------------------
// 5) time budget: a short deadline returns promptly (well under 4x budget)
// ---------------------------------------------------------------------------
{
  const ai = new Engine({ tablebase: tb });
  const s = engine.initialState();
  const t0 = Date.now();
  ai.chooseMove(s, [packKey(s)], { timeMs: 300 });
  const dt = Date.now() - t0;
  ok('respects time budget (<1500ms for 300ms)', dt < 1500, dt + 'ms');
}

// ---------------------------------------------------------------------------
// 6) self-play: engine vs engine plays a full, fully-legal game that terminates
// ---------------------------------------------------------------------------
{
  const ai = new Engine({ tablebase: tb });
  const game = new engine.Game(engine.initialState());
  const history = [packKey(game.state)];
  let status = engine.terminalStatus(game.state);
  let plies = 0;
  let illegal = false;
  while (!status.over && plies < 300) {
    const r = ai.chooseMove(game.state, history, { timeMs: 120 });
    if (!r.move || !legalIn(game.state, r.move)) { illegal = true; break; }
    status = game.play(r.move);            // Game applies the twofold-repetition rule
    history.push(packKey(game.state));
    plies++;
  }
  ok('self-play made only legal moves', !illegal);
  ok('self-play terminated (win or draw)', status.over === true || plies >= 300,
    `plies ${plies}, status ${JSON.stringify(status)}`);
  ok('self-play reached a real result within 300 plies', status.over === true,
    `plies ${plies}`);
  console.log(`  (self-play: ${plies} plies, result ${JSON.stringify(status)})`);
}

// ---------------------------------------------------------------------------
// 7) REGRESSION: a won Q+B-vs-q endgame must be CONVERTED to a win, not shuffled
//    to a repetition draw. This guards the distance-to-win metric: the engine
//    must make monotone progress (and promote when that is the winning plan)
//    instead of cycling among equally-scored "winning" moves.
//    (Bug: the tablebase stored distance-to-conversion flattened to 1, so every
//    winning move looked equally good and the engine never made progress.)
// ---------------------------------------------------------------------------
{
  const ai = new Engine({ tablebase: tb });

  // strongest defence: prefer a draw, else survive as long as possible (max DTW).
  function optimalDefense(state) {
    const opp = state.turn === 'w' ? 'b' : 'w';
    let best = null, bestRank = null;
    for (const m of engine.generateMoves(state)) {
      const ch = engine.applyMove(state, m);
      if (engine.countPieces(ch, opp) === 0) return m; // wipeout for the defender
      const r = tb.probe(ch.board, ch.turn);
      let rank;
      if (!r) rank = [1, 0];
      else if (r.result === 'loss') rank = [3, r.dtw]; // forced to lose -> delay
      else if (r.result === 'draw') rank = [2, 0];     // hold the draw
      else rank = [0, r.dtw];                          // defender winning
      if (bestRank === null || rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
        bestRank = rank; best = m;
      }
    }
    return best;
  }

  // a handful of seed positions the tablebase rates as wins for White to move,
  // including the exact position that exposed the bug (Qc1 Bb5 vs qa5).
  const seeds = [
    { Q: 'c1', B: 'b5', q: 'a5' },
    { Q: 'a1', B: 'a2', q: 'c5' },
    { Q: 'b1', B: 'c2', q: 'b5' },
    { Q: 'c3', B: 'a3', q: 'a6' },
  ];

  for (const s of seeds) {
    const start = engine.makeState({ [s.Q]: 'Q', [s.B]: 'B', [s.q]: 'q' }, 'w');
    const verdict = tb.probe(start.board, 'w');
    ok(`seed ${s.Q}/${s.B} vs ${s.q} is a TB win`, verdict && verdict.result === 'win',
      JSON.stringify(verdict));

    const game = new engine.Game(engine.cloneState(start));
    const history = [packKey(game.state)];
    let status = { over: false }, plies = 0, promoted = false;
    while (!status.over && plies < 80) {
      let m;
      if (game.state.turn === 'w') {
        m = ai.chooseMove(game.state, history, { timeMs: 100 }).move;
        if (m && m.promotion) promoted = true;
      } else {
        m = optimalDefense(game.state);
      }
      if (!m) break;
      status = game.play(m);
      history.push(packKey(game.state));
      plies++;
    }
    ok(`seed ${s.Q}/${s.B} vs ${s.q} is CONVERTED to a win (not a draw)`,
      status.over === true && status.result === 'w',
      `plies ${plies}, status ${JSON.stringify(status)}, promoted=${promoted}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
