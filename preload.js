'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = new Set(['start', 'submit', 'write', 'resize', 'grid', 'open', 'complete', 'bookmarks', 'new-tab', 'tab-next', 'tab-prev', 'tab-close', 'prefs']);

contextBridge.exposeInMainWorld('anvil', {
  send(name, arg) { if (ALLOWED.has(name)) ipcRenderer.send('anvil', name, arg); },
  get(what) { return ipcRenderer.invoke('anvil-get', String(what)); },   // 'history', 'bookmarks' or 'prefs'
  on(callback) { ipcRenderer.on('anvil', (_e, name, payload) => callback(name, payload)); },
});
