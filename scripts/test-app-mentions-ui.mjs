// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appMentionsFixture, mentionsFinal } from './app-mentions-fixture.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const phone of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : phone ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-mentions-ui-'));
    const f = await appMentionsFixture(directory);
    let app, context, page;
    try {
      if (native) {
        const profile = join(directory, 'native');
        await mkdir(profile);
        await writeFile(join(profile, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${profile}`],
        });
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: phone ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: phone,
          hasTouch: phone,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.locator('.composer textarea');
      const chip = (name) => page.getByRole('button', { name: `Remove ${name} app`, exact: true });
      const option = (name) => page.getByRole('option', { name: `${name} app`, exact: true });
      const before = f.store.read().messages.length;
      await composer.fill('@NoAppMatches');
      await expect(
        page.getByRole('option', { name: 'No matching apps', exact: true }),
      ).toBeVisible();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await composer.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await composer.fill('Email person@example.com');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await composer.fill('@');
      await expect(option('Little notebook')).toBeVisible();
      await expect(option('Other notebook')).toBeVisible();
      await expect(option('Writer only')).toHaveCount(0);
      await expect(option('Paused app')).toHaveCount(0);
      await page.screenshot({ path: join(evidence, `app-mentions-picker-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await composer.fill('@Little');
      await composer.press('Enter');
      await expect(chip('Little notebook')).toBeVisible();
      await expect(composer).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Sunday.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('A quiet Sunday.'),
      });
      const attachment = page.getByRole('button', { name: 'Open Sunday.txt', exact: true });
      await expect(attachment).toBeVisible();
      const fileBounds = await attachment.boundingBox(),
        chipBounds = await chip('Little notebook').boundingBox();
      expect(fileBounds.y + fileBounds.height).toBeLessThanOrEqual(chipBounds.y);
      await attachment.click();
      await expect(page.getByRole('region', { name: 'File preview', exact: true })).toContainText(
        'A quiet Sunday.',
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(chip('Little notebook')).toBeVisible();
      await page.getByRole('button', { name: 'Remove attachment', exact: true }).click();
      await composer.fill('Keep my notebook draft');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(composer).not.toBeVisible();
      await page.getByRole('button', { name: 'Main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my notebook draft');
      await expect(chip('Little notebook')).toBeVisible();
      await page.reload();
      await expect(composer).toHaveValue('Keep my notebook draft');
      await expect(chip('Little notebook')).toBeVisible();
      await chip('Little notebook').click();
      await composer.fill('Read  after lunch');
      await composer.press('Home');
      for (let i = 0; i < 5; i++) await composer.press('ArrowRight');
      await composer.pressSequentially('@Lit');
      await expect(option('Little notebook')).toBeVisible();
      await composer.press('Tab');
      await expect(composer).toHaveValue('Read  after lunch');
      await expect(chip('Little notebook')).toBeVisible();
      await page.getByRole('button', { name: 'Choose an app', exact: true }).click();
      await option('Other notebook').click();
      await expect(chip('Other notebook')).toBeVisible();
      await chip('Other notebook').click();
      await composer.fill('Keep my notebook draft');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'Little team', exact: true }).click();
      const groupComposer = page.locator('.composer textarea');
      await expect(chip('Little notebook')).toHaveCount(0);
      await groupComposer.fill('@Mochi');
      await groupComposer.press('Enter');
      await expect(page.getByRole('button', { name: 'Remove Mochi recipient' })).toBeVisible();
      await groupComposer.fill('@Writer');
      await option('Writer only').click();
      await expect(chip('Writer only')).toBeVisible();
      await groupComposer.fill('Keep the group draft');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my notebook draft');
      await expect(chip('Little notebook')).toBeVisible();
      expect(f.store.read().messages).toHaveLength(before);
      expect(f.remote.calls).toHaveLength(0);
      checks.push(
        `${label}: keyboard/touch picker, caret insertion, email boundary, scoped groups, per-chat draft and reload with no model call`,
      );
      const previous = f.selected;
      f.services.connectors.update({
        id: previous.id,
        revision: previous.revision,
        name: previous.name,
      });
      await expect(chip('Little notebook')).toContainText('Choose again');
      await composer.fill('Read and save my Sunday plan.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(composer).toHaveValue('Read and save my Sunday plan.');
      await expect(chip('Little notebook')).toBeVisible();
      expect(f.store.read().messages).toHaveLength(before);
      expect(f.remote.calls).toHaveLength(0);
      await page.getByRole('button', { name: 'Choose an app', exact: true }).click();
      await option('Little notebook').click();
      await expect(chip('Little notebook')).not.toContainText('Choose again');
      const visibleChip = await chip('Little notebook').boundingBox();
      expect(visibleChip.height).toBeLessThan(60);
      expect(visibleChip.width).toBeGreaterThan(100);
      const inputBounds = await composer.boundingBox();
      const appButtonBounds = await page
        .getByRole('button', { name: 'Choose an app', exact: true })
        .boundingBox();
      expect(appButtonBounds.x + appButtonBounds.width).toBeLessThanOrEqual(inputBounds.x);
      const dismissToast = page.getByRole('button', { name: 'Dismiss notification', exact: true });
      if (await dismissToast.isVisible()) await dismissToast.click();
      await page.screenshot({ path: join(evidence, `app-mentions-draft-${label}.png`) });
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const approve = page.getByRole('button', { name: 'Approve app action', exact: true });
      await expect(approve).toBeVisible({ timeout: 30000 });
      expect(f.remote.calls.map((c) => c.name)).toEqual(['find_note']);
      expect(f.remote.notes).toHaveLength(0);
      await expect(page.getByLabel('Apps selected for this message')).toContainText(
        'Little notebook',
      );
      await expect(chip('Little notebook')).toHaveCount(0);
      await composer.fill('Keep this thought for later');
      await page.getByRole('button', { name: 'Choose an app', exact: true }).click();
      await option('Other notebook').click();
      await page.reload();
      await expect(chip('Other notebook')).toBeVisible();
      await expect(approve).toBeVisible();
      await approve.click();
      await expect(page.locator('.messages').getByText(mentionsFinal, { exact: true })).toBeVisible(
        { timeout: 30000 },
      );
      expect(f.remote.notes).toHaveLength(1);
      expect(f.remote.calls.map((c) => c.name)).toEqual(['find_note', 'save_note']);
      expect(f.errors).toEqual([]);
      expect(f.requests).toHaveLength(5);
      await expect(chip('Other notebook')).toBeVisible();
      await expect(composer).toHaveValue('Keep this thought for later');
      const continuation = f.store.read().runs.find((r) => r.connectorContext);
      expect(continuation.appContext[0].id).toBe(f.selected.id);
      await page.screenshot({ path: join(evidence, `app-mentions-result-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      checks.push(
        `${label}: stale selection rejects without losing draft; HTTP model/MCP read, exact reviewed write once, frozen continuation and independent next draft`,
      );
    } catch (error) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `app-mentions-failure-${label}.png`) })
          .catch(() => {});
      throw error;
    } finally {
      await context?.close();
      await app?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      native ? 'app-mentions-native-mac-acceptance.json' : 'app-mentions-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Independent controlled HTTP model/MCP services; no hosted account or live-model quality certification.',
      },
      null,
      2,
    ),
  );
  console.log('PASS app selections: ' + checks.join('; '));
} finally {
  await browser?.close();
}
