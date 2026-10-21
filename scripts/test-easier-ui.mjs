// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';

const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const nativeMac = process.argv.includes('--mac');
const browser = nativeMac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of nativeMac ? [false] : [false, true]) {
    const surface = nativeMac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-easier-ui-'));
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
      }
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      if (!nativeMac) await page.goto(fixture.url);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my unfinished thought');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      const sidebar = page.locator('#chat-sidebar');
      const newChat = sidebar.getByRole('button', { name: 'New side chat', exact: true });
      await expect(newChat).toHaveText('New side chat');
      await expect(sidebar.getByRole('button', { name: 'Manage assistants' })).toHaveCount(0);
      await page.screenshot({
        path: join(evidence, `easier-sidebar-${surface}.png`),
        animations: 'disabled',
      });
      await newChat.click();
      await expect(sidebar).toBeHidden();
      await expect(composer).toHaveValue('');
      await expect(composer).toBeFocused();
      await composer.fill('Keep my separate side thought');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought');
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.store.read().messages).toHaveLength(0);
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      await dock.getByRole('button', { name: 'More', exact: true }).click();
      const finder = page.getByRole('searchbox', { name: 'Find a feature or setting' });
      await expect(finder).toBeVisible();
      await page.screenshot({ path: join(evidence, `easier-more-${surface}.png`) });
      await finder.fill('dark mode');
      const results = page.getByRole('region', { name: 'Matching features and settings' });
      await expect(results.getByRole('button')).toHaveCount(1);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.screenshot({ path: join(evidence, `easier-finder-${surface}.png`) });
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(nativeMac).analyze()).violations,
      ).toEqual([]);
      await finder.press('Enter');
      await expect(page.getByRole('combobox', { name: 'Appearance', exact: true })).toBeVisible();
      expect(page.url()).toContain('#settings?section=personal');
      await dock.getByRole('button', { name: 'More', exact: true }).click();
      await finder.fill('qwerty-no-match');
      await expect(results.getByRole('button')).toHaveCount(0);
      await finder.press('Enter');
      expect(page.url()).toContain('#more');
      await page.getByRole('button', { name: 'Clear feature search' }).click();
      await expect(finder).toHaveValue('');
      await expect(finder).toBeFocused();
      await finder.fill('voice');
      await finder.press('Escape');
      await expect(finder).toHaveValue('');
      await finder.fill('reminders');
      await results.getByRole('button', { name: 'Routines', exact: true }).click();
      expect(page.url()).toContain('#routines');
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.store.read().messages).toHaveLength(0);
      await dock.getByRole('button', { name: 'Main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought');
      await composer.fill('');
      const fileInput = page.locator('.composer input[type=file]');
      await fileInput.setInputFiles({
        name: 'A little thought.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Fictional attachment for acceptance.'),
      });
      const pending = page.locator('.composer .attachment-list');
      await expect(pending).toContainText('A little thought.txt');
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.store.read().messages).toHaveLength(0);
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await dock.getByRole('button', { name: 'Main chat', exact: true }).click();
      await page.reload();
      await expect(pending).toContainText('A little thought.txt');
      await expect(composer).toHaveValue('');
      await page.screenshot({ path: join(evidence, `easier-attachment-${surface}.png`) });
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('This reply came through your saved chat connection.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(pending).toHaveCount(0);
      const state = fixture.store.read();
      expect(state.messages).toHaveLength(2);
      const message = state.messages.find((m) => m.role === 'user');
      expect(message.text).toBe('Shared with you.');
      expect(message.fileIds).toHaveLength(1);
      expect(state.files.find((f) => f.id === message.fileIds[0]).name).toBe(
        'A little thought.txt',
      );
      expect(fixture.requests).toHaveLength(1);
      expect(JSON.stringify(fixture.requests[0].messages)).toContain(message.fileIds[0]);
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
        checks: [
          'visible side-chat action focuses an empty composer and keeps the Main draft without a dialog or model request',
          'inline feature/setting search, aliases, Enter, no-match and clear/focus',
          'direct settings category and routine navigation without messages or model requests',
          'unfinished text preserved; attachment-only draft survives navigation and reload',
          'one explicit Send produces one attached owner message and one actual HTTP model reply',
          'accessibility, viewport fit and no script errors',
        ],
      });
      console.log(
        `PASS ${surface}: inline finder and attachment-only send through the real worker`,
      );
    } catch (e) {
      await page
        ?.screenshot({ path: join(evidence, `easier-failure-${surface}.png`), timeout: 5000 })
        .catch(() => {});
      throw e;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, nativeMac ? 'easier-native-mac-acceptance.json' : 'easier-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope: nativeMac
          ? 'Existing packaged Mac remote client with current production UI and isolated real Relay/SQLite/HTTP provider. File input is driven through the renderer; no native picker, bundled backend rebuild, other platform or live-account claim.'
          : 'Production browser UI with real Relay, SQLite, worker and controlled local HTTP provider; not native or live-account acceptance.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
