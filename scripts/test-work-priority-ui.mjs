// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { priorityFixture, directRequest, directReply } from './work-priority-fixture.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-priority-ui-')),
      f = await priorityFixture(directory);
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
      await input.fill(directRequest);
      const sentAt = Date.now();
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await f.checkPriority();
      const foregroundMilliseconds = Date.now() - sentAt;
      expect(foregroundMilliseconds).toBeLessThan(3000);
      // Visit an existing side chat using the same UI as the owner.
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'Background 1', exact: true }).click();
      await expect(
        page.getByText('Waiting while I answer your message', { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(evidence, `work-priority-waiting-${surface}.png`) });
      await page.getByRole('button', { name: 'Main chat', exact: true }).click();
      f.releaseForeground();
      await expect(page.getByText(directReply, { exact: true })).toBeVisible();
      await input.fill('Keep my next draft');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await f.verify();
      await page.getByRole('button', { name: 'Main chat', exact: true }).click();
      await page.reload();
      await expect(input).toHaveValue('Keep my next draft');
      await expect(page.getByText(directReply, { exact: true })).toBeVisible();
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
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(evidence, `work-priority-${surface}.png`) });
      checks.push({
        surface,
        passed: true,
        foregroundMilliseconds,
        modelCalls: f.requests.length,
        savedFiles: f.store.read().files.length,
        mainMessages: 2,
      });
      console.log(
        `PASS ${surface}: owner request started with four occupied background slots; all notes resumed once`,
      );
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      native ? 'work-priority-native-mac-acceptance.json' : 'work-priority-browser-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope: 'Actual UI, SQLite and independent HTTP model; controlled model decisions.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
