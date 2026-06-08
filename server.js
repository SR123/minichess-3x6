'use strict';

/*
 * Web server to play the 3x6 bishops+queens variant against the search engine.
 *
 *   GET  /                -> the board UI (public/index.html)
 *   GET  /app.js          -> the client script
 *   POST /api/newgame     -> { board, turn, history, status }
 *   POST /api/move        -> apply the human's move, then reply with the
 *                            engine's move. Body: { board, turn, history, move }
 *                            where `move` is the human move {from,to,promotion}
 *                            (or null to ask the engine to move from the given
 *                            position, e.g. when the engine plays first).
 *
 * The browser is a thin renderer: all rules, legality, repetition and the
 * engine live here on the server. `history` is the list of packed position keys
 * that have occurred this game (including the current position); the server
 * uses it for the engine's repetition awareness and to apply the twofold-draw
 * rule itself.
 *
 * Run:  node --max-old-space-size=2048 server.js [port]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { Engine, packKey } = require('./search');
const { Tablebase } = require('./tbprobe');
const study = require('./tbstudy');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const THINK_MS = Number(process.env.THINK_MS || 1500);

// ---- load the tablebase + build the search engine once ---------------------
const tb = new Tablebase().loadDefault(6);
if (tb.loaded) console.log(`Tablebase loaded: K=${tb.K}`);
else console.log('No tablebase found (engine will search without endgame oracle).');
const ai = new Engine({ tablebase: tb.loaded ? tb : null });

// ---- helpers ---------------------------------------------------------------

// Recompute the count of each position from a history of packed keys, then
// report whether the *current* position is a twofold repetition (draw).
function isRepetitionDraw(history) {
  const counts = new Map();
  for (const k of history) counts.set(k, (counts.get(k) || 0) + 1);
  const cur = history[history.length - 1];
  return (counts.get(cur) || 0) >= 2;
}

// Full status of a position given its game history (terminal + repetition).
// Returns { over, result?, reason? }. result is 'w' | 'b' | 'draw'.
function statusOf(state, history) {
  if (isRepetitionDraw(history)) return { over: true, result: 'draw', reason: 'repetition' };
  const t = engine.terminalStatus(state);
  if (t.over) return { over: true, result: t.result, reason: 'wipeout' };
  return { over: false };
}

// Validate that `move` is one of the legal moves from `state` and return the
// canonical move object (so promotion flags etc. are authoritative).
function findLegalMove(state, move) {
  for (const m of engine.generateMoves(state)) {
    if (m.from === move.from && m.to === move.to && !!m.promotion === !!move.promotion) return m;
  }
  return null;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Exact tablebase verdict for the position, in ABSOLUTE terms (which colour wins
// and in how many plies/moves), or null if the position is out of the tablebase.
// `dtw` is a true distance-to-win: plies to wipeout under optimal play.
function tbInfo(state) {
  if (!tb.loaded) return null;
  const pr = tb.probe(state.board, state.turn);
  if (!pr) return null;
  if (pr.result === 'draw') return { result: 'draw', plies: 0, moves: 0, winner: null };
  // 'win' is for the side to move; 'loss' means the other side wins.
  const winner = pr.result === 'win' ? state.turn : (state.turn === 'w' ? 'b' : 'w');
  return { result: 'decisive', winner, plies: pr.dtw, moves: Math.ceil(pr.dtw / 2) };
}

// ---- endgame study ---------------------------------------------------------
const other = (s) => (s === 'w' ? 'b' : 'w');

// The per-class longest-win index. Built once (a full tablebase scan, ~10s for
// K5) on the first /api/study/classes request, then cached. Only classes that
// have a forced win are listed (a wholly-drawn class has nothing to study).
let STUDY_INDEX = null;
function studyClasses() {
  if (!tb.loaded) return [];
  if (!STUDY_INDEX) {
    console.log('Building endgame study index (one-time tablebase scan)...');
    const t = Date.now();
    STUDY_INDEX = study.buildClassIndex(tb)
      .filter((c) => c.hardest)
      .map((c) => ({
        name: c.name, pieces: c.pieces, counts: c.counts, maxDtw: c.maxDtw, maxMoves: c.maxMoves,
        hardest: { board: c.hardest.board, turn: c.hardest.turn, winner: c.hardest.winner },
      }));
    console.log(`  study index: ${STUDY_INDEX.length} classes in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  return STUDY_INDEX;
}

// Absolute probe summary for a position (which colour wins, in how many plies).
function studyProbe(state) {
  const pr = tb.loaded ? tb.probe(state.board, state.turn) : null;
  if (!pr) return null;
  if (pr.result === 'draw') return { result: 'draw', winner: null, plies: 0, moves: 0 };
  const winner = pr.result === 'win' ? state.turn : other(state.turn);
  return { result: pr.result, winner, plies: pr.dtw, moves: Math.ceil(pr.dtw / 2) };
}

// Full study analysis of a position: per-move outcomes (sorted best-first) plus
// the position's own verdict, or a terminal marker once a side is wiped out.
function studyAnalyze(state) {
  const w = engine.countPieces(state, 'w'), b = engine.countPieces(state, 'b');
  if (w === 0 || b === 0) {
    return { board: state.board, turn: state.turn, terminal: true, winner: w === 0 ? 'b' : 'w', probe: null, moves: [], optimalIndex: -1 };
  }
  const a = study.analyze(tb, state);
  return { board: state.board, turn: state.turn, terminal: false, winner: null, probe: studyProbe(state), moves: a.moves, optimalIndex: a.optimalIndex };
}

// Build a response payload describing a position + legal moves + status.
function describe(state, history) {
  const status = statusOf(state, history);
  const moves = status.over ? [] : engine.generateMoves(state).map((m) => ({
    from: m.from, to: m.to, promotion: !!m.promotion, san: engine.moveSan(m),
  }));
  return { board: state.board, turn: state.turn, history, status, legalMoves: moves, tb: tbInfo(state) };
}

// ---- request handling ------------------------------------------------------

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/study': ['study.html', 'text/html; charset=utf-8'],
  '/study.html': ['study.html', 'text/html; charset=utf-8'],
  '/study.js': ['study.js', 'application/javascript; charset=utf-8'],
  '/study.css': ['study.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && STATIC[req.url]) {
      const [file, type] = STATIC[req.url];
      const full = path.join(PUBLIC, file);
      fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': type });
        res.end(buf);
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/study/classes') {
      sendJson(res, 200, { loaded: tb.loaded, K: tb.K, classes: studyClasses() });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/study/analyze') {
      const body = await readBody(req);
      if (!Array.isArray(body.board) || (body.turn !== 'w' && body.turn !== 'b')) {
        sendJson(res, 400, { error: 'expected {board, turn}' }); return;
      }
      sendJson(res, 200, studyAnalyze({ board: body.board.slice(), turn: body.turn }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/newgame') {
      const state = engine.initialState();
      const history = [packKey(state)];
      sendJson(res, 200, describe(state, history));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/move') {
      const body = await readBody(req);
      let state = { board: body.board.slice(), turn: body.turn };
      let history = (body.history || []).slice();
      const thinkMs = Number(body.thinkMs) || THINK_MS;
      const plies = []; // each half-move applied this request, with its own snapshot

      // record a half-move frame for the position AFTER `mover` played `mv`
      const recordPly = (mover, mv, engineInfo) => {
        const st = statusOf(state, history);
        plies.push({
          mover, san: engine.moveSan(mv), from: mv.from, to: mv.to, promotion: !!mv.promotion,
          board: state.board, turn: state.turn, status: st, tb: tbInfo(state),
          engineInfo: engineInfo || null,
        });
        return st;
      };

      // 1) apply the human move if one was supplied
      if (body.move) {
        const legal = findLegalMove(state, body.move);
        if (!legal) { sendJson(res, 400, { error: 'illegal move' }); return; }
        const mover = state.turn;
        state = engine.applyMove(state, legal);
        history.push(packKey(state));
        const st = recordPly(mover, legal, null);
        if (st.over) { sendJson(res, 200, { ...describe(state, history), engineMove: null, plies }); return; }
      }

      // 2) engine replies
      const result = ai.chooseMove(state, history, { timeMs: thinkMs });
      if (!result.move) { sendJson(res, 200, { ...describe(state, history), engineMove: null, plies }); return; }
      const engineInfo = { score: result.score, depth: result.depth, nodes: result.nodes, mate: result.mate };
      const engMove = { from: result.move.from, to: result.move.to, promotion: !!result.move.promotion, san: engine.moveSan(result.move) };
      const mover = state.turn;
      state = engine.applyMove(state, result.move);
      history.push(packKey(state));
      recordPly(mover, result.move, engineInfo);

      sendJson(res, 200, {
        ...describe(state, history),
        engineMove: engMove,
        engineInfo,
        plies,
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`minichess server on http://localhost:${PORT}  (think ${THINK_MS}ms/move)`);
});
