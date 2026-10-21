import { isMemoryReview, emptyMemoryWireReply } from './memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
// Local deterministic HTTP model for acceptance; never imported by production.
import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function assistantsFixture(
  directory,
  { respond, review, usage, configure, accessKey = '', tls, middleware } = {},
) {
  const requests = [],
    endpoint = express();
  endpoint.use(express.json({ limit: '12mb' }));
  endpoint.post('/v1/chat/completions', async (req, res) => {
    if (isMemoryReview(req.body)) {
      res.json(
        review
          ? { choices: [{ message: await review(req.body), finish_reason: 'stop' }] }
          : emptyMemoryWireReply(),
      );
      return;
    }
    requests.push(req.body);
    if (respond) {
      const message = await respond(req.body);
      if (message) {
        res.json({
          choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          ...(usage ? { usage: usage(req.body) } : {}),
        });
        return;
      }
    }
    const messages = req.body.messages,
      system = messages[0].content;
    const name = system.match(/^You are (.*?), a personal assistant/)?.[1] || 'Relay';
    const last = messages.at(-1),
      user = messages.findLast((m) => m.role === 'user');
    const learning = user?.content === 'I prefer quiet hotels. Remember this for our trips.';
    const message =
      learning && last.role !== 'tool'
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'save-hotel',
                type: 'function',
                function: {
                  name: 'learn_memory',
                  arguments: JSON.stringify({
                    key: 'preference.hotel',
                    text: 'Prefers quiet hotels.',
                    evidence: 'I prefer quiet hotels',
                  }),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content: learning
              ? `${name}: I saved your quiet-hotel preference.`
              : user?.content.includes('Run my saved routine')
                ? `${name}: Your scheduled check is ready.`
                : `${name}: ${system.includes('Prefers quiet hotels.') ? 'I remember your quiet-hotel preference.' : 'Ready for our own conversation.'}`,
          };
    res.json({
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      ...(usage ? { usage: usage(req.body) } : {}),
    });
  });
  const modelServer = endpoint.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const provider = new ModelConnections(store, { key: modelVaultKey(directory) });
  provider.save({
    preset: 'custom',
    name: 'Acceptance model',
    protocol: 'chat',
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    model: 'assistant-test',
    apiKey: '',
  });
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  await configure?.(store, services);
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const server = tls ? createHttpsServer(tls) : createHttpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  const app = createApp(store, services, {
    host: '127.0.0.1',
    port: 0,
    accessKey,
    ...(tls ? { publicUrl: url } : {}),
  });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const entry = express();
  if (middleware) entry.use(middleware);
  entry.use(app);
  server.on('request', entry);
  worker.start();
  return {
    store,
    worker,
    provider,
    services,
    requests,
    server,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      services.connectors?.close();
      await services.notifications?.close();
      await worker.stop();
      for (const s of [server, modelServer]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      store.close();
    },
  };
}
