// SPDX-License-Identifier: MIT
// Packaged Mac local backend, actual text-only Ollama inference. No downloads.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ollamaProbe } from '../server/local-model-runtime.mjs';
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const model = process.env.RELAY_CAPABILITY_TEST_MODEL;
assert(modelsDirectory && model, 'Set an isolated cache and an explicit model.');
assert.equal((await ollamaProbe()).occupied, false, 'Preserve an existing service.');
const directory = await mkdtemp(join(tmpdir(), 'relay-abilities-mac-'));
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
    .fill('Keep my packaged abilities draft');
  await page.evaluate(() => {
    location.hash = '#settings?section=models';
  });
  await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
  await page.getByRole('button', { name: 'Start Ollama', exact: true }).click();
  await expect(
    page.getByText(
      'Chat & documents · Attach text, PDF or Office files and ask. Photos, apps and assistant actions need a suitable model.',
      { exact: true },
    ),
  ).toBeVisible({ timeout: 30000 });
  assert.equal((await api('models')).connections.length, 0);
  assert.equal((await api('state')).messages.length, 0);
  await page.getByRole('button', { name: 'Use this model', exact: true }).click();
  await page.evaluate(() => {
    location.hash = '#chat';
  });
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await expect(composer).toHaveValue('Keep my packaged abilities draft');
  await composer.fill('Hello, Relay!');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await api('state')).messages
          .filter((m) => m.role === 'assistant')
          .map((m) => m.text)
          .join('\n'),
      { timeout: 180000 },
    )
    .toMatch(/hello|hi\b|hey/i);
  const answered = await api('state');
  assert.equal(answered.runs.at(-1).status, 'completed');
  assert.equal(answered.memories.length, 0);
  await composer.fill('Keep my final packaged abilities draft');
  await page.screenshot({
    path: resolve('../relay-evidence/model-capabilities-local-native-mac.png'),
  });
  await app.close();
  app = null;
  await expect.poll(async () => (await ollamaProbe()).occupied).toBe(false);
  await launch();
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
    'Keep my final packaged abilities draft',
  );
  const selected = await api('models');
  assert.equal(selected.connections.find((c) => c.id === selected.active).model, model);
  await writeFile(
    resolve('../relay-evidence/model-capabilities-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        model,
        response: answered.messages.findLast((m) => m.role === 'assistant').text,
        checks: [
          'Packaged Mac bundled backend detects actual text-only Ollama abilities',
          'Capability label shown before activation',
          'Actual text-only worker reply without HTTP 400 or workspace actions',
          'Full quit drains owned Ollama and relaunch retains draft/model choice',
        ],
        scope:
          'Unsigned arm64 Mac, real installed Ollama and dedicated model cache; no Windows/Linux or hosted-provider certification.',
      },
      null,
      2,
    ),
  );
  console.log('PASS packaged Mac text-only inference and relaunch');
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
