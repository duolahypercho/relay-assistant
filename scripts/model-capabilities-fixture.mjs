// SPDX-License-Identifier: MIT
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function modelCapabilitiesFixture(
  directory,
  { tls, accessKey = '', singleText = false, singlePhoto = false, respond, thinking } = {},
) {
  const requests = [],
    endpoint = express();
  endpoint.use(express.json({ limit: '12mb' }));
  endpoint.get('/v1/models', (_req, res) =>
    res.json({
      data: (singleText
        ? ['text-chat']
        : singlePhoto
          ? ['photo-chat']
          : ['text-chat', 'tools-chat', 'vision-chat', 'photo-chat']
      ).map((id) => ({
        id,
      })),
    }),
  );
  endpoint.post('/api/show', (req, res) =>
    res.json({
      ...(thinking ? { thinking } : {}),
      capabilities: [
        'completion',
        ...(!['text-chat', 'photo-chat'].includes(req.body.model) ? ['tools'] : []),
        ...(['vision-chat', 'photo-chat'].includes(req.body.model) ? ['vision'] : []),
      ],
    }),
  );
  endpoint.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    if (['text-chat', 'photo-chat'].includes(req.body.model) && req.body.tools?.length)
      return res.status(400).json({ error: 'Tools not supported; private provider text' });
    const history = req.body.messages,
      last = history.at(-1);
    if (req.body.model !== 'text-chat' && /Remember/.test(last.content || ''))
      return res.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'memory-save',
                  type: 'function',
                  function: {
                    name: 'learn_memory',
                    arguments: JSON.stringify({
                      key: 'preference.coffee',
                      text: 'Prefers iced coffee.',
                      evidence: 'I prefer iced coffee',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    res.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: respond
              ? respond(req.body)
              : req.body.model === 'photo-chat'
                ? `I received ${history.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').length} attached photos directly.`
                : last.role === 'tool'
                  ? 'I saved your coffee preference.'
                  : 'Hello! We can chat here without tools.',
          },
          finish_reason: 'stop',
        },
      ],
    });
  });
  const providerServer = endpoint.listen(0, '127.0.0.1');
  await once(providerServer, 'listening');
  const transport = (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'http://127.0.0.1:11434') throw Error('Service unavailable');
    url.port = String(providerServer.address().port);
    return fetch(url, init);
  };
  const store = new Store(join(directory, 'relay.sqlite'), { sample: false });
  const provider = new ModelConnections(store, {
    key: modelVaultKey(directory),
    fetcher: transport,
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
    provider,
    requests,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      await worker.stop();
      services.connectors?.close();
      await services.notifications?.close();
      server.closeAllConnections();
      providerServer.closeAllConnections();
      await Promise.all([
        new Promise((r) => server.close(r)),
        new Promise((r) => providerServer.close(r)),
      ]);
      store.close();
    },
  };
}
