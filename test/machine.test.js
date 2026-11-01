'use strict';
// A command per machine, and bookmarks inside ssh. A pretend ssh (a bare
// shell that shows itself as `ssh forge`) stands in for a server.
//
//   xvfb-run -a node --test --test-timeout=600000 test/machine.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
let app, w, dir;
const wait = ms => new Promise(r => setTimeout(r, ms));
const spokenNow = () => w.textContent('#live-now');
const spoken = () => w.textContent('#live');
const outText = () => w.evaluate(() => [...document.querySelectorAll('.block')].pop().querySelector('.out').textContent);
async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}
async function run(command, ms = 900) {
  await w.fill('#cmd', command);
  await w.press('#cmd', 'Enter');
  await wait(ms);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textsmith-machine-'));
  const config = path.join(dir, 'config'), bin = path.join(dir, 'bin');
  fs.mkdirSync(config); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(config, 'bookmarks'), [
    '# notes stay',
    'machine: anvil',
    '#update: [:brainpower "echo updating brainpower", :forge "echo updating forge -y && echo again -y"]',
    '#get: [:forge "echo get <..>"]',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nPS1="remote$ " exec -a ssh bash --norc --noprofile -i -s "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.bashrc'), "alias vps='ssh forge'\n");
  app = await electron.launch({
    args: [ROOT, '--no-sandbox'], cwd: ROOT,
    env: {
      ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, TEXTSMITH_SHELL: '/bin/bash',
      TEXTSMITH_USER_DATA: path.join(dir, 'userdata'), TEXTSMITH_CONFIG: config, TEXTSMITH_MACHINE: 'brainpower',
    },
  });
  w = await app.firstWindow();
  await w.waitForLoadState('domcontentloaded');
  w.on('pageerror', e => { throw e; });
  await until(() => w.title().then(t => t.includes('@') || t.includes(':')), 'the shell');
  await wait(800);
});

after(async () => {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bookmark with a command per machine runs this machine\'s', async () => {
  await w.press('#cmd', 'Control+Space');
  await w.keyboard.type('update');
  await w.press('#cmd', 'Enter');
  await until(async () => (await outText()).trim() === 'updating brainpower', 'brainpower\'s command');
});

test('inside ssh, a bookmark goes into the box with the remote machine\'s command, once', async () => {
  await run('ssh forge', 1200);
  await w.press('#cmd', 'Control+Space');
  await w.keyboard.type('update');
  await w.press('#cmd', 'Enter');
  assert.equal(await w.inputValue('#cmd'), 'echo updating forge -y && echo again -y');
  await until(async () => (await spoken()).startsWith('In the box for ssh: echo updating forge'), 'what was put in the box');
  await w.press('#cmd', 'Enter');
  await until(async () => /updating forge -y\s+again -y/.test(await outText()), 'the command run once on forge');
  assert.doesNotMatch(await outText(), /-yecho|-yupdating/);   // not typed twice, run together
  await run('exit', 1000);
});

test('through an alias, the list has a row per machine, forge first', async () => {
  await run('vps', 1200);
  await w.keyboard.press('Alt+Shift+B');
  await wait(600);
  const labels = await w.evaluate(() => [...document.querySelectorAll('#finder-list button')].map(b => b.textContent));
  assert.deepEqual(labels.filter(l => l.startsWith('update')), [
    'update, for forge: echo updating forge -y && echo again -y',
    'update, for brainpower: echo updating brainpower',
  ]);
  await w.keyboard.type('update');                      // typing filters
  await wait(300);
  await w.keyboard.press('ArrowDown');                  // into the list: forge's row
  await w.keyboard.press('ArrowDown');                  // the next: brainpower's
  await w.keyboard.press('Enter');
  assert.equal(await w.inputValue('#cmd'), 'echo updating brainpower');
  await w.fill('#cmd', '');
  await w.keyboard.press('Alt+Shift+B');                // one with arguments: typed with its places
  await wait(600);
  await w.keyboard.type('get');
  await wait(300);
  await w.keyboard.press('Enter');
  assert.equal(await w.inputValue('#cmd'), 'echo get <..>');
  await w.fill('#cmd', '');
  await run('exit', 1000);
});

test('the bookmarks file keeps its notes when saved; an old machine: line counts for nothing', async () => {
  await w.fill('#cmd', '#hi: echo hi');
  await w.press('#cmd', 'Alt+m');
  await wait(600);
  const text = fs.readFileSync(path.join(dir, 'config', 'bookmarks'), 'utf8');
  assert.match(text, /^# notes stay\n/);
  assert.match(text, /#hi: echo hi/);
});
