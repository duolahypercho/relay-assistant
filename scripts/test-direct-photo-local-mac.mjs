// SPDX-License-Identifier: MIT
// Packaged Mac local backend, actual tools-free photo inference. No downloads.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { randomInt } from 'node:crypto';
import { ollamaProbe } from '../server/local-model-runtime.mjs';
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const model = process.env.RELAY_PHOTO_TEST_MODEL;
assert(modelsDirectory && model, 'Set an isolated cache and an explicit model.');
assert.equal((await ollamaProbe()).occupied, false, 'Preserve an existing service.');
const directory = await mkdtemp(join(tmpdir(), 'relay-photo-mac-'));
let app,
  page,
  port = '0';
const launch = async () => {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, `--relay-local-port=${port}`],
    env: {
      ...process.env,
      RELAY_DESKTOP_ENV: '',
      RELAY_MODE: 'live',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: '',
      RELAY_MODEL_ID: '',
      RELAY_MODEL_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      OLLAMA_MODELS: modelsDirectory,
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
    },
  });
  page = await app.firstWindow();
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.log('Navigation', frame.url());
  });
  port = new URL(page.url()).port;
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible();
};
const api = (path) => page.evaluate(async (path) => (await fetch('/api/' + path)).json(), path);
try {
  await launch();
  await page
    .getByRole('textbox', { name: 'Message Relay', exact: true })
    .fill('Keep my initial photo draft');
  await page.getByRole('button', { name: 'Self-hosted sample', exact: true }).click();
  await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ollama', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this model', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByLabel('Local model', { exact: true })
    .selectOption(JSON.stringify(['ollama', model]));
  await page.getByRole('button', { name: 'Use this model', exact: true }).click();
  await page.getByRole('button', { name: `Edit Ollama · ${model}`, exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Assistant actions', exact: true })
    .selectOption('unsupported');
  await page.getByRole('button', { name: 'Save & use model', exact: true }).click();
  await expect(
    page.getByText(
      'Chat, photos & documents · Attach a file and ask. Apps and assistant actions need a model with tools.',
      { exact: true },
    ),
  ).toBeVisible();
  const code = String(randomInt(1000, 9999)),
    canvas = createCanvas(650, 420),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 650, 420);
  ctx.fillStyle = '#2160cf';
  ctx.fillRect(240, 30, 170, 170);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.font = 'bold 100px Arial';
  ctx.fillText(code, 325, 350);
  const photo = canvas.toBuffer('image/png');
  await page.evaluate(() => {
    location.hash = '#chat/main';
  });
  await page
    .locator('.composer input[type=file]')
    .setInputFiles({ name: 'Native photo.png', mimeType: 'image/png', buffer: photo });
  const send = async (text) => {
    const prior = (await api('state')).messages.filter((m) => m.role === 'assistant').length;
    await page.getByRole('textbox', { name: 'Message Relay', exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(
        async () => (await api('state')).messages.filter((m) => m.role === 'assistant').length,
        { timeout: 180000 },
      )
      .toBe(prior + 1);
    await expect
      .poll(async () => (await api('state')).runs.at(-1)?.status, { timeout: 180000 })
      .toBe('completed');
    return (await api('state')).messages.findLast((m) => m.role === 'assistant').text;
  };
  const first = await send('Read the four-digit code in this picture. Reply with just the digits.');
  assert(first.includes(code), first);
  const draft = 'Keep my native photo follow-up';
  await page.getByRole('textbox', { name: 'Message Relay', exact: true }).fill(draft);
  await expect
    .poll(async () => (await api('state')).threads.find((t) => t.id === 'main').draft)
    .toBe(draft);
  await app.close();
  app = null;
  await expect.poll(async () => (await ollamaProbe()).occupied).toBe(false);
  await launch();
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
    draft,
  );
  // The visible start-with-Relay choice was left enabled at the first startup.
  await expect
    .poll(async () => (await api('models/local/runtime')).running, { timeout: 30000 })
    .toBe(true);
  assert.equal((await api('models/local/runtime')).startWithRelay, true);
  const second = await send('What color and shape were above the code? Answer briefly.');
  assert.match(second, /blue/i);
  assert.match(second, /square/i);
  const state = await api('state'),
    models = await api('models');
  assert.equal(
    models.connections.find((c) => c.id === models.active).abilities.tools,
    'unsupported',
  );
  assert.equal(state.files.length, 1);
  assert.equal(state.memories.length, 0);
  await page.screenshot({ path: resolve('../relay-evidence/direct-photo-local-native-mac.png') });
  await writeFile(
    resolve('../relay-evidence/direct-photo-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        model,
        code,
        first,
        second,
        checks: [
          'Packaged Mac own bundled backend reads unpredictable image digits',
          'Full application quit stops its owned Ollama',
          'History/photo bytes and draft survive full relaunch',
          'Real vision follow-up after saved automatic model startup',
          'Tools-off override remains saved, no workspace actions',
        ],
        scope:
          'Unsigned arm64 Mac with actual installed Qwen and dedicated test cache. Not other desktop operating systems or hosted-provider certification.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS packaged Mac direct photo vision and full relaunch',
    JSON.stringify({ first, second }),
  );
} catch (error) {
  if (app && page && !page.isClosed())
    await page
      .screenshot({ path: resolve('../relay-evidence/direct-photo-local-native-mac-failure.png') })
      .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
