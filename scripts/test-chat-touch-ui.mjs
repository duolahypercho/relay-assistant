// SPDX-License-Identifier: MIT
// Actual edge taps and navigation against an isolated production UI and HTTP model.
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
const expect = baseExpect.configure({ timeout: 12000 });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const width of [320, 390, 481, 600, 720])
    for (const locale of ['en', 'zh-CN']) {
      const directory = await mkdtemp(join(tmpdir(), 'relay-touch-'));
      const f = await assistantsFixture(directory, {
        configure(store) {
          store.mutate((s) => {
            s.profile.theme = locale === 'en' ? 'light' : 'dark';
            appendAssistant(s, 'main', { text: 'Shall we take a walk by the river?', cards: [] });
          });
        },
        respond() {
          return { role: 'assistant', content: 'A walk by the river sounds lovely.' };
        },
      });
      const context = await browser.newContext({
        viewport: { width, height: width === 320 ? 568 : 844 },
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'reduce',
      });
      await context.addInitScript(
        (locale) => localStorage.setItem('relay.ui-language', locale),
        locale,
      );
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const targets = [];
      const hit = async (locator, label, tap = false) => {
        await expect(locator).toBeVisible();
        const size = await locator.evaluate((el) => {
          const b = el.getBoundingClientRect();
          const points = [
            [b.left + 2, b.top + b.height / 2],
            [b.right - 2, b.top + b.height / 2],
            [b.left + b.width / 2, b.top + 2],
            [b.left + b.width / 2, b.bottom - 2],
          ];
          return {
            width: b.width,
            height: b.height,
            x: points[0][0],
            y: points[0][1],
            hits: points.map(([x, y]) => el.contains(document.elementFromPoint(x, y))),
            blockers: points.map(([x, y]) =>
              document.elementFromPoint(x, y)?.outerHTML.slice(0, 200),
            ),
          };
        });
        expect(size.width, label).toBeGreaterThanOrEqual(43.9);
        expect(size.height, label).toBeGreaterThanOrEqual(43.9);
        expect(
          size.hits,
          `${width}/${locale} ${label} all edges unobstructed: ${JSON.stringify(size)}`,
        ).toEqual([true, true, true, true]);
        targets.push({ label, width: size.width, height: size.height });
        if (tap) await locator.tap({ position: { x: 2, y: size.height / 2 } });
      };
      try {
        await page.goto(f.url);
        const composer = page.locator('.composer textarea');
        await expect(composer).toBeVisible();
        for (const [selector, label] of [
          ['.sidebar-toggle', 'chats'],
          ['.global-search', 'search'],
          ['.companion-toggle', 'pause companion'],
          ['.assistant-details-button', 'assistant details'],
          ['.sample-badge', 'model'],
          ['.notification-button', 'notifications'],
          ['.chat-workspace .conversation-menu-trigger', 'chat options'],
          ['.composer-plus', 'attachments'],
          ['.composer-voice', 'dictation'],
          ['.send-button', 'voice chat'],
        ])
          await hit(page.locator(selector), label);
        await expect(page.locator('.workspace-shortcut')).toBeHidden();
        await hit(page.locator('.companion-toggle'), 'pause edge', true);
        await expect(page.locator('.companion-toggle')).toHaveAttribute(
          'aria-label',
          'Wake companion',
        );
        await composer.fill('Keep this draft while I look around.');
        await hit(page.locator('.global-search'), 'search edge', true);
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await hit(page.locator('.sidebar-toggle'), 'chats edge', true);
        await expect(page.locator('.sidebar-scrim')).toBeVisible();
        await hit(
          page.locator('.sidebar .conversation-menu-trigger').first(),
          'sidebar options edge',
          true,
        );
        await expect(page.getByRole('menu')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.locator('.sidebar-scrim').click({ position: { x: width - 2, y: 120 } });
        await expect(page.locator('.sidebar-scrim')).toHaveCount(0);
        await hit(page.locator('.composer-plus'), 'attach edge', true);
        await expect(page.getByRole('menu')).toBeVisible();
        await page.keyboard.press('Escape');
        await hit(page.locator('.composer-voice'), 'dictation edge', true);
        await expect(page).toHaveURL(/#settings\?section=voice/);
        expect(f.requests).toHaveLength(0);
        expect(f.store.read().messages).toHaveLength(1);
        await page.goto(f.url + '/#chat');
        await expect(composer).toHaveValue('Keep this draft while I look around.');
        await hit(page.locator('.message-more').first(), 'message options edge', true);
        const reply = page.getByRole('button', { name: 'Reply to message', exact: true });
        await hit(reply, 'reply edge', true);
        await expect(page.locator('.reply-preview')).toBeVisible();
        await hit(
          page.getByRole('button', { name: 'Cancel reply', exact: true }),
          'cancel reply edge',
          true,
        );
        await expect(page.locator('.reply-preview')).toHaveCount(0);
        await hit(page.locator('.send-button'), 'send edge', true);
        await expect(
          page.getByText('A walk by the river sounds lovely.', { exact: true }),
        ).toBeVisible();
        expect(f.requests).toHaveLength(1);
        expect(f.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(1);
        await composer.fill('A quiet afternoon, together.');
        await page.reload();
        await expect(composer).toHaveValue('A quiet afternoon, together.');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(errors).toEqual([]);
        await page.screenshot({ path: join(evidence, `chat-touch-${width}-${locale}.png`) });
        checks.push({
          width,
          locale,
          targets,
          edgeTaps: true,
          draftReload: true,
          singleSend: true,
          errors,
        });
      } catch (error) {
        await page.screenshot({
          path: join(evidence, `chat-touch-failure-${width}-${locale}.png`),
        });
        throw new Error(`${width}/${locale}: ${error.message}`, { cause: error });
      } finally {
        await context.close();
        await f.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  await writeFile(
    join(evidence, 'chat-touch-ui.json'),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks }, null, 2),
  );
  console.log(
    'PASS: phone touch edges, translated headers, reply, single send and retained drafts at 320/390px; no accessibility violations or page errors.',
  );
} finally {
  await browser.close();
}
