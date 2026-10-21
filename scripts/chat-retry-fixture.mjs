// SPDX-License-Identifier: MIT
// Controlled HTTP model failures; production tools, persistence and recovery.
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { ModelProvider } from '../server/model.mjs';
import { BackgroundWorker } from '../server/worker.mjs';

export const retryRequest = 'Save a note about our Saturday plan.';
export const retryAnswer = 'Your Saturday note is saved. We can continue.';
export async function chatRetryFixture(directory, { tls, accessKey = '' } = {}) {
  const store = new Store(join(directory, 'relay.sqlite'), { sample: false });
  const controls = { fail: true, hold: false, release: null },
    requests = [];
  const modelApp = express();
  modelApp.use(express.json({ limit: '2mb' }));
  modelApp.post('/v1/chat/completions', async (req, res) => {
    requests.push(req.body);
    const messages = req.body.messages;
    const saved = messages.findLast((m) => m.role === 'tool' && m.tool_call_id === 'saved-note');
    if (!saved) {
      res.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'saved-note',
                  type: 'function',
                  function: {
                    name: 'write_note',
                    arguments: JSON.stringify({
                      name: 'Saturday.txt',
                      text: 'A walk by the river, then tea.',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      return;
    }
    if (controls.fail)
      return res.status(503).json({ error: { message: 'Temporary model interruption.' } });
    if (controls.hold)
      await new Promise((r) => {
        controls.release = r;
      });
    if (!res.destroyed)
      res.json({ choices: [{ message: { content: retryAnswer }, finish_reason: 'stop' }] });
  });
  const modelServer = modelApp.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const provider = new ModelProvider({
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    model: 'retry-acceptance',
    protocol: 'chat',
  });
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 50 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? createServer(tls, app).listen(0, '127.0.0.1') : app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    services,
    controls,
    requests,
    worker,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      controls.release?.();
      await worker.stop();
      services.connectors?.close();
      services.notifications?.close();
      server.closeAllConnections();
      modelServer.closeAllConnections();
      await Promise.all([
        new Promise((r) => server.close(r)),
        new Promise((r) => modelServer.close(r)),
      ]);
      store.close();
    },
  };
}
