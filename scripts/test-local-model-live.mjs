// SPDX-License-Identifier: MIT
// Opt-in live inference acceptance. No mock replies or owner workspace data.
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { chromium, expect } from '@playwright/test';

const baseUrl = process.env.RELAY_LIVE_MODEL_URL;
const model = process.env.RELAY_LIVE_MODEL_ID;
assert(
  baseUrl && model,
  'Set RELAY_LIVE_MODEL_URL and RELAY_LIVE_MODEL_ID to an installed local model.',
);
const endpoint = new URL(baseUrl);
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
  'Live acceptance uses only a loopback model service.',
);
assert.equal(endpoint.protocol, 'http:');
assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const directory = await mkdtemp(join(tmpdir(), 'relay-local-model-live-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'workspace.sqlite'), { sample: false });
const requests = [];
const computerEvents = [];
const computerHost = process.env.RELAY_LIVE_COMPUTER_HOST;
const computer = computerHost
  ? new PrivateComputer(store, { enabled: true, deployment: directory, dockerHost: computerHost })
  : null;
if (computer) {
  const screenshot = computer.screenshot.bind(computer);
  computer.screenshot = async () => {
    const result = await screenshot();
    computerEvents.push({ action: 'look', pixels: Boolean(result.screenshot) });
    return result;
  };
  const perform = computer.perform.bind(computer);
  computer.perform = async (p, options = {}) => {
    const result = await perform(p, options);
    computerEvents.push({ actor: options.actor || 'agent', kind: p.kind, action: p.action });
    return result;
  };
}
const provider = new ModelConnections(store, {
  key: modelVaultKey(directory),
  fetcher: async (url, options) => {
    const body = options?.body && JSON.parse(options.body);
    requests.push({
      path: new URL(url).pathname,
      model: body?.model,
      messages: body?.messages?.length,
      tools: body?.tools?.length,
      selectedTools: body?.messages?.flatMap((m) =>
        (m.tool_calls || []).map((t) => t.function.name),
      ),
    });
    return fetch(url, options);
  },
});
const services = {
  mode: 'live',
  provider,
  google: { configured: false },
  browser: { enabled: false },
  terminal: { enabled: false },
  ...(computer ? { computer } : {}),
};
const worker = new BackgroundWorker(store, services, { pollMs: 100 });
services.worker = worker;
const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: '' });
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
worker.start();
const checks = [];
let passed = false;
let browser;
async function post(path, body) {
  const response = await fetch(url + '/api/' + path, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const command = async (action, payload) => (await post('command', { action, payload })).result;
async function ask(text, { threadId = 'main', fileIds = [] } = {}) {
  const before = new Set(store.read().runs.map((r) => r.id));
  await command('chat.send', { threadId, text, fileIds });
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const run = store.read().runs.find((r) => !before.has(r.id) && r.threadId === threadId);
    if (run && !['queued', 'running'].includes(run.status)) {
      assert.equal(run.status, 'completed', JSON.stringify(run));
      const reply = store
        .read()
        .messages.findLast((m) => m.threadId === threadId && m.role === 'assistant');
      assert(reply?.text, 'A completed live request must have a visible reply.');
      return reply.text;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Live model did not finish within four minutes.');
}
try {
  const discovery = await post('models/discover', {
    preset: 'ollama',
    protocol: 'chat',
    baseUrl,
    apiKey: '',
  });
  assert(
    discovery.models.some((m) => m.id === model),
    'The real service must list the chosen model.',
  );
  await post('models/save', {
    preset: 'ollama',
    name: 'Live local acceptance',
    protocol: 'chat',
    baseUrl,
    model,
    apiKey: '',
    activate: true,
  });
  assert.equal(store.read().messages.length, 0);
  checks.push({
    check: 'Real local model discovery and saved connection without setup chat messages',
    passed: true,
  });
  console.log('PASS live model discovery and connection');

  const remembered = await ask('I prefer quiet hotels. Please remember that for future trips.');
  assert(
    store.read().memories.some((m) => /quiet/i.test(m.text) && /hotel/i.test(m.text)),
    'A real memory tool must save the preference.',
  );
  const side = await command('thread.create', { title: 'Live memory recall' });
  const recalled = await ask('What hotel preference do you have saved for me?', {
    threadId: side.id,
  });
  assert.match(recalled, /quiet/i);
  checks.push({
    check:
      'Actual model chooses a memory tool and recalls the saved preference in a fresh side chat',
    passed: true,
    remembered,
    recalled,
  });
  console.log('PASS live memory write and cross-chat recall');

  const canvas = createCanvas(640, 400),
    context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = '#d70022';
  context.beginPath();
  context.moveTo(100, 300);
  context.lineTo(270, 40);
  context.lineTo(440, 300);
  context.closePath();
  context.fill();
  context.fillStyle = 'black';
  context.font = 'bold 48px sans-serif';
  context.fillText('4632', 455, 340);
  const image = await command('file.add', {
    name: 'shape-check.png',
    mime: 'image/png',
    base64: canvas.toBuffer('image/png').toString('base64'),
  });
  const visionThread = await command('thread.create', { title: 'Live image reading' });
  const vision = await ask(
    'Inspect the attached image and tell me its main shape, its color, and the four-digit code. Do not guess from the file name.',
    { threadId: visionThread.id, fileIds: [image.id] },
  );
  assert.match(vision, /triangle/i);
  assert.match(vision, /red/i);
  assert.match(vision, /4632/);
  checks.push({
    check: 'Actual local vision model reads original image pixels through Relay attachment tools',
    passed: true,
    reply: vision,
  });
  console.log('PASS live image understanding');

  const artifactThread = await command('thread.create', { title: 'Live file creation' });
  const reply = await ask(
    'Create a downloadable text file called weekend-plan.txt containing exactly these three lines: Walk by the river; Pack a book; Bring water. Put each item on its own line, without bullets.',
    { threadId: artifactThread.id },
  );
  const file = store.read().files.find((f) => f.name === 'weekend-plan.txt');
  assert(file, 'The model must create a saved file, not just claim it did.');
  const content = file.text ?? Buffer.from(file.base64, 'base64').toString('utf8');
  assert.equal(content.trim(), 'Walk by the river\nPack a book\nBring water');
  checks.push({
    check: 'Actual model creates a downloadable file with independently verified exact text',
    passed: true,
    reply,
  });
  console.log('PASS live file creation and exact bytes');

  if (computer) {
    await computer.start('owner');
    await computer.takeControl();
    const caption = `SEABIRD ${randomInt(1000, 10000)}`;
    const program = `import tkinter as tk\nr=tk.Tk()\nr.title('Screen reading check')\nr.geometry('900x420+180+140')\nr.attributes('-topmost',True)\nr.configure(bg='white')\ntk.Label(r,text=${JSON.stringify(caption)},font=('DejaVu Sans',54),bg='white',fg='black').pack(expand=True)\nr.mainloop()`;
    // Original pixels in an ephemeral guest window, with no caption in the model's prompt
    // or any workspace fixture file. The model receives the real screenshot through its tool.
    const encoded = Buffer.from(program).toString('base64');
    await computer.perform(
      {
        kind: 'exec',
        operationId: randomUUID(),
        command: `python3 -c "import base64; exec(base64.b64decode('${encoded}'))" >/tmp/relay-live-screen.log 2>&1 </dev/null &`,
      },
      { actor: 'owner' },
    );
    await expect
      .poll(async () => (await computer.screenshot()).title, { timeout: 15000 })
      .toContain('Screen reading check');
    const frame = await computer.screenshot();
    await writeFile(
      join(evidence, 'local-model-computer-screen.jpg'),
      Buffer.from(frame.screenshot, 'base64'),
    );
    await computer.release();
    computerEvents.length = 0;
    const task = await command('thread.create', { title: 'Live computer task' });
    const result = await ask(
      'Look at the actual screen of my private computer. Read the large caption in the open window. Run Python in the private computer to write that exact caption into observed-code.txt in /workspace, without a trailing newline, then export that file to Relay Files. Do not infer the caption from a filename.',
      { threadId: task.id },
    );
    assert(
      computerEvents.some((e) => e.action === 'look' && e.pixels),
      'The agent must observe real screen pixels.',
    );
    assert(
      computerEvents.some((e) => e.actor === 'agent' && e.kind === 'exec'),
      'The agent must actually run a guest command.',
    );
    const guest = await computer.read('observed-code.txt');
    assert.equal(Buffer.from(guest.base64, 'base64').toString('utf8'), caption);
    const exported = store.read().files.find((f) => f.name === 'observed-code.txt');
    assert(exported, 'The actual guest file must be exported.');
    assert.equal(Buffer.from(exported.base64, 'base64').toString('utf8'), caption);
    checks.push({
      check:
        'Real model observes unpredictable guest pixels, runs Python, and exports independently verified exact bytes',
      passed: true,
      caption,
      reply: result,
      events: [...computerEvents],
    });
    console.log('PASS live private computer observation, command and export');
  }

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const uiErrors = [];
  for (const page of [desktop, phone]) page.on('pageerror', (e) => uiErrors.push(e.message));
  await desktop.goto(url + '/#chat');
  await phone.goto(url + '/#chat');
  const desktopDraft = desktop.getByRole('textbox', { name: 'Message Relay', exact: true });
  await desktopDraft.fill('Keep this draft while my phone replies');
  const phoneComposer = phone.getByRole('textbox', { name: 'Message Relay', exact: true });
  const previous = new Set(store.read().runs.map((r) => r.id));
  await phoneComposer.fill('What is 14 plus 28? Answer in one short sentence.');
  await phone.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => store.read().runs.find((r) => !previous.has(r.id))?.status, { timeout: 120000 })
    .toBe('completed');
  const answer = store
    .read()
    .messages.findLast((m) => m.threadId === 'main' && m.role === 'assistant').text;
  assert.match(answer, /42/);
  for (const page of [desktop, phone])
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(desktopDraft).toHaveValue('Keep this draft while my phone replies');
  const download = await fetch(url + '/api/files/' + file.id);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /weekend-plan\.txt/);
  assert.equal((await download.text()).trim(), 'Walk by the river\nPack a book\nBring water');
  await desktop.screenshot({ path: join(evidence, 'local-model-live-desktop.png') });
  await phone.screenshot({ path: join(evidence, 'local-model-live-phone.png') });
  assert.deepEqual(uiErrors, []);
  checks.push({
    check:
      'Phone UI sends a real model request; desktop receives the same answer without losing its draft; actual text download preserves name and content',
    passed: true,
    reply: answer,
  });
  console.log('PASS live desktop and phone chat, draft preservation and download');
  passed = true;
} finally {
  await writeFile(
    join(evidence, 'local-model-live-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed,
        model,
        baseUrl,
        checks,
        requests,
        runs: store.read().runs,
        messages: store.read().messages,
        files: store.read().files.map(({ base64, ...file }) => file),
        limits:
          'One local model on this Mac with fictional workspace content. No hosted-account, physical-device, unrestricted semantic-quality or complete product-parity claim.',
      },
      null,
      2,
    ),
  );
  await worker.stop();
  await browser?.close();
  services.connectors?.close();
  await services.notifications?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (computer) {
    await computer.stop();
    await computer.checked(['rm', '-f', computer.name, computer.runtime.name]);
    await computer.checked(['volume', 'rm', computer.volume, computer.displayVolume]);
  }
  store.close();
  await rm(directory, { recursive: true, force: true });
}
