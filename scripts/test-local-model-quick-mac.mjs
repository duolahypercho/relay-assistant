// SPDX-License-Identifier: MIT
// One-click activation through the packaged Mac’s own production backend and real local model.
// Existing system Ollama is left alone; its presence is why installation is requested
// directly through the owner API here. Empty-machine UI is tested in the companion suite.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ollamaProbe } from '../server/local-model-runtime.mjs';
import { ollamaRelease } from '../server/local-model-installation.mjs';
const exec = promisify(execFile),
  modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS,
  model = process.env.RELAY_LOCAL_MODEL_TEST_ID;
assert(modelsDirectory && model, 'Use an explicit existing test model cache.');
assert.equal((await ollamaProbe()).occupied, false, 'Never disturb an existing Ollama listener.');
const directory = await mkdtemp(join(tmpdir(), 'relay-install-own-mac-'));
await mkdir(join(directory, 'home'));
let app,
  page,
  port = '0';
const executable = join(
  directory,
  'workspace/runtimes/ollama',
  'v' + ollamaRelease.version,
  'ollama',
);
const ownedProcess = async () =>
  (await exec('/bin/ps', ['-axo', 'pid=,command='])).stdout
    .split('\n')
    .find((line) => line.trim().endsWith(executable + ' serve'))
    ?.trim()
    .split(/\s+/)[0];
const launch = async () => {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, `--relay-local-port=${port}`],
    env: {
      ...process.env,
      HOME: join(directory, 'home'),
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
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  });
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible();
  port = new URL(page.url()).port;
};
const api = (path, body) =>
  page.evaluate(
    async ({ path, body }) => {
      const result = await fetch(
        '/api/' + path,
        body
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {},
      );
      if (!result.ok) throw Error('Owner API status ' + result.status);
      return result.json();
    },
    { path, body },
  );
try {
  await launch();
  const composer = () => page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer().fill('Keep my installed Mac draft');
  await api('models/local/installation/start', {});
  await expect
    .poll(async () => (await api('models/local/installation')).installation.phase, {
      timeout: 180000,
      intervals: [1000],
    })
    .toBe('ready');
  const receipt = JSON.parse(
    await readFile(
      join(
        directory,
        'workspace/runtimes/ollama',
        'v' + ollamaRelease.version,
        'relay-install.json',
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.sha256, ollamaRelease.sha256);
  assert.equal((await api('state')).messages.length, 0);
  assert.equal((await api('models')).connections.length, 0);
  assert.equal(await ownedProcess(), undefined);
  await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
  await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
  await page.getByRole('button', { name: 'Set up & use', exact: true }).click();
  await expect
    .poll(async () => (await api('models/local/setup')).job?.connected, { timeout: 120000 })
    .toBe(true);
  assert(await ownedProcess(), 'Combined setup must start the private installed executable.');
  assert.equal((await api('models')).connections.length, 1);
  await expect(composer()).toHaveValue('Keep my installed Mac draft');
  await composer().fill('Say hello in one short sentence.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(async () => (await api('state')).runs.at(-1)?.status, {
      timeout: 180000,
      intervals: [1000],
    })
    .toBe('completed');
  const reply = (await api('state')).messages.find((message) => message.role === 'assistant')?.text;
  assert(reply?.trim().length > 0);
  await expect(page.locator('.message.assistant .message-content')).toContainText(
    reply.split('\n\n')[0],
  );
  await composer().fill('Keep my final installed Mac draft');
  await page.screenshot({ path: resolve('../relay-evidence/local-quick-own-mac.png') });
  await app.close();
  app = null;
  await expect.poll(async () => (await ollamaProbe()).occupied).toBe(false);
  assert.equal(await ownedProcess(), undefined);
  await launch();
  await expect(composer()).toHaveValue('Keep my final installed Mac draft');
  await expect.poll(ownedProcess, { timeout: 90000 }).toBeTruthy();
  assert.equal((await api('models/local/installation')).installation.phase, 'ready');
  await app.close();
  app = null;
  await expect.poll(async () => (await ollamaProbe()).occupied).toBe(false);
  assert.equal(await ownedProcess(), undefined);
  await writeFile(
    resolve('../relay-evidence/local-quick-own-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        release: ollamaRelease.version,
        model,
        checks: [
          'Official HTTPS runtime download in bundled backend; published archive digest verified',
          'Separate installer does not activate; the single Set up & use action then starts and connects the suggested model',
          'Real process runs from this private app data folder',
          'One setup action, direct draft return and actual local inference',
          'Full quit stops owned runtime; relaunch restores it and retains draft; second quit drains it',
        ],
        limits:
          'Unsigned arm64 Mac. Installation request uses the owner API because this host already has system Ollama; empty-machine UI is separately exercised.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: packaged local installation, private executable, real inference, quit/relaunch/quit',
  );
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
