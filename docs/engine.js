/*
 * Featherweight (browser) port of the 3x6 bishops+queens rules from engine.js.
 *
 * This is a faithful copy of the rules needed by the study tool: move
 * generation, move application, piece counting, SAN, and serialization. It is
 * dual-loaded -- it attaches to `window.MiniEngine` in a browser AND exports
 * under Node (module.exports) so docs-parity.test.js can compare it against the
 * server-side engine.js. No DOM, no I/O here.
 *
 * Board: index = row*3 + col, 0..17. row 0 = rank "1" (white home),
 * row 5 = rank "6" (black home). Pieces: 'B','Q' white, 'b','q' black, null empty.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiniEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 3, ROWS = 6, SIZE = COLS * ROWS;

  const colOf = (i) => i % COLS;
  const rowOf = (i) => Math.floor(i / COLS);
  const sq = (col, row) => row * COLS + col;
  const squareName = (i) =>
    String.fromCharCode(97 + colOf(i)) + String.fromCharCode(49 + rowOf(i));

  const isWhite = (p) => p === p.toUpperCase();
  const colorOf = (p) => (isWhite(p) ? 'w' : 'b');
  const typeOf = (p) => p.toUpperCase(); // 'B' | 'Q'

  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const QUEEN_DIRS = BISHOP_DIRS.concat(ROOK_DIRS);
  const dirsFor = (p) => (typeOf(p) === 'Q' ? QUEEN_DIRS : BISHOP_DIRS);

  // A bishop reaching the far rank promotes (white -> row 6, black -> row 1).
  function isPromotion(piece, to) {
    if (typeOf(piece) !== 'B') return false;
    const row = rowOf(to);
    return isWhite(piece) ? row === ROWS - 1 : row === 0;
  }

  function cloneState(state) { return { board: state.board.slice(), turn: state.turn }; }

  function generateMoves(state) {
    const { board, turn } = state;
    const moves = [];
    for (let from = 0; from < SIZE; from++) {
      const piece = board[from];
      if (piece === null || colorOf(piece) !== turn) continue;
      const fc = colOf(from), fr = rowOf(from);
      for (const [dc, dr] of dirsFor(piece)) {
        let c = fc + dc, r = fr + dr;
        while (c >= 0 && c < COLS && r >= 0 && r < ROWS) {
          const to = sq(c, r);
          const target = board[to];
          if (target === null) {
            moves.push({ from, to, promotion: isPromotion(piece, to) });
          } else {
            if (colorOf(target) !== turn) moves.push({ from, to, promotion: isPromotion(piece, to) });
            break; // own piece or captured enemy blocks the ray
          }
          c += dc; r += dr;
        }
      }
    }
    return moves;
  }

  function applyMove(state, move) {
    const next = cloneState(state);
    let piece = next.board[move.from];
    next.board[move.from] = null;
    if (move.promotion) piece = isWhite(piece) ? 'Q' : 'q';
    next.board[move.to] = piece;
    next.turn = state.turn === 'w' ? 'b' : 'w';
    return next;
  }

  function moveSan(move) {
    return squareName(move.from) + squareName(move.to) + (move.promotion ? '=Q' : '');
  }

  function countPieces(state, color) {
    let n = 0;
    for (let i = 0; i < SIZE; i++) {
      const p = state.board[i];
      if (p !== null && colorOf(p) === color) n++;
    }
    return n;
  }

  function serialize(state) {
    let s = '';
    for (let i = 0; i < SIZE; i++) s += state.board[i] === null ? '.' : state.board[i];
    return s + ' ' + state.turn;
  }

  return {
    COLS, ROWS, SIZE, colOf, rowOf, sq, squareName,
    isWhite, colorOf, typeOf, generateMoves, applyMove, moveSan,
    countPieces, serialize, cloneState,
  };
});
