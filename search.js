'use strict';

/*
 * Iterative-deepening alpha-beta search for the 3x6 bishops+queens variant.
 *
 * Pieces of the engine:
 *   - Negamax alpha-beta with a quiescence search over captures & promotions
 *     (this variant is almost entirely tactical sliding captures, so a static
 *     leaf would be wildly horizon-sensitive).
 *   - Exact endgame tablebase cutoff: any node with <= K pieces returns the
 *     tablebase's WLD verdict (with distance-to-win), i.e. perfect play.
 *   - Bounded transposition table in flat typed arrays (fixed capacity, never
 *     grows toward the 2 GB cap), depth-preferred replacement.
 *   - Repetition detection along the path (game history + current line): a
 *     position seen a second time is an immediate draw (score 0), matching the
 *     engine's twofold-repetition rule. Checked BEFORE the tablebase probe so a
 *     repeat short-circuits even inside the endgame.
 *   - Move ordering: TT move, then MVV-LVA captures, then promotions, then
 *     killer moves, then quiets.
 *
 * Scores are from the side-to-move's perspective (negamax). Decisive scores:
 *   wipeout win  =  MATE - ply        wipeout loss  = -MATE + ply
 *   tablebase win = TBWIN - dtw       tablebase loss = -TBWIN + dtw   draw = 0
 * Any |score| > DECISIVE is "winning/losing for sure".
 */

const engine = require('./engine');
const { evaluate, QUEEN_VALUE, BISHOP_VALUE } = require('./eval');
const { SIZE } = engine;

const POW5 = (() => { const a = new Array(SIZE); let p = 1; for (let i = 0; i < SIZE; i++) { a[i] = p; p *= 5; } return a; })();

const MATE = 30000;
const TBWIN = 28000;     // below MATE so a forced wipeout is preferred to a slow TB win
const DECISIVE = 20000;  // |score| above this is decisive
const INF = 1e9;

// piece string -> tablebase cell code (0 empty,1 wB,2 wQ,3 bB,4 bQ)
function codeOf(p) {
  if (p === null) return 0;
  if (p === 'B') return 1;
  if (p === 'Q') return 2;
  if (p === 'b') return 3;
  return 4; // 'q'
}

// packed numeric key for a state: boardNum*2 + side, < 2^53 (exact double)
function packKey(state) {
  const b = state.board;
  let n = 0;
  for (let i = 0; i < SIZE; i++) { const c = b[i]; if (c !== null) n += codeOf(c) * POW5[i]; }
  return n * 2 + (state.turn === 'w' ? 0 : 1);
}

function pieceValue(p) {
  const t = p === 'Q' || p === 'q' ? 'Q' : 'B';
  return t === 'Q' ? QUEEN_VALUE : BISHOP_VALUE;
}

// move <-> int (from 0..17, to 0..17, promo bit)
function encodeMove(m) { return m.from * 64 + m.to * 2 + (m.promotion ? 1 : 0); }

// TT entry flags
const F_NONE = 0, F_EXACT = 1, F_LOWER = 2, F_UPPER = 3;

class Engine {
  // opts: { tablebase, ttBits=22 }
  constructor(opts = {}) {
    this.tb = opts.tablebase || null;
    const bits = opts.ttBits || 22;             // 2^22 entries ~ 50 MB total
    this.ttCap = 1 << bits;
    this.ttMask = this.ttCap - 1;
    this.ttKey = new Float64Array(this.ttCap);  // 0 = empty
    this.ttScore = new Int16Array(this.ttCap);
    this.ttDepth = new Int8Array(this.ttCap);
    this.ttFlag = new Int8Array(this.ttCap);
    this.ttMove = new Int16Array(this.ttCap);
    this.killers = [];                          // [ply] -> [m1, m2] encoded
    this.counts = new Map();                    // repetition counts along the path
    this.nodes = 0;
    this.stop = false;
    this.deadline = Infinity;
  }

  _ttIndex(key) {
    const hi = Math.floor(key / 4294967296);
    const lo = key - hi * 4294967296;
    let h = Math.imul(lo ^ hi, 2654435761);
    h ^= h >>> 15;
    return (h >>> 0) & this.ttMask;
  }

