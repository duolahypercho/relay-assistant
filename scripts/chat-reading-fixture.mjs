// SPDX-License-Identifier: MIT
// Original, synthetic conversations for reading-position acceptance; no model or owner data.
import express from 'express';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
export async function chatReadingFixture({ tls, accessKey = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reading-fixture-'));
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const messages = (threadId, count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `reading-${threadId}-${String(i).padStart(2, '0')}`,
      threadId,
      role: i % 2 ? 'assistant' : 'user',
      text:
        `${threadId === 'main' ? 'Main' : 'Side'} note ${String(i).padStart(2, '0')}. ` +
        'A quiet walk by the river gives us room to think. We can return to this idea when we are ready. '.repeat(
          3,
        ),
      createdAt: new Date(Date.now() - (count - i) * 60000).toISOString(),
      cards: [],
    }));
  store.mutate((state) => {
    state.threads.push({
      id: 'reading-side',
      title: 'Reading side chat',
      createdAt: new Date().toISOString(),
      draft: 'Keep the side draft',
      archived: false,
    });
    state.threads[0].draft = 'Keep the main draft';
    state.messages = [...messages('main', 40), ...messages('reading-side', 24)];
  });
  const app = createApp(
    store,
    {
      mode: 'sample',
      provider: {},
      google: {},
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey },
  );
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls ? httpsServer(tls, app) : httpServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    store,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    addMessage() {
      store.mutate((state) =>
        state.messages.push({
          ...messages('main', 1)[0],
          id: 'reading-background',
          text: 'A new result arrived while you were reading.',
        }),
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
