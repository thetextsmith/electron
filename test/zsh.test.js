'use strict';
// The same checks as ui.test.js where the shell matters, with zsh.
//   npm run test:zsh        (skipped when zsh is not installed)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const has = cmd => { try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !has('zsh') && 'zsh not installed';

let app, w, dir;
const wait = ms => new Promise(r => setTimeout(r, ms));
const spokenNow = () => w.textContent('#live-now');
const spoken = () => w.textContent('#live');
const lastBlock = sel => w.evaluate(s => { const b = [...document.querySelectorAll('.block')].pop(); return s ? [...b.querySelectorAll(s)].map(e => e.textContent) : b.innerText; }, sel);
const outText = () => lastBlock('.out').then(o => o[0]);
const meta = () => w.evaluate(() => [...document.querySelectorAll('.block')].pop().querySelector('.meta').textContent);
const focused = () => w.evaluate(() => { const a = document.activeElement; return { tag: a.tagName, id: a.id, text: a.textContent.slice(0, 80) }; });
async function run(command, ms = 900) { await w.fill('#cmd', command); await w.press('#cmd', 'Enter'); await wait(ms); }
async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textsmith-zsh-'));
  fs.writeFileSync(path.join(dir, 'zsh_history'), ': 1700000000:0;echo from zsh history\n: 1700000001:0;ls -la\n');
  fs.writeFileSync(path.join(dir, '.zshrc'), "PS1='%n at %1~%# '\nREPO_FROM_RC=drive:Documents\nsetopt CORRECT\nhello_world() { echo it ran }\n");
  app = await electron.launch({
    args: [ROOT, '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, TEXTSMITH_SHELL: 'zsh', ZDOTDIR: dir, HISTFILE: path.join(dir, 'zsh_history'),
      TEXTSMITH_USER_DATA: path.join(dir, 'userdata'), TEXTSMITH_CONFIG: path.join(dir, 'config') },
  });
  w = await app.firstWindow();
  await w.waitForLoadState('domcontentloaded');
  await until(() => w.title().then(t => / — zsh — /.test(t)), 'zsh to report itself in the title', 10000);
  await run(`cd ${dir}`);
});
after(async () => { if (app) await app.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('your own .zshrc is read, and its prompt is in the title', { skip }, async () => {
  assert.match(await w.title(), new RegExp(`at ${path.basename(dir)} — zsh — The Textsmith$`));
  await run('echo $REPO_FROM_RC');
  assert.equal(await outText(), 'drive:Documents');
});

test('a command becomes a heading; output, errors and exit codes', { skip }, async () => {
  await run('echo hello; ls /definitely-missing');
  assert.deepEqual(await lastBlock('h2'), ['echo hello; ls /definitely-missing']);
  assert.match(await outText(), /^hello\nls: .*No such file/);
  assert.match(await meta(), /failed, exit code 2/);
  assert.match((await lastBlock('.err'))[0], /No such file or directory/);
});

test('loops and comments', { skip }, async () => {
  await run('for i in 1 2; do echo "n$i"; done # a comment');
  assert.equal(await outText(), 'n1\nn2');
});

test('Tab uses zsh completion, inside loops too, and for variables', { skip }, async () => {
  fs.mkdirSync(path.join(dir, 'music'));
  await w.fill('#cmd', 'git che');
  await w.press('#cmd', 'Tab');
  await until(async () => /checkout/.test(await spokenNow()), 'git subcommands');
  await w.fill('#cmd', 'for s in a b; do ech');
  await w.press('#cmd', 'Tab');
  await until(async () => /echo/.test(await spokenNow() + await w.inputValue('#cmd')), 'a command after do');
  await w.fill('#cmd', 'echo $REPO_FR');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'echo $REPO_FROM_RC ', 'a variable');
  await w.fill('#cmd', 'cd mu');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'cd music/', 'a folder');
  await w.fill('#cmd', '');
  await run('echo still fine');                                      // the shell is not left waiting
  assert.equal(await outText(), 'still fine');
});

test('history from the zsh history file is there on Up', { skip }, async () => {
  await w.fill('#cmd', '');
  for (let i = 0; i < 40; i++) {
    await w.press('#cmd', 'ArrowUp');
    if ((await w.inputValue('#cmd')) === 'echo from zsh history') break;
  }
  assert.equal(await w.inputValue('#cmd'), 'echo from zsh history');
  await w.fill('#cmd', '');
});

test('a password prompt is hidden', { skip }, async () => {
  await run('read -rs "pw?Password: "; echo; echo "got ${#pw}"', 1000);
  assert.equal(await w.getAttribute('#cmd', 'type'), 'password');
  await w.fill('#cmd', 'hunter2');
  await w.press('#cmd', 'Enter');
  await until(async () => /done/.test(await meta()), 'the command to finish');
  assert.match(await outText(), /got 7/);
  assert.doesNotMatch(await lastBlock(), /hunter2/);
});

test('bookmarks and #@ aliases', { skip }, async () => {
  await w.fill('#cmd', '#|count: wc -l');
  await w.press('#cmd', 'Alt+m');
  await until(async () => /Bookmarked: count/.test(await spoken()), 'the bookmark');
  await run('printf "a\\nb\\n" #@count');
  assert.deepEqual(await lastBlock('h2'), ['printf "a\\nb\\n" | wc -l']);
  assert.match(await outText(), /^\s*2$/);
});

test('a pager in the document', { skip }, async () => {
  await run('seq 1 300 | LESS=FRXMK less', 1200);
  await until(async () => /^Pager/.test(await w.textContent('#cmd-label')), 'the pager');
  await w.focus('#cmd');
  await w.keyboard.press('Space');
  await until(async () => /\n60\n/.test(await outText()), 'the next page');
  await w.keyboard.press('q');
  await until(async () => /done/.test(await meta()), 'the pager to quit');
});

test('a full-screen program takes over and gives back', { skip: skip || (!has('vim') && 'vim not installed') }, async () => {
  await run('vim -u DEFAULTS -i NONE -n', 1300);
  assert.equal(await w.title(), 'Vim, active');
  await w.keyboard.type(':q!');
  await w.keyboard.press('Enter');
  await until(async () => (await focused()).id === 'cmd', 'vim to quit');
  await run('echo after vim');
  assert.equal(await outText(), 'after vim');
});

test("zsh's spelling question is read out and takes one key", { skip }, async () => {
  await run('helo_world', 1300);
  assert.match(await outText(), /correct 'helo_world' to 'hello_world' \[nyae\]\?/);
  assert.match(await w.textContent('#cmd-label'), /^Answer: Y yes/);
  await w.focus('#cmd');
  await w.keyboard.press('y');
  await until(async () => /done/.test(await meta()), 'the corrected command');
  assert.match(await outText(), /it ran$/);
  await run('echo next');
  assert.equal(await outText(), 'next');
});
