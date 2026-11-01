'use strict';
// End-to-end tests: start The Textsmith, drive it from the keyboard the way a
// person would, and check what is on the page and what would be spoken.
//
//   npm run test:ui                  (opens a window while it runs)
//   xvfb-run -a npm run test:ui      (keeps it out of sight on Linux)
//
// Tests for vim and python are skipped when those programs are not installed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const has = cmd => { try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; } };

let app, w, dir;
const wait = ms => new Promise(r => setTimeout(r, ms));

// Text spoken through the two live regions (they empty themselves after a while).
const spokenNow = () => w.textContent('#live-now');
const spoken = () => w.textContent('#live');
const lastBlock = sel => w.evaluate(s => { const b = [...document.querySelectorAll('.block')].pop(); return s ? [...b.querySelectorAll(s)].map(e => e.textContent) : b.innerText; }, sel);
const outText = () => lastBlock('.out').then(o => o[0]);
const meta = () => w.evaluate(() => [...document.querySelectorAll('.block')].pop().querySelector('.meta').textContent);
const focused = () => w.evaluate(() => { const a = document.activeElement; return { tag: a.tagName, id: a.id, text: a.textContent.slice(0, 80) }; });

async function run(command, ms = 800) {
  await w.fill('#cmd', command);
  await w.press('#cmd', 'Enter');
  await wait(ms);
}
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);      // the page may still be loading
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textsmith-test-'));
  // A history file and a settings folder of its own, so your real ones are untouched.
  fs.writeFileSync(path.join(dir, 'history'), 'echo from an earlier session\nls -la\n');
  app = await electron.launch({
    args: [ROOT, '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, HISTFILE: path.join(dir, 'history'), TEXTSMITH_USER_DATA: path.join(dir, 'userdata'), TEXTSMITH_CONFIG: path.join(dir, 'config') },
  });
  w = await app.firstWindow();
  await w.waitForLoadState('domcontentloaded');
  w.on('pageerror', e => { throw e; });
  await until(() => w.title().then(t => t.includes('@')), 'the shell to report its directory');
  await run(`cd ${dir}`);
});

after(async () => {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a command becomes a heading with its output under it', async () => {
  await run('echo hello world');
  assert.deepEqual(await lastBlock('h2'), ['echo hello world']);
  assert.match(await outText(), /^hello world$/);
  assert.match(await meta(), /^done, 1 line/);
  assert.match(await w.title(), new RegExp(path.basename(dir)));
});

test('a failing command is marked and its errors are in the errors view', async () => {
  await run('ls /definitely-missing');
  assert.match(await meta(), /failed, exit code 2/);
  await w.keyboard.press('Alt+2');
  assert.match(await spoken(), /Errors only, \d+ commands? with errors/);
  assert.match(await lastBlock('.err').then(e => e[0]), /No such file or directory/);
  await w.keyboard.press('Alt+1');
  await w.keyboard.press('Escape');
});

test('Alt+Up moves through command headings', async () => {
  await w.focus('#cmd');
  await w.keyboard.press('Alt+ArrowUp');
  assert.equal((await focused()).tag, 'H2');
  await w.keyboard.press('Escape');
  assert.equal((await focused()).id, 'cmd');
});

test('man page references and web addresses become links', async () => {
  await run("printf 'see ls(1) or https://example.com/page.\\n'");
  const links = await w.evaluate(() => [...[...document.querySelectorAll('.block')].pop().querySelectorAll('a')].map(a => a.dataset.man || a.dataset.url));
  assert.deepEqual(links, ['1 ls', 'https://example.com/page']);
});

