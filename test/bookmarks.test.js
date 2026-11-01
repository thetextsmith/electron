'use strict';
// How bookmark lines are read and how calls are filled in.   node --test test/bookmarks.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../renderer/bookmarks');

const run = (line, ...args) => B.expand(B.parse(line), args);

test('a name after # is split off, with or without a space', () => {
  assert.deepEqual([B.parse('ssh forge#vps').command, B.parse('ssh forge#vps').name], ['ssh forge', 'vps']);
  assert.deepEqual([B.parse('ssh forge #vps').command, B.parse('ssh forge #vps').name], ['ssh forge', 'vps']);
  assert.equal(B.parse('ssh forge').name, '');
});

test('words after the name are a description', () => {
  const b = B.parse('rclone sync <> . --progress#sync music');
  assert.equal(b.name, 'sync');
  assert.equal(b.desc, 'music');
  assert.equal(B.describe(b), 'sync. music. 1 argument');
});

test('a # inside quotes or in ${#x} is not a name', () => {
  assert.equal(B.parse("echo '#nope'").name, '');
  assert.equal(B.parse('echo ${#x}').name, '');
  assert.equal(B.parse("grep '#todo' notes.md#todos").name, 'todos');
});

test('anonymous places are filled in order, even inside quotes', () => {
  assert.deepEqual(run('rclone sync <> . --progress#sync', 'drive:Music'), { command: 'rclone sync drive:Music . --progress' });
  assert.deepEqual(run("find . -type f -iname '*<>*'#notes", 'artificial'), { command: "find . -type f -iname '*artificial*'" });
});

test('named places take arguments in order of first use and repeat', () => {
  assert.deepEqual(run('cp <src> <dst> && ls -l <dst>#copy', 'a.txt', 'b/'), { command: 'cp a.txt b/ && ls -l b/' });
  assert.equal(B.argText(B.parse('cp <src> <dst>#copy')), '2 arguments: src, dst');
});

test('a count without places adds the arguments at the end', () => {
  assert.deepEqual(run('cp#copy:2', 'a', 'b'), { command: 'cp a b' });
  assert.deepEqual(run('cp -v#copy:2..', 'a', 'b', 'c/'), { command: 'cp -v a b c/' });
  assert.deepEqual(run('ls#l:..1'), { command: 'ls' });
  assert.deepEqual(run('ls#l:..1', '/tmp'), { command: 'ls /tmp' });
});

test('the wrong number of arguments is explained', () => {
  assert.equal(run('rclone sync <> .#sync').error, 'sync takes 1 argument; you gave 0.');
  assert.equal(run('cp#copy:2..', 'a').error, 'copy takes at least 2 arguments; you gave 1.');
  assert.equal(run('ls#l:..1', 'a', 'b').error, 'l takes up to 1 argument; you gave 2.');
  assert.equal(run('ssh forge#vps', 'x').error, 'vps takes no arguments; you gave 1.');
  assert.equal(run('cp <src> <dst>#copy:1..', 'a').error, 'copy is missing <dst>.');
});

test('arguments keep their quotes', () => {
  assert.deepEqual(B.tokenize(`copy "my file.txt" it\\'s 'a b'`), ['copy', '"my file.txt"', "it\\'s", "'a b'"]);
  assert.deepEqual(run('cp <> <>#copy', '"my file.txt"', 'b/'), { command: 'cp "my file.txt" b/' });
});

test('a bookmark typed as a comment with a label: #name: command', () => {
  const b = B.parse('#organise txt: mkdir -p <txt> && find . -type f -name "*.<txt>" -exec mv {} <txt>/ +');
  assert.equal(b.name, 'organise');
  assert.equal(b.desc, 'txt');
  assert.deepEqual(B.expand(b, ['txt']), { command: 'mkdir -p txt && find . -type f -name "*.txt" -exec mv {} txt/ +' });
  assert.deepEqual([B.parse('#vps: ssh forge').command, B.parse('#vps: ssh forge').name], ['ssh forge', 'vps']);
  assert.deepEqual(run('#copy(2): cp', 'a', 'b'), { command: 'cp a b' });
  assert.equal(B.argText(B.parse('#copy(2..): cp -v')), 'at least 2 arguments');
  assert.equal(B.argText(B.parse('#l(..1): ls -l')), 'up to 1 argument');
});

