'use strict';

/*
 * Rules engine for a 3x6 chess variant.
 *
 * Board: 3 columns (a,b,c) x 6 rows (1..6) = 18 squares.
 * Pieces: bishops ('B') and queens ('Q') only. They move and capture exactly
 *         as in standard chess. No kings, no check, no castling, no en passant.
 *
 * Promotion: a WHITE bishop reaching row 6 becomes a queen.
 *            a BLACK bishop reaching row 1 becomes a queen.
 *            (Queens never promote.)
 *
 * Goal: capture all enemy pieces. A side with zero pieces has lost.
 *
 * Repetition: a full position (board layout + side to move) occurring for the
 *             SECOND time is an immediate draw. (Handled by the Game driver
 *             below, which tracks position counts; pure perft does not apply it.)
 *
 * Coordinates:
 *   column a,b,c -> 0,1,2
 *   row    1..6  -> 0..5   (row index 0 is row "1", row index 5 is row "6")
 *   index = row*3 + col, range 0..17
 *
 * A piece is encoded as a string: 'B','Q' (white) or 'b','q' (black).
 * An empty square is null.
 *
 * A state is { board: Array(18) of (piece|null), turn: 'w'|'b' }.
 * A move is { from, to, promotion } where from/to are indices and promotion is
 * a boolean (true => the moving bishop becomes a queen on arrival).
 */

const COLS = 3;
const ROWS = 6;
const SIZE = COLS * ROWS;

// ---------------------------------------------------------------------------
// Square helpers
// ---------------------------------------------------------------------------

function sq(col, row) {
  return row * COLS + col;
}

function colOf(index) {
  return index % COLS;
}

function rowOf(index) {
  return Math.floor(index / COLS);
}

// "b3" -> index
function parseSquare(name) {
  const col = name.charCodeAt(0) - 'a'.charCodeAt(0); // a,b,c -> 0,1,2
  const row = name.charCodeAt(1) - '1'.charCodeAt(0); // 1..6  -> 0..5
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
    throw new Error(`Bad square: ${name}`);
  }
  return sq(col, row);
}

// index -> "b3"
function squareName(index) {
  const col = String.fromCharCode('a'.charCodeAt(0) + colOf(index));
  const row = String.fromCharCode('1'.charCodeAt(0) + rowOf(index));
  return col + row;
}

// ---------------------------------------------------------------------------
// Piece helpers
// ---------------------------------------------------------------------------

