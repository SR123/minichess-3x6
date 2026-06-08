'use strict';

/*
 * Thin client for the 3x6 bishops+queens variant. All rules, legality, the
 * tablebase and the search engine live on the server; this file renders the
 * board, collects the human's from/to clicks, and POSTs them to /api/move.
 *
 * It also keeps a TIMELINE of frames (the start position + one per half-move),
 * which drives the move list, the replay controls, and save/load. Each frame
 * carries the exact tablebase verdict for that position when it is within the
 * endgame tablebase ("White wins — mate in 3"), shown on the verdict line.
 *
 * Board indexing matches engine.js: index = row*3 + col, row 0 = rank "1"
 * (white's home), row 5 = rank "6" (black's home). We draw rank 6 at the top.
 */

const COLS = 3, ROWS = 6;
const GLYPH = { B: '♗', Q: '♕', b: '♗', q: '♕' }; // ♗ ♕ (color via CSS)

const el = (id) => document.getElementById(id);
const boardEl = el('board'), statusEl = el('status'), verdictEl = el('verdict'), infoEl = el('info');
const movesEl = el('moves'), navLabelEl = el('navLabel');
const sideSel = el('side'), levelSel = el('level');

// ---- game state ------------------------------------------------------------
let timeline = [];      // [frame]; frame 0 is the start position
let live = null;        // latest server response (board/turn/history/legalMoves) — the real game tip
let viewIndex = 0;      // which timeline frame is on the board
let loadedGame = false; // viewing a loaded/finished game (no live play)
let humanColor = 'w';
let selected = null;    // selected from-square (only meaningful at the live tip)
let busy = false;

// A frame: { board, turn, lastMove, tb, status, move, engineInfo }
function frameFromStart(resp) {
  return { board: resp.board, turn: resp.turn, lastMove: null, tb: resp.tb || null,
    status: resp.status, move: null, engineInfo: null };
}
function frameFromPly(ply) {
  return { board: ply.board, turn: ply.turn, lastMove: { from: ply.from, to: ply.to }, tb: ply.tb || null,
    status: ply.status, engineInfo: ply.engineInfo || null,
    move: { san: ply.san, mover: ply.mover, from: ply.from, to: ply.to, promotion: ply.promotion } };
}

const atTip = () => viewIndex === timeline.length - 1;
const atLive = () => !loadedGame && atTip();
const curFrame = () => timeline[viewIndex];
function thinkMs() { return Number(levelSel.value); }

