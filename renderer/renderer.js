'use strict';
/* global Terminal, FitAddon, anvil */

const $ = id => document.getElementById(id);
const doc = $('doc'), cmd = $('cmd'), cmdLabel = $('cmd-label'), live = $('live'), gridEl = $('grid');
const liveNow = $('live-now'), review = $('review');

const blocks = new Map();       // id -> { el, h, meta, out, err, command, errLines }
const history = [];
let historyPos = 0, draft = '';
let running = null;             // the block whose command is still running
let ready = false;
let gridOn = false, gridManual = false;
let where = 'The Textsmith';
let view = 'all';

// Preferences; the saved ones arrive from prefs.json at start.
let prefs = {
  display: { commandStyle: 'heading', theme: 'system', fontSize: 14, font: '', programColours: true },
  speech: { whileRunning: true, readFullUpTo: 8, gridCharacters: true, wordEcho: true },
  editing: { readline: true, pairQuotes: true },
  title: { format: '{prompt} — {shell} — {app}' },
  startup: { directory: '', shell: '' },
  keys: { ...Keys.DEFAULT_KEYS },
  meta: { version: 3 },
};
const MONO = 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';
// Does this key press belong to that action? (see renderer/keys.js)
const is = (e, action) => Keys.matches(Keys.of(e), prefs.keys[action]);

// ---------- the grid: a classic terminal, only for full-screen programs ----------

const term = new Terminal({
  cursorBlink: false, fontSize: 14,
  fontFamily: 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace',
  theme: { background: '#171716', foreground: '#ecebe6' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(gridEl);
// Only while a program owns the grid. Otherwise vim's focus reporting would
// leak a stray escape sequence into the shell when the grid closes.
let lastKey = '';
term.onData(d => { if (gridOn) { lastKey = d; anvil.send('write', d); } });
// The Textsmith's own keys inside a full-screen program. Everything else is the program's.
term.attachCustomKeyEventHandler(e => {
  const actions = {
    screenPage: openScreen,
    grid: () => anvil.send('grid', false),
    readLine: () => sayNow(lineText(cursorRow()) || 'blank'),
    readStatus: () => sayNow(lineText(bottomRow()) || 'blank'),
  };
  const name = Object.keys(actions).find(a => is(e, a));
  if (!name) return true;
  const act = actions[name];
  if (e.type === 'keydown') act();
  e.preventDefault();
  e.stopPropagation();                    // or the page would see Alt+R too and close the review
  return false;
});

// ---------- speaking the grid ----------
// A grid has no text for a screen reader to find, so The Textsmith reads it out itself.

// Speech goes through live regions. They empty themselves after a few
// seconds, so an old message is not found later when reading the page.
function speak(el, text) {
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  });
}
function sayNow(text) { speak(liveNow, text.replace(/\s{2,}/g, ', ')); }
const buf = () => term.buffer.active;
const cursorRow = () => buf().baseY + buf().cursorY;
const bottomRow = () => buf().baseY + term.rows - 1;
function lineText(y) { const l = buf().getLine(y); return l ? l.translateToString(true).trim() : ''; }
// The bottom line without its right-hand part, where vim shows half-typed
// commands and a ruler that changes on every move.
function statusText() {
  const l = buf().getLine(bottomRow());
  return l ? l.translateToString(true, 0, Math.max(0, term.cols - 30)).trim() : '';
}
// How many characters differ between two versions of a line.
function changedSpan(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return Math.max(a.length, b.length) - p - s;
}

// Rows drawn in a style of their own: the selected message in neomutt, the
// selected process in htop, a menu's current item. Lists often leave the
// cursor parked elsewhere, so this is how The Textsmith knows what is selected.
function highlightedRows() {
  const b = buf(), cell = b.getNullCell(), keys = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.baseY + y);
    const count = new Map();
    let n = 0;
    for (let x = 0; line && x < term.cols; x++) {
      line.getCell(x, cell);
      const k = cell.isInverse() ? 'inverse' : cell.isBgDefault() ? 'plain' : `${cell.getBgColorMode()}:${cell.getBgColor()}`;
      if (k === 'plain' && !cell.getChars().trim()) continue;      // empty space does not count
      count.set(k, (count.get(k) || 0) + 1); n++;
    }
    let best = 'empty', bestN = 0;
    for (const [k, c] of count) if (c > bestN) { best = k; bestN = c; }
    keys.push(n === 0 ? 'empty' : bestN * 2 >= n ? best : 'mixed');
  }
  const freq = new Map();
  for (const k of keys) if (k !== 'empty' && k !== 'mixed') freq.set(k, (freq.get(k) || 0) + 1);
  let normal = null, normalN = 0;
  for (const [k, c] of freq) if (c > normalN) { normal = k; normalN = c; }
  const rows = new Map();
  keys.forEach((k, y) => { if (k !== 'empty' && k !== 'mixed' && k !== normal) rows.set(y, lineText(b.baseY + y)); });
  return rows;
}

let spoken = null, speakTimer = null, lastSelected = '';
const snapshot = () => ({ row: cursorRow(), col: buf().cursorX, text: lineText(cursorRow()), status: statusText(), hl: highlightedRows() });

// Characters a speech synthesiser may skip or mumble get a name.
const CHAR_NAMES = { ' ': 'space', '.': 'dot', ',': 'comma', ';': 'semicolon', ':': 'colon', '!': 'bang',
  '?': 'question', "'": 'quote', '"': 'double quote', '(': 'left paren', ')': 'right paren', '[': 'left bracket',
  ']': 'right bracket', '{': 'left brace', '}': 'right brace', '<': 'less', '>': 'greater', '-': 'dash',
  '_': 'underscore', '/': 'slash', '\\': 'backslash', '|': 'bar', '*': 'star', '&': 'and', '#': 'hash',
  '$': 'dollar', '%': 'percent', '^': 'caret', '~': 'tilde', '`': 'backtick', '=': 'equals', '+': 'plus', '@': 'at' };
function charAt(row, col) {
  const cell = buf().getLine(row)?.getCell(col);
  const ch = cell ? cell.getChars() : '';
  if (!ch) return 'blank';
  if (CHAR_NAMES[ch]) return CHAR_NAMES[ch];
  return /\p{Lu}/u.test(ch) ? `cap ${ch}` : ch;
}
// The word under the cursor, for moves of more than one character.
function wordAt(row, col) {
  const line = buf().getLine(row)?.translateToString(false) ?? '';
  if (!line[col] || !line[col].trim()) return charAt(row, col);
  let a = col, b = col;
  while (a > 0 && line[a - 1].trim()) a--;
  while (b < line.length && line[b].trim()) b++;
  return line.slice(a, b);
}
// What is selected right now: the highlighted row under the cursor, else the
// last one read out, else a highlighted row that is not a top or bottom bar.
function currentSelection(s) {
  const y = buf().cursorY;
  if (s.hl.get(y)) return s.hl.get(y);
  const hl = [...s.hl.entries()].filter(([, t]) => t);
  if (hl.some(([, t]) => t === lastSelected)) return lastSelected;
  const inner = hl.find(([r]) => r > 0 && r < term.rows - 2);
  return (inner || hl[0] || [])[1] || s.text;
}
let reentry = false;                      // back in a program that was already on screen
function settle() {
  speakTimer = null;
  if (!gridOn || reading || !review.hidden) return;
  const now = snapshot();
  const was = spoken;
  spoken = now;
  if (!was) {                             // first screen: "Vim, active" is enough...
    if (reentry) sayNow(currentSelection(now) || 'blank');   // ...unless we are coming back
    return;
  }
  const parts = [];
  // A row that has just become highlighted is the new selection.
  let selected = null;
  for (const [y, t] of now.hl) if (!was.hl.has(y) && t) { selected = t; break; }
  if (selected !== null) { parts.push(selected); lastSelected = selected; }
  // Otherwise a new line under the cursor is read out. Small edits on the same
  // line are typing, which the screen reader's own key echo already covers.
  else if (now.row !== was.row || changedSpan(was.text, now.text) > 3) parts.push(now.text || 'blank');
  // Same line, same text, cursor moved: read the character now under the
  // cursor after a one-character move (arrows, h, l), the word after a jump
  // (w, b, Ctrl+arrows, searches).
  else if (now.text === was.text && now.col !== was.col && lastKey !== ' ' && prefs.speech.gridCharacters) {
    const charMove = /^(\x1b[\[O][CD]|[hl]|\x7f|\x08)$/.test(lastKey);
    parts.push(charMove ? charAt(now.row, now.col) : wordAt(now.row, now.col));
  }
  else if (lastKey === ' ' && now.row === was.row && prefs.speech.wordEcho) {
    // A space ends a word: say the word, as a screen reader's word echo would.
    const before = (buf().getLine(now.row)?.translateToString(false) ?? '').slice(0, buf().cursorX);
    const word = before.trimEnd().split(/\s+/).pop();
    if (word && /\s$/.test(before)) parts.push(word);
  }
  // The selection stayed on its row but shows something else (a list scrolled).
  if (!parts.length) {
    let best = null, bestSpan = 3;
    for (const [y, t] of now.hl) {
      const span = was.hl.has(y) ? changedSpan(was.hl.get(y), t) : 0;
      if (span > bestSpan) { best = t; bestSpan = span; }
    }
    if (best) { parts.push(best); lastSelected = best; }
  }
  lastKey = '';
  if (now.status !== was.status && now.status && now.row !== bottomRow()) parts.push(now.status);
  if (parts.length) sayNow(parts.join('. '));
}
term.onWriteParsed(() => { if (gridOn && !speakTimer) speakTimer = setTimeout(settle, 80); });

// ---------- F2: step out of a full-screen program to read, and back ----------
// The program keeps running in the background while the page is read as a
// document; F2 again hands every key back to it.
let reading = false;
function enterReading() {
  if (!gridOn) return;
  reading = true;
  gridEl.hidden = true;
  const hs = running ? running.el.querySelectorAll('h2, h3') : [];
  const target = hs.length ? hs[hs.length - 1] : cmd;
  target.focus();
  target.scrollIntoView?.({ block: 'start' });
  setTitle();
  announce(`Reading. ${gridName} waits in the background; F2 goes back to it.`);
}
function leaveReading() {
  reading = false;
  gridEl.hidden = false;
  term.focus();
  spoken = snapshot();
  setTitle();
  sayNow(`${gridName}. ${currentSelection(spoken) || ''}`);
}

// ---------- the screen page (F2 or Alt+R) ----------
// A full-screen program's screen as a web page: its list (neomutt's messages,
// htop's processes, a menu) becomes a list of buttons, everything else plain
// text. Activating an item moves the program's selection there and presses
// Enter; Shift+Enter only moves the selection. The Keys field sends keys.

let screenSig = '', expectChange = false;

function rowStyles() {
  const b = buf(), cell = b.getNullCell(), keys = [], texts = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.baseY + y);
    texts.push(line ? line.translateToString(true).trimEnd() : '');
    const count = new Map();
    let n = 0;
    for (let x = 0; line && x < term.cols; x++) {
      line.getCell(x, cell);
      const k = cell.isInverse() ? 'inverse' : cell.isBgDefault() ? 'plain' : `${cell.getBgColorMode()}:${cell.getBgColor()}`;
      if (k === 'plain' && !cell.getChars().trim()) continue;
      count.set(k, (count.get(k) || 0) + 1); n++;
    }
    let best = 'empty', bestN = 0;
    for (const [k, c] of count) if (c > bestN) { best = k; bestN = c; }
    keys.push(n === 0 ? 'empty' : bestN * 2 >= n ? best : 'mixed');
  }
  const freq = new Map();
  for (const k of keys) if (k !== 'empty' && k !== 'mixed') freq.set(k, (freq.get(k) || 0) + 1);
  let normal = null, normalN = 0;
  for (const [k, c] of freq) if (c > normalN) { normal = k; normalN = c; }
  return { keys, texts, normal };
}

