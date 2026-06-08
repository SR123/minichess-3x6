'use strict';

/*
 * Endgame-study queries over the exact DTW tablebase (tbprobe.js + engine.js).
 *
 * Everything here is derived from real probes -- no heuristics, no recomputation
 * of the solve. The one rule that matters is converting a successor's stored
 * value into an outcome from the CURRENT mover's perspective:
 *
 *   child = applyMove(P, m)            // the opponent O is to move in `child`
 *   - O wiped out      -> M WINS in 1 ply (terminal capture)
 *   - probe(child) from O's view:
 *       O loses (dtw d) -> M WINS,  in 1 + d plies   (sign flip: O-loss = M-win)
 *       O wins  (dtw d) -> M LOSES, in 1 + d plies
 *       O draws         -> DRAW
 *
 * The +1 is M's own move; the loss<->win flip is the side-to-move sign change.
 * Sorting moves (wins shortest-first, then draws, then losses longest-first) puts
 * the DTW-optimal move on top for BOTH roles: a winner picks the fastest win
 * (min DTW), a loser the longest survival (max DTW). Following moves[0] is the
 * principal variation, and it provably ends in a wipeout in exactly probe(P).dtw
 * plies (verified in study.test.js).
 */

const engine = require('./engine');
const tb = require('./tablebase');
const { SIZE, permCountForSig, unrankBoard, unpackSig, sigKeyOf } = tb;

const codeToPiece = [null, 'B', 'Q', 'b', 'q'];
const other = (s) => (s === 'w' ? 'b' : 'w');

// Material-class name, matching hardest.js: "BBB vs qb", "Q vs bb", ...
function sigName(wQ, wB, bQ, bB) {
  return `${'Q'.repeat(wQ)}${'B'.repeat(wB)} vs ${'q'.repeat(bQ)}${'b'.repeat(bB)}`;
}

// Outcome of one move from the MOVER's perspective, via a real probe of the
// resulting position. Returns { result:'win'|'loss'|'draw', plies:int|null }.
// `plies` is the distance to wipeout under optimal play (null for a draw).
function moveOutcome(T, state, move) {
  const child = engine.applyMove(state, move);
  const opp = other(state.turn);
  if (engine.countPieces(child, opp) === 0) return { result: 'win', plies: 1 }; // captured last piece
  const cv = T.probe(child.board, child.turn); // verdict from the opponent's perspective
  if (!cv) return null;                         // out of tablebase (more than K pieces)
  if (cv.result === 'draw') return { result: 'draw', plies: null };
  if (cv.result === 'loss') return { result: 'win', plies: 1 + cv.dtw };  // opp loses -> we win
  return { result: 'loss', plies: 1 + cv.dtw };                            // opp wins  -> we lose
}

// Sort key so the best move for the mover comes first:
//   wins  (cat 0) ordered by plies ASC  (fastest mate first)
//   draws (cat 1)
//   losses(cat 2) ordered by plies DESC (survive longest = least bad)
function moveSortKey(o) {
  if (o.result === 'win') return [0, o.plies];
  if (o.result === 'draw') return [1, 0];
  return [2, -o.plies];
}

// Full analysis of a (non-terminal) position: every legal move with its exact
// outcome, sorted best-first, each carrying the resulting board+turn so a client
// can navigate to it. optimalIndex points at the DTW-optimal move (== moves[0]).
function analyze(T, state) {
  const moves = engine.generateMoves(state);
  const rows = [];
  for (const m of moves) {
    const o = moveOutcome(T, state, m);
    if (!o) continue; // skip moves that leave the tablebase (shouldn't happen <=K)
    const child = engine.applyMove(state, m);
    rows.push({
      from: m.from, to: m.to, promotion: !!m.promotion, san: engine.moveSan(m),
      result: o.result, plies: o.plies, moves: o.plies == null ? null : Math.ceil(o.plies / 2),
      board: child.board, turn: child.turn,
    });
  }
  rows.sort((a, b) => {
    const ka = moveSortKey(a), kb = moveSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.san.localeCompare(b.san);
  });
  return { board: state.board, turn: state.turn, moves: rows, optimalIndex: rows.length ? 0 : -1 };
}

// The DTW-optimal move at a decisive position (= top of the sorted list), or null.
function optimalMove(T, state) {
  const a = analyze(T, state);
  return a.optimalIndex >= 0 ? a.moves[a.optimalIndex] : null;
}

// Principal variation from a decisive position under optimal play by BOTH sides,
// until a side is wiped out. Returns the list of half-moves taken; its length
// equals probe(board,turn).dtw for a decisive root.
function principalVariation(T, board, turn, cap = 256) {
  let state = { board: board.slice(), turn };
  const line = [];
  for (let i = 0; i < cap; i++) {
    if (engine.countPieces(state, 'w') === 0 || engine.countPieces(state, 'b') === 0) break;
    const best = optimalMove(T, state);
    if (!best) break;
    line.push({
      from: best.from, to: best.to, promotion: best.promotion, san: best.san,
      result: best.result, plies: best.plies, board: best.board, turn: best.turn,
    });
    state = { board: best.board, turn: best.turn };
  }
  return line;
}

// Every live material class in the tablebase, named and sized.
function enumerateClasses(T) {
  const out = [];
  for (const sig of T.sigs.keys()) {
    const [wQ, wB, bQ, bB] = unpackSig(sig);
    out.push({ sig, name: sigName(wQ, wB, bQ, bB), pieces: wQ + wB + bQ + bB, counts: [wQ, wB, bQ, bB] });
  }
  return out;
}

// The longest-forced-win position of one class: the max-DTW decisive position
// over all boards of that signature (both sides to move). Null if all draws.
function hardestOf(T, sig) {
  const [wQ, wB, bQ, bB] = unpackSig(sig);
  const perm = permCountForSig(wQ, wB, bQ, bB);
  let best = null;
  const board = new Array(SIZE);
  for (let rank = 0; rank < perm; rank++) {
    const codes = unrankBoard(rank, wQ, wB, bQ, bB);
    for (let i = 0; i < SIZE; i++) board[i] = codeToPiece[codes[i]];
    for (const turn of ['w', 'b']) {
      const pr = T.probe(board, turn);
      if (!pr || pr.result === 'draw') continue;
      if (!best || pr.dtw > best.dtw) {
        best = {
          board: board.slice(), turn, dtw: pr.dtw, result: pr.result,
          winner: pr.result === 'win' ? turn : other(turn),
        };
      }
    }
  }
  return best;
}

// Full study index: every class with its longest win, sorted by piece count then
// DTW (desc). One pass over the whole tablebase (~10s for K5); cache the result.
function buildClassIndex(T) {
  const classes = enumerateClasses(T).map((c) => {
    const h = hardestOf(T, c.sig);
    return {
      sig: c.sig, name: c.name, pieces: c.pieces, counts: c.counts,
      maxDtw: h ? h.dtw : 0, maxMoves: h ? Math.ceil(h.dtw / 2) : 0, hardest: h,
    };
  });
  classes.sort((a, b) => a.pieces - b.pieces || b.maxDtw - a.maxDtw || a.name.localeCompare(b.name));
  return classes;
}

module.exports = {
  sigName, moveOutcome, moveSortKey, analyze, optimalMove, principalVariation,
  enumerateClasses, hardestOf, buildClassIndex, other,
};
