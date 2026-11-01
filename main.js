'use strict';
// The Textsmith's main process: one window, any number of tabs. Each tab is
// its own page with its own shell session.

const { app, BaseWindow, WebContentsView, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session } = require('./session');
const Keys = require('./renderer/keys');
const Bookmarks = require('./renderer/bookmarks');
const { execFileSync } = require('child_process');

const EVENTS = ['ready', 'cwd', 'block-start', 'block-output', 'block-stderr', 'block-end',
  'grid-enter', 'grid-data', 'grid-exit', 'completions', 'secret'];

let win = null;
const tabs = [];              // { view, session, title }
let active = -1;
let quitting = false;

// ---------- tabs ----------

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  for (const t of tabs) t.view.setBounds({ x: 0, y: 0, width, height });
}

function newTab() {
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const tab = { view, session: null, title: 'The Textsmith' };
  tabs.push(tab);
  win.contentView.addChildView(view);
  layout();
  const wc = view.webContents;
  wc.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  wc.on('will-navigate', e => e.preventDefault());       // the page is the terminal
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('page-title-updated', (_e, title) => { tab.title = title; if (tabs[active] === tab) win.setTitle(title); });
  wc.on('before-input-event', (e, input) => { if (tabKeys(input)) e.preventDefault(); });
  if (process.env.TEXTSMITH_DEVTOOLS) wc.openDevTools({ mode: 'detach' });
  showTab(tabs.length - 1);
  return tab;
}

function showTab(i) {
  if (!tabs[i]) return;
  active = i;
  tabs.forEach((t, j) => t.view.setVisible(j === i));
  const t = tabs[i];
  win.setTitle(t.title);
  t.view.webContents.focus();
  broadcastTabs(true);
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (tab.session) tab.session.dispose();
  win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (!tabs.length) { app.quit(); return; }
  showTab(Math.min(i, tabs.length - 1));
}

// Every page shows "tab 2 of 3"; the newly shown one also announces it.
function broadcastTabs(announce) {
  tabs.forEach((t, j) => {
    if (!t.view.webContents.isDestroyed()) t.view.webContents.send('anvil', 'tabs', { index: j, count: tabs.length, active: j === active, announce: announce && j === active });
  });
}

// Tab keys work everywhere, even inside vim or neomutt.
function tabKeys(input) {
  if (input.type !== 'keyDown') return false;
  const combo = Keys.of(input), k = prefs.keys;
  if (!combo) return false;
  if (Keys.matches(combo, k.newTab)) { newTab(); return true; }
  if (Keys.matches(combo, k.closeTab)) { closeTab(tabs[active]); return true; }
  if (Keys.matches(combo, k.nextTab)) { showTab((active + 1) % tabs.length); return true; }
  if (Keys.matches(combo, k.prevTab)) { showTab((active - 1 + tabs.length) % tabs.length); return true; }
  return false;
}

// ---------- history and bookmarks ----------

// The shell's own history file, so Up in a new window reaches yesterday's commands.
// ---------- which shell ----------
// Your login shell from /etc/passwd (so chsh takes effect for the next tab
// or window, no logging out), unless the preferences name one. bash and zsh
// have their own integration; anything else runs bash.
function shellPath() {
  const want = process.env.TEXTSMITH_SHELL || (prefs && prefs.startup.shell) || '';
  const sh = want || os.userInfo().shell || process.env.SHELL || 'bash';
  return /^(bash|zsh)$/.test(path.basename(sh)) ? sh : 'bash';
}
const shellKind = () => path.basename(shellPath());

