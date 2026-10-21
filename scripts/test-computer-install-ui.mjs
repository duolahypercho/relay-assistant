// SPDX-License-Identifier: MIT
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setupProcess } from '../server/computer-setup.mjs';
import { ComputerInstallation } from '../server/computer-installation.mjs';
import { computerInstallFixture } from './computer-install-fixture.mjs';
const expect = baseExpect.configure({ timeout: 30000 });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const ownerBefore = {
  profiles: (await setupProcess('/opt/homebrew/bin/colima', ['list', '--json'])).stdout,
  context: (await setupProcess('/opt/homebrew/bin/docker', ['context', 'show'])).stdout,
};
const fixture = await computerInstallFixture();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
let passed = false;
await writeFile(
  resolve('../../work/engine-install-active-fixture.json'),
  JSON.stringify(
    { directory: fixture.directory, url: fixture.url, root: fixture.manager.root },
    null,
    2,
  ),
);
try {
  const desktop = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    reducedMotion: 'reduce',
  });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 675 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const pages = [await desktop.newPage(), await phone.newPage()];
  const errors = [];
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url);
    await page.getByLabel('Message Relay', { exact: true }).fill('Keep my private computer draft');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Computer', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Private computer setup', exact: true }),
    ).toBeVisible();
  }
  const before = structuredClone(fixture.store.read().messages);
  const [page, mobile] = pages;
  const region = page.getByRole('region', { name: 'Private computer setup', exact: true });
  await region.getByRole('button', { name: 'Set up computer', exact: true }).click();
  await expect(region.getByText('Downloading computer tools…', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'computer-install-desktop-progress.png') });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my private computer draft',
  );
  await mobile.reload();
  await expect(mobile.getByText('Downloading computer tools…', { exact: true })).toBeVisible();
  await mobile.getByRole('button', { name: 'Cancel setup', exact: true }).click();
  await expect(
    mobile.getByText('Setup cancelled. Continue whenever you’re ready.', { exact: true }),
  ).toBeVisible();
  checks.push('cancel from a second client after navigation/reload');
  fixture.delivery('fail');
  await mobile.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(mobile.getByRole('alert')).toContainText('Setup could not finish');
  checks.push('inline download failure and retry');
  fixture.delivery('ready');
  await mobile.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await expect
    .poll(
      async () => {
        try {
          await access(join(fixture.manager.root, 'colima/_lima/colima-relay/ha.pid'));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 5 * 60000 },
    )
    .toBe(true);
  await mobile.getByRole('button', { name: 'Cancel setup', exact: true }).click();
  await expect.poll(() => !!fixture.manager.pending, { timeout: 90000 }).toBe(false);
  assert.equal(fixture.manager.state.phase, 'cancelled');
  const stopped = await setupProcess(fixture.manager.colima, ['list', '--json'], {
    env: fixture.manager.env,
  });
  assert.equal(JSON.parse(stopped.stdout.trim()).status, 'Stopped');
  checks.push('cancelling an actual boot stops only the new private VM and retains verified tools');
  await mobile.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect
    .poll(() => !!fixture.manager.pending, { timeout: 25 * 60000, intervals: [1000] })
    .toBe(false);
  assert.equal(fixture.manager.state.phase, 'ready', JSON.stringify(fixture.manager.state));
  assert.equal((await fixture.computer.status()).state, 'running');
  checks.push(
    'official verified binaries → fresh private VM → original workspace image → real desktop',
  );
  for (const [index, p] of pages.entries()) {
    await expect(p.locator('.computer-screen-input img').first()).toBeVisible();
    await p.screenshot({
      path: join(evidence, `computer-install-${index ? 'phone' : 'desktop'}-ready.png`),
    });
    const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa']).analyze();
    assert.deepEqual(axe.violations, []);
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  const screenshot = await fixture.computer.screenshot();
  assert(
    screenshot.data || screenshot.screenshot || screenshot.image || screenshot.bytes,
    JSON.stringify(Object.keys(screenshot)),
  );
  // Prove the private CLI can execute in the real constrained workspace and preserve a file.
  const out = await fixture.computer.checked([
    'exec',
    fixture.computer.name,
    'python3',
    '-c',
    'from pathlib import Path; p=Path("/workspace/installation-proof.txt"); p.write_text("private computer verified"); print(p.read_text())',
  ]);
  assert(out.includes('private computer verified'));
  const config = JSON.parse(await fixture.computer.checked(['inspect', fixture.computer.name]))[0];
  assert.equal(config.HostConfig.NetworkMode, 'none');
  assert.equal(config.Config.User, '1000:1000');
  assert(config.Mounts.every((m) => m.Type !== 'bind'));
  checks.push('real screenshot, non-root command and persistent file with no host binds');
  assert(
    fixture.calls
      .filter((c) => !c.binary.includes('not-installed'))
      .every((c) => c.binary.startsWith(fixture.manager.root)),
    'Every setup executable must be privately installed',
  );
  const restored = new ComputerInstallation(fixture.setup, { root: fixture.manager.root });
  await restored.restore();
  assert.equal(restored.selected, true);
  await restored.close();
  checks.push('restart restores verified private tool selection without an automatic VM start');
  for (const [index, p] of pages.entries()) {
    await p.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(p.getByLabel('Message Relay', { exact: true })).toHaveValue(
      'Keep my private computer draft',
    );
  }
  assert.deepEqual(fixture.store.read().messages, before);
  assert.deepEqual(errors, []);
  checks.push(
    'desktop/phone drafts and history preserved, no page errors, accessibility and overflow checks',
  );
  passed = true;
} finally {
  await browser.close();
  await writeFile(
    join(evidence, 'computer-install-ui-acceptance.json'),
    JSON.stringify(
      {
        passed,
        checks,
        installation: fixture.manager.state,
        root: fixture.manager.root,
        liveDownloads: true,
        processCalls: fixture.calls,
      },
      null,
      2,
    ),
  );
  await fixture.close();
  const ownerAfter = {
    profiles: (await setupProcess('/opt/homebrew/bin/colima', ['list', '--json'])).stdout,
    context: (await setupProcess('/opt/homebrew/bin/docker', ['context', 'show'])).stdout,
  };
  assert.deepEqual(ownerAfter, ownerBefore);
  console.log(
    JSON.stringify({ passed, checks, ownerUnchanged: true, disposableVMRemoved: true }, null, 2),
  );
}
