'use strict';

const {
  initialState,
  makeState,
  generateMoves,
  applyMove,
  moveSan,
  terminalStatus,
  perft,
  Game,
} = require('./engine');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

// Assert the exact set of legal moves (as SAN strings) from a state.
function checkMoves(name, state, expected) {
  const got = generateMoves(state).map(moveSan).sort();
  const want = expected.slice().sort();
  const equal =
    got.length === want.length && got.every((m, i) => m === want[i]);
  check(name, equal, `got [${got.join(', ')}]  want [${want.join(', ')}]`);
}

// ---------------------------------------------------------------------------
// Perft
// ---------------------------------------------------------------------------

console.log('Perft from the initial position:');
const perftResults = [];
for (let d = 1; d <= 4; d++) {
  const n = perft(initialState(), d);
  perftResults[d] = n;
  console.log(`  perft(${d}) = ${n}`);
}
console.log('');

console.log('Tests:');

// We hand-verified perft(1): white has exactly 6 legal moves from the start
// (a2-b3, a2-c4, c2-b3, c2-a4, b2-a3, b2-c3; the back-rank pieces are all
// blocked by their own neighbours).
check('perft(1) == 6', perftResults[1] === 6, `got ${perftResults[1]}`);
// Sanity: perft strictly grows over these depths and is non-trivial.
check('perft depths increase', perftResults[2] > perftResults[1] &&
  perftResults[3] > perftResults[2] && perftResults[4] > perftResults[3]);

// Cross-check: perft(2) equals the sum over each legal reply.
(function () {
  let sum = 0;
  for (const m of generateMoves(initialState())) {
    sum += generateMoves(applyMove(initialState(), m)).length;
  }
  check('perft(2) == sum of replies', sum === perftResults[2],
    `sum ${sum} vs perft ${perftResults[2]}`);
})();

// ---------------------------------------------------------------------------
// Hand-specified move sets
// ---------------------------------------------------------------------------

// 1) Lone white bishop on b3, empty board. Reaches the four corners-ish squares.
checkMoves('bishop b3 on empty board',
  makeState({ b3: 'B' }, 'w'),
  ['b3a4', 'b3c4', 'b3a2', 'b3c2']);

// 2) Lone white queen on b3, empty board: 4 diagonal + 7 orthogonal = 11.
checkMoves('queen b3 on empty board',
  makeState({ b3: 'Q' }, 'w'),
  [
    // diagonals
    'b3a4', 'b3c4', 'b3a2', 'b3c2',
    // file (up then down)
    'b3b4', 'b3b5', 'b3b6', 'b3b2', 'b3b1',
    // rank
    'b3a3', 'b3c3',
  ]);

// 3) White bishop on b5 promotes when it steps onto row 6.
checkMoves('white bishop b5 promotes on row 6',
  makeState({ b5: 'B' }, 'w'),
  ['b5a6=Q', 'b5c6=Q', 'b5a4', 'b5c4']);

// 4) Black bishop on b2 promotes when it steps onto row 1.
checkMoves('black bishop b2 promotes on row 1',
  makeState({ b2: 'b' }, 'b'),
  ['b2a1=Q', 'b2c1=Q', 'b2a3', 'b2c3']);

// 5) Queens do NOT promote: white queen on b5 reaching row 6 stays a queen.
checkMoves('queen b5 does not promote',
  makeState({ b5: 'Q' }, 'w'),
  [
    'b5a6', 'b5c6',        // diagonals onto row 6, no '=Q'
    'b5a4', 'b5c4',        // diagonals down
    'b5b6', 'b5b4', 'b5b3', 'b5b2', 'b5b1', // file
    'b5a5', 'b5c5',        // rank
  ]);

// 6) Captures and blocking, fully enumerated. White bishop b3 may capture the
//    black bishop on a4 but is blocked down-right by its own bishop on c2
//    (which itself can only slide to b1).
checkMoves('bishop b3 captures enemy, blocked by own',
  makeState({ b3: 'B', a4: 'b', c2: 'B' }, 'w'),
  [
    'b3a4', // capture
    'b3c4', // empty
    'b3a2', // empty
    // b3 cannot reach c2 (own piece blocks down-right)
    'c2b1', // the blocker's own move
  ]);

// 7) Sliding stops at the first piece in the line. White queen a1, black
//    bishop on a3: queen may move a2 and capture a3, but not beyond.
checkMoves('queen a1 slides up the file, captures, stops',
  makeState({ a1: 'Q', a3: 'b' }, 'w'),
  [
    'a1a2', 'a1a3',                // up the a-file: empty a2, capture a3, stop
    'a1b1', 'a1c1',                // along rank 1
    'a1b2', 'a1c3',                // up-right diagonal
  ]);

// 8) A fully blocked piece contributes nothing. White bishop a1's only
//    diagonal is up-right to b2, which is occupied by its own bishop, so a1
//    has zero moves; only b2's moves appear (a1 blocks its down-left).
checkMoves('boxed-in bishop has no moves',
  makeState({ a1: 'B', b2: 'B' }, 'w'),
  ['b2a3', 'b2c3', 'b2c1']);

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

// White to move but white has no pieces -> black has won.
(function () {
  const st = makeState({ a1: 'b' }, 'w');
  const t = terminalStatus(st);
  check('no pieces => loss', t.over && t.result === 'b', JSON.stringify(t));
})();

// White to move, black has no pieces -> white has won.
(function () {
  const st = makeState({ a1: 'B' }, 'w');
  const t = terminalStatus(st);
  check('enemy wiped out => win', t.over && t.result === 'w', JSON.stringify(t));
})();

// Capturing the last enemy piece ends the game in your favour.
(function () {
  const st = makeState({ b3: 'B', a4: 'b' }, 'w'); // white can take the only black piece
  const after = applyMove(st, generateMoves(st).find((m) => moveSan(m) === 'b3a4'));
  const t = terminalStatus(after);
  check('capturing last enemy piece wins', t.over && t.result === 'w', JSON.stringify(t));
})();

// Ongoing position is not terminal.
(function () {
  const t = terminalStatus(initialState());
  check('start position is not terminal', t.over === false, JSON.stringify(t));
})();

// ---------------------------------------------------------------------------
// Repetition draw
// ---------------------------------------------------------------------------

// Shuffle two bishops out and back; the start position recurs -> draw.
(function () {
  const g = new Game(initialState());
  const seq = ['b2c3', 'b5a4', 'c3b2', 'a4b5']; // returns to the initial layout, white to move
  let last = null;
  for (const san of seq) {
    const move = g.legalMoves().find((m) => moveSan(m) === san);
    check(`repetition move ${san} is legal`, !!move);
    last = g.play(move);
  }
  check('position repeated => draw',
    last && last.over && last.result === 'draw' && last.reason === 'repetition',
    JSON.stringify(last));
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
