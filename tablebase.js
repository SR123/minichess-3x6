'use strict';

/*
 * Retrograde tablebase for the 3x6 bishops+queens variant.
 *
 * Strategy: solve over the REACHABLE-from-start position set (tens of millions),
 * not the full material space (hundreds of billions). Successors of reachable
 * positions are reachable, so a reachable position's WLD value depends only on
 * reachable positions -- restricting to the reachable set is exact.
 *
 * Layers are material signatures S = (wQ,wB,bQ,bB). They are solved in
 * topological order by (totalPieces asc, totalBishops asc): every
 * signature-changing move (capture and/or promotion) strictly decreases this
 * key, so all cross-layer successors are already solved; the only undetermined
 * successors are quiet moves, which stay in the same layer (the retrograde
 * fixpoint). Repetition is confined within a layer (identical board => identical
 * material, which never increases) and the loop-as-draw fixpoint realizes the
 * twofold-repetition draw, so no history is tracked.
 *
 * Cell codes: 0 empty, 1 wB, 2 wQ, 3 bB, 4 bQ.
 * Packed position key: boardNum*2 + side, where boardNum = sum(code_i * 5^i),
 *   side 0 = white to move, 1 = black. Max ~7.6e12 < 2^53 (exact JS integer).
 * Material signature packed (base 7, counts <= 6): ((wQ*7+wB)*7+bQ)*7+bB.
 */

const COLS = 3;
const ROWS = 6;
const SIZE = 18;

// Cell-code predicates
const EMPTY = 0;
function isWhiteCode(c) { return c === 1 || c === 2; }
function isBishopCode(c) { return c === 1 || c === 3; }
// side of the piece occupying a cell: 0 white, 1 black (caller guarantees c!=0)
function sideOfCode(c) { return c <= 2 ? 0 : 1; }

function colOf(i) { return i % COLS; }
function rowOf(i) { return (i - (i % COLS)) / COLS; }

// Powers of five for incremental key arithmetic.
const POW5 = new Array(SIZE);
(function () { let p = 1; for (let i = 0; i < SIZE; i++) { POW5[i] = p; p *= 5; } })();

// Sliding directions [dCol, dRow]
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = BISHOP_DIRS.concat([[1, 0], [-1, 0], [0, 1], [0, -1]]);

// ---------------------------------------------------------------------------
// Pack / unpack
// ---------------------------------------------------------------------------

// board: Int8Array(18) of codes; side 0/1 -> packed key (number)
function packKey(board, side) {
  let n = 0;
  for (let i = 0; i < SIZE; i++) n += board[i] * POW5[i];
  return n * 2 + side;
}

// packed key -> { board: Int8Array(18), side }
function unpackKey(key) {
  const side = key % 2;
  let n = (key - side) / 2;
  const board = new Int8Array(SIZE);
  for (let i = 0; i < SIZE; i++) { board[i] = n % 5; n = (n - board[i]) / 5; }
  return { board, side };
}

// counts [wQ,wB,bQ,bB] of a board
function countsOf(board) {
  let wQ = 0, wB = 0, bQ = 0, bB = 0;
  for (let i = 0; i < SIZE; i++) {
    const c = board[i];
    if (c === 1) wB++; else if (c === 2) wQ++; else if (c === 3) bB++; else if (c === 4) bQ++;
  }
  return [wQ, wB, bQ, bB];
}

function sigKeyOf(wQ, wB, bQ, bB) { return ((wQ * 7 + wB) * 7 + bQ) * 7 + bB; }
function unpackSig(s) {
  const bB = s % 7; s = (s - bB) / 7;
  const bQ = s % 7; s = (s - bQ) / 7;
  const wB = s % 7; s = (s - wB) / 7;
  const wQ = s;
  return [wQ, wB, bQ, bB];
}

// ---------------------------------------------------------------------------
// Combinatorial ranking / unranking (used for verification & enumeration).
// Ranks a placement of the 18 cells over labels {0:empty,1,2,3,4} with the
// exact given multiplicities, lexicographically by cell 0..17 (label order
// 0<1<2<3<4). counts5 = [c0,c1,c2,c3,c4].
// ---------------------------------------------------------------------------

const FACT = new Array(SIZE + 1);
(function () { FACT[0] = 1; for (let i = 1; i <= SIZE; i++) FACT[i] = FACT[i - 1] * i; })();

