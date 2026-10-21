// SPDX-License-Identifier: MIT
// Actual installed chat model in an explicit cache; never downloads weights.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { directDocumentFiles } from './direct-document-fixtures.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const model = process.env.RELAY_DOCUMENT_TEST_MODEL,
  modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed chat model and its isolated test cache.');
const directory = await mkdtemp(join(tmpdir(), 'relay-direct-document-live-'));
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
  await page
    .getByRole('combobox', { name: 'Image support', exact: true })
    .selectOption('unsupported');
  await page.getByRole('button', { name: 'Save & use model', exact: true }).click();
  await expect(
    page.getByText(
      'Chat & documents · Attach text, PDF or Office files and ask. Photos, apps and assistant actions need a suitable model.',
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
  const files = await directDocumentFiles(code);
  await page.evaluate(() => {
    location.hash = '#chat/main';
  });
  await page.locator('.composer input[type=file]').setInputFiles(files);
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
    'Read the four-digit meeting code in my attached note. Reply with only those digits.',
  );
  if (!first.includes(code))
    await writeFile(
      resolve('../../work/direct-document-live-failure.json'),
      JSON.stringify({ first, requests }, null, 2),
    );
  assert(first.includes(code), `Incorrect document code: ${first}`);
  await page.reload();
  const second = await send(
    'Where is my meeting and what should I bring? Use the other two attached documents. Answer briefly.',
  );
  assert.match(second, /Willow/i);
  assert.match(second, /green notebook/i);
  assert.equal(requests.length, 2);
  assert(requests.every((r) => !r.tools));
  for (const fact of [`Meeting code: ${code}.`, 'Willow library.', 'green notebook.'])
    assert(requests.every((r) => JSON.stringify(r).includes(fact)));
  for (const file of files)
    assert.equal(
      f.store.read().files.find((f) => f.name === file.name).base64,
      file.buffer.toString('base64'),
    );
  assert.equal(f.store.read().files.length, 3);
  assert.equal(f.store.read().memories.length, 0);
  await page.screenshot({ path: join(evidence, 'direct-document-live.png') });
  await writeFile(
    join(evidence, 'direct-document-live-acceptance.json'),
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
          'Actual local model reads unpredictable digits from an attached note',
          'Follow-up after reload combines facts from attached PDF and Word documents',
          'No tools sent or actions executed',
          'No weights downloaded',
        ],
        scope:
          'One installed model on arm64 Mac, with explicit tools-off and images-off overrides. Not a certification of every model or hosted service.',
      },
      null,
      2,
    ),
  );
  console.log('PASS actual direct document chat', JSON.stringify({ model, first, second }));
} finally {
  await browser.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