  _ttProbe(key) {
    const i = this._ttIndex(key);
    if (this.ttKey[i] === key) return i;
    return -1;
  }

  _ttStore(key, depth, score, flag, move) {
    const i = this._ttIndex(key);
    // depth-preferred replacement: keep a deeper analysis of a different key
    if (this.ttKey[i] !== 0 && this.ttKey[i] !== key && this.ttDepth[i] > depth) return;
    this.ttKey[i] = key;
    this.ttScore[i] = score;
    this.ttDepth[i] = depth;
    this.ttFlag[i] = flag;
    this.ttMove[i] = move;
  }

  _bump(key, d) { this.counts.set(key, (this.counts.get(key) || 0) + d); if (this.counts.get(key) === 0) this.counts.delete(key); }
  _seen(key) { return (this.counts.get(key) || 0) >= 1; }

  // ----- move ordering -----------------------------------------------------
  _orderMoves(state, moves, ttMove, ply) {
    const board = state.board;
    const km = this.killers[ply];
    for (const m of moves) {
      let s = 0;
      const enc = encodeMove(m);
      if (enc === ttMove) s = 1e7;
      else {
        const captured = board[m.to];
        if (captured !== null) s = 1e6 + pieceValue(captured) * 16 - pieceValue(board[m.from]); // MVV-LVA
        if (m.promotion) s += 5e5;
        if (s === 0 && km) { if (enc === km[0]) s = 9e4; else if (enc === km[1]) s = 8e4; }
      }
      m._o = s;
    }
    moves.sort((a, b) => b._o - a._o);
  }

  _recordKiller(ply, enc) {
    let k = this.killers[ply];
    if (!k) { k = [0, 0]; this.killers[ply] = k; }
    if (k[0] !== enc) { k[1] = k[0]; k[0] = enc; }
  }

  // terminal score from mover perspective, or null if not terminal
  _terminal(state, ply) {
    const me = state.turn;
    const them = me === 'w' ? 'b' : 'w';
    if (engine.countPieces(state, me) === 0) return -MATE + ply;
    if (engine.countPieces(state, them) === 0) return MATE - ply;
    return null;
  }

  // tablebase score from mover perspective, or null if out of tablebase
  _tbScore(state) {
    if (!this.tb) return null;
    const r = this.tb.probe(state.board, state.turn);
    if (!r) return null;
    if (r.result === 'win') return TBWIN - r.dtw;
    if (r.result === 'loss') return -TBWIN + r.dtw;
    return 0; // draw
  }

  _checkTime() {
    if ((this.nodes & 2047) === 0 && Date.now() >= this.deadline) this.stop = true;
    return this.stop;
  }

