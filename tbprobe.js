'use strict';

/*
 * Loader + probe for the exact <=K endgame tablebase built by build-tablebase.js.
 *
 * Probing is O(1): a position's signature selects a dense per-signature array,
 * and rankBoard gives the exact slot (rank*2 + side). No keys are stored and no
 * search is needed.
 *
 * The board passed to probe() is an engine.js board: an Array(18) of piece
 * strings ('B','Q','b','q') or null. We map it to the tablebase cell codes
 * (0 empty, 1 wB, 2 wQ, 3 bB, 4 bQ) on the fly.
 */

const fs = require('fs');
const path = require('path');
const tb = require('./tablebase');
const { SIZE, sigKeyOf, rankBoard, WIN, LOSS, DRAW } = tb;

const MAGIC = 0x54434234; // 'TCB4' -- distance field is distance-to-win (DTW)

// piece string -> cell code
function codeOf(piece) {
  if (piece === null) return 0;
  switch (piece) {
    case 'B': return 1;
    case 'Q': return 2;
    case 'b': return 3;
    case 'q': return 4;
    default: throw new Error(`Bad piece: ${piece}`);
  }
}

class Tablebase {
  constructor() {
    this.K = 0;
    this.sigs = new Map(); // sig -> { val: Uint8Array, dtw: Int16Array }
    this.loaded = false;
    this._board = new Int8Array(SIZE);
  }

  // Load a tb.K*.bin file. Returns this. Throws if the file is malformed.
  load(file) {
    const buf = fs.readFileSync(file);
    const magic = buf.readUInt32LE(0);
    if (magic !== MAGIC) {
      if (magic === 0x54434233) {
        throw new Error(
          `${file}: stale 'TCB3' tablebase. The format is now 'TCB4' (the ` +
          `distance field is guaranteed distance-to-win). Rebuild it:\n` +
          `  node --max-old-space-size=2048 build-tablebase.js ${buf.readUInt32LE(4)} ${file}`);
      }
      throw new Error(`${file}: bad magic 0x${magic.toString(16)} (expected 'TCB4')`);
    }
    this.K = buf.readUInt32LE(4);
    const nSigs = buf.readUInt32LE(8);
    const entries = [];
    let off = 12;
    for (let i = 0; i < nSigs; i++) {
      entries.push([buf.readUInt32LE(off), buf.readUInt32LE(off + 4)]);
      off += 8;
    }
    // val block
    for (const [sig, n2] of entries) {
      const val = new Uint8Array(n2);
      buf.copy(Buffer.from(val.buffer), 0, off, off + n2);
      off += n2;
      this.sigs.set(sig, { val, dtw: null, n2 });
    }
    // dtw block
    for (const [sig, n2] of entries) {
      const dtw = new Int16Array(n2);
      // copy n2*2 bytes
      Buffer.from(dtw.buffer).set(buf.subarray(off, off + n2 * 2));
      off += n2 * 2;
      this.sigs.get(sig).dtw = dtw;
    }
    this.loaded = true;
    this.maxPieces = this.K;
    return this;
  }

  // Try to load the default tb.K{K}.bin for the largest K available in cwd or
  // the module directory. Returns this; this.loaded is false if none found.
  loadDefault(maxK = 6) {
    const dirs = [process.cwd(), __dirname];
    for (let k = maxK; k >= 2; k--) {
      for (const d of dirs) {
        const f = path.join(d, `tb.K${k}.bin`);
        if (fs.existsSync(f)) { this.load(f); return this; }
      }
    }
    return this;
  }

  // Probe an engine board (Array(18) of piece|null) with side to move
  // ('w'|'b'). Returns { result: 'win'|'loss'|'draw', dtw } from the side to
  // move's perspective, or null if the position is out of the tablebase
  // (more than K pieces, or a side already wiped out -> caller handles those).
  probe(board, turn) {
    if (!this.loaded) return null;
    const b = this._board;
    let wQ = 0, wB = 0, bQ = 0, bB = 0, total = 0;
    for (let i = 0; i < SIZE; i++) {
      const c = codeOf(board[i]);
      b[i] = c;
      if (c !== 0) {
        total++;
        if (c === 1) wB++; else if (c === 2) wQ++; else if (c === 3) bB++; else bQ++;
      }
    }
    if (total > this.K) return null;
    if ((wQ + wB) === 0 || (bQ + bB) === 0) return null; // terminal: caller decides
    const entry = this.sigs.get(sigKeyOf(wQ, wB, bQ, bB));
    if (!entry) return null;
    const side = turn === 'w' ? 0 : 1;
    const idx = rankBoard(b) * 2 + side;
    const v = entry.val[idx];
    const dtw = entry.dtw[idx];
    if (v === WIN) return { result: 'win', dtw };
    if (v === LOSS) return { result: 'loss', dtw };
    if (v === DRAW) return { result: 'draw', dtw };
    return null;
  }
}

module.exports = { Tablebase };