// multinomial(total; counts) for counts array; total = sum(counts)
function multinomial(counts) {
  let total = 0;
  for (const c of counts) total += c;
  let r = FACT[total];
  for (const c of counts) r /= FACT[c];
  return r; // exact integer (denominator divides numerator, all < 2^53)
}

function permCountForSig(wQ, wB, bQ, bB) {
  const c0 = SIZE - (wQ + wB + bQ + bB);
  return multinomial([c0, wQ, wB, bQ, bB]); // count of distinct boards (no side factor)
}

// board (Int8Array) -> rank within its signature's board-enumeration
function rankBoard(board) {
  const cnt = [0, 0, 0, 0, 0];
  for (let i = 0; i < SIZE; i++) cnt[board[i]]++;
  let rank = 0, n = SIZE;
  for (let i = 0; i < SIZE; i++) {
    const v = board[i];
    for (let L = 0; L < v; L++) {
      if (cnt[L] > 0) {
        cnt[L]--;
        // arrangements of remaining n-1 cells
        rank += multinomial(cnt);
        cnt[L]++;
      }
    }
    cnt[v]--; n--;
  }
  return rank;
}

// rank + signature counts -> board (Int8Array)
function unrankBoard(rank, wQ, wB, bQ, bB) {
  const c0 = SIZE - (wQ + wB + bQ + bB);
  const cnt = [c0, wB, wQ, bB, bQ]; // map label index -> remaining count
  // NOTE label indices: 0 empty, 1 wB, 2 wQ, 3 bB, 4 bQ
  cnt[0] = c0; cnt[1] = wB; cnt[2] = wQ; cnt[3] = bB; cnt[4] = bQ;
  const board = new Int8Array(SIZE);
  let r = rank;
  for (let i = 0; i < SIZE; i++) {
    for (let L = 0; L < 5; L++) {
      if (cnt[L] > 0) {
        cnt[L]--;
        const ways = multinomial(cnt);
        if (r < ways) { board[i] = L; break; }
        r -= ways; cnt[L]++;
      }
    }
  }
  return board;
}

// ---------------------------------------------------------------------------
// Fast move generation (validated against engine.js in the tests).
// Returns successor descriptors WITHOUT building boards: each is
// { key, sig } of the child position. side is the side to move.
// ---------------------------------------------------------------------------

function genSuccessors(board, side, parentCounts /* [wQ,wB,bQ,bB] */, parentBoardNum) {
  const out = [];
  for (let from = 0; from < SIZE; from++) {
    const c = board[from];
    if (c === 0 || sideOfCode(c) !== side) continue;
    const dirs = isBishopCode(c) ? BISHOP_DIRS : QUEEN_DIRS;
    const fc = colOf(from), fr = rowOf(from);
    for (let d = 0; d < dirs.length; d++) {
      let col = fc + dirs[d][0], row = fr + dirs[d][1];
      while (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
        const to = row * COLS + col;
        const t = board[to];
        if (t !== 0 && sideOfCode(t) === side) break; // own piece blocks
        // promotion: a bishop reaching the far rank
        let newCode = c;
        let promo = false;
        if (isBishopCode(c)) {
          if (side === 0 && row === ROWS - 1) { newCode = 2; promo = true; }
          else if (side === 1 && row === 0) { newCode = 4; promo = true; }
        }
        // child board number via delta
        const childBoardNum = parentBoardNum
          + (0 - c) * POW5[from]
          + (newCode - t) * POW5[to];
        const childKey = childBoardNum * 2 + (1 - side);
        // child signature via delta
        let wQ = parentCounts[0], wB = parentCounts[1], bQ = parentCounts[2], bB = parentCounts[3];
        if (promo) { if (side === 0) { wB--; wQ++; } else { bB--; bQ++; } }
        if (t !== 0) { // capture removes target
          if (t === 1) wB--; else if (t === 2) wQ--; else if (t === 3) bB--; else bQ--;
        }
        out.push({ key: childKey, sig: sigKeyOf(wQ, wB, bQ, bB) });
        if (t !== 0) break; // captured enemy piece -> stop sliding
        col += dirs[d][0]; row += dirs[d][1];
      }
    }
  }
  return out;
}

