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
import { BackgroundWorker } from '../server/worker.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-web-ui-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'db.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, web: true, deployment: directory });
const startComputer = computer.start.bind(computer);
const checkedComputer = computer.checked.bind(computer);
computer.checked = async (args, options) => {
  const began = Date.now();
  try {
    return await checkedComputer(args, options);
  } finally {
    if (Date.now() - began > 1000) console.log(`Docker ${args[0]}: ${Date.now() - began} ms`);
  }
};
computer.start = async (...args) => {
  const start = Date.now();
  console.log('Starting computer for website flow');
  try {
    return await startComputer(...args);
  } finally {
    console.log(`Computer start returned after ${Date.now() - start} ms`);
  }
};
let label;
const provider = {
  configured: true,
  model: 'Controlled website test',
  protocol: 'fixture',
  complete: async (messages) => {
    const toolResults = messages.filter((m) => m.role === 'tool');
    for (const m of toolResults) expect(JSON.parse(m.content).error).toBeUndefined();
    const resumed = messages.some(
      (m) =>
        m.role === 'user' &&
        m.content.startsWith('Continue the original request. I allowed a network connection'),
    );
    const open = [
      'computer_open_website',
      {
        url: 'https://example.com',
        reason: 'Read the public page you requested.',
        operationId: `open-${label}`,
      },
    ];
    const steps = resumed
      ? [
          open,
          [
            'computer_run',
            {
              command: `python3 -c "import urllib.request; b=urllib.request.urlopen('https://example.com',timeout=15).read(); assert b'Example Domain' in b; open('/workspace/result-${label}.html','wb').write(b)"`,
              operationId: `download-${label}`,
            },
          ],
          ['computer_export', { path: `result-${label}.html` }],
        ]
      : [['computer_start', {}], open];
    const step = steps[toolResults.length];
    return step
      ? {
          text: '',
          toolCalls: [
            {
              id: `step-${toolResults.length}`,
              function: { name: step[0], arguments: JSON.stringify(step[1]) },
            },
          ],
        }
      : { text: 'Downloaded the real public page. Your file is ready.', toolCalls: [] };
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
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const worker = new BackgroundWorker(store, services, { pollMs: 70 });
worker.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  for (const mobile of [false, true]) {
    label = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 980 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    const draft = page.getByLabel('Message Relay', { exact: true });
    await draft.fill(`Download the public example page for the ${label} test.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await draft.fill(`Keep this ${label} draft`);
    await expect
      .poll(() => store.read().runs.filter((r) => !r.websiteContext).length)
      .toBe(mobile ? 2 : 1);
    const originalRun = store
      .read()
      .runs.filter((r) => !r.websiteContext)
      .at(-1);
    const permission = page.locator(`.website-permission[data-run-id="${originalRun.id}"]`);
    await expect(
      permission.getByRole('button', { name: 'Allow & continue', exact: true }),
    ).toBeEnabled({ timeout: 90000 });
    const before = store.read().messages.filter((m) => m.role === 'user').length;
    await page.screenshot({ path: join(evidence, `computer-web-permission-${label}.png`) });
    await computer.takeControl();
    await expect(page.locator('.computer-pause-note')).toBeVisible();
    await permission.getByRole('button', { name: 'Allow & continue', exact: true }).click();
    await expect(
      permission.getByText('Allowed. Waiting for you to give control back.', { exact: true }),
    ).toBeVisible();
    expect(
      store
        .read()
        .runs.filter((r) => r.websiteContext?.host === 'example.com')
        .at(-1).status,
    ).toBe('queued');
    await permission.getByRole('button', { name: 'Open computer', exact: true }).click();
    await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `result-${label}.html Saved to your files` }),
    ).toBeVisible({ timeout: 45000 });
    await expect(draft).toHaveValue(`Keep this ${label} draft`);
    expect(store.read().messages.filter((m) => m.role === 'user').length).toBe(before);
    expect(
      store
        .read()
        .runs.filter((r) => r.websiteContext?.host === 'example.com' && r.status === 'completed')
        .length,
    ).toBe(mobile ? 2 : 1);
    const file = store.read().files.find((f) => f.name === `result-${label}.html`);
    expect(Buffer.from(file.base64, 'base64').toString()).toContain('Example Domain');
    await permission.getByRole('button', { name: 'Open computer', exact: true }).click();
    await expect(page.locator('.computer-display img')).toHaveAttribute('alt', /Example Domain/, {
      timeout: 15000,
    });
    const websites = page.locator('.computer-websites');
    await expect(websites).toBeVisible();
    if ((await websites.getAttribute('open')) === null) await websites.locator('summary').click();
    await page.screenshot({ path: join(evidence, `computer-web-${label}.png`) });
    const a11y = await new AxeBuilder({ page }).include('.computer-page').analyze();
    expect(a11y.violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    // Hold an actual older screenshot response across the owner decision. The
    // decision must be visible immediately and survive the delayed response.
    let releaseScreen, screenHeld;
    const held = new Promise((resolve) => {
      screenHeld = resolve;
    });
    const released = new Promise((resolve) => {
      releaseScreen = resolve;
    });
    let intercept = true;
    await page.route('**/api/computer/screen', async (route) => {
      const response = await route.fetch();
      if (intercept) {
        intercept = false;
        screenHeld();
        await released;
      }
      await route.fulfill({ response });
    });
    await held;
    await page
      .locator('.website-row')
      .filter({ hasText: 'example.com' })
      .getByRole('button', { name: 'Revoke', exact: true })
      .click();
    await expect(
      page
        .locator('.website-row')
        .filter({ hasText: 'example.com' })
        .getByText('revoked', { exact: true }),
    ).toBeVisible();
    releaseScreen();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(
      page
        .locator('.website-row')
        .filter({ hasText: 'example.com' })
        .getByText('revoked', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(draft).toHaveValue(`Keep this ${label} draft`);
    await page.reload();
    await expect(draft).toHaveValue(`Keep this ${label} draft`);
    expect(errors).toEqual([]);
    check(
      `${label}: one-click website approval resumes a real computer task and returns actual downloaded bytes without a synthetic user message`,
    );
    check(
      `${label}: separate website controls revoke access; reload preserves drafts; no overflow, accessibility violations or page errors`,
    );
    await computer.stop();
    await context.close();
  }
  await writeFile(
    join(evidence, 'computer-web-ui-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Real Docker and public HTTPS, production desktop/mobile UI, controlled model',
        checks,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(evidence, 'computer-web-ui-failure.json'),
    JSON.stringify(
      {
        failedAt: new Date().toISOString(),
        error: error.message,
        runs: store.read().runs,
        checkpoint: store.db.prepare('SELECT run_id,phase,body FROM agent_checkpoints').all(),
        computer: await computer.status(),
      },
      null,
      2,
    ),
  );
  throw error;
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
