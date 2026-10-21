// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';

const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const nativeMac = process.argv.includes('--mac');
const browser = nativeMac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of nativeMac ? [false] : [false, true]) {
    const surface = nativeMac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-direct-navigation-'));
    const fixture = await modelsFixture(directory);
    fixture.provider.save({
      preset: 'custom',
      name: 'Local acceptance',
      model: 'relay-chat-test',
      baseUrl: fixture.baseUrl,
      protocol: 'chat',
      apiKey: 'fixture-key',
      activate: true,
    });
    let app, context, page;
    try {
      if (nativeMac) {
        const desktopData = join(directory, 'desktop');
        await mkdir(desktopData);
        await writeFile(join(desktopData, 'desktop.json'), JSON.stringify({ server: fixture.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${desktopData}`],
        });
        context = app.context();
        page = await app.firstWindow({ timeout: 15000 });
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(fixture.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const preview = page.locator('.composer-navigation');
      const baseline = fixture.store.read();
      for (const [request, title, route] of [
        ['show my files', 'Files', '#files'],
        ['open tasks', 'Tasks', '#activity'],
        ['take me to my calendar', 'Calendar', '#calendar'],
        ['open settings', 'Settings', '#settings'],
        ['open appearance settings', 'Appearance & personality', '#settings?section=personal'],
        ['open the computer', 'Computer', '#computer'],
      ]) {
        await composer.fill(request);
        await expect(
          preview.getByRole('button', { name: `Open ${title}`, exact: true }),
        ).toBeVisible();
        if (title === 'Files') {
          await page.screenshot({ path: join(evidence, `direct-navigation-${surface}.png`) });
          expect(
            (await new AxeBuilder({ page }).setLegacyMode(nativeMac).analyze()).violations,
          ).toEqual([]);
          await composer.press('Enter');
        } else {
          await page.getByRole('button', { name: `Go to ${title}`, exact: true }).click();
        }
        expect(new URL(page.url()).hash).toBe(route);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(composer).toHaveValue('');
      }
      expect(fixture.store.read().messages).toEqual(baseline.messages);
      expect(fixture.store.read().runs).toEqual(baseline.runs);
      expect(fixture.store.read().profile).toEqual(baseline.profile);
      expect(fixture.requests).toHaveLength(0);

      // Navigating from a side chat keeps its identity and the separate Main draft.
      await composer.fill('Keep my main draft');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await composer.fill('open files');
      await preview.getByRole('button', { name: 'Open Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Back to main chat', exact: true }),
      ).toBeVisible();
      await composer.fill('Keep my side draft');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main draft');
      await page.reload();
      await expect(composer).toHaveValue('Keep my main draft');

      // With no computer configured, teaching opens its setup page without
      // sending a request or consuming the unfinished chat message.
      await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Teach a task', exact: true }).click();
      await expect(page).toHaveURL(/#computer\/teaching\/new\?chat=main/);
      await expect(
        page.getByRole('button', { name: 'Take control & record', exact: true }),
      ).toHaveCount(0);
      expect(fixture.store.read().messages).toEqual(baseline.messages);
      expect(fixture.store.read().runs).toEqual(baseline.runs);
      expect(fixture.requests).toHaveLength(0);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main draft');

      for (const request of [
        'show my files from yesterday',
        'open files and summarize them',
        'Can you show my files?',
        '"open files"',
      ]) {
        await composer.fill(request);
        await expect(preview).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      }
      // The explicit alternate action sends the unmodified request exactly once.
      await composer.fill('show my files');
      await preview.getByRole('button', { name: 'Ask Relay instead', exact: true }).click();
      await expect(
        page.getByText('This reply came through your saved chat connection.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(fixture.requests).toHaveLength(1);
      expect(
        fixture.store
          .read()
          .messages.filter((m) => m.role === 'user')
          .at(-1).text,
      ).toBe('show my files');

      // Context must never disappear into a navigation command.
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Navigation context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Preserve this attachment.'),
      });
      await expect(page.locator('.composer .attachment-list')).toContainText(
        'Navigation context.txt',
      );
      await composer.fill('open files');
      await expect(preview).toHaveCount(0);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('This reply came through your saved chat connection.', { exact: true }),
      ).toHaveCount(2, { timeout: 30000 });
      expect(fixture.requests).toHaveLength(2);
      const sent = fixture.store
        .read()
        .messages.filter((m) => m.role === 'user')
        .at(-1);
      expect(sent.text).toBe('open files');
      expect(sent.fileIds).toHaveLength(1);
      expect(new URL(page.url()).hash).toContain('#chat');
      await composer.fill('open appearance settings');
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(nativeMac).analyze()).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        zeroRequestsForNavigation: true,
        preservedContext: true,
        explicitModelRequests: 2,
        accessibility: true,
      });
      console.log(
        `PASS ${surface}: direct page requests, no chat noise, preserved context and explicit model override`,
      );
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `direct-navigation-failure-${surface}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `direct-navigation-${nativeMac ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Production UI and real Relay worker against controlled HTTP model; no live-account claim.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