// Quiet (same-signature) predecessors of a position: the side that just moved
// is `prevSide` = 1 - sideToMove. Un-slide each of its pieces backward over
// empty squares. No captures/promotions (those change the signature).
// Returns an array of predecessor keys.
function genQuietPredecessors(board, sideToMove, boardNum) {
  const prevSide = 1 - sideToMove;
  const out = [];
  for (let at = 0; at < SIZE; at++) {
    const c = board[at];
    if (c === 0 || sideOfCode(c) !== prevSide) continue;
    // A bishop on its own promotion rank cannot have arrived by a quiet move
    // (any move onto that rank promotes), so it has no quiet predecessors.
    if (isBishopCode(c)) {
      const r = rowOf(at);
      if ((c === 1 && r === ROWS - 1) || (c === 3 && r === 0)) continue;
    }
    const dirs = isBishopCode(c) ? BISHOP_DIRS : QUEEN_DIRS;
    const ac = colOf(at), ar = rowOf(at);
    for (let d = 0; d < dirs.length; d++) {
      let col = ac + dirs[d][0], row = ar + dirs[d][1];
      while (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
        const s = row * COLS + col;
        if (board[s] !== 0) break; // can only have come from an empty square chain
        // predecessor: piece sat at s, side = prevSide to move
        const predBoardNum = boardNum
          + (c - 0) * POW5[s]
          + (0 - c) * POW5[at];
        out.push(predBoardNum * 2 + prevSide);
        col += dirs[d][0]; row += dirs[d][1];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Start position
// ---------------------------------------------------------------------------
// indices: a1=0 b1=1 c1=2 a2=3 b2=4 c2=5 ... a5=12 b5=13 c5=14 a6=15 b6=16 c6=17
function startKey() {
  const b = new Int8Array(SIZE);
  b[1] = 2;                         // white queen b1
  b[0] = b[3] = b[4] = b[2] = b[5] = 1; // white bishops a1,a2,b2,c1,c2
  b[16] = 4;                        // black queen b6
  b[12] = b[13] = b[14] = b[15] = b[17] = 3; // black bishops a5,b5,c5,a6,c6
  return packKey(b, 0);
}

// ---------------------------------------------------------------------------
// Left-right mirror symmetry (swap columns a<->c). The rules and the start
// position are symmetric under this fold, so WLD/DTW values are mirror-
// invariant and we store one canonical representative per mirror pair.
// ---------------------------------------------------------------------------
const MIRROR = new Int8Array(SIZE);
(function () {
  for (let i = 0; i < SIZE; i++) {
    const row = (i - (i % COLS)) / COLS, col = i % COLS;
    MIRROR[i] = row * COLS + (COLS - 1 - col);
  }
})();

// mirror of a packed key (reuses a scratch board buffer to avoid allocation)
function mirrorKey(key, buf) {
  const side = key % 2;
  let n = (key - side) / 2;
  for (let i = 0; i < SIZE; i++) { buf[i] = n % 5; n = (n - buf[i]) / 5; }
  let mb = 0;
  for (let i = 0; i < SIZE; i++) mb += buf[i] * POW5[MIRROR[i]];
  return mb * 2 + side;
}

// canonical key = min(key, mirror(key))
function canonKey(key, buf) {
  const m = mirrorKey(key, buf);
  return m < key ? m : key;
}

// ---------------------------------------------------------------------------
// Packed open-addressing hash set of integer keys (< 2^43), stored exactly in
// a Float64Array. ~16 B/entry vs ~40 B for a V8 Set, and no per-Set element
// cap. Key 0 is the empty-slot sentinel (no real position has key 0).
// ---------------------------------------------------------------------------
class PackedSet {
  constructor(capPow2 = 26) {
    this.cap = 1 << capPow2;
    this.mask = this.cap - 1;
    this.slots = new Float64Array(this.cap);
    this.size = 0;
    this.limit = Math.floor(this.cap * 0.7);
  }
  _idx(key) {
    const hi = Math.floor(key / 4294967296);
    const lo = key - hi * 4294967296;
    let h = Math.imul(lo ^ hi, 2654435761);
    h ^= h >>> 15;
    return (h >>> 0) & this.mask;
  }
  has(key) {
    let i = this._idx(key);
    const s = this.slots;
    while (s[i] !== 0) { if (s[i] === key) return true; i = (i + 1) & this.mask; }
    return false;
  }
  // returns true if newly added
  add(key) {
    let i = this._idx(key);
    const s = this.slots;
    while (s[i] !== 0) { if (s[i] === key) return false; i = (i + 1) & this.mask; }
    s[i] = key; this.size++;
    if (this.size > this.limit) this._grow();
    return true;
  }
  _grow() {
    if (this.cap >= (1 << 30)) throw new Error('PackedSet exceeded 2^30 slots (8.6GB) -- need disk streaming');
    const old = this.slots;
    this.cap <<= 1; this.mask = this.cap - 1; this.limit = Math.floor(this.cap * 0.7);
    this.slots = new Float64Array(this.cap); this.size = 0;
    const s = this.slots;
    for (let j = 0; j < old.length; j++) {
      const k = old[j];
      if (k !== 0) { let i = this._idx(k); while (s[i] !== 0) i = (i + 1) & this.mask; s[i] = k; this.size++; }
    }
  }
}

// ---------------------------------------------------------------------------
// Sharded "seen" set to bypass V8's ~2^24 per-Set cap.
// ---------------------------------------------------------------------------
class ShardedSet {
  constructor(shards) {
    this.mask = shards - 1; // shards must be a power of two
    this.sets = [];
    for (let i = 0; i < shards; i++) this.sets.push(new Set());
  }
  has(key) { return this.sets[key & this.mask].has(key); }
  add(key) { this.sets[key & this.mask].add(key); }
  get size() { let n = 0; for (const s of this.sets) n += s.size; return n; }
}

function isTerminalCounts(counts) {
  // a side with zero pieces
  return (counts[0] + counts[1] === 0) || (counts[2] + counts[3] === 0);
}

// Decode a packed key into a preallocated board (no allocation).
function unpackInto(key, board) {
  const side = key % 2;
  let n = (key - side) / 2;
  for (let i = 0; i < SIZE; i++) { board[i] = n % 5; n = (n - board[i]) / 5; }
  return side;
}

// Forward-enumerate all positions reachable from the start under legal play,
// grouped by material signature. Dedup uses one sharded set PER signature (a
// single copy of the keys; no structure ever exceeds V8's per-Set cap).
// Terminal positions (a side wiped out) are recorded but not expanded.
// Returns Map sigKey -> sorted Float64Array of keys.
function forwardEnumerate(opts = {}) {
  const log = opts.log || (() => {});
  const sets = new Map(); // sigKey -> ShardedSet (also the layer membership)
  const board = new Int8Array(SIZE);

  function getSet(sig) {
    let s = sets.get(sig);
    if (s === undefined) { s = new ShardedSet(16); sets.set(sig, s); }
    return s;
  }

  const start = startKey();
  {
    const side = unpackInto(start, board);
    const c = countsOf(board);
    getSet(sigKeyOf(c[0], c[1], c[2], c[3])).add(start);
  }
  const stack = [start];

  let expanded = 0, totalSeen = 1;
  const t0 = Date.now();
  while (stack.length > 0) {
    const key = stack.pop();
    expanded++;
    if (expanded % 2000000 === 0) {
      log(`  ...expanded ${expanded.toLocaleString()}, seen ${totalSeen.toLocaleString()}, ` +
        `frontier ${stack.length.toLocaleString()}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    const side = unpackInto(key, board);
    const counts = countsOf(board);
    if (isTerminalCounts(counts)) continue; // do not expand terminal positions
    const boardNum = (key - side) / 2;
    const succ = genSuccessors(board, side, counts, boardNum);
    for (let i = 0; i < succ.length; i++) {
      const ck = succ[i].key;
      const s = getSet(succ[i].sig);
      if (!s.has(ck)) { s.add(ck); stack.push(ck); totalSeen++; }
    }
  }

  log(`  enumeration done: ${totalSeen.toLocaleString()} positions in ${sets.size} layers, ` +
    `${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Drain each signature's sharded set into a sorted Float64Array (a perfect
  // minimal hash by index); free each set as we go.
  const layers = new Map();
  for (const [sig, s] of sets) {
    const arr = new Float64Array(s.size);
    let k = 0;
    for (const shard of s.sets) { for (const key of shard) arr[k++] = key; shard.clear(); }
    arr.sort();
    layers.set(sig, { keys: arr, val: null, dtw: null });
  }
  sets.clear();
  return { layers, total: totalSeen };
}

// WLD value codes
const UNKNOWN = 0, WIN = 1, LOSS = 2, DRAW = 3;

// Solve every layer by retrograde WLD analysis (value from the side to move),
// in topological order (totalPieces asc, totalBishops asc). Fills layer.val and
// layer.dtw in place. Cross-layer (capture/promotion) successors are read from
// already-solved smaller layers; same-layer (quiet) successors are resolved by
// the within-layer worklist fixpoint; the residual loop is DRAW.
//
// `dtw` holds a true distance-to-win (DTW): plies to wipeout under optimal play.
// WIN  node: dtw = 1 + MIN child dtw over winning (opponent-LOSS) successors.
// LOSS node: dtw = 1 + MAX child dtw over its (all-winning) successors.
// DRAW node: dtw = 0. A terminal wipeout child has dtw 0, so capturing the last
// enemy piece is a win in 1. This monotone distance is what lets the search make
// progress (it strictly prefers shorter wins) instead of shuffling among equal
// "winning" moves -- a distance-to-CONVERSION would flatten all winning
// conversions to 1 and destroy that gradient.
function solveAll(layers, opts = {}) {
  const log = opts.log || (() => {});

  const sigs = [];
  for (const sig of layers.keys()) {
    const [wQ, wB, bQ, bB] = unpackSig(sig);
    sigs.push({ sig, total: wQ + wB + bQ + bB, bishops: wB + bB });
  }
  sigs.sort((a, b) => a.total - b.total || a.bishops - b.bishops || a.sig - b.sig);

  // allocate value/dtw arrays
  for (const { sig } of sigs) {
    const L = layers.get(sig);
    L.val = new Uint8Array(L.keys.length); // 0 = UNKNOWN
    L.dtw = new Int32Array(L.keys.length);
  }

  function lookup(sig, key) {
    const L = layers.get(sig);
    const i = bsearch(L.keys, key);
    return L.val[i]; // child layer already solved
  }
  // distance-to-win of an already-solved cross-layer child
  function lookupDtw(sig, key) {
    const L = layers.get(sig);
    const i = bsearch(L.keys, key);
    return L.dtw[i];
  }

  const board = new Int8Array(SIZE);
  const t0 = Date.now();
  let solved = 0;

  for (const { sig, total, bishops } of sigs) {
    const L = layers.get(sig);
    const keys = L.keys, val = L.val, dtw = L.dtw, n = keys.length;
    const counter = new Int32Array(n);       // # successors not yet known WIN-for-opp
    const maxContrib = new Int32Array(n).fill(-1); // max child DTW over WIN-for-opp successors
    const processed = new Uint8Array(n);     // propagated-to-predecessors yet?
    const buckets = [];
    let maxD = 0;
    const push = (d, idx) => { (buckets[d] || (buckets[d] = [])).push(idx); if (d > maxD) maxD = d; };

    // ---- init pass: seed from terminals and cross-layer (solved) successors ----
    // We compute a TRUE distance-to-win (DTW): a WIN's DTW is 1 + the MIN child
    // DTW over winning successors; a LOSS's DTW is 1 + the MAX child DTW over its
    // (all-winning) successors. Cross-layer successors (captures/promotions) live
    // in already-solved layers, so their DTW is final and looked up directly;
    // same-layer (quiet) successors are resolved by the propagation below. A
    // conversion win is NOT finalized at distance 1 here -- it is pushed as a
    // candidate at its true distance (1 + child DTW) and resolved on pop, so a
    // shorter quiet win can still win the min.
    for (let idx = 0; idx < n; idx++) {
      const key = keys[idx];
      const side = unpackInto(key, board);
      const counts = countsOf(board);
      const moverZero = side === 0 ? counts[0] + counts[1] === 0 : counts[2] + counts[3] === 0;
      const oppZero = side === 0 ? counts[2] + counts[3] === 0 : counts[0] + counts[1] === 0;
      if (oppZero) { val[idx] = WIN; dtw[idx] = 0; push(0, idx); continue; }
      if (moverZero) { val[idx] = LOSS; dtw[idx] = 0; push(0, idx); continue; }

      const boardNum = (key - side) / 2;
      const succ = genSuccessors(board, side, counts, boardNum);
      let cnt = 0, decrements = 0, convWin = -1, mc = -1;
      for (let s = 0; s < succ.length; s++) {
        cnt++;
        if (succ[s].sig === sig) continue; // same-layer: deferred to propagation
        const cv = lookup(succ[s].sig, succ[s].key);
        const cd = lookupDtw(succ[s].sig, succ[s].key);
        if (cv === LOSS) {                       // conversion to opp loss -> win in 1+cd
          const wd = 1 + cd;
          if (convWin < 0 || wd < convWin) convWin = wd;
        } else if (cv === WIN) {                 // WIN-for-opp -> contributes its DTW to a loss
          decrements++;
          if (cd > mc) mc = cd;
        }
        // cv === DRAW: not WIN-for-opp -> never decremented (keeps position off LOSS)
      }
      counter[idx] = cnt - decrements;
      maxContrib[idx] = mc;
      if (convWin >= 0) {
        // candidate WIN via a conversion at its true distance; resolved on pop
        push(convWin, idx);
      }
      if (counter[idx] === 0) {
        // every successor is a WIN-for-opp conversion -> forced LOSS (max child DTW)
        val[idx] = LOSS; dtw[idx] = 1 + (mc < 0 ? 0 : mc); push(dtw[idx], idx);
      }
    }

    // ---- propagation: resolve in nondecreasing DTW order via un-move predecessors.
    // On pop, a still-UNKNOWN node is a conversion-win candidate finalized at this
    // (smallest) distance. Each node propagates to its quiet predecessors once.
    for (let d = 0; d <= maxD; d++) {
      const bk = buckets[d];
      if (!bk) continue;
      for (let qi = 0; qi < bk.length; qi++) {
        const idx = bk[qi];
        if (val[idx] === UNKNOWN) { val[idx] = WIN; dtw[idx] = d; } // conversion-win candidate
        if (processed[idx]) continue;
        processed[idx] = true;
        const key = keys[idx];
        const side = unpackInto(key, board);
        const boardNum = (key - side) / 2;
        const preds = genQuietPredecessors(board, side, boardNum);
        const vIdx = val[idx], dIdx = dtw[idx];
        for (let p = 0; p < preds.length; p++) {
          const pIdx = bsearch(keys, preds[p]);
          if (pIdx < 0 || val[pIdx] !== UNKNOWN) continue;
          if (vIdx === LOSS) {
            val[pIdx] = WIN; dtw[pIdx] = 1 + dIdx; push(dtw[pIdx], pIdx);
          } else { // vIdx === WIN
            counter[pIdx]--;
            if (dIdx > maxContrib[pIdx]) maxContrib[pIdx] = dIdx;
            if (counter[pIdx] === 0) { val[pIdx] = LOSS; dtw[pIdx] = 1 + maxContrib[pIdx]; push(dtw[pIdx], pIdx); }
          }
        }
      }
    }

    // ---- remaining unknown positions are draws (unforced loops) ----
    let nW = 0, nL = 0, nD = 0;
    for (let idx = 0; idx < n; idx++) {
      if (val[idx] === UNKNOWN) { val[idx] = DRAW; dtw[idx] = 0; nD++; }
      else if (val[idx] === WIN) nW++; else if (val[idx] === LOSS) nL++; else nD++;
    }

    solved++;
    if (solved % 25 === 0 || n > 1000000) {
      const [wQ, wB, bQ, bB] = unpackSig(sig);
      log(`  solved layer ${solved}/${sigs.length} (${wQ},${wB},${bQ},${bB}) ` +
        `n=${n.toLocaleString()} W=${nW.toLocaleString()} L=${nL.toLocaleString()} D=${nD.toLocaleString()} ` +
        `[${((Date.now() - t0) / 1000).toFixed(0)}s]`);
    }
  }
  log(`  solve done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// binary search in a sorted Float64Array; returns index or -1
function bsearch(arr, key) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid];
    if (v === key) return mid;
    if (v < key) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

module.exports = {
  COLS, ROWS, SIZE, POW5,
  isWhiteCode, isBishopCode, sideOfCode, colOf, rowOf,
  packKey, unpackKey, countsOf, sigKeyOf, unpackSig,
  multinomial, permCountForSig, rankBoard, unrankBoard,
  genSuccessors, genQuietPredecessors,
  startKey, ShardedSet, isTerminalCounts, forwardEnumerate, bsearch,
  unpackInto, solveAll, UNKNOWN, WIN, LOSS, DRAW,
  MIRROR, mirrorKey, canonKey, PackedSet,
};
