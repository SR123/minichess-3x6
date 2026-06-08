'use strict';

/*
 * Validate the tablebase's distance-to-win (DTW) for EVERY probed position, by
 * checking the retrograde recurrence directly against the engine's own move
 * generation (independent of the solver's internals):
 *
 *   WIN  position P: some legal move reaches a LOSS-for-opponent child, and
 *                    dtw(P) = 1 + min over those children of dtw(child).
 *   LOSS position P: every legal move reaches a WIN-for-opponent child, and
 *                    dtw(P) = 1 + max over all children of dtw(child).
 *   DRAW position P: dtw(P) = 0, no child is a LOSS-for-opponent (else it'd be a
 *                    win), and at least one child is a draw (the held escape).
 *
 * A move that captures the opponent's last piece is a terminal wipeout: that
 * child is a LOSS-for-its-mover with dtw 0 (the probe returns null for it, so we
 * special-case it). This is exactly the "win in N plies, strictly preferring
 * shorter" property the search relies on to make progress and promote.
 *
 *   node --max-old-space-size=2048 dtw.test.js [tb.K5.bin] [K]
 */

const engine = require('./engine');
const { Tablebase } = require('./tbprobe');

const FILE = process.argv[2] || 'tb.K5.bin';
const K = Number(process.argv[3] || 5);
const tb = new Tablebase().load(FILE);

const tbprobe = require('./tablebase');
const { SIZE, POW5, permCountForSig, unrankBoard, sigKeyOf } = tbprobe;
const codeToPiece = [null, 'B', 'Q', 'b', 'q'];

function allSignatures(K) {
  const out = [];
  for (let wQ = 0; wQ <= K; wQ++) for (let wB = 0; wB + wQ <= K; wB++)
    for (let bQ = 0; bQ + wB + wQ <= K; bQ++) for (let bB = 0; bB + bQ + wB + wQ <= K; bB++) {
      const t = wQ + wB + bQ + bB; if (t >= 1 && t <= K) out.push([wQ, wB, bQ, bB]);
    }
  return out;
}
function boardNumOf(b) { let n = 0; for (let i = 0; i < SIZE; i++) n += b[i] * POW5[i]; return n; }

// value+dtw of a child from the CHILD mover's perspective; handles terminal
// wipeouts (child mover has no pieces) which the file does not store.
function childVerdict(child) {
  const mover = child.turn;
  if (engine.countPieces(child, mover) === 0) return { result: 'loss', dtw: 0 }; // wiped out
  const opp = mover === 'w' ? 'b' : 'w';
  if (engine.countPieces(child, opp) === 0) return { result: 'win', dtw: 0 };    // already won
  return tb.probe(child.board, child.turn);
}

let checked = 0, bad = 0, examples = [];
for (const [wQ, wB, bQ, bB] of allSignatures(K)) {
  if ((wQ + wB) === 0 || (bQ + bB) === 0) continue; // terminal sigs aren't probed
  const perm = permCountForSig(wQ, wB, bQ, bB);
  for (let rank = 0; rank < perm; rank++) {
    const codes = unrankBoard(rank, wQ, wB, bQ, bB);
    const board = new Array(SIZE);
    for (let i = 0; i < SIZE; i++) board[i] = codeToPiece[codes[i]];
    for (const side of ['w', 'b']) {
      const state = { board, turn: side };
      const pr = tb.probe(board, side);
      if (!pr) continue;
      checked++;
      const moves = engine.generateMoves(state);
      let minLoss = Infinity, maxAll = -Infinity, anyLoss = false, anyDraw = false, allWin = true;
      for (const m of moves) {
        const cv = childVerdict(engine.applyMove(state, m));
        // child perspective -> from OUR perspective: child 'loss' => we win
        if (cv.result === 'loss') { anyLoss = true; if (cv.dtw < minLoss) minLoss = cv.dtw; allWin = false; }
        else if (cv.result === 'draw') { anyDraw = true; allWin = false; }
        if (cv.dtw > maxAll) maxAll = cv.dtw;
      }
      let want;
      if (pr.result === 'win') want = anyLoss && pr.dtw === 1 + minLoss;
      else if (pr.result === 'loss') want = allWin && pr.dtw === 1 + maxAll;
      else want = pr.dtw === 0 && !anyLoss && anyDraw; // draw
      if (!want) {
        bad++;
        if (examples.length < 8) examples.push({
          pos: engine.serialize(state), probe: pr,
          minLoss: minLoss === Infinity ? null : 1 + minLoss,
          maxAll: maxAll === -Infinity ? null : 1 + maxAll, anyLoss, anyDraw, allWin,
        });
      }
    }
  }
}

console.log(`DTW recurrence: checked=${checked} violations=${bad}`);
for (const e of examples) console.log('  BAD', JSON.stringify(e));
process.exit(bad === 0 ? 0 : 1);
