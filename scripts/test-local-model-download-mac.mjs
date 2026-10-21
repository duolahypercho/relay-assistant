// SPDX-License-Identifier: MIT
// Packaged Mac local backend, actual Ollama registry pull/cache and inference.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ollamaProbe } from '../server/local-model-runtime.mjs';
assert.equal(process.env.RELAY_ALLOW_MODEL_DOWNLOAD, 'true');
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const model = process.env.RELAY_DOWNLOAD_TEST_MODEL;
assert(modelsDirectory && model, 'Set an isolated cache and an explicit model.');
assert.equal((await ollamaProbe()).occupied, false, 'Preserve an existing service.');
const directory = await mkdtemp(join(tmpdir(), 'relay-download-mac-'));
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
  port = new URL(page.url()).port;
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible();
};
const api = (path) => page.evaluate(async (path) => (await fetch('/api/' + path)).json(), path);
try {
  await launch();
  await page
    .getByRole('textbox', { name: 'Message Relay', exact: true })
    .fill('Keep my packaged download draft');
  await page.evaluate(() => {
    location.hash = '#settings?section=models';
  });
  await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ollama', exact: true }).click();
  const download = page.getByRole('region', { name: 'Download a local model', exact: true });
  await expect(download).toBeVisible({ timeout: 30000 });
  if (await download.getByText('Get another model', { exact: true }).count())
    await download.getByText('Get another model', { exact: true }).click();
  await download.getByRole('button', { name: 'Choose another Ollama model', exact: true }).click();
  await download.getByLabel('Ollama model tag', { exact: true }).fill(model);
  await download.getByRole('button', { name: 'Download model', exact: true }).click();
  await expect
    .poll(async () => (await api('models/local/download')).download?.phase, {
      timeout: 600000,
      intervals: [1000],
    })
    .toBe('ready');
  assert.equal((await api('models')).connections.length, 0);
  assert.equal((await api('state')).messages.length, 0);
  await page.getByRole('button', { name: 'Use this model', exact: true }).click();
  await page.evaluate(() => {
    location.hash = '#chat';
  });
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await expect(composer).toHaveValue('Keep my packaged download draft');
  await composer.fill('Reply with exactly: LOCAL DOWNLOAD READY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('LOCAL DOWNLOAD READY', { exact: true })).toBeVisible({
    timeout: 180000,
  });
  await composer.fill('Keep my final packaged download draft');
  await page.screenshot({
    path: resolve('../relay-evidence/local-model-download-local-native-mac.png'),
  });
  await app.close();
  app = null;
  await expect.poll(async () => (await ollamaProbe()).occupied).toBe(false);
  await launch();
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
    'Keep my final packaged download draft',
  );
  assert.equal((await api('models/local/download')).download.phase, 'ready');
  assert.equal((await api('models/local/download')).download.model, model);
  await writeFile(
    resolve('../relay-evidence/local-model-download-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        model,
        checks: [
          'Packaged Mac uses its own bundled backend to start Ollama and pull an explicit registry model',
          'Installed cached weights may be reused; no model autoactivation or chat insertion',
          'Explicit selection followed by real local worker inference',
          'Full native quit drains owned Ollama; relaunch preserves draft and download receipt',
        ],
        scope:
          'Unsigned arm64 Mac, real installed Ollama and dedicated model cache; no Windows/Linux or hosted-provider certification.',
      },
      null,
      2,
    ),
  );
  console.log('PASS packaged Mac local backend download, real inference and relaunch');
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