test('Tab completes file names and steps through several matches', async () => {
  await run('touch quarto--x.tar.gz quarto-notes.md "my file.txt" && mkdir sub');
  await w.fill('#cmd', 'rm quarto--');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'rm quarto--x.tar.gz ', 'a single match');
  await w.fill('#cmd', 'rm qu');
  await w.press('#cmd', 'Tab');
  await until(async () => /2 matches/.test(await spokenNow()), 'two matches announced');
  assert.equal(await w.inputValue('#cmd'), 'rm quarto-');
  await w.press('#cmd', 'Tab');
  assert.match(await w.inputValue('#cmd'), /^rm quarto-(notes\.md|-x\.tar\.gz)$/);
  await w.fill('#cmd', 'cat my');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'cat my\\ file.txt ', 'an escaped name');
  await w.fill('#cmd', 'cd su');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'cd sub/', 'a directory');
  assert.equal((await focused()).id, 'cmd', 'Tab never leaves the box');
  await w.fill('#cmd', '');
});

test('completion leaves history and the exit status alone', async () => {
  await run('false');
  await w.fill('#cmd', 'ls qu');
  await w.press('#cmd', 'Tab');
  await wait(500);
  await run('echo "status=$?"; history 2 | head -1');
  const out = await outText();
  assert.match(out, /status=1/);
  assert.doesNotMatch(out, /__anvil_complete/);
});

test('lines typed into a running program become sub-headings; secret input does not', async () => {
  await run('cat', 400);
  await run('hello cat', 600);
  await w.press('#cmd', 'Control+d');
  await until(async () => /done/.test(await meta()), 'cat to finish');
  assert.deepEqual(await lastBlock('h3'), ['hello cat']);

  await run('read -rs secret; echo "length ${#secret}"', 400);
  await run('s3cret', 800);
  assert.deepEqual(await lastBlock('h3'), []);
  assert.match(await outText(), /length 6/);
});

test('a program with its own prompt answers aloud', { skip: !has('python3') && 'python3 not installed' }, async () => {
  await run('python3 -q', 1200);
  await run('print(6*7)', 1000);
  assert.match(await spoken(), /^42/);
  await run('exit()', 1000);
  assert.deepEqual(await lastBlock('h3'), ['print(6*7)', 'exit()']);
});

test('a full-screen list program: selection is spoken, F2 shows it as a page', async () => {
  await run(path.join(__dirname, 'fixtures', 'menu.sh'), 1000);
  assert.equal(await w.title(), 'Menu.sh, active');
  await w.keyboard.press('j');
  await until(async () => (await spokenNow()) === 'banana bread', 'the selection to be read');

  await w.keyboard.press('F2');
  await until(async () => (await focused()).tag === 'BUTTON', 'the screen page');
  const items = await w.evaluate(() => [...document.querySelectorAll('#review-body button')].map(b => b.textContent + (b.getAttribute('aria-current') ? ' *' : '')));
  assert.deepEqual(items, ['apple pie', 'banana bread *', 'cherry tart', 'date loaf', 'elderberry jam']);

  await w.keyboard.press('Tab');                 // to "cherry tart"
  await w.keyboard.press('Enter');
  await until(async () => (await w.textContent('#review-body')).includes('You chose cherry tart'), 'the item to be opened');

  await w.keyboard.press('F2');                  // back to the program
  assert.equal((await focused()).tag, 'TEXTAREA');
  await w.keyboard.press('q');
  await until(async () => (await focused()).id === 'cmd', 'the program to end');
  assert.match(await w.title(), /The Textsmith$/);
});

test('in vim, moving reads lines, characters and words', { skip: !has('vim') && 'vim not installed' }, async () => {
  fs.writeFileSync(path.join(dir, 'v.txt'), 'Hello, big world.\nsecond line\n');
  await run('vim -u DEFAULTS -i NONE -n v.txt', 1300);
  const after = async (key, expected) => {
    await w.keyboard.press(key);
    await until(async () => (await spokenNow()) === expected, `"${expected}" after ${key}`, 3000);
  };
  await after('ArrowDown', 'second line');
  await after('ArrowUp', 'Hello, big world.');
  for (let i = 0; i < 4; i++) { await w.keyboard.press('ArrowRight'); await wait(200); }
  await after('ArrowRight', 'comma');                 // one step: the character
  await after('ArrowRight', 'space');
  await after('w', 'big');
  await after('Alt+l', 'Hello, big world.');
  await w.keyboard.press('Escape');
  await w.keyboard.type(':q!');
  await w.keyboard.press('Enter');
  await until(async () => (await focused()).id === 'cmd', 'vim to quit');
});

