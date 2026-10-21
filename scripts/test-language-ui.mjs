// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';
import { uiText as text } from '../shared/ui-language.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const nativeMac = process.argv.includes('--mac');
const browser = nativeMac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of nativeMac ? [false] : [false, true]) {
    const surface = nativeMac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-language-'));
    const fixture = await modelsFixture(directory);
    fixture.provider.save({
      preset: 'custom',
      name: 'Language acceptance',
      model: 'relay-chat-test',
      baseUrl: fixture.baseUrl,
      protocol: 'chat',
      apiKey: 'fixture-key',
      activate: true,
    });
    fixture.store.mutate((state) => {
      state.messages.push({
        id: 'language-preserve',
        role: 'user',
        threadId: 'main',
        text: 'Files · keep my words 原文',
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
          locale: 'en-US',
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
      const baseline = fixture.store.read();
      const composer = () => page.locator('.composer textarea');
      await expect(composer()).toBeVisible();
      await composer().fill('Keep this unfinished draft 原文');
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
      await page.getByLabel('Your name', { exact: true }).fill('Unsaved name');
      const canonicalTone = await page.getByLabel('Response style', { exact: true }).inputValue();
      await page.getByRole('combobox', { name: 'App language', exact: true }).selectOption('zh-CN');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await expect(page).toHaveTitle('Relay · 你的个人空间');
      await expect(page.getByLabel('你的名字', { exact: true })).toHaveValue('Unsaved name');
      await expect(page.getByLabel('回复风格', { exact: true })).toHaveValue(canonicalTone);
      await expect(page.getByRole('button', { name: '返回聊天', exact: true })).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(nativeMac).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({
        path: join(evidence, `language-settings-${surface}.png`),
        fullPage: false,
      });
      await page.getByRole('button', { name: '返回聊天', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '给Relay发消息', exact: true })).toHaveValue(
        'Keep this unfinished draft 原文',
      );
      await expect(page.locator('#message-language-preserve .message-bubble')).toHaveText(
        'Files · keep my words 原文',
      );
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await expect(composer()).toHaveValue('Keep this unfinished draft 原文');
      await composer().fill('打开语言设置');
      await page
        .getByRole('button', {
          name: text('zh-CN', 'Go to {page}', { page: text('zh-CN', 'Appearance & personality') }),
          exact: true,
        })
        .click();
      expect(new URL(page.url()).hash).toBe('#settings?section=personal');
      await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('zh-TW');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
      await expect(page.getByLabel('回覆風格', { exact: true })).toHaveValue(canonicalTone);
      await page.getByRole('button', { name: '返回聊天', exact: true }).click();
      await composer().fill('Keep traditional draft');
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page
        .getByRole('searchbox', { name: text('zh-TW', 'Find a feature or setting'), exact: true })
        .fill('語言');
      await page
        .getByRole('button', { name: text('zh-TW', 'Appearance & personality'), exact: true })
        .click();
      await expect(page.getByRole('combobox', { name: '介面語言', exact: true })).toHaveValue(
        'zh-TW',
      );
      await page.screenshot({ path: join(evidence, `language-traditional-${surface}.png`) });
      if (!nativeMac) {
        const second = await context.newPage();
        await second.goto(fixture.url);
        await expect(second.locator('html')).toHaveAttribute('lang', 'zh-TW');
        await page.getByRole('combobox', { name: '介面語言', exact: true }).selectOption('en');
        await expect(second.locator('html')).toHaveAttribute('lang', 'en');
        await second.close();
      } else await page.getByRole('combobox', { name: '介面語言', exact: true }).selectOption('en');
      await page
        .getByRole('combobox', { name: 'App language', exact: true })
        .selectOption('system');
      expect(await page.evaluate(() => localStorage.getItem('relay.ui-language'))).toBe('system');
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        nativeMac
          ? await page.evaluate(() => (navigator.language.startsWith('zh') ? 'zh-CN' : 'en'))
          : 'en',
      );
      // No server mutation, model call or message was produced by any preference/navigation action.
      const final = fixture.store.read();
      for (const key of ['messages', 'runs', 'profile']) expect(final[key]).toEqual(baseline[key]);
      expect(fixture.requests).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        savedDevicePreference: true,
        preservedDraftsAndNames: true,
        unchangedCanonicalSettings: true,
        noWorkspaceMutation: true,
        accessibility: true,
      });
      console.log(
        `PASS ${surface}: language switching, persistence, preserved drafts/data and Chinese navigation`,
      );
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `language-failure-${surface}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!nativeMac) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-device-language-'));
    const fixture = await modelsFixture(directory);
    try {
      for (const [device, expected] of [
        ['zh-TW', 'zh-TW'],
        ['zh-CN', 'zh-CN'],
        ['fr-FR', 'en'],
      ]) {
        const context = await browser.newContext({ locale: device });
        try {
          const page = await context.newPage();
          await page.goto(fixture.url);
          await expect(page.locator('html')).toHaveAttribute('lang', expected);
          expect(await page.evaluate(() => localStorage.getItem('relay.ui-language'))).toBeNull();
        } finally {
          await context.close();
        }
      }
      checks.push({
        systemLocale: 'Simplified, Traditional and English fallback; isolated device preferences',
        passed: true,
      });
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `language-${nativeMac ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Core UI only. Browser phone checks are not Android runtime acceptance. Model fixture is controlled; no live-provider assertion.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
