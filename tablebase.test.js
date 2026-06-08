'use strict';

// Stage 1 + Stage 2 unit tests for the tablebase building blocks.

const engine = require('./engine');
const tb = require('./tablebase');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}

// ---- conversions between tablebase codes and engine pieces -----------------
const CODE_TO_PIECE = { 1: 'B', 2: 'Q', 3: 'b', 4: 'q' };
function boardToEngineState(board, side) {
  const eb = new Array(18).fill(null);
  for (let i = 0; i < 18; i++) if (board[i] !== 0) eb[i] = CODE_TO_PIECE[board[i]];
  return { board: eb, turn: side === 0 ? 'w' : 'b' };
}
function engineStateToKey(state) {
  const board = new Int8Array(18);
  const map = { B: 1, Q: 2, b: 3, q: 4 };
  for (let i = 0; i < 18; i++) board[i] = state.board[i] ? map[state.board[i]] : 0;
  return tb.packKey(board, state.turn === 'w' ? 0 : 1);
}

function boardNumOf(board) {
  let n = 0; for (let i = 0; i < 18; i++) n += board[i] * tb.POW5[i]; return n;
}

// place pieces on distinct random squares
function randomBoard(wQ, wB, bQ, bB) {
  const board = new Int8Array(18);
  const sqs = [];
  for (let i = 0; i < 18; i++) sqs.push(i);
  for (let i = sqs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sqs[i], sqs[j]] = [sqs[j], sqs[i]];
  }
  let k = 0;
  for (let n = 0; n < wQ; n++) board[sqs[k++]] = 2;
  for (let n = 0; n < wB; n++) board[sqs[k++]] = 1;
  for (let n = 0; n < bQ; n++) board[sqs[k++]] = 4;
  for (let n = 0; n < bB; n++) board[sqs[k++]] = 3;
  return board;
}

console.log('Stage 1: encoding / ranking / generators');

// --- pack/unpack round trip -------------------------------------------------
(function () {
  let ok = true;
  for (let t = 0; t < 2000; t++) {
    const board = randomBoard(1, 2, 1, 2);
    const side = Math.random() < 0.5 ? 0 : 1;
    const key = tb.packKey(board, side);
    const u = tb.unpackKey(key);
    if (u.side !== side) { ok = false; break; }
    for (let i = 0; i < 18; i++) if (u.board[i] !== board[i]) { ok = false; break; }
    if (!ok) break;
  }
  check('packKey/unpackKey round-trip', ok);
})();

// --- ranking round trip: rank(unrank(i)) === i for a small layer ------------
(function () {
  const sig = [1, 0, 1, 0]; // 1 wQ, 1 bQ
  const n = tb.permCountForSig(...sig);
  let ok = n === 18 * 17;
  for (let i = 0; i < n && ok; i++) {
    const b = tb.unrankBoard(i, ...sig);
    if (tb.rankBoard(b) !== i) ok = false;
  }
  check('rank(unrank(i))==i over full small layer (wQ,bQ)', ok, `n=${n}`);
})();

// --- ranking round trip on a bigger signature, sampled ----------------------
(function () {
  const sig = [2, 1, 1, 1];
  const n = tb.permCountForSig(...sig);
  let ok = true;
  for (let t = 0; t < 5000 && ok; t++) {
    const i = Math.floor(Math.random() * n);
    const b = tb.unrankBoard(i, ...sig);
    if (tb.rankBoard(b) !== i) ok = false;
    // also board->rank->board
    const rb = randomBoard(...sig);
    if (tb.rankBoard(rb) >= n) ok = false;
    const b2 = tb.unrankBoard(tb.rankBoard(rb), ...sig);
    for (let k = 0; k < 18; k++) if (b2[k] !== rb[k]) ok = false;
  }
  check('rank<->board round-trip sampled (2,1,1,1)', ok, `n=${n}`);
})();

// --- enumerate a small layer TWO WAYS and compare ---------------------------
(function () {
  const sig = [1, 0, 1, 0]; // one wQ, one bQ
  const n = tb.permCountForSig(...sig);
  // way A: combinatorial unranking
  const setA = new Set();
  for (let i = 0; i < n; i++) setA.add(boardNumOf(tb.unrankBoard(i, ...sig)));
  // way B: direct nested placement
  const setB = new Set();
  for (let w = 0; w < 18; w++) for (let b = 0; b < 18; b++) {
    if (w === b) continue;
    const board = new Int8Array(18); board[w] = 2; board[b] = 4;
    setB.add(boardNumOf(board));
  }
  let same = setA.size === setB.size && setA.size === n;
  if (same) for (const x of setA) if (!setB.has(x)) { same = false; break; }
  check('small layer enumerated two ways agree', same, `A=${setA.size} B=${setB.size} n=${n}`);
})();

// --- fast successor generator vs engine.js ----------------------------------
(function () {
  let ok = true, detail = '';
  for (let t = 0; t < 4000 && ok; t++) {
    // vary material, sometimes with pieces near promotion ranks
    const board = randomBoard(
      Math.floor(Math.random() * 3),
      Math.floor(Math.random() * 3),
      Math.floor(Math.random() * 3),
      Math.floor(Math.random() * 3));
    const side = Math.random() < 0.5 ? 0 : 1;
    // fast
    const counts = tb.countsOf(board);
    const fast = new Set(tb.genSuccessors(board, side, counts, boardNumOf(board)).map((m) => m.key));
    // engine
    const st = boardToEngineState(board, side);
    const eng = new Set();
    for (const mv of engine.generateMoves(st)) eng.add(engineStateToKey(engine.applyMove(st, mv)));
    if (fast.size !== eng.size) { ok = false; detail = `size ${fast.size} vs ${eng.size}`; break; }
    for (const k of fast) if (!eng.has(k)) { ok = false; detail = `key ${k} missing in engine`; break; }
  }
  check('fast genSuccessors matches engine.generateMoves+applyMove', ok, detail);
})();