test('Tab inside a running shell (as over ssh) comes back into the box', async () => {
  fs.writeFileSync(path.join(dir, 'docker-restic-backup.log'), 'x');
  fs.writeFileSync(path.join(dir, 'notes-one.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'notes-two.txt'), 'x');
  await run("env -i HOME=$HOME TERM=xterm-256color PS1='remote$ ' bash --norc --noprofile -i", 1000);
  try {

  await w.fill('#cmd', 'cat docker-res');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'cat docker-restic-backup.log ', 'the remote completion in the box', 5000);
  await until(async () => (await spokenNow()) === 'docker-restic-backup.log', 'the completion to be read');

  await w.fill('#cmd', 'ls notes-');
  await w.press('#cmd', 'Tab');
  await until(async () => /2 matches/.test(await spokenNow()), 'the remote list of matches', 5000);
  assert.equal(await w.inputValue('#cmd'), 'ls notes-');

  await w.fill('#cmd', 'cat docker-restic-backup.log');
  await w.press('#cmd', 'Enter');
  await wait(700);
  assert.ok((await lastBlock('h3')).includes('cat docker-restic-backup.log'));
  } finally {
    await run('exit', 800);
    await until(async () => /done/.test(await meta()), 'the inner shell to end');
  }
});

test('Alt+C opens the current block in a text box for selecting and copying', async () => {
  await run("printf 'IPv6: 2a02:c207::1\\nsecond line\\n'");
  await w.keyboard.press('Control+Shift+C');
  assert.equal((await focused()).tag, 'TEXTAREA');
  assert.equal(await w.inputValue('#copy-text'), 'IPv6: 2a02:c207::1\nsecond line');
  await w.keyboard.press('End');
  await w.keyboard.press('Shift+Home');
  const sel = await w.evaluate(() => { const t = document.getElementById('copy-text'); return t.value.slice(t.selectionStart, t.selectionEnd); });
  assert.equal(sel, 'IPv6: 2a02:c207::1');
  await w.keyboard.type('x');                 // the text cannot be changed
  await w.keyboard.press('Backspace');
  assert.equal(await w.inputValue('#copy-text'), 'IPv6: 2a02:c207::1\nsecond line');
  await w.keyboard.press('Escape');
  assert.equal(await w.evaluate(() => document.getElementById('copy').hidden), true);
});

test('history from earlier sessions is there on Up', async () => {
  await w.fill('#cmd', '');
  for (let i = 0; i < 60; i++) {                 // walk back past this run's commands
    await w.press('#cmd', 'ArrowUp');
    if ((await w.inputValue('#cmd')) === 'echo from an earlier session') break;
  }
  assert.equal(await w.inputValue('#cmd'), 'echo from an earlier session');
  await w.fill('#cmd', '');
});

test('Shift+Enter runs the command with sudo', async () => {
  await w.fill('#cmd', 'true');
  await w.press('#cmd', 'Shift+Enter');
  await wait(800);
  assert.deepEqual(await lastBlock('h2'), ['sudo true']);
});

test('a password prompt hides what is typed and keeps it out of headings', async () => {
  await run('read -rs -p "Password: " pw; echo; echo "got ${#pw}"', 900);
  assert.equal(await w.getAttribute('#cmd', 'type'), 'password');
  assert.match(await w.textContent('#cmd-label'), /^Password for read/);
  await w.fill('#cmd', 'hunter2');
  await w.press('#cmd', 'Enter');
  await until(async () => /done/.test(await meta()), 'the command to finish');
  assert.equal(await w.getAttribute('#cmd', 'type'), 'text');
  assert.match(await outText(), /got 7/);
  assert.doesNotMatch(await lastBlock(), /hunter2/);
});

test('Ctrl+B bookmarks a command; Alt+B lists bookmarks and runs one', async () => {
  await w.fill('#cmd', 'echo bookmarked one');
  await w.press('#cmd', 'Alt+m');
  await until(async () => /Bookmarked: echo bookmarked one/.test(await spoken()), 'the bookmark to be announced');
  await w.fill('#cmd', 'echo bookmarked two');
  await w.press('#cmd', 'Alt+m');
  await w.fill('#cmd', '');
  await w.keyboard.press('Alt+Shift+B');
  await until(async () => (await focused()).text === 'echo bookmarked two', 'the bookmark list');         // newest first
  await w.keyboard.press('ArrowDown');
  assert.equal((await focused()).text, 'echo bookmarked one');
  await w.keyboard.press('Enter');
  await wait(800);
  assert.deepEqual(await lastBlock('h2'), ['echo bookmarked one']);
  const saved = fs.readFileSync(path.join(dir, 'config', 'bookmarks'), 'utf8').split('\n').filter(l => l && !/^#(\s|#|$)/.test(l));
  assert.deepEqual(saved, ['echo bookmarked one', 'echo bookmarked two']);

  await w.keyboard.press('Alt+Shift+B');                                      // Delete removes one
  await until(async () => (await focused()).tag === 'BUTTON', 'the bookmark list');
  await w.keyboard.press('Delete');
  await until(async () => /Bookmark removed: echo bookmarked two/.test(await spoken()), 'the removal to be announced');
  await w.keyboard.press('Escape');
});

test('Ctrl+R searches history; Ctrl+Enter puts a match in the box', async () => {
  await w.fill('#cmd', '');
  await w.press('#cmd', 'Control+r');
  assert.equal((await focused()).id, 'finder-q');
  await w.keyboard.type('earlier');
  await until(async () => /1 match: echo from an earlier session/.test(await spokenNow()), 'the match to be read');
  await w.keyboard.press('Control+Enter');
  assert.equal(await w.inputValue('#cmd'), 'echo from an earlier session');
  assert.equal((await focused()).id, 'cmd');
  await w.fill('#cmd', '');
});

test('Ctrl+Shift+T opens a tab with its own shell; exit closes it', async () => {
  const opened = app.context().waitForEvent('page');
  await w.keyboard.press('Control+Shift+T');
  const w2 = await opened;
  await until(async () => /Tab 2 of 2\. .*@/.test(await w2.textContent('#live')), 'the new tab to announce itself');
  assert.match(await w2.textContent('#where'), /^Tab 2 of 2 · /);
  await w2.keyboard.press('Control+PageUp');
  await until(async () => /^Tab 1 of 2\./.test(await w.textContent('#live')), 'the first tab to announce itself');
  await w.keyboard.press('Control+PageDown');
  await w2.fill('#cmd', 'exit');
  await w2.press('#cmd', 'Enter').catch(() => {});   // the tab closes under our feet
  await until(async () => app.context().pages().length === 1, 'the tab to close');
  await until(async () => !(await w.textContent('#where')).startsWith('Tab'), 'the tab count to go away');
});

test('named bookmarks with arguments are called by name with Ctrl+Space', async () => {
  fs.mkdirSync(path.join(dir, 'music'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'music', 'song.mp3'), 'x');
  await w.fill('#cmd', 'echo syncing <> into . --progress#sync music');
  await w.press('#cmd', 'Alt+m');
  await until(async () => /Bookmarked: sync\. music\. 1 argument/.test(await spoken()), 'the named bookmark');
  await w.fill('#cmd', 'echo copy <src> to <dst> and back to <src>#copy');
  await w.press('#cmd', 'Alt+m');
  await w.fill('#cmd', 'pwd#here');
  await w.press('#cmd', 'Alt+m');

  await w.fill('#cmd', 'half typed');
  await w.press('#cmd', 'Control+Space');
  assert.equal(await w.textContent('#cmd-label'), 'Bookmark');
  assert.equal(await w.inputValue('#cmd'), '');

  await w.keyboard.type('sy');                          // Tab completes the name
  await w.press('#cmd', 'Tab');
  assert.equal(await w.inputValue('#cmd'), 'sync ');
  await until(async () => (await spokenNow()) === 'sync. music. 1 argument', 'the bookmark described');

  await w.press('#cmd', 'Enter');                       // no argument: told, nothing runs
  await until(async () => (await spokenNow()) === 'sync takes 1 argument; you gave 0.', 'the missing argument');
  assert.equal(await w.textContent('#cmd-label'), 'Bookmark');

  await w.keyboard.type('mu');                          // arguments complete like files
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'sync music/', 'the folder completed');
  await w.press('#cmd', 'Enter');
  await wait(800);
  assert.deepEqual(await lastBlock('h2'), ['echo syncing music/ into . --progress']);
  assert.equal(await w.textContent('#cmd-label'), 'Command');

  await w.press('#cmd', 'Control+Space');
  await w.keyboard.type('copy a.txt b/');
  await w.press('#cmd', 'Enter');
  await wait(800);
  assert.match(await outText(), /^copy a\.txt to b\/ and back to a\.txt$/);

  await w.press('#cmd', 'Control+Space');               // Escape gives back what was in the box
  await w.keyboard.press('Escape');
  assert.equal(await w.textContent('#cmd-label'), 'Command');
  await w.fill('#cmd', '');
});

test('Alt+B: a bookmark without arguments runs; one with arguments asks for them', async () => {
  await w.keyboard.press('Alt+Shift+B');
  await until(async () => (await focused()).tag === 'BUTTON', 'the bookmark list');
  const labels = await w.evaluate(() => [...document.querySelectorAll('#finder-list button')].map(b => b.textContent));
  assert.deepEqual(labels.slice(0, 3), ['here: pwd', 'copy: echo copy <src> to <dst> and back to <src>', 'sync: echo syncing <> into . --progress']);
  await w.keyboard.press('Enter');                      // "here" has no arguments
  await wait(800);
  assert.deepEqual(await lastBlock('h2'), ['pwd']);

  await w.keyboard.press('Alt+Shift+B');
  await until(async () => (await focused()).tag === 'BUTTON', 'the bookmark list');
  await w.keyboard.press('ArrowDown');                  // "copy" needs two
  await w.keyboard.press('Enter');
  assert.equal(await w.textContent('#cmd-label'), 'Bookmark');
  assert.equal(await w.inputValue('#cmd'), 'copy ');
  await until(async () => /copy\. 2 arguments: src, dst/.test(await spoken()), 'what copy needs');
  await w.keyboard.press('Escape');
  await w.fill('#cmd', '');
});

test('word-list completions from complete -W work', async () => {
  fs.writeFileSync(path.join(dir, 'backup.sh'), '#!/bin/sh\necho "backing up $1"\n', { mode: 0o755 });
  await run('complete -W "docs project" backup.sh');
  await w.fill('#cmd', './backup.sh p');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === './backup.sh project ', 'project completed');
  await w.fill('#cmd', '');
});