test('only the label part is read: = $ & and colons in the command are left alone', () => {
  const b = B.parse('#burn: dd if=<iso> of=/dev/sdb bs=1M status=progress');
  assert.equal(b.name, 'burn');
  assert.equal(b.command, 'dd if=<iso> of=/dev/sdb bs=1M status=progress');
  assert.equal(B.parse('#same: [ "$a" = "$b" ] && echo same &').command, '[ "$a" = "$b" ] && echo same &');
  assert.equal(B.parse('#web: curl https://example.com/a#top').command, 'curl https://example.com/a#top');
  assert.equal(B.parse('[ "$a" = "$b" ] && echo same').name, '');      // no # in front: no name
  assert.equal(B.parse('#ssh forge').name, '');                           // a comment without a label
  assert.equal(B.parse('#ssh forge').command, 'ssh forge');
});

test('format writes the label form back', () => {
  for (const line of ['#vps: ssh forge', '#sync music: rclone sync <> .', '#copy(2): cp', '#copy(2..): cp -v', '#l(..1): ls', '#c(1..3): cp'])
    assert.equal(B.format(B.parse(line)), line);
  assert.equal(B.format(B.parse('ssh forge#vps')), '#vps: ssh forge');       // older forms become labels
  assert.equal(B.format(B.parse('ssh forge =vps')), '#vps: ssh forge');
  assert.equal(B.format(B.parse('ls -la')), 'ls -la');
});

test('\\<> is a literal <>, not a place', () => {
  const b = B.parse('#open: exec 3\\<>/dev/tcp/<host>/80');
  assert.deepEqual(b.slots.map(s => s.name), ['host']);
  assert.deepEqual(B.expand(b, ['example.com']), { command: 'exec 3<>/dev/tcp/example.com/80' });
  assert.equal(B.parse('#e: echo \\<html\\>').slots.length, 0);
});

test('#@name adds a bookmark to the end of a command, like a global alias', () => {
  const marks = ['#|count: wc -l', '#|sorted: sort', '#|grab: grep -i <>', '#quiet: 2>/dev/null', '#vps: ssh forge'].map(B.parse);
  const find = n => marks.find(b => b.name === n);
  assert.equal(B.format(marks[0]), '#|count: wc -l');
  assert.equal(B.describe(marks[0]), 'count. piped into. no arguments');
  assert.deepEqual(B.expandInline('ls -1F #@count', find), { command: 'ls -1F | wc -l' });
  assert.deepEqual(B.expandInline('find . -type f #@grab TODO @sorted @count', find), { command: 'find . -type f | grep -i TODO | sort | wc -l' });
  assert.deepEqual(B.expandInline('make #@quiet', find), { command: 'make 2>/dev/null' });
  assert.deepEqual(B.expandInline('#@vps', find), { command: 'ssh forge' });
  assert.equal(B.expandInline('ls #@nope', find).error, 'No bookmark called nope.');
  assert.equal(B.expandInline('ls #@grab', find).error, 'grab takes 1 argument; you gave 0.');
  assert.equal(B.expandInline('echo "#@count"', find), null);              // inside quotes
  assert.equal(B.expandInline('echo a#@count', find), null);               // not after a space
  assert.equal(B.expandInline('ls -la', find), null);
});

// ---- defaults and any number of arguments, as in the GTK version ----

