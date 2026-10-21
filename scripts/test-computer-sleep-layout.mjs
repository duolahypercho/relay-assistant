// SPDX-License-Identifier: MIT
// Controlled sleeping-runtime state for geometry/accessibility; real VM behavior is tested separately.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { createApp } from '../server/app.mjs';
const store = new Store(':memory:', { sample: false });
const computer = new PrivateComputer(store, {
  enabled: true,
  runner: async () => {
    throw Error('Layout fixture must not launch a runtime');
  },
});
store.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
computer.status = computer.screenshot = async () => ({
  enabled: true,
  managedEngine: true,
  state: 'unavailable',
  controller: 'owner',
  network: 'offline',
  web: { enabled: false, sites: [] },
});
computer.jobs.list = async () => [];
let starts = 0;
const engine = {
  status: async () => ({
    available: true,
    managed: true,
    canStart: true,
    running: false,
    busy: !!starts,
    phase: starts ? 'waking' : 'asleep',
    intent: 'open',
    error: '',
  }),
  start: async () => {
    starts++;
    return engine.status();
  },
};
const app = createApp(
  store,
  {
    mode: 'sample',
    computer,
    computerSetup: { engineControl: engine },
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  },
  { host: '127.0.0.1', port: 0 },
);
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_q, r) => r.sendFile(resolve('dist/index.html')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const [width, height] of [
    [390, 675],
    [320, 568],
    [1365, 900],
  ]) {
    starts = 0;
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start computer', exact: true });
    await expect(start).toBeVisible();
    const bounds = await start.boundingBox(),
      dock = await page.getByRole('navigation', { name: 'Workspace shortcuts' }).boundingBox();
    await page.screenshot({
      path: resolve(`../relay-evidence/computer-sleep-layout-${width}.png`),
    });
    assert(bounds && dock);
    assert(
      bounds.y >= 0 && bounds.y + bounds.height <= dock.y,
      JSON.stringify({ width, height, bounds, dock }),
    );
    assert(bounds.height >= 44);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      [],
    );
    await start.click();
    assert.equal(starts, 1);
    await expect(
      page
        .getByRole('region', { name: 'Computer startup' })
        .getByText('Waking your computer…', { exact: true }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
    checks.push({ width, height, primaryAction: bounds, dockTop: dock.y });
    await context.close();
  }
  await writeFile(
    resolve('../relay-evidence/computer-sleep-layout-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        scope:
          'Controlled sleeping-engine state; visible primary action above dock before any scrolling, minimum target, accessibility, dispatch and no JS errors.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  store.close();
}