  // ----- quiescence: only captures and promotions ---------------------------
  _quiesce(state, key, alpha, beta, ply) {
    this.nodes++;
    if (this._seen(key)) return 0;                       // repetition draw
    const term = this._terminal(state, ply);
    if (term !== null) return term;
    const tb = this._tbScore(state);
    if (tb !== null) return tb;

    const moves = engine.generateMoves(state);
    // mobility needs the opponent's move count
    const oppMoves = engine.generateMoves({ board: state.board, turn: state.turn === 'w' ? 'b' : 'w' }).length;
    let stand = evaluate(state, moves.length, oppMoves);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;

    if (this._checkTime()) return alpha;

    // tactical moves only
    const tactical = [];
    for (const m of moves) if (state.board[m.to] !== null || m.promotion) tactical.push(m);
    this._orderMoves(state, tactical, -1, ply);

    this._bump(key, 1);
    let best = stand;
    for (const m of tactical) {
      const child = engine.applyMove(state, m);
      const v = -this._quiesce(child, packKey(child), -beta, -alpha, ply + 1);
      if (this.stop) break;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    this._bump(key, -1);
    return best;
  }

  // ----- main negamax -------------------------------------------------------
  _search(state, key, depth, alpha, beta, ply) {
    this.nodes++;
    if (this._seen(key)) return 0;                       // repetition draw (2nd occurrence)
    const term = this._terminal(state, ply);
    if (term !== null) return term;
    const tb = this._tbScore(state);
    if (tb !== null) return tb;                          // exact endgame verdict
    if (depth <= 0) return this._quiesce(state, key, alpha, beta, ply);
    if (this._checkTime()) return alpha;

    const alphaOrig = alpha;
    let ttMove = -1;
    const ti = this._ttProbe(key);
    if (ti >= 0) {
      ttMove = this.ttMove[ti];
      if (this.ttDepth[ti] >= depth) {
        let s = this.ttScore[ti];
        // de-adjust mate distance relative to this ply
        if (s > DECISIVE) s -= ply; else if (s < -DECISIVE) s += ply;
        const fl = this.ttFlag[ti];
        if (fl === F_EXACT) return s;
        if (fl === F_LOWER && s > alpha) alpha = s;
        else if (fl === F_UPPER && s < beta) beta = s;
        if (alpha >= beta) return s;
      }
    }

    const moves = engine.generateMoves(state);
    this._orderMoves(state, moves, ttMove, ply);

    this._bump(key, 1);
    let best = -INF, bestMove = 0;
    for (const m of moves) {
      const child = engine.applyMove(state, m);
      const v = -this._search(child, packKey(child), depth - 1, -beta, -alpha, ply + 1);
      if (this.stop) { this._bump(key, -1); return best > -INF ? best : alpha; }
      if (v > best) { best = v; bestMove = encodeMove(m); }
      if (v > alpha) alpha = v;
      if (alpha >= beta) {
        if (state.board[m.to] === null && !m.promotion) this._recordKiller(ply, encodeMove(m));
        break;
      }
    }
    this._bump(key, -1);

    // store with mate distance made ply-relative
    let store = best;
    if (store > DECISIVE) store += ply; else if (store < -DECISIVE) store -= ply;
    const flag = best <= alphaOrig ? F_UPPER : best >= beta ? F_LOWER : F_EXACT;
    this._ttStore(key, depth, store, flag, bestMove);
    return best;
  }

  // ----- public: choose a move ---------------------------------------------
  // historyKeys: packed keys of every position that has occurred this game
  // (including the current one). opts: { timeMs, maxDepth }.
  chooseMove(state, historyKeys = [], opts = {}) {
    this.counts = new Map();
    for (const k of historyKeys) this._bump(k, 1);
    // the current position is "present" once via history; for the root we do
    // not want an immediate repetition verdict on itself, so search its
    // children directly. Decrement the current position so children that
    // return to a DIFFERENT earlier position still flag, but a child equal to
    // the root flags correctly (root still counted via history if it appeared).
    const rootKey = packKey(state);

    this.nodes = 0;
    this.stop = false;
    this.killers = [];
    this.deadline = opts.timeMs ? Date.now() + opts.timeMs : Infinity;
    const maxDepth = opts.maxDepth || 64;

    const rootMoves = engine.generateMoves(state);
    if (rootMoves.length === 0) return { move: null, score: 0, depth: 0, nodes: 0 };

    let best = { move: rootMoves[0], score: -INF, depth: 0 };
    let prevScore = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -INF, beta = INF;
      let localBest = null, localScore = -INF;
      const ttMove = best.move ? encodeMove(best.move) : -1;
      this._orderMoves(state, rootMoves, ttMove, 0);

      this._bump(rootKey, 1);
      for (const m of rootMoves) {
        const child = engine.applyMove(state, m);
        const v = -this._search(child, packKey(child), depth - 1, -beta, -alpha, 1);
        if (this.stop) break;
        if (v > localScore) { localScore = v; localBest = m; }
        if (v > alpha) alpha = v;
      }
      this._bump(rootKey, -1);

      if (this.stop && localBest === null) break;        // no completed move this depth
      if (localBest !== null) { best = { move: localBest, score: localScore, depth }; prevScore = localScore; }
      if (this.stop) break;
      if (localScore > DECISIVE || localScore < -DECISIVE) break; // proven win/loss: stop
    }

    return {
      move: best.move,
      score: best.score === -INF ? prevScore : best.score,
      depth: best.depth,
      nodes: this.nodes,
      mate: best.score > DECISIVE || best.score < -DECISIVE,
    };
  }
}

module.exports = { Engine, packKey, MATE, TBWIN, DECISIVE, encodeMove };
