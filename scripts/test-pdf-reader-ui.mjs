// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pdfReaderFixture, pdfAnswer } from './pdf-reader-fixture.mjs';
const mac = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-pdf-reader-'));
    const f = await pdfReaderFixture(directory);
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
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true }),
        dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      await composer.fill('When is the visit, and what should I bring?');
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await page
        .locator('.file-tile')
        .filter({ has: page.getByText(f.file.name, { exact: true }) })
        .click();
      const dialog = page.getByRole('region', { name: 'File preview', exact: true });
      await expect(dialog.getByText('Page 1 of 3', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Rendering document…', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Next PDF page', exact: true }).click();
      await expect(dialog.getByText('Page 2 of 3', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Next PDF page', exact: true }).click();
      await expect(dialog.getByText('Page 3 of 3', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Rendering document…', { exact: true })).toHaveCount(0);
      await page.screenshot({
        path: join(evidence, `pdf-reader-preview-${surface}.png`),
        animations: 'disabled',
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await dialog.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(composer).toHaveValue('When is the visit, and what should I bring?');
      await page.reload();
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText(f.file.name);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.locator('.chat-workspace').getByText(pdfAnswer, { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await composer.fill('Keep my next thought.');
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought.');
      expect(f.reads).toHaveLength(1);
      expect(f.images).toHaveLength(1);
      expect(f.errors).toEqual([]);
      expect(errors).toEqual([]);
      expect(f.store.read().files).toHaveLength(1);
      expect(Buffer.from(f.store.read().files[0].base64, 'base64')).toEqual(f.bytes);
      expect(f.store.read().messages).toHaveLength(2);
      expect(
        f.store
          .read()
          .messages.at(-1)
          .cards.filter((card) => card.kind === 'file'),
      ).toHaveLength(1);
      await expect(page.locator('.rich-card').filter({ hasText: f.file.name })).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
        false,
      );
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: join(evidence, `pdf-reader-answer-${surface}.png`),
        animations: 'disabled',
      });
      checks.push({
        surface,
        passed: true,
        checks: [
          'actual PDF preview and scanned page',
          'Ask about this and reload preserve draft',
          'independent HTTP model reads page text and exact form value',
          'real rendered scanned-page pixels reach the model',
          'unchanged original, separate pages, accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: PDF text and scanned-page assistant reads`);
    } finally {
      await app?.close();
      if (!app) await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `pdf-reader-${mac ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Independent deterministic HTTP model, actual PDF decoder and page pixels; not live vision/OCR quality certification.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
