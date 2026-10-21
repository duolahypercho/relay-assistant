import { DesktopBackupFiles } from './backup-files.mjs';
import { DesktopNotifications } from './notifications.mjs';
import { DesktopTemplateLinks } from './template-links.mjs';
import { parseTemplateAppLink } from '../../shared/assistant-template-links.mjs';
// SPDX-License-Identifier: MIT
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  clipboard,
  Notification,
  session,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverURL, navigationKind, clipboardText, appSignInURL } from './urls.mjs';
import { connectionInput } from '../../shared/device-link.mjs';
import { isWorkspaceMicrophone } from './permissions.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argument = (name) =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
if (argument('--relay-test-data')) app.setPath('userData', resolve(argument('--relay-test-data')));
const settingsPath = () => join(app.getPath('userData'), 'desktop.json');
const templateLinks = new DesktopTemplateLinks(app.getPath('userData'));
let templateDestination = null;
const incomingTemplateLinks = process.argv.filter((value) => value.startsWith('relay-assistant:'));
async function receiveTemplateLink(value) {
  try {
    parseTemplateAppLink(value);
    if (templateDestination === null) {
      incomingTemplateLinks.push(value);
      return;
    }
    await templateLinks.receive(value, templateDestination);
    await showWindow();
    if (!['/', '/index.html'].includes(new URL(mainWindow.webContents.getURL()).pathname))
      await mainWindow.loadURL(workspaceURL);
  } catch {
    /* A malformed app link does not change the selected workspace. */
  }
}
let backupFiles;
let mainWindow,
  connectionWindow,
  backend,
  workspaceURL,
  quitting = false;
