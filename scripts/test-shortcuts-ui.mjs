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
    const surface = nativeMac ? 'native-mac' : mobile ? 'phone-browser' : 'desktop-browser';
    const directory = await mkdtemp(join(tmpdir(), 'relay-shortcuts-'));
    const fixture = await modelsFixture(directory);
    fixture.provider.save({
      preset: 'custom',
      name: 'Acceptance only',
      model: 'relay-chat-test',
      baseUrl: fixture.baseUrl,
      protocol: 'chat',
      apiKey: 'fixture-key',
      activate: true,
    });
    fixture.store.mutate((s) => {
      s.threads.find((t) => t.id === 'main').title = 'Your workspace';
      s.threads.push(
        { id: 'travel', title: 'Travel notes', assistantId: 'relay' },
        { id: 'hidden-chat', title: 'Put away', archived: true },
      );
      for (let i = 0; i < 36; i++)
        s.messages.push({
          id: `other-${i}`,
          threadId: 'travel',
          role: 'assistant',
          text: `needle elsewhere ${i}`,
          createdAt: new Date().toISOString(),
        });
      s.messages.push({
        id: 'main-match',
        threadId: 'main',
        role: 'assistant',
        text: 'needle in the main conversation',
        createdAt: new Date().toISOString(),
      });
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
      const modifier = await page.evaluate(() =>
        /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control',
      );
      const press = (key) => page.keyboard.press(`${modifier}+${key}`);
      const composer = page.locator('[data-chat-composer]');
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      const original = fixture.store.read().messages;
      await composer.fill('Main unfinished thought');
      await press('f');
      await page.getByRole('textbox', { name: 'Search this chat' }).fill('needle');
      const results = page.getByRole('region', { name: 'Your workspace results' });
      await expect(results.getByRole('button')).toHaveCount(1);
      await expect(results).toContainText('needle in the main conversation');
      await expect(page.getByText('Searching Main chat.', { exact: true })).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(nativeMac).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: join(evidence, `shortcuts-search-${surface}.png`) });
      // Scope changes keep the query. Chat-only filtering happens before the 30-result cap.
      await page.getByRole('button', { name: 'Everything', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Search your workspace' })).toHaveValue(
        'needle',
      );
      await expect(results.getByRole('button')).toHaveCount(30);
      await page.getByRole('button', { name: 'This chat', exact: true }).click();
      await results.getByRole('button').click();
      await expect(page.locator('#message-main-match')).toHaveClass(/search-match/);
      await expect(composer).toHaveValue('Main unfinished thought');
      checks.push(
        `${surface}: scoped search, preserved query, exact message and accessible dialog`,
      );

      await press('2');
      await expect(page).toHaveURL(/#chat\/travel$/);
      await composer.fill('Travel unfinished thought');
      await press('1');
      await expect(composer).toHaveValue('Main unfinished thought');
      await page.keyboard.press('Control+Tab');
      await expect(composer).toHaveValue('Travel unfinished thought');
      await page.keyboard.press('Control+Shift+Tab');
      await expect(composer).toHaveValue('Main unfinished thought');
      // Alt+arrows keep native editing behavior inside a message field.
      await composer.focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(page).toHaveURL(/#chat$/);
      await page.getByRole('button', { name: 'Search', exact: true }).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect(page).toHaveURL(/#chat\/travel$/);
      await press('[');
      await expect(page).toHaveURL(/#chat$/);
      await press(']');
      await expect(page).toHaveURL(/#chat\/travel$/);
      await press('Shift+f');
      const chatSearch = page.getByRole('textbox', { name: 'Search chats', exact: true });
      await expect(chatSearch).toBeFocused();
      await expect(results.getByRole('button')).toHaveCount(2);
      await chatSearch.fill('Travel');
      await chatSearch.press('Enter');
      await expect(composer).toHaveValue('Travel unfinished thought');
      await press(',');
      await expect(page).toHaveURL(/#settings$/);
      await press('Enter');
      expect(fixture.requests).toHaveLength(0);
      await press('i');
      await expect(page).toHaveURL(/#chat\/travel$/);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue('Travel unfinished thought');
      checks.push(
        `${surface}: numbered/cyclic/history navigation, scoped chat switcher and retained drafts`,
      );

      await page.getByRole('button', { name: 'Search', exact: true }).focus();
      await press('b');
      await expect(page.locator('#chat-sidebar')).toBeVisible();
      await press('b');
      await expect(page.locator('#chat-sidebar')).toBeHidden();
      await press('Shift+m');
      await expect(page).toHaveURL(/#apps$/);
      await press('i');
      // The open details dialog owns keyboard input; application commands cannot send/create.
      await press('Shift+,');
      await expect(page.getByRole('dialog')).toHaveCount(1);
      const threadsBefore = fixture.store.read().threads.length;
      await press('n');
      await press('Enter');
      expect(fixture.store.read().threads).toHaveLength(threadsBefore);
      expect(fixture.requests).toHaveLength(0);
      await page.keyboard.press('Escape');
      // Scope arbitration uses the same focused element boundary as the real computer.
      await page.evaluate(() => {
        const boundary = document.createElement('div');
        boundary.className = 'computer-screen-input';
        boundary.id = 'test-guest-focus';
        const input = document.createElement('textarea');
        boundary.append(input);
        document.body.append(boundary);
        input.focus();
      });
      await press('k');
      await press('n');
      await press('Enter');
      await press('1');
      await expect(page).toHaveURL(/#chat\/travel$/);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(fixture.store.read().threads).toHaveLength(threadsBefore);
      expect(fixture.requests).toHaveLength(0);
      await page.evaluate(() => document.getElementById('test-guest-focus').remove());
      await composer.focus();
      await composer.dispatchEvent('keydown', {
        key: 'n',
        [modifier === 'Meta' ? 'metaKey' : 'ctrlKey']: true,
        isComposing: true,
        bubbles: true,
      });
      await composer.dispatchEvent('keydown', {
        key: 'n',
        [modifier === 'Meta' ? 'metaKey' : 'ctrlKey']: true,
        repeat: true,
        bubbles: true,
      });
      expect(fixture.store.read().threads).toHaveLength(threadsBefore);
      expect(fixture.store.read().messages).toEqual(original);
      checks.push(
        `${surface}: dialogs, composition, repeats and guest-focus boundary protect input; navigation adds no history`,
      );

      await dock.getByRole('button', { name: 'More', exact: true }).click();
      const finder = page.getByRole('searchbox', { name: 'Find a feature or setting' });
      await finder.fill('keyboard');
      await expect(page.locator('.keyboard-help')).toHaveAttribute('open', '');
      await expect(page.locator('.keyboard-help')).toContainText('Find in this chat');
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(nativeMac).analyze()).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.screenshot({ path: join(evidence, `shortcuts-help-${surface}.png`) });
      await press('i');
      if (nativeMac) {
        await app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu().getMenuItemById('find-chat').click(),
        );
        await expect(page.getByRole('textbox', { name: 'Search this chat' })).toBeFocused();
        await page.keyboard.press('Escape');
        await app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu().getMenuItemById('settings').click(),
        );
        await expect(page).toHaveURL(/#settings$/);
        await app.evaluate(({ Menu }) =>
          Menu.getApplicationMenu().getMenuItemById('focus-prompt').click(),
        );
        await expect(page).toHaveURL(/#chat\/travel$/);
        await expect(composer).toBeFocused();
        checks.push(
          'native-mac: actual application menu commands use the latest chat and current renderer',
        );
      }
      // Explicit shortcut from a button submits one current draft through the actual worker/provider.
      await page.getByRole('button', { name: 'Search', exact: true }).focus();
      await press('Enter');
      await expect(
        page
          .locator('.messages')
          .getByText('This reply came through your saved chat connection.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(fixture.requests).toHaveLength(1);
      const messages = fixture.store.read().messages;
      expect(messages).toHaveLength(original.length + 2);
      expect(messages.find((m) => m.role === 'user')).toMatchObject({
        threadId: 'travel',
        text: 'Travel unfinished thought',
      });
      await press('1');
      await expect(composer).toHaveValue('Main unfinished thought');
      expect(errors).toEqual([]);
      checks.push(
        `${surface}: inline help, responsive fit and explicit one-request send through real HTTP provider`,
      );
      console.log(`PASS ${surface}: scoped search, shortcuts, drafts, boundaries and real send`);
    } catch (e) {
      await page
        ?.screenshot({ path: join(evidence, `shortcuts-failure-${surface}.png`) })
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
    join(
      evidence,
      nativeMac ? 'shortcuts-native-mac-acceptance.json' : 'shortcuts-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Controlled HTTP provider. Guest focus arbitration uses a synthetic focus boundary; full desktop input has separate real-Docker tests. Browser keyboard events and Mac native menu callbacks are exercised, not every OS-reserved physical key.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
