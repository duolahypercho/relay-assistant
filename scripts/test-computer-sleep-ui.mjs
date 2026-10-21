// SPDX-License-Identifier: MIT
// Real private VM sleep/wake from desktop and phone; a fresh disposable deployment.
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { computerInstallFixture } from './computer-install-fixture.mjs';
import { setupProcess } from '../server/computer-setup.mjs';
const expect = baseExpect.configure({ timeout: 30000 });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const owner = async () => ({
  profiles: (await setupProcess('/opt/homebrew/bin/colima', ['list', '--json'])).stdout,
  context: (await setupProcess('/opt/homebrew/bin/docker', ['context', 'show'])).stdout,
});
const beforeOwner = await owner();
const f = await computerInstallFixture({
  live: false,
  artifacts: resolve('../../work/engine-install-research/artifacts'),
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
let passed = false,
  release;
await writeFile(
  resolve('../../work/computer-sleep-active-fixture.json'),
  JSON.stringify({ directory: f.directory, root: f.manager.root, url: f.url }),
);
try {
  f.delivery('ready');
  f.manager.start({});
  console.log('Provisioning real disposable private VM');
  await f.manager.pending;
  assert.equal(f.manager.state.phase, 'ready', JSON.stringify(f.manager.state));
  console.log('Private VM ready');
  const runner = f.setup.runner;
  let mode = 'ready';
  f.setup.runner = async (binary, args, options) => {
    if (binary === f.manager.colima && args[0] === 'stop') {
      if (mode === 'hold') await new Promise((r) => (release = r));
      if (mode === 'fail')
        return { exitCode: 1, stdout: '', stderr: 'Simulated unavailable shutdown transport' };
    }
    return runner(binary, args, options);
  };
  const errors = [];
  const desktop = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    reducedMotion: 'reduce',
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 675 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const pages = [await desktop.newPage(), await mobile.newPage()];
  for (const p of pages) {
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(f.url);
    await p.getByLabel('Message Relay', { exact: true }).fill('Keep my computer sleep draft');
    await p.getByRole('button', { name: 'More', exact: true }).click();
    await p.getByRole('button', { name: 'Computer', exact: true }).click();
    await expect(p.locator('.computer-screen-input img')).toBeVisible();
  }
  const history = structuredClone(f.store.read().messages);
  await f.computer.checked([
    'exec',
    f.computer.name,
    'python3',
    '-c',
    'from pathlib import Path; Path("/workspace/sleep-proof.txt").write_text("Saved across private VM sleep")',
  ]);
  const original = JSON.parse(await f.computer.checked(['inspect', f.computer.name]))[0].Id;
  const [page, phone] = pages;
  mode = 'hold';
  await page.getByRole('button', { name: 'Stop computer and keep files', exact: true }).click();
  await expect.poll(() => f.setup.engineControl.phase).toBe('sleeping');
  await phone.reload();
  await expect(
    phone
      .getByRole('region', { name: 'Computer startup' })
      .getByText('Putting your computer to sleep…', { exact: true }),
  ).toBeVisible();
  await expect(phone.getByRole('button', { name: 'Give back to Relay', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my computer sleep draft',
  );
  await expect(
    page
      .locator('.computer-pause-note')
      .filter({ visible: true })
      .getByText('Putting your computer to sleep…', { exact: true }),
  ).toBeVisible();
  await phone.screenshot({ path: join(evidence, 'computer-sleep-phone-progress.png') });
  mode = 'ready';
  release();
  await f.setup.engineControl.pending;
  assert.equal(f.setup.engineControl.phase, 'asleep');
  const vm = () => setupProcess(f.manager.colima, ['list', '--json'], { env: f.manager.env });
  assert.equal(JSON.parse((await vm()).stdout).status, 'Stopped');
  await expect(phone.getByRole('button', { name: 'Start computer', exact: true })).toBeVisible();
  await phone.screenshot({ path: join(evidence, 'computer-sleep-phone-asleep.png') });
  await expect(page.getByRole('button', { name: 'Start & resume', exact: true })).toBeVisible();
  checks.push(
    'Real private VM stops; another device/reload and chat observe progress without history messages or handback',
  );
  await phone.getByRole('button', { name: 'Start computer', exact: true }).click();
  await expect(phone.locator('.computer-screen-input img')).toBeVisible({ timeout: 240000 });
  assert.equal(JSON.parse((await vm()).stdout).status, 'Running');
  assert.equal(f.computer.controller, 'owner');
  assert.equal(JSON.parse(await f.computer.checked(['inspect', f.computer.name]))[0].Id, original);
  assert.equal(
    (
      await f.computer.checked(['exec', f.computer.name, 'cat', '/workspace/sleep-proof.txt'])
    ).trim(),
    'Saved across private VM sleep',
  );
  checks.push(
    'Phone starts same private VM and desktop with exact file bytes and owner control retained',
  );
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  mode = 'fail';
  await phone.getByRole('button', { name: 'Stop computer and keep files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try stopping again', exact: true })).toBeVisible();
  assert.equal(JSON.parse((await vm()).stdout).status, 'Running');
  assert.equal((await f.computer.inspect()).State.Running, false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Try stopping again', exact: true })).toBeVisible();
  mode = 'ready';
  await page.getByRole('button', { name: 'Try stopping again', exact: true }).click();
  await expect.poll(() => f.setup.engineControl.phase, { timeout: 120000 }).toBe('asleep');
  assert.equal(JSON.parse((await vm()).stdout).status, 'Stopped');
  checks.push(
    'Failed shutdown stays visible after reload; explicit desktop retry stops the real VM without deleting data',
  );
  await page.getByRole('button', { name: 'Start computer', exact: true }).click();
  await expect(page.locator('.computer-screen-input img')).toBeVisible({ timeout: 240000 });
  assert.equal(
    (
      await f.computer.checked(['exec', f.computer.name, 'cat', '/workspace/sleep-proof.txt'])
    ).trim(),
    'Saved across private VM sleep',
  );
  for (const [index, p] of pages.entries()) {
    await expect(p.locator('.computer-screen-input img')).toBeVisible();
    assert.deepEqual(
      (await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      [],
    );
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.screenshot({
      path: join(evidence, `computer-sleep-${index ? 'phone' : 'desktop'}-awake.png`),
    });
    await p.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(p.getByLabel('Message Relay', { exact: true })).toHaveValue(
      'Keep my computer sleep draft',
    );
  }
  assert.deepEqual(f.store.read().messages, history);
  assert.deepEqual(errors, []);
  checks.push('Desktop/phone accessibility, fit, retained drafts/history and no JavaScript errors');
  passed = true;
} finally {
  release?.();
  await browser.close();
  await writeFile(
    join(evidence, 'computer-sleep-ui-acceptance.json'),
    JSON.stringify(
      { passed, checks, root: f.manager.root, state: f.setup.engineControl.view() },
      null,
      2,
    ),
  );
  await f.close();
  assert.deepEqual(await owner(), beforeOwner);
  console.log(JSON.stringify({ passed, checks, cleaned: true, ownerUnchanged: true }));
}