test('a default is filled in when left out', () => {
  const b = B.parse('#burn: dd if=<iso> of=<disk:/dev/sdb> bs=1M');
  assert.deepEqual([b.min, b.max], [1, 2]);
  assert.deepEqual(B.expand(b, ['a.iso']), { command: 'dd if=a.iso of=/dev/sdb bs=1M' });
  assert.deepEqual(B.expand(b, ['a.iso', '/dev/sdc']), { command: 'dd if=a.iso of=/dev/sdc bs=1M' });
  assert.equal(B.expand(b, []).error, 'burn takes 1 to 2 arguments: iso, disk defaults to /dev/sdb; you gave 0.');
  assert.equal(B.describe(b), 'burn. 1 to 2 arguments: iso, disk defaults to /dev/sdb');
  assert.equal(B.format(b), '#burn: dd if=<iso> of=<disk:/dev/sdb> bs=1M');
});

test('defaults repeat with their name; all defaults need no argument', () => {
  assert.deepEqual(run('#mnt: mount <dev> <dir:/mnt> && ls <dir>', '/dev/sdb1'), { command: 'mount /dev/sdb1 /mnt && ls /mnt' });
  const b = B.parse('#serve: python -m http.server <port:8000> --bind <addr:127.0.0.1>');
  assert.equal(B.argText(b), 'up to 2 arguments: port defaults to 8000, addr defaults to 127.0.0.1');
  assert.deepEqual(B.expand(b, []), { command: 'python -m http.server 8000 --bind 127.0.0.1' });
  assert.deepEqual(run('#up: ping -c 3 <host:forge> <:-q>'), { command: 'ping -c 3 forge -q' });
  assert.equal(B.argText(B.parse('#cp2: cp <src:a.txt> <dst>')), '2 arguments: src defaults to a.txt, dst');
  assert.equal(run('#cp4(0..2): cp <src:a.txt> <dst>', 'x').error, 'cp4 is missing <dst>.');
});

test('<..> takes any number of arguments, anywhere', () => {
  const b = B.parse('#install: sudo apt update && sudo apt install -y <..>');
  assert.deepEqual([b.min, b.max], [0, Infinity]);
  assert.equal(B.argText(b), 'any number of arguments');
  assert.deepEqual(B.expand(b, ['vim', 'git', '"my pkg"']), { command: 'sudo apt update && sudo apt install -y vim git "my pkg"' });
  assert.deepEqual(run('#cpto: cp -v <..> <dst> && ls <dst>', 'a', 'b', 'c/'), { command: 'cp -v a b c/ && ls c/' });
  assert.equal(B.argText(B.parse('#cpto: cp -v <..> <dst>')), 'at least 1 argument: the rest, dst');
  assert.deepEqual(run('#pk: echo <pkgs..> && apt install <pkgs..>', 'a', 'b'), { command: 'echo a b && apt install a b' });
  assert.deepEqual(run('#lint: cargo clippy <opts..:--all-targets>'), { command: 'cargo clippy --all-targets' });
  assert.equal(B.argText(B.parse('#lint: cargo clippy <opts..:--all-targets>')), 'any number of arguments: opts, any number, defaulting to --all-targets');
  assert.equal(run('#install(1..): sudo apt install -y <..>').error, 'install takes at least 1 argument; you gave 0.');
  assert.deepEqual(run('#e: echo \\<..>'), { command: 'echo <..>' });
  const marks = ['#|grep: grep -E <..>'].map(B.parse);
  assert.deepEqual(B.expandInline('ls #@grep -i foo', n => marks.find(b => b.name === n)), { command: 'ls | grep -E -i foo' });
});

// ---- a command per machine, as in the GTK version ----

const UPDATE = '#update: [:anvil "sudo apt update -y && sudo apt upgrade -y", :brainpower "sudo pacman -Syu --noconfirm", :hammer "sudo dnf update"]';

