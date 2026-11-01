'use strict';
// Runs a few commands through the session without Electron and prints what
// the window would be told.   node test/smoke.js
const { Session } = require('../session');
const cmds = [
  'echo hello',
  'ls /definitely-missing',
  'echo out; echo err >&2; false',
  "printf 'working...\\rdone      \\n'",
  'ls /nope 2>&1 | cat; ls /nope2 | cat',
  'cd /tmp',
  'foo(',
  "printf '\\033[31mred\\033[0m plain\\n'",
  "printf 'before\\n\\033[?1049hGRID STUFF\\033[?1049l'; echo after",
  'seq 1 200 | tail -3',
];
const s = new Session({ cols: 80, rows: 24 });
const text = rows => rows.map(r => (r.w ? '' : '\n') + r.r.map(x => x.t).join('')).join('').slice(1);
const out = new Map();
let i = 0, pendingEnd = false;
const next = () => { if (i < cmds.length) s.submit(cmds[i++]); else { s.dispose(); process.exit(0); } };
let isReady = false, ended = true;
const maybe = () => { if (isReady && ended) { isReady = false; ended = false; next(); } };
s.on('ready', () => { isReady = true; maybe(); });
s.on('cwd', c => console.log('  [cwd]', c.path));
s.on('block-start', b => { out.set(b.id, []); console.log(`\n## ${b.command}`); });
s.on('block-output', o => { const a = out.get(o.id); a.length = o.start; a.push(...o.rows); });
s.on('block-stderr', e => console.log('  [stderr]', JSON.stringify(e.text)));
s.on('grid-enter', g => console.log('  [grid-enter]', g.name));
s.on('grid-data', d => console.log('  [grid-data]', JSON.stringify(d)));
s.on('grid-exit', () => console.log('  [grid-exit]'));
s.on('block-end', e => {
  console.log(text(out.get(e.id)));
  console.log(`  [end] exit ${e.exitCode}, ${e.lines} lines`, JSON.stringify(out.get(e.id).flatMap(r => r.r).filter(r => r.f !== undefined)));
  ended = true; maybe();
});
s.start();
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
