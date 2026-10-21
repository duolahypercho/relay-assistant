// SPDX-License-Identifier: MIT
// Real installed Ollama and inference. Requires an explicit test model directory.
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { Store } from '../server/store.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import {
  LocalModelRuntime,
  ollamaProbe,
  supervisedOllama,
} from '../server/local-model-runtime.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { LocalModelDownloads } from '../server/local-model-downloads.mjs';
import { LocalModelInstallation } from '../server/local-model-installation.mjs';
import { LocalModelSetup } from '../server/local-model-setup.mjs';
export async function localModelStartFixture(
  directory,
  {
    modelsDirectory,
    tls,
    accessKey = '',
    isolatedPort,
    enableDownloads = false,
    installationOptions,
    setupSuggestion,
    configure,
  } = {},
) {
  if (!modelsDirectory) throw Error('Use an explicit acceptance model directory.');
  if (
    isolatedPort !== undefined &&
    (!Number.isInteger(isolatedPort) || isolatedPort < 1024 || isolatedPort > 65535)
  )
    throw Error('Use a valid isolated test port.');
  const port = isolatedPort ?? 11434;
  // Acceptance-only transport relocation preserves an unrelated owner's service.
  // Production discovery, activation and runtime endpoints stay fixed to 11434.
  const fetcher = (input, options) => {
    const url = new URL(input);
    if (isolatedPort && url.origin === 'http://127.0.0.1:11434') url.port = String(port);
    return fetch(url, options);
  };
  const probe = (signal) =>
    ollamaProbe(signal, {
      connect: (options) => createConnection({ ...options, port }),
      fetcher,
    });
  if ((await probe()).occupied)
    throw Error(`Port ${port} is already occupied; leave its service alone.`);
  const store = new Store(join(directory, 'relay.sqlite'), { sample: false });
  const provider = new ModelConnections(store, { key: modelVaultKey(directory), fetcher });
  const controls = { hold: false, starts: 0 };
  const installation = installationOptions
    ? new LocalModelInstallation(store, directory, installationOptions)
    : null;
  if (installation) await mkdir(join(directory, 'runtime-home'), { recursive: true });
  const runtime = new LocalModelRuntime(store, {
    ...(installation ? { locate: () => installation.executable() } : {}),
    environment: {
      ...process.env,
      OLLAMA_MODELS: modelsDirectory,
      ...(installation ? { HOME: join(directory, 'runtime-home') } : {}),
    },
    launch: (executable, environment) => {
      controls.starts++;
      return supervisedOllama(executable, { ...environment, OLLAMA_HOST: `127.0.0.1:${port}` });
    },
    probe: async (signal) => {
      const result = await probe(signal);
      return controls.hold && controls.starts && runtime.phase === 'starting'
        ? { ...result, running: false }
        : result;
    },
  });
  const services = {
    mode: 'live',
    provider,
    localModelRuntime: runtime,
    ...(installation ? { localModelInstallation: installation } : {}),
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const downloads = enableDownloads ? new LocalModelDownloads(store, { fetcher, probe }) : null;
  if (downloads) services.localModelDownloads = downloads;
  const setup = setupSuggestion
    ? new LocalModelSetup(store, {
        installation,
        runtime,
        downloads,
        provider,
        suggestion: setupSuggestion,
      })
    : null;
  if (setup) services.localModelSetup = setup;
  await configure?.(store, services);
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? createServer(tls, app).listen(0, '127.0.0.1') : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    provider,
    worker,
    services,
    runtime,
    controls,
    downloads,
    installation,
    setup,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      await worker.stop();
      await setup?.close();
      await downloads?.close();
      await installation?.close();
      await runtime.close();
      services.connectors?.close();
      services.notifications?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
