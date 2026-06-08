/*
 * Featherweight (browser) port of the endgame-study queries from tbstudy.js.
 * Pure logic over a loaded MiniTB.Tablebase + MiniEngine -- no DOM, no I/O.
 * Dual-loaded so docs-parity.test.js can confirm it matches the server's
 * tbstudy.js exactly on K3 positions.
 *
 * The conversion rule (successor's stored value -> outcome from the current
 * mover's view) is identical to the server: opponent-loss = our win, +1 ply per
 * move. Sorting wins-shortest / draws / losses-longest puts the DTW-optimal move
 * on top for both roles, so following moves[0] is the optimal principal
 * variation and ends in a wipeout in exactly probe(root).dtw plies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./tablebase'));
  else root.MiniStudy = factory(root.MiniEngine, root.MiniTB);
})(typeof self !== 'undefined' ? self : this, function (engine, MTB) {
  'use strict';

  const SIZE = MTB.SIZE;
  const codeToPiece = [null, 'B', 'Q', 'b', 'q'];
  const other = (s) => (s === 'w' ? 'b' : 'w');

  function sigName(wQ, wB, bQ, bB) {
    return `${'Q'.repeat(wQ)}${'B'.repeat(wB)} vs ${'q'.repeat(bQ)}${'b'.repeat(bB)}`;
  }

  // Outcome of one move from the mover's perspective via a real probe of the
  // resulting position. { result:'win'|'loss'|'draw', plies:int|null }.
  function moveOutcome(T, state, move) {
    const child = engine.applyMove(state, move);
    const opp = other(state.turn);
    if (engine.countPieces(child, opp) === 0) return { result: 'win', plies: 1 };
    const cv = T.probe(child.board, child.turn);
    if (!cv) return null;
    if (cv.result === 'draw') return { result: 'draw', plies: null };
    if (cv.result === 'loss') return { result: 'win', plies: 1 + cv.dtw };
    return { result: 'loss', plies: 1 + cv.dtw };
  }

  // best-first: wins by plies asc, then draws, then losses by plies desc
  function moveSortKey(o) {
    if (o.result === 'win') return [0, o.plies];
    if (o.result === 'draw') return [1, 0];
    return [2, -o.plies];
  }

  function analyze(T, state) {
    const moves = engine.generateMoves(state);
    const rows = [];
    for (const m of moves) {
      const o = moveOutcome(T, state, m);
      if (!o) continue;
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

  function optimalMove(T, state) {
    const a = analyze(T, state);
    return a.optimalIndex >= 0 ? a.moves[a.optimalIndex] : null;
  }

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

  function enumerateClasses(T) {
    const out = [];
    for (const sig of T.sigs.keys()) {
      const [wQ, wB, bQ, bB] = MTB.unpackSig(sig);
      out.push({ sig, name: sigName(wQ, wB, bQ, bB), pieces: wQ + wB + bQ + bB, counts: [wQ, wB, bQ, bB] });
    }
    return out;
  }

  function hardestOf(T, sig) {
    const [wQ, wB, bQ, bB] = MTB.unpackSig(sig);
    const perm = MTB.permCountForSig(wQ, wB, bQ, bB);
    let best = null;
    const board = new Array(SIZE);
    for (let rank = 0; rank < perm; rank++) {
      const codes = MTB.unrankBoard(rank, wQ, wB, bQ, bB);
      for (let i = 0; i < SIZE; i++) board[i] = codeToPiece[codes[i]];
      for (const turn of ['w', 'b']) {
        const pr = T.probe(board, turn);
        if (!pr || pr.result === 'draw') continue;
        if (!best || pr.dtw > best.dtw) {
          best = { board: board.slice(), turn, dtw: pr.dtw, result: pr.result, winner: pr.result === 'win' ? turn : other(turn) };
        }
      }
    }
    return best;
  }

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

  return {
    sigName, moveOutcome, moveSortKey, analyze, optimalMove, principalVariation,
    enumerateClasses, hardestOf, buildClassIndex, other,
  };
});