// zsh keeps some characters in a "metafied" form in its history file.
function unmetafy(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf[i] === 0x83 && i + 1 < buf.length ? buf[++i] ^ 32 : buf[i]);
  return Buffer.from(out).toString('utf8');
}
function readHistory() {
  const zsh = shellKind() === 'zsh';
  const file = process.env.HISTFILE || path.join(os.homedir(), zsh ? '.zsh_history' : '.bash_history');
  let text;
  try { text = zsh ? unmetafy(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = [];
  if (zsh) {
    let cur = null;                                         // ": 1697040000:0;command", "\" continues
    for (const l of text.split('\n')) {
      if (cur !== null) cur += '\n' + l; else cur = l.replace(/^: \d+:\d+;/, '');
      if (cur.endsWith('\\')) { cur = cur.slice(0, -1); continue; }
      lines.push(cur); cur = null;
    }
  } else lines.push(...text.split('\n'));
  const out = [];
  for (const l of lines) {
    if (!l.trim() || /^#\d+$/.test(l)) continue;           // timestamps from HISTTIMEFORMAT
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out.slice(-5000);
}

// The Textsmith's folder, shared with the GTK edition; first found wins:
// TEXTSMITH_CONFIG (or TEXTSMITH_HOME); ~/.textsmith, if it is there; else
// $XDG_CONFIG_HOME/textsmith (~/.config/textsmith).
function configDir() {
  const set = process.env.TEXTSMITH_CONFIG || process.env.TEXTSMITH_HOME;
  if (set) return set;
  const old = path.join(os.homedir(), '.textsmith');
  try { if (fs.statSync(old).isDirectory()) return old; } catch {}
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'textsmith');
}
const bookmarksFile = () => path.join(configDir(), 'bookmarks');
const BOOKMARKS_HEADER = `# The Textsmith bookmarks: one per line, written as you would type them.
#   #name(count) description: command      or just: command
# <> or <name> marks where an argument goes; <name:default> has a default; <..> takes any number;
#   #name: [:machine "command", :other "command", :* "command"] gives each machine its own command.
# Lines starting with "# " are notes.
`;
function readBookmarks() {
  let text;
  try { text = fs.readFileSync(bookmarksFile(), 'utf8'); }
  catch {
    // Bookmarks from before they had a file of their own.
    try {
      const old = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'bookmarks.json'), 'utf8'));
      if (Array.isArray(old) && old.length) { writeBookmarks(old.map(String)); return old.map(String); }
    } catch {}
    return [];
  }
  // Notes start with "# " or "##"; "#name: command" is a bookmark; a
  // "machine:" line (an old way of naming the machine) is ignored.
  return text.split('\n').map(l => l.trim()).filter(l => l && !/^#(\s|#|$)/.test(l) && !l.startsWith('machine:'));
}
function writeBookmarks(list) {
  fs.mkdirSync(configDir(), { recursive: true });
  // Notes already in the file stay at its top.
  let keep = [];
  try {
    keep = fs.readFileSync(bookmarksFile(), 'utf8').split('\n').map(l => l.trim()).filter(l => l === '#' || /^#(\s|#)/.test(l));
  } catch {}
  const head = keep.length ? keep.join('\n') + '\n' : BOOKMARKS_HEADER;
  fs.writeFileSync(bookmarksFile(), head + list.map(l => l.replace(/\n/g, ' ')).join('\n') + '\n');
}

// ---------- this machine's name, for bookmarks with a command per machine ----------
// TEXTSMITH_MACHINE, else the machine file in the folder (kept out of dotfiles), else
// /etc/hostname. The same order as the GTK version. Never from the bookmarks
// file: it travels between machines.
let machineName = null;
function machine() {
  if (machineName !== null) return machineName;
  const first = f => { try { return (fs.readFileSync(f, 'utf8').split('\n')[0] || '').trim(); } catch { return ''; } };
  let m = (process.env.TEXTSMITH_MACHINE || '').trim() || first(path.join(configDir(), 'machine'));
  if (!m) m = first('/etc/hostname') || os.hostname();
  return (machineName = m);
}

// The names the machine a tab's running ssh is connected to may go by, best
// first: the host given to ssh (an alias from ~/.ssh/config, say), then its
// real host name in full and short. The program is looked up as it really
// runs, so an alias or a bookmark that starts ssh is seen through.
function remoteNames(tab) {
  const s = tab && tab.session;
  if (!s || !s.pty) return null;
  const argvOf = pid => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; }
  };
  const childrenOf = pid => {
    try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { return []; }
  };
  let host = null;
  const queue = childrenOf(s.pty.pid);
  for (let n = 0; queue.length && n < 50 && !host; n++) {
    const pid = queue.shift();
    host = Bookmarks.remoteMachine(argvOf(pid));
    queue.push(...childrenOf(pid));
  }
  if (!host && s.current) host = Bookmarks.remoteMachine(s.current.command);
  if (!host) return null;
  const names = [host];
  try {
    const out = execFileSync('ssh', ['-G', host], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const h = (out.split('\n').find(l => l.startsWith('hostname ')) || '').slice(9).trim();
    for (const x of [h, h.split('.')[0]]) if (x && !names.includes(x)) names.push(x);
  } catch {}
  const short = host.split('.')[0];
  if (short !== host && !names.includes(short)) names.push(short);
  return names;
}

// ---------- preferences: prefs.json in The Textsmith's folder ----------

const DEFAULT_PREFS = {
  display: { commandStyle: 'heading', theme: 'system', fontSize: 14, font: '', programColours: true },
  speech: { whileRunning: true, readFullUpTo: 8, gridCharacters: true, wordEcho: true },
  editing: { readline: true, pairQuotes: true },
  title: { format: '{prompt} — {shell} — {app}' },
  startup: { directory: '', shell: '' },
  keys: { ...Keys.DEFAULT_KEYS },
  meta: { version: 3 },
};
const prefsFile = () => path.join(configDir(), 'prefs.json');
function mergePrefs(saved) {
  const out = {};
  for (const [group, defaults] of Object.entries(DEFAULT_PREFS)) {
    const given = saved && typeof saved[group] === 'object' ? saved[group] : {};
    out[group] = { ...defaults };
    for (const k of Object.keys(defaults)) if (k in given && typeof given[k] === typeof defaults[k]) out[group][k] = given[k];
  }
  // Versions 2 and 3 freed Ctrl+B, Alt+B and Alt+C for readline: keys still
  // on the old defaults move to the new ones.
  if (!(saved && saved.meta && saved.meta.version >= 3)) {
    for (const [k, old] of Object.entries(Keys.OLD_DEFAULTS)) if (out.keys[k] === old) out.keys[k] = Keys.DEFAULT_KEYS[k];
  }
  out.meta = { version: 3 };
  return out;
}
function readPrefs() {
  try { return mergePrefs(JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))); } catch { return mergePrefs({}); }
}
let prefs = null;
function savePrefs(p) {
  prefs = mergePrefs(p);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2) + '\n');
  for (const t of tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.send('anvil', 'prefs', prefs);
}

