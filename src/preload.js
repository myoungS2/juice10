'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  loadPath: (p, forceConvert) => ipcRenderer.invoke('load-path', p, !!forceConvert),
  saveDialog: (defaultName) => ipcRenderer.invoke('save-dialog', defaultName),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  showError: (title, message) => ipcRenderer.invoke('show-error', title, message),
  ready: () => ipcRenderer.send('renderer-ready'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, k) => cb(k)),
  setTextFocus: (v) => ipcRenderer.send('text-focus', !!v),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});
