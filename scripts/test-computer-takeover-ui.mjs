// SPDX-License-Identifier: MIT
// Production UI + actual Docker, with a controlled model and no external writes.
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
import { BackgroundWorker } from '../server/worker.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-takeover-ui-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'db.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: directory });
let modelCalls = 0;
const provider = {
  configured: true,
  model: 'Controlled takeover test',
  protocol: 'fixture',
  complete: async (messages) => {
    modelCalls++;
    const original = messages.findLast(
      (m) => m.role === 'user' && m.content.startsWith('Remember my'),
    );
    const label = original.content.includes('mobile') ? 'mobile' : 'desktop';
    const tools = messages.filter((m) => m.role === 'tool');
    for (const m of tools) expect(JSON.parse(m.content).error).toBeUndefined();
    return !tools.length
      ? {
          text: '',
          toolCalls: [
            {
              id: `save-${label}`,
              function: {
                name: 'remember',
                arguments: JSON.stringify({ text: `${label} takeover preference` }),
              },
            },
          ],
        }
      : { text: `Saved your ${label} takeover preference.`, toolCalls: [] };
  },
};
const services = {
  mode: 'live',
  computer,
  provider,
  google: { configured: false },
  browser: { enabled: false },
  terminal: { enabled: false },
};
const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: '' });
app.use(express.static(resolve('dist')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const worker = new BackgroundWorker(store, services, { pollMs: 30 });
worker.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (text) => {
  checks.push(text);
  console.log(`PASS ${text}`);
};
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    await computer.start('owner');
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 980 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}/#computer`);
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Give back to Relay', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    const pause = page.locator('.computer-pause-note');
    await expect(pause).toBeVisible();
    const beforeCalls = modelCalls;
    const beforeMessages = store.read().messages.length;
    const draft = page.getByLabel('Message Relay', { exact: true });
    await draft.fill(`Remember my ${label} takeover preference.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await draft.fill(`Keep this ${label} draft.`);
    await expect.poll(() => store.read().runs.at(-1)?.status).toBe('queued');
    await page.reload();
    await expect(pause).toBeVisible();
    await expect(draft).toHaveValue(`Keep this ${label} draft.`);
    await expect(page.getByText('Waiting for handback', { exact: true })).toBeVisible();
    await expect(page.locator('.followup-queue')).toHaveCount(0);
    expect(modelCalls).toBe(beforeCalls);
    expect(store.read().messages.length).toBe(beforeMessages + 1);
    await page.screenshot({ path: join(evidence, `takeover-paused-${label}.png`) });
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    check(
      `${label}: taking control pauses real worker/model dispatch; chat shows one inline status; queued message and unsent draft survive reload`,
    );
    if (mobile) {
      await pause.getByRole('button', { name: 'Open computer', exact: true }).click();
      await page.getByRole('button', { name: 'Stop computer and keep files', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Start computer', exact: true })).toBeVisible({
        timeout: 20000,
      });
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    } else {
      await page.route('**/api/computer/release', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Could not give back the computer. Try again.' }),
        }),
      );
      await pause.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Could not give back the computer.');
      await expect(pause).toBeVisible();
      await expect(draft).toHaveValue(`Keep this ${label} draft.`);
      expect(modelCalls).toBe(beforeCalls);
      expect(store.read().messages.length).toBe(beforeMessages + 1);
      await page.unroute('**/api/computer/release');
      check(
        'desktop: failed handback keeps control, queued work and draft; retry remains available',
      );
    }
    await pause.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
    await expect(
      page.getByText(`Saved your ${label} takeover preference.`, { exact: true }),
    ).toBeVisible();
    await expect(pause).toHaveCount(0);
    await expect(draft).toHaveValue(`Keep this ${label} draft.`);
    await expect(draft).toBeFocused();
    expect(page.url()).toContain('#chat');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(modelCalls).toBe(beforeCalls + 2);
    expect(
      store.read().memories.filter((m) => m.text === `${label} takeover preference`),
    ).toHaveLength(1);
    expect(store.read().messages.length).toBe(beforeMessages + 2);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(evidence, `takeover-resumed-${label}.png`) });
    check(
      `${label}: one chat action hands back the ${mobile ? 'stopped' : 'running'} computer; queued request finishes once without navigation, dialogs, draft loss or page errors`,
    );
    await context.close();
  }
  await writeFile(
    join(evidence, 'computer-takeover-ui-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Actual Docker desktop and production desktop/mobile UI; controlled model',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await worker.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.name]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
