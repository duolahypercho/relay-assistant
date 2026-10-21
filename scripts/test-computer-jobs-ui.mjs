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
const directory = await mkdtemp(join(tmpdir(), 'relay-jobs-ui-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: directory });
const checked = computer.checked.bind(computer);
computer.checked = async (args, options) => {
  const started = Date.now();
  try {
    return await checked(args, options);
  } finally {
    if (Date.now() - started > 1500) console.log(`Docker ${args[0]}: ${Date.now() - started} ms`);
  }
};
const startComputer = computer.start.bind(computer);
computer.start = async (...args) => {
  const started = Date.now();
  console.log('Starting computer for job flow');
  try {
    return await startComputer(...args);
  } finally {
    console.log(`Computer startup returned after ${Date.now() - started} ms`);
  }
};
let label, cancellation;
const call = (name, args, id) => ({
  text: '',
  toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const provider = {
  configured: true,
  model: 'Controlled background-job test',
  complete: async (messages) => {
    const results = messages.filter((m) => m.role === 'tool');
    for (const m of results) expect(JSON.parse(m.content).error).toBeUndefined();
    const continued = messages.some((m) =>
      m.content?.startsWith('Continue the original request after this background'),
    );
    if (continued)
      return results.length === 0
        ? call('computer_export', { path: `${label}-result.txt` }, 'export')
        : { text: 'Your background report is ready.', toolCalls: [] };
    if (!results.length) return call('computer_start', {}, 'start');
    return call(
      'computer_job_start',
      {
        title: cancellation ? `Cancel example ${label}` : `Write report ${label}`,
        operationId: `job-${label}-${cancellation}`,
        seconds: 240,
        command: `python3 -u - <<'PY'
import pathlib,time
p=pathlib.Path('/workspace')
print('Preparing report',flush=True)
while not (p/'release-${label}-${cancellation}').exists(): time.sleep(.1)
(p/'${label}-result.txt').write_text('A real ${label} report from background work.')
print('Saved report',flush=True)
PY`,
      },
      'job',
    );
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
const worker = new BackgroundWorker(store, services, { pollMs: 150 });
worker.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
try {
  for (const mobile of [false, true]) {
    label = mobile ? 'mobile' : 'desktop';
    cancellation = false;
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
    await draft.fill(`Write a report in the background for ${label}.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await draft.fill(`Keep my ${label} draft`);
    const card = page.getByRole('region', {
      name: `Computer job: Write report ${label}`,
      exact: true,
    });
    await expect(card).toBeVisible({ timeout: 120000 });
    await expect(page.getByRole('button', { name: 'Open your computer', exact: true })).toHaveCount(
      0,
    );
    await expect(card.getByRole('status')).toHaveText('Working', { timeout: 30000 });
    await card.getByText('Details & output', { exact: true }).click();
    await expect(card.getByLabel(`Output for Write report ${label}`)).toContainText(
      'Preparing report',
      { timeout: 30000 },
    );
    const before = store.read().messages.filter((m) => m.role === 'user').length;
    await card.getByRole('button', { name: 'Open computer', exact: true }).click();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeEnabled(
      { timeout: 30000 },
    );
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('Paused while you’re in control', {
      timeout: 15000,
    });
    await expect(draft).toHaveValue(`Keep my ${label} draft`);
    await page.screenshot({ path: join(evidence, `jobs-paused-${label}.png`) });
    await computer.perform(
      {
        kind: 'files',
        action: 'write',
        path: `release-${label}-${cancellation}`,
        base64: '',
        operationId: `release-${label}`,
      },
      { actor: 'owner' },
    );
    await card.getByRole('button', { name: 'Open computer', exact: true }).click();
    await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText(/^(Working|Finished)$/, { timeout: 60000 });
    await expect(
      page.getByRole('button', { name: `${label}-result.txt Saved to your files`, exact: true }),
    ).toBeVisible({ timeout: 120000 });
    await expect(card.getByRole('status')).toHaveText('Finished', { timeout: 15000 });
    const file = store.read().files.find((f) => f.name === `${label}-result.txt`);
    expect(Buffer.from(file.base64, 'base64').toString()).toBe(
      `A real ${label} report from background work.`,
    );
    await page
      .getByRole('button', { name: `${label}-result.txt Saved to your files`, exact: true })
      .click();
    const preview = page.getByRole('region', { name: 'File preview', exact: true });
    await expect(preview).toContainText(`A real ${label} report from background work.`);
    await preview.getByRole('button', { name: 'Edit text', exact: true }).click();
    await expect(preview.getByRole('textbox', { name: 'File text', exact: true })).toHaveValue(
      `A real ${label} report from background work.`,
    );
    await page.goBack();
    expect(store.read().messages.filter((m) => m.role === 'user').length).toBe(before);
    await expect(draft).toHaveValue(`Keep my ${label} draft`);
    await page.reload();
    await expect(draft).toHaveValue(`Keep my ${label} draft`);
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: join(evidence, `jobs-completed-${label}.png`) });
    check(
      `${label}: real background job, live logs, owner pause/handback and automatic file result with readable preview/editor; no synthetic message, lost draft, overflow or accessibility findings`,
    );
    cancellation = true;
    await draft.fill(`Start a cancellable task for ${label}.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await draft.fill(`Keep the cancellation draft ${label}`);
    const stopped = page.getByRole('region', {
      name: `Computer job: Cancel example ${label}`,
      exact: true,
    });
    await expect(stopped).toBeVisible({ timeout: 60000 });
    await stopped.getByRole('button', { name: 'Stop job', exact: true }).click();
    await expect(stopped.getByRole('status')).toHaveText('Stopped', { timeout: 45000 });
    await expect(draft).toHaveValue(`Keep the cancellation draft ${label}`);
    await stopped.getByRole('button', { name: 'Open computer', exact: true }).click();
    await page.getByText('Commands & activity', { exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Background computer jobs', exact: true }),
    ).toContainText(`Cancel example ${label}`);
    expect(errors).toEqual([]);
    check(
      `${label}: one-click job cancellation and dedicated computer activity retain the conversation draft without page errors`,
    );
    await context.close();
  }
  await writeFile(
    join(evidence, 'computer-jobs-ui-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime:
          'Real Docker jobs and production desktop/mobile UI with controlled model responses',
        checks,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await writeFile(
    join(evidence, 'computer-jobs-ui-failure.json'),
    JSON.stringify(
      {
        failedAt: new Date().toISOString(),
        error: e.message,
        jobs: computer.jobs.list(),
        checkpoint: store.db.prepare('SELECT run_id,phase,body FROM agent_checkpoints').all(),
        runs: store.read().runs,
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  await browser.close();
  await worker.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
