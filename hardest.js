'use strict';

/*
 * "Hardest positions" report: the LONGEST forced wins in the endgame tablebase,
 * ranked by true distance-to-win (DTW = plies to wipeout under optimal play).
 *
 * Scans every probed position (both sides to move) in tb.K{K}.bin, and reports:
 *   - the global maximum DTW, how many positions reach it, and the top-N hardest
 *     WIN positions (side to move forces a win, but needs the most plies);
 *   - the per-signature maximum DTW (which material balance yields the longest
 *     grind).
 *
 * Both WIN and LOSS positions are ranked by DTW (a LOSS position with DTW d means
 * the side to move is the doomed one and the winner -- the opponent -- needs d
 * plies to finish). The single longest grind in the file sits on a LOSS-to-move
 * position: the loser is on the clock and stalls maximally, so the global max DTW
 * is one ply longer than the longest winner-to-move position.
 *
 * The numbers here are only as trustworthy as the DTW metric -- run
 * dtw-forceplay.test.js to confirm by direct forced-play simulation that these
 * "longest win" plies are real.
 *
 *   node --max-old-space-size=2048 hardest.js [tb.K5.bin] [K] [topN=12]
 */

const engine = require('./engine');
const tb = require('./tablebase');
const { Tablebase } = require('./tbprobe');
const { SIZE, COLS, ROWS, permCountForSig, unrankBoard, unpackSig } = tb;

const FILE = process.argv[2] || 'tb.K5.bin';
const K = Number(process.argv[3] || 5);
const TOPN = Number(process.argv[4] || 12);

const T = new Tablebase().load(FILE);
const codeToPiece = [null, 'B', 'Q', 'b', 'q'];

function allSignatures(K) {
  const out = [];
  for (let wQ = 0; wQ <= K; wQ++) for (let wB = 0; wB + wQ <= K; wB++)
    for (let bQ = 0; bQ + wB + wQ <= K; bQ++) for (let bB = 0; bB + bQ + wB + wQ <= K; bB++) {
      const t = wQ + wB + bQ + bB; if (t >= 1 && t <= K) out.push([wQ, wB, bQ, bB]);
    }
  return out;
}

function sigName(wQ, wB, bQ, bB) {
  return `${'Q'.repeat(wQ)}${'B'.repeat(wB)} vs ${'q'.repeat(bQ)}${'b'.repeat(bB)}`;
}

// Render an engine board (Array(18) of piece|null) as a small ASCII diagram,
// row 6 (top) down to row 1 (bottom). `turn` is whose move it is.
function ascii(board, turn) {
  const lines = [];
  for (let row = ROWS - 1; row >= 0; row--) {
    let line = (row + 1) + ' ';
    for (let col = 0; col < COLS; col++) {
      const p = board[row * COLS + col];
      line += ' ' + (p === null ? '.' : p);
    }
    lines.push(line);
  }
  lines.push('   a b c   (' + (turn === 'w' ? 'White' : 'Black') + ' to move)');
  return lines.join('\n');
}

// Keep the TOPN highest-DTW decisive positions. `winner` is the colour that wins
// ('w'/'b'); `turn` is whose move it is (= winner for a WIN, loser for a LOSS).
const top = [];                 // sorted descending by dtw
let topMin = -1;                // smallest dtw currently retained (or -1 if not full)
function offer(dtw, codes, turn, winner, sig) {
  if (top.length >= TOPN && dtw <= topMin) return;
  const board = new Array(SIZE);
  for (let i = 0; i < SIZE; i++) board[i] = codeToPiece[codes[i]];
  const entry = { dtw, board, turn, winner, sig };
  let pos = top.length;
  while (pos > 0 && top[pos - 1].dtw < dtw) pos--;
  top.splice(pos, 0, entry);
  if (top.length > TOPN) top.length = TOPN;
  topMin = top.length >= TOPN ? top[top.length - 1].dtw : -1;
}

let maxDtw = 0, maxCount = 0, scanned = 0;
const perSig = []; // { name, sig, maxDtw, total, wins }

console.log(`Scanning ${FILE} (K=${K}) for the longest forced wins...\n`);
const t0 = Date.now();

for (const [wQ, wB, bQ, bB] of allSignatures(K)) {
  if ((wQ + wB) === 0 || (bQ + bB) === 0) continue; // terminal sigs aren't probed
  const sig = tb.sigKeyOf(wQ, wB, bQ, bB);
  const perm = permCountForSig(wQ, wB, bQ, bB);
  let sigMax = -1, sigDecisive = 0, sigTotal = 0;
  for (let rank = 0; rank < perm; rank++) {
    const codes = unrankBoard(rank, wQ, wB, bQ, bB);
    const board = new Array(SIZE);
    for (let i = 0; i < SIZE; i++) board[i] = codeToPiece[codes[i]];
    for (const side of ['w', 'b']) {
      const pr = T.probe(board, side);
      if (!pr) continue;
      scanned++;
      sigTotal++;
      if (pr.result === 'draw') continue;
      sigDecisive++;
      const winner = pr.result === 'win' ? side : (side === 'w' ? 'b' : 'w');
      const d = pr.dtw;
      if (d > sigMax) sigMax = d;
      if (d > maxDtw) { maxDtw = d; maxCount = 1; } else if (d === maxDtw) maxCount++;
      offer(d, codes, side, winner, sig);
    }
  }
  perSig.push({ name: sigName(wQ, wB, bQ, bB), maxDtw: sigMax, total: sigTotal, decisive: sigDecisive });
}

// --- report -----------------------------------------------------------------
console.log(`Scanned ${scanned.toLocaleString()} probed positions in ` +
  `${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);
console.log(`Global maximum DTW = ${maxDtw} plies (${Math.ceil(maxDtw / 2)} moves), ` +
  `reached by ${maxCount.toLocaleString()} position(s).\n`);

console.log(`Top ${top.length} hardest positions (longest optimal win):`);
console.log('='.repeat(40));
top.forEach((e, i) => {
  const [wQ, wB, bQ, bB] = unpackSig(e.sig);
  const mover = e.turn === e.winner ? 'winner to move' : 'loser to move (stalling)';
  console.log(`\n#${i + 1}  DTW ${e.dtw} plies (${Math.ceil(e.dtw / 2)} moves) — ` +
    `${sigName(wQ, wB, bQ, bB)} — ${e.winner === 'w' ? 'White' : 'Black'} wins (${mover})`);
  console.log(`    ${engine.serialize({ board: e.board, turn: e.turn })}`);
  console.log(ascii(e.board, e.turn).split('\n').map((l) => '    ' + l).join('\n'));
});

console.log('\n\nPer-signature longest win (sorted):');
console.log('='.repeat(40));
perSig.filter((s) => s.decisive > 0).sort((a, b) => b.maxDtw - a.maxDtw).forEach((s) => {
  console.log(`  ${String(s.maxDtw).padStart(3)} plies  ${s.name.padEnd(14)}` +
    `  (${s.decisive.toLocaleString()} decisive / ${s.total.toLocaleString()} probed)`);
});
