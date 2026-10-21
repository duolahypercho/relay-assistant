// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess } from '../server/computer-setup.mjs';
import { createApp } from '../server/app.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.RELAY_TEST_BROWSER_CHANNEL || 'chrome',
  headless: true,
});
const checks = [];
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-setup-ui-'));
    const store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const computer = new PrivateComputer(store, { deployment: directory });
    const setup = new ComputerSetup(computer, { root: resolve('.'), environment: {} });
    const app = createApp(
      store,
      {
        mode: 'sample',
        computer,
        computerSetup: setup,
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
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 980 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const before = store.read().messages;
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByLabel('Message Relay', { exact: true }).fill(`Keep my ${label} setup draft`);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Set up computer', exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(evidence, `computer-setup-start-${label}.png`) });
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      setup.runner = async (_binary, _args, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      await page.getByRole('button', { name: 'Set up computer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Cancel setup', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        `Keep my ${label} setup draft`,
      );
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await page.reload();
      await page.getByRole('button', { name: 'Cancel setup', exact: true }).click();
      await expect(
        page.getByText('Setup cancelled. You can continue whenever you’re ready.', { exact: true }),
      ).toBeVisible();
      expect(computer.enabled).toBe(false);
      checks.push(`${label}: navigate/reload while setup runs, cancel safely, preserve chat draft`);
      setup.runner = async () => {
        throw Object.assign(new Error('missing fixture runtime'), { code: 'ENOENT' });
      };
      await page.getByRole('button', { name: 'Set up computer', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Get Docker', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `computer-setup-error-${label}.png`) });
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      setup.runner = setupProcess;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      const deadline = Date.now() + 20 * 60000;
      while (setup.status().phase !== 'ready') {
        if (setup.status().phase === 'error') throw new Error(setup.status().error);
        if (Date.now() > deadline) throw new Error('Setup timed out');
        await new Promise((r) => setTimeout(r, 500));
      }
      await expect(page.getByRole('button', { name: 'Start computer', exact: true })).toBeEnabled();
      expect(setup.status().phase).toBe('ready');
      await page.getByRole('button', { name: 'Start computer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
        timeout: 45000,
      });
      await expect(page.locator('.computer-display img')).toHaveAttribute(
        'alt',
        /Relay.*A little room to work/,
      );
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await page.getByText('Commands & activity', { exact: true }).click();
      await page
        .getByLabel('Private computer command')
        .fill(`printf 'Setup worked' > setup-${label}.txt`);
      await page.getByRole('button', { name: 'Run command', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
      expect(
        Buffer.from((await computer.read(`setup-${label}.txt`)).base64, 'base64').toString(),
      ).toBe('Setup worked');
      await page.screenshot({ path: join(evidence, `computer-setup-ready-${label}.png`) });
      await page.reload();
      await expect(
        page.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        `Keep my ${label} setup draft`,
      );
      expect(store.read().messages).toEqual(before);
      expect(errors).toEqual([]);
      checks.push(
        `${label}: retry uses real local Docker engine, builds/caches bundled image, starts desktop, runs command, saves file; no restart, dialogs, history changes, overflow or accessibility violations`,
      );
      console.log(`PASS ${label} setup and real computer`);
    } catch (error) {
      await page
        .screenshot({ path: join(evidence, `computer-setup-failed-${label}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      await setup.cancel();
      await context.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (computer.enabled) {
        await computer.stop().catch(() => {});
        await computer
          .dockerRun(['rm', '-f', computer.name, computer.runtime.name])
          .catch(() => {});
        await computer
          .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
          .catch(() => {});
      }
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'computer-setup-ui-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Missing-runtime and cancellable-delay cases use controlled subprocess fixtures; successful setup, image build/cache, desktop and commands use real Docker. Phone is Chrome emulation, not native Android/iOS.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
