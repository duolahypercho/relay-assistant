// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { boundedProcess } from '../server/terminal.mjs';
const data = await mkdtemp(join(tmpdir(), 'relay-native-computer-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const name = `relay-desktop-${createHash('sha256').update(join(data, 'workspace')).digest('hex').slice(0, 16)}`;
const executable = process.env.RELAY_DESKTOP_EXECUTABLE;
const env = {
  ...process.env,
  RELAY_MODE: 'sample',
  RELAY_ACCESS_KEY: '',
  RELAY_DESKTOP_ENABLED: 'true',
  RELAY_BROWSER_ENABLED: 'false',
  RELAY_COMPUTER_ENABLED: 'false',
  RELAY_MODEL_BASE_URL: '',
  RELAY_MODEL_ID: '',
  RELAY_MODEL_API_KEY: '',
  RELAY_TRANSCRIPTION_BASE_URL: '',
  RELAY_TRANSCRIPTION_MODEL: '',
  RELAY_TRANSCRIPTION_API_KEY: '',
  RELAY_SPEECH_BASE_URL: '',
  RELAY_SPEECH_MODEL: '',
  RELAY_SPEECH_API_KEY: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};
let application;
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const launch = () =>
  electron.launch({
    args: [
      ...(executable ? [] : [resolve('.')]),
      `--relay-test-data=${data}`,
      '--relay-local-port=0',
    ],
    env,
    ...(executable ? { executablePath: executable } : {}),
    timeout: 40000,
  });
const state = (page) => page.evaluate(async () => (await fetch('/api/state')).json());
try {
  application = await launch();
  let page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  expect((await state(page)).connections.runtime.desktop).toBe(true);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my native computer draft');
  const before = (await state(page)).messages.length;
  await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();
  await page.getByRole('button', { name: 'Start computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
    timeout: 30000,
  });
  check('Packaged app’s own server starts the real private Linux desktop');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByText('Click and type. Drag to move or select. Tab leaves the screen.', {
      exact: true,
    }),
  ).toBeVisible();
  const frozen = await boundedProcess('docker', ['inspect', `${name}-commands`]);
  expect(JSON.parse(frozen.stdout)[0].State.Paused).toBe(true);
  await page.getByText('Commands & activity', { exact: true }).click();
  await page
    .getByLabel('Private computer command')
    .fill("printf 'Saved by native Relay.' > native-proof.txt");
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled({
    timeout: 20000,
  });
  await page
    .locator('.computer-window')
    .getByRole('button', { name: 'Files', exact: true })
    .click();
  const row = page.locator('.computer-file-row').filter({ hasText: 'native-proof.txt' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Save to Relay' }).click();
  await expect
    .poll(async () => (await state(page)).files.some((f) => f.name === 'native-proof.txt'))
    .toBe(true);
  check('Native takeover, command execution and saving a real result to Relay work');
  await application.close();
  application = null;
  await expect
    .poll(
      async () => {
        const r = await boundedProcess('docker', ['inspect', name]);
        return r.exitCode === 0 ? JSON.parse(r.stdout)[0].State.Running : null;
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const stillFrozen = await boundedProcess('docker', ['inspect', `${name}-commands`]);
  expect(JSON.parse(stillFrozen.stdout)[0].State.Paused).toBe(true);
  check('Quitting the native app preserves its desktop and frozen owner-controlled commands');
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native computer draft',
  );
  await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();

  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page
    .locator('.computer-window')
    .getByRole('button', { name: 'Files', exact: true })
    .click();
  await expect(
    page.locator('.computer-file-row').filter({ hasText: 'native-proof.txt' }),
  ).toBeVisible();
  check('Workspace file and owner control survive a full packaged app restart');
  await page.screenshot({ path: join(evidence, 'computer-native-mac.png') });
  await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
  const resumed = await boundedProcess('docker', ['inspect', `${name}-commands`]);
  expect(JSON.parse(resumed.stdout)[0].State.Paused).toBe(false);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native computer draft',
  );
  expect((await state(page)).messages.length).toBe(before);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  check('Handback returns to the same draft without adding chat history or dialogs');
  await writeFile(
    join(evidence, 'computer-native-acceptance.json'),
    JSON.stringify({ testedAt: new Date().toISOString(), packaged: !!executable, checks }, null, 2),
  );
} finally {
  await application?.close().catch(() => {});
  await boundedProcess('docker', ['rm', '-f', `${name}-commands`, name]);
  await boundedProcess('docker', ['volume', 'rm', `${name}-files`, `${name}-display`]);
  await rm(data, { recursive: true, force: true });
}