test('the title shows your prompt and the shell', async () => {
  await run("PS1='\\u at \\W\\$ '");
  await until(async () => / at .* — bash — The Textsmith$/.test(await w.title()), 'the prompt in the title');
  assert.ok((await w.title()).includes(` at ${path.basename(dir)} — bash`));
});

test('Ctrl+Comma opens preferences; changes apply at once and are saved', async () => {
  await w.focus('#cmd');
  await w.keyboard.press('Control+Comma');
  await until(async () => (await focused()).id === 'prefs-title', 'the preferences page');
  const headings = await w.evaluate(() => [...document.querySelectorAll('#prefs h2')].map(h => h.textContent));
  await until(async () => /^Version \d+\.\d+\.\d+$/.test(await w.textContent('#about-version')), 'the version in About');
  assert.deepEqual(headings, ['Display', 'Speech', 'Editing', 'Title and start', 'Keyboard', 'About']);

  await w.selectOption('#prefs select >> nth=1', 'contrast');           // colours
  assert.equal(await w.evaluate(() => document.documentElement.dataset.theme), 'contrast');
  await w.selectOption('#prefs select >> nth=0', 'line');               // traditional lines
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'config', 'prefs.json'), 'utf8'));
  await until(async () => saved().display.commandStyle === 'line', 'the file to be written');
  assert.equal(saved().display.theme, 'contrast');

  // Rebind "Bookmark the command" to Ctrl+K; Ctrl+R is refused as taken.
  const btn = '#prefs button[data-action="bookmark"]';
  await w.click(btn);
  await w.keyboard.press('Control+r');
  await until(async () => /Ctrl\+R is already used for Search history/.test(await spoken()), 'the clash to be explained');
  await w.click(btn);
  await w.keyboard.press('Control+k');
  await until(async () => /now Ctrl\+K/.test(await spoken()), 'the new key');
  assert.match(await w.textContent(btn), /Bookmark the command in the box: Ctrl\+K/);
  assert.equal(saved().keys.bookmark, 'Ctrl+K');

  await w.keyboard.press('Escape');
  assert.equal(await w.evaluate(() => document.getElementById('prefs').hidden), true);
  await run('echo styled');
  assert.match((await lastBlock('h2'))[0], /\$ echo styled$/);              // prompt, $, command
  await w.fill('#cmd', 'echo via ctrl k#viak');
  await w.press('#cmd', 'Control+k');
  await until(async () => /Bookmarked: viak/.test(await spoken()), 'Ctrl+K to bookmark');

  // Back to the defaults for anything after this.
  await w.keyboard.press('Control+Comma');
  await w.selectOption('#prefs select >> nth=0', 'heading');
  await w.selectOption('#prefs select >> nth=1', 'system');
  await w.click('#prefs button:has-text("Reset all keys")');
  await w.keyboard.press('Escape');
  await w.fill('#cmd', '');
});

