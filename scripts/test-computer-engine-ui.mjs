// SPDX-License-Identifier: MIT
// Explicit acceptance profile only. Restores its initial stopped state after
// removing this test's containers/volumes; never removes the Colima profile.
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess } from '../server/computer-setup.mjs';
import { createApp } from '../server/app.mjs';
import { ComputerMaintenance } from '../server/computer-maintenance.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const profile = process.env.RELAY_ENGINE_TEST_PROFILE;
assert(
  profile && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile),
  'Select an existing disposable/stopped acceptance profile with RELAY_ENGINE_TEST_PROFILE.',
);
const host = `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`;
const profileFile = join(homedir(), '.colima', profile, 'colima.yaml');
const config = await readFile(profileFile);
const initialContext = (await setupProcess('docker', ['context', 'show'])).stdout.trim();
async function profileStatus() {
  const result = await setupProcess('colima', ['list', '--json']);
  assert.equal(result.exitCode, 0);
  return result.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.name === profile)?.status;
}
assert.equal(
  await profileStatus(),
  'Stopped',
  'Acceptance must begin with its chosen runtime stopped.',
);
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-engine-ui-'));
    const store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const computer = new PrivateComputer(store, {
      enabled: true,
      deployment: directory,
      dockerHost: host,
    });
    const setup = new ComputerSetup(computer, {
      root: resolve('.'),
      environment: { DOCKER_HOST: host },
    });
    const maintenance = new ComputerMaintenance(computer, setup);
    if (mobile) computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    const app = createApp(
      store,
      {
        mode: 'sample',
        computer,
        computerSetup: setup,
        computerMaintenance: maintenance,
        provider: { configured: false },
        google: { configured: false },
        browser: { enabled: false },
        terminal: { enabled: false },
      },
      { host: '127.0.0.1', port: 0, accessKey: '' },
    );
    app.use(express.static(resolve('dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const before = structuredClone(store.read().messages);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page
        .getByLabel('Message Relay', { exact: true })
        .fill(`Keep my ${label} runtime draft`);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      const recovery = page.getByRole('region', { name: 'Computer startup', exact: true });
      await expect(recovery.getByText(/Colima is asleep/)).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Review recovery', exact: true })).toHaveCount(
        0,
      );
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: join(evidence, `computer-engine-sleeping-${label}.png`) });
      let entered;
      const dispatched = new Promise((r) => {
        entered = r;
      });
      setup.runner = async (binary, args, options) => {
        if (args[0] !== 'start' || !args.includes('--save-config=false'))
          return setupProcess(binary, args, options);
        entered();
        await new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        );
      };
      await recovery.getByRole('button', { name: 'Start computer', exact: true }).click();
      await dispatched;
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        `Keep my ${label} runtime draft`,
      );
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await page.reload();
      await recovery.getByRole('button', { name: 'Cancel startup', exact: true }).click();
      await expect(recovery.getByRole('status')).toContainText('Startup cancelled.');
      assert.equal(await profileStatus(), 'Stopped');
      setup.runner = setupProcess;
      console.log(`Starting actual ${profile} runtime through ${label} UI`);
      await recovery.getByRole('button', { name: 'Start computer', exact: true }).click();
      await expect(
        page.getByRole('button', {
          name: mobile ? 'Give back to Relay' : 'Take control',
          exact: true,
        }),
      ).toBeVisible({
        timeout: 210000,
      });
      if (!mobile) await page.getByRole('button', { name: 'Take control', exact: true }).click();
      assert.equal(computer.controller, 'owner');
      await page.getByText('Commands & activity', { exact: true }).click();
      await page
        .getByLabel('Private computer command')
        .fill(`printf 'Runtime woke successfully' > engine-${label}.txt`);
      await page.getByRole('button', { name: 'Run command', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
      assert.equal(
        Buffer.from((await computer.read(`engine-${label}.txt`)).base64, 'base64').toString(),
        'Runtime woke successfully',
      );
      await page.screenshot({ path: join(evidence, `computer-engine-ready-${label}.png`) });
      assert.deepEqual(await readFile(profileFile), config);
      assert.equal(
        (await setupProcess('docker', ['context', 'show'])).stdout.trim(),
        initialContext,
      );
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        `Keep my ${label} runtime draft`,
      );
      assert.deepEqual(store.read().messages, before);
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'read-only stopped-runtime discovery',
          'cancel/reload/navigation via controlled command delay',
          'actual Colima startup and automatic private desktop opening',
          'actual command-created file bytes',
          'unchanged profile configuration and active Docker context',
          'unchanged chat and draft; accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${label}: actual runtime wake and private desktop`);
    } finally {
      await setup.engineControl.close();
      await setup.cancel();
      await maintenance.close();
      await context.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if ((await profileStatus()) === 'Running') {
        await computer.stop();
        const removed = await computer.dockerRun([
          'rm',
          '-f',
          computer.name,
          computer.runtime.name,
        ]);
        assert.equal(removed.exitCode, 0);
        await computer.dockerRun(['volume', 'rm', computer.volume, computer.displayVolume]);
        const stopped = await setupProcess('colima', ['stop', '--profile', profile], {
          timeout: 120000,
        });
        assert.equal(stopped.exitCode, 0);
      }
      store.close();
      await rm(directory, { recursive: true, force: true });
      assert.equal(await profileStatus(), 'Stopped');
    }
  }
  await writeFile(
    join(evidence, 'computer-engine-browser-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        profileRestoredStopped: true,
        profileConfigPreserved: true,
        activeDockerContextPreserved: true,
        limits:
          'Real installed Colima and Docker; cancellation uses a controlled delayed command. Browser phone layout, not native mobile or live model behavior.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
