// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { oldComputer, cleanupComputer } from './computer-maintenance-fixture.mjs';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-maintenance-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const old = await oldComputer(directory);
const oldImage = old.computer.image;
old.store.close();
let app;
const options = {
  executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
  args: [`--relay-test-data=${directory}`, '--relay-local-port=0'],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(RELAY_|GOOGLE_|DOCKER_)/.test(k)),
    ),
    RELAY_MODE: 'sample',
    RELAY_BROWSER_ENABLED: 'false',
  },
};
const checks = [];
try {
  app = await electron.launch(options);
  let page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(30000);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my Mac update draft');
  const before = await page.evaluate(async () => (await fetch('/api/state')).json());
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: 'Start computer', exact: true }).click();
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('Commands & activity', { exact: true }).click();
  await page
    .getByLabel('Private computer command')
    .fill("printf 'Mac update kept me' > mac-update.txt");
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
  await page.getByText('Computer care', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restart & update', exact: true })).toBeVisible({
    timeout: 120000,
  });
  await page.screenshot({ path: join(evidence, 'computer-maintenance-review-native-mac.png') });
  await page.getByRole('button', { name: 'Restart & update', exact: true }).click();
  await expect(
    page.getByText('Your computer is ready. Check your work, then give control back to Relay.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).setLegacyMode(true).include('.computer-page').analyze())
      .violations,
  ).toEqual([]);
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  expect(after.messages).toEqual(before.messages);
  await page.screenshot({ path: join(evidence, 'computer-maintenance-ready-native-mac.png') });
  checks.push(
    'Bundled local Mac backend updates a prepared older image using its own bundled sources, preserves file/history/draft and leaves owner in control',
  );
  await app.close();
  app = null;
  app = await electron.launch(options);
  page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(30000);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my Mac update draft',
  );
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible();
  const files = await page.evaluate(async () => (await fetch('/api/computer/files')).json());
  expect(JSON.stringify(files)).toContain('mac-update.txt');
  await page.getByText('Computer care', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(
    page.getByText('Your computer has the latest workspace included with this Relay app.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
  checks.push(
    'Full app quit/relaunch restores updated image and owner freeze; saved file and chat draft survive; same-version check does not restart',
  );
  await app.close();
  app = null;
  const store = new Store(join(directory, 'workspace/relay.sqlite'));
  const computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
  new ComputerSetup(computer, { environment: {} });
  try {
    expect(computer.image).not.toBe(oldImage);
    expect(Buffer.from((await computer.read('mac-update.txt')).base64, 'base64').toString()).toBe(
      'Mac update kept me',
    );
  } finally {
    await cleanupComputer({ store, computer });
  }
  await writeFile(
    join(evidence, 'computer-maintenance-native-mac-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Unsigned macOS arm64 with installed/running Colima. Recovery failure and rollback are covered separately; not signed distribution, native phones or live-account acceptance.',
      },
      null,
      2,
    ),
  );
  console.log('PASS packaged local Mac update and relaunch');
} finally {
  await app?.close();
  const store = new Store(join(directory, 'workspace/relay.sqlite'));
  const computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
  new ComputerSetup(computer, { environment: {} });
  await cleanupComputer({ store, computer });
  await rm(directory, { recursive: true, force: true });
}
