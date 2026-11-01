'use strict';
// Bookmarks: how a bookmark line is read, and how a call to one becomes a command.
//
// A bookmark is typed as a comment, so bash ignores it if Enter is pressed by
// mistake. The label comes first, like a label on a jar, and ends at ": ":
//
//   #vps: ssh forge                               "vps", no arguments
//   #sync music: rclone sync <> . --progress      "sync", one argument; "music" is a description
//   #notes: find . -type f -iname '*<>*'          one argument, inside the quotes
//   #copy: cp <src> <dst>                         named places: src, then dst
//   #copy(2): cp                                  exactly 2 arguments, added at the end
//   #copy(2..): cp -v   #l(..1): ls -l   #copy(1..3): cp      at least 2, at most 1, 1 to 3
//   #burn: dd if=<iso> of=<disk:/dev/sdb>         a default, used when left out
//   #install: sudo apt install -y <..>            <..> or <name..>: any number of arguments
//
// A line without a label (no # in front) is a bookmark without a name.
//
// Used at the end of another command, after #@, a bookmark is added to it,
// much like a global alias: with "#|count: wc -l" saved, "ls -1F #@count"
// runs "ls -1F | wc -l". The | in the label means "pipe into this"; without
// it the bookmark's text is simply added. Several can follow each other:
// "ls #@sorted @count". Bash ignores the #@ part as a comment.
// \<> (or \<name>) is a literal <> for the rare bash redirection, not a place.
// Older forms are still read: "ssh forge#vps" and "ssh forge =vps".
//
// Loaded by the page as a plain script (window.Bookmarks) and by the tests
// with require().

