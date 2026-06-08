'use strict';

/*
 * Parity test: the featherweight BROWSER port (docs/engine.js, docs/tablebase.js,
 * docs/study.js) must produce exactly the same results as the SERVER code
 * (tbprobe.js + tbstudy.js) on K3 positions. Both are loaded here under Node --
 * the docs modules are dual-loaded (UMD), so this exercises the identical code
 * the browser ships. If these ever diverge, the static site would silently lie.
 *
 * Checks over a sample of K3 positions (both sides to move):
 *   - probe(result, dtw) identical
 *   - analyze(): same moves in the same best-first order, with identical
 *     result/plies/moves and optimalIndex
 *   - principalVariation(): identical SAN sequence, ending in a wipeout
 *   - buildClassIndex(): same classes, ordering, maxDTW, and hardest positions
 *
 *   node --max-old-space-size=2048 docs-parity.test.js
 */

const fs = require('fs');
const path = require('path');

// server side
const sengine = require('./engine');
const { Tablebase: ServerTB } = require('./tbprobe');
const sstudy = require('./tbstudy');
const stb = require('./tablebase');

// browser port (loaded as Node modules via the UMD wrapper)
const bengine = require('./docs/engine');
const BTB = require('./docs/tablebase');
const bstudy = require('./docs/study');

const K = 3;
const codeToPiece = [null, 'B', 'Q', 'b', 'q'];

const ST = new ServerTB().load('tb.K3.bin');
const BT = new BTB.Tablebase().loadFromBuffer(fs.readFileSync(path.join(__dirname, 'docs', 'tb.K3.bin')));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}

function allSignatures(K) {
  const out = [];
  for (let wQ = 0; wQ <= K; wQ++) for (let wB = 0; wB + wQ <= K; wB++)
    for (let bQ = 0; bQ + wB + wQ <= K; bQ++) for (let bB = 0; bB + bQ + wB + wQ <= K; bB++) {
      const t = wQ + wB + bQ + bB; if (t >= 1 && t <= K) out.push([wQ, wB, bQ, bB]);
    }
  return out;
}
function boardOf(codes) { const b = new Array(18); for (let i = 0; i < 18; i++) b[i] = codeToPiece[codes[i]]; return b; }

// ---- A) probe parity over EVERY K3 probed position -------------------------
console.log('A) probe parity (browser vs server) over all K3 positions:');
{
  let checked = 0, mism = 0;
  const firstBad = [];
  for (const [wQ, wB, bQ, bB] of allSignatures(K)) {
    if ((wQ + wB) === 0 || (bQ + bB) === 0) continue;
    const perm = stb.permCountForSig(wQ, wB, bQ, bB);
    for (let r = 0; r < perm; r++) {
      const board = boardOf(stb.unrankBoard(r, wQ, wB, bQ, bB));
      for (const turn of ['w', 'b']) {
        const s = ST.probe(board, turn);
        const b = BT.probe(board, turn);
        checked++;
        const same = (s === null && b === null) || (s && b && s.result === b.result && s.dtw === b.dtw);
        if (!same) { mism++; if (firstBad.length < 5) firstBad.push({ pos: sengine.serialize({ board, turn }), server: s, browser: b }); }
      }
    }
  }
  console.log(`   checked ${checked.toLocaleString()} positions`);
  check('every browser probe equals the server probe', mism === 0, `${mism} mismatch`);
  for (const e of firstBad) console.log('     ', JSON.stringify(e));
}

// ---- B) analyze() + principalVariation() parity over a sample --------------
console.log('\nB) per-move analysis + optimal line parity over a sample:');
{
  let posChecked = 0, analyzeBad = 0, pvBad = 0;
  const firstBad = [];
  for (const [wQ, wB, bQ, bB] of allSignatures(K)) {
    if ((wQ + wB) === 0 || (bQ + bB) === 0) continue;
    const perm = stb.permCountForSig(wQ, wB, bQ, bB);
    const stride = Math.max(1, Math.floor(perm / 200));
    for (let r = 0; r < perm; r += stride) {
      const board = boardOf(stb.unrankBoard(r, wQ, wB, bQ, bB));
      for (const turn of ['w', 'b']) {
        const state = { board, turn };
        if (!ST.probe(board, turn)) continue;
        posChecked++;

        // analyze: compare the (san,result,plies) lists in order + optimalIndex
        const sa = sstudy.analyze(ST, state);
        const ba = bstudy.analyze(BT, state);
        const enc = (a) => a.moves.map((m) => `${m.san}:${m.result}:${m.plies}`).join(',') + `|opt=${a.optimalIndex}`;
        if (enc(sa) !== enc(ba)) {
          analyzeBad++;
          if (firstBad.length < 5) firstBad.push({ kind: 'analyze', pos: sengine.serialize(state), server: enc(sa), browser: enc(ba) });
        }

        // principal variation: identical SAN sequence
        const spv = sstudy.principalVariation(ST, board, turn).map((m) => m.san).join(' ');
        const bpv = bstudy.principalVariation(BT, board, turn).map((m) => m.san).join(' ');
        if (spv !== bpv) {
          pvBad++;
          if (firstBad.length < 5) firstBad.push({ kind: 'pv', pos: sengine.serialize(state), server: spv, browser: bpv });
        }
      }
    }
  }
  console.log(`   sampled ${posChecked} positions`);
  check('analyze() identical (moves, order, plies, optimalIndex)', analyzeBad === 0, `${analyzeBad} bad`);
  check('principalVariation() identical SAN sequence', pvBad === 0, `${pvBad} bad`);
  for (const e of firstBad) console.log('     ', JSON.stringify(e));
}

// ---- C) class index parity --------------------------------------------------
console.log('\nC) class index parity:');
{
  const sc = sstudy.buildClassIndex(ST);
  const bc = bstudy.buildClassIndex(BT);
  check('same number of classes', sc.length === bc.length, `${sc.length} vs ${bc.length}`);
  let bad = 0;
  const firstBad = [];
  for (let i = 0; i < Math.min(sc.length, bc.length); i++) {
    const a = sc[i], b = bc[i];
    const sameMeta = a.name === b.name && a.pieces === b.pieces && a.maxDtw === b.maxDtw;
    const sameHard = (!a.hardest && !b.hardest) ||
      (a.hardest && b.hardest &&
        sengine.serialize({ board: a.hardest.board, turn: a.hardest.turn }) ===
        bengine.serialize({ board: b.hardest.board, turn: b.hardest.turn }) &&
        a.hardest.winner === b.hardest.winner);
    if (!sameMeta || !sameHard) { bad++; if (firstBad.length < 5) firstBad.push({ i, server: { n: a.name, d: a.maxDtw }, browser: { n: b.name, d: b.maxDtw } }); }
  }
  check('every class matches (name, order, maxDTW, hardest position)', bad === 0, `${bad} bad`);
  for (const e of firstBad) console.log('     ', JSON.stringify(e));
  const gmax = Math.max(...bc.map((c) => c.maxDtw));
  check('browser global max DTW = 20 (K3)', gmax === 20, `got ${gmax}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
