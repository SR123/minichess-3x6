'use strict';
// Fast consistency check: the probe (load from file) must agree with what
// solveAll computed in memory, for every position. This validates the
// enumerate -> solve -> serialize -> load -> rank-index round trip.
// (solveAll itself is brute-force-validated in solver.test.js.)

const tb = require('./tablebase');
const { Tablebase } = require('./tbprobe');
const {
  SIZE, POW5, permCountForSig, unrankBoard, sigKeyOf, unpackSig,
  solveAll, WIN, LOSS, DRAW,
} = tb;

const K = Number(process.argv[3] || 3);
const FILE = process.argv[2] || `tb.K${K}.bin`;

function boardNumOf(board) { let n = 0; for (let i = 0; i < SIZE; i++) n += board[i] * POW5[i]; return n; }
function allSignatures(K) {
  const out = [];
  for (let wQ = 0; wQ <= K; wQ++) for (let wB = 0; wB + wQ <= K; wB++)
    for (let bQ = 0; bQ + wB + wQ <= K; bQ++) for (let bB = 0; bB + bQ + wB + wQ <= K; bB++) {
      const t = wQ + wB + bQ + bB; if (t >= 1 && t <= K) out.push([wQ, wB, bQ, bB]);
    }
  return out;
}

// rebuild layers in memory and solve
const sigs = allSignatures(K);
const layers = new Map();
for (const [wQ, wB, bQ, bB] of sigs) {
  const sig = sigKeyOf(wQ, wB, bQ, bB);
  const perm = permCountForSig(wQ, wB, bQ, bB);
  const keys = new Float64Array(perm * 2);
  let k = 0;
  for (let r = 0; r < perm; r++) { const bn = boardNumOf(unrankBoard(r, wQ, wB, bQ, bB)); keys[k++] = bn * 2; keys[k++] = bn * 2 + 1; }
  keys.sort();
  layers.set(sig, { keys, val: null, dtc: null });
}
solveAll(layers, {});

const T = new Tablebase().load(FILE);
const VAL = { [WIN]: 'win', [LOSS]: 'loss', [DRAW]: 'draw' };
const codeToPiece = [null, 'B', 'Q', 'b', 'q'];

let checked = 0, mism = 0;
for (const [wQ, wB, bQ, bB] of sigs) {
  if ((wQ + wB) === 0 || (bQ + bB) === 0) continue; // terminal: not probed
  const sig = sigKeyOf(wQ, wB, bQ, bB);
  const L = layers.get(sig);
  for (let i = 0; i < L.keys.length; i++) {
    const key = L.keys[i];
    const side = key % 2;
    let n = (key - side) / 2;
    const board = new Array(SIZE);
    for (let c = 0; c < SIZE; c++) { const code = n % 5; board[c] = codeToPiece[code]; n = (n - code) / 5; }
    const turn = side === 0 ? 'w' : 'b';
    const pr = T.probe(board, turn);
    const want = VAL[L.val[i]];
    checked++;
    if (!pr || pr.result !== want) {
      mism++;
      if (mism <= 8) console.log('MISMATCH', tb.colOf ? '' : '', 'side', turn, 'tb=', pr && pr.result, 'want=', want);
    }
  }
}
console.log(`probe-vs-solver: checked=${checked} mismatches=${mism}`);
process.exit(mism === 0 ? 0 : 1);
