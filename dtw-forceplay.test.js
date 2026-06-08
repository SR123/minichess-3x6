'use strict';

/*
 * INDEPENDENT verification of distance-to-win (DTW) by direct forced-play
 * simulation.
 *
 * dtw.test.js checks the LOCAL one-ply recurrence (dtw == 1 + min/max child dtw)
 * for every position. That is inductively sound but never actually plays a game
 * out -- it trusts the children's stored numbers. This test is the end-to-end
 * cross-check: for a sample of positions it PLAYS REAL MOVES on engine.js, with
 *
 *     the winner choosing the move that MINIMISES its distance to wipeout, and
 *     the loser choosing the move that MAXIMISES it (stalls as long as possible),
 *
 * and confirms the resulting game ends in a wipeout in EXACTLY DTW plies -- the
 * loser wiped out, the winner standing. If the forced game does not last exactly
 * `dtw` plies, or visits a position twice (an optimal DTW line must be acyclic),
 * or the wrong side is wiped out, the mismatch is reported LOUDLY and the test
 * fails.
 *
 * The sample is the N longest wins in the file (so the headline "longest win"
 * numbers are verified directly) plus a strided sweep across all signatures and
 * both colours for breadth.
 *
 *   node --max-old-space-size=2048 dtw-forceplay.test.js [tb.K5.bin] [K]
 */

const engine = require('./engine');
const tb = require('./tablebase');
const { Tablebase } = require('./tbprobe');
const { SIZE, permCountForSig, unrankBoard } = tb;

const FILE = process.argv[2] || 'tb.K5.bin';
const K = Number(process.argv[3] || 5);
const HARDEST = Number(process.argv[4] || 300);  // verify this many longest wins
const STRIDE = Number(process.argv[5] || 1500);  // plus every STRIDE-th decisive pos

const T = new Tablebase().load(FILE);
const codeToPiece = [null, 'B', 'Q', 'b', 'q'];
const other = (s) => (s === 'w' ? 'b' : 'w');

function allSignatures(K) {
  const out = [];
  for (let wQ = 0; wQ <= K; wQ++) for (let wB = 0; wB + wQ <= K; wB++)
    for (let bQ = 0; bQ + wB + wQ <= K; bQ++) for (let bB = 0; bB + bQ + wB + wQ <= K; bB++) {
      const t = wQ + wB + bQ + bB; if (t >= 1 && t <= K) out.push([wQ, wB, bQ, bB]);
    }
  return out;
}

// Verdict + DTW of a child position, from the CHILD mover's perspective. Handles
// terminal wipeouts (a side has 0 pieces) which the file does not store.
function childVerdict(child) {
  const mover = child.turn;
  if (engine.countPieces(child, mover) === 0) return { result: 'loss', dtw: 0 }; // just got wiped out
  if (engine.countPieces(child, other(mover)) === 0) return { result: 'win', dtw: 0 }; // opponent gone
  return T.probe(child.board, child.turn);
}

// Play a decisive position out under optimal DTW play and verify the game lasts
// EXACTLY the stored DTW. Returns null on success, or a {reason, ...} on failure.
function verifyRollout(board, turn) {
  const root = T.probe(board, turn);
  if (!root || root.result === 'draw') return null; // only decisive positions
  const expected = root.dtw;
  const winner = root.result === 'win' ? turn : other(turn);

  let state = { board: board.slice(), turn };
  let plies = 0;
  const seen = new Set([engine.serialize(state)]);

  while (true) {
    // terminal? (a side has been wiped out)
    if (engine.countPieces(state, state.turn) === 0 ||
        engine.countPieces(state, other(state.turn)) === 0) break;

    const pr = T.probe(state.board, state.turn);
    if (!pr) return { reason: 'probe-null', pos: engine.serialize(state), plies };
    // remaining distance must tick down by exactly one each ply
    if (pr.dtw !== expected - plies) {
      return { reason: 'dtw-desync', pos: engine.serialize(state), plies, got: pr.dtw, want: expected - plies };
    }

    const moves = engine.generateMoves(state);
    let chosen = null;
    if (state.turn === winner) {
      // winner: among winning moves (child is a LOSS for its mover) take min child DTW
      let bestD = Infinity;
      for (const m of moves) {
        const cv = childVerdict(engine.applyMove(state, m));
        if (cv.result === 'loss' && cv.dtw < bestD) { bestD = cv.dtw; chosen = m; }
      }
      if (chosen === null) return { reason: 'winner-no-win', pos: engine.serialize(state), plies };
      if (1 + bestD !== pr.dtw) {
        return { reason: 'winner-dtw', pos: engine.serialize(state), plies, got: 1 + bestD, want: pr.dtw };
      }
    } else {
      // loser: every move loses; take the move that MAXIMISES child DTW (stall).
      let bestD = -Infinity, escape = false;
      for (const m of moves) {
        const cv = childVerdict(engine.applyMove(state, m));
        if (cv.result !== 'win') escape = true;             // a non-losing reply => not really a loss
        if (cv.dtw > bestD) { bestD = cv.dtw; chosen = m; }
      }
      if (escape) return { reason: 'loser-has-escape', pos: engine.serialize(state), plies };
      if (1 + bestD !== pr.dtw) {
        return { reason: 'loser-dtw', pos: engine.serialize(state), plies, got: 1 + bestD, want: pr.dtw };
      }
    }

    state = engine.applyMove(state, chosen);
    plies++;
    const key = engine.serialize(state);
    if (seen.has(key)) return { reason: 'cycle', pos: key, plies };
    seen.add(key);
    if (plies > expected + 2) return { reason: 'overrun', pos: key, plies, want: expected };
  }

  // game over: it must have lasted exactly `expected` plies, with the loser wiped
  if (plies !== expected) {
    return { reason: 'length', pos: engine.serialize({ board, turn }), plies, want: expected };
  }
  const loser = other(winner);
  if (engine.countPieces(state, loser) !== 0 || engine.countPieces(state, winner) === 0) {
    return { reason: 'wrong-wipeout', pos: engine.serialize(state), plies, winner };
  }
  return null;
}

