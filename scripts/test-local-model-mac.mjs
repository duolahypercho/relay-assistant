// SPDX-License-Identifier: MIT
// Opt-in inference through the packaged Mac app's own local backend, with isolated data.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const baseUrl = process.env.RELAY_LIVE_MODEL_URL;
const model = process.env.RELAY_LIVE_MODEL_ID;
const quick = process.argv.includes('--quick-setup');
assert(baseUrl && model, 'Set RELAY_LIVE_MODEL_URL and RELAY_LIVE_MODEL_ID.');
const endpoint = new URL(baseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
assert.equal(endpoint.protocol, 'http:');
assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const directory = await mkdtemp(join(tmpdir(), 'relay-local-model-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let app;
let localPort = '0';
const checks = [];
const errors = [];
const launch = async () => {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, `--relay-local-port=${localPort}`],
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
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
    },
  });
  const page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible();
  // Production uses one fixed local origin. Reuse the first allocated test port
  // so browser-local drafts are tested at the same origin after a full restart.
  localPort = new URL(page.url()).port;
  return page;
};
let passed = false;
try {
  let page = await launch();
  const state = () => page.evaluate(async () => (await fetch('/api/state')).json());
  const initial = await state();
  await page.getByRole('textbox', { name: 'Message Relay', exact: true }).fill('Keep my Mac draft');
  await page.evaluate(() => {
    location.hash = '#settings?section=models';
  });
  const panel = page.getByRole('article', { name: 'AI models', exact: true });
  if (quick) {
    assert.equal(
      baseUrl,
      'http://127.0.0.1:11434/v1',
      'Quick setup tests the standard local Ollama port.',
    );
    await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
    await expect(panel.getByLabel('Local model', { exact: true })).toHaveValue(
      JSON.stringify(['ollama', model]),
    );
    await page.screenshot({ path: join(evidence, 'local-model-quick-live-native-mac.png') });
    await panel.getByRole('button', { name: 'Use this model', exact: true }).click();
  } else {
    await panel.getByRole('button', { name: 'Add a model', exact: true }).click();
    await panel.getByLabel('Provider', { exact: true }).selectOption('ollama');
    await panel.getByLabel('Connection name', { exact: true }).fill('My local assistant');
    await panel.getByLabel('Endpoint', { exact: true }).fill(baseUrl);
    await panel.getByRole('button', { name: 'Find models', exact: true }).click();
    await panel.getByLabel('Available models', { exact: true }).selectOption(model);
    await panel.getByRole('button', { name: 'Save & use model', exact: true }).click();
  }
  await expect(panel.getByRole('status')).toContainText('Connection saved');
  assert.deepEqual((await state()).messages, initial.messages);
  await page.evaluate(() => {
    location.hash = '#chat';
  });
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await expect(composer).toHaveValue('Keep my Mac draft');
  checks.push(
    'Native settings discover and save the actual local model without chat noise or draft loss',
  );
  await composer.fill(
    'Create a downloadable plain text file called native-check.txt containing exactly: Hello from Relay',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(async () => (await state()).runs.find((r) => r.threadId === 'main')?.status, {
      timeout: 180000,
    })
    .toBe('completed');
  const after = await state();
  const file = after.files.find((f) => f.name === 'native-check.txt');
  assert(file, 'The installed backend must save the actual requested text file.');
  const downloaded = await page.evaluate(async (id) => {
    const response = await fetch('/api/files/' + id);
    return {
      status: response.status,
      name: response.headers.get('content-disposition'),
      text: await response.text(),
    };
  }, file.id);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.name, /native-check\.txt/);
  assert.equal(downloaded.text, 'Hello from Relay');
  checks.push(
    'Actual inference uses the packaged local agent to create and download exact filename and bytes',
  );
  await composer.fill('Keep this draft after quitting');
  await page.screenshot({
    path: join(
      evidence,
      quick ? 'local-model-quick-live-native-result.png' : 'local-model-native-mac.png',
    ),
  });
  await app.close();
  app = null;
  page = await launch();
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toHaveValue(
    'Keep this draft after quitting',
  );
  assert.deepEqual((await state()).files, after.files);
  await page.evaluate(() => {
    location.hash = '#settings?section=models';
  });
  await expect(
    page.getByRole('heading', {
      name: quick ? `Ollama · ${model}` : 'My local assistant',
      exact: true,
    }),
  ).toBeVisible();
  checks.push(
    'Full native quit and relaunch preserve the model connection, saved file and unfinished draft',
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log('PASS native Mac live local inference, model setup, exact text file and restart');
} finally {
  await writeFile(
    join(
      evidence,
      quick
        ? 'local-model-quick-live-native-mac-acceptance.json'
        : 'local-model-native-mac-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed,
        model,
        checks,
        errors,
        limits:
          'One real local model; unsigned arm64 Mac app using its actual packaged local backend and fictional data. No physical mobile or hosted provider claim.',
      },
      null,
      2,
    ),
  );
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
