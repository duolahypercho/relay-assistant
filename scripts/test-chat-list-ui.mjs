// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const mac = process.argv.includes('--mac'),
  browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop',
      dir = await mkdtemp(join(tmpdir(), 'relay-chat-list-ui-')),
      fixture = await modelsFixture(dir);
    const first = fixture.store.mutate((s) => command(s, 'thread.create', { title: 'Groceries' })),
      second = fixture.store.mutate((s) => command(s, 'thread.create', { title: 'Travel' }));
    const specialist = fixture.store.mutate((s) =>
      command(s, 'assistant.create', { name: 'Garden', description: 'Garden planning' }),
    );
    const baseline = fixture.store.read();
    let app, context, page;
    try {
      if (mac) {
        const data = join(dir, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: fixture.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
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
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true }),
        sidebar = page.locator('#chat-sidebar');
      const thread = (id) => fixture.store.read().threads.find((t) => t.id === id);
      async function openList() {
        if (!(await sidebar.isVisible()) || (await sidebar.getAttribute('aria-hidden')) === 'true')
          await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      }
      async function options(name) {
        const control = page.getByRole('button', { name: `Options for ${name}`, exact: true });
        if (!mobile) await control.locator('..').hover();
        await control.click();
      }
      await composer.fill('Keep my main thought');
      await openList();
      await options('Groceries');
      await page.getByRole('menuitem', { name: 'Pin conversation', exact: true }).click();
      await expect.poll(() => thread(first.id).pinned).toBe(true);
      await expect(sidebar.locator('.conversation-list .thread-link').first()).toHaveAttribute(
        'aria-label',
        'Groceries',
      );
      await expect(sidebar.getByRole('button', { name: 'Main chat', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await options('Travel');
      await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
      await expect.poll(() => !!thread(second.id).unreadMarker).toBe(true);
      await expect(
        sidebar
          .getByRole('button', { name: 'Travel', exact: true })
          .getByRole('img', { name: 'Unread updates', exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(composer).toHaveValue('Keep my main thought');
      await openList();
      await expect(sidebar.locator('.conversation-list .thread-link').first()).toHaveAttribute(
        'aria-label',
        'Groceries',
      );
      await expect(
        sidebar
          .getByRole('button', { name: 'Travel', exact: true })
          .getByRole('img', { name: 'Unread updates', exact: true }),
      ).toBeVisible();
      // The menu does not change selection; keyboard Escape returns to its trigger.
      const trigger = page.getByRole('button', { name: 'Options for Travel', exact: true });
      await trigger.focus();
      await trigger.press('ArrowDown');
      await expect(
        page.getByRole('menuitem', { name: 'Pin conversation', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Mark as read', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(page.getByRole('menu')).toHaveCount(0);
      // Number shortcuts follow the visible pinned order, and a hidden list closes its menu.
      await options('Travel');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+2' : 'Control+2');
      await expect(page.getByRole('menu')).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe(`#chat/${first.id}`);
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main thought');
      await openList();
      await sidebar.getByRole('button', { name: 'Travel', exact: true }).click();
      await expect.poll(() => !!thread(second.id).unreadMarker).toBe(false);
      await composer.fill('Keep my travel thought');
      await page.getByRole('button', { name: 'Conversation options', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
      await expect.poll(() => !!thread(second.id).unreadMarker).toBe(true);
      if (!mac) {
        const otherContext = await browser.newContext({ locale: 'en-US' });
        try {
          const other = await otherContext.newPage();
          await other.goto(fixture.url);
          await other.getByRole('button', { name: 'Show chats', exact: true }).click();
          await expect(other.locator('.conversation-list .thread-link').first()).toHaveAttribute(
            'aria-label',
            'Groceries',
          );
          await expect(
            other
              .getByRole('button', { name: 'Travel', exact: true })
              .getByRole('img', { name: 'Unread updates', exact: true }),
          ).toBeVisible();
        } finally {
          await otherContext.close();
        }
        await page.bringToFront();
      }
      // Focus changes and unrelated fresh activity cannot clear an explicit reminder.
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      fixture.store.mutate((s) =>
        s.messages.push({
          id: 'elsewhere-update',
          threadId: first.id,
          role: 'assistant',
          text: 'A separate update',
          createdAt: new Date().toISOString(),
        }),
      );
      await expect.poll(() => !!thread(second.id).unreadMarker).toBe(true);
      await openList();
      await options('Travel');
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      const box = await page.getByRole('menu').boundingBox(),
        vp = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
      if (!mac) {
        const previousViewport = page.viewportSize();
        await page.setViewportSize({ width: previousViewport.width, height: 600 });
        await expect(page.getByRole('menu')).toBeVisible();
        await expect
          .poll(async () => {
            const rect = await page.getByRole('menu').boundingBox();
            return rect.y + rect.height <= 600;
          })
          .toBe(true);
        await page.setViewportSize(previousViewport);
        await expect(page.getByRole('menu')).toBeVisible();
      }
      await page.screenshot({ path: join(evidence, `chat-list-${surface}.png`) });
      await page.getByRole('menuitem', { name: 'Mark as read', exact: true }).click();
      await expect.poll(() => !!thread(second.id).unreadMarker).toBe(false);
      await options('Groceries');
      await page.getByRole('menuitem', { name: 'Unpin conversation', exact: true }).click();
      await expect(sidebar.locator('.conversation-list .thread-link').first()).toHaveAttribute(
        'aria-label',
        'Travel',
      );
      await options('Garden');
      await page.getByRole('menuitem', { name: 'Pin conversation', exact: true }).click();
      await expect
        .poll(() => fixture.store.read().assistants.find((a) => a.id === specialist.id).pinned)
        .toBe(true);
      // Archive from the list preserves drafts and restores the same conversation.
      await options('Travel');
      await page.getByRole('menuitem', { name: 'Archive conversation', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main thought');
      await openList();
      await page.getByRole('button', { name: 'Show archived side chats', exact: true }).click();
      await page.getByRole('button', { name: 'Restore Travel', exact: true }).click();
      await expect(composer).toHaveValue('Keep my travel thought');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main thought');
      const final = fixture.store.read();
      expect(final.messages.filter((m) => m.id !== 'elsewhere-update')).toEqual(baseline.messages);
      for (const key of ['runs', 'approvals', 'notifications', 'profile'])
        expect(final[key]).toEqual(baseline[key]);
      expect(fixture.requests).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      fixture.store.mutate((state) => {
        state.profile.theme = 'dark';
      });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await openList();
      await sidebar.getByRole('button', { name: 'Travel', exact: true }).click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      await page.screenshot({ path: join(evidence, `chat-list-dark-${surface}.png`) });
      await page.keyboard.press('Escape');
      checks.push({
        surface,
        passed: true,
        pins: true,
        readReminders: true,
        persisted: true,
        readOnReopen: true,
        draftsPreserved: true,
        noModelRequests: true,
        keyboardAndAccessibility: true,
      });
      console.log(
        `PASS ${surface}: pins, read reminders, keyboard menu, archive/restore and retained drafts`,
      );
    } catch (e) {
      await page
        ?.screenshot({ path: join(evidence, `chat-list-failure-${surface}.png`) })
        .catch(() => {});
      throw e;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `chat-list-${mac ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits: 'Isolated HTTP/SQLite workspace. No live model/account or Android runtime claim.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
