import { Notifications } from './notifications.mjs';
import { pushProvidersFromEnvironment } from './push-providers.mjs';
// SPDX-License-Identifier: MIT
import express from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Connectors } from './connectors.mjs';
import { createApp } from './app.mjs';
import { BrowserComputer } from './browser.mjs';
import { IsolatedTerminal } from './terminal.mjs';
import { ModelConnections, modelVaultKey } from './model-connections.mjs';
import { LocalModelRuntime, installedOllama } from './local-model-runtime.mjs';
import { LocalModelDownloads } from './local-model-downloads.mjs';
import { LocalModelInstallation } from './local-model-installation.mjs';
import { LocalModelSetup } from './local-model-setup.mjs';
import { GoogleConnection } from './google.mjs';
import { MailTriggerPoller } from './mail-trigger.mjs';
import { BackgroundWorker, recoverWork } from './worker.mjs';
import { readPage } from './network.mjs';
import { WebSearch } from './search.mjs';
import { VoiceConnections } from './voice-connections.mjs';
import { LocalListeningInstallation } from './local-listening-installation.mjs';
import { LocalTranscriptionService } from './local-transcription.mjs';
import { ImageConnections } from './image-connections.mjs';
import { PrivateComputer } from './computer.mjs';
import { ComputerSetup } from './computer-setup.mjs';
import { ComputerInstallation } from './computer-installation.mjs';
import { ComputerMaintenance } from './computer-maintenance.mjs';
import { ComputerSnapshots } from './computer-snapshots.mjs';
import { TrustedBrowser } from './trusted-browser.mjs';
import { BrowserContainer } from './browser-container.mjs';
import { deploymentSecret } from './deployment-secret.mjs';
import { remoteComputerFromEnvironment } from './remote-computer.mjs';
if (process.env.RELAY_DESKTOP_ENV) {
  try {
    process.loadEnvFile(process.env.RELAY_DESKTOP_ENV);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dev = process.argv.includes('--dev');
const host = process.env.RELAY_HOST || '127.0.0.1';
const port = Number(process.env.RELAY_PORT || (dev ? 5173 : 4173));
const mode = process.env.RELAY_MODE || 'sample';
const accessKey = deploymentSecret('RELAY_ACCESS_KEY');
if (!['sample', 'live'].includes(mode)) throw new Error('RELAY_MODE must be sample or live.');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && accessKey.length < 24)
  throw new Error('A remote server requires a RELAY_ACCESS_KEY with at least 24 characters.');
const dataDir = resolve(process.env.RELAY_DATA_DIR || resolve(root, 'data'));
const config = {
  host,
  port,
  accessKey,
  publicUrl: process.env.RELAY_PUBLIC_URL || `http://${host}:${port}`,
};
const store = new Store(resolve(dataDir, 'relay.sqlite'), { sample: mode === 'sample' });
const provider = new ModelConnections(store, {
  key: modelVaultKey(dataDir),
  environment: {
    baseUrl: process.env.RELAY_MODEL_BASE_URL,
    model: process.env.RELAY_MODEL_ID,
    apiKey: process.env.RELAY_MODEL_API_KEY,
    protocol: process.env.RELAY_MODEL_PROTOCOL || 'responses',
    reportUsage: process.env.RELAY_MODEL_REPORT_USAGE !== 'false',
  },
});
const google = new GoogleConnection(store, {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  encryptionKey: deploymentSecret('RELAY_TOKEN_ENCRYPTION_KEY'),
  redirectUri: `${config.publicUrl}/api/google/callback`,
});
const localModelInstallation = new LocalModelInstallation(store, dataDir);
const localModelRuntime = new LocalModelRuntime(store, {
  locate: async () => (await localModelInstallation.executable()) || installedOllama(),
});
const localModelDownloads = new LocalModelDownloads(store);
const localModelSetup = new LocalModelSetup(store, {
  installation: localModelInstallation,
  runtime: localModelRuntime,
  downloads: localModelDownloads,
  provider,
});
const browser = new BrowserComputer(dataDir, {
  enabled: process.env.RELAY_BROWSER_ENABLED !== 'false',
  channel: process.env.RELAY_BROWSER_CHANNEL,
});
const terminal = new IsolatedTerminal({
  enabled: process.env.RELAY_COMPUTER_ENABLED === 'true',
  image: process.env.RELAY_COMPUTER_IMAGE,
  deployment: dataDir,
});
const remoteComputer = await remoteComputerFromEnvironment();
const computer = new PrivateComputer(store, {
  enabled: process.env.RELAY_DESKTOP_ENABLED === 'true',
  image: remoteComputer?.image || process.env.RELAY_DESKTOP_IMAGE,
  deployment: remoteComputer?.deployment || dataDir,
  dockerHost: remoteComputer?.endpoint,
  remoteEngine: remoteComputer,
  web: process.env.RELAY_DESKTOP_WEB_ENABLED !== 'false',
});
const computerSetup = new ComputerSetup(computer, { root });
computerSetup.installation = new ComputerInstallation(computerSetup);
await computerSetup.installation.restore();
const computerMaintenance = new ComputerMaintenance(computer, computerSetup);
const computerSnapshots = new ComputerSnapshots(computer);
await computer.stdio.recover();
await computerSnapshots.reconcile();
const search = new WebSearch({ apiKey: process.env.BRAVE_SEARCH_API_KEY });
const privateBrowser =
  process.env.RELAY_TRUSTED_BROWSER_ENABLED === 'true' && computer.enabled
    ? new TrustedBrowser(store, {
        enabled: true,
        key: modelVaultKey(dataDir),
        control: computer,
        runtime: new BrowserContainer(computer),
      })
    : null;
const mailTriggers = new MailTriggerPoller(store, google);
const localListeningInstallation = new LocalListeningInstallation(store, dataDir);
const localTranscription = new LocalTranscriptionService(localListeningInstallation);
const voiceConnections = new VoiceConnections(store, {
  localTranscription,
  key: modelVaultKey(dataDir),
  environment: {
    transcription: {
      baseUrl: process.env.RELAY_TRANSCRIPTION_BASE_URL,
      model: process.env.RELAY_TRANSCRIPTION_MODEL,
      apiKey: process.env.RELAY_TRANSCRIPTION_API_KEY,
    },
    speech: {
      baseUrl: process.env.RELAY_SPEECH_BASE_URL,
      model: process.env.RELAY_SPEECH_MODEL,
      apiKey: process.env.RELAY_SPEECH_API_KEY,
      voice: process.env.RELAY_SPEECH_VOICE || 'coral',
    },
  },
});
localListeningInstallation.voice = voiceConnections;
const connectors = new Connectors(store, { key: modelVaultKey(dataDir), computer });
const imageConnections = new ImageConnections(store, {
  key: modelVaultKey(dataDir),
  environment: {
    baseUrl: process.env.RELAY_IMAGE_BASE_URL,
    model: process.env.RELAY_IMAGE_MODEL,
    apiKey: process.env.RELAY_IMAGE_API_KEY,
    format: process.env.RELAY_IMAGE_FORMAT,
  },
});
const notifications = new Notifications(store, {
  key: modelVaultKey(dataDir),
  providers: pushProvidersFromEnvironment(),
});
const services = {
  notifications,
  connectors,
  mode,
  provider,
  localModelRuntime,
  localModelDownloads,
  localModelInstallation,
  localModelSetup,
  google,
  browser,
  terminal,
  computer,
  computerSetup,
  computerMaintenance,
  computerSnapshots,
  privateBrowser,
  readPage,
  search,
  mailTriggers,
  voiceConnections,
  localListeningInstallation,
  imageConnections,
  transcription: voiceConnections.transcription,
  speech: voiceConnections.speech,
};
const worker = new BackgroundWorker(store, services);
services.worker = worker;
// An external write whose process died after claiming it has an unknown outcome. Never resend it automatically.
recoverWork(store);
const app = createApp(store, services, config);
let vite;
if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(resolve(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/index.html')));
}
const server = app.listen(port, host, (error) => {
  if (error) {
    // Express 5 also invokes this callback for a listen failure. No runtime has
    // started, so don't shut down a computer owned by another server instance.
    console.error(`Relay could not listen on ${host}:${port}: ${error.code || error.message}`);
    process.exit(1);
    return;
  }
  const url = `http://${host}:${server.address().port}`;
  console.log(`Relay is ready at ${url} (${mode})`);
  // Make the app available immediately; queued work waits for an opted-in local engine.
  void localModelRuntime
    .restore()
    .catch(() => {})
    .finally(() => {
      if (!stopping) worker.start();
    });
  notifications.start();
  process.parentPort?.postMessage({
    type: 'relay-ready',
    url,
    nonce: process.env.RELAY_DESKTOP_NONCE,
  });
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Stop admitting new owner actions before draining workers and detaching the desktop.
  const serverClosed = new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
  connectors.close();
  await notifications.close();
  await worker.stop();
  await localListeningInstallation.close();
  await localTranscription.close();
  await localModelSetup.close();
  await localModelDownloads.close();
  await localModelInstallation.close();
  await localModelRuntime.close();
  await computerSetup.installation.close();
  await computerSetup.engineControl.close();
  await computerSetup.cancel();
  await computerMaintenance.close();
  await computerSnapshots.close();
  await privateBrowser?.close();
  await browser.stop();
  if (computer.enabled) await computer.shutdown().catch((error) => console.error(error.message));
  await remoteComputer?.close();
  await vite?.close();
  await serverClosed;
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'relay-stop') void stop();
});
