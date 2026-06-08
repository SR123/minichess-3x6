/*
 * Featherweight (browser) port of the exact-tablebase probe (tbprobe.js) plus
 * the combinatorial ranking math it needs (from tablebase.js). Parses a TCB4
 * tb.K*.bin and answers probe(board, turn) in O(1), entirely in the browser.
 *
 * Dual-loaded: attaches to window.MiniTB in a browser and exports under Node so
 * the parity test can compare it byte-for-byte against the server probe. The
 * loader takes raw bytes (loadFromBuffer), so the Node test feeds it
 * fs.readFileSync and the browser feeds it fetch(...).arrayBuffer().
 *
 * Format (little-endian):
 *   magic uint32 0x54434234 ('TCB4'); K uint32; nSigs uint32;
 *   nSigs * { sig uint32, n2 uint32 };   n2 = permCount(sig)*2
 *   val block: per sig, n2 bytes (0..3 WLD codes)
 *   dtw block: per sig, n2*2 bytes (Int16LE, distance-to-win)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiniTB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 18;
  const MAGIC = 0x54434234; // 'TCB4'
  const UNKNOWN = 0, WIN = 1, LOSS = 2, DRAW = 3;

  // ---- combinatorial ranking (verbatim from tablebase.js) ------------------
  const FACT = new Array(SIZE + 1);
  FACT[0] = 1;
  for (let i = 1; i <= SIZE; i++) FACT[i] = FACT[i - 1] * i;

  function multinomial(counts) {
    let total = 0;
    for (const c of counts) total += c;
    let r = FACT[total];
    for (const c of counts) r /= FACT[c];
    return r; // exact integer, < 2^53
  }

  function permCountForSig(wQ, wB, bQ, bB) {
    const c0 = SIZE - (wQ + wB + bQ + bB);
    return multinomial([c0, wQ, wB, bQ, bB]);
  }

  // board (array of cell codes 0..4) -> rank within its signature
  function rankBoard(board) {
    const cnt = [0, 0, 0, 0, 0];
    for (let i = 0; i < SIZE; i++) cnt[board[i]]++;
    let rank = 0;
    for (let i = 0; i < SIZE; i++) {
      const v = board[i];
      for (let L = 0; L < v; L++) {
        if (cnt[L] > 0) { cnt[L]--; rank += multinomial(cnt); cnt[L]++; }
      }
      cnt[v]--;
    }
    return rank;
  }

  // rank + signature -> board of cell codes (0 empty,1 wB,2 wQ,3 bB,4 bQ)
  function unrankBoard(rank, wQ, wB, bQ, bB) {
    const c0 = SIZE - (wQ + wB + bQ + bB);
    const cnt = [c0, wB, wQ, bB, bQ];
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

  const sigKeyOf = (wQ, wB, bQ, bB) => ((wQ * 7 + wB) * 7 + bQ) * 7 + bB;
  function unpackSig(s) {
    const bB = s % 7; s = (s - bB) / 7;
    const bQ = s % 7; s = (s - bQ) / 7;
    const wB = s % 7; s = (s - wB) / 7;
    return [s, wB, bQ, bB];
  }

  // piece string -> cell code
  function codeOf(piece) {
    if (piece === null) return 0;
    if (piece === 'B') return 1;
    if (piece === 'Q') return 2;
    if (piece === 'b') return 3;
    if (piece === 'q') return 4;
    throw new Error('Bad piece: ' + piece);
  }

  // ---- the tablebase -------------------------------------------------------
  class Tablebase {
    constructor() { this.K = 0; this.sigs = new Map(); this.loaded = false; this._b = new Int8Array(SIZE); }

    // bytes: ArrayBuffer | Uint8Array | Node Buffer
    loadFromBuffer(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const magic = dv.getUint32(0, true);
      if (magic !== MAGIC) throw new Error('bad magic 0x' + magic.toString(16) + " (expected 'TCB4')");
      this.K = dv.getUint32(4, true);
      const nSigs = dv.getUint32(8, true);
      const entries = [];
      let off = 12;
      for (let i = 0; i < nSigs; i++) {
        entries.push([dv.getUint32(off, true), dv.getUint32(off + 4, true)]);
        off += 8;
      }
      // val block (Uint8 view into the buffer)
      for (const [sig, n2] of entries) {
        const val = u8.subarray(off, off + n2);
        off += n2;
        this.sigs.set(sig, { val, dtw: null, n2 });
      }
      // dtw block (Int16LE -> copy into an aligned Int16Array)
      for (const [sig, n2] of entries) {
        const dtw = new Int16Array(n2);
        for (let j = 0; j < n2; j++) dtw[j] = dv.getInt16(off + j * 2, true);
        off += n2 * 2;
        this.sigs.get(sig).dtw = dtw;
      }
      this.loaded = true;
      return this;
    }

    // Browser convenience: fetch a static .bin and parse it.
    async loadFromUrl(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('fetch ' + url + ' -> ' + res.status);
      return this.loadFromBuffer(await res.arrayBuffer());
    }

    // probe an engine board (Array(18) of piece|null) + turn ('w'|'b').
    // Returns { result:'win'|'loss'|'draw', dtw } from the side-to-move's view,
    // or null if out of tablebase (>K pieces, or a side already wiped out).
    probe(board, turn) {
      if (!this.loaded) return null;
      const b = this._b;
      let wQ = 0, wB = 0, bQ = 0, bB = 0, total = 0;
      for (let i = 0; i < SIZE; i++) {
        const c = codeOf(board[i]);
        b[i] = c;
        if (c !== 0) { total++; if (c === 1) wB++; else if (c === 2) wQ++; else if (c === 3) bB++; else bQ++; }
      }
      if (total > this.K) return null;
      if ((wQ + wB) === 0 || (bQ + bB) === 0) return null;
      const entry = this.sigs.get(sigKeyOf(wQ, wB, bQ, bB));
      if (!entry) return null;
      const idx = rankBoard(b) * 2 + (turn === 'w' ? 0 : 1);
      const v = entry.val[idx], dtw = entry.dtw[idx];
      if (v === WIN) return { result: 'win', dtw };
      if (v === LOSS) return { result: 'loss', dtw };
      if (v === DRAW) return { result: 'draw', dtw };
      return null;
    }
  }

  return {
    SIZE, MAGIC, UNKNOWN, WIN, LOSS, DRAW,
    multinomial, permCountForSig, rankBoard, unrankBoard, sigKeyOf, unpackSig, codeOf,
    Tablebase,
  };
});