let rendererReady = false;
const pendingCommands = [];
const shownNotifications = new Set();
let notificationClient,
  pendingAttention = null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => {
    const link = args.find((value) => value.startsWith('relay-assistant:'));
    if (link) void receiveTemplateLink(link);
    else void showWindow();
  });
  app.on('open-url', (event, value) => {
    event.preventDefault();
    void receiveTemplateLink(value);
  });
  app.on('activate', () => void showWindow());
  // Closing a window keeps the local worker alive. Quit Relay ends the runtime.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    void notificationClient?.close();
    // Remote connections have no local runtime to drain; let Electron quit normally.
    if (quitting || !backend) return;
    event.preventDefault();
    quitting = true;
    const timeout = setTimeout(() => app.exit(), 8000);
    backend.once('exit', () => {
      clearTimeout(timeout);
      app.quit();
    });
    backend.postMessage({ type: 'relay-stop' });
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('Relay could not start', error.message);
      app.quit();
    });
}
async function start() {
  let config;
  try {
    config = JSON.parse(await readFile(settingsPath(), 'utf8'));
  } catch {
    config = {};
  }
  if (config.server) {
    try {
      workspaceURL = serverURL(config.server);
    } catch {
      /* Use the local runtime. */
    }
  }
  const templateScope = workspaceURL || 'local';
  if (!workspaceURL) workspaceURL = await startBackend();
  installMenu();
  ipcMain.on('relay:ready', (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    rendererReady = true;
    mainWindow.webContents.setIgnoreMenuShortcuts(false);
    if (pendingAttention) {
      mainWindow.webContents.send('relay:attention', pendingAttention);
      pendingAttention = null;
    }
    for (const name of pendingCommands.splice(0))
      mainWindow.webContents.send('relay:command', name);
  });
  ipcMain.on('relay:guest-keyboard', (event, active) => {
    if (
      event.sender !== mainWindow?.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      return;
    mainWindow.webContents.setIgnoreMenuShortcuts(active === true);
  });
  backupFiles = new DesktopBackupFiles(app.getPath('temp'));
  for (const action of ['begin', 'append', 'save', 'cancel']) {
    ipcMain.handle(`relay:backup-${action}`, async (event, input = {}) => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== new URL(workspaceURL).origin
      )
        throw Error('Save backups from the main Relay workspace.');
      return backupFiles[action](input, async (name) => {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: 'Save computer backup',
          defaultPath: name,
          filters: [{ name: 'Relay computer backup', extensions: ['relaybackup'] }],
        });
        return canceled ? null : filePath;
      });
    });
  }
  ipcMain.handle('relay:copy-text', async (event, value) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw new Error('Copy text from the main Relay workspace.');
    await clipboard.writeText(clipboardText(value, event.senderFrame.url, workspaceURL));
    return { copied: true };
  });
  ipcMain.handle('relay:app-sign-in', async (event, value) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      throw Error('Open app sign-in from the Relay workspace.');
    await shell.openExternal(appSignInURL(value, event.senderFrame.url, workspaceURL));
    return { opened: true };
  });
  ipcMain.handle('relay:connect', async (event, input) => {
    if (!connectionWindow || event.sender !== connectionWindow.webContents)
      throw new Error('Use the native server connection window.');
    const target =
      input === ''
        ? { server: '', token: '' }
        : connectionInput(input, { allowLoopbackHttp: true });
    if (target.token) {
      try {
        const targetSession = session.fromPartition('persist:relay-workspace');
        const response = await targetSession.fetch(`${target.server}/api/device-links/redeem`, {
          method: 'POST',
          redirect: 'error',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Origin: target.server },
          body: JSON.stringify({
            token: target.token,
            name:
              process.platform === 'darwin'
                ? 'My Mac'
                : process.platform === 'win32'
                  ? 'My Windows PC'
                  : 'My Linux PC',
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error('rejected');
        const cookies = await targetSession.cookies.get({
          url: target.server,
          name: 'relay_session',
        });
        if (!cookies.some((cookie) => cookie.httpOnly && cookie.secure)) throw Error('No session');
        await targetSession.cookies.flushStore();
      } catch {
        throw Error(
          'This link could not connect. Check the server address, or create a new link on your connected device.',
        );
      }
    }
    const value = target.server;
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify({ server: value }), { mode: 0o600 });
    connectionWindow.close();
    app.relaunch();
    app.quit();
    return { ok: true };
  });
  notificationClient = new DesktopNotifications({
    url: workspaceURL,
    path: join(app.getPath('userData'), 'notifications.json'),
    fetcher: (url, options) => session.fromPartition('persist:relay-workspace').fetch(url, options),
    isFocused: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    supported: () => Notification.isSupported(),
    show: ({ title, body, onClick }) =>
      new Promise((resolve) => {
        const notification = new Notification({ title, body });
        shownNotifications.add(notification);
        notification.once('close', () => shownNotifications.delete(notification));
        const timeout = setTimeout(() => resolve(false), 5000);
        notification.once('show', () => {
          clearTimeout(timeout);
          resolve(true);
        });
        notification.once('failed', () => {
          shownNotifications.delete(notification);
          clearTimeout(timeout);
          resolve(false);
        });
        notification.on('click', onClick);
        notification.show();
      }),
    open: async (target) => {
      pendingAttention = target;
      await showWindow();
      if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('relay:attention', pendingAttention);
        pendingAttention = null;
      }
    },
  });
  const trusted = (event) =>
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === new URL(workspaceURL).origin;
  ipcMain.handle('relay:notifications-status', (event) => {
    if (!trusted(event)) throw Error('Open the Relay workspace.');
    return notificationClient.status();
  });
  ipcMain.handle('relay:notifications-configure', (event, identity) => {
    if (!trusted(event)) throw Error('Open the Relay workspace.');
    return notificationClient.configure(identity);
  });
  const templateFrame = (event) =>
    trusted(event) && ['/', '/index.html'].includes(new URL(event.senderFrame.url).pathname);
  ipcMain.handle('relay:template-peek', async (event) => {
    if (!templateFrame(event)) throw Error('Open the main Relay workspace to review a template.');
    return { item: await templateLinks.peek(templateDestination) };
  });
  ipcMain.handle('relay:template-acknowledge', async (event, { id } = {}) => {
    if (!templateFrame(event))
      throw Error('Open the main Relay workspace to finish template review.');
    await templateLinks.acknowledge(id, templateDestination);
  });
  await notificationClient.start();
  await showWindow();
  templateDestination = templateScope;
  for (const link of incomingTemplateLinks.splice(0)) await receiveTemplateLink(link);
}
async function startBackend() {
  const nonce = randomBytes(24).toString('hex');
  const port = argument('--relay-local-port') || process.env.RELAY_PORT || '17734';
  const child = utilityProcess.fork(join(root, 'server/index.mjs'), [], {
    cwd: app.isPackaged ? process.resourcesPath : root,
    serviceName: 'Relay assistant runtime',
    stdio: 'pipe',
    env: {
      ...process.env,
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: port,
      RELAY_DATA_DIR: join(app.getPath('userData'), 'workspace'),
      RELAY_DESKTOP_NONCE: nonce,
      RELAY_DESKTOP_ENV: join(app.getPath('userData'), 'server.env'),
    },
  });
  backend = child;
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  return await new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error('The assistant runtime did not become ready. Check your server configuration.'),
      );
    }, 30000);
    child.once('message', (message) => {
      if (message?.type !== 'relay-ready' || message.nonce !== nonce) return;
      ready = true;
      clearTimeout(timeout);
      resolve(serverURL(message.url));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      backend = undefined;
      if (quitting) return;
      const error = new Error(
        `The assistant runtime stopped (code ${code}). The local port may be in use.`,
      );
      if (!ready) reject(error);
      else {
        dialog.showErrorBox('Relay runtime stopped', error.message);
        app.quit();
      }
    });
  });
}
async function showWindow() {
  if (!workspaceURL) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    title: 'Relay',
    width: 1280,
    height: 860,
    minWidth: 740,
    minHeight: 540,
    show: false,
    backgroundColor: '#fffdf9',
    webPreferences: {
      preload: join(root, 'native/desktop/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: 'persist:relay-workspace',
    },
  });
  rendererReady = false;
  let mainFrameNavigations = 0;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _sameDocument, isMainFrame) => {
    if (isMainFrame && !_sameDocument) {
      rendererReady = false;
      mainFrameNavigations++;
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('relay-assistant:')) {
      void receiveTemplateLink(url);
      return { action: 'deny' };
    }
    if (navigationKind(url, workspaceURL) === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('relay-assistant:')) {
      event.preventDefault();
      void receiveTemplateLink(url);
      return;
    }
    const kind = navigationKind(url, workspaceURL);
    if (['workspace', 'google'].includes(kind)) return;
    event.preventDefault();
    if (kind === 'external') void shell.openExternal(url);
  });
  let microphoneApproved = false;
  const voiceWindow = mainWindow;
  mainWindow.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      !voiceWindow.isDestroyed() &&
      contents === voiceWindow.webContents &&
      microphoneApproved &&
      isWorkspaceMicrophone(permission, details, workspaceURL, 'check'),
  );
  mainWindow.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (
        voiceWindow.isDestroyed() ||
        contents !== voiceWindow.webContents ||
        !isWorkspaceMicrophone(permission, details, workspaceURL)
      )
        return callback(false);
      if (microphoneApproved) return callback(true);
      void dialog
        .showMessageBox(voiceWindow, {
          type: 'question',
          title: 'Microphone access',
          message: 'Allow Relay to use your microphone?',
          detail:
            'Dictation adds editable text to your draft. Voice chat sends each spoken turn automatically while the call is open. Your configured transcription service processes the audio. Cancel or End call stops recording.',
          buttons: ['Cancel', 'Allow microphone'],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          microphoneApproved =
            response === 1 &&
            !voiceWindow.isDestroyed() &&
            new URL(voiceWindow.webContents.getURL()).origin === new URL(workspaceURL).origin;
          callback(microphoneApproved);
        })
        .catch(() => callback(false));
    },
  );
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    void backupFiles?.abandon().catch(() => {});
    mainWindow = undefined;
  });
  const openingWindow = mainWindow;
  try {
    await openingWindow.loadURL(workspaceURL);
  } catch (error) {
    // Reload can replace the initial navigation before it finishes. Its own
    // load continues in this window; cancelling the old load is not startup failure.
    if (openingWindow.isDestroyed()) return;
    if ((error.code === 'ERR_ABORTED' || error.errno === -3) && mainFrameNavigations > 1) return;
    throw error;
  }
}
function command(name) {
  void showWindow().then(() => {
    if (rendererReady) mainWindow?.webContents.send('relay:command', name);
    else pendingCommands.push(name);
  });
}
function connect() {
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    connectionWindow.focus();
    return;
  }
  connectionWindow = new BrowserWindow({
    title: 'Connect your assistant',
    width: 510,
    height: 410,
    resizable: false,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      preload: join(root, 'native/desktop/connect-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  connectionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectionWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  connectionWindow.on('closed', () => {
    connectionWindow = undefined;
  });
  void connectionWindow.loadFile(join(root, 'native/desktop/connect.html'));
}
function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Relay',
              submenu: [
                { role: 'about' },
                { label: 'Connect to shared server…', click: connect },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          {
            id: 'new-chat',
            label: 'New side chat',
            accelerator: 'CommandOrControl+N',
            click: () => command('new'),
          },
          {
            id: 'search',
            label: 'Search',
            accelerator: 'CommandOrControl+K',
            click: () => command('search'),
          },
          {
            id: 'settings',
            label: 'Settings',
            accelerator: 'CommandOrControl+,',
            click: () => command('settings'),
          },
          { label: 'Connect to shared server…', click: connect },
          { type: 'separator' },
          { role: 'close' },
          ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }]),
        ],
      },
      {
        label: 'Conversation',
        submenu: [
          ['find-chat', 'Find in this chat', 'CommandOrControl+F'],
          ['search-chats', 'Find a chat', 'CommandOrControl+Shift+F'],
          ['sidebar', 'Show or hide chats', 'CommandOrControl+B'],
          ['focus-prompt', 'Focus your message', 'CommandOrControl+I'],
          ['details', 'Conversation details', 'CommandOrControl+Shift+,'],
          ['apps', 'Connect apps', 'CommandOrControl+Shift+M'],
          ['back', 'Back', 'CommandOrControl+['],
          ['forward', 'Forward', 'CommandOrControl+]'],
          ['previous-chat', 'Previous chat', 'Control+Shift+Tab'],
          ['next-chat', 'Next chat', 'Control+Tab'],
          ...Array.from({ length: 9 }, (_, i) => [
            `chat-${i + 1}`,
            `Chat ${i + 1}`,
            `CommandOrControl+${i + 1}`,
          ]),
          ['send', 'Send message', 'CommandOrControl+Enter'],
        ].map(([id, label, accelerator]) => ({ id, label, accelerator, click: () => command(id) })),
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}