// ---------- how the program was started ----------
// textsmith [--working-directory DIR] [-e command args...]
// These are the forms desktops and file managers use for "open a terminal here".
function launchOptions(argv) {
  const o = { cwd: '', command: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--working-directory' || a === '-d') o.cwd = argv[++i] || '';
    else if (a.startsWith('--working-directory=')) o.cwd = a.slice(20);
    else if (a === '-e' || a === '-x' || a === '--command') {
      const rest = argv.slice(i + 1);
      // One argument is a command line; several are a program and its arguments.
      o.command = rest.length === 1 ? rest[0] : rest.map(w => /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`).join(' ');
      break;
    }
  }
  return o;
}
let launch = launchOptions(process.argv);

// ---------- the bridge to each page ----------

const tabOf = sender => tabs.find(t => t.view.webContents === sender);

ipcMain.handle('anvil-get', (e, what) => {
  if (what === 'machine') return machine();
  if (what === 'remote') return remoteNames(tabOf(e.sender));
  if (what === 'prefs') return prefs;
  if (what === 'version') return app.getVersion();
  if (what === 'history') return readHistory();
  if (what === 'bookmarks') return readBookmarks();
  return null;
});

ipcMain.on('anvil', (e, name, arg) => {
  const tab = tabOf(e.sender);
  if (!tab) return;
  const s = tab.session;
  switch (name) {
    case 'start': {
      if (s) s.dispose();
      // The first tab honours --working-directory and -e; later tabs start in
      // the startup directory from the preferences, or home.
      const first = launch;
      launch = { cwd: '', command: '' };
      let cwd = first.cwd || prefs.startup.directory.replace(/^~(?=\/|$)/, os.homedir()) || os.homedir();
      try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
      const session = tab.session = new Session({ cols: arg.cols, rows: arg.rows, cwd, shell: shellPath() });
      if (first.command) session.once('ready', () => session.submit(first.command));
      for (const ev of EVENTS) session.on(ev, p => { if (!e.sender.isDestroyed()) e.sender.send('anvil', ev, p); });
      session.on('exit', () => { if (!quitting) closeTab(tab); });
      session.start();
      broadcastTabs(tabs[active] === tab);
      break;
    }
    case 'submit': if (s) s.submit(String(arg)); break;
    case 'complete':
      if (s && !s.complete(arg)) e.sender.send('anvil', 'completions', { list: [], busy: true });
      break;
    case 'write': if (s) s.write(String(arg)); break;
    case 'resize': if (s) s.resize(arg.cols | 0, arg.rows | 0); break;
    case 'grid': if (s) s.setGrid(!!arg); break;
    case 'bookmarks':
      if (Array.isArray(arg)) { writeBookmarks(arg.map(String)); for (const t of tabs) t.view.webContents.send('anvil', 'bookmarks', arg); }
      break;
    case 'prefs': savePrefs(arg); break;
    case 'new-tab': newTab(); break;
    case 'tab-next': showTab((active + 1) % tabs.length); break;
    case 'tab-prev': showTab((active - 1 + tabs.length) % tabs.length); break;
    case 'tab-close': closeTab(tab); break;
    case 'open':
      if (/^https?:\/\//i.test(String(arg))) shell.openExternal(String(arg));
      break;
  }
});

// ---------- the window ----------

// Tests keep their bookmarks apart from yours.
if (process.env.TEXTSMITH_USER_DATA) app.setPath('userData', process.env.TEXTSMITH_USER_DATA);

app.whenReady().then(() => {
  // On Linux and Windows the menu bar would steal the Alt key.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  prefs = readPrefs();
  win = new BaseWindow({ width: 1000, height: 720, title: 'The Textsmith' });
  win.on('resize', layout);
  win.on('focus', () => { if (tabs[active]) tabs[active].view.webContents.focus(); });
  win.on('close', () => { quitting = true; for (const t of tabs) if (t.session) t.session.dispose(); });
  win.on('closed', () => { win = null; app.quit(); });
  newTab();
});
app.on('before-quit', () => { quitting = true; for (const t of tabs) if (t.session) t.session.dispose(); });
app.on('window-all-closed', () => app.quit());
