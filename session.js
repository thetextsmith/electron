'use strict';
// One shell session. Knows nothing about Electron, so it can be tested alone
// (see test/smoke.js).
//
// It turns the raw terminal stream into events:
//   ready                      shell is waiting for a command
//   cwd      {user,host,path}
//   block-start  {id, command}
//   block-output {id, start, rows}   replace rows from index `start` onwards
//   block-stderr {id, text}
//   block-end    {id, exitCode, lines, ms}
//   grid-enter {name} / grid-data string / grid-exit   full-screen programs
//   exit

const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const pty = require('@lydell/node-pty');
const { Terminal } = require('@xterm/headless');

// The escape sequences The Textsmith cares about. Everything else passes through.
const MARK = /\x1b\]133;([A-D])(?:;([^\x07\x1b]*))?\x07|\x1b\]7;([^\x07\x1b]*)\x07|\x1b\[\?(?:1049|1047|47)([hl])|\x1b\]7771;([^\x07]*)\x07|\x1b\]7772;([^\x07]*)\x07/g;
// A possibly unfinished escape sequence at the end of a chunk: hold it back.
const PARTIAL = /^\x1b(?:\][^\x07]*|\[\??[0-9;]*)?$/;

class Scanner {
  constructor(handlers) { this.h = handlers; this.carry = ''; }
  push(data) {
    let s = this.carry + data;
    this.carry = '';
    const esc = s.lastIndexOf('\x1b');
    if (esc !== -1 && s.length - esc < 262144 && PARTIAL.test(s.slice(esc))) {
      this.carry = s.slice(esc);
      s = s.slice(0, esc);
    }
    let last = 0, m;
    MARK.lastIndex = 0;
    while ((m = MARK.exec(s))) {
      if (m.index > last) this.h.text(s.slice(last, m.index));
      last = MARK.lastIndex;
      if (m[1] === 'D') this.h.done(parseInt(m[2], 10) || 0);
      else if (m[1] === 'C') { if (this.h.started) this.h.started(); }
      else if (m[1] === 'A') this.h.ready();
      else if (m[3] !== undefined) this.h.cwd(m[3]);
      else if (m[4]) this.h.alt(m[4] === 'h');
      else if (m[5] !== undefined) this.h.completions(m[5]);
      else if (m[6] !== undefined) this.h.prompt(m[6]);
    }
    if (last < s.length) this.h.text(s.slice(last));
  }
}

