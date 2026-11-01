'use strict';
/* global prefs, anvil, Keys, $, term, fit, measure, blocks, headingText, setTitle, announce, sayNow, cmd */
// The preferences page (Ctrl+Comma) and applying preferences to the page.
// Loaded after renderer.js, whose top-level names it uses.

// ---------- applying ----------

function applyPrefs() {
  const d = prefs.display, root = document.documentElement;
  if (d.theme === 'system') delete root.dataset.theme; else root.dataset.theme = d.theme;
  const size = Math.min(32, Math.max(10, Number(d.fontSize) || 14));
  root.style.setProperty('--fs', size + 'px');
  root.style.setProperty('--mono', d.font ? `"${d.font}", ${MONO}` : MONO);
  document.body.classList.toggle('no-colours', !d.programColours);
  document.body.classList.toggle('style-line', d.commandStyle === 'line');
  for (const b of blocks.values()) b.h.textContent = headingText(b);
  if (term.options.fontSize !== size || term.options.fontFamily !== (d.font ? `"${d.font}", ${MONO}` : MONO)) {
    term.options.fontSize = size;
    term.options.fontFamily = d.font ? `"${d.font}", ${MONO}` : MONO;
    anvil.send('resize', measure());
  }
  setTitle();
}

anvil.get('prefs').then(p => { if (p) { prefs = p; applyPrefs(); } });

// ---------- the page ----------
// Built from this list, one category per heading level 2.

const FIELDS = [
  ['Display', [
    { key: 'display.commandStyle', label: 'How commands are shown', type: 'select',
      options: [['heading', 'As headings: the command alone'], ['line', 'As a terminal line: prompt, $ and command']],
      hint: 'Either way each command is a heading, so heading navigation keeps working.' },
    { key: 'display.theme', label: 'Colours', type: 'select',
      options: [['system', 'Follow the system'], ['light', 'Light'], ['dark', 'Dark'], ['contrast', 'High contrast']] },
    { key: 'display.fontSize', label: 'Text size in pixels', type: 'number', min: 10, max: 32 },
    { key: 'display.font', label: 'Monospaced font', type: 'text', hint: 'A font name such as "JetBrains Mono". Empty uses the system\'s.' },
    { key: 'display.programColours', label: 'Show colours from programs', type: 'checkbox' },
  ]],
  ['Speech', [
    { key: 'speech.whileRunning', label: 'Read output while a command runs', type: 'checkbox',
      hint: 'Read new output whenever it pauses. Without it, only a summary is read when the command ends.' },
    { key: 'speech.readFullUpTo', label: 'Read finished output in full up to this many lines', type: 'number', min: 0, max: 200,
      hint: 'Longer output is summarised as its line count. 0 always summarises.' },
    { key: 'speech.gridCharacters', label: 'In full-screen programs, read characters and words as the cursor moves', type: 'checkbox' },
    { key: 'speech.wordEcho', label: 'In full-screen programs, read each word when a space is typed', type: 'checkbox' },
  ]],
  ['Editing', [
    { key: 'editing.readline', label: 'Readline keys in the command box, as in bash', type: 'checkbox',
      hint: 'On: Ctrl+A, Ctrl+E, Ctrl+B, Ctrl+F, Alt+B, Alt+F, Ctrl+K, Ctrl+U, Ctrl+W, Ctrl+Y, Alt+D, Alt+Backspace, Alt+C, Alt+U, Alt+L, Ctrl+T and Alt+. work as in bash. Off: desktop keys, as in any text field: Ctrl+A selects everything, Home and End, Ctrl with the arrows moves by word.' },
    { key: 'editing.pairQuotes', label: 'Close quotes as they are opened', type: 'checkbox',
      hint: 'Typing a quote adds the closing one; typing it again steps over it. Never after a letter, as in it\'s.' },
  ]],
  ['Title and start', [
    { key: 'title.format', label: 'Window title', type: 'text',
      hint: '{prompt} is your prompt, {shell} the shell and {app} The Textsmith.' },
    { key: 'startup.directory', label: 'Start in this folder', type: 'text', hint: 'Empty starts in your home folder. ~ means home.' },
    { key: 'startup.shell', label: 'Shell', type: 'select',
      options: [['', 'Your login shell (as set with chsh)'], ['bash', 'bash'], ['zsh', 'zsh']],
      hint: 'Applies to new tabs and windows. Shells other than bash and zsh run bash.' },
  ]],
];

let capturingKeys = false;
const getPref = key => key.split('.').reduce((o, k) => o[k], prefs);
function setPref(key, value) {
  const [group, name] = key.split('.');
  prefs = { ...prefs, [group]: { ...prefs[group], [name]: value } };
  anvil.send('prefs', prefs);
  applyPrefs();
}

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
let fieldId = 0;

