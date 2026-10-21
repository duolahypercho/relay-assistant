// SPDX-License-Identifier: MIT
// Controlled provider HTTP endpoints for acceptance tests; never used by production.
import express from 'express';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function modelsFixture(directory, port = 0) {
  const requests = [];
  const failures = new Map();
  const endpoint = express();
  endpoint.use(express.json({ limit: '12mb' }));
  endpoint.use((req, res, next) => {
    const key =
      req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'];
    if (String(key).includes('rejected-key'))
      return res.status(401).json({ error: 'Fixture denied this test key.' });
    if (req.method === 'POST' && failures.has(req.body?.model)) {
      requests.push(req.body);
      return res.status(failures.get(req.body.model)).json({ error: 'Controlled model outage' });
    }
    next();
  });
  endpoint.get('/v1/models', (_req, res) =>
    res.json({
      data: [
        { id: 'relay-chat-test', name: 'Chat test' },
        { id: 'relay-claude-test', name: 'Claude test' },
      ],
    }),
  );
  endpoint.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    res.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              req.body.messages[0]?.content === 'Reply with the word Connected.'
                ? 'Connected'
                : 'This reply came through your saved chat connection.',
          },
          finish_reason: 'stop',
        },
      ],
    });
  });
  endpoint.post('/v1/messages', (req, res) => {
    requests.push(req.body);
    const result = req.body.messages.at(-1)?.content?.find((p) => p.type === 'tool_result');
    const text = req.body.messages.at(-1)?.content?.find((p) => p.type === 'text')?.text;
    res.json({
      content:
        text?.includes('Remember') && !result
          ? [
              {
                type: 'tool_use',
                id: 'save',
                name: 'learn_memory',
                input: {
                  key: 'preference.coffee',
                  text: 'Prefers iced coffee.',
                  evidence: 'I prefer iced coffee',
                },
              },
            ]
          : [
              {
                type: 'text',
                text: result
                  ? 'I saved your coffee preference through the second model connection.'
                  : 'Connected',
              },
            ],
      stop_reason: result ? 'end_turn' : 'tool_use',
    });
  });
  const providerServer = endpoint.listen(0, '127.0.0.1');
  await once(providerServer, 'listening');
  const baseUrl = `http://127.0.0.1:${providerServer.address().port}/v1`;
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const provider = new ModelConnections(store, { key: modelVaultKey(directory) });
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port, accessKey: '' });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    provider,
    requests,
    setFailure: (model, status) => (status ? failures.set(model, status) : failures.delete(model)),
    baseUrl,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await worker.stop();
      for (const s of [server, providerServer]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      store.close();
    },
  };
}
