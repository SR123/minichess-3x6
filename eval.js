'use strict';

/*
 * Heuristic evaluation for the 3x6 bishops+queens variant. Used only ABOVE the
 * tablebase frontier (positions with more than K pieces); once a line reaches
 * <=K pieces the search returns the exact tablebase verdict instead.
 *
 * Score is in centipawn-like units, from the side-to-move's perspective
 * (negamax convention: + good for the mover). Three terms:
 *
 *   material            queens are worth far more than bishops.
 *   promotion proximity  a bishop near its promotion rank is a near-queen; the
 *                        whole game is about racing bishops to the far rank.
 *   mobility            (my legal moves - their legal moves), lightly weighted,
 *                        rewarding open diagonals and active queens.
 *
 * Terminal positions (a side wiped out) are NOT scored here -- the search
 * detects them and returns a mate score with ply distance.
 */

const { SIZE, colOf, rowOf, ROWS } = require('./engine');

const QUEEN_VALUE = 900;
const BISHOP_VALUE = 300;

// Per-step bonus as a white bishop climbs toward row 6 (index 5). A bishop on
// its start rows gets ~0; one a single step from promotion gets a big chunk of
// the queen-minus-bishop gap. Symmetric for black bishops racing toward row 1.
// rowsFromPromo: 0 means already on promo rank (can't be a bishop there),
// 1 = one step away. We reward small distances steeply.
const PROMO_BONUS = [0, 360, 200, 110, 55, 20]; // indexed by rows-from-promotion

const MOBILITY_WEIGHT = 4;

// Material + promotion proximity for one color, scanning the board once.
function staticTerms(board) {
  let white = 0, black = 0;
  for (let i = 0; i < SIZE; i++) {
    const p = board[i];
    if (p === null) continue;
    const row = rowOf(i);
    if (p === 'Q') white += QUEEN_VALUE;
    else if (p === 'q') black += QUEEN_VALUE;
    else if (p === 'B') {
      white += BISHOP_VALUE;
      const dist = (ROWS - 1) - row; // steps to row 6
      white += PROMO_BONUS[dist] || 0;
    } else if (p === 'b') {
      black += BISHOP_VALUE;
      const dist = row; // steps to row 1
      black += PROMO_BONUS[dist] || 0;
    }
  }
  return [white, black];
}

// Full evaluation from side-to-move's perspective. `myMoves`/`theirMoves` are
// optional precomputed legal-move counts (the search already has the mover's
// move list); when omitted, mobility falls back to the material+promo terms
// only (still a valid, if blunter, evaluation).
function evaluate(state, myMoves, theirMoves) {
  const [white, black] = staticTerms(state.board);
  let score = state.turn === 'w' ? white - black : black - white;
  if (myMoves != null && theirMoves != null) {
    score += MOBILITY_WEIGHT * (myMoves - theirMoves);
  }
  return score;
}

module.exports = { evaluate, staticTerms, QUEEN_VALUE, BISHOP_VALUE, PROMO_BONUS };
