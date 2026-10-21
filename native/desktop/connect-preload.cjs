// SPDX-License-Identifier: MIT
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relayConnection', {
  connect: (url) => ipcRenderer.invoke('relay:connect', url),
});
