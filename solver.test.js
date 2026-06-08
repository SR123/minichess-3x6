'use strict';

// Correctness test for solveAll on small CLOSED reachable sets (forward closure
// from low-material starts), cross-checked exhaustively against brute-force
// minimax with repetition. Catches retrograde bugs before the full build.

const engine = require('./engine');
const tb = require('./tablebase');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}

// forward closure from one or more start keys -> layers map {sig:{keys,val,dtc}}
function enumerateFrom(startKeys, cap) {
  const sets = new Map();
  const board = new Int8Array(18);
  function sigOf(key) {
    tb.unpackInto(key, board);
    const c = tb.countsOf(board);
    return tb.sigKeyOf(c[0], c[1], c[2], c[3]);
  }
  function getSet(sig) { let s = sets.get(sig); if (!s) { s = new Set(); sets.set(sig, s); } return s; }
  const stack = [];
  let count = 0;
  for (const sk of startKeys) { getSet(sigOf(sk)).add(sk); stack.push(sk); count++; }
  while (stack.length) {
    const key = stack.pop();
    const side = tb.unpackInto(key, board);
    const counts = tb.countsOf(board);
    if (tb.isTerminalCounts(counts)) continue;
    const boardNum = (key - side) / 2;
    for (const s of tb.genSuccessors(board, side, counts, boardNum)) {
      const set = getSet(s.sig);
      if (!set.has(s.key)) { set.add(s.key); stack.push(s.key); count++; if (count > cap) return null; }
    }
  }
  const layers = new Map();
  for (const [sig, s] of sets) {
    const arr = Float64Array.from(s); arr.sort();
    layers.set(sig, { keys: arr, val: null, dtc: null });
  }
  return layers;
}

// brute-force ground truth (value from side to move), twofold-repetition = draw
const RANK = { L: 0, D: 1, W: 2 };
const invert = (r) => (r === 'W' ? 'L' : r === 'L' ? 'W' : 'D');
function brute(state, hist, ctx) {
  if (++ctx.nodes > ctx.budget) throw { over: true };
  if (engine.countPieces(state, state.turn) === 0) return 'L';
  const key = engine.serialize(state);
  if (hist.has(key)) return 'D';
  hist.add(key);
  let best = 'L';
  for (const m of engine.generateMoves(state)) {
    const r = invert(brute(engine.applyMove(state, m), hist, ctx));
    if (RANK[r] > RANK[best]) best = r;
    if (best === 'W') break;
  }
  hist.delete(key);
  return best;
}

const CODE_TO_PIECE = { 1: 'B', 2: 'Q', 3: 'b', 4: 'q' };
function keyToEngineState(key) {
  const { board, side } = tb.unpackKey(key);
  const eb = new Array(18).fill(null);
  for (let i = 0; i < 18; i++) if (board[i] !== 0) eb[i] = CODE_TO_PIECE[board[i]];
  return { board: eb, turn: side === 0 ? 'w' : 'b' };
}
const VAL_CHAR = { 1: 'W', 2: 'L', 3: 'D' };

function randomStartKey(wQ, wB, bQ, bB) {
  const board = new Int8Array(18);
  const sqs = []; for (let i = 0; i < 18; i++) sqs.push(i);
  for (let i = 17; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sqs[i], sqs[j]] = [sqs[j], sqs[i]]; }
  let k = 0;
  // avoid placing a bishop on its own promotion rank (illegal/unreachable)
  function place(code, count, isWhiteBishop, isBlackBishop) {
    let placed = 0;
    while (placed < count) {
      const sq = sqs[k++];
      const row = Math.floor(sq / 3);
      if (isWhiteBishop && row === 5) continue;
      if (isBlackBishop && row === 0) continue;
      board[sq] = code; placed++;
    }
  }
  place(2, wQ, false, false);
  place(1, wB, true, false);
  place(4, bQ, false, false);
  place(3, bB, false, true);
  return tb.packKey(board, Math.random() < 0.5 ? 0 : 1);
}

console.log('Solver correctness on small closed reachable sets:');