async function api(pathname, body) {
  const res = await fetch(pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

function isWhitePiece(p) { return p && p === p.toUpperCase(); }

// ---- rendering -------------------------------------------------------------
function render() {
  const f = curFrame();
  const board = f.board;
  const showSel = atLive() && !f.status.over;
  const dests = showSel && selected != null ? live.legalMoves.filter((m) => m.from === selected) : [];
  const destSet = new Set(dests.map((m) => m.to));

  boardEl.innerHTML = '';
  for (let row = ROWS - 1; row >= 0; row--) {
    for (let col = 0; col < COLS; col++) {
      const i = row * COLS + col;
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((row + col) % 2 === 1 ? 'light' : 'dark');
      if (showSel && i === selected) sq.classList.add('sel');
      if (f.lastMove && (i === f.lastMove.from || i === f.lastMove.to)) sq.classList.add('last');

      const p = board[i];
      if (p) {
        const span = document.createElement('span');
        span.className = 'piece ' + (isWhitePiece(p) ? 'white' : 'black');
        span.textContent = GLYPH[p];
        sq.appendChild(span);
      }
      if (destSet.has(i)) {
        if (p) sq.classList.add('capture');
        const dot = document.createElement('span'); dot.className = 'dot'; sq.appendChild(dot);
      }
      if (col === 0) { const r = document.createElement('span'); r.className = 'coord rank'; r.textContent = String(row + 1); sq.appendChild(r); }
      if (row === 0) { const fl = document.createElement('span'); fl.className = 'coord file'; fl.textContent = 'abc'[col]; sq.appendChild(fl); }
      sq.addEventListener('click', () => onSquare(i));
      boardEl.appendChild(sq);
    }
  }
  renderStatus(f);
  renderVerdict(f);
  renderInfo(f);
  renderMoves();
  renderNav();
}

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = 'status' + (cls ? ' ' + cls : ''); }

function renderStatus(f) {
  if (busy && atLive()) { setStatus('Engine thinking…', 'thinking'); return; }
  const st = f.status;
  if (st.over) {
    if (st.result === 'draw') { setStatus('Draw by ' + (st.reason || 'repetition') + '.', 'draw'); return; }
    const winnerName = st.result === 'w' ? 'White' : 'Black';
    if (loadedGame) { setStatus(`${winnerName} wins by wipeout.`, st.result === 'w' ? 'win' : 'loss'); return; }
    const humanWon = st.result === humanColor;
    setStatus(`${winnerName} wins by wipeout. ${humanWon ? 'You win!' : 'Engine wins.'}`, humanWon ? 'win' : 'loss');
    return;
  }
  const toMove = f.turn === 'w' ? 'White' : 'Black';
  if (!atLive()) { setStatus(`${toMove} to move.`, ''); return; }
  setStatus(`${toMove} to move — ${f.turn === humanColor ? 'your move' : 'engine to move'}.`, '');
}

// Exact tablebase verdict line: "White wins — mate in 3 (5 plies)" / draw.
function renderVerdict(f) {
  const tb = f.tb;
  if (f.status.over || !tb) { verdictEl.textContent = ''; verdictEl.className = 'verdict'; return; }
  if (tb.result === 'draw') {
    verdictEl.textContent = 'Theoretical draw (tablebase).';
    verdictEl.className = 'verdict draw';
    return;
  }
  const winnerName = tb.winner === 'w' ? 'White' : 'Black';
  const moveWord = tb.moves === 1 ? 'move' : 'moves';
  let who = 'win';
  if (!loadedGame) who = tb.winner === humanColor ? 'win' : 'loss';
  verdictEl.textContent = `${winnerName} wins — mate in ${tb.moves} ${moveWord} (${tb.plies} plies, optimal play).`;
  verdictEl.className = 'verdict ' + who;
}

function renderInfo(f) {
  const info = f.engineInfo;
  if (!info) { infoEl.textContent = ''; return; }
  let evalTxt;
  if (info.mate) evalTxt = (info.score > 0 ? 'engine winning' : 'engine losing') + ' (forced)';
  else evalTxt = (info.score >= 0 ? '+' : '') + (info.score / 100).toFixed(2);
  infoEl.textContent = `engine: depth ${info.depth} · ${info.nodes.toLocaleString()} nodes · eval ${evalTxt}`;
}

// Move list: one row per full move (White ply / Black ply), each clickable.
function renderMoves() {
  movesEl.innerHTML = '';
  // timeline[0] is the start; plies are timeline[1..]
  const nRows = Math.ceil((timeline.length - 1) / 2);
  for (let r = 0; r < nRows; r++) {
    const wIdx = 1 + r * 2, bIdx = 2 + r * 2;
    const li = document.createElement('li');
    const num = document.createElement('span'); num.className = 'num'; num.textContent = (r + 1) + '.';
    li.appendChild(num);
    li.appendChild(plyCell(wIdx));
    li.appendChild(plyCell(bIdx));
    movesEl.appendChild(li);
  }
  const active = movesEl.querySelector('.ply.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function plyCell(idx) {
  const span = document.createElement('span');
  if (idx >= timeline.length) { span.className = 'ply empty'; span.textContent = ''; return span; }
  span.className = 'ply' + (idx === viewIndex ? ' active' : '');
  span.textContent = timeline[idx].move.san;
  span.addEventListener('click', () => { goto(idx); });
  return span;
}

function renderNav() {
  const k = viewIndex, n = timeline.length - 1;
  navLabelEl.textContent = k === 0 ? 'start' : `move ${k} / ${n}` + (atTip() && !loadedGame ? ' (live)' : '');
  el('navStart').disabled = k === 0;
  el('navPrev').disabled = k === 0;
  el('navNext').disabled = atTip();
  el('navEnd').disabled = atTip();
}

// ---- navigation ------------------------------------------------------------
function goto(idx) {
  viewIndex = Math.max(0, Math.min(timeline.length - 1, idx));
  selected = null;
  render();
}
el('navStart').addEventListener('click', () => goto(0));
el('navPrev').addEventListener('click', () => goto(viewIndex - 1));
el('navNext').addEventListener('click', () => goto(viewIndex + 1));
el('navEnd').addEventListener('click', () => goto(timeline.length - 1));
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') goto(viewIndex - 1);
  else if (e.key === 'ArrowRight') goto(viewIndex + 1);
});

