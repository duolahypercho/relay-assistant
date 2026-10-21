// SPDX-License-Identifier: MIT
// Isolated real Docker desktop with a controlled HTTP vision model.
import express from 'express';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ModelProvider } from '../server/model.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
export async function teachingFixture(directory, { tls, accessKey = '' } = {}) {
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const computer = new PrivateComputer(store, {
    enabled: true,
    deployment: directory,
    dockerHost: process.env.DOCKER_HOST,
  });
  let label = 'desktop',
    failDraft = false;
  const modelRequests = [];
  const endpoint = express();
  endpoint.use(express.json({ limit: '24mb' }));
  endpoint.post('/v1/chat/completions', (req, res) => {
    modelRequests.push(req.body);
    const teaching = req.body.messages[0]?.content.startsWith('Turn an owner-recorded');
    if (teaching && failDraft)
      return res.status(503).json({ error: 'Controlled vision model failure' });
    let content, tool_calls;
    if (teaching) {
      const frames = req.body.messages
        .filter((m) => Array.isArray(m.content))
        .map(
          (m) =>
            m.content
              .find((p) => p.type === 'text')
              ?.text.match(/Recorded screenshot ([^.]+)/)?.[1],
        )
        .filter(Boolean);
      content = JSON.stringify({
        title: `Create a note ${label}`,
        slug: `create-note-${label}`,
        description: 'When a local text note is needed',
        inputs: ['A note title'],
        steps: [
          {
            instruction:
              'Reload the example note form. Enter the supplied title, then press Enter to save the text file.',
            sources: frames.slice(0, 3),
          },
        ],
        validation: ['Find the downloaded text file and check its content.'],
        output: 'The downloaded note file',
        boundaries: ['Ask before sending the file to anyone.'],
        uncertainties: ['This example does not show sending or sharing.'],
      });
    } else {
      const results = req.body.messages
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.parse(m.content));
      const error = results.find((r) => r.error);
      if (error) content = `Test failed: ${error.error}`;
      else {
        const calls = [
          ['computer_look', {}],
          ['computer_use', { action: 'key', key: 'ctrl+r', operationId: `test-${label}-reload` }],
          [
            'computer_use',
            { action: 'type', text: `Test ${label}`, operationId: `test-${label}-type` },
          ],
          ['computer_use', { action: 'key', key: 'Return', operationId: `test-${label}-save` }],
          [
            'computer_run',
            {
              command: `find /workspace -type f -name 'test-${label}.txt' -print`,
              operationId: `test-${label}-find`,
            },
          ],
        ];
        let next = calls[results.length];
        if (results.length === 5) {
          const path = results.at(-1)?.result?.stdout?.trim().split('\n')[0];
          next = [
            'computer_export',
            { path: path?.replace(/^\/workspace\//, '') || 'missing-test-file' },
          ];
        }
        if (next)
          tool_calls = [
            {
              id: `step-${results.length}`,
              type: 'function',
              function: { name: next[0], arguments: JSON.stringify(next[1]) },
            },
          ];
        else content = 'The learned method created and checked your test note.';
      }
    }
    res.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: content || null,
            ...(tool_calls ? { tool_calls } : {}),
          },
          finish_reason: tool_calls ? 'tool_calls' : 'stop',
        },
      ],
    });
  });
  const modelServer = endpoint.listen(0, '127.0.0.1');
  await once(modelServer, 'listening');
  const provider = new ModelProvider({
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    protocol: 'chat',
    model: 'controlled-vision',
  });
  const services = {
    mode: 'live',
    computer,
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
  const server = tls ? createHttpsServer(tls, app) : createHttpServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  worker.start();
  const owner = (p) =>
    computer.perform({ ...p, operationId: crypto.randomUUID() }, { actor: 'owner' });
  async function prepare() {
    await computer.takeControl();
    await computer.start('owner');
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Teaching example</title><style>body{font:22px system-ui;background:#f5f2e8;color:#234337;padding:60px}form{display:grid;gap:20px;max-width:650px}input,button{font:inherit;padding:14px}button{background:#356b50;color:white;border:0}h1{font-size:38px}</style><h1>A note worth keeping</h1><form><label for="title">Note title</label><input id="title" autofocus required><button>Save note</button></form><p id="result" role="status"></p><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();const title=document.querySelector('input').value;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Note: '+title+'\\n'],{type:'text/plain'}));a.download=title.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.txt';a.click();document.getElementById('result').textContent='Saved note: '+title;};</script></html>`;
    await owner({
      kind: 'files',
      action: 'write',
      path: 'teaching-example.html',
      base64: Buffer.from(html).toString('base64'),
    });
    await owner({
      kind: 'exec',
      command:
        'chromium --no-sandbox --user-data-dir="$HOME/chromium" --new-window file:///workspace/teaching-example.html >/tmp/teaching-browser.log 2>&1 &',
    });
  }

  return {
    store,
    computer,
    services,
    worker,
    url,
    modelRequests,
    owner,
    prepare,
    setLabel(value) {
      label = value;
    },
    failDraft(value) {
      failDraft = value;
    },
    async close() {
      await worker.stop();
      for (const s of [server, modelServer]) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
      await computer.stop();
      // Only this fixture's deployment-scoped containers and volumes.
      if (await computer.inspect()) await computer.checked(['rm', computer.name]);
      for (const volume of [computer.volume, computer.displayVolume]) {
        const exists = await computer.dockerRun(['volume', 'inspect', volume]);
        if (exists.exitCode === 0) await computer.checked(['volume', 'rm', volume]);
      }
      store.close();
    },
  };
}
