// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chatStopFixture,
  initialRequest,
  queuedRequest,
  stoppedReply,
  queuedReply,
} from './chat-stop-fixture.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-chat-stop-')),
      f = await chatStopFixture(directory);
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
      await expect.poll(() => f.waiting).toBe(true);
      await input.fill(queuedRequest);
      await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
      await input.fill('Stop now');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByText(stoppedReply, { exact: true })).toBeVisible();
      await expect(page.getByText('1 follow-up paused', { exact: true })).toBeVisible();
      expect(f.requests).toHaveLength(1);
      expect(f.store.read().runs).toHaveLength(2);
      expect(f.store.read().runs[0].status).toBe('cancelled');
      f.release();
      await input.fill('Keep my next draft');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Main chat', exact: true }).click();
      await expect(input).toHaveValue('Keep my next draft');
      await page.reload();
      await expect(input).toHaveValue('Keep my next draft');
      await expect(page.getByText(stoppedReply, { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(
        (
          await new AxeBuilder({ page })
            .setLegacyMode(native)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(evidence, `chat-stop-${surface}.png`) });
      await page.getByRole('button', { name: 'Send queued messages', exact: true }).click();
      await expect(page.getByText(queuedReply, { exact: true })).toBeVisible();
      await expect(input).toHaveValue('Keep my next draft');
      expect(f.store.read().messages).toHaveLength(5);
      expect(f.requests).toHaveLength(2);
      expect(f.store.read().memories).toHaveLength(0);
      await expect(page.getByText('A late obsolete plan.', { exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'typed Stop cancels a pending HTTP model without calling it again',
          'queued request paused and resumed only explicitly',
          'late response creates no tool action or answer',
          'draft and receipt survive navigation and reload',
          'no dialog, accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: typed Stop, paused queue, preserved draft and explicit resume`);
    } finally {
      f.release();
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      native ? 'chat-stop-native-mac-acceptance.json' : 'chat-stop-browser-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope: 'Real UI and SQLite/HTTP worker; controlled model behavior.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