test('each machine gets its own command', () => {
  assert.deepEqual(B.expand(B.parseOn(UPDATE, 'brainpower'), []), { command: 'sudo pacman -Syu --noconfirm' });
  assert.deepEqual(B.expand(B.parseOn(UPDATE, 'anvil'), []), { command: 'sudo apt update -y && sudo apt upgrade -y' });
  assert.equal(B.expand(B.parseOn(UPDATE, 'Hammer'), []).error, 'update has no command for this machine (Hammer); it has commands for anvil, brainpower, hammer.');
  assert.equal(B.format(B.parseOn(UPDATE, 'vm')), UPDATE);
  assert.equal(B.describe(B.parseOn(UPDATE, 'anvil')), 'update. for anvil, brainpower, hammer. no arguments');
  assert.equal(B.describe(B.parseOn(UPDATE, 'vm')), 'update. for anvil, brainpower, hammer. none for this machine (vm)');
  B.setMachine('hammer');
  assert.deepEqual(B.expand(B.parse(UPDATE), []), { command: 'sudo dnf update' });
  B.setMachine('');
});

test('several names, a fallback, places and quotes', () => {
  const l = `#up: [:anvil :forge 'sudo apt install -y <..>', :* "echo \\"no apt here\\" <..>"]`;
  assert.deepEqual(B.expand(B.parseOn(l, 'forge'), ['vim', 'git']), { command: 'sudo apt install -y vim git' });
  assert.deepEqual(B.expand(B.parseOn(l, 'other'), ['x']), { command: 'echo "no apt here" x' });
  const d = '#burn(1..2): [:anvil "dd if=<iso> of=<disk:/dev/sdb>", :brainpower "dd if=<iso> of=<disk:/dev/sdc>"]';
  assert.deepEqual(B.expand(B.parseOn(d, 'brainpower'), ['a.iso']), { command: 'dd if=a.iso of=/dev/sdc' });
  assert.equal(B.thisCommand(B.parseOn(d, 'anvil')), 'dd if=<iso> of=<disk:/dev/sdb>');
  assert.equal(B.wantsArgs(B.parseOn(d, 'anvil')), true);
});

test('brackets that are not a list stay a command', () => {
  assert.equal(B.parseOn('#t: [ -f x ]', 'a').variants.length, 0);
  assert.deepEqual(B.expand(B.parseOn('#t: [ -f x ]', 'a'), []), { command: '[ -f x ]' });
  assert.equal(B.parseVariants('[:a]'), null);
  assert.equal(B.parseVariants('["x"]'), null);
  assert.equal(B.parseVariants('[:a "x", :b]'), null);
  assert.equal(B.parseVariants(`[:a:b 'x' :c "y"]`).length, 2);
});

test('the machine an ssh is connected to', () => {
  assert.equal(B.remoteMachine('ssh forge'), 'forge');
  assert.equal(B.remoteMachine('ssh -p 2222 -i ~/.ssh/k ishe@forge.example.com uptime'), 'forge.example.com');
  assert.equal(B.remoteMachine(['ssh', '-A', 'forge']), 'forge');
  assert.equal(B.remoteMachine('mosh forge'), 'forge');
  assert.equal(B.remoteMachine('tmux'), null);
});

// ---- a default that is another place ----

test('a default can be another place', () => {
  const b = B.parse('#send: rclone sync <from> drive:Library/<to:<from>> --progress');
  assert.deepEqual([b.min, b.max], [1, 2]);
  assert.equal(B.argText(b), '1 to 2 arguments: from, to defaults to from');
  assert.deepEqual(B.expand(b, ['Music']), { command: 'rclone sync Music drive:Library/Music --progress' });
  assert.deepEqual(B.expand(b, ['Music', 'Songs']), { command: 'rclone sync Music drive:Library/Songs --progress' });
  assert.equal(B.format(b), '#send: rclone sync <from> drive:Library/<to:<from>> --progress');
  assert.deepEqual(run('#bk: cp <f> <to:<f>.bak>', 'a.txt'), { command: 'cp a.txt a.txt.bak' });
  assert.deepEqual(run('#d: echo <a:x> <b:<a>-y>'), { command: 'echo x x-y' });
  assert.deepEqual(run('#d: echo <a:x> <b:<a>-y>', 'q'), { command: 'echo q q-y' });
  assert.deepEqual(run('#n: echo <a> <b:<zz>>', '1'), { command: 'echo 1 <zz>' });
  assert.deepEqual(run('#e: echo \\<b:<a>>'), { command: 'echo <b:<a>>' });
});