// --- build the sample -------------------------------------------------------
// One pass over every probed position: keep the HARDEST longest wins, and every
// STRIDE-th decisive position for breadth.
console.log(`Sampling ${FILE} (K=${K}): top ${HARDEST} longest wins + every ${STRIDE}th decisive position...`);
const hardest = [];     // {dtw, board, turn} sorted desc, capped at HARDEST
let hardMin = -1;
const strided = [];
let decisiveSeen = 0, t0 = Date.now();

function offerHard(dtw, board, turn) {
  if (hardest.length >= HARDEST && dtw <= hardMin) return;
  const entry = { dtw, board: board.slice(), turn };
  let pos = hardest.length;
  while (pos > 0 && hardest[pos - 1].dtw < dtw) pos--;
  hardest.splice(pos, 0, entry);
  if (hardest.length > HARDEST) hardest.length = HARDEST;
  hardMin = hardest.length >= HARDEST ? hardest[hardest.length - 1].dtw : -1;
}

for (const [wQ, wB, bQ, bB] of allSignatures(K)) {
  if ((wQ + wB) === 0 || (bQ + bB) === 0) continue;
  const perm = permCountForSig(wQ, wB, bQ, bB);
  for (let rank = 0; rank < perm; rank++) {
    const codes = unrankBoard(rank, wQ, wB, bQ, bB);
    const board = new Array(SIZE);
    for (let i = 0; i < SIZE; i++) board[i] = codeToPiece[codes[i]];
    for (const turn of ['w', 'b']) {
      const pr = T.probe(board, turn);
      if (!pr || pr.result === 'draw') continue;
      offerHard(pr.dtw, board, turn);
      if (decisiveSeen % STRIDE === 0) strided.push({ board: board.slice(), turn });
      decisiveSeen++;
    }
  }
}
console.log(`  ${decisiveSeen.toLocaleString()} decisive positions; verifying ` +
  `${hardest.length} hardest + ${strided.length} strided by forced play ` +
  `(${((Date.now() - t0) / 1000).toFixed(1)}s to sample).\n`);

// --- run the rollouts -------------------------------------------------------
const sample = hardest.map((h) => ({ board: h.board, turn: h.turn })).concat(strided);
let checked = 0, bad = 0, maxVerified = 0;
const examples = [];
t0 = Date.now();
for (const s of sample) {
  const fail = verifyRollout(s.board, s.turn);
  checked++;
  if (fail) {
    bad++;
    if (examples.length < 8) examples.push(fail);
  } else {
    const d = T.probe(s.board, s.turn).dtw;
    if (d > maxVerified) maxVerified = d;
  }
}

console.log(`Forced-play DTW: verified=${checked} mismatches=${bad} ` +
  `longest-win-verified=${maxVerified} plies  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
for (const e of examples) console.log('  MISMATCH', JSON.stringify(e));
if (bad > 0) console.log('\n*** DTW FORCED-PLAY MISMATCH -- the longest-win numbers are NOT trustworthy ***');
process.exit(bad === 0 ? 0 : 1);
