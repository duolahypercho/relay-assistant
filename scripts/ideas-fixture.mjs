// SPDX-License-Identifier: MIT
// Controlled HTTP model for acceptance tests. Not a production suggestion fallback.
import express from 'express';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function ideasFixture(directory, port = 0) {
  const requests = [],
    controls = { fail: false };
  const endpoint = express();
  endpoint.use(express.json({ limit: '12mb' }));
  endpoint.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    const suggestions = req.body.messages[0]?.content.startsWith('Suggest a small number');
    if (suggestions && controls.fail)
      return res.status(503).json({ error: 'Controlled provider failure' });
    const goal = suggestions
      ? JSON.parse(req.body.messages[1].content).context.sources.find(
          (source) => source.type === 'goal',
        )
      : null;
    const content = suggestions
      ? JSON.stringify({
          ideas: [
            {
              topic: 'walking-plan',
              title: 'A little room for a walk',
              description:
                'You want to get outside more. A short route could make the first walk easier to fit in.',
              prompt: 'Help me plan a short walk near home.',
              whyNow: 'Your walking goal is still open.',
              importance: 'useful',
              notify: false,
              sources: [{ ref: goal?.ref || 'goal:walk', quote: goal?.title || 'Walk outdoors' }],
            },
          ],
        })
      : 'Let’s start with a short route and choose a time that works for you.';
    res.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  });
  const providerServer = endpoint.listen(0, '127.0.0.1');
  await once(providerServer, 'listening');
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  store.mutate((s) => {
    s.goals.push({
      id: 'walk',
      title: 'Walk outdoors',
      description: 'Get outside three times this week.',
      current: 0,
      target: 3,
      unit: 'walks',
      milestones: [],
    });
  });
  const provider = new ModelConnections(store, { key: modelVaultKey(directory) });
  provider.save({
    preset: 'custom',
    name: 'Controlled ideas model',
    baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`,
    protocol: 'chat',
    model: 'ideas-test',
    apiKey: '',
    activate: true,
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
  const app = createApp(store, services, { host: '127.0.0.1', port, accessKey: '' });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    provider,
    services,
    worker,
    requests,
    controls,
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
