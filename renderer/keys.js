'use strict';
// Keyboard shortcuts: names for key combinations, the default for every
// action, and matching a key press against a setting. A setting can hold
// several combinations: "F2 or Alt+R".
//
// Used by the page (window.Keys) and by the main process for the tab keys.

(function (root) {
  const DEFAULT_KEYS = {
    sudo: 'Shift+Enter',
    bookmark: 'Alt+M',
    bookmarkRun: 'Alt+Shift+M',
    bookmarkMode: 'Ctrl+Space',
    bookmarks: 'Alt+Shift+B',
    historySearch: 'Ctrl+R',
    screenPage: 'F2 or Alt+R',
    copy: 'Ctrl+Shift+C',
    viewList: 'Alt+0',
    viewAll: 'Alt+1',
    viewErrors: 'Alt+2',
    prevHeading: 'Alt+Up',
    nextHeading: 'Alt+Down',
    grid: 'Alt+G',
    readLine: 'Alt+L',
    readStatus: 'Alt+S',
    preferences: 'Ctrl+Comma',
    newTab: 'Ctrl+Shift+T',
    closeTab: 'Ctrl+Shift+W',
    nextTab: 'Ctrl+PageDown or Ctrl+Tab',
    prevTab: 'Ctrl+PageUp or Ctrl+Shift+Tab',
  };

  // What each action is, in the words the preferences page uses.
  const ACTIONS = [
    ['Commands', [
      ['sudo', 'Run the command as administrator (sudo)'],
      ['historySearch', 'Search history'],
      ['bookmark', 'Bookmark the command in the box'],
      ['bookmarkRun', 'Bookmark the command and run it'],
      ['bookmarkMode', 'Call a bookmark by name'],
      ['bookmarks', 'List bookmarks'],
    ]],
    ['Reading', [
      ['prevHeading', 'Previous heading'],
      ['nextHeading', 'Next heading'],
      ['viewAll', 'Output view'],
      ['viewErrors', 'Errors only view'],
      ['viewList', 'Command list view'],
      ['copy', 'Select and copy text'],
    ]],
    ['Full-screen programs', [
      ['screenPage', 'Show the program\'s screen as a page, and back'],
      ['readLine', 'Read the line under the cursor'],
      ['readStatus', 'Read the bottom line'],
      ['grid', 'Hand the window to the running program as a grid'],
    ]],
    ['Tabs and window', [
      ['newTab', 'New tab'],
      ['closeTab', 'Close tab'],
      ['nextTab', 'Next tab'],
      ['prevTab', 'Previous tab'],
      ['preferences', 'Preferences'],
    ]],
  ];

  const NAMES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  const MODIFIER = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

  // A key press as a combination name, such as "Ctrl+Shift+T". Takes a DOM
  // keyboard event or an Electron input event. Null for a lone modifier.
  function of(e) {
    const code = e.code || '';
    const key = e.key || '';
    if (MODIFIER.test(code) || MODIFIER.test(key)) return null;
    let name;
    if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
    else if (/^Digit\d$/.test(code)) name = code.slice(5);
    else if (code) name = NAMES[code] || code;
    else name = key.length === 1 ? key.toUpperCase() : (NAMES[key] || key);
    const ctrl = e.ctrlKey ?? e.control, alt = e.altKey ?? e.alt, shift = e.shiftKey ?? e.shift, meta = e.metaKey ?? e.meta;
    return [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', meta && 'Meta', name].filter(Boolean).join('+');
  }

  const list = setting => String(setting || '').split(/\s+or\s+/i).map(s => s.trim()).filter(Boolean);
  const matches = (combo, setting) => !!combo && list(setting).some(s => s.toLowerCase() === combo.toLowerCase());

  // A combination the page can safely take: it must not swallow ordinary typing.
  function usable(combo) {
    if (!combo) return false;
    const parts = combo.split('+'), key = parts[parts.length - 1];
    if (/^F\d{1,2}$/.test(key)) return true;
    if (parts.includes('Ctrl') || parts.includes('Alt') || parts.includes('Meta')) return true;
    return combo === 'Shift+Enter';
  }

  // The action already using a combination, other than `except`.
  function owner(keys, combo, except) {
    for (const [action, setting] of Object.entries(keys)) if (action !== except && matches(combo, setting)) return action;
    return null;
  }

  const label = action => { for (const [, items] of ACTIONS) for (const [a, l] of items) if (a === action) return l; return action; };

  // Defaults before readline keys came to the command box, for moving saved preferences on.
  const OLD_DEFAULTS = { bookmark: 'Ctrl+B', bookmarkRun: 'Ctrl+Shift+B', bookmarks: 'Alt+B', copy: 'Alt+C' };
  // Actions that only apply inside a full-screen program, so their keys are free in the command box.
  const GRID_ONLY = ['readLine', 'readStatus'];

  const api = { GRID_ONLY, OLD_DEFAULTS, DEFAULT_KEYS, ACTIONS, of, list, matches, usable, owner, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Keys = api;
})(this);
