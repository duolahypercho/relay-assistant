// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-computer-setup-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let app;
const checks = [];
const options = {
  executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
  args: [`--relay-test-data=${directory}`, '--relay-local-port=0'],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(RELAY_|GOOGLE_|DOCKER_)/.test(key)),
    ),
    RELAY_MODE: 'sample',
    RELAY_BROWSER_ENABLED: 'false',
  },
};
try {
  app = await electron.launch(options);
  let page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(20000);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my computer setup draft');
  const before = await page.evaluate(async () => (await fetch('/api/state')).json());
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Set up computer', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'computer-setup-start-native-mac.png') });
  await page.getByRole('button', { name: 'Set up computer', exact: true }).click();
  const deadline = Date.now() + 20 * 60000;
  while (true) {
    const state = await page.evaluate(async () => (await fetch('/api/computer/setup')).json());
    if (state.phase === 'error') throw new Error(state.error);
    if (state.phase === 'ready') break;
    if (Date.now() > deadline) throw new Error('Native computer setup timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
  await expect(page.getByRole('button', { name: 'Start computer', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
    timeout: 45000,
  });
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('Commands & activity', { exact: true }).click();
  await page
    .getByLabel('Private computer command')
    .fill("printf 'Native setup works' > native-setup.txt");
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
  const content = await page.evaluate(async () => (await fetch('/api/computer/files')).json());
  expect(JSON.stringify(content)).toContain('native-setup.txt');
  await page.screenshot({ path: join(evidence, 'computer-setup-ready-native-mac.png') });
  expect(
    (await new AxeBuilder({ page }).setLegacyMode(true).include('.computer-page').analyze())
      .violations,
  ).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  expect(after.messages).toEqual(before.messages);
  checks.push(
    'Fresh unsigned Mac app profile uses bundled local server and extracted original image files; actual Docker setup, desktop start, owner control and command-created file work without env files or terminal setup',
  );
  await app.close();
  app = null;
  app = await electron.launch(options);
  page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(20000);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my computer setup draft',
  );
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole('button', { name: 'Set up computer', exact: true })).toHaveCount(0);
  const restored = await page.evaluate(async () => (await fetch('/api/computer/files')).json());
  expect(JSON.stringify(restored)).toContain('native-setup.txt');
  await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my computer setup draft',
  );
  checks.push(
    'Full packaged-app quit/relaunch restores managed engine/image, saved file, owner control and draft; setup adds no chat messages',
  );
  await writeFile(
    join(evidence, 'computer-setup-native-mac-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Real local Docker through Colima; runtime was already installed and running. Unsigned macOS arm64, not Windows/Linux desktop acceptance.',
      },
      null,
      2,
    ),
  );
  console.log('PASS packaged local Mac setup and relaunch');
} finally {
  await app?.close();
  const store = new Store(join(directory, 'workspace/relay.sqlite'));
  const computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
  new ComputerSetup(computer, { environment: {} });
  if (computer.enabled) {
    await computer.stop().catch(() => {});
    await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]).catch(() => {});
    await computer
      .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
      .catch(() => {});
  }
  store.close();
  await rm(directory, { recursive: true, force: true });
}