function colorOf(piece) {
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

function typeOf(piece) {
  return piece.toUpperCase(); // 'B' or 'Q'
}

function isWhite(piece) {
  return piece === piece.toUpperCase();
}

// Sliding directions as [dCol, dRow].
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const QUEEN_DIRS = BISHOP_DIRS.concat(ROOK_DIRS);

function dirsFor(piece) {
  return typeOf(piece) === 'Q' ? QUEEN_DIRS : BISHOP_DIRS;
}

// ---------------------------------------------------------------------------
// State construction
// ---------------------------------------------------------------------------

function emptyBoard() {
  return new Array(SIZE).fill(null);
}

function initialState() {
  const board = emptyBoard();
  // White: queen b1, bishops a1,a2,b2,c1,c2  (all of rows 1 & 2)
  board[parseSquare('b1')] = 'Q';
  for (const s of ['a1', 'a2', 'b2', 'c1', 'c2']) board[parseSquare(s)] = 'B';
  // Black: queen b6, bishops a5,b5,c5,a6,c6  (all of rows 5 & 6)
  board[parseSquare('b6')] = 'q';
  for (const s of ['a5', 'b5', 'c5', 'a6', 'c6']) board[parseSquare(s)] = 'b';
  return { board, turn: 'w' };
}

// Build a state from a map like {b3:'B', a4:'b'} plus side to move.
function makeState(placements, turn) {
  const board = emptyBoard();
  for (const name of Object.keys(placements)) {
    board[parseSquare(name)] = placements[name];
  }
  return { board, turn };
}

function cloneState(state) {
  return { board: state.board.slice(), turn: state.turn };
}

// Stable string key for a position (board layout + side to move).
function serialize(state) {
  let s = '';
  for (let i = 0; i < SIZE; i++) s += state.board[i] === null ? '.' : state.board[i];
  return s + ' ' + state.turn;
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

// Does moving `piece` to `to` trigger promotion?
function isPromotion(piece, to) {
  if (typeOf(piece) !== 'B') return false; // only bishops promote
  const row = rowOf(to);
  return isWhite(piece) ? row === ROWS - 1 : row === 0;
}

function generateMoves(state) {
  const { board, turn } = state;
  const moves = [];

  for (let from = 0; from < SIZE; from++) {
    const piece = board[from];
    if (piece === null || colorOf(piece) !== turn) continue;

    const fromCol = colOf(from);
    const fromRow = rowOf(from);

    for (const [dc, dr] of dirsFor(piece)) {
      let c = fromCol + dc;
      let r = fromRow + dr;
      while (c >= 0 && c < COLS && r >= 0 && r < ROWS) {
        const to = sq(c, r);
        const target = board[to];
        if (target === null) {
          moves.push({ from, to, promotion: isPromotion(piece, to) });
        } else {
          if (colorOf(target) !== turn) {
            // capture
            moves.push({ from, to, promotion: isPromotion(piece, to) });
          }
          break; // blocked by own or captured enemy piece
        }
        c += dc;
        r += dr;
      }
    }
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Move application (returns a NEW state; does not mutate the input)
// ---------------------------------------------------------------------------

function applyMove(state, move) {
  const next = cloneState(state);
  let piece = next.board[move.from];
  next.board[move.from] = null;
  if (move.promotion) {
    piece = isWhite(piece) ? 'Q' : 'q';
  }
  next.board[move.to] = piece;
  next.turn = state.turn === 'w' ? 'b' : 'w';
  return next;
}

// Human-readable move, e.g. "b5a6=Q" or "b3c4".
function moveSan(move) {
  return squareName(move.from) + squareName(move.to) + (move.promotion ? '=Q' : '');
}

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

function countPieces(state, color) {
  let n = 0;
  for (let i = 0; i < SIZE; i++) {
    const p = state.board[i];
    if (p !== null && colorOf(p) === color) n++;
  }
  return n;
}

/*
 * Terminal status of a position, ignoring repetition (which needs history).
 * Returns one of:
 *   { over: false }
 *   { over: true, result: 'w' }   white has won
 *   { over: true, result: 'b' }   black has won
 *
 * The only terminal condition here is the spec's win rule: a side with zero
 * pieces has lost. (Repetition draws are applied by the Game driver, which
 * has the position history.)
 *
 * Stalemate cannot occur on this board: the boundary of any piece's cluster
 * always abuts an empty square some piece can reach, so a side that still has
 * pieces always has a legal move. We do NOT have a stalemate result. If
 * move generation ever returns empty for a side that still has pieces, that
 * is an engine bug, so we fail loudly rather than inventing a result.
 */
function terminalStatus(state) {
  const me = state.turn;
  const them = me === 'w' ? 'b' : 'w';

  if (countPieces(state, me) === 0) {
    return { over: true, result: them }; // side to move has no pieces -> lost
  }
  if (countPieces(state, them) === 0) {
    return { over: true, result: me }; // opponent wiped out -> side to move won
  }
  if (generateMoves(state).length === 0) {
    throw new Error(
      `Engine bug: side '${me}' has pieces but no legal move (stalemate is ` +
      `supposed to be impossible). Position: ${serialize(state)}`
    );
  }
  return { over: false };
}

// ---------------------------------------------------------------------------
// Perft (pure move-sequence counting; repetition is NOT applied here)
// ---------------------------------------------------------------------------

function perft(state, depth) {
  if (depth === 0) return 1;
  const moves = generateMoves(state);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    nodes += perft(applyMove(state, move), depth - 1);
  }
  return nodes;
}

// Perft split by first move, useful for debugging.
function perftDivide(state, depth) {
  const out = {};
  for (const move of generateMoves(state)) {
    out[moveSan(move)] = depth <= 1 ? 1 : perft(applyMove(state, move), depth - 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Game driver (applies the repetition draw rule via position counts)
// ---------------------------------------------------------------------------

class Game {
  constructor(state) {
    this.state = state || initialState();
    this.counts = new Map();
    this._bump(this.state); // the starting position counts as one occurrence
  }

  _bump(state) {
    const key = serialize(state);
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    return n;
  }

  legalMoves() {
    return generateMoves(this.state);
  }

  // Apply a move and report status, including the repetition draw rule.
  play(move) {
    this.state = applyMove(this.state, move);
    const occurrences = this._bump(this.state);
    if (occurrences >= 2) {
      return { over: true, result: 'draw', reason: 'repetition' };
    }
    return terminalStatus(this.state);
  }

  status() {
    if ((this.counts.get(serialize(this.state)) || 0) >= 2) {
      return { over: true, result: 'draw', reason: 'repetition' };
    }
    return terminalStatus(this.state);
  }
}

module.exports = {
  COLS,
  ROWS,
  SIZE,
  sq,
  colOf,
  rowOf,
  parseSquare,
  squareName,
  colorOf,
  typeOf,
  initialState,
  makeState,
  cloneState,
  serialize,
  generateMoves,
  applyMove,
  moveSan,
  countPieces,
  terminalStatus,
  perft,
  perftDivide,
  Game,
};
