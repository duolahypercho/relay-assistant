// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { recoveryComputer } from './computer-recovery-fixture.mjs';
const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence/computer-missing-workspace');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const surface of native ? ['mac'] : ['desktop', 'phone']) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-missing-workspace-'));
    let f, r, app, context;
    try {
      f = await assistantsFixture(directory, {
        configure: async (store, services) => {
          r = await recoveryComputer(store, services, directory);
        },
      });
      context = await browser.newContext({
        viewport: surface === 'phone' ? { width: 390, height: 844 } : { width: 1360, height: 1000 },
        reducedMotion: 'reduce',
      });
      let page;
      if (native) {
        const data = join(directory, 'native');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
      } else {
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(30000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByLabel('Message Relay', { exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Keep my recovery draft');
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === 'main').draft)
        .toBe('Keep my recovery draft');
      await r.loseWorkspace();
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await expect(
        page.getByRole('heading', {
          name: 'Your saved workspace could not be found.',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start computer', exact: true })).toHaveCount(
        0,
      );
      const panel = page.getByRole('region', { name: 'Restore points', exact: true });
      await expect(panel.getByRole('button', { name: 'Import backup', exact: true })).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Save restore point', exact: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: join(evidence, `${surface}-missing.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      const foreign = await fetch(f.url + '/api/computer/snapshots/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.invalid' },
        body: JSON.stringify({ kind: 'fresh' }),
      });
      assert.equal(foreign.status, 403);
      const before = r.computer.volume;
      await panel.getByRole('button', { name: 'Start a new empty workspace', exact: true }).click();
      await expect(
        panel.getByRole('heading', { name: 'Start a new empty workspace?', exact: true }),
      ).toBeVisible();
      assert.equal(r.computer.volume, before);
      assert.equal((await r.computer.status()).state, 'missing');
      await panel.getByRole('button', { name: 'Not now', exact: true }).click();
      assert.equal(r.computer.volume, before);
      assert.equal((await r.computer.status()).state, 'missing');
      await panel.getByRole('button', { name: /^Review restore point / }).click();
      await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
      await expect
        .poll(async () => (await r.computer.status()).state, { timeout: 45000 })
        .toBe('running');
      const saved = await r.owner({ kind: 'files', action: 'read', path: 'recovery.txt' });
      assert.equal(Buffer.from(saved.base64, 'base64').toString(), 'My original saved work.');
      assert.equal(r.computer.controller, 'owner');
      await r.loseWorkspace();
      await expect(
        page.getByRole('heading', {
          name: 'Your saved workspace could not be found.',
          exact: true,
        }),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Start a new empty workspace', exact: true }).click();
      await panel.getByRole('button', { name: 'Start empty workspace', exact: true }).click();
      await expect
        .poll(async () => (await r.computer.status()).state, { timeout: 45000 })
        .toBe('running');
      await expect(
        page.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeVisible();
      const absent = await r.owner({ kind: 'files', action: 'list', path: '.' });
      assert(!absent.entries.some((e) => e.name === 'recovery.txt'));
      assert.equal(r.computer.controller, 'owner');
      assert.equal(r.snapshots.points().length, 1);
      assert.equal(f.store.read().messages.length, 0);
      assert.equal(f.requests.length, 0);
      await page.screenshot({ path: join(evidence, `${surface}-new-workspace.png`) });
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my recovery draft');
      await page.reload();
      await expect(composer).toHaveValue('Keep my recovery draft');
      // A lost computer must not force a storage decision before an ordinary chat.
      await r.loseWorkspace();
      await expect(
        page.getByRole('button', { name: 'Recover computer', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Recover computer', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Import backup', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my recovery draft');
      const send = page.getByRole('button', {
        name: 'Send message and continue chatting',
        exact: true,
      });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(
        page.getByText('Relay: Ready for our own conversation.', { exact: true }),
      ).toBeVisible();
      await expect.poll(() => f.store.read().messages.length).toBe(2);
      assert.equal(f.requests.length, 1);
      assert.equal((await r.computer.status()).state, 'missing');
      assert.equal(await r.snapshots.volumeExists(r.computer.volume), false);
      await page.screenshot({ path: join(evidence, `${surface}-chat-without-computer.png`) });
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        originalRecovered: true,
        explicitFreshStart: true,
        recoveryAddsNoMessages: true,
        chatContinuesWithoutReplacingStorage: true,
        draftPreserved: true,
        accessibility: true,
      });
      console.log(
        'PASS',
        surface,
        'real storage loss, reviewed restore, explicit fresh workspace and retained chat',
      );
    } finally {
      await app?.close();
      await context?.close();
      await r?.close();
      await f?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, native ? 'mac.json' : 'browser.json'),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks }, null, 2),
  );
} finally {
  await browser.close();
}
