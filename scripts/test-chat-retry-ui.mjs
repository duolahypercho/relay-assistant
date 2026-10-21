// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chatRetryFixture, retryRequest, retryAnswer } from './chat-retry-fixture.mjs';
const expect = baseExpect.configure({ timeout: 15000 });
const mac = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of mac ? [1365] : [1365, 390, 320]) {
    const label = mac ? 'mac' : String(width),
      mobile = width < 600;
    const directory = await mkdtemp(join(tmpdir(), 'relay-chat-retry-'));
    const f = await chatRetryFixture(directory);
    let app, context, page;
    try {
      if (mac) {
        await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        context = await browser.newContext({
          viewport: { width, height: mobile ? 844 : 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const retry = page.getByRole('button', { name: 'Try again', exact: true });
      await composer.fill(retryRequest);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(retry).toBeVisible();
      assert.equal(f.store.read().files.length, 1);
      const fileId = f.store.read().files[0].id;
      const count = f.store.read().messages.length;
      assert.equal(count, 2);
      await composer.fill('Keep my next thought');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.reload();
      await expect(retry).toBeVisible();
      await expect(composer).toHaveValue('Keep my next thought');
      assert.equal(f.store.read().messages.length, count);
      const bounds = await retry.boundingBox();
      assert(bounds.height >= 44 && bounds.width >= 44);
      await page.screenshot({ path: join(evidence, `chat-retry-ready-${label}.png`) });
      assert.deepEqual(
        (
          await new AxeBuilder({ page })
            .setLegacyMode(mac)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
        [],
      );
      f.controls.fail = false;
      f.controls.hold = true;
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText('Trying again…', { exact: true })).toBeVisible();
      await expect.poll(() => f.requests.length).toBe(3);
      await page.reload();
      await expect(page.getByText('Trying again…', { exact: true })).toBeVisible();
      await expect(retry).toHaveCount(0);
      assert.equal(f.store.read().runs[0].retryCount, 1);
      f.controls.release();
      await expect(page.getByText(retryAnswer, { exact: true })).toBeVisible();
      await expect(composer).toHaveValue('Keep my next thought');
      assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
      assert.deepEqual(
        f.store.read().files.map((f) => f.id),
        [fileId],
      );
      assert.equal(f.requests.length, 3);
      assert.equal(f.store.db.prepare('SELECT count(*) as n FROM agent_checkpoints').get().n, 0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(evidence, `chat-retry-done-${label}.png`) });
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'Failed reply retains saved file and shows one inline action',
          'Draft and recovery survive separate-page navigation and reload without history noise',
          '44px keyboard-accessible retry; zero Axe violations',
          'Pending retry survives reload and cannot duplicate dispatch',
          'One original request, one saved file, three HTTP model calls total',
          'Completed checkpoint removed; no dialogs or horizontal overflow',
        ],
      });
      console.log('PASS retry', label);
    } finally {
      f.controls.release?.();
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `chat-retry-${mac ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        scope:
          'Controlled HTTP model interruption; real agent, file tool, database, browser and/or packaged Mac client. No claim of model quality or physical phone verification.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
