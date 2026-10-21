// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askFileFixture } from './ask-file-fixture.mjs';
import { filePreviewHash } from '../shared/file-navigation.mjs';
const mac = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const width of mac ? [1200] : [1365, 390, 320]) {
    const surface = mac ? 'mac' : String(width);
    const directory = await mkdtemp(join(tmpdir(), 'relay-file-pages-'));
    const f = await askFileFixture(directory);
    let app, context, page;
    try {
      if (mac) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        context = await browser.newContext({
          viewport: { width, height: width < 500 ? 844 : 950 },
          isMobile: width < 500,
          hasTouch: width < 500,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const preview = page.getByRole('region', { name: 'File preview', exact: true });
      await composer.fill('Keep my main thought');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      const thread = f.store.read().threads.find((t) => t.id !== 'main');
      assert(thread);
      await composer.fill('Tell me about my saved plan.');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.locator('.file-tile').filter({ hasText: 'Weekend plans.txt' }).click();
      const link = f.url + '/' + filePreviewHash(f.files[0].id, thread.id);
      await expect(page).toHaveURL(link);
      await expect(
        preview.getByRole('heading', { name: 'Weekend plans.txt', exact: true }),
      ).toBeFocused();
      await expect(preview).toContainText('Meet at noon. Bring a book.');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(f.url + '/#files');
      await expect(
        page.locator('.file-tile').filter({ hasText: 'Weekend plans.txt' }),
      ).toBeVisible();
      await page.goForward();
      await expect(preview).toBeVisible();
      await page.evaluate(() => sessionStorage.removeItem('relay-selected-thread'));
      await page.reload();
      await expect(preview).toContainText('Meet at noon. Bring a book.');
      await expect(page).toHaveURL(link);
      assert.deepEqual(
        (
          await new AxeBuilder({ page })
            .setLegacyMode(mac)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(evidence, `file-page-${surface}.png`) });
      await preview.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Tell me about my saved plan.');
      assert.equal(f.store.read().messages.length, 0);
      assert.equal(f.requests.length, 0);
      await page.goto(link);
      await preview.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(composer).toBeFocused();
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('Weekend plans.txt');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page
          .locator('.chat-workspace')
          .getByText('Your saved plan says to meet at noon and bring a book.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      assert.equal(f.store.read().messages.length, 2);
      assert.deepEqual(f.errors, []);
      await composer.fill('Keep my next thought');
      await page.goto(f.url + '/' + filePreviewHash('missing-file', thread.id));
      await expect(preview).toContainText('This file is no longer in your workspace.');
      await preview.getByRole('button', { name: 'All files', exact: true }).click();
      await page.locator('.file-tile').filter({ hasText: 'Saved note 1.txt' }).click();
      await preview.getByRole('button', { name: 'Remove file', exact: true }).click();
      await preview.getByRole('button', { name: 'Keep it', exact: true }).click();
      assert.equal(f.store.read().files.length, 9);
      await preview.getByRole('button', { name: 'Edit text', exact: true }).click();
      await preview
        .getByRole('textbox', { name: 'File text', exact: true })
        .fill('Saved through the dedicated page');
      await preview.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(preview.getByText('Unsaved changes', { exact: true })).toBeVisible();
      await expect(
        preview.getByText('Saved through the dedicated page', { exact: true }),
      ).toBeVisible();
      await expect(
        preview.getByRole('button', { name: 'Ask about this', exact: true }),
      ).toHaveCount(0);
      await preview.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(
        preview.getByText('Saved through the dedicated page', { exact: true }),
      ).toBeVisible();
      const target = join(directory, 'saved-note.txt');
      if (mac) {
        await app.evaluate(({ app, BrowserWindow }, target) => {
          app.fileDownload = null;
          BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
            item.setSavePath(target);
            item.once('done', (_e, state) => (app.fileDownload = state));
          });
        }, target);
        await preview.getByRole('link', { name: 'Download', exact: true }).click();
        await expect.poll(() => app.evaluate(({ app }) => app.fileDownload)).toBe('completed');
      } else {
        const pending = page.waitForEvent('download');
        await preview.getByRole('link', { name: 'Download', exact: true }).click();
        await (await pending).saveAs(target);
      }
      assert.equal(await readFile(target, 'utf8'), 'Saved through the dedicated page');
      await preview.getByRole('button', { name: 'Remove file', exact: true }).click();
      await preview.getByRole('button', { name: 'Remove file', exact: true }).click();
      await expect(page).toHaveURL(f.url + '/#files');
      assert.equal(f.store.read().files.length, 8);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main thought');
      assert.equal(f.store.read().messages.length, 2);
      assert.deepEqual(errors, []);
      checks.push({
        surface,
        passed: true,
        checks: [
          'Dedicated preview with no dialog; browser Back/Forward and reload',
          'Deep link keeps originating side chat and separate main draft',
          'Navigation sends nothing; Ask about this sends one real file read after explicit Send',
          'Edit and exact download, inline delete/cancel, missing-file recovery',
          'No page errors, Axe violations or horizontal overflow',
        ],
      });
      console.log('PASS file pages', surface);
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `file-pages-${mac ? 'mac' : 'ui'}.json`),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks }, null, 2),
  );
} finally {
  await browser?.close();
}