// ---- play ------------------------------------------------------------------
async function onSquare(i) {
  if (busy || loadedGame || !atTip()) return;
  const f = curFrame();
  if (f.status.over || live.turn !== humanColor) return;

  if (selected != null) {
    const move = live.legalMoves.find((m) => m.from === selected && m.to === i);
    if (move) { await sendMove(move); return; }
  }
  if (pieceColor(i) === humanColor && live.legalMoves.some((m) => m.from === i)) { selected = i; render(); return; }
  selected = null; render();
}
function pieceColor(i) { const p = curFrame().board[i]; return p ? (isWhitePiece(p) ? 'w' : 'b') : null; }

function applyResponse(resp) {
  for (const ply of (resp.plies || [])) timeline.push(frameFromPly(ply));
  live = resp;
  viewIndex = timeline.length - 1;
}

async function sendMove(move) {
  selected = null; busy = true; render();
  try {
    const resp = await api('/api/move', {
      board: live.board, turn: live.turn, history: live.history,
      move: move ? { from: move.from, to: move.to, promotion: !!move.promotion } : null,
      thinkMs: thinkMs(),
    });
    applyResponse(resp);
    busy = false; render();
  } catch (e) { busy = false; setStatus('Error: ' + e.message, 'loss'); }
}

async function newGame() {
  busy = true; selected = null; loadedGame = false;
  setStatus('Starting…', '');
  try {
    const resp = await api('/api/newgame', {});
    humanColor = sideSel.value;
    timeline = [frameFromStart(resp)];
    live = resp; viewIndex = 0;
    busy = false; render();
    if (live.turn !== humanColor) await sendMove(null); // engine moves first
  } catch (e) { busy = false; setStatus('Error: ' + e.message, 'loss'); }
}

// ---- save / load -----------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }
function saveGame() {
  if (timeline.length === 0) return;
  const data = { app: 'minichess-3x6', version: 1, savedAt: new Date().toISOString(), humanColor, timeline };
  const blob = new Blob([JSON.stringify(data, null, 0)], { type: 'application/json' });
  const d = new Date();
  const name = `minichess-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function loadGameFromText(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { setStatus('Load failed: not valid JSON.', 'loss'); return; }
  if (!data || data.app !== 'minichess-3x6' || !Array.isArray(data.timeline) || data.timeline.length === 0) {
    setStatus('Load failed: not a minichess game file.', 'loss'); return;
  }
  timeline = data.timeline;
  humanColor = data.humanColor || 'w';
  live = null; loadedGame = true; selected = null; busy = false;
  viewIndex = 0;
  render();
  setStatus('Loaded game — replay with the arrows. Press “New game” to play.', '');
}

el('new').addEventListener('click', newGame);
el('save').addEventListener('click', saveGame);
el('load').addEventListener('click', () => el('loadFile').click());
el('loadFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadGameFromText(String(reader.result));
  reader.readAsText(file);
  e.target.value = '';
});

newGame();
