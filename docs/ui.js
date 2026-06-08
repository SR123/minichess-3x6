'use strict';

/*
 * Featherweight study UI (browser only). Loads tb.K3.bin as a static asset and
 * does ALL tablebase work in the page via MiniEngine / MiniTB / MiniStudy -- no
 * server, no API calls. Same three features as the full study page, K3-only:
 * per-class longest wins, optimal-line playthrough, and the ranked per-move
 * outcome list. Everything is synchronous once the .bin is fetched.
 */

const COLS = 3, ROWS = 6;
const GLYPH = { B: '♗', Q: '♕', b: '♗', q: '♕' };
const el = (id) => document.getElementById(id);
const isWhitePiece = (p) => p && p === p.toUpperCase();
const other = (s) => (s === 'w' ? 'b' : 'w');

const boardEl = el('board'), classesEl = el('classes'), moveListEl = el('moveList');
const classNameEl = el('className'), verdictEl = el('verdict'), dtwlineEl = el('dtwline'), plylineEl = el('plyline');

let T = null;              // loaded MiniTB tablebase
let classes = [];
let current = null;        // current class
let path = [];             // visited positions [{board, turn}]
let cursor = 0;
let analysis = null;       // studyAnalyze of path[cursor]
let rootDtw = 0;
let lastMove = null;
let playing = false;

// ---- local "endpoints" (mirror server.js studyProbe/studyAnalyze) ----------
function studyProbe(state) {
  const pr = T.probe(state.board, state.turn);
  if (!pr) return null;
  if (pr.result === 'draw') return { result: 'draw', winner: null, plies: 0, moves: 0 };
  const winner = pr.result === 'win' ? state.turn : other(state.turn);
  return { result: pr.result, winner, plies: pr.dtw, moves: Math.ceil(pr.dtw / 2) };
}
function studyAnalyze(state) {
  const w = MiniEngine.countPieces(state, 'w'), b = MiniEngine.countPieces(state, 'b');
  if (w === 0 || b === 0) {
    return { board: state.board, turn: state.turn, terminal: true, winner: w === 0 ? 'b' : 'w', probe: null, moves: [], optimalIndex: -1 };
  }
  const a = MiniStudy.analyze(T, state);
  return { board: state.board, turn: state.turn, terminal: false, winner: null, probe: studyProbe(state), moves: a.moves, optimalIndex: a.optimalIndex };
}

// ---- class list ------------------------------------------------------------
function renderClassList() {
  classesEl.innerHTML = '';
  let lastPieces = null;
  for (const c of classes) {
    if (c.pieces !== lastPieces) {
      const h = document.createElement('div');
      h.className = 'piece-group'; h.textContent = `${c.pieces} pieces`;
      classesEl.appendChild(h); lastPieces = c.pieces;
    }
    const row = document.createElement('div');
    row.className = 'class-row' + (current && current.name === c.name ? ' active' : '');
    row.dataset.name = c.name;
    const win = c.hardest.winner === 'w' ? 'White' : 'Black';
    row.innerHTML = `<span class="cn">${c.name}</span><span class="cd">${win} · ${c.maxMoves}m / ${c.maxDtw}p</span>`;
    row.addEventListener('click', () => selectClass(c));
    classesEl.appendChild(row);
  }
}

function selectClass(c) {
  stopPlay();
  current = c;
  path = [{ board: c.hardest.board.slice(), turn: c.hardest.turn }];
  cursor = 0; lastMove = null; rootDtw = c.maxDtw;
  for (const r of classesEl.querySelectorAll('.class-row')) r.classList.toggle('active', r.dataset.name === c.name);
  classNameEl.textContent = `${c.name} — longest forced win`;
  refresh();
}

// ---- analysis + rendering --------------------------------------------------
function refresh() {
  analysis = studyAnalyze(path[cursor]);
  render();
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
      const cell = document.createElement('div');
      cell.className = 'sq ' + ((row + col) % 2 === 1 ? 'light' : 'dark');
      if (lastMove && (i === lastMove.from || i === lastMove.to)) cell.classList.add('last');
      const p = board[i];
      if (p) {
        const span = document.createElement('span');
        span.className = 'piece ' + (isWhitePiece(p) ? 'white' : 'black');
        span.textContent = GLYPH[p];
        cell.appendChild(span);
      }
      if (col === 0) { const r = document.createElement('span'); r.className = 'coord rank'; r.textContent = String(row + 1); cell.appendChild(r); }
      if (row === 0) { const fl = document.createElement('span'); fl.className = 'coord file'; fl.textContent = 'abc'[col]; cell.appendChild(fl); }
      boardEl.appendChild(cell);
    }
  }
}

