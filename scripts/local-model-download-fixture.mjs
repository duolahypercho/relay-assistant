// SPDX-License-Identifier: MIT
// Real Relay/SQLite/worker and an independent streaming HTTP Ollama fixture.
import express from 'express';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { LocalModelDownloads } from '../server/local-model-downloads.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function localModelDownloadFixture(directory, { tls, accessKey = '' } = {}) {
  const models = [],
    pulls = [],
    requests = [];
  let mode = 'hold',
    active;
  const ollama = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ url: req.url, method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/pull') {
      pulls.push(body);
      active = res;
      res.setHeader('Content-Type', 'application/x-ndjson');
      if (mode === 'error') {
        res.end(JSON.stringify({ error: 'private-provider-detail' }));
        return;
      }
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      res.write(
        JSON.stringify({
          status: 'pulling sha256:fixture',
          digest: 'sha256:fixture',
          total: 4000000000,
          completed: 1200000000,
        }) + '\n',
      );
      req.socket.once('close', () => {
        if (active === res) active = null;
      });
    } else if (req.url === '/api/tags')
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
    else if (req.url === '/v1/models')
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    else if (req.url === '/v1/chat/completions')
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'Your downloaded model is connected.' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  }).listen(0, '127.0.0.1');
  await once(ollama, 'listening');
  const store = new Store(join(directory, 'relay.sqlite'), { sample: false });
  const fetcher = (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'http://127.0.0.1:11434') throw Error('Unavailable local service');
    url.port = String(ollama.address().port);
    return fetch(url, init);
  };
  const provider = new ModelConnections(store, { key: modelVaultKey(directory), fetcher });
  const downloads = new LocalModelDownloads(store, {
    fetcher,
    probe: async () => ({ running: true }),
    stall: 120000,
  });
  const services = {
    mode: 'live',
    provider,
    localModelDownloads: downloads,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? httpsServer(tls, app).listen(0, '127.0.0.1') : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    provider,
    downloads,
    pulls,
    requests,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    setMode(value) {
      mode = value;
    },
    finish() {
      if (!active || active.destroyed) throw Error('No live pull');
      const name = pulls.at(-1).model;
      if (!models.includes(name)) models.push(name);
      active.end(JSON.stringify({ status: 'success' }) + '\n');
      active = null;
    },
    async close() {
      await downloads.close();
      await worker.stop();
      services.connectors?.close();
      await services.notifications?.close();
      server.closeAllConnections();
      ollama.closeAllConnections();
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => ollama.close(r))]);
      store.close();
    },
  };
}
