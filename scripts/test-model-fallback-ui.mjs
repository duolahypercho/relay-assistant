// SPDX-License-Identifier: MIT
// Real Relay, SQLite and independent HTTP model; provider outage is controlled, not a live-account claim.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of [false, true]) {
    const surface = mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-model-backup-ui-'));
    const f = await modelsFixture(directory);
    const save = (name, model) =>
      f.provider.save({
        preset: 'custom',
        name,
        model,
        baseUrl: f.baseUrl,
        protocol: 'chat',
        apiKey: 'fictional-key',
      }).id;
    const primary = save('Everyday model', 'primary');
    const one = save('Calm model', 'calm');
    const two = save('Quick model', 'quick');
    f.setFailure('primary', 429);
    f.setFailure('quick', 503);
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    let page;
    try {
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(f.url);
      const composer = () => page.locator('.composer textarea');
      await composer().fill('Keep this unsent thought');
      await page.goto(f.url + '/#settings?section=models');
      const panel = page.getByRole('article', { name: 'AI models', exact: true });
      const backups = panel.locator('.model-backups');
      await expect(backups.locator('summary')).toHaveText('Backup models · off');
      await expect(backups.getByLabel('Add a backup model')).toBeHidden();
      await backups.locator('summary').click();
      await expect(backups).toContainText('same chat, files and tool results');
      await backups.getByLabel('Add a backup model').selectOption(one);
      await backups.getByRole('button', { name: 'Add backup', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('saved for new requests');
      await backups.getByLabel('Add a backup model').selectOption(two);
      await backups.getByRole('button', { name: 'Add backup', exact: true }).click();
      await expect(
        backups.getByRole('list', { name: 'Backup model order' }).getByRole('listitem'),
      ).toHaveCount(2);
      await backups.getByRole('button', { name: 'Move Quick model earlier', exact: true }).click();
      await expect(backups.getByRole('listitem').first()).toContainText('Quick model');
      expect(f.provider.publicState().fallbacks[primary]).toEqual([two, one]);
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await backups.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `model-backups-settings-${surface}.png`) });
      await page.reload();
      await backups.locator('summary').click();
      await expect(backups.getByRole('listitem').first()).toContainText('Quick model');
      await panel.getByLabel('Active connection', { exact: true }).selectOption(one);
      await expect(backups.locator('summary')).toHaveText('Backup models · off');
      await panel.getByLabel('Active connection', { exact: true }).selectOption(primary);
      await expect(backups.locator('summary')).toHaveText('Backup models · 2 ready');
      await page.goto(f.url + '/#chat');
      await expect(composer()).toHaveValue('Keep this unsent thought');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('This reply came through your saved chat connection.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByText('Answered with Calm model · backup model', { exact: true }),
      ).toBeVisible();
      expect(f.store.read().messages).toHaveLength(2);
      expect(f.requests.map((request) => request.model)).toEqual(['primary', 'quick', 'calm']);
      expect(f.provider.publicState().active).toBe(primary);
      await page.screenshot({ path: join(evidence, `model-backups-reply-${surface}.png`) });
      await composer().fill('Retain this second draft');
      await page.goto(f.url + '/#settings?section=models');
      await backups.locator('summary').click();
      await backups.getByRole('button', { name: 'Remove Quick model backup', exact: true }).click();
      await expect(backups.getByRole('listitem')).toHaveCount(1);
      await backups.getByRole('button', { name: 'Turn off backups', exact: true }).click();
      await expect(backups.locator('summary')).toHaveText('Backup models · off');
      await page.reload();
      await page.goto(f.url + '/#chat');
      await expect(composer()).toHaveValue('Retain this second draft');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByText(/I could not finish this reply:.*HTTP 429/)).toBeVisible({
        timeout: 30000,
      });
      expect(f.requests.map((request) => request.model)).toEqual([
        'primary',
        'quick',
        'calm',
        'primary',
      ]);
      expect(f.store.read().messages).toHaveLength(4);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'optional collapsed setup; ordered backups saved per selected model',
          'settings never create messages or requests; draft survives reload',
          'real 429 then 503 falls back in order to a complete reply',
          'one user/reply pair with visible backup label; primary selection retained',
          'remove and disable persist; disabled backups receive no request',
          'accessibility and viewport fit',
        ],
      });
      console.log(
        `PASS ${surface}: ordered model fallback, explicit consent, persistence, one reply, disable and accessibility`,
      );
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `model-backups-failure-${surface}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'model-fallback-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Production browser UI, real Relay/SQLite/HTTP with controlled provider failures; no live-account or native-app claim.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