// --- fast successor SIGNATURES are correct ----------------------------------
(function () {
  let ok = true;
  for (let t = 0; t < 2000 && ok; t++) {
    const board = randomBoard(1, 2, 1, 2);
    const side = Math.random() < 0.5 ? 0 : 1;
    const counts = tb.countsOf(board);
    for (const m of tb.genSuccessors(board, side, counts, boardNumOf(board))) {
      const cb = tb.unpackKey(m.key).board;
      const cc = tb.countsOf(cb);
      if (tb.sigKeyOf(cc[0], cc[1], cc[2], cc[3]) !== m.sig) { ok = false; break; }
    }
  }
  check('genSuccessors reports correct child signatures', ok);
})();

// --- un-move: every quiet successor lists its parent as a predecessor -------
(function () {
  let ok = true, detail = '';
  for (let t = 0; t < 3000 && ok; t++) {
    const board = randomBoard(1, 1, 1, 1);
    const side = Math.random() < 0.5 ? 0 : 1;
    const counts = tb.countsOf(board);
    const parentSig = tb.sigKeyOf(counts[0], counts[1], counts[2], counts[3]);
    const parentKey = tb.packKey(board, side);
    for (const m of tb.genSuccessors(board, side, counts, boardNumOf(board))) {
      if (m.sig !== parentSig) continue; // only quiet (same-layer) successors
      const s = tb.unpackKey(m.key);
      const preds = tb.genQuietPredecessors(s.board, s.side, boardNumOf(s.board));
      if (!preds.includes(parentKey)) { ok = false; detail = `missing pred for child ${m.key}`; break; }
    }
  }
  check('genQuietPredecessors inverts every quiet move', ok, detail);
})();

// --- un-move only ever yields same-signature, legal-shaped predecessors -----
(function () {
  let ok = true;
  for (let t = 0; t < 2000 && ok; t++) {
    const board = randomBoard(1, 1, 1, 1);
    const side = Math.random() < 0.5 ? 0 : 1;
    const counts = tb.countsOf(board);
    const sig = tb.sigKeyOf(counts[0], counts[1], counts[2], counts[3]);
    for (const pk of tb.genQuietPredecessors(board, side, boardNumOf(board))) {
      const p = tb.unpackKey(pk);
      const pc = tb.countsOf(p.board);
      // same signature
      if (tb.sigKeyOf(pc[0], pc[1], pc[2], pc[3]) !== sig) { ok = false; break; }
      // predecessor's mover is the side that just moved
      if (p.side === side) { ok = false; break; }
      // and forward: the predecessor must actually have `board`+`side` as a successor
      const ps = tb.genSuccessors(p.board, p.side, pc, boardNumOf(p.board));
      if (!ps.some((m) => m.key === tb.packKey(board, side))) { ok = false; break; }
    }
  }
  check('genQuietPredecessors yields same-sig predecessors whose move reaches the position', ok);
})();

// --- mirror symmetry: involution, sig-preserving, commutes with moves -------
(function () {
  const buf = new Int8Array(18);
  let ok = true, detail = '';
  for (let t = 0; t < 3000 && ok; t++) {
    const board = randomBoard(
      Math.floor(Math.random() * 3), Math.floor(Math.random() * 3),
      Math.floor(Math.random() * 3), Math.floor(Math.random() * 3));
    const side = Math.random() < 0.5 ? 0 : 1;
    const key = tb.packKey(board, side);
    // involution
    if (tb.mirrorKey(tb.mirrorKey(key, buf), buf) !== key) { ok = false; detail = 'not involution'; break; }
    // canonical idempotent
    const c = tb.canonKey(key, buf);
    if (tb.canonKey(c, buf) !== c) { ok = false; detail = 'canon not idempotent'; break; }
    // signature preserved
    const cs = tb.countsOf(tb.unpackKey(key).board);
    const ms = tb.countsOf(tb.unpackKey(tb.mirrorKey(key, buf)).board);
    if (cs.join(',') !== ms.join(',')) { ok = false; detail = 'sig changed'; break; }
    // mirror commutes with move generation: mirror(successors(p)) == successors(mirror(p))
    const counts = tb.countsOf(board);
    const succA = new Set(tb.genSuccessors(board, side, counts, boardNumOf(board)).map((m) => tb.mirrorKey(m.key, buf)));
    const mk = tb.mirrorKey(key, buf);
    const mu = tb.unpackKey(mk);
    const succB = new Set(tb.genSuccessors(mu.board, mu.side, tb.countsOf(mu.board), boardNumOf(mu.board)).map((m) => m.key));
    if (succA.size !== succB.size) { ok = false; detail = 'succ size mismatch'; break; }
    for (const k of succA) if (!succB.has(k)) { ok = false; detail = 'succ set mismatch'; break; }
  }
  check('mirror symmetry: involution, sig-preserving, commutes with moves', ok, detail);
})();

// --- PackedSet basic correctness vs a reference Set -------------------------
(function () {
  const ps = new tb.PackedSet(8);
  const ref = new Set();
  let ok = true;
  for (let t = 0; t < 20000 && ok; t++) {
    const key = Math.floor(Math.random() * 7e12) + 1;
    const a = ps.add(key);
    const b = !ref.has(key); ref.add(key);
    if (a !== b) { ok = false; break; }
    if (!ps.has(key)) { ok = false; break; }
  }
  ok = ok && ps.size === ref.size;
  check('PackedSet matches reference Set (with growth/rehash)', ok, `size ${ps.size} vs ${ref.size}`);
})();

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
