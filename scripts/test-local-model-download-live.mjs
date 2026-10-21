// SPDX-License-Identifier: MIT
// Opt-in real registry download and inference in an explicit test cache. Never uses owner data.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
assert.equal(
  process.env.RELAY_ALLOW_MODEL_DOWNLOAD,
  'true',
  'Explicitly opt in to downloading model weights.',
);
const model = process.env.RELAY_DOWNLOAD_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Set a test model tag and isolated cache directory.');
await mkdir(modelsDirectory, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-download-live-'));
const f = await localModelStartFixture(directory, {
  modelsDirectory,
  isolatedPort: 41334,
  enableDownloads: true,
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(f.url + '/#settings?section=models');
  await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ollama', exact: true }).click();
  const download = page.getByRole('region', { name: 'Download a local model', exact: true });
  await expect(download).toBeVisible({ timeout: 30000 });
  const installedBefore = (await f.provider.discoverLocal()).services[0].models.map((m) => m.id);
  if (installedBefore.length)
    await download.getByText('Get another model', { exact: true }).click();
  await download.getByRole('button', { name: 'Choose another Ollama model', exact: true }).click();
  await download.getByLabel('Ollama model tag', { exact: true }).fill(model);
  await download.getByRole('button', { name: 'Download model', exact: true }).click();
  let maxBytes = 0;
  const updates = [];
  await expect
    .poll(
      () => {
        const state = f.downloads.status().download;
        if (state?.total) {
          maxBytes = Math.max(maxBytes, state.total);
          if (updates.length < 10)
            updates.push({ stage: state.stage, completed: state.completed, total: state.total });
        }
        return state?.phase;
      },
      { timeout: 600000, intervals: [1000] },
    )
    .toBe('ready');
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
  await page
    .getByRole('textbox', { name: 'Message Relay', exact: true })
    .fill('Reply with exactly: LOCAL DOWNLOAD READY');
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
    .toContain('LOCAL DOWNLOAD READY');
  await page.screenshot({ path: join(evidence, 'local-model-download-live.png') });
  const receipt = {
    checkedAt: new Date().toISOString(),
    passed: true,
    model,
    installedBefore,
    largestReportedFileBytes: maxBytes,
    progressSamples: updates,
    checks: [
      'Real installed Ollama startup from production UI',
      'Explicit registry pull into isolated cache, verified installed model',
      'No automatic activation or chat insertion',
      'Explicit selection and real local assistant inference',
    ],
    scope:
      'Real Mac Ollama, relocated test port 41334, dedicated test cache. No hosted account or general model-quality certification.',
  };
  await writeFile(
    join(evidence, 'local-model-download-live-acceptance.json'),
    JSON.stringify(receipt, null, 2),
  );
  console.log('PASS', model, 'actual registry download and inference');
} finally {
  await browser.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