// Where the list is: around the selected row, up to an empty row or a row
// styled like the selection (a title or status bar).
function analyseScreen() {
  const { keys, texts, normal } = rowStyles();
  const hl = keys.map((k, y) => k !== 'empty' && k !== 'mixed' && k !== normal && texts[y].trim() ? y : -1).filter(y => y >= 0);
  // Title and status bars sit on the first row and the last two; a selection
  // lives in between.
  const inner = hl.filter(y => y > 0 && y < term.rows - 2);
  const cy = buf().cursorY;
  const sel = inner.includes(cy) ? cy : inner[0];
  if (sel === undefined) return { texts, list: null };
  // An empty row, or a row with a background of its own (a title or status bar).
  const isEdge = y => !texts[y].trim() || (keys[y] !== normal && keys[y] !== 'mixed');
  let top = sel, bottom = sel;
  while (top > 0 && !isEdge(top - 1)) top--;
  while (bottom < term.rows - 1 && !isEdge(bottom + 1)) bottom++;
  if (bottom - top < 1) return { texts, list: null };
  return { texts, list: { top, bottom, sel } };
}

function textBlock(lines, tag) {
  const el = document.createElement(tag);
  const out = [];
  let prev = null, n = 0;
  const flush = () => { if (prev !== null) out.push(n > 2 && prev ? `${prev}   (${n} lines the same)` : Array(n).fill(prev).join('\n')); };
  for (const l of lines) { if (l === prev) { n++; continue; } flush(); prev = l; n = 1; }
  flush();
  el.textContent = out.join('\n').replace(/^\n+|\n+$/g, '');
  return el.textContent ? el : null;
}

function renderScreen(force) {
  const a = analyseScreen();
  const sig = a.texts.join('\n') + '|' + (a.list ? a.list.sel : '');
  if (sig === screenSig && !force) return;
  const body = $('review-body');
  // While the person is reading inside the page, only redraw when they asked
  // for something (an item, keys) or press F5: a ticking clock must not move them.
  if (!force && !expectChange && body.contains(document.activeElement)) return;
  screenSig = sig;
  const focusedItem = document.activeElement?.dataset?.y;
  body.textContent = '';
  const add = el => { if (el) body.append(el); };
  if (a.list) {
    const { top, bottom, sel } = a.list;
    for (const t of a.texts.slice(0, top)) if (t.trim()) { const p = document.createElement('p'); p.textContent = t.trim(); body.append(p); }
    const ul = document.createElement('ul');
    ul.setAttribute('aria-label', `${gridName} list, ${bottom - top + 1} items`);
    for (let y = top; y <= bottom; y++) {
      const li = document.createElement('li'), btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.y = y;
      btn.textContent = a.texts[y].trim().replace(/\s{2,}/g, '  ');
      if (y === sel) btn.setAttribute('aria-current', 'true');
      li.append(btn); ul.append(li);
    }
    body.append(ul);
    for (const t of a.texts.slice(bottom + 1)) if (t.trim()) { const p = document.createElement('p'); p.textContent = t.trim(); body.append(p); }
    $('review-note').textContent = `Enter opens an item, Shift+Enter only selects it. F2 or Escape goes back to ${gridName}.`;
  } else {
    add(textBlock(a.texts, 'pre'));
    $('review-note').textContent = `F2 or Escape goes back to ${gridName}. F5 refreshes this page.`;
  }
  if (expectChange || focusedItem !== undefined) {
    expectChange = false;
    const target = (a.list && body.querySelector(`button[data-y="${a.list.sel}"]`)) || $('review-title');
    if (document.activeElement !== $('keys')) target.focus();
  }
}

// While the screen page is up, nothing behind it can take focus.
function behindInert(on) { for (const id of ['bar', 'doc', 'prompt', 'grid', 'matches']) $(id).inert = on; }

function openScreen() {
  behindInert(true);
  $('review-title').textContent = `${gridName} screen`;
  $('keys-label').textContent = `Keys for ${gridName}`;
  review.hidden = false;
  screenSig = '';
  renderScreen(true);
  setTimeout(() => {                                   // after the grid has finished with the key
    const cur = $('review-body').querySelector('button[aria-current]');
    (cur || $('review-title')).focus();
  }, 0);
}

function sendToProgram(seq) {
  expectChange = true;
  anvil.send('write', seq);
}

function activateItem(y, open) {
  const a = analyseScreen();
  if (!a.list) return;
  const app = term.modes.applicationCursorKeysMode;
  const d = y - a.list.sel;
  const step = d > 0 ? (app ? '\x1bOB' : '\x1b[B') : (app ? '\x1bOA' : '\x1b[A');
  sendToProgram(step.repeat(Math.abs(d)) + (open ? '\r' : ''));
}

$('review-body').addEventListener('click', e => {
  const btn = e.target.closest('button[data-y]');
  if (btn) activateItem(+btn.dataset.y, !e.shiftKey);
});
$('review-body').addEventListener('keydown', e => {
  const btn = e.target.closest('button[data-y]');
  if (btn && e.key === 'Enter' && e.shiftKey) { e.preventDefault(); activateItem(+btn.dataset.y, false); }
});

