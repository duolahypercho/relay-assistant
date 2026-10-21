// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  steeringFixture,
  initialRequest,
  correction,
  queuedRequest,
  correctedReply,
  queuedReply,
} from './steering-fixture.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-steering-')),
      f = await steeringFixture(directory);
    let app, context, page;
    try {
      if (native) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const input = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await expect(input).toBeVisible();
      await page.getByRole('button', { name: 'Pause companion', exact: true }).click();
      await input.fill(initialRequest);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.firstWaiting).toBe(true);
      await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toBeVisible();
      await input.fill(correction);
      await page.locator('input[type=file]').setInputFiles({
        name: 'garden-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Meet at the garden at 10. Bring water.'),
      });
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      await expect(
        page.getByRole('button', { name: 'Queue follow-up', exact: true }),
      ).toBeVisible();
      const queueControl = page.getByRole('button', { name: 'Queue follow-up', exact: true });
      expect(
        parseFloat(await queueControl.evaluate((el) => getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(12);
      expect((await queueControl.boundingBox()).height).toBeGreaterThanOrEqual(44);
      const stopControl = page.getByRole('button', { name: 'Stop reply', exact: true });
      await expect(stopControl).toBeVisible();
      expect((await stopControl.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect((await stopControl.boundingBox()).width).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: join(evidence, `steering-compose-${label}.png`) });
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.correctedWaiting).toBe(true);
      expect(f.store.read().runs).toHaveLength(1);
      expect(f.store.read().runs[0].steeringApplied).toBe(1);
      await input.fill(queuedRequest);
      await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
      await expect(page.getByText('1 follow-up queued', { exact: true })).toBeVisible();
      expect(f.store.read().runs.filter((r) => r.status === 'queued')).toHaveLength(1);
      await input.fill('Keep my next draft');
      f.release();
      await expect(page.getByText(correctedReply, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(queuedReply, { exact: true })).toBeVisible({ timeout: 15000 });
      expect(f.store.read().runs.every((r) => r.status === 'completed')).toBe(true);
      expect(f.store.read().messages).toHaveLength(5);
      expect(f.store.read().memories).toHaveLength(0);
      await expect(page.getByText('Obsolete Saturday plan.', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(input).toHaveValue('Keep my next draft');
      await page.reload();
      await expect(input).toHaveValue('Keep my next draft');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Main chat', exact: true }).click();
      await expect(input).toHaveValue('Keep my next draft');
      expect(f.store.read().messages).toHaveLength(5);
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(evidence, `steering-result-${label}.png`) });
      checks.push({
        surface: label,
        passed: true,
        modelRequests: f.requests.length,
        checks: [
          'one-tap Send redirects real in-flight HTTP model request',
          'attached file reaches the model through the existing read tool',
          'one active run; obsolete response/tool plan discarded',
          'explicit queue executes afterward',
          'draft and clean navigation survive reload',
          'no modal, accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${label}: redirect, attachment, queue, reload and navigation`);
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `steering-${native ? 'native-mac' : 'browser'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Actual UI, SQLite worker, HTTP provider and file tool. Controlled model behavior, not live reasoning quality.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