function xterm256(n) {
  if (n >= 232) { const v = 8 + (n - 232) * 10; return rgb(v, v, v); }
  const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
  return rgb(steps[Math.floor(i / 36)], steps[Math.floor(i / 6) % 6], steps[i % 6]);
}
function rgb(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

class Session extends EventEmitter {
  constructor({ cols = 100, rows = 30, cwd = os.homedir(), shell = 'bash' } = {}) {
    super();
    this.cols = cols; this.rows = rows; this.cwd = cwd;
    // Which integration to use: zsh has its own, every other shell gets bash.
    this.shellPath = path.basename(shell) === 'zsh' ? shell : (path.basename(shell) === 'bash' ? shell : 'bash');
    this.kind = path.basename(this.shellPath);
    this.outputStarted = false; // zsh: output of the running command has begun (133;C)
    this.state = 'boot';        // boot | ready | running | settling | completing
    this.queued = null;         // a command typed while the shell was not ready
    this.grid = false;          // a full-screen program owns the window
    this.doneCount = 0;         // "command finished" marks seen on the terminal
    this.errEndCount = 0;       // "end of stderr" marks seen on the stderr pipe
    this.blocks = new Map();    // seq -> unfinished block
    this.current = null;
    this.last = null;
    this.nextId = 1;
  }

  start() {
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-'));
    const fifo = path.join(this.tmp, 'stderr');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    // Opened read+write so the pipe never reports end-of-file, and wrapped in
    // a socket so reading it never blocks a thread.
    const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    this.errStream = new net.Socket({ fd, readable: true, writable: false });
    this.errStream.setEncoding('utf8');
    this.errScanner = new Scanner(this._handlers(true));
    this.errStream.on('data', d => this._onStderr(d));
    this.errStream.on('error', () => {});

    this.scanner = new Scanner(this._handlers(false));
    const zsh = this.kind === 'zsh';
    const args = zsh ? ['-i'] : ['--noediting', '--rcfile', path.join(__dirname, 'shell', 'textsmith.bashrc'), '-i'];
    const extra = zsh ? { ZDOTDIR: path.join(__dirname, 'shell', 'zsh'), TEXTSMITH_USER_ZDOTDIR: process.env.ZDOTDIR || '' } : {};
    this.pty = pty.spawn(this.shellPath, args, {
      name: 'xterm-256color',
      cols: this.cols, rows: this.rows, cwd: this.cwd,
      env: {
        ...process.env, ...extra,
        TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: this.shellPath,
        TEXTSMITH: '1', ANVIL: '1', ANVIL_ERR_FIFO: fifo, ANVIL_TMP: this.tmp,   // ANVIL kept for older configs
        // Output is a document you can scroll and search, so no pagers.
        PAGER: 'cat', MANPAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: 'cat',
      },
    });
    this.pty.onData(d => this.scanner.push(d));
    this.pty.onExit(() => { this.dispose(); this.emit('exit'); });
  }

  // A line from the command box: a new command, or input for the running one.
  submit(line) {
    if (this.state === 'ready') {
      const block = {
        id: this.nextId++, seq: this.doneCount + 1, command: line, started: Date.now(),
        term: this._newTerm(),
        sentBase: 0, lines: 0, offset: 0, offsetLines: 0, timer: null, ptyDone: false, errDone: false, exitCode: 0,
      };
      this.blocks.set(block.seq, block);
      if (this.last && this.last !== block && this.last.finished) this.last.term.dispose();
      this.current = this.last = block;
      this.state = 'running';
      this.outputStarted = false;
      this.emit('block-start', { id: block.id, command: line });
      if (this.kind === 'zsh') this._zle('\x1b[9998~', line);
      else this.pty.write(line + '\r');
      return true;
    }
    if (this.state === 'running') { this.pty.write(line + '\r'); return true; }
    this.queued = line;         // runs as soon as the shell is ready
    return true;
  }

  // Ask the shell what `word` could be completed to. Answer: 'completions'.
  // `words` are the words of `line` as typed, `cword` the one being completed.
  complete({ cword, line, words, full }) {
    if (this.state !== 'ready') return false;
    this.state = 'completing';
    // zsh completes the whole line itself, loops and all.
    if (this.kind === 'zsh') { this._zle('\x1b[9999~', full ?? line); return true; }
    const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
    this.pty.write(` __anvil_complete ${cword | 0} ${q(line)} ${words.map(q).join(' ')}\r`);
    return true;
  }

  write(data) { if (this.pty) this.pty.write(data); }   // raw keys (grid, Ctrl+C)

  // zsh: hand a line to a widget in the line editor through a file and a
  // private key, so nothing is typed in (no echo, no paste handling).
  _zle(key, line) {
    fs.writeFileSync(path.join(this.tmp, 'line'), String(line));
    this.pty.write(key);
  }

  resize(cols, rows) {
    if (!(cols > 1 && rows > 1)) return;
    this.cols = cols; this.rows = rows;
    if (this.pty) this.pty.resize(cols, rows);
    const b = this.current;
    if (b && !b.finished) { b.term.resize(cols, rows); b.sentBase = 0; this._schedule(b); }
  }

  // Manual switch to the grid, for programs that want single keys but do not
  // use the alternate screen (top, some y/n prompts).
  setGrid(on) {
    if (on && this.state !== 'running') return;
    this._setGrid(on);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.pty.kill(); } catch {}
    try { this.errStream.destroy(); } catch {}
    try { fs.rmSync(this.tmp, { recursive: true, force: true }); } catch {}
  }

  // ---- internals ----

  _handlers(fromStderr) {
    return {
      text: t => this._onText(t, fromStderr),
      alt: on => this._setGrid(on),
      cwd: url => { if (!fromStderr) this._onCwd(url); },
      started: () => { if (!fromStderr) { this.outputStarted = true; this.preStart = ''; clearTimeout(this.preStartTimer); } },
      ready: () => {
        if (fromStderr) return;
        this.state = 'ready';
        this.emit('ready');
        if (this.queued !== null) { const line = this.queued; this.queued = null; this.submit(line); }
      },
      prompt: text => { if (!fromStderr) this.prompt = text.trim().replace(/\s*[$#%>❯]$/, '').trim(); },
      completions: text => {
        if (!fromStderr) this.emit('completions', { list: [...new Set(text.split(/\r?\n/).filter(Boolean))] });
      },
      done: code => { if (!fromStderr) this._onDone(code); },
    };
  }

  _setGrid(on) {
    if (on === this.grid) return;
    this.grid = on;
    if (on) {
      let name = '';
      try { name = this.pty.process || ''; } catch {}
      const words = (this.current ? this.current.command : '').trim().split(/\s+/);
      if (!name || /^(ba|z|fi|da)?sh$/.test(path.basename(name))) name = words[0] || 'program';
      // docker run ... neomutt, sudo htop, ssh host top: name what runs inside.
      if (/^(docker|podman|sudo|doas|env|nice|kubectl|distrobox|toolbox|flatpak)$/.test(path.basename(name))) {
        const inner = words.slice(1).filter(w => !w.startsWith('-') && !w.includes('=')).pop();
        if (inner) name = inner;
      }
      this.emit('grid-enter', { name: path.basename(name), appCursor: !!this.appCursor, appKeypad: !!this.appKeypad });
    } else {
      // A program stepping aside mid-run (neomutt showing a message) prints on
      // a fresh page below what is already there, never over it.
      const b = this.current;
      if (this.state === 'running' && b && !b.finished) this._newSegment(b);
      this.emit('grid-exit');
    }
  }

  // Is the running program reading a secret? A terminal in line mode with echo
  // switched off is exactly that: sudo, ssh and read -s all ask this way.
  _checkSecret() {
    if (this.secretTimer) return;
    this.secretTimer = setTimeout(() => {
      this.secretTimer = null;
      if (this.state !== 'running' || this.grid || !this.pty || this.disposed) { this._setSecret(false); return; }
      const flag = process.platform === 'darwin' ? '-f' : '-F';
      execFile('stty', [flag, this.pty._pty, '-a'], (err, out) => {
        if (err) return;
        const words = out.split(/[\s;]+/);
        this._setSecret(this.state === 'running' && !this.grid && words.includes('-echo') && words.includes('icanon'));
      });
    }, 120);
  }
  _setSecret(on) {
    if (on === !!this.secret) return;
    this.secret = on;
    this.emit('secret', { on });
  }

  _onText(text, fromStderr) {
    // Which arrow-key codes the program expects. It may say so before it
    // switches screens, so this is tracked across the whole stream.
    for (const m of text.matchAll(/\x1b\[\?1([hl])|\x1b([=>])/g)) {
      if (m[1]) this.appCursor = m[1] === 'h'; else this.appKeypad = m[2] === '=';
    }
    if (this.grid) { this.emit('grid-data', text); return; }
    // zsh's line editor redraws its line between commands; only a command's
    // own output (after 133;C) belongs in the document.
    if (this.kind === 'zsh' && !fromStderr && (this.state !== 'running' || !this.outputStarted)) {
      // Before the command starts, zsh may still ask something (setopt
      // CORRECT: "correct 'sl' to 'ls' [nyae]?"). Text not followed by the
      // command's start within half a second is passed on after all.
      if (this.state === 'running') {
        this.preStart = (this.preStart || '') + text;
        clearTimeout(this.preStartTimer);
        this.preStartTimer = setTimeout(() => {
          const t = this.preStart; this.preStart = '';
          if (this.state === 'running' && !this.outputStarted && t && this.current) {
            const visible = t.slice(t.lastIndexOf('\r') + 1);
            this.current.term.write(visible.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), () => this._schedule(this.current));
          }
        }, 500);
      }
      return;
    }
    if (this.state === 'running') this._checkSecret();
    let block;
    if (fromStderr) block = this.blocks.get(this.errEndCount + 1);
    else if (this.state === 'running') block = this.current;
    else if (this.state === 'ready') block = this.last;      // late background output
    if (!block) return;
    block.term.write(text, () => this._schedule(block));
  }

  _onStderr(data) {
    // The pipe has no terminal in front of it, so newlines need a carriage return.
    const parts = data.split('\x1e');
    parts.forEach((part, i) => {
      if (i > 0) {                                  // an end-of-stderr mark
        this.errEndCount++;
        const b = this.blocks.get(this.errEndCount);
        if (b) { b.errDone = true; this._tryFinish(b); }
      }
      if (!part) return;
      const block = this.blocks.get(this.errEndCount + 1);
      if (block && !this.grid) this.emit('block-stderr', { id: block.id, text: part });
      this.errScanner.push(part.replace(/\r?\n/g, '\r\n'));
    });
  }

  _onDone(code) {
    this._setSecret(false);
    this.doneCount++;
    this.state = 'settling';
    if (this.grid) this._setGrid(false);
    const b = this.blocks.get(this.doneCount);
    if (b) { b.ptyDone = true; b.exitCode = code; this._tryFinish(b); }
  }

  _onCwd(url) {
    let p = url.replace(/^file:\/\/[^/]*/, '');
    try { p = decodeURIComponent(p); } catch {}
    const host = (url.match(/^file:\/\/([^/]*)/) || [])[1] || os.hostname();
    this.emit('cwd', { user: os.userInfo().username, host, path: p, home: os.homedir() , prompt: this.prompt || '', shell: this.kind });
  }

  _tryFinish(b) {
    if (!(b.ptyDone && b.errDone) || b.finished) return;
    this.blocks.delete(b.seq);
    // An empty write runs after everything already queued has been parsed.
    b.term.write('', () => {
      this._flush(b);
      b.finished = true;
      this.emit('block-end', { id: b.id, exitCode: b.exitCode, lines: b.lines, ms: Date.now() - b.started });
      if (b !== this.last) b.term.dispose();
    });
  }

  _schedule(b) {
    if (b.timer) return;
    b.timer = setTimeout(() => { b.timer = null; this._flush(b); }, 50);
  }

  // Send the part of the block that may have changed: everything from the top
  // of the screen at the last flush. Lines above that have scrolled away and
  // can no longer be rewritten by the program.
  _flush(b) {
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    const buf = b.term.buffer.active;
    let end = buf.baseY + buf.cursorY;                       // last line, inclusive
    const lastLine = buf.getLine(end);
    if (buf.cursorX === 0 && lastLine && lastLine.translateToString(true) === '') end--;
    const start = buf.baseY < b.sentBase ? 0 : b.sentBase;   // screen was cleared
    const cell = buf.getNullCell();
    const rows = [];
    for (let y = start; y <= end; y++) {
      const line = buf.getLine(y);
      if (!line) break;
      const next = buf.getLine(y + 1);
      const continues = y < end && next && next.isWrapped;
      rows.push({ w: line.isWrapped ? 1 : 0, r: serialize(line, cell, !continues) });
    }
    let lines = 0;
    for (let y = 0; y <= end; y++) { const l = buf.getLine(y); if (l && !l.isWrapped) lines++; }
    b.lines = b.offsetLines + lines;
    b.sentBase = buf.baseY;
    this.emit('block-output', { id: b.id, start: b.offset + start, rows, cursor: { row: b.offset + buf.baseY + buf.cursorY, col: buf.cursorX } });
  }

  _newTerm() {
    return new Terminal({ cols: this.cols, rows: this.rows, scrollback: 50000, allowProposedApi: true });
  }

  // Freeze what the block shows so far and carry on in a fresh terminal.
  _newSegment(b) {
    this._flush(b);
    const buf = b.term.buffer.active;
    let end = buf.baseY + buf.cursorY;
    const last = buf.getLine(end);
    if (buf.cursorX === 0 && last && last.translateToString(true) === '') end--;
    b.offset += end + 1;
    b.offsetLines = b.lines;
    b.term.dispose();
    b.term = this._newTerm();
    b.sentBase = 0;
  }
}

// One screen row -> runs of text with the same colour and weight.
function serialize(line, cell, trim) {
  const runs = [];
  let cur = null;
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;                     // second half of a wide char
    let f;
    if (cell.isFgRGB()) f = '#' + cell.getFgColor().toString(16).padStart(6, '0');
    else if (cell.isFgPalette()) { const n = cell.getFgColor(); f = n < 16 ? n : xterm256(n); }
    const b = cell.isBold() ? 1 : 0, u = cell.isUnderline() ? 1 : 0;
    const ch = cell.getChars() || ' ';
    if (cur && cur.f === f && cur.b === b && cur.u === u) cur.t += ch;
    else { cur = { t: ch, f, b, u }; runs.push(cur); }
  }
  if (trim) {
    while (runs.length) {
      const r = runs[runs.length - 1];
      r.t = r.t.replace(/\s+$/, '');
      if (r.t) break;
      runs.pop();
    }
  }
  return runs.map(r => {
    const o = { t: r.t };
    if (r.f !== undefined) o.f = r.f;
    if (r.b) o.b = 1;
    if (r.u) o.u = 1;
    return o;
  });
}

module.exports = { Session, Scanner };
