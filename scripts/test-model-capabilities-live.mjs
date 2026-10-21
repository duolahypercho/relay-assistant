// SPDX-License-Identifier: MIT
// Actual text-only chat with an installed model in an explicit test cache. No weights are downloaded.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const model = process.env.RELAY_CAPABILITY_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Set a test model tag and isolated cache directory.');
await mkdir(modelsDirectory, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-capabilities-live-'));
const f = await localModelStartFixture(directory, {
  modelsDirectory,
  isolatedPort: 41334,
  enableDownloads: false,
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(f.url + '/#settings?section=models');
  await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ollama', exact: true }).click();
  await expect(
    page.getByText(
      'Chat & documents · Attach text, PDF or Office files and ask. Photos, apps and assistant actions need a suitable model.',
      { exact: true },
    ),
  ).toBeVisible({ timeout: 30000 });
  const modelAbilities = await f.provider.capabilities.resolve({
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model,
    apiKey: '',
  });
  assert.equal(modelAbilities.tools, false);
  const requests = [],
    transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    return transport(url, init);
  };
  assert.equal(f.provider.configured, false);
  assert.equal(f.store.read().messages.length, 0);
  const setup = page.getByRole('region', { name: 'Local model setup', exact: true });
  await expect(setup.getByLabel('Local model', { exact: true })).toHaveValue(
    JSON.stringify(['ollama', model]),
    { timeout: 15000 },
  );
  await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
  await page.evaluate(() => {
    location.hash = '#chat';
  });
  await page.getByRole('textbox', { name: 'Message Relay', exact: true }).fill('Hello, Relay!');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(
      () =>
        f.store
          .read()
          .messages.filter((m) => m.role === 'assistant' && !m.streaming)
          .map((m) => m.content || m.text || '')
          .join('\n'),
      { timeout: 180000 },
    )
    .toMatch(/hello|hi\b|hey/i);
  await page.screenshot({ path: join(evidence, 'model-capabilities-live.png') });
  assert.equal(f.store.read().runs.at(-1).status, 'completed');
  assert(requests.length > 0 && requests.every((r) => !r.tools));
  assert(requests.every((r) => r.messages[0].content.includes('no tools')));
  const receipt = {
    checkedAt: new Date().toISOString(),
    passed: true,
    model,
    modelAbilities,
    response: f.store.read().messages.findLast((m) => m.role === 'assistant').text,
    checks: [
      'Actual installed text-only Ollama detected automatically',
      'Production UI labels model Chat only before selection',
      'Real assistant worker replies to a greeting without HTTP 400 or tool definitions',
      'No new download, hosted account, tools or invented action',
    ],
    scope:
      'Real Mac Ollama on isolated test port 41334 and explicit test cache; one basic model interaction, not general quality certification.',
  };
  await writeFile(
    join(evidence, 'model-capabilities-live-acceptance.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log('PASS', model, 'actual text-only chat');
} finally {
  await browser.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
