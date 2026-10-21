// SPDX-License-Identifier: MIT
// Real owner API and worker, with controlled local-catalog/response transport only.
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function localModelSetupFixture(directory, { tls, accessKey = '' } = {}) {
  const store = new Store(join(directory, 'relay.sqlite'), { sample: false });
  const requests = [];
  let mode = 'ready';
  const provider = new ModelConnections(store, {
    key: modelVaultKey(directory),
    fetcher: async (url, init) => {
      requests.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
      if (!/^http:\/\/127\.0\.0\.1:(11434|1234)\/v1\/(models|chat\/completions)$/.test(url))
        throw Error('Unexpected destination');
      if (init.method === 'GET') {
        if (mode === 'slow')
          await new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
          );
        if (mode === 'offline' || url.includes(':1234/'))
          throw Error('Controlled unavailable service');
        return Response.json({
          data:
            mode === 'empty'
              ? []
              : mode === 'multiple'
                ? [
                    { id: 'local-chat', name: 'Local chat' },
                    { id: 'local-vision', name: 'Local vision' },
                  ]
                : [{ id: 'local-chat', name: 'Local chat' }],
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Your local model is connected. We can keep talking here.',
            },
            finish_reason: 'stop',
          },
        ],
      });
    },
  });
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
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
    requests,
    setMode(value) {
      mode = value;
    },
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      await worker.stop();
      services.connectors?.close();
      await services.notifications?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