function renderVerdict() {
  if (analysis.terminal) {
    verdictEl.textContent = `${analysis.winner === 'w' ? 'White' : 'Black'} wins — opponent wiped out.`;
    verdictEl.className = 'verdict win'; dtwlineEl.textContent = ''; return;
  }
  const pr = analysis.probe;
  const toMove = path[cursor].turn === 'w' ? 'White' : 'Black';
  if (!pr) { verdictEl.textContent = `${toMove} to move.`; verdictEl.className = 'verdict'; dtwlineEl.textContent = ''; return; }
  if (pr.result === 'draw') { verdictEl.textContent = 'Theoretical draw.'; verdictEl.className = 'verdict draw'; dtwlineEl.textContent = `${toMove} to move.`; return; }
  const winName = pr.winner === 'w' ? 'White' : 'Black';
  const mw = pr.moves === 1 ? 'move' : 'moves';
  verdictEl.textContent = `${winName} wins — mate in ${pr.moves} ${mw} (${pr.plies} plies).`;
  verdictEl.className = 'verdict ' + (pr.result === 'win' ? 'win' : 'loss');
  const role = path[cursor].turn === pr.winner ? 'winner to move (minimising)' : 'loser to move (stalling)';
  dtwlineEl.textContent = `${toMove} to move — ${role} · DTW ${pr.plies} plies to wipeout.`;
}

function renderControls() {
  plylineEl.textContent = `ply ${cursor} / ${rootDtw}` + (analysis.terminal ? ' — wipeout' : '');
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
    li.addEventListener('click', () => { stopPlay(); takeMove(m); });
    moveListEl.appendChild(li);
  });
}

// ---- navigation ------------------------------------------------------------
function takeMove(m) {
  path = path.slice(0, cursor + 1);
  path.push({ board: m.board.slice(), turn: m.turn });
  cursor++;
  lastMove = { from: m.from, to: m.to };
  refresh();
}
function stepForward() {
  if (!analysis || analysis.terminal || analysis.optimalIndex < 0) { stopPlay(); return; }
  takeMove(analysis.moves[analysis.optimalIndex]);
}
function stepBack() {
  if (cursor === 0) return;
  stopPlay(); cursor--; lastMove = null; refresh();
}
function reset() { stopPlay(); cursor = 0; lastMove = null; path = path.slice(0, 1); refresh(); }
function toEnd() {
  stopPlay();
  let guard = rootDtw + 4;
  while (guard-- > 0 && analysis && !analysis.terminal && analysis.optimalIndex >= 0) stepForward();
}
function play() {
  if (playing) { stopPlay(); renderControls(); return; }
  if (analysis && (analysis.terminal || analysis.optimalIndex < 0)) return;
  playing = true; renderControls();
  const tick = () => {
    if (!playing) return;
    stepForward();
    if (playing && analysis && !analysis.terminal && analysis.optimalIndex >= 0) setTimeout(tick, 850);
    else { playing = false; renderControls(); }
  };
  setTimeout(tick, 300);
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

// ---- boot ------------------------------------------------------------------
(async function boot() {
  try {
    classesEl.innerHTML = '<div class="loading">Loading tablebase…</div>';
    T = new MiniTB.Tablebase();
    await T.loadFromUrl('tb.K3.bin');
    classesEl.innerHTML = '<div class="loading">Indexing endgames…</div>';
    // let the loading text paint before the (fast) K3 scan
    await new Promise((r) => setTimeout(r, 0));
    classes = MiniStudy.buildClassIndex(T).filter((c) => c.hardest);
    if (classes.length === 0) { classesEl.innerHTML = '<div class="loading">No decisive endgames found.</div>'; return; }
    renderClassList();
    selectClass(classes[0]);
  } catch (e) {
    classesEl.innerHTML = `<div class="loading">Error: ${e.message}<br><br>` +
      `(If you opened this file directly, the browser blocks loading tb.K3.bin. ` +
      `Serve the folder over http — e.g. <code>python3 -m http.server</code> — or view it on GitHub Pages.)</div>`;
  }
})();