test('the launcher options: --working-directory and -e', async () => {
  const second = await electron.launch({
    args: [ROOT, '--no-sandbox', '--working-directory', dir, '-e', 'echo', 'started with -e'], cwd: ROOT,
    env: { ...process.env, HISTFILE: path.join(dir, 'history'), TEXTSMITH_USER_DATA: path.join(dir, 'userdata2'), TEXTSMITH_CONFIG: path.join(dir, 'config') },
  });
  try {
    const p = await second.firstWindow();
    await until(() => p.evaluate(() => [...document.querySelectorAll('.block h2')].map(h => h.textContent).join('|')), 'the command', 8000);
    assert.equal(await p.evaluate(() => document.querySelector('.block h2').textContent), "echo 'started with -e'");
    await until(async () => (await p.evaluate(() => document.querySelector('.block .out').textContent)) === 'started with -e', 'its output');
    assert.ok((await p.title()).includes(path.basename(dir)));
  } finally { await second.close(); }
});

test('Ctrl+B clears the box; Ctrl+Shift+B bookmarks and runs', async () => {
  await w.fill('#cmd', 'echo kept#keep');
  await w.press('#cmd', 'Alt+m');
  await until(async () => /Bookmarked: keep/.test(await spoken()), 'the bookmark');
  assert.equal(await w.inputValue('#cmd'), '');

  await w.fill('#cmd', 'echo ran at once#once');
  await w.press('#cmd', 'Alt+Shift+M');
  await wait(900);
  assert.deepEqual(await lastBlock('h2'), ['echo ran at once']);

  await w.fill('#cmd', 'echo hello <who>#greet');             // needs an argument: asks for it
  await w.press('#cmd', 'Alt+Shift+M');
  assert.equal(await w.textContent('#cmd-label'), 'Bookmark');
  assert.equal(await w.inputValue('#cmd'), 'greet ');
  await w.keyboard.type('world');
  await w.press('#cmd', 'Enter');
  await wait(900);
  assert.match(await outText(), /^hello world$/);
});

