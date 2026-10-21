// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { oldComputer, cleanupComputer } from './computer-maintenance-fixture.mjs';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-snapshots-mac-')),
  old = await oldComputer(directory);
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
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence'),
  checks = [];
try {
  app = await electron.launch(options);
  let page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(30000);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my Mac restore draft');
  const open = async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
  };
  await open();
  await page.getByRole('button', { name: 'Start computer', exact: true }).click();
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('Commands & activity', { exact: true }).click();
  const command = async (text) => {
    await page.getByLabel('Private computer command').fill(text);
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
  };
  await command("printf 'native before' > mac-snapshot.txt");
  await page.getByText('Restore points', { exact: true }).click();
  let panel = page.getByRole('region', { name: 'Restore points', exact: true });
  await panel.getByRole('button', { name: 'Save restore point', exact: true }).click();
  await expect(
    panel.getByText('Restore point saved. Your computer is ready to use.', { exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await command("printf 'native later' > mac-snapshot.txt");
  await panel.getByRole('button', { name: /Review restore point/ }).click();
  await page.screenshot({ path: join(evidence, 'computer-snapshots-review-native-mac.png') });
  await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
  await expect(
    panel.getByText(
      'Your workspace is restored. Check your work, then give control back to Relay.',
      { exact: true },
    ),
  ).toBeVisible({ timeout: 120000 });
  expect(
    (await new AxeBuilder({ page }).setLegacyMode(true).include('.computer-page').analyze())
      .violations,
  ).toEqual([]);
  const routes = await page.evaluate(async () => ({
    state: await (await fetch('/api/state')).json(),
    snapshots: await (await fetch('/api/computer/snapshots')).json(),
  }));
  expect(routes.state.messages).toHaveLength(0);
  expect(routes.snapshots.points).toHaveLength(2);
  await page.screenshot({ path: join(evidence, 'computer-snapshots-restored-native-mac.png') });
  await app.close();
  app = null;
  const restoredStore = new Store(join(directory, 'workspace/relay.sqlite'));
  const restoredComputer = new PrivateComputer(restoredStore, {
    deployment: join(directory, 'workspace'),
  });
  new ComputerSetup(restoredComputer, { environment: {} });
  expect(
    Buffer.from((await restoredComputer.read('mac-snapshot.txt')).base64, 'base64').toString(),
  ).toBe('native before');
  restoredStore.close();
  app = await electron.launch(options);
  page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(30000);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my Mac restore draft',
  );
  await open();
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible();
  await page.getByText('Restore points', { exact: true }).click();
  panel = page.getByRole('region', { name: 'Restore points', exact: true });
  await expect(panel.locator('li')).toHaveCount(2);
  checks.push(
    'Packaged local backend saves/restores through the native UI; full app quit/relaunch retains restored volume, two saved points, owner control and original draft.',
  );
  await panel
    .locator('li')
    .filter({ hasText: 'Before restore' })
    .getByRole('button', { name: /Review restore point/ })
    .click();
  await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
  await expect(
    panel.getByText(
      'Your workspace is restored. Check your work, then give control back to Relay.',
      { exact: true },
    ),
  ).toBeVisible({ timeout: 120000 });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my Mac restore draft',
  );
  await app.close();
  app = null;
  const store = new Store(join(directory, 'workspace/relay.sqlite')),
    computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
  new ComputerSetup(computer, { environment: {} });
  try {
    expect(Buffer.from((await computer.read('mac-snapshot.txt')).base64, 'base64').toString()).toBe(
      'native later',
    );
    expect(computer.controller).toBe('owner');
    expect((await computer.runtime.inspect()).State.Paused).toBe(true);
    expect(store.read().messages).toHaveLength(0);
    checks.push(
      'Restoring the automatic before-restore point after native relaunch returns the exact later file bytes, with commands frozen and chat unchanged.',
    );
  } finally {
    await cleanupComputer({ store, computer });
  }
  await writeFile(
    join(evidence, 'computer-snapshots-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Unsigned macOS arm64 app, bundled local backend and existing Docker/Colima engine. Not native phones, signed distribution, lost-disk recovery or live accounts.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS packaged local Mac restore points and restart');
} finally {
  await app?.close();
  const store = new Store(join(directory, 'workspace/relay.sqlite')),
    computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
  new ComputerSetup(computer, { environment: {} });
  // Successful runs already removed containers/volumes. Clear records before the second cleanup.
  const present = await computer.dockerRun([
    'volume',
    'ls',
    '--filter',
    `name=^${computer.volume}$`,
    '--format',
    '{{.Name}}',
  ]);
  if (present.stdout.trim()) await cleanupComputer({ store, computer });
  else store.close();
  await rm(directory, { recursive: true, force: true });
}