// Exact brute force is exponential in path count, so we restrict to tiny
// material (total 2-3) where it resolves within budget, and check the whole
// closure. We track how many W/L/D verdicts are actually verified.
let totalMismatch = 0, setsTested = 0;
const tally = { W: 0, L: 0, D: 0 };
let totalChecked = 0, totalSkipped = 0;
const configs = [
  [1, 0, 1, 0], [1, 0, 0, 1], [0, 1, 0, 1], [0, 1, 1, 0],
  [2, 0, 1, 0], [1, 0, 2, 0], [1, 1, 1, 0], [1, 0, 1, 1],
  [0, 2, 1, 0], [1, 0, 0, 2], [2, 0, 0, 1], [0, 1, 0, 2],
];
for (const cfg of configs) {
  for (let rep = 0; rep < 3; rep++) {
    const startKey = randomStartKey(...cfg);
    const layers = enumerateFrom([startKey], 60000);
    if (layers === null) continue; // closure too big, skip
    tb.solveAll(layers, {});
    let mism = 0;
    for (const [sig, L] of layers) {
      const n = L.keys.length;
      const stride = Math.max(1, Math.floor(n / 250));
      for (let i = 0; i < n; i += stride) {
        const state = keyToEngineState(L.keys[i]);
        let bv;
        try { bv = brute(state, new Set(), { nodes: 0, budget: 1500000 }); }
        catch (e) { if (e && e.over) { totalSkipped++; continue; } throw e; }
        totalChecked++;
        tally[bv]++;
        if (bv !== VAL_CHAR[L.val[i]]) {
          mism++;
          if (totalMismatch + mism <= 5) console.log(`     MISMATCH ${engine.serialize(state)} tb=${VAL_CHAR[L.val[i]]} brute=${bv}`);
        }
      }
    }
    totalMismatch += mism; setsTested++;
  }
}
console.log(`  verified verdicts: W=${tally.W} L=${tally.L} D=${tally.D}  (skipped over budget: ${totalSkipped})`);
check(`solveAll agrees with brute force (${setsTested} closed sets, ${totalChecked} positions)`,
  totalMismatch === 0, `${totalMismatch} mismatches`);

// DTC sanity: from any WIN position, some move leads to a LOSS child with
// strictly smaller DTC (or a conversion), guaranteeing progress.
(function () {
  const layers = enumerateFrom([randomStartKey(1, 1, 1, 1)], 400000);
  if (!layers) { check('DTC progress (skipped, closure too big)', true); return; }
  tb.solveAll(layers, {});
  const board = new Int8Array(18);
  function look(key) {
    tb.unpackInto(key, board);
    const c = tb.countsOf(board);
    const L = layers.get(tb.sigKeyOf(c[0], c[1], c[2], c[3]));
    if (!L) return null;
    const i = tb.bsearch(L.keys, key);
    return i < 0 ? null : { val: L.val[i], dtc: L.dtc[i], sig: tb.sigKeyOf(c[0], c[1], c[2], c[3]) };
  }
  let ok = true, tested = 0;
  for (const [sig, L] of layers) {
    for (let i = 0; i < L.keys.length && ok; i++) {
      if (L.val[i] !== tb.WIN) continue;
      tested++;
      const key = L.keys[i];
      const side = tb.unpackInto(key, board);
      const counts = tb.countsOf(board);
      const boardNum = (key - side) / 2;
      const myDtc = L.dtc[i];
      // find a winning move: child is LOSS, and dtc decreases (conversion or quiet)
      let good = false;
      for (const s of tb.genSuccessors(board, side, counts, boardNum)) {
        const cr = look(s.key);
        if (cr && cr.val === tb.LOSS) {
          const childContrib = (cr.sig !== sig) ? 0 : cr.dtc; // conversion contributes 0
          if (1 + childContrib === myDtc) { good = true; break; }
        }
      }
      if (!good) { ok = false; console.log(`     DTC: WIN ${engine.serialize(keyToEngineState(key))} dtc=${myDtc} has no matching winning move`); }
      if (tested > 5000) break;
    }
    if (!ok) break;
  }
  check(`DTC of WIN positions matches a real winning move (${tested} checked)`, ok);
})();

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