// The Keys field: text goes to the program as typed, without Enter. An empty
// field sends Enter. Named keys go in angle brackets: <esc> <enter> <tab>
// <up> <down> <left> <right> <pgup> <pgdn> <home> <end> <space> <bs>.
const NAMED_KEYS = { esc: '\x1b', escape: '\x1b', enter: '\r', tab: '\t', space: ' ', bs: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', pgup: '\x1b[5~', pgdn: '\x1b[6~', home: '\x1b[H', end: '\x1b[F' };
$('keys-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('keys').value;
  const seq = v ? v.replace(/<(\w+)>/g, (m, k) => NAMED_KEYS[k.toLowerCase()] ?? m) : '\r';
  $('keys').value = '';
  sendToProgram(seq);
  announce('Sent');
});

let screenTimer = null;
term.onWriteParsed(() => {
  if (review.hidden) return;
  clearTimeout(screenTimer);
  screenTimer = setTimeout(() => renderScreen(false), 150);
});

function closeReview(refocus) {
  if (review.hidden) return;
  review.hidden = true;
  behindInert(false);
  if (refocus) {
    term.focus();
    spoken = snapshot();
    sayNow(`${gridName}. ${currentSelection(spoken) || ''}`);
  }
}

function measure() {
  fit.fit();
  return { cols: term.cols, rows: term.rows };
}
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => anvil.send('resize', measure()), 100);
});

// ---------- small helpers ----------

function announce(text) { speak(live, text); }

let shellName = '';
function setTitle() {
  if (gridOn && reading) document.title = `${gridName}, in the background — ${where}`;
  else if (gridOn) document.title = `${gridName}, active`;
  else if (running) document.title = `${running.command} — running — ${where}`;
  else document.title = where === 'The Textsmith' ? where
    : prefs.title.format.replace(/\{prompt\}/g, where).replace(/\{shell\}/g, shellName || 'shell').replace(/\{app\}/g, 'The Textsmith');
  $('where').textContent = (tabInfo && tabInfo.count > 1 ? `Tab ${tabInfo.index + 1} of ${tabInfo.count} · ` : '') + where;
}
let gridName = '';

function nearBottom() { return doc.scrollHeight - doc.scrollTop - doc.clientHeight < 80; }
function scrollDown() { doc.scrollTop = doc.scrollHeight; }

function setView(v) {
  view = v;
  document.body.className = 'view-' + v;
  for (const b of document.querySelectorAll('#bar button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  const names = { list: 'Command list', all: 'Output', err: 'Errors only' };
  let msg = names[v];
  if (v === 'err') {
    const n = document.querySelectorAll('.block.has-err').length;
    msg += n ? `, ${n} command${n === 1 ? '' : 's'} with errors` : ', no errors';
  }
  announce(msg);
  scrollDown();
}

function headings() { return [...doc.querySelectorAll('.block h2, .block h3')].filter(h => h.offsetParent !== null); }

function moveHeading(delta) {
  const hs = headings();
  if (!hs.length) return;
  let i = hs.indexOf(document.activeElement);
  if (i === -1) i = delta < 0 ? hs.length : -1;
  const target = hs[Math.max(0, Math.min(hs.length - 1, i + delta))];
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

// ---------- output rendering ----------

const LINK = /(https?:\/\/[^\s<>"')\]]+)|\b([A-Za-z0-9_][A-Za-z0-9_.+:-]*)\(([1-9][a-z]{0,3})\)/g;

function runNode(run, text) {
  if (run.f === undefined && !run.b && !run.u) return document.createTextNode(text);
  const s = document.createElement('span');
  if (typeof run.f === 'number') s.classList.add('f' + run.f);
  else if (run.f) s.style.color = run.f;
  if (run.b) s.classList.add('b');
  if (run.u) s.classList.add('u');
  s.textContent = text;
  return s;
}

// One screen row. Links are found on the row's whole text, so "ls(1)" is still
// one link when "ls" is bold and "(1)" is not.
function rowNode(row, first) {
  const el = document.createElement('span');
  el.className = 'row';
  if (row.w) el.dataset.w = '1';
  if (!first && !row.w) {                   // its own element, so a row right after a sub-heading can drop it
    const nl = document.createElement('span');
    nl.className = 'nl'; nl.textContent = '\n';
    el.append(nl);
  }
  const text = row.r.map(r => r.t).join('');
  const links = [];
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(text))) {
    const a = document.createElement('a');
    a.href = '#';
    if (m[1]) { a.dataset.url = m[1].replace(/[.,;:]+$/, ''); }
    else { a.dataset.man = `${m[3]} ${m[2]}`; a.title = `Open the manual page ${m[2]}(${m[3]})`; }
    links.push({ s: m.index, e: m.index + (m[1] ? a.dataset.url.length : m[0].length), a, used: false });
  }
  let pos = 0, li = 0;
  for (const run of row.r) {
    let t = run.t;
    while (t) {
      while (li < links.length && links[li].e <= pos) li++;
      const l = links[li];
      let take, parent = el;
      if (l && pos >= l.s) { take = Math.min(t.length, l.e - pos); parent = l.a; if (!l.used) { el.append(l.a); l.used = true; } }
      else take = l ? Math.min(t.length, l.s - pos) : t.length;
      parent.append(runNode(run, t.slice(0, take)));
      t = t.slice(take); pos += take;
    }
  }
  return el;
}

// A command's heading: the command alone, or prompt, $ and command as a
// traditional terminal shows it.
function headingText(b) {
  return prefs.display.commandStyle === 'line' && b.prompt !== 'The Textsmith' ? `${b.prompt}$ ${b.command}` : b.command;
}

function addBlock({ id, command }) {
  $('empty')?.remove();
  const el = document.createElement('section');
  el.className = 'block running';
  const h = document.createElement('h2');
  h.id = 'cmd-' + id; h.tabIndex = -1;
  el.setAttribute('aria-labelledby', h.id);
  const meta = document.createElement('p');
  meta.className = 'meta'; meta.textContent = 'running';
  const out = document.createElement('pre'); out.className = 'out';
  const err = document.createElement('pre'); err.className = 'err';
  el.append(h, meta, out, err);
  doc.append(el);
  const b = { id, el, h, meta, out, err, command, prompt: where, spoken: '', speakTimer: null, rowEls: [], subs: [], pending: [], dropAt: null };
  h.textContent = headingText(b);
  blocks.set(id, b);
  running = b;
  cmdLabel.textContent = 'Input to ' + command.split(/\s+/)[0];
  setTitle();
  scrollDown();
}

// What has appeared in a block since it was last read out. This is what makes
// programs with their own prompt (sqlite3, python) talk back after each line.
let lastInput = '';
// The block's output as text, without the sub-headings and the lines they replace.
const blockText = b => b.rowEls.filter(r => !r.classList.contains('echo')).map(r => r.textContent).join('');

// ---------- sub-headings: input typed into a running program ----------
// A line sent to psql, python or any program with its own prompt becomes a
// heading 3 inside the command's block, and what the program answers follows
// it. The heading replaces the program's own "prompt + what you typed" line.
// It is only made once the program has echoed the line back, so a password,
// which is never echoed, never becomes a heading.

function logicalLine(b, i) {                // row i plus the rows it wraps onto
  let end = i, text = b.rowEls[i].textContent.replace(/^\n/, '');
  while (b.rowEls[end + 1]?.dataset.w) text += b.rowEls[++end].textContent;
  return { end, text: text.trimEnd() };
}

function layoutSubs(b) {
  // Has the program echoed a line we are waiting for?
  b.pending = b.pending.filter(p => {
    for (let i = Math.max(0, p.n - 1); i < Math.min(b.rowEls.length, p.n + 3); i++) {
      if (b.rowEls[i].dataset.w) continue;
      const line = logicalLine(b, i);
      if (!line.text.endsWith(p.input) || !line.text.trim()) continue;
      const h = document.createElement('h3');
      h.tabIndex = -1;
      // After Tab the program finished the line itself, so the whole line is the heading.
      h.textContent = p.full ? line.text.trim() : p.input;
      b.subs.push({ at: i, end: line.end, h });
      return false;
    }
    return b.rowEls.length <= p.n + 4;      // still waiting, unless output has moved on
  });
  // Put every sub-heading in front of its row; hide the echoed line itself.
  b.subs.sort((x, y) => x.at - y.at);
  b.subs = b.subs.filter(s => {
    if (s.at >= b.rowEls.length) { s.h.remove(); return false; }     // screen was cleared
    if (s.h.nextSibling !== b.rowEls[s.at]) b.out.insertBefore(s.h, b.rowEls[s.at]);
    for (let i = s.at; i <= s.end && i < b.rowEls.length; i++) b.rowEls[i].classList.add('echo');
    b.rowEls[s.end + 1]?.classList.add('lead');
    return true;
  });
}

// A full-screen program has stepped aside, printed something and is waiting:
// neomutt showing a message through an external pager, vim after ":!make".
// What it printed gets a heading 3 of its own, named after its first line,
// and focus moves there so it can be read like any other text.
function pauseHeading(b) {
  let i = b.dropAt;
  b.dropAt = null;
  while (i < b.rowEls.length && !b.rowEls[i].textContent.trim()) i++;
  if (i >= b.rowEls.length) return false;
  const line = logicalLine(b, i);
  const title = line.text.replace(/\s+/g, ' ').replace(/^[-\s]+|[-\s]+$/g, '') || gridName;
  const h = document.createElement('h3');
  h.tabIndex = -1; h.textContent = title;
  b.subs.push({ at: i, end: line.end, h });
  layoutSubs(b);
  const fresh = b.rowEls.slice(line.end + 1).map(r => r.textContent).join('').trim().split('\n');
  b.spoken = blockText(b);
  b.pausedDrop = true;                      // the next thing it prints gets a heading too
  // The last line is usually the program saying how to carry on.
  announce(`${title}. ${fresh.length} line${fresh.length === 1 ? '' : 's'}. ${fresh[fresh.length - 1]}`);
  h.focus();
  h.scrollIntoView({ block: 'start' });
  return true;
}

function newOutput(b) {
  const full = blockText(b);
  let delta;
  if (full.startsWith(b.spoken)) delta = full.slice(b.spoken.length);
  else {                                    // earlier lines were rewritten
    const a = b.spoken.split('\n'), n = full.split('\n');
    let i = 0;
    while (i < a.length && i < n.length && a[i] === n[i]) i++;
    delta = n.slice(i).join('\n');
  }
  b.spoken = full;
  delta = delta.trim();
  if (lastInput && delta.startsWith(lastInput)) delta = delta.slice(lastInput.length).trim();   // our own echo
  lastInput = '';
  const lines = delta.split('\n');
  return lines.length > 12 ? `${lines.length} new lines, ending: ${lines.slice(-2).join('. ')}` : delta;
}

function onOutput({ id, start, rows, cursor }) {
  const b = blocks.get(id);
  if (!b) return;
  b.lastOutputAt = Date.now();
  b.cursor = cursor;
  const stick = nearBottom();
  for (const old of b.rowEls.splice(start)) old.remove();
  rows.forEach((row, i) => {
    const idx = start + i, el = rowNode(row, idx === 0);
    // Rows are re-sent from the top of the screen, so one may belong before
    // a sub-heading that is already in place.
    const next = b.subs.find(s => s.at > idx);
    b.out.insertBefore(el, next ? next.h : null);
    b.rowEls.push(el);
  });
  layoutSubs(b);
  if (stick) scrollDown();
  if (b === running) {                      // "Password:" at the end of the output, as over ssh
    const last = b.rowEls[b.rowEls.length - 1]?.textContent.replace(/^\n/, '') ?? '';
    textSecret = /(password|passphrase|\bpin\b)[^:\n]{0,40}:\s*$/i.test(last);
    updateSecret();
    setPager(PAGER_PROMPT.test(last.trim()) ? 'pager' : /\[nyae\]\?\s*$/.test(last) ? 'nyae' : false);
  }
  if (b === running && !b.quiet) {          // read it out once the output pauses
    clearTimeout(b.speakTimer);
    b.speakTimer = setTimeout(() => {
      if (b.dropAt !== null && !gridOn && pauseHeading(b)) return;
      const d = newOutput(b);
      if (d && prefs.speech.whileRunning) announce(d);
    }, 400);
  }
}

function onStderr({ id, text }) {
  const b = blocks.get(id);
  if (!b) return;
  const clean = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, '').replace(/\r\n?/g, '\n');
  if (!clean) return;
  b.err.append(clean);
  b.el.classList.add('has-err');
}

function onEnd({ id, exitCode, lines, ms }) {
  const b = blocks.get(id);
  if (!b) return;
  b.el.classList.remove('running');
  b.el.classList.add(exitCode === 0 ? 'ok' : 'fail');
  const took = ms < 1000 ? '' : `, ${(ms / 1000).toFixed(1)} seconds`;
  const count = `${lines} line${lines === 1 ? '' : 's'}`;
  const status = exitCode === 0 ? 'done' : `failed, exit code ${exitCode}`;
  b.meta.textContent = `${status}, ${count}${took}`;
  if (running === b) { running = null; cmdLabel.textContent = 'Command'; sessionSecret = textSecret = false; updateSecret(); setPager(false); }
  setTitle();
  clearTimeout(b.speakTimer);
  if (b.spoken) {                           // already read out along the way
    const rest = newOutput(b);
    announce([rest, exitCode === 0 ? `${b.command.split(/\s+/)[0]} finished` : `Exit code ${exitCode}`].filter(Boolean).join('. '));
    return;
  }
  // Short output is read out in full; long output only as a summary.
  const text = blockText(b).trim();
  const upTo = prefs.speech.readFullUpTo;
  if (lines > 0 && lines <= upTo && text.length < upTo * 80) announce(exitCode === 0 ? text : `${text}. Exit code ${exitCode}`);
  else announce(`${b.command}: ${status}, ${count}`);
}

// ---------- events from the shell ----------

anvil.on((name, p) => {
  switch (name) {
    case 'ready': ready = true; break;
    case 'completions': onCompletions(p); break;
    case 'cwd': {
      const path = p.path === p.home ? '~' : p.path.startsWith(p.home + '/') ? '~' + p.path.slice(p.home.length) : p.path;
      // Your own prompt if you have one, else user@host: directory.
      where = p.prompt || `${p.user}@${p.host}: ${path}`;
      shellName = p.shell || '';
      setTitle();
      if (tabAnnounce) { tabAnnounce = false; announce(`Tab ${tabInfo.index + 1} of ${tabInfo.count}. ${where}`); }
      break;
    }
    case 'block-start': ready = false; addBlock(p); break;
    case 'block-output': onOutput(p); break;
    case 'block-stderr': onStderr(p); break;
    case 'block-end': onEnd(p); break;
    case 'secret': sessionSecret = p.on; updateSecret(); break;
    case 'bookmarks': bookmarks = p; break;
    case 'prefs': prefs = p; applyPrefs(); break;
    case 'tabs':
      tabInfo = p;
      setTitle();
      // A new tab's shell has not said where it is yet: announce once it has.
      if (p.announce) { if (where === 'The Textsmith') tabAnnounce = true; else announce(`Tab ${p.index + 1} of ${p.count}. ${where}`); }
      break;
    case 'grid-enter':
      gridOn = true;
      reading = false;
      gridName = p.name.charAt(0).toUpperCase() + p.name.slice(1);
      term.reset();
      // Carry over the key modes the program set before taking the screen.
      term.write((p.appCursor ? '\x1b[?1h' : '') + (p.appKeypad ? '\x1b=' : ''));
      spoken = null;
      reentry = !!(running && running.gridSeen);
      if (running) running.gridSeen = true;
      if (!reentry) lastSelected = '';
      if (running) { running.dropAt = null; running.pausedDrop = false; }
      gridEl.hidden = false;
      anvil.send('resize', measure());
      term.focus();
      setTitle();
      announce(`${gridName}, active`);
      break;
    case 'grid-data': term.write(p); break;
    case 'grid-exit':
      gridOn = false; gridManual = false; reading = false;
      closeReview(false);
      gridEl.hidden = true;
      setTitle();
      cmd.focus();
      // If the program is only stepping aside, what it prints next gets a heading.
      if (running) running.dropAt = running.rowEls.length;
      break;
  }
});

// ---------- keyboard ----------

// Tab keys. The main process catches them first from the real keyboard, even
// inside vim; this is the same thing for keys that reach the page.
window.addEventListener('keydown', e => {
  if (capturingKeys) return;                // the preferences page is recording a key
  const act = is(e, 'newTab') ? 'new-tab' : is(e, 'closeTab') ? 'tab-close'
    : is(e, 'nextTab') ? 'tab-next' : is(e, 'prevTab') ? 'tab-prev' : null;
  if (!act) return;
  e.preventDefault(); e.stopPropagation();
  anvil.send(act);
}, true);

document.addEventListener('keydown', e => {
  if (!$('copy').hidden || !$('finder').hidden || !$('prefs').hidden) return;   // these handle their own keys
  if (!review.hidden) {                     // the program's screen as a page
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (e.key === 'Escape' || is(e, 'screenPage')) { e.preventDefault(); closeReview(true); }
    else if (plain && e.code === 'F5') { e.preventDefault(); renderScreen(true); announce('Refreshed'); }
    else if (is(e, 'copy')) { e.preventDefault(); openCopy(); }
    else if (is(e, 'viewAll') || is(e, 'viewList')) {     // the session document instead
      e.preventDefault(); closeReview(false); enterReading();
    }
    return;
  }
  if (is(e, 'preferences') && !(gridOn && !reading)) { e.preventDefault(); openPrefs(); return; }
  if (is(e, 'screenPage')) {
    e.preventDefault();
    if (reading) leaveReading();
    else if (running && running.pausedDrop) { anvil.send('write', '\r'); }   // let the program carry on
    else announce('No full-screen program is running');
    return;
  }
  if (gridOn && !reading) return;           // the full-screen program gets every key
  const views = { viewList: 'list', viewAll: 'all', viewErrors: 'err' };
  const v = Object.keys(views).find(a => is(e, a));
  if (v) { e.preventDefault(); setView(views[v]); if (v === 'viewList') cmd.focus(); return; }
  if (is(e, 'prevHeading')) { e.preventDefault(); moveHeading(-1); return; }
  if (is(e, 'nextHeading')) { e.preventDefault(); moveHeading(1); return; }
  if (is(e, 'grid') && running) { e.preventDefault(); gridManual = true; anvil.send('grid', true); return; }
  if (is(e, 'copy')) { e.preventDefault(); openCopy(); return; }
  if (is(e, 'bookmarks')) { e.preventDefault(); openFinder('bookmarks'); return; }
  if (is(e, 'bookmarkMode') && document.activeElement !== cmd) {
    e.preventDefault(); enterBookmarkMode(); return;
  }
  if (e.key === 'Escape') { e.preventDefault(); cmd.focus(); scrollDown(); return; }
  // Enter on a command in the list opens its output.
  if (e.key === 'Enter' && /^H[23]$/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    const h = document.activeElement;
    if (view !== 'all') setView('all');
    h.focus(); h.scrollIntoView({ block: 'start' });
  }
});

// ---------- tab completion ----------
// Tab never leaves the command box while there is something to complete.
// One match is filled in. Several: the common part is filled in and the
// matches are read out; Tab again steps through them, Shift+Tab steps back.

let comp = null;                // { start, list, i, value } while stepping through matches
let pendingComp = null;
const shellEscape = s => s.includes('\\') ? s : s.replace(/([\s'"\\$`&|;<>()*?!#\[\]{}])/g, '\\$1');
const cycling = () => comp && comp.value === cmd.value;

// The words of the line up to the caret, as typed (escapes kept).
// The shell words of the command being typed, up to the caret. A command
// starts after ; & | ( ) ` or a newline outside quotes, or a { or } on its
// own; keywords such as do, then and if, and VAR=value in front, are
// skipped. So "for s in a b; do restic -r <Tab>" completes as restic would.
const LEAD_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time', '{']);
function wordsAtCaret() {
  const full = cmd.value.slice(0, cmd.selectionStart);
  let words = [], starts = [], word = '', start = 0, inWord = false, q = null;
  const end = () => { if (inWord) { words.push(word); starts.push(start); } word = ''; inWord = false; };
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (q) {                                  // inside quotes: everything belongs to the word
      word += ch;
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < full.length) word += full[++i];
      continue;
    }
    if (ch === '\\' && i + 1 < full.length) { if (!inWord) start = i; word += ch + full[++i]; inWord = true; continue; }
    if (ch === '"' || ch === "'") { if (!inWord) start = i; q = ch; word += ch; inWord = true; continue; }
    if (';&|()`\n'.includes(ch) || ((ch === '{' || ch === '}') && !inWord)) { end(); words = []; starts = []; continue; }
    if (/\s/.test(ch)) { end(); continue; }
    if (!inWord) start = i;
    word += ch; inWord = true;
  }
  if (!inWord) start = full.length;
  words.push(word); starts.push(start);
  while (words.length > 1 && (LEAD_WORDS.has(words[0]) || /^[A-Za-z_]\w*=/.test(words[0]))) { words.shift(); starts.shift(); }
  return { line: full.slice(starts[0]), words, cword: words.length - 1, start, word: word.replace(/\\(.)/g, '$1') };
}
function putWord(start, text) {
  cmd.value = cmd.value.slice(0, start) + text + cmd.value.slice(cmd.selectionStart);
  cmd.selectionStart = cmd.selectionEnd = start + text.length;
}
function onTab(back) {
  if (cycling()) {
    const n = comp.list.length;
    comp.i = comp.i === -1 ? (back ? n - 1 : 0) : (comp.i + (back ? -1 : 1) + n) % n;
    const m = comp.list[comp.i];
    putWord(comp.start, comp.raw ? m : shellEscape(m));
    comp.value = cmd.value;
    sayNow(`${m}, ${comp.i + 1} of ${n}`);
    return;
  }
  pendingComp = wordsAtCaret();
  const { line, words, cword } = pendingComp;
  anvil.send('complete', { line, words, cword });
}
function onCompletions({ list, busy }) {
  const w = pendingComp;
  pendingComp = null;
  if (!w) return;
  comp = null;
  $('matches').textContent = '';
  if (busy) { sayNow('The shell is busy'); return; }
  if (!list.length) { sayNow('No matches'); return; }
  // Variable names ($HOME, "$REPO") go in as they are; anything else is escaped.
  const raw = w.words[w.cword];
  const isVar = raw.includes('$');
  const esc = s => (isVar ? s : shellEscape(s));
  if (list.length === 1) {
    let after = /[\/=:]$/.test(list[0]) ? '' : ' ';
    const oq = isVar && openQuote(raw);
    if (oq) after = cmd.value[cmd.selectionStart] === oq ? '' : oq + ' ';   // close "$VAR
    putWord(w.start, esc(list[0]) + after);
    sayNow(list[0]);
    return;
  }
  let common = list[0];
  for (const m of list) { let i = 0; while (i < common.length && common[i] === m[i]) i++; common = common.slice(0, i); }
  if (common.length > w.word.length) putWord(w.start, esc(common));
  comp = { start: w.start, list, i: -1, value: cmd.value, raw: isVar };
  $('matches').textContent = list.slice(0, 60).join('   ') + (list.length > 60 ? '   …' : '');
  sayNow(`${list.length} matches: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', and more' : ''}. Tab for the next one.`);
}
cmd.addEventListener('input', () => { $('matches').textContent = ''; });

// ---------- Tab inside a running program (ssh, psql, python) ----------
// The program completes the line itself, so it is handed what is typed so far
// plus Tab. The completed line is then read back off the screen into the box,
// and the program's own copy is cleared with Ctrl+U, so the box stays the one
// place the line lives, exactly as with local completion. If nothing was
// added, a second Tab asks the program for its list of matches.

let remoteBusy = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settled(b, quiet, max) {
  const start = Date.now();
  b.lastOutputAt = b.lastOutputAt || 0;
  const sentAt = Date.now();
  while (Date.now() - start < max) {
    await sleep(40);
    if (b.lastOutputAt > sentAt && Date.now() - b.lastOutputAt >= quiet) return true;
  }
  return false;
}
function lastLineInfo(b) {
  let i = b.rowEls.length - 1;
  while (i > 0 && b.rowEls[i].dataset.w) i--;
  if (i < 0) return { i: -1, text: '' };
  let text = logicalLine(b, i).text;
  // Spaces before the cursor matter (bash adds one after a finished name),
  // but the screen text has them trimmed: put them back.
  const last = b.rowEls[b.rowEls.length - 1];
  if (b.cursor && b.cursor.row === b.rowEls.length - 1) {
    const shown = last.textContent.replace(/^\n/, '').length;
    if (b.cursor.col > shown) text += ' '.repeat(b.cursor.col - shown);
  }
  return { i, text };
}

async function remoteComplete() {
  const b = running, typed = cmd.value;
  remoteBusy = true;
  b.quiet = true;
  try {
    const before = lastLineInfo(b);
    anvil.send('write', typed + '\t');
    await settled(b, 200, 1500);
    let line = lastLineInfo(b);
    let at = typed ? line.text.lastIndexOf(typed) : -1;
    if (typed && at < 0) {
      // The line cannot be found on screen (a password prompt, a program
      // that draws its own way): leave it with the program, as typed.
      if (b.partialN == null) b.partialN = before.i + 1;
      cmd.value = ''; lastInput = '';
      return;
    }
    let completed = typed ? line.text.slice(at) : '';
    let matches = [];
    if (completed === typed) {                         // nothing added: ask for the list
      const listFrom = line.i;
      anvil.send('write', '\t');
      await settled(b, 250, 1200);
      line = lastLineInfo(b);
      if (/possibilities\?? \(y or n\)|Display all/i.test(line.text)) {   // too many to show
        anvil.send('write', 'n');
        await settled(b, 200, 800);
        matches = null;
        line = lastLineInfo(b);
      } else if (line.i > listFrom) {
        for (let r = listFrom + 1; r < line.i; r++) matches.push(...b.rowEls[r].textContent.trim().split(/\s{2,}|\t/).filter(Boolean));
      }
      at = typed ? line.text.lastIndexOf(typed) : -1;
      if (at >= 0) completed = line.text.slice(at);
    }
    anvil.send('write', '\x15');                     // Ctrl+U: the box holds the line now
    await settled(b, 150, 600);
    cmd.value = completed;
    cmd.selectionStart = cmd.selectionEnd = completed.length;
    if (matches === null) sayNow('Too many matches to list. Type more and press Tab again.');
    else if (matches.length) {
      $('matches').textContent = matches.slice(0, 60).join('   ');
      sayNow(`${matches.length} matches: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ', and more' : ''}`);
    } else if (completed !== typed) sayNow(completed.slice(typed.length).trim() ? completed.trim().split(/\s+/).pop() : completed);
    else sayNow('No matches');
  } finally {
    b.spoken = blockText(b);                           // none of this is new output to read
    b.quiet = false;
    remoteBusy = false;
  }
}

// ---------- Alt+C: select and copy ----------
// A web page has no caret, so Shift+arrows cannot select in it. Alt+C puts the
// current block (or the program's screen) into a read-only text box, where the
// caret, selection and Ctrl+C all work and the screen reader follows along.

let copyReturn = null;
function currentBlock() {
  const el = document.activeElement?.closest?.('.block');
  if (el) return [...blocks.values()].find(b => b.el === el);
  return [...blocks.values()].pop();
}
function openCopy() {
  let title, text;
  if (!review.hidden) {
    title = `${gridName} screen`;
    text = analyseScreen().texts.join('\n').replace(/\n+$/, '');
  } else {
    const b = currentBlock();
    if (!b) { announce('Nothing to copy yet'); return; }
    title = b.command;
    text = b.out.innerText.replace(/\n+$/, '');
    const err = b.err.textContent.trim();
    if (err && view === 'err') text = err;
  }
  copyReturn = document.activeElement;
  $('copy-title').textContent = `Copy from: ${title}`;
  $('copy-text').value = text;
  $('copy').hidden = false;
  const ta = $('copy-text');
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}
function closeCopy() {
  $('copy').hidden = true;
  (copyReturn && document.contains(copyReturn) ? copyReturn : cmd).focus();
  copyReturn = null;
}
// Chromium gives a truly read-only text box no caret, so this one stays
// editable and simply refuses every change.
$('copy-text').addEventListener('beforeinput', e => e.preventDefault());
$('copy').addEventListener('keydown', e => {
  if (e.key === 'Escape' || is(e, 'copy')) { e.preventDefault(); e.stopPropagation(); closeCopy(); }
}, true);

// ---------- #@name completion ----------
// Tab on "#@co" (or "@co" after an earlier #@) completes bookmark names.
function inlineTab() {
  const w = wordsAtCaret();
  const word = w.words[w.cword];
  let p = 0;
  if (word.startsWith('#@')) p = 2;
  else if (word.startsWith('@')) { const at = Bookmarks.inlineAt(w.line); if (at >= 0 && at < w.start) p = 1; }
  if (!p) return false;
  const typed = word.slice(p).toLowerCase();
  const found = namedBookmarks().filter(b => b.name.toLowerCase().startsWith(typed));
  if (!found.length) { sayNow('No bookmark starts with that'); return true; }
  if (found.length === 1) { putWord(w.start, word.slice(0, p) + found[0].name + ' '); sayNow(Bookmarks.describe(found[0])); return true; }
  let common = found[0].name;
  for (const b of found) { let i = 0; while (i < common.length && common[i].toLowerCase() === b.name[i]?.toLowerCase()) i++; common = common.slice(0, i); }
  if (common.length > typed.length) putWord(w.start, word.slice(0, p) + common);
  $('matches').textContent = found.map(b => b.name).join('   ');
  sayNow(`${found.length} bookmarks: ${found.slice(0, 8).map(b => b.name).join(', ')}`);
  return true;
}

// ---------- quote pairing in the command box ----------
// Typing " or ' gives the closing one as well, with the caret between.
// Typing the closing quote steps over it; Backspace in an empty pair removes
// both. No pairing after a letter (it's) or a backslash, inside quotes, or
// before a word. With text selected, the quotes go round it.
function openQuote(s) {
  let q = null, esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === '\\' && q !== "'") { esc = true; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
  }
  return q;
}
function quoteKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const v = cmd.value, a = cmd.selectionStart, z = cmd.selectionEnd;
  if (e.key === 'Backspace') {
    if (a !== z || a === 0 || !/["']/.test(v[a - 1]) || v[a] !== v[a - 1] || openQuote(v.slice(0, a - 1))) return false;
    e.preventDefault();
    cmd.setSelectionRange(a - 1, a + 1);
    document.execCommand('delete');
    return true;
  }
  if (e.key !== '"' && e.key !== "'") return false;
  const q = e.key;
  if (a !== z) {                                   // wrap the selection
    e.preventDefault();
    document.execCommand('insertText', false, q + v.slice(a, z) + q);
    return true;
  }
  const inside = openQuote(v.slice(0, a));
  if (inside === q && v[a] === q) { e.preventDefault(); cmd.setSelectionRange(a + 1, a + 1); return true; }
  if (inside) return false;
  if (a > 0 && /[\w\\]/.test(v[a - 1])) return false;
  if (a < v.length && !/[\s)|;&]/.test(v[a])) return false;
  e.preventDefault();
  document.execCommand('insertText', false, q + q);
  cmd.setSelectionRange(a + 1, a + 1);
  return true;
}

// ---------- readline keys in the command box ----------
// Ctrl+A, Ctrl+E, Ctrl+B, Ctrl+F, Alt+B, Alt+F, Ctrl+K, Ctrl+U, Ctrl+W,
// Alt+D, Alt+Backspace, Ctrl+Y, Alt+C, Alt+U, Alt+L, Ctrl+T and Alt+., as in bash. A key you have given to one of
// The Textsmith's own actions keeps that action. What is deleted is read out.
let killed = '';
function readlineKey(e) {
  const k = Keys.of(e);
  const v = cmd.value, a = cmd.selectionStart, z = cmd.selectionEnd;
  const wordStart = i => { while (i > 0 && /\s/.test(v[i - 1])) i--; while (i > 0 && !/\s/.test(v[i - 1])) i--; return i; };
  const wordEnd = i => { while (i < v.length && /\s/.test(v[i])) i++; while (i < v.length && !/\s/.test(v[i])) i++; return i; };
  const move = i => { cmd.selectionStart = cmd.selectionEnd = i; };
  const kill = (from, to) => {
    if (from === to) { sayNow('Nothing to delete'); return; }
    killed = v.slice(from, to);
    cmd.value = v.slice(0, from) + v.slice(to);
    move(from);
    sayNow(`Deleted ${killed.trim() || "spaces"}`);
  };
  const free = combo => !Object.entries(prefs.keys).some(([a, s]) => !Keys.GRID_ONLY.includes(a) && Keys.matches(combo, s));
  // Alt+C, Alt+U, Alt+L: change the case of the word from the caret on, and move past it.
  const recase = f => {
    let i = z; while (i < v.length && /\s/.test(v[i])) i++;
    const end = wordEnd(z);
    if (i >= end) return;
    const word = f(v.slice(i, end));
    cmd.value = v.slice(0, i) + word + v.slice(end);
    move(end);
    sayNow(word);
  };
  const actions = {
    'Ctrl+A': () => move(0),
    'Ctrl+E': () => move(v.length),
    'Ctrl+F': () => move(Math.min(v.length, z + 1)),
    'Alt+F': () => move(wordEnd(z)),
    'Ctrl+B': () => move(Math.max(0, a - 1)),
    'Alt+B': () => move(wordStart(a)),
    'Ctrl+K': () => kill(a, v.length),
    'Ctrl+U': () => kill(0, a),
    'Ctrl+W': () => kill(wordStart(a), a),
    'Alt+Backspace': () => kill(wordStart(a), a),
    'Alt+D': () => kill(z, wordEnd(z)),
    'Alt+C': () => recase(w => w[0].toUpperCase() + w.slice(1).toLowerCase()),
    'Alt+U': () => recase(w => w.toUpperCase()),
    'Alt+L': () => recase(w => w.toLowerCase()),
    'Ctrl+T': () => {                           // swap the characters around the caret
      if (v.length < 2 || a === 0) return;
      const i = a === v.length ? a - 1 : a;
      cmd.value = v.slice(0, i - 1) + v[i] + v[i - 1] + v.slice(i + 1);
      move(i + 1);
      sayNow(v[i] + v[i - 1]);
    },
    'Alt+Period': () => {                       // the last word of the previous command
      const prev = [...history].reverse().find(Boolean);
      const last = prev ? Bookmarks.tokenize(prev).pop() : '';
      if (!last) { sayNow('No previous command'); return; }
      cmd.value = v.slice(0, a) + last + v.slice(z);
      move(a + last.length);
      sayNow(last);
    },
    'Ctrl+Y': () => {
      if (!killed) return;
      cmd.value = v.slice(0, a) + killed + v.slice(z);
      move(a + killed.length);
      sayNow(killed);
    },
  };
  if (!actions[k] || !free(k)) return false;
  e.preventDefault();
  actions[k]();
  return true;
}

cmd.addEventListener('keydown', e => {
  const oneKey = pagerOn === 'nyae' ? NYAE_KEYS : PAGER_KEYS;
  if (pagerOn && running && !cmd.value && !e.ctrlKey && !e.altKey && !e.metaKey && oneKey[e.key]) {
    e.preventDefault();
    anvil.send('write', oneKey[e.key]);
    if (pagerOn === 'nyae') setPager(false);
    return;
  }
  if (is(e, 'bookmarkMode')) {
    e.preventDefault();
    if (bmMode) { leaveBookmarkMode(true); announce('Commands'); } else enterBookmarkMode();
    return;
  }
  if (editingBookmark !== null && e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    endEditBookmark(true); announce('Edit cancelled');
    return;
  }
  if (bmMode && e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    leaveBookmarkMode(true); announce('Commands');
    return;
  }
  if (bmMode && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    const named = namedBookmarks();
    if (!named.length) { sayNow('No named bookmarks'); return; }
    bmPos = e.key === 'ArrowDown' ? (bmPos + 1) % named.length : (bmPos <= 0 ? named.length - 1 : bmPos - 1);
    cmd.value = named[bmPos].name + ' ';
    cmd.selectionStart = cmd.selectionEnd = cmd.value.length;
    sayNow(`${Bookmarks.describe(named[bmPos])}. ${bmPos + 1} of ${named.length}`);
    return;
  }
  // Shift+Enter runs the command as administrator.
  if (is(e, 'sudo') && !running && !secretOn) {
    e.preventDefault();
    if (bmMode) { runBookmark(true); return; }
    const line = cmd.value.trim();
    if (!line) return;
    if (!/^sudo\s/.test(line)) cmd.value = 'sudo ' + line;
    $('prompt').requestSubmit();
    return;
  }
  if (is(e, 'bookmark')) { e.preventDefault(); toggleBookmark(false); return; }
  if (is(e, 'bookmarkRun')) { e.preventDefault(); toggleBookmark(true); return; }
  if (is(e, 'historySearch')) { e.preventDefault(); openFinder('history'); return; }
  if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (!e.shiftKey && inlineTab()) return;
    if (running) {
      if (!e.shiftKey && !remoteBusy) remoteComplete();
      return;
    }
    if (bmMode) { bookmarkTab(e.shiftKey); return; }
    if (!cmd.value.trim() && !cycling()) { sayNow('Type the start of a name first'); return; }
    onTab(e.shiftKey);
    return;
  }
  if (e.ctrlKey && !e.altKey && e.code === 'KeyC' && running
      && cmd.selectionStart === cmd.selectionEnd && !String(getSelection())) {
    e.preventDefault(); anvil.send('write', '\x03'); announce('Interrupt sent'); return;
  }
  if (e.ctrlKey && !e.altKey && e.code === 'KeyD' && cmd.value === '') {
    e.preventDefault(); anvil.send('write', '\x04'); return;
  }
  if (prefs.editing.pairQuotes && !secretOn && quoteKey(e)) return;
  if (prefs.editing.readline && readlineKey(e)) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowUp' && historyPos > 0) {
    e.preventDefault();
    if (historyPos === history.length) draft = cmd.value;
    cmd.value = history[--historyPos];
  } else if (e.key === 'ArrowDown' && historyPos < history.length) {
    e.preventDefault();
    historyPos++;
    cmd.value = historyPos === history.length ? draft : history[historyPos];
  }
});

// ---------- pagers (less, more, man) showing their pages in the document ----------
// A pager that does not take the whole screen (less as journalctl and git
// start it, or any pager over ssh) adds each page under the last and waits
// at a prompt line. While it waits, the bare keys go to it from an empty box.
const PAGER_PROMPT = /^(:|\(END\)|.*\(END\)|--More--.*|lines \d+-\d+.*|Manual page .* line \d+.*|byte \d+.*)$/;
// zsh's spelling correction ("correct 'sl' to 'ls' [nyae]?") likewise takes
// one key: n, y, a or e.
let pagerOn = false;
const PAGER_KEYS = { ' ': ' ', PageDown: ' ', b: 'b', PageUp: 'b', q: 'q', g: 'g', G: 'G', Home: 'g', End: 'G' };
const NYAE_KEYS = { n: 'n', y: 'y', a: 'a', e: 'e' };
function setPager(on) {
  if (on === pagerOn) return;
  pagerOn = on;
  if (on === 'pager') {
    cmdLabel.textContent = 'Pager: Space next page, B back, Q quit';
    announce('Pager. Space for the next page, B to go back, Q to quit.');
  } else if (on === 'nyae') {
    cmdLabel.textContent = 'Answer: Y yes, N no, A abort, E edit';
  } else if (running && !secretOn) cmdLabel.textContent = 'Input to ' + running.command.split(/\s+/)[0];
}

// ---------- secrets: a password the program asks for is never shown ----------
let sessionSecret = false, textSecret = false, secretOn = false;
function updateSecret() {
  const on = !!running && (sessionSecret || textSecret);
  if (on === secretOn) return;
  secretOn = on;
  cmd.type = on ? 'password' : 'text';
  if (on) {
    cmdLabel.textContent = `Password for ${running.command.split(/\s+/)[0]}`;
    announce('Password requested. What you type is hidden.');
  } else cmdLabel.textContent = running ? 'Input to ' + running.command.split(/\s+/)[0] : 'Command';
}

// ---------- bookmarks (Ctrl+B, Alt+B, Ctrl+Space) and history search (Ctrl+R) ----------
// Bookmarks live in the bookmarks file, one per line, written the way you
// type them: `rclone sync <> . --progress#sync music`. renderer/bookmarks.js
// explains the form.
let tabAnnounce = false;
let bookmarks = [], tabInfo = null, finderMode = null, finderReturn = null;
const parsedBookmarks = () => bookmarks.map(Bookmarks.parse);
const namedBookmarks = () => parsedBookmarks().filter(b => b.name);
const refreshBookmarks = () => anvil.get('bookmarks').then(b => { if (Array.isArray(b)) bookmarks = b; });
const saveBookmarks = () => anvil.send('bookmarks', bookmarks);
// Inside a running program (ssh, tmux...), a bookmark is put in the box as
// input for it, without Enter. Over ssh, a bookmark with a command per
// machine takes the command for the machine connected to (remoteNames, from
// the main process); otherwise this machine's.
let remoteNames = null;
const refreshRemote = () => (running ? anvil.get('remote').then(r => { remoteNames = Array.isArray(r) ? r : null; }) : Promise.resolve((remoteNames = null)));
function machineFor(raw) {
  for (const m of remoteNames || []) if (!Bookmarks.parseOn(raw, m).missing) return m;
  return (remoteNames && remoteNames[0]) || Bookmarks.parse(raw).machine;
}
const runningName = () => (running ? running.command.split(/\s+/)[0] : 'the program');
// A bookmark, filled in as far as it goes, into the box for the running program.
function intoProgram(b, args = []) {
  if (b.missing) { sayNow(b.missing); return false; }
  let text;
  if (args.length || !Bookmarks.wantsArgs(b)) {
    const r = Bookmarks.expand(b, args);
    if (r.error) { sayNow(r.error); return false; }
    text = r.command;
  } else text = Bookmarks.thisCommand(b);
  if (b.pipe) text = ' | ' + text;
  closeFinder(false);
  leaveBookmarkMode(false);
  cmd.value = text;
  cmd.focus();
  cmd.selectionStart = cmd.selectionEnd = text.length;
  const more = Bookmarks.wantsArgs(b) && !args.length ? ' Replace the places in angle brackets, then Enter sends it.' : ' Enter sends it.';
  announce(`In the box for ${runningName()}: ${text}.${more}`);
  return true;
}

function findBookmark(name) {
  const named = namedBookmarks();
  return named.find(b => b.name === name) || named.find(b => b.name.toLowerCase() === name.toLowerCase());
}

// Ctrl+B: bookmark what is in the box and clear it. The same line again
// removes it; the same name with a new command replaces the old one.
// Ctrl+Shift+B does the same and then runs it (or asks for its arguments).
function toggleBookmark(andRun) {
  if (editingBookmark !== null) { saveEditedBookmark(); return; }
  const fromBox = !!cmd.value.trim();
  // Typed as "#name: command" or as a plain command; stored in the label form.
  const typed = cmd.value.trim() || [...history].reverse().find(Boolean) || '';
  if (!typed) { announce('Type a command to bookmark'); return; }
  const bm = Bookmarks.parse(typed);
  const text = Bookmarks.format(bm);
  const same = bookmarks.findIndex(r => Bookmarks.format(Bookmarks.parse(r)) === text);
  if (same >= 0 && !andRun) {
    bookmarks.splice(same, 1); saveBookmarks();
    announce(`Bookmark removed: ${bm.name || bm.command}`);
    return;
  }
  const old = bookmarks.findIndex(r => {
    const o = Bookmarks.parse(r);
    return bm.name ? o.name === bm.name : !o.name && o.command === bm.command;
  });
  if (old >= 0) bookmarks.splice(old, 1);
  bookmarks.push(text);
  saveBookmarks();
  if (fromBox) { cmd.value = ''; comp = null; $('matches').textContent = ''; }
  const what = `${old >= 0 && bookmarks[old] !== text ? 'Bookmark updated' : 'Bookmarked'}: ${bm.name ? Bookmarks.describe(bm) : bm.command}`;
  if (!andRun) { announce(what); return; }
  if (running) { announce(`${what}. It will run once the running command has finished.`); return; }
  if (bm.name && (bm.min > 0 || bm.slots.length)) { enterBookmarkMode(bm.name + ' ', `${what}. Type its arguments.`); return; }
  if (bm.min > 0 || bm.slots.some(s => s.rest)) {
    cmd.value = bm.command;
    announce(`${what}. Fill in the places marked with angle brackets, then Enter.`);
    return;
  }
  cmd.value = Bookmarks.expand(bm, []).command;
  $('prompt').requestSubmit();
}

// Editing a bookmark (Ctrl+Enter in the bookmark list): the whole line, name
// and all, goes in the box; Enter saves it in place of the old one.
let editingBookmark = null, editDraft = '';
function startEditBookmark(raw) {
  closeFinder(false);
  leaveBookmarkMode(false);
  editDraft = editingBookmark === null ? cmd.value : editDraft;
  editingBookmark = raw;
  cmd.value = Bookmarks.format(Bookmarks.parse(raw));
  cmd.focus();
  cmd.selectionStart = cmd.selectionEnd = raw.length;
  cmdLabel.textContent = 'Edit bookmark';
  const b = Bookmarks.parse(raw);
  announce(`Editing bookmark ${b.name || b.command}. Enter saves, Escape cancels.`);
}
function endEditBookmark(restore) {
  editingBookmark = null;
  cmdLabel.textContent = running ? 'Input to ' + running.command.split(/\s+/)[0] : 'Command';
  cmd.value = restore ? editDraft : '';
  editDraft = '';
}
function saveEditedBookmark() {
  const old = editingBookmark;
  const text = cmd.value.trim() ? Bookmarks.format(Bookmarks.parse(cmd.value)) : '';
  const i = bookmarks.indexOf(old);
  if (!text) {
    if (i >= 0) bookmarks.splice(i, 1);
    saveBookmarks(); endEditBookmark(false);
    announce('Bookmark removed');
    return;
  }
  const bm = Bookmarks.parse(text);
  const clash = bm.name && bookmarks.find(r => r !== old && Bookmarks.parse(r).name === bm.name);
  if (clash) { sayNow(`Another bookmark is already called ${bm.name}. Choose another name.`); return; }
  if (i >= 0) bookmarks[i] = text; else bookmarks.push(text);
  saveBookmarks();
  endEditBookmark(false);
  announce(`Bookmark saved: ${bm.name ? Bookmarks.describe(bm) : bm.command}`);
}

function finderItems() {
  const q = $('finder-q').value.toLowerCase();
  if (finderMode === 'bookmarks') {
    const items = [];
    for (const raw of [...bookmarks].reverse()) {
      const b = Bookmarks.parse(raw);
      if (running && b.variants.length) {
        // Inside a program: one row per machine, the one connected to first.
        const rank = m => { const i = (remoteNames || [b.machine]).indexOf(m); return i < 0 ? 1e6 + (m === '*') : i; };
        const ms = b.variants.flatMap(v => v.machines).sort((x, y) => rank(x) - rank(y));
        for (const m of ms) {
          const one = Bookmarks.parseOn(raw, m);
          items.push({ raw, machine: m, label: `${b.name}, for ${m === '*' ? 'any other machine' : m}: ${Bookmarks.thisCommand(one)}` });
        }
      } else items.push({ raw, machine: '', label: b.name ? `${b.name}: ${b.command}` : b.command });
    }
    return items.filter(it => it.label.toLowerCase().includes(q)).slice(0, 300);
  }
  return [...new Set([...history].reverse())].filter(c => c && c.toLowerCase().includes(q)).slice(0, 300).map(c => ({ raw: c, label: c }));
}
function renderFinder() {
  const list = $('finder-list');
  list.textContent = '';
  for (const it of finderItems()) {
    const li = document.createElement('li'), btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = it.label; btn.dataset.cmd = it.raw; btn.dataset.machine = it.machine || '';
    li.append(btn); list.append(li);
  }
  return list.children.length;
}
function openFinder(mode) {
  finderMode = mode;
  finderReturn = document.activeElement;
  $('finder-q').value = mode === 'history' ? cmd.value : '';
  $('finder-title').textContent = mode === 'bookmarks' ? 'Bookmarks' : 'Search history';
  $('finder-note').textContent = mode === 'bookmarks'
    ? (running
      ? 'Enter puts a bookmark in the box for the running program; Enter there sends it. A bookmark with a command per machine has a row for each. Escape goes back.'
      : 'Enter runs a bookmark, or asks for its arguments. Ctrl+Enter edits it in the command box, where Enter saves it. Delete removes it. Escape goes back.')
    : 'Enter runs a command, Ctrl+Enter puts it in the box to edit. Escape goes back.';
  const show = () => {
    const n = renderFinder();
    $('finder').hidden = false;
    const first = $('finder-list').querySelector('button');
    if (mode === 'bookmarks' && first) first.focus();
    else $('finder-q').focus();
    if (mode === 'bookmarks' && !n) announce('No bookmarks yet. Ctrl+B in the command box bookmarks a command.');
  };
  if (mode === 'bookmarks') Promise.all([refreshBookmarks(), refreshRemote()]).then(show); else show();
}
function closeFinder(refocus = true) {
  $('finder').hidden = true;
  finderMode = null;
  if (refocus) (finderReturn && document.contains(finderReturn) ? finderReturn : cmd).focus();
}
function useCommand(c, run) {
  closeFinder(false);
  leaveBookmarkMode(false);
  cmd.value = c;
  cmd.focus();
  cmd.selectionStart = cmd.selectionEnd = c.length;
  if (run) $('prompt').requestSubmit();
  else announce(`In the box: ${c}`);
}
function pickFinder(raw, run, machine) {
  if (finderMode !== 'bookmarks') { useCommand(raw, run); return; }
  if (run && running) { intoProgram(Bookmarks.parseOn(raw, machine || machineFor(raw))); return; }
  const b = Bookmarks.parse(raw);
  if (!run) { startEditBookmark(raw); return; }
  if (b.name && (b.min > 0 || b.slots.length)) {      // it needs arguments: ask for them
    closeFinder(false);
    enterBookmarkMode(b.name + ' ', Bookmarks.describe(b));
    return;
  }
  if (b.min > 0 || b.slots.some(s => s.rest)) { useCommand(b.command, false); announce(`In the box: ${b.command}. Fill in the places marked with angle brackets.`); return; }
  useCommand(Bookmarks.expand(b, []).command, true);
}

// ---------- Ctrl+Space: call a bookmark by name ----------
// The box takes a bookmark name and its arguments instead of a command:
// `sync drive:Music`. Tab completes names (and then files, or whatever the
// bookmarked program completes); Up and Down step through the bookmarks.
let bmMode = false, bmDraft = '', bmPos = -1;
function enterBookmarkMode(text = '', say = '') {
  if (running) refreshRemote();
  if (!bmMode) bmDraft = cmd.value;
  bmMode = true; bmPos = -1;
  cmd.value = text;
  cmd.focus();
  cmd.selectionStart = cmd.selectionEnd = text.length;
  cmdLabel.textContent = 'Bookmark';
  comp = null; $('matches').textContent = '';
  refreshBookmarks().then(() => {
    if (say) { announce(`Bookmark. ${say}`); return; }
    const n = namedBookmarks().length;
    announce(n ? `Bookmark. ${n} named bookmark${n === 1 ? '' : 's'}: type a name, Tab completes, Up and Down list them. Escape goes back to commands.`
      : 'Bookmark. There are no named bookmarks yet: end a command with #name and press Ctrl+B. Escape goes back.');
  });
}
function leaveBookmarkMode(restore) {
  if (!bmMode) return;
  bmMode = false;
  cmdLabel.textContent = running ? 'Input to ' + running.command.split(/\s+/)[0] : 'Command';
  if (restore) cmd.value = bmDraft;
  bmDraft = '';
  comp = null; $('matches').textContent = '';
}
function runBookmark(sudo) {
  const words = Bookmarks.tokenize(cmd.value.trim());
  if (!words.length) { sayNow('Type a bookmark name'); return; }
  const b = findBookmark(words[0]);
  if (!b) { sayNow(`No bookmark called ${words[0]}`); return; }
  if (running) { intoProgram(Bookmarks.parseOn(b.raw, machineFor(b.raw)), words.slice(1)); return; }
  const r = Bookmarks.expand(b, words.slice(1));
  if (r.error) { sayNow(r.error); return; }
  leaveBookmarkMode(false);
  cmd.value = (sudo && !/^sudo\s/.test(r.command) ? 'sudo ' : '') + r.command;
  // Called from inside the form's own submit, where a second submit is ignored.
  setTimeout(() => $('prompt').requestSubmit(), 0);
}
function bookmarkTab(back) {
  if (cycling()) { onTab(back); return; }
  const w = wordsAtCaret();
  if (w.cword === 0) {
    const found = namedBookmarks().filter(b => b.name.toLowerCase().startsWith(w.word.toLowerCase()));
    if (!found.length) { sayNow('No bookmark starts with that'); return; }
    if (found.length === 1) { putWord(w.start, found[0].name + ' '); sayNow(Bookmarks.describe(found[0])); return; }
    let common = found[0].name;
    for (const b of found) { let i = 0; while (i < common.length && common[i].toLowerCase() === b.name[i]?.toLowerCase()) i++; common = common.slice(0, i); }
    if (common.length > w.word.length) putWord(w.start, common);
    comp = { start: w.start, list: found.map(b => b.name), i: -1, value: cmd.value };
    $('matches').textContent = comp.list.join('   ');
    sayNow(`${found.length} bookmarks: ${comp.list.slice(0, 8).join(', ')}. Tab for the next one.`);
    return;
  }
  // An argument: complete it as the bookmarked program would (files, rclone
  // remotes, git branches...).
  const b = findBookmark(w.words[0]);
  if (!b) { sayNow(`No bookmark called ${w.words[0]}`); return; }
  const prog = Bookmarks.tokenize(b.command)[0] || '';
  const rest = w.line.slice(w.line.indexOf(w.words[0]) + w.words[0].length);
  pendingComp = w;
  anvil.send('complete', { line: prog + rest, words: [prog, ...w.words.slice(1)], cword: w.cword });
}

let finderTimer = null;
$('finder-q').addEventListener('input', () => {
  const n = renderFinder();
  clearTimeout(finderTimer);
  finderTimer = setTimeout(() => {
    const first = $('finder-list').querySelector('button');
    sayNow(n ? `${n} match${n === 1 ? '' : 'es'}: ${first.textContent}` : 'No matches');
  }, 250);
});
$('finder').addEventListener('keydown', e => {
  const items = [...$('finder-list').querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  const inQuery = document.activeElement === $('finder-q');
  if (e.key === 'Escape') { e.preventDefault(); closeFinder(); }
  else if (e.key === 'ArrowDown' && (inQuery || i >= 0)) { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
  else if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); (i === 0 ? $('finder-q') : items[i - 1]).focus(); }
  else if (e.key === 'Enter' && (inQuery || i >= 0)) {
    e.preventDefault();
    const it = i >= 0 ? items[i] : items[0];
    if (it) pickFinder(it.dataset.cmd, !e.ctrlKey, it.dataset.machine);
  }
  else if (e.key === 'Delete' && i >= 0 && finderMode === 'bookmarks') {
    e.preventDefault();
    const c = items[i].dataset.cmd;
    bookmarks = bookmarks.filter(x => x !== c);
    anvil.send('bookmarks', bookmarks);
    renderFinder();
    const rest = [...$('finder-list').querySelectorAll('button')];
    (rest[Math.min(i, rest.length - 1)] || $('finder-q')).focus();
    announce(`Bookmark removed: ${Bookmarks.parse(c).name || Bookmarks.parse(c).command}`);
  }
  else if (e.key.length === 1 && i >= 0 && !e.ctrlKey && !e.altKey) {   // typing filters
    $('finder-q').focus();
  }
});

$('prompt').addEventListener('submit', e => {
  e.preventDefault();
  if (editingBookmark !== null) { saveEditedBookmark(); return; }
  if (bmMode) { runBookmark(false); return; }
  let line = cmd.value;
  if (secretOn) {                           // a password: send it, keep it nowhere
    anvil.send('submit', line);
    cmd.value = '';
    textSecret = false; updateSecret();
    return;
  }
  // "command #@name": bookmarks added to the end, like global aliases.
  const inline = Bookmarks.expandInline(line, findBookmark);
  if (inline) {
    if (inline.error) { sayNow(inline.error); return; }
    line = cmd.value = inline.command;
  }
  if (!running) {
    if (!line.trim()) return;
    if (history[history.length - 1] !== line) history.push(line);
    historyPos = history.length; draft = '';
  }
  else {
    lastInput = line.trim();
    const partial = running.partialN != null;
    if (running.pausedDrop) running.dropAt = running.rowEls.length;   // e.g. next message in neomutt
    else if (lastInput || partial) {
      running.pending.push({ n: partial ? running.partialN : running.rowEls.length, input: lastInput, full: partial });
    }
    running.partialN = null;
  }
  anvil.send('submit', line);
  cmd.value = '';
  comp = null; $('matches').textContent = '';
  scrollDown();
});

for (const b of document.querySelectorAll('#bar button')) b.addEventListener('click', () => { setView(b.dataset.view); cmd.focus(); });

doc.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.url) anvil.send('open', a.dataset.url);
  else if (a.dataset.man) {
    if (running || !ready) { announce('Finish the running command first'); return; }
    anvil.send('submit', 'man ' + a.dataset.man);
    cmd.focus();
  }
});

// ---------- go ----------

setTitle();
requestAnimationFrame(() => anvil.send('start', measure()));
anvil.get('machine').then(m => { if (m) Bookmarks.setMachine(m); });
anvil.get('history').then(h => {
  if (!Array.isArray(h) || !h.length) return;
  history.unshift(...h.filter(l => l !== history[0]));
  historyPos = history.length;
});
anvil.get('bookmarks').then(b => { if (Array.isArray(b)) bookmarks = b; });
