'use strict';

/*
 * Endgame-study client. All numbers come from the server's tablebase queries
 * (/api/study/classes and /api/study/analyze) -- this file only renders and
 * drives navigation. Three features:
 *   1. a list of every material class with its longest forced win,
 *   2. step/auto-play through the optimal line (winner minimising DTW, loser
 *      maximising) until a side is wiped out, and
 *   3. for the shown position, every legal move with its exact tablebase outcome
 *      ("win in 19 plies", "draw", "loss in 28 plies"), sorted best-first.
 *
 * Board indexing matches engine.js: index = row*3 + col, row 0 = rank "1",
 * row 5 = rank "6"; rank 6 is drawn at the top.
 */

const COLS = 3, ROWS = 6;
const GLYPH = { B: '♗', Q: '♕', b: '♗', q: '♕' };
const el = (id) => document.getElementById(id);
const isWhitePiece = (p) => p && p === p.toUpperCase();

const boardEl = el('board'), classesEl = el('classes'), moveListEl = el('moveList');
const classNameEl = el('className'), verdictEl = el('verdict'), dtwlineEl = el('dtwline'), plylineEl = el('plyline');

// ---- state -----------------------------------------------------------------
let classes = [];
let current = null;        // current class { name, hardest:{board,turn,winner}, maxDtw, maxMoves }
let path = [];             // visited positions [{board, turn}] along the explored line
let cursor = 0;            // index into `path` currently shown
let analysis = null;       // server analyze() of path[cursor]
let rootDtw = 0;           // DTW at the study start (total plies of the optimal line)
let lastMove = null;       // {from,to} that led to the shown position (for highlight)
let playing = false;       // auto-play loop active?

async function api(pathname, body) {
  const res = await fetch(pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'request failed');
  return res.json();
}

// ---- class list ------------------------------------------------------------
async function loadClasses() {
  const data = await api('/api/study/classes', {});
  classes = data.classes || [];
  if (!data.loaded || classes.length === 0) { classesEl.innerHTML = '<div class="loading">No tablebase loaded.</div>'; return; }
  renderClassList();
  selectClass(classes[0]); // open the deepest few-piece class first
}

function renderClassList() {
  classesEl.innerHTML = '';
  let lastPieces = null;
  for (const c of classes) {
    if (c.pieces !== lastPieces) {
      const h = document.createElement('div');
      h.className = 'piece-group';
      h.textContent = `${c.pieces} pieces`;
      classesEl.appendChild(h);
      lastPieces = c.pieces;
    }
    const row = document.createElement('div');
    row.className = 'class-row' + (current && current.name === c.name ? ' active' : '');
    row.dataset.name = c.name;
    const win = c.hardest.winner === 'w' ? 'White' : 'Black';
    row.innerHTML = `<span class="cn">${c.name}</span>` +
      `<span class="cd">${win} · ${c.maxMoves}m / ${c.maxDtw}p</span>`;
    row.addEventListener('click', () => selectClass(c));
    classesEl.appendChild(row);
  }
}

function selectClass(c) {
  stopPlay();
  current = c;
  path = [{ board: c.hardest.board.slice(), turn: c.hardest.turn }];
  cursor = 0;
  lastMove = null;
  rootDtw = c.maxDtw;
  for (const r of classesEl.querySelectorAll('.class-row')) r.classList.toggle('active', r.dataset.name === c.name);
  classNameEl.textContent = `${c.name} — longest forced win`;
  analyzeCurrent();
}

// ---- analysis + rendering --------------------------------------------------
async function analyzeCurrent() {
  const pos = path[cursor];
  analysis = await api('/api/study/analyze', { board: pos.board, turn: pos.turn });
  render();
  return analysis;
}

function render() {
  renderBoard(path[cursor].board);
  renderVerdict();
  renderControls();
  renderMoveList();
}

function renderBoard(board) {
  boardEl.innerHTML = '';
  for (let row = ROWS - 1; row >= 0; row--) {
    for (let col = 0; col < COLS; col++) {
      const i = row * COLS + col;
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((row + col) % 2 === 1 ? 'light' : 'dark');
      if (lastMove && (i === lastMove.from || i === lastMove.to)) sq.classList.add('last');
      const p = board[i];
      if (p) {
        const span = document.createElement('span');
        span.className = 'piece ' + (isWhitePiece(p) ? 'white' : 'black');
        span.textContent = GLYPH[p];
        sq.appendChild(span);
      }
      if (col === 0) { const r = document.createElement('span'); r.className = 'coord rank'; r.textContent = String(row + 1); sq.appendChild(r); }
      if (row === 0) { const fl = document.createElement('span'); fl.className = 'coord file'; fl.textContent = 'abc'[col]; sq.appendChild(fl); }
      boardEl.appendChild(sq);
    }
  }
}