test('Alt+B, Ctrl+Enter edits a bookmark; Enter saves it in place', async () => {
  await w.keyboard.press('Alt+Shift+B');
  await until(async () => (await focused()).text === 'greet: echo hello <who>', 'the bookmark list');
  await w.keyboard.press('Control+Enter');
  assert.equal(await w.textContent('#cmd-label'), 'Edit bookmark');
  assert.equal(await w.inputValue('#cmd'), '#greet: echo hello <who>');
  await w.fill('#cmd', '#greet: echo good morning <who>');
  await w.press('#cmd', 'Enter');
  await until(async () => /Bookmark saved: greet/.test(await spoken()), 'the save');
  assert.equal(await w.textContent('#cmd-label'), 'Command');
  assert.equal(await w.inputValue('#cmd'), '');
  const saved = fs.readFileSync(path.join(dir, 'config', 'bookmarks'), 'utf8');
  assert.match(saved, /^#greet: echo good morning <who>$/m);
  assert.doesNotMatch(saved, /echo hello <who>/);
  assert.notEqual((await lastBlock('h2'))[0], 'echo good morning <who>');   // nothing ran
});

test('a bookmark typed as a comment with a label: #name: command', async () => {
  await w.fill('#cmd', '#organise txt: echo organised <ext>');
  await w.press('#cmd', 'Alt+m');
  await until(async () => /Bookmarked: organise\. txt\. 1 argument: ext/.test(await spoken()), 'the bookmark');
  const saved = fs.readFileSync(path.join(dir, 'config', 'bookmarks'), 'utf8');
  assert.match(saved, /^#organise txt: echo organised <ext>$/m);
  await w.press('#cmd', 'Control+Space');
  await w.keyboard.type('organise md');
  await w.press('#cmd', 'Enter');
  await wait(900);
  assert.deepEqual(await lastBlock('h2'), ['echo organised md']);
});

test('readline keys edit the command box', async () => {
  await w.fill('#cmd', 'git commit -m message');
  await w.press('#cmd', 'Control+a');
  assert.equal(await w.evaluate(() => document.getElementById('cmd').selectionStart), 0);
  await w.press('#cmd', 'Control+f');
  await w.press('#cmd', 'Control+b');                                // back one character, as in bash
  assert.equal(await w.evaluate(() => document.getElementById('cmd').selectionStart), 0);
  assert.equal(await w.evaluate(() => document.getElementById('finder').hidden), true);
  await w.press('#cmd', 'Alt+f');                                   // after "git"
  await w.press('#cmd', 'Control+k');
  assert.equal(await w.inputValue('#cmd'), 'git');
  await until(async () => (await spokenNow()) === 'Deleted commit -m message', 'the deleted text');
  await w.press('#cmd', 'Control+y');
  assert.equal(await w.inputValue('#cmd'), 'git commit -m message');
  await w.press('#cmd', 'Control+w');
  assert.equal(await w.inputValue('#cmd'), 'git commit -m ');
  await w.press('#cmd', 'Control+u');
  assert.equal(await w.inputValue('#cmd'), '');
  await w.fill('#cmd', 'echo hello');
  await w.press('#cmd', 'Control+a');
  await w.press('#cmd', 'Alt+f');
  await w.press('#cmd', 'Alt+c');                                    // capitalise the next word
  assert.equal(await w.inputValue('#cmd'), 'echo Hello');
  await w.press('#cmd', 'Control+a');
  await w.press('#cmd', 'Alt+u');
  assert.equal(await w.inputValue('#cmd'), 'ECHO Hello');
  await w.fill('#cmd', 'cat ');
  await w.press('#cmd', 'Alt+Period');                               // last word of the previous command
  assert.match(await w.inputValue('#cmd'), /^cat \S+$/);
  assert.equal(await w.evaluate(() => document.getElementById('copy').hidden), true);
  await w.fill('#cmd', '');
});

test('#@name at the end of a command adds a bookmark, like a global alias', async () => {
  await w.fill('#cmd', '#|count: wc -l');
  await w.press('#cmd', 'Alt+m');
  await until(async () => /Bookmarked: count\. piped into/.test(await spoken()), 'the pipe bookmark');
  await run('printf "a\\nb\\nc\\n" #@count');
  assert.deepEqual(await lastBlock('h2'), ['printf "a\\nb\\nc\\n" | wc -l']);
  assert.match(await outText(), /^\s*3$/);

  await w.fill('#cmd', 'ls #@cou');                                  // Tab completes the name
  await w.press('#cmd', 'Tab');
  assert.equal(await w.inputValue('#cmd'), 'ls #@count ');
  await w.fill('#cmd', 'ls #@nothing');
  await w.press('#cmd', 'Enter');
  await until(async () => (await spokenNow()) === 'No bookmark called nothing.', 'the unknown name');
  assert.equal(await w.inputValue('#cmd'), 'ls #@nothing');
  await w.fill('#cmd', '');
});

test('quotes close as they are opened', async () => {
  await w.fill('#cmd', '');
  await w.focus('#cmd');
  await w.keyboard.type('echo "hi');
  assert.equal(await w.inputValue('#cmd'), 'echo "hi"');
  await w.keyboard.type('" ');                                       // steps over the closing quote
  assert.equal(await w.inputValue('#cmd'), 'echo "hi" ');
  await w.keyboard.type("'");
  assert.equal(await w.inputValue('#cmd'), "echo \"hi\" ''");
  await w.keyboard.press('Backspace');                               // an empty pair goes at once
  assert.equal(await w.inputValue('#cmd'), 'echo "hi" ');
  await w.keyboard.type("it's");                                     // no pair after a letter
  assert.equal(await w.inputValue('#cmd'), "echo \"hi\" it's");
  await w.fill('#cmd', '');
});

test('a pager in the document: Space for the next page, q to quit', async () => {
  await run('seq 1 300 | LESS=FRXMK less', 1200);
  await until(async () => /^Pager/.test(await w.textContent('#cmd-label')), 'the pager to be recognised');
  assert.match(await outText(), /lines 1-\d+/);
  await w.focus('#cmd');
  await w.keyboard.press('Space');
  await until(async () => /\n60\n/.test(await outText()), 'the next page');
  assert.equal(await w.inputValue('#cmd'), '');
  await w.keyboard.press('q');
  await until(async () => /done/.test(await meta()), 'the pager to quit');
  assert.equal(await w.textContent('#cmd-label'), 'Command');
});

test('Tab inside loops and lists completes the command being typed, and variables', async () => {
  await run('TSREPO=drive:Documents; TSPASS=secret');
  await w.fill('#cmd', 'for s in a b; do ech');                       // a command after do
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'for s in a b; do echo ', 'echo after do');
  await w.fill('#cmd', 'for s in a b; do git che');                   // its arguments, as git completes them
  await w.press('#cmd', 'Tab');
  await until(async () => /checkout/.test(await spokenNow()), 'git subcommands after do');
  await w.fill('#cmd', 'for s in a b; do echo -r $TSRE');             // a variable
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'for s in a b; do echo -r $TSREPO ', 'the variable');
  await w.fill('#cmd', 'true && echo "$TSPA');                         // in quotes: the quote is closed
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'true && echo "$TSPASS" ', 'the quoted variable');
  await w.fill('#cmd', 'echo ${TSRE');
  await w.press('#cmd', 'Tab');
  await until(async () => (await w.inputValue('#cmd')) === 'echo ${TSREPO} ', 'the braced variable');
  await w.fill('#cmd', 'ls | sort -r | hea');                         // after a pipe
  await w.press('#cmd', 'Tab');
  await until(async () => /^ls \| sort -r \| head/.test(await w.inputValue('#cmd')) || /head/.test(await spokenNow()), 'a command after a pipe');
  await w.fill('#cmd', '');
});
