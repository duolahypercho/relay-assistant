// SPDX-License-Identifier: MIT
// Actual installed vision model in an explicit cache; never downloads weights.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const model = process.env.RELAY_PHOTO_TEST_MODEL,
  modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed vision model and its isolated test cache.');
const directory = await mkdtemp(join(tmpdir(), 'relay-direct-photo-live-'));
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(f.url + '/#settings?section=models');
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
  const requests = [],
    transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    return transport(url, init);
  };
  const code = String(randomInt(1000, 9999));
  const canvas = createCanvas(700, 480),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 700, 480);
  ctx.fillStyle = '#7829bd';
  ctx.beginPath();
  ctx.moveTo(350, 40);
  ctx.lineTo(490, 255);
  ctx.lineTo(210, 255);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.font = 'bold 100px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(code, 350, 405);
  const photo = canvas.toBuffer('image/png');
  await page.evaluate(() => {
    location.hash = '#chat/main';
  });
  await page
    .locator('.composer input[type=file]')
    .setInputFiles({ name: 'Vision check.png', mimeType: 'image/png', buffer: photo });
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  const send = async (text) => {
    const prior = f.store.read().messages.filter((m) => m.role === 'assistant').length;
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => f.store.read().messages.filter((m) => m.role === 'assistant').length, {
        timeout: 180000,
      })
      .toBe(prior + 1);
    await expect
      .poll(() => f.store.read().runs.at(-1)?.status, { timeout: 180000 })
      .toBe('completed');
    return f.store.read().messages.findLast((m) => m.role === 'assistant').text;
  };
  const first = await send(
    'Read the four-digit code printed in this image. Reply with only those digits.',
  );
  assert(first.includes(code), `Incorrect visual code: ${first}`);
  await page.reload();
  const second = await send('What color and shape are above that code? Answer briefly.');
  assert.match(second, /triangle/i);
  assert.match(second, /purple|violet/i);
  assert.equal(requests.length, 2);
  assert(requests.every((r) => !r.tools));
  assert(requests.every((r) => JSON.stringify(r).includes(photo.toString('base64'))));
  assert.equal(f.store.read().files.length, 1);
  assert.equal(f.store.read().memories.length, 0);
  await page.screenshot({ path: join(evidence, 'direct-photo-live.png') });
  await writeFile(
    join(evidence, 'direct-photo-live-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        model,
        explicitToolsOverride: 'unsupported',
        code,
        first,
        second,
        requests: requests.length,
        checks: [
          'Actual local model reads unpredictable digits from image bytes',
          'Follow-up after reload reads shape and color from the same image',
          'No tools sent or actions executed',
          'No weights downloaded',
        ],
        scope:
          'One installed vision model on arm64 Mac, with an explicit tools-off override. Not a certification of every vision-only model or hosted service.',
      },
      null,
      2,
    ),
  );
  console.log('PASS actual direct photo vision', JSON.stringify({ model, first, second }));
} finally {
  await browser.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
