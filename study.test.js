'use strict';

/*
 * Tests for the endgame-study queries in tbstudy.js. These confirm the UI's
 * data is exactly the tablebase's, with no heuristic creep:
 *
 *   A) PER-MOVE OUTCOMES. For a sample of positions, every move's reported
 *      {result, plies} matches an INDEPENDENT direct probe of the resulting
 *      position (with the side-to-move sign flip and +1 ply), AND the whole list
 *      is consistent with the position's own probe via the DTW recurrence
 *      (a win's best move == probe.dtw; a loss's every move loses, longest ==
 *      probe.dtw; a draw has no winning move). The list is sorted best-first.
 *
 *   B) OPTIMAL PRINCIPAL VARIATION. For each sampled class's longest-win
 *      position, the PV produced by tbstudy.optimalMove (the exact function the
 *      UI auto-plays) ends in a wipeout in EXACTLY probe(root).dtw plies, with
 *      the loser wiped out.
 *
 *   C) CLASS INDEX. Over K3 (fast, full scan) the enumerated classes match the
 *      tablebase's live signatures, each decisive class has a longest-win
 *      position, the ordering is by piece count then DTW, and the global maximum
 *      matches the file (K3 maxDTW = 20).
 *
 *   node --max-old-space-size=2048 study.test.js [tb.K5.bin] [K]
 */

const engine = require('./engine');
const tb = require('./tablebase');
const { Tablebase } = require('./tbprobe');
const study = require('./tbstudy');
const { SIZE, permCountForSig, unrankBoard, sigKeyOf } = tb;

const FILE = process.argv[2] || 'tb.K5.bin';
const K = Number(process.argv[3] || 5);
const codeToPiece = [null, 'B', 'Q', 'b', 'q'];
const other = (s) => (s === 'w' ? 'b' : 'w');

const T = new Tablebase().load(FILE);
const T3 = new Tablebase().load('tb.K3.bin');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}

function boardOfCodes(codes) {
  const b = new Array(SIZE);
  for (let i = 0; i < SIZE; i++) b[i] = codeToPiece[codes[i]];
  return b;
}

// Independent recomputation of a move's outcome, NOT calling tbstudy: probe the
// child directly and apply the sign flip + 1 here, so the test is a genuine
// cross-check rather than a tautology.
function independentOutcome(Tbl, state, move) {
  const child = engine.applyMove(state, move);
  const opp = other(state.turn);
  if (engine.countPieces(child, opp) === 0) return { result: 'win', plies: 1 };
  const cv = Tbl.probe(child.board, child.turn);
  if (!cv || cv.result === 'draw') return { result: 'draw', plies: null };
  return cv.result === 'loss'
    ? { result: 'win', plies: 1 + cv.dtw }
    : { result: 'loss', plies: 1 + cv.dtw };
}

// ===========================================================================
// A) per-move outcomes agree with direct probes, and with the position probe
// ===========================================================================
console.log('A) per-move outcomes vs independent probes + recurrence:');
{
  // a spread of decisive positions across several K5 classes + both sides
  const sampleSigs = [
    [0, 1, 1, 0], // B vs q
    [0, 2, 1, 0], // BB vs q
    [1, 0, 0, 2], // Q vs bb
    [0, 3, 1, 1], // BBB vs qb (the global-hardest class)
    [2, 0, 1, 1], // QQ vs qb
    [1, 1, 1, 1], // QB vs qb
  ];
  let posChecked = 0, moveChecked = 0, mismatches = 0, sortBad = 0, recurrenceBad = 0;
  const firstBad = [];

  for (const [wQ, wB, bQ, bB] of sampleSigs) {
    const perm = permCountForSig(wQ, wB, bQ, bB);
    const stride = Math.max(1, Math.floor(perm / 400)); // ~400 boards per class
    for (let rank = 0; rank < perm; rank += stride) {
      const board = boardOfCodes(unrankBoard(rank, wQ, wB, bQ, bB));
      for (const turn of ['w', 'b']) {
        const state = { board, turn };
        const root = T.probe(board, turn);
        if (!root) continue;
        const a = study.analyze(T, state);
        posChecked++;

        // every move matches an independent probe
        for (const row of a.moves) {
          moveChecked++;
          const ind = independentOutcome(T, state, { from: row.from, to: row.to, promotion: row.promotion });
          if (ind.result !== row.result || ind.plies !== row.plies) {
            mismatches++;
            if (firstBad.length < 6) firstBad.push({ pos: engine.serialize(state), san: row.san, got: { r: row.result, p: row.plies }, want: ind });
          }
        }

        // sorted best-first (non-decreasing sort key)
        for (let i = 1; i < a.moves.length; i++) {
          const ka = study.moveSortKey(a.moves[i - 1]), kb = study.moveSortKey(a.moves[i]);
          if (ka[0] > kb[0] || (ka[0] === kb[0] && ka[1] > kb[1])) { sortBad++; break; }
        }

        // consistency with the position's own probe via the DTW recurrence
        const wins = a.moves.filter((m) => m.result === 'win');
        const draws = a.moves.filter((m) => m.result === 'draw');
        const losses = a.moves.filter((m) => m.result === 'loss');
        let ok;
        if (root.result === 'win') ok = wins.length > 0 && Math.min(...wins.map((m) => m.plies)) === root.dtw;
        else if (root.result === 'loss') ok = wins.length === 0 && draws.length === 0 && Math.max(...losses.map((m) => m.plies)) === root.dtw;
        else ok = wins.length === 0 && draws.length > 0; // draw
        if (!ok) {
          recurrenceBad++;
          if (firstBad.length < 6) firstBad.push({ pos: engine.serialize(state), probe: root, wins: wins.length, draws: draws.length, losses: losses.length });
        }
      }
    }
  }
  console.log(`   sampled ${posChecked} positions, ${moveChecked} moves`);
  check('every move outcome equals an independent direct probe', mismatches === 0, `${mismatches} bad`);
  check('move list sorted best-first', sortBad === 0, `${sortBad} unsorted`);
  check('per-move list consistent with the position probe (DTW recurrence)', recurrenceBad === 0, `${recurrenceBad} bad`);
  for (const e of firstBad) console.log('     ', JSON.stringify(e));
}

