// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { createApp } from '../server/app.mjs';
import { command } from '../shared/domain.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-computer-ui-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'db.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: directory });
store.mutate((s) =>
  command(s, 'file.add', {
    name: 'copy-me.txt',
    mime: 'text/plain',
    text: 'A test file for the private computer.',
  }),
);
const app = createApp(
  store,
  {
    mode: 'sample',
    computer,
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
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  channel: process.env.RELAY_TEST_BROWSER_CHANNEL || 'chrome',
  headless: true,
});
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 980 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
    await page.getByLabel('Message Relay', { exact: true }).fill(`Keep my ${label} draft`);
    const before = store.read().messages.length;
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start computer', exact: true })).toBeEnabled({
      timeout: 20000,
    });
    await page.getByRole('button', { name: 'Start computer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator('.computer-display img')).toHaveAttribute(
      'alt',
      /Relay.*A little room to work/,
      { timeout: 15000 },
    );
    await page.screenshot({ path: join(evidence, `computer-${label}.png`) });
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Give back to Relay', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.locator('.computer-viewport')).toHaveClass(/is-zoomed/);
    expect(
      await page
        .locator('.computer-display')
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    ).toBe(1280);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.getByRole('button', { name: 'Fit screen', exact: true }).click();
    await page.getByText('Commands & activity', { exact: true }).click();
    await page
      .getByLabel('Private computer command')
      .fill(`printf 'Made from the ${label} app' > ${label}.txt`);
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled({
      timeout: 20000,
    });
    await page
      .locator('.computer-window')
      .getByRole('button', { name: 'Files', exact: true })
      .click();
    const pane = page.getByRole('region', { name: 'Computer files' });
    await expect(pane.getByText(`${label}.txt`, { exact: true })).toBeVisible();
    await pane
      .locator('.computer-file-row')
      .filter({ hasText: `${label}.txt` })
      .getByRole('button', { name: 'Save to Relay' })
      .click();
    await expect.poll(() => store.read().files.some((f) => f.name === `${label}.txt`)).toBe(true);
    await pane.getByLabel('File to copy to computer').selectOption({ label: 'copy-me.txt' });
    if (!mobile) {
      await pane.getByRole('button', { name: 'Copy here' }).click();
      await expect(
        pane.locator('.computer-file-row').getByText('copy-me.txt', { exact: true }),
      ).toBeVisible();
    }
    await page.reload();
    await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeVisible(
      { timeout: 20000 },
    );
    const accessibility = await new AxeBuilder({ page }).include('.computer-page').analyze();
    expect(accessibility.violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
      `Keep my ${label} draft`,
    );
    expect(store.read().messages.length).toBe(before);
    expect(errors).toEqual([]);
    check(
      `${label}: real desktop start, takeover, command, file bridge, reload, handback, clean chat history and retained draft`,
    );
    check(`${label}: no dialogs, overflow, accessibility violations or page errors`);
    await computer.stop();
    await context.close();
  }
  await writeFile(
    join(evidence, 'computer-ui-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'real Docker + production web UI, Chrome desktop/mobile viewport',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.name]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