(function (root) {
  const NAME = /^([A-Za-z0-9_][\w.-]*)(?::(\d*)(\.\.)?(\d*))?(?:\s+(.*))?$/;
  // A place, or an escaped place that stands for itself. <name:default> has a
  // default; <..> (or <name..>) takes any number of arguments.
  // A default may name another place: <to:<from>>.
  const PLACE = /\\(<(?:[A-Za-z_][\w-]*)?(?:\.\.)?(?::(?:<[A-Za-z_][\w-]*>|[^<>\n])*)?>)|<([A-Za-z_][\w-]*)?(\.\.)?(?::((?:<[A-Za-z_][\w-]*>|[^<>\n])*))?>/g;
  const REF = /<([A-Za-z_][\w-]*)>/g;
  const shown = d => String(d).replace(REF, '$1');      // <from> is said "from" 

  // The position of the last # outside quotes, or -1.
  function lastHash(line) {
    let q = null, esc = false, last = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && q !== "'") { esc = true; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '#') last = i;
    }
    return last;
  }

  // Positions of " =" outside quotes: where a name may start.
  function eqMarks(line) {
    let q = null, esc = false;
    const out = [];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && q !== "'") { esc = true; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '=' && i > 0 && /\s/.test(line[i - 1])) out.push(i);
    }
    return out;
  }

  // #name(count) description: command
  const LABEL = /^#\s*(\|?)\s*([A-Za-z0-9_][\w.-]*)(?:\((\d*)(\.\.)?(\d*)\))?((?:\s+[^:]*)?):\s+(\S.*)$/;
  const specOf = (lo, range, hi) => !(lo || range || hi) ? null
    : !range ? { min: +lo || 0, max: +lo || 0 } : { min: lo ? +lo : 0, max: hi ? +hi : Infinity };

  // ---- a command per machine: #update: [:anvil "...", :brainpower :hammer '...', :* "..."]
  // The name of this machine comes from the main process (setMachine): see
  // machine() in main.js. Names are exact; :* is for any other machine.
  let thisMachine = '';
  const setMachine = m => { thisMachine = String(m || ''); };

  // The list of [:name "command", ...], or null when the command is not
  // written that way (a test such as [ -f x ] stays a command).
  function parseVariants(text) {
    const s = String(text).trim();
    if (!s.startsWith('[') || !s.endsWith(']')) return null;
    const c = [...s.slice(1, -1)];
    const out = [];
    let machines = [], i = 0;
    while (i < c.length) {
      const ch = c[i];
      if (/\s/.test(ch) || ch === ',') {
        if (ch === ',' && machines.length) return null;   // a name without a command
        i++;
      } else if (ch === ':') {
        i++;
        const start = i;
        while (i < c.length && /[\p{L}\p{N}_.\-*]/u.test(c[i])) i++;
        if (i === start) return null;
        machines.push(c.slice(start, i).join(''));
      } else if (ch === '"' || ch === "'") {
        if (!machines.length) return null;
        i++;
        let cmd = '';
        for (;;) {
          if (i >= c.length) return null;
          if (c[i] === ch) { i++; break; }
          if (ch === '"' && c[i] === '\\' && (c[i + 1] === '"' || c[i + 1] === '\\')) { cmd += c[i + 1]; i += 2; continue; }
          cmd += c[i++];
        }
        out.push({ machines, command: cmd });
        machines = [];
      } else return null;
    }
    return out.length && !machines.length ? out : null;
  }
  const pick = (vs, m) => vs.find(v => v.machines.includes(m)) || vs.find(v => v.machines.includes('*')) || null;
  const machineList = vs => vs.flatMap(v => v.machines).map(m => (m === '*' ? 'any other machine' : m));

  function parse(raw) { return parseOn(raw, thisMachine); }

  // A bookmark as it is on the machine m.
  function parseOn(raw, mach) {
    raw = String(raw).trim();
    const label = LABEL.exec(raw);
    if (label) {
      const command = label[7].trim(), spec = specOf(label[3], label[4], label[5]);
      const vs = parseVariants(command);
      if (!vs) return { ...build(raw, command, label[2], label[6].trim(), spec), pipe: !!label[1], machine: mach };
      const chosen = pick(vs, mach);
      const b = build(raw, chosen ? chosen.command : '', label[2], label[6].trim(), spec);
      return {
        ...b, command, variants: vs, machine: mach, pipe: !!label[1],
        missing: chosen ? null : `${label[2]} has no command for this machine (${mach}); it has commands for ${machineList(vs).join(', ')}.`,
      };
    }
    raw = raw.replace(/^#\s*/, '');                    // a comment without a label: no name
    let command = raw, name = '', desc = '', spec = null;
    // The name: after the last " =" whose remainder reads as a name, or
    // (the older form) after a final #.
    let at = -1, m = null;
    for (const i of eqMarks(raw).reverse()) {
      const t = NAME.exec(raw.slice(i + 1).trim());
      if (t && raw.slice(0, i).trim()) { at = i; m = t; break; }
    }
    if (at < 0) {
      const h = lastHash(raw);
      if (h > 0) { m = NAME.exec(raw.slice(h + 1).trim()); at = m ? h : -1; }
    }
    if (at > 0) {
      const before = raw.slice(0, at).trimEnd();
      if (m && before) {
        command = before;
        name = m[1];
        desc = (m[5] || '').trim();
        spec = specOf(m[2], m[3], m[4]);
      }
    }
    return { ...build(raw, command, name, desc, spec), machine: mach };
  }

  function build(raw, command, name, desc, spec) {
    let m;
    // The command split into text and places; each place refers to a slot.
    const slots = [], parts = [], named = new Map();
    let last = 0;
    PLACE.lastIndex = 0;
    while ((m = PLACE.exec(command))) {
      if (m.index > last) parts.push({ text: command.slice(last, m.index) });
      last = PLACE.lastIndex;
      if (m[1]) { parts.push({ text: m[1] }); continue; }   // \<> stays as <>
      const pname = m[2], rest = !!m[3], def = m[4];
      let slot;
      // A name used again is the same place; so is a second <..>.
      if (pname && named.has(pname)) slot = named.get(pname);
      else if (!pname && rest && slots.some(s => s.rest && !s.name)) slot = slots.findIndex(s => s.rest && !s.name);
      else if (rest && slots.some(s => s.rest)) { parts.push({ text: m[0] }); continue; }   // only one place for the rest
      else {
        slot = slots.length;
        slots.push({ name: pname || '', rest });
        if (pname) named.set(pname, slot);
      }
      if (def !== undefined && slots[slot].default === undefined) slots[slot].default = def;
      parts.push({ slot });
    }
    if (last < command.length) parts.push({ text: command.slice(last) });
    // Without a count, every place up to the last one without a default must be
    // given; a place for the rest takes any number, none included.
    const fixed = slots.filter(s => !s.rest);
    let required = 0;
    fixed.forEach((s, i) => { if (s.default === undefined) required = i + 1; });
    const hasRest = slots.some(s => s.rest);
    const min = spec ? spec.min : required;
    const max = spec ? Math.max(spec.max, spec.min) : (hasRest ? Infinity : slots.length);
    return { raw, command, name, desc, slots, parts, min, max, spec, variants: [], machine: thisMachine, missing: null };
  }

  // A bookmark as it is written and stored: "#name(count) description: command",
  // or just the command when it has no name.
  function format(b) {
    if (!b.name) return b.command;
    let count = '';
    if (b.spec) {
      const { min, max } = b.spec;
      count = min === max ? `(${min})` : `(${min || ''}..${max === Infinity ? '' : max})`;
    }
    return `#${b.pipe ? '|' : ''}${b.name}${count}${b.desc ? ' ' + b.desc : ''}: ${b.command}`;
  }

  // Split what was typed into words, keeping each word exactly as typed.
  function tokenize(s) {
    const out = [];
    let cur = '', q = null, esc = false, inTok = false;
    for (const c of String(s)) {
      if (esc) { cur += c; esc = false; continue; }
      if (c === '\\' && q !== "'") { cur += c; esc = true; inTok = true; continue; }
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; inTok = true; continue; }
      if (/\s/.test(c)) { if (inTok) { out.push(cur); cur = ''; inTok = false; } continue; }
      cur += c; inTok = true;
    }
    if (inTok) out.push(cur);
    return out;
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function argText(b) {
    let t;
    if (b.max === 0) t = 'no arguments';
    else if (b.min === b.max) t = plural(b.min, 'argument');
    else if (b.max === Infinity) t = b.min ? `at least ${plural(b.min, 'argument')}` : 'any number of arguments';
    else if (b.min === 0) t = `up to ${plural(b.max, 'argument')}`;
    else t = `${b.min} to ${b.max} arguments`;
    const names = [];
    b.slots.forEach((s, i) => {
      const name = s.rest ? (s.name ? `${s.name}, any number` : 'the rest') : s.name;
      if (s.default !== undefined) {
        if (!name) names.push(`argument ${i + 1} defaults to ${shown(s.default)}`);
        else names.push(s.rest ? `${name}, defaulting to ${shown(s.default)}` : `${name} defaults to ${shown(s.default)}`);
      } else if (name && !(s.rest && !s.name && b.slots.length === 1)) names.push(name);
    });
    return names.length ? `${t}: ${names.join(', ')}` : t;
  }

  // What a screen reader says about a bookmark: name, description, arguments.
  function describe(b) {
    const v = [b.name || b.command, b.pipe && 'piped into', b.desc];
    if (b.variants && b.variants.length) {
      v.push(`for ${machineList(b.variants).join(', ')}`);
      if (b.missing) return [...v, `none for this machine (${b.machine})`].filter(Boolean).join('. ');
    }
    return [...v, argText(b)].filter(Boolean).join('. ');
  }

  // The command that runs on this machine, places and all.
  function thisCommand(b) {
    if (!b.variants || !b.variants.length) return b.command;
    const v = pick(b.variants, b.machine);
    return v ? v.command : '';
  }

  // Arguments are expected: some are required, or a place takes any number.
  const wantsArgs = b => b.min > 0 || b.slots.some(s => s.rest);

  // The machine a running ssh (or mosh) is connected to: the host as typed,
  // without user@. Takes the command line or its words. Null for anything else.
  function remoteMachine(command) {
    const words = (Array.isArray(command) ? command : tokenize(String(command))).map(w => w.replace(/^['"]|['"]$/g, ''));
    const prog = (words[0] || '').split('/').pop();
    if (!['ssh', 'mosh', 'autossh'].includes(prog)) return null;
    const withValue = ['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-M', '--ssh', '--port'];
    for (let i = 1; i < words.length; i++) {
      if (withValue.includes(words[i])) { i++; continue; }
      if (words[i].startsWith('-')) continue;
      return words[i].split('@').pop();
    }
    return null;
  }

  // "command #@name args @other args": the position of #@ (outside quotes,
  // at the start or after a space), or -1.
  function inlineAt(line) {
    let q = null, esc = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && q !== "'") { esc = true; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '#' && line[i + 1] === '@' && (i === 0 || /\s/.test(line[i - 1]))) return i;
    }
    return -1;
  }

  // Expand the #@ calls at the end of a line. find(name) gives a parsed
  // bookmark or nothing. Returns null when the line has no #@.
  function expandInline(line, find) {
    const at = inlineAt(line);
    if (at < 0) return null;
    let command = line.slice(0, at).trimEnd();
    const calls = [];
    for (const w of tokenize(line.slice(at + 1))) {
      if (w.startsWith('@')) calls.push({ name: w.slice(1), args: [] });
      else if (calls.length) calls[calls.length - 1].args.push(w);
    }
    for (const c of calls) {
      if (!c.name) return { error: 'A bookmark name is missing after @.' };
      const b = find(c.name);
      if (!b) return { error: `No bookmark called ${c.name}.` };
      const r = expand(b, c.args);
      if (r.error) return r;
      command = !command ? r.command : `${command}${b.pipe ? ' | ' : ' '}${r.command}`;
    }
    return { command };
  }

  function expand(b, args) {
    if (b.missing) return { error: b.missing };
    const n = args.length, who = b.name || 'This bookmark';
    if (n < b.min || n > b.max) return { error: `${who} takes ${argText(b)}; you gave ${n}.` };
    // Which arguments go to which place: a place for the rest takes what the
    // others leave over, at its own position; left-out places take their defaults.
    const fixed = b.slots.filter(s => !s.rest).length;
    const restN = Math.max(0, n - fixed);
    const values = [];
    let k = 0;
    b.slots.forEach((s, i) => {
      if (s.rest) { if (restN) { values[i] = args.slice(k, k + restN).join(' '); k += restN; } }
      else if (k < n) values[i] = args[k++];
    });
    for (let i = 0; i < b.slots.length; i++) {
      const s = b.slots[i];
      if (values[i] === undefined && s.default === undefined && !s.rest)
        return { error: `${who} is missing ${s.name ? `<${s.name}>` : `argument ${i + 1}`}.` };
    }
    // A default that names another place (<to:<from>>) takes that place's value.
    const given = j => (values[j] !== undefined ? values[j] : (b.slots[j].default ?? ''));
    const value = i => {
      if (values[i] !== undefined) return values[i];
      return String(b.slots[i].default ?? '').replace(REF, (all, n) => {
        const j = b.slots.findIndex(s => s.name === n);
        return j >= 0 && j !== i ? given(j) : all;
      });
    };
    let command = b.parts.map(p => (p.slot === undefined ? p.text : value(p.slot))).join('');
    if (k < n) command = `${command.trimEnd()} ${args.slice(k).join(' ')}`;
    return { command };
  }

  const api = { parse, parseOn, parseVariants, setMachine, thisCommand, wantsArgs, remoteMachine, format, tokenize, expand, expandInline, inlineAt, describe, argText, lastHash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bookmarks = api;
})(this);