function fieldNode(f) {
  const id = 'pref-' + (++fieldId), hintId = id + '-hint';
  const value = getPref(f.key);
  let input;
  if (f.type === 'select') {
    input = el('select', { id });
    for (const [v, l] of f.options) input.append(el('option', { value: v, textContent: l, selected: v === value }));
    input.addEventListener('change', () => { setPref(f.key, input.value); announce('Saved'); });
  } else if (f.type === 'checkbox') {
    input = el('input', { id, type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => { setPref(f.key, input.checked); announce('Saved'); });
  } else {
    input = el('input', { id, type: f.type === 'number' ? 'number' : 'text', value: String(value) });
    if (f.type === 'number') { input.min = f.min; input.max = f.max; }
    input.spellcheck = false;
    input.addEventListener('change', () => {
      let v = input.value;
      if (f.type === 'number') { v = Math.min(f.max, Math.max(f.min, Math.round(Number(v) || 0))); input.value = v; }
      setPref(f.key, v);
      announce('Saved');
    });
  }
  const label = el('label', { htmlFor: id, textContent: f.label });
  const row = el('div', { className: 'field' });
  if (f.type === 'checkbox') row.append(input, label); else row.append(label, input);
  if (f.hint) { row.append(el('p', { className: 'hint', id: hintId, textContent: f.hint })); input.setAttribute('aria-describedby', hintId); }
  return row;
}

// ---------- keyboard shortcuts ----------
// Each action has a button saying its keys. Pressing it records the next
// key combination; Escape cancels. A combination already in use is refused.

function keyButtonText(action) { return `${Keys.label(action)}: ${Keys.list(prefs.keys[action]).join(' or ') || 'none'}`; }

function captureKey(btn, action) {
  capturingKeys = true;
  btn.classList.add('capturing');
  btn.textContent = `Press the new keys for ${Keys.label(action)}, or Escape to cancel`;
  const done = msg => {
    window.removeEventListener('keydown', onKey, true);
    capturingKeys = false;
    btn.classList.remove('capturing');
    btn.textContent = keyButtonText(action);
    if (msg) announce(msg);
  };
  const onKey = e => {
    const combo = Keys.of(e);
    if (!combo) return;                        // a modifier on its own: keep waiting
    e.preventDefault(); e.stopPropagation();
    if (combo === 'Escape') { done('Unchanged'); return; }
    if (!Keys.usable(combo)) { announce(`${combo} would get in the way of typing. Use Ctrl, Alt or a function key.`); return; }
    const other = Keys.owner(prefs.keys, combo, action);
    if (other) { done(`${combo} is already used for ${Keys.label(other)}. Unchanged.`); return; }
    setPref('keys.' + action, combo);
    done(`${Keys.label(action)} is now ${combo}`);
  };
  window.addEventListener('keydown', onKey, true);
  announce(btn.textContent);
}

function keysSection() {
  const sec = el('section', { id: 'prefs-keyboard' });
  sec.setAttribute('aria-labelledby', 'prefs-keyboard-h');
  sec.append(el('h2', { id: 'prefs-keyboard-h', textContent: 'Keyboard', tabIndex: -1 }),
    el('p', { className: 'hint', textContent: 'Each button says an action and its keys. Press it, then press the new keys.' }));
  for (const [group, items] of Keys.ACTIONS) {
    sec.append(el('h3', { textContent: group }));
    for (const [action] of items) {
      const btn = el('button', { type: 'button', textContent: keyButtonText(action) });
      btn.dataset.action = action;
      btn.addEventListener('click', () => captureKey(btn, action));
      sec.append(el('div', { className: 'keyrow' }, btn));
    }
  }
  const reset = el('button', { type: 'button', textContent: 'Reset all keys to the defaults' });
  reset.addEventListener('click', () => {
    prefs = { ...prefs, keys: { ...Keys.DEFAULT_KEYS } };
    anvil.send('prefs', prefs);
    for (const b of sec.querySelectorAll('button[data-action]')) b.textContent = keyButtonText(b.dataset.action);
    announce('Keys reset to the defaults');
  });
  sec.append(el('div', { className: 'keyrow' }, reset));
  return sec;
}

function aboutSection() {
  const sec = el('section', { id: 'prefs-about' });
  sec.setAttribute('aria-labelledby', 'prefs-about-h');
  sec.append(el('h2', { id: 'prefs-about-h', textContent: 'About', tabIndex: -1 }),
    el('p', { textContent: 'The Textsmith: a terminal whose output is a web document, written for screen readers first.' }),
    el('p', { id: 'about-version', textContent: 'Version' }),
    el('p', { textContent: 'Bookmarks are kept in the file bookmarks and preferences in prefs.json, in The Textsmith\'s folder (~/.config/textsmith, or ~/.textsmith if you have one); both can be edited by hand.' }));
  return sec;
}

let prefsReturn = null;
function openPrefs() {
  prefsReturn = document.activeElement;
  const body = $('prefs-body'), nav = $('prefs-nav');
  body.textContent = ''; nav.textContent = '';
  const sections = [];
  for (const [title, fields] of FIELDS) {
    const id = 'prefs-' + title.toLowerCase().replace(/\W+/g, '-');
    const sec = el('section', { id });
    sec.setAttribute('aria-labelledby', id + '-h');
    sec.append(el('h2', { id: id + '-h', textContent: title, tabIndex: -1 }), ...fields.map(fieldNode));
    sections.push([title, sec]);
  }
  sections.push(['Keyboard', keysSection()], ['About', aboutSection()]);
  anvil.get('version').then(v => { const p = $('about-version'); if (p) p.textContent = `Version ${v}`; });
  for (const [title, sec] of sections) {
    body.append(sec);
    const a = el('a', { href: '#' + sec.id, textContent: title });
    a.addEventListener('click', e => { e.preventDefault(); const h = sec.querySelector('h2'); h.focus(); h.scrollIntoView({ block: 'start' }); });
    nav.append(a);
  }
  for (const id of ['bar', 'doc', 'prompt', 'grid', 'matches']) $(id).inert = true;
  $('prefs').hidden = false;
  $('prefs-title').focus();
  announce('Preferences. Categories: ' + sections.map(s => s[0]).join(', ') + '. Escape closes.');
}
function closePrefs() {
  $('prefs').hidden = true;
  for (const id of ['bar', 'doc', 'prompt', 'grid', 'matches']) $(id).inert = false;
  (prefsReturn && document.contains(prefsReturn) ? prefsReturn : cmd).focus();
}
$('prefs').addEventListener('keydown', e => {
  if (capturingKeys) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePrefs(); }
});
