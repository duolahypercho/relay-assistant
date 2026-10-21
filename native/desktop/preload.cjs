// SPDX-License-Identifier: MIT
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relayNative', {
  platform: process.platform,
  templates: {
    peek: () => ipcRenderer.invoke('relay:template-peek'),
    acknowledge: (input) => ipcRenderer.invoke('relay:template-acknowledge', input),
  },
  backups: {
    begin: () => ipcRenderer.invoke('relay:backup-begin'),
    append: (input) => ipcRenderer.invoke('relay:backup-append', input),
    save: (input) => ipcRenderer.invoke('relay:backup-save', input),
    cancel: (input) => ipcRenderer.invoke('relay:backup-cancel', input),
  },
  notifications: {
    status: () => ipcRenderer.invoke('relay:notifications-status'),
    configure: (identity) => ipcRenderer.invoke('relay:notifications-configure', identity),
    onOpen(callback) {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('relay:attention', listener);
      return () => ipcRenderer.removeListener('relay:attention', listener);
    },
  },
  openAppSignIn: (url) => ipcRenderer.invoke('relay:app-sign-in', url),
  copyText: (text) => ipcRenderer.invoke('relay:copy-text', text),
  setGuestKeyboard: (active) => ipcRenderer.send('relay:guest-keyboard', active === true),
  ready: () => ipcRenderer.send('relay:ready'),
  onCommand(callback) {
    const listener = (_event, value) => {
      if (
        [
          'new',
          'search',
          'settings',
          'find-chat',
          'search-chats',
          'sidebar',
          'focus-prompt',
          'apps',
          'details',
          'back',
          'forward',
          'next-chat',
          'previous-chat',
          'send',
          ...Array.from({ length: 9 }, (_, i) => `chat-${i + 1}`),
        ].includes(value)
      )
        callback(value);
    };
    ipcRenderer.on('relay:command', listener);
    return () => ipcRenderer.removeListener('relay:command', listener);
  },
});
