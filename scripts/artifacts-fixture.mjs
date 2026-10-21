// SPDX-License-Identifier: MIT
// Controlled chat provider for acceptance tests. Real agent tools, SQLite and exports.
import express from 'express';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export const artifactExamples = {
  document: {
    kind: 'document',
    title: 'A slower Saturday',
    source:
      '# A slower Saturday\n\nA little room for the things you love.\n\n## The morning\n\n- Take the **9:15 train** to the riverside.\n- Pick up tea from your favourite café.\n- Bring a book and leave your afternoon open.\n\n## A simple budget\n\n| Item | Budget |\n| --- | --- |\n| Return train | $25 |\n| Tea and lunch | $28 |\n| Total | $53 |\n\n[Check the park information](https://example.com/park)',
  },
  spreadsheet: {
    kind: 'spreadsheet',
    title: 'Saturday budget',
    source: JSON.stringify({
      sheets: [
        {
          name: 'Budget',
          rows: [
            ['Item', 'Amount'],
            ['Train', 25],
            ['Tea', 8],
            ['Lunch', 20],
            ['Total', { formula: 'SUM(B2:B4)' }],
          ],
        },
      ],
    }),
  },
  presentation: {
    kind: 'presentation',
    title: 'A weekend worth keeping',
    source: JSON.stringify({
      slides: [
        {
          title: 'Make room for a slower Saturday',
          bullets: [
            'A train ride, a riverside walk, and a little time to yourself.',
            'Keep the plan small enough to enjoy.',
          ],
          notes: 'Leave space for the weather and a spontaneous stop.',
        },
        {
          title: 'The little details',
          bullets: [
            'Return train: $25',
            'Tea and lunch: $28',
            'Bring a book. Leave the afternoon open.',
          ],
          notes: 'All amounts are planning estimates.',
        },
      ],
    }),
  },
  web: {
    kind: 'web',
    title: 'A little breathing space',
    source:
      '<style>body{margin:0;padding:40px 24px;background:#f5f4ec;color:#213b31;font-family:system-ui;text-align:center}main{max-width:470px;margin:auto}h1{font-size:32px;letter-spacing:-1px}.orb{font-size:60px;margin:28px}button{font:inherit;color:#fff;background:#315c49;border:0;border-radius:24px;padding:14px 26px;cursor:pointer}p{line-height:1.7}</style><main><p>A MOMENT FOR YOU</p><div class="orb" aria-hidden="true">🌿</div><h1>A little breathing space.</h1><p id="moment">Let your shoulders soften.</p><button id="breathe">Take a breath</button><p id="count">0 quiet moments</p></main><script>let count=0;document.getElementById("breathe").onclick=()=>{count++;document.getElementById("moment").textContent="Breathe in. Breathe out. You have time.";document.getElementById("count").textContent=count+" quiet moments";}</script>',
  },
};
export async function artifactsFixture(directory, port = 0, { tls, accessKey = '' } = {}) {
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const provider = {
    configured: true,
    model: 'controlled-artifact-test',
    protocol: 'test',
    complete: async (messages) => {
      const tool = messages.at(-1);
      if (tool.role === 'tool') {
        const result = JSON.parse(tool.content);
        return {
          text: result.error
            ? `Could not create this result: ${result.error}`
            : 'Ready. Open your result to preview, edit, or download it.',
          toolCalls: [],
        };
      }
      const request = messages.findLast((m) => m.role === 'user')?.content || '';
      const kind =
        ['spreadsheet', 'presentation', 'web'].find((k) => request.includes(k)) || 'document';
      return {
        text: '',
        toolCalls: [
          {
            id: 'create-result',
            type: 'function',
            function: { name: 'save_artifact', arguments: JSON.stringify(artifactExamples[kind]) },
          },
        ],
      };
    },
  };
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 100 });
  services.worker = worker;
  const app = createApp(store, services, { host: '127.0.0.1', port, accessKey });
  const probes = [];
  app.all('/preview-probe', (req, res) => {
    probes.push(req.url);
    res.send('probe');
  });
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  const server = tls
    ? createServer(tls, app).listen(port, '127.0.0.1')
    : app.listen(port, '127.0.0.1');
  await once(server, 'listening');
  worker.start();
  return {
    store,
    provider,
    server,
    probes,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    async close() {
      await worker.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