// ===========================================================================
// B) optimal PV ends in a wipeout in exactly probe(root).dtw plies
// ===========================================================================
console.log('\nB) optimal principal variation ends in wipeout at exact DTW:');
{
  const sigs = [
    [0, 1, 1, 0], [0, 2, 1, 0], [0, 3, 1, 1], [1, 0, 0, 2], [2, 0, 1, 1], [1, 1, 1, 1],
  ].map(([a, b, c, d]) => sigKeyOf(a, b, c, d));

  let checkedPV = 0, badPV = 0, maxVerified = 0;
  const firstBad = [];
  for (const sig of sigs) {
    const h = study.hardestOf(T, sig); // this class's longest forced win
    if (!h) continue;
    const root = T.probe(h.board, h.turn);
    const winner = h.winner, loser = other(winner);
    const line = study.principalVariation(T, h.board, h.turn);
    checkedPV++;

    let bad = null;
    if (line.length !== root.dtw) bad = { reason: 'length', got: line.length, want: root.dtw };
    else {
      const end = line.length ? { board: line[line.length - 1].board, turn: line[line.length - 1].turn } : { board: h.board, turn: h.turn };
      if (engine.countPieces(end, loser) !== 0 || engine.countPieces(end, winner) === 0) bad = { reason: 'wrong-wipeout' };
      // each step's reported remaining distance must tick down to 0
      for (let i = 0; i < line.length && !bad; i++) {
        const want = root.dtw - i;
        if (line[i].plies !== want) bad = { reason: 'dtw-tick', ply: i, got: line[i].plies, want };
      }
    }
    if (bad) { badPV++; if (firstBad.length < 6) firstBad.push({ class: study.sigName(...tb.unpackSig(sig)), pos: engine.serialize({ board: h.board, turn: h.turn }), dtw: root.dtw, ...bad }); }
    else if (root.dtw > maxVerified) maxVerified = root.dtw;
  }
  check(`optimal PV reaches wipeout in exactly DTW plies (${checkedPV} classes, longest ${maxVerified})`, badPV === 0, `${badPV} bad`);
  for (const e of firstBad) console.log('     ', JSON.stringify(e));
}

// ===========================================================================
// C) class index over K3 (full scan)
// ===========================================================================
console.log('\nC) class index (K3 full scan):');
{
  const liveSigs = [...T3.sigs.keys()];
  const classes = study.buildClassIndex(T3);
  check('one class per live signature', classes.length === liveSigs.length, `${classes.length} vs ${liveSigs.length}`);

  let noHardest = 0;
  for (const c of classes) if (c.maxDtw > 0 && !c.hardest) noHardest++;
  check('every decisive class has a longest-win position', noHardest === 0, `${noHardest} missing`);

  let orderBad = 0;
  for (let i = 1; i < classes.length; i++) {
    const a = classes[i - 1], b = classes[i];
    if (a.pieces > b.pieces || (a.pieces === b.pieces && a.maxDtw < b.maxDtw)) { orderBad++; break; }
  }
  check('classes sorted by piece count then DTW desc', orderBad === 0);

  const globalMax = Math.max(...classes.map((c) => c.maxDtw));
  check('global max DTW matches the file (K3 = 20)', globalMax === 20, `got ${globalMax}`);

  // the hardest class's stored position is itself a decisive probe of that DTW
  const hardestClass = classes.slice().sort((a, b) => b.maxDtw - a.maxDtw)[0];
  const hp = T3.probe(hardestClass.hardest.board, hardestClass.hardest.turn);
  check(`hardest K3 class (${hardestClass.name}) position probes to its DTW`,
    hp && hp.dtw === hardestClass.maxDtw && hp.result !== 'draw', JSON.stringify(hp));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