function renderVerdict() {
  if (analysis.terminal) {
    const w = analysis.winner === 'w' ? 'White' : 'Black';
    verdictEl.textContent = `${w} wins — opponent wiped out.`;
    verdictEl.className = 'verdict win';
    dtwlineEl.textContent = '';
    return;
  }
  const pr = analysis.probe;
  const toMove = path[cursor].turn === 'w' ? 'White' : 'Black';
  if (!pr) { verdictEl.textContent = `${toMove} to move (outside tablebase).`; verdictEl.className = 'verdict'; dtwlineEl.textContent = ''; return; }
  if (pr.result === 'draw') {
    verdictEl.textContent = 'Theoretical draw.'; verdictEl.className = 'verdict draw';
    dtwlineEl.textContent = `${toMove} to move.`;
    return;
  }
  const winName = pr.winner === 'w' ? 'White' : 'Black';
  const mw = pr.moves === 1 ? 'move' : 'moves';
  verdictEl.textContent = `${winName} wins — mate in ${pr.moves} ${mw} (${pr.plies} plies).`;
  verdictEl.className = 'verdict ' + (pr.result === 'win' ? 'win' : 'loss');
  const role = path[cursor].turn === pr.winner ? 'winner to move (minimising)' : 'loser to move (stalling)';
  dtwlineEl.textContent = `${toMove} to move — ${role} · DTW ${pr.plies} plies to wipeout.`;
}

function renderControls() {
  const total = rootDtw;
  plylineEl.textContent = `ply ${cursor} / ${total}` + (analysis.terminal ? ' — wipeout' : '');
  el('back').disabled = cursor === 0;
  el('reset').disabled = cursor === 0;
  const atEnd = analysis.terminal || analysis.optimalIndex < 0;
  el('step').disabled = atEnd;
  el('toend').disabled = atEnd;
  el('play').textContent = playing ? '❚❚' : '▶';
  el('play').disabled = atEnd && !playing;
}

function outcomeText(m) {
  if (m.result === 'draw') return 'draw';
  const mw = m.moves === 1 ? 'move' : 'moves';
  return `${m.result} in ${m.plies} plies (${m.moves} ${mw})`;
}

function renderMoveList() {
  moveListEl.innerHTML = '';
  if (analysis.terminal) { moveListEl.innerHTML = '<li class="terminal">Game over — no moves.</li>'; return; }
  analysis.moves.forEach((m, idx) => {
    const li = document.createElement('li');
    li.className = 'move ' + m.result + (idx === analysis.optimalIndex ? ' optimal' : '');
    li.innerHTML = `<span class="mark">${idx === analysis.optimalIndex ? '✓' : ''}</span>` +
      `<span class="san">${m.san}</span><span class="oc">${outcomeText(m)}</span>`;
    li.addEventListener('click', () => takeMove(m));
    moveListEl.appendChild(li);
  });
}

// ---- navigation ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Advance to the position resulting from move `m` (optimal or an explored
// branch). Returns the promise for the resulting analyze, so callers can await.
function takeMove(m) {
  path = path.slice(0, cursor + 1); // truncate forward history (we're branching)
  path.push({ board: m.board.slice(), turn: m.turn });
  cursor++;
  lastMove = { from: m.from, to: m.to };
  return analyzeCurrent();
}

function stepForward() {
  if (!analysis || analysis.terminal || analysis.optimalIndex < 0) { stopPlay(); return Promise.resolve(); }
  return takeMove(analysis.moves[analysis.optimalIndex]);
}

function stepBack() {
  if (cursor === 0) return;
  stopPlay();
  cursor--;
  lastMove = null; // we don't re-derive the move into an arbitrary prior node
  analyzeCurrent();
}

function reset() { stopPlay(); cursor = 0; lastMove = null; path = path.slice(0, 1); analyzeCurrent(); }

async function toEnd() {
  stopPlay();
  let guard = rootDtw + 4;
  while (guard-- > 0 && analysis && !analysis.terminal && analysis.optimalIndex >= 0) {
    await stepForward();
  }
}

function play() {
  if (playing) { stopPlay(); renderControls(); return; }
  if (analysis && (analysis.terminal || analysis.optimalIndex < 0)) return;
  playing = true;
  renderControls();
  (async function loop() {
    while (playing && analysis && !analysis.terminal && analysis.optimalIndex >= 0) {
      await stepForward();
      if (playing) await sleep(850);
    }
    playing = false;
    renderControls();
  })();
}
function stopPlay() { playing = false; }

el('reset').addEventListener('click', reset);
el('back').addEventListener('click', stepBack);
el('play').addEventListener('click', play);
el('step').addEventListener('click', () => { stopPlay(); stepForward(); });
el('toend').addEventListener('click', toEnd);
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { stopPlay(); stepForward(); }
  else if (e.key === 'ArrowLeft') stepBack();
  else if (e.key === ' ') { e.preventDefault(); play(); }
});

loadClasses().catch((e) => { classesEl.innerHTML = `<div class="loading">Error: ${e.message}</div>`; });
