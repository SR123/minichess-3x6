'use strict';

/*
 * Build an EXACT endgame tablebase for every position with <= K total pieces.
 *
 * Why this is exact and cheap:
 *   The set {positions with total pieces <= K} is CLOSED under move-making --
 *   a move never increases the piece count (captures decrease it, promotions
 *   keep it equal while turning a bishop into a queen, quiet moves keep it the
 *   same). So a <=K position's value depends only on other <=K positions, and
 *   we can solve the whole set with the retrograde WLD+DTC solver in
 *   tablebase.js (solveAll), which is cross-checked against brute-force minimax
 *   (with the twofold-repetition draw) in solver.test.js. No reachability
 *   argument and no move history are needed.
 *
 * Sizes (live = both sides have >=1 piece, the only positions ever probed):
 *   K=4 -> 1.45M positions, K=5 -> 17.9M. Stored DENSELY: per live signature we
 *   keep a perfect combinatorial index (rankBoard) so NO keys are stored, only
 *   val (Uint8) + dtc (Int16). K=5 lands at ~54 MB on disk.
 *
 * Output file format (little-endian), default tb.K5.bin:
 *   magic   uint32  0x54434233 ('TCB3')
 *   K       uint32
 *   nSigs   uint32                       (number of LIVE signatures stored)
 *   nSigs * { sig uint32, n2 uint32 }     n2 = permCount(sig) * 2  (val length)
 *   val  block: for each sig in order, n2 bytes (0..3 WLD codes)
 *   dtc  block: for each sig in order, n2 * 2 bytes (Int16LE)
 *
 * Run under the 2 GB cap:  node --max-old-space-size=2048 build-tablebase.js [K]
 */

const fs = require('fs');
const tb = require('./tablebase');
const {
  SIZE, POW5, permCountForSig, unrankBoard, rankBoard,
  sigKeyOf, unpackSig, solveAll, isTerminalCounts,
} = tb;

const K = Number(process.argv[2] || 5);
const OUT = process.argv[3] || `tb.K${K}.bin`;
const MAGIC = 0x54434233;

function log(...a) { console.log(...a); }

// All signatures (wQ,wB,bQ,bB) with 1 <= total <= K. Includes one-sided
// (terminal) signatures so cross-layer lookups into a wiped-out side resolve.
function allSignatures(K) {
  const out = [];
  for (let wQ = 0; wQ <= K; wQ++)
    for (let wB = 0; wB + wQ <= K; wB++)
      for (let bQ = 0; bQ + wB + wQ <= K; bQ++)
        for (let bB = 0; bB + bQ + wB + wQ <= K; bB++) {
          const t = wQ + wB + bQ + bB;
          if (t < 1 || t > K) continue;
          out.push([wQ, wB, bQ, bB]);
        }
  return out;
}

// boardNum = sum(code_i * 5^i) for an Int8Array of cell codes.
function boardNumOf(board) {
  let n = 0;
  for (let i = 0; i < SIZE; i++) n += board[i] * POW5[i];
  return n;
}

function build() {
  const t0 = Date.now();
  const sigs = allSignatures(K);
  log(`Building exact tablebase for total pieces <= ${K}  (${sigs.length} signatures)`);

  // ---- enumerate every board of every signature into sorted-key layers ----
  const layers = new Map();
  let totalPos = 0;
  const board = new Int8Array(SIZE);
  for (const [wQ, wB, bQ, bB] of sigs) {
    const sig = sigKeyOf(wQ, wB, bQ, bB);
    const perm = permCountForSig(wQ, wB, bQ, bB);
    const keys = new Float64Array(perm * 2);
    let k = 0;
    for (let rank = 0; rank < perm; rank++) {
      const b = unrankBoard(rank, wQ, wB, bQ, bB);
      const bn = boardNumOf(b);
      keys[k++] = bn * 2;     // white to move
      keys[k++] = bn * 2 + 1; // black to move
    }
    keys.sort();
    layers.set(sig, { keys, val: null, dtc: null });
    totalPos += keys.length;
  }
  log(`  enumerated ${totalPos.toLocaleString()} positions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- solve exactly (retrograde WLD + DTC), reusing the tested solver ----
  solveAll(layers, { log });

  // ---- reindex LIVE signatures into dense rank-indexed val/dtc, write ----
  const live = sigs
    .filter(([wQ, wB, bQ, bB]) => (wQ + wB) > 0 && (bQ + bB) > 0)
    .map((c) => sigKeyOf(...c));

  const headerEntries = [];
  const valBlocks = [];
  const dtcBlocks = [];
  let maxDtc = 0;
  let liveTotal = 0;

  for (const sig of live) {
    const [wQ, wB, bQ, bB] = unpackSig(sig);
    const L = layers.get(sig);
    const perm = permCountForSig(wQ, wB, bQ, bB);
    const n2 = perm * 2;
    const denseVal = new Uint8Array(n2);
    const denseDtc = new Int16Array(n2);
    for (let i = 0; i < L.keys.length; i++) {
      const key = L.keys[i];
      const side = key % 2;
      const bn = (key - side) / 2;
      // unpack boardNum -> codes
      let n = bn;
      for (let c = 0; c < SIZE; c++) { board[c] = n % 5; n = (n - board[c]) / 5; }
      const idx = rankBoard(board) * 2 + side;
      denseVal[idx] = L.val[i];
      const d = L.dtc[i];
      if (d > maxDtc) maxDtc = d;
      denseDtc[idx] = d;
    }
    headerEntries.push([sig, n2]);
    valBlocks.push(Buffer.from(denseVal.buffer, denseVal.byteOffset, denseVal.byteLength));
    dtcBlocks.push(Buffer.from(denseDtc.buffer, denseDtc.byteOffset, denseDtc.byteLength));
    liveTotal += n2;
    // free the solved layer's heavy arrays as we go
    layers.delete(sig);
  }

  if (maxDtc > 32000) throw new Error(`DTC ${maxDtc} overflows Int16; widen dtc storage.`);

  const head = Buffer.alloc(12 + headerEntries.length * 8);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(K, 4);
  head.writeUInt32LE(headerEntries.length, 8);
  let off = 12;
  for (const [sig, n2] of headerEntries) {
    head.writeUInt32LE(sig, off); head.writeUInt32LE(n2, off + 4); off += 8;
  }

  const all = Buffer.concat([head, ...valBlocks, ...dtcBlocks]);
  fs.writeFileSync(OUT, all);

  log(`  live signatures: ${live.length}, ${liveTotal.toLocaleString()} probed positions, maxDTC=${maxDtc}`);
  log(`  wrote ${OUT}  (${(all.length / 1e6).toFixed(1)} MB)  in ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
}

build();
