// SPDX-License-Identifier: MIT
// A deterministic independent HTTP provider; all files, tools and exports use production code.
import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { renderArtifact } from '../server/artifacts.mjs';
import { artifactKinds } from '../shared/artifacts.mjs';
export const officeExamples = {
  document: {
    title: 'Weekend plan',
    kind: 'document',
    source: '# Weekend plan\n\nTrain 25. Tea 8.\n\nBring a book. 你好 🌱',
  },
  spreadsheet: {
    title: 'Weekend budget',
    kind: 'spreadsheet',
    source: JSON.stringify({
      sheets: [
        {
          name: 'Budget',
          rows: [
            ['Item', 'Cost'],
            ['Train', 25],
            ['Tea', 8],
            ['Total', { formula: 'SUM(B2:B3)' }],
          ],
        },
      ],
    }),
  },
  presentation: {
    title: 'Weekend briefing',
    kind: 'presentation',
    source: JSON.stringify({
      slides: [{ title: 'Weekend plan', bullets: ['Train 25', 'Tea 8'], notes: 'Meet at nine.' }],
    }),
  },
};
export async function officeFixture(directory, port = 0, tls) {
  const requests = [],
    readResults = [],
    errors = [];
  const sources = {};
  for (const [kind, example] of Object.entries(officeExamples)) {
    const { bytes } = await renderArtifact(example);
    sources[kind] = {
      name: example.title + '.' + artifactKinds[kind].extension,
      mimeType: artifactKinds[kind].mime,
      buffer: Buffer.from(bytes),
    };
  }
  const endpoint = express();
  endpoint.use(express.json({ limit: '2mb' }));
  endpoint.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    try {
      assert.equal(req.headers.authorization, 'Bearer office-fixture-key');
      const last = req.body.messages.at(-1);
      const user = req.body.messages.findLast((m) => m.role === 'user');
      const content =
        typeof user.content === 'string'
          ? user.content
          : user.content.map((p) => p.text || '').join('\n');
      const kind = ['spreadsheet', 'presentation'].find((k) => content.includes(k)) || 'document';
      let name, args, text;
      if (last.role !== 'tool') {
        const id = /Attached workspace file IDs: ([^,\s]+)/.exec(content)?.[1];
        assert.ok(id, 'Provider must receive the selected file ID');
        name = 'read_file';
        args = { id };
      } else {
        const value = JSON.parse(last.content);
        assert.ok(!value.error, value.error);
        if (value.result.contentHash) {
          readResults.push(value.result);
          assert.equal(value.result.kind, kind);
          assert.match(value.result.text, /Tea/);
          assert.match(value.result.text, /8/);
          assert.doesNotMatch(value.result.text, /PK\u0003\u0004/);
          assert.equal(value.result.nextOffset, null);
          const source =
            kind === 'document'
              ? '# Weekend plan\n\nTrain 25. Tea 9.\n\nBring a book. 你好 🌱'
              : kind === 'spreadsheet'
                ? JSON.stringify({
                    sheets: [
                      {
                        name: 'Budget',
                        rows: [
                          ['Item', 'Cost'],
                          ['Train', 25],
                          ['Tea', 9],
                          ['Total', { formula: 'SUM(B2:B3)' }],
                        ],
                      },
                    ],
                  })
                : JSON.stringify({
                    slides: [
                      {
                        title: 'Weekend plan',
                        bullets: ['Train 25', 'Tea 9'],
                        notes: 'Meet at nine.',
                      },
                    ],
                  });
          name = 'save_artifact';
          args = { kind, title: `Revised ${kind}`, source };
        } else {
          assert.ok(value.result.fileId);
          text = `Updated the ${kind}. Your original file is unchanged.`;
        }
      }
      res.json({
        choices: [
          {
            message: text
              ? { role: 'assistant', content: text }
              : {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: `office-${name}-${requests.length}`,
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
            finish_reason: text ? 'stop' : 'tool_calls',
          },
        ],
      });
    } catch (error) {
      errors.push(error.message);
      res.status(500).json({ error: 'Office fixture assertion failed.' });
    }
  });
  const providerServer = endpoint.listen(0, '127.0.0.1');
  await once(providerServer, 'listening');
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const provider = new ModelConnections(store, { key: modelVaultKey(directory) });
  provider.save({
    preset: 'custom',
    name: 'Office acceptance',
    model: 'office-fixture-model',
    protocol: 'chat',
    baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`,
    apiKey: 'office-fixture-key',
    activate: true,
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
  const app = createApp(store, services, { host: '127.0.0.1', port, accessKey: '' });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls
    ? createHttpsServer(tls, app).listen(port, '127.0.0.1')
    : app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    app,
    store,
    sources,
    requests,
    readResults,
    errors,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
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
