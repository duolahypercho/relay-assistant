// SPDX-License-Identifier: MIT
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess } from '../server/computer-setup.mjs';
const expect = baseExpect.configure({ timeout: 30000 });
const profile = process.env.RELAY_ENGINE_TEST_PROFILE;
assert(profile && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile));
const host = `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`;
const profileFile = join(homedir(), '.colima', profile, 'colima.yaml');
const config = await readFile(profileFile);
const initialContext = (await setupProcess('docker', ['context', 'show'])).stdout.trim();
async function status() {
  const result = await setupProcess('colima', ['list', '--json']);
  assert.equal(result.exitCode, 0);
  return result.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.name === profile)?.status;
}
assert.equal(await status(), 'Stopped');
const directory = await mkdtemp(join(tmpdir(), 'relay-chat-resume-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const seedStore = new Store(join(directory, 'workspace/relay.sqlite'), { sample: false });
new PrivateComputer(seedStore, {
  enabled: true,
  deployment: join(directory, 'workspace'),
  dockerHost: host,
});
seedStore.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
seedStore.close();
const options = {
  executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
  args: [`--relay-test-data=${directory}`, '--relay-local-port=0'],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(RELAY_|GOOGLE_|DOCKER_)/.test(key)),
    ),
    RELAY_MODE: 'sample',
    RELAY_DESKTOP_ENABLED: 'true',
    RELAY_DESKTOP_WEB_ENABLED: 'false',
    RELAY_BROWSER_ENABLED: 'false',
    DOCKER_HOST: host,
  },
};
let app;
async function observeInputs(app, page) {
  // Keep the acceptance window from receiving the owner's physical typing.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  });
  await page.evaluate(() => {
    window.__resumeInputAudit = [];
    document.addEventListener('input', (event) => {
      const label = event.target?.getAttribute?.('aria-label');
      if (['Message Relay', 'Private computer command'].includes(label)) {
        window.__resumeInputAudit.push({
          label,
          type: event.inputType,
          trusted: event.isTrusted,
          length: event.target.value?.length,
          at: Date.now(),
        });
      }
    });
  });
}
async function checkDraft(page, stage) {
  const text = await page.getByLabel('Message Relay', { exact: true }).inputValue();
  console.log(
    JSON.stringify({
      stage,
      draftLength: text.length,
      inputAudit: await page.evaluate(() => window.__resumeInputAudit),
    }),
  );
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native runtime draft',
  );
}
try {
  app = await electron.launch(options);
  let page = await app.firstWindow();
  await observeInputs(app, page);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my native runtime draft');
  const before = await page.evaluate(async () => (await fetch('/api/state')).json());
  await expect(page.getByRole('button', { name: 'Start & resume', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'chat-resume-sleeping-local-native-mac.png') });
  await page.getByRole('button', { name: 'Start & resume', exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => (await (await fetch('/api/computer')).json()).controller),
      { timeout: 210000 },
    )
    .toBe('agent');
  await expect(page.getByRole('button', { name: 'Start & resume', exact: true })).toHaveCount(0);
  assert.equal(
    (await page.evaluate(async () => await (await fetch('/api/computer')).json())).state,
    'running',
  );
  await checkDraft(page, 'after-first-resume');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('Commands & activity', { exact: true }).click();
  await page
    .getByLabel('Private computer command')
    .fill("printf 'Native runtime is awake' > runtime-native.txt");
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).setLegacyMode().include('.computer-page').analyze()).violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await checkDraft(page, 'after-computer-navigation');
  await app.close();
  app = null;
  assert.equal(
    (await setupProcess('colima', ['stop', '--profile', profile], { timeout: 120000 })).exitCode,
    0,
  );
  app = await electron.launch(options);
  page = await app.firstWindow();
  await observeInputs(app, page);
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my native runtime draft',
  );
  await expect(page.getByRole('button', { name: 'Start & resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start & resume', exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => (await (await fetch('/api/computer')).json()).controller),
      { timeout: 210000 },
    )
    .toBe('agent');
  await expect(page.getByRole('button', { name: 'Start & resume', exact: true })).toHaveCount(0);
  await checkDraft(page, 'after-second-resume');
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  expect(after.messages).toEqual(before.messages);
  await page.screenshot({ path: join(evidence, 'chat-resume-local-native-mac.png') });
  assert.equal(await status(), 'Running');
  assert.deepEqual(await readFile(profileFile), config);
  assert.equal((await setupProcess('docker', ['context', 'show'])).stdout.trim(), initialContext);
  await app.close();
  app = null;
  console.log(`Checking saved workspace ${directory}`);
  const store = new Store(join(directory, 'workspace/relay.sqlite'));
  const computer = new PrivateComputer(store, {
    enabled: true,
    deployment: join(directory, 'workspace'),
    dockerHost: host,
  });
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: { DOCKER_HOST: host },
  });
  try {
    assert.equal(computer.controller, 'agent');
    assert.equal(
      Buffer.from((await computer.read('runtime-native.txt')).base64, 'base64').toString(),
      'Native runtime is awake',
    );
  } finally {
    await setup.engineControl.close();
    store.close();
  }
  await writeFile(
    join(evidence, 'chat-resume-local-native-mac-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks: [
          'packaged own backend starts selected Colima and resumes directly from chat',
          'configured owner-controlled workspace requires one explicit chat action',
          'actual desktop command and exact saved file bytes',
          'full app quit, runtime stop and app relaunch',
          'saved files, draft and history survive app/runtime restart and a second explicit chat resume',
          'profile settings and active context unchanged',
          'accessibility',
        ],
        limits:
          'Unsigned macOS arm64 and installed Colima. No Windows/Linux or live-model acceptance.',
      },
      null,
      2,
    ),
  );
  console.log('PASS packaged local Mac: chat resume, runtime restart and durable workspace');
} finally {
  await app?.close();
  const store = new Store(join(directory, 'workspace/relay.sqlite'));
  const computer = new PrivateComputer(store, {
    enabled: true,
    deployment: join(directory, 'workspace'),
    dockerHost: host,
  });
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: { DOCKER_HOST: host },
  });
  try {
    if ((await status()) === 'Running') {
      await computer.stop().catch(() => {});
      await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]);
      await computer.dockerRun(['volume', 'rm', computer.volume, computer.displayVolume]);
      assert.equal(
        (await setupProcess('colima', ['stop', '--profile', profile], { timeout: 120000 }))
          .exitCode,
        0,
      );
    }
    assert.equal(await status(), 'Stopped');
  } finally {
    await setup.engineControl.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
