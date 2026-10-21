// SPDX-License-Identifier: MIT
// Ordinary desktop/phone controls, two real Linux VMs and native dockerd TLS.
import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { remoteComputerFixture } from './remote-computer-fixture.mjs';
const expect = baseExpect.configure({ timeout: 30000 });
const evidence = resolve('../relay-evidence');
let f, browser;
const report = { startedAt: new Date().toISOString(), checks: [] };
try {
  f = await remoteComputerFixture();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const open = async (mobile) => {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      ignoreHTTPSErrors: true,
    });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(f.url);
    await p.getByLabel('Server access key', { exact: true }).fill(f.key);
    await p.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(p.getByLabel('Message Relay', { exact: true })).toBeVisible();
    return p;
  };
  const computer = async (p) => {
    await p.getByRole('button', { name: 'More', exact: true }).click();
    await p.getByRole('button', { name: 'Computer', exact: true }).click();
    await p.getByRole('button', { name: 'Desktop', exact: true }).click();
  };
  const desktop = await open(false);
  await desktop.getByLabel('Message Relay', { exact: true }).fill('Keep my remote computer draft.');
  await computer(desktop);
  await desktop.getByRole('button', { name: 'Start computer', exact: true }).click();
  await expect(desktop.locator('.computer-screen-input img')).toBeVisible();
  await desktop.getByRole('button', { name: 'Take control', exact: true }).click();
  await desktop.getByText('Commands & activity', { exact: true }).click();
  await desktop
    .getByLabel('Private computer command', { exact: true })
    .fill("printf 'Made in the remote desktop UI' > ui-proof.txt");
  await desktop.getByRole('button', { name: 'Run command', exact: true }).click();
  await f.until(
    async () =>
      (await f.d('guest', ['exec', f.computerName, 'cat', '/workspace/ui-proof.txt'])) ===
      'Made in the remote desktop UI',
    'Desktop command',
  );
  await desktop.getByText('Commands & activity', { exact: true }).click();
  await desktop.screenshot({ path: resolve(evidence, 'remote-computer-desktop.png') });
  assert.deepEqual(
    (await new AxeBuilder({ page: desktop }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    [],
  );
  await desktop.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(desktop.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my remote computer draft.',
  );
  assert.equal((await f.json('/api/state')).messages.length, 0);
  report.checks.push(
    'Desktop starts and controls the separate computer through the existing page, executes real work and returns to an unchanged chat/draft',
  );
  const phone = await open(true);
  await computer(phone);
  await expect(phone.locator('.computer-screen-input img')).toBeVisible();
  await expect(
    phone.getByRole('button', { name: 'Give back to Relay', exact: true }),
  ).toBeVisible();
  const oldId = JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0].Id;
  await phone.getByRole('button', { name: 'Stop computer and keep files', exact: true }).click();
  await expect(phone.getByRole('button', { name: 'Start computer', exact: true })).toBeVisible();
  await phone.getByRole('button', { name: 'Start computer', exact: true }).click();
  await expect(phone.locator('.computer-screen-input img')).toBeVisible();
  assert.equal(JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0].Id, oldId);
  assert.equal(
    await f.d('guest', ['exec', f.computerName, 'cat', '/workspace/ui-proof.txt']),
    'Made in the remote desktop UI',
  );
  await phone.screenshot({ path: resolve(evidence, 'remote-computer-phone.png') });
  assert.deepEqual(
    (await new AxeBuilder({ page: phone }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    [],
  );
  assert.equal(
    await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await phone.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
  await phone.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(phone.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my remote computer draft.',
  );
  report.checks.push(
    'Phone sees owner control from desktop, stops and restarts the same remote computer with its exact files, then hands control back; no horizontal overflow or WCAG A/AA violations',
  );
  await phone.getByLabel('Message Relay', { exact: true }).fill('Make me a file on your computer.');
  await phone.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    phone.getByText('I made the file on my separate computer.', { exact: true }),
  ).toBeVisible();
  await phone.getByLabel('Message Relay', { exact: true }).fill('Keep my final remote draft.');
  await f.until(
    async () => (await f.json('/api/state')).threads[0].draft === 'Keep my final remote draft.',
    'Saved draft',
  );
  const before = await f.json('/api/state');
  assert.equal(before.files.filter((x) => x.name === 'remote-result.txt').length, 1);
  await f.restart();
  await phone.reload();
  await expect(phone.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my final remote draft.',
  );
  assert.deepEqual((await f.json('/api/state')).messages, before.messages);
  assert.deepEqual(errors, []);
  report.checks.push(
    'Phone sends one request, receives the actual remote file, and survives app-server replacement with authenticated session, messages and unsent draft retained',
  );
  report.passed = true;
  console.log('PASS remote computer desktop and phone UI');
} catch (error) {
  report.error = error.stack;
  for (const [i, p] of (browser?.contexts().flatMap((c) => c.pages()) || []).entries())
    await p
      .screenshot({ path: resolve(evidence, `remote-computer-ui-failure-${i}.png`) })
      .catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(evidence, 'remote-computer-ui-acceptance.json'),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await f?.close();
}
