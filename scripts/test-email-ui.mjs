// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { emailFixture, emailBytes, enclosedBytes } from './email-fixture.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-email-')),
      f = await emailFixture(directory);
    let app, context, page;
    try {
      if (native) {
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
      const errors = [],
        outside = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        if (/^https?:/.test(r.url()) && !r.url().startsWith(f.url)) outside.push(r.url());
      });
      const composer = page.getByLabel('Message Relay', { exact: true }),
        draft = page.locator('.composer .draft-attachments'),
        dialog = page.getByRole('region', { name: 'File preview', exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Read this email and its budget.');
      await page
        .locator('.composer input[type=file]')
        .setInputFiles({ name: 'Weekend.eml', mimeType: '', buffer: f.source });
      await draft.getByRole('button', { name: 'Open Weekend.eml', exact: true }).click();
      await expect(
        dialog.getByRole('heading', { name: 'Weekend — plan', exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText('Café Team <team@example.invalid>', { exact: true }),
      ).toBeVisible();
      await expect(dialog.locator('.email-body')).toContainText('Meet at noon & bring a book.');
      expect(await dialog.locator('iframe, img, script').count()).toBe(0);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await dialog.getByRole('button', { name: 'Open attachment Budget.csv', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'Budget.csv', exact: true })).toBeVisible();
      await expect(dialog.locator('.email-body')).toContainText('Train,25');
      const copies = f.store.read().files.length;
      expect(copies).toBe(2);
      const downloads = dialog.getByRole('link', { name: 'Download Budget.csv', exact: true });
      let path;
      if (app) {
        path = join(directory, 'Budget.csv');
        await app.evaluate(({ app, BrowserWindow }, path) => {
          app.emailDownload = '';
          BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
            item.setSavePath(path);
            item.once('done', (_e, state) => (app.emailDownload = state));
          });
        }, path);
        await downloads.last().click();
        await expect.poll(() => app.evaluate(({ app }) => app.emailDownload)).toBe('completed');
      } else {
        const wait = page.waitForEvent('download');
        await downloads.last().click();
        path = await (await wait).path();
      }
      expect((await readFile(path)).equals(enclosedBytes)).toBe(true);
      await dialog.getByRole('button', { name: 'Back to email', exact: true }).click();
      await dialog.getByRole('button', { name: 'Open attachment Budget.csv', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'Budget.csv', exact: true })).toBeVisible();
      expect(f.store.read().files.length).toBe(copies);
      await dialog.getByRole('button', { name: 'Back to email', exact: true }).click();
      await page.screenshot({ path: join(evidence, `email-preview-${surface}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Read this email and its budget.');
      await page.reload();
      await draft.getByRole('button', { name: 'Open Weekend.eml', exact: true }).click();
      await expect(
        dialog.getByRole('heading', { name: 'Weekend — plan', exact: true }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('The email says noon. The attached budget lists train 25 and tea 8.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(f.errors).toEqual([]);
      expect(f.reads.length).toBe(3);
      expect(f.store.read().files.length).toBe(copies);
      expect(f.store.read().files.find((x) => x.name === 'Weekend.eml').base64).toBe(
        f.source.toString('base64'),
      );
      await composer.fill('Keep my next thought');
      const count = f.store.read().messages.length,
        requests = f.requests.length;
      await page
        .getByRole('navigation', { name: 'Workspace shortcuts' })
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought');
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Long.eml',
        mimeType: 'message/rfc822',
        buffer: emailBytes({ long: true }),
      });
      await draft.getByRole('button', { name: 'Open Long.eml', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: 'Read more of this email', exact: true }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Read more of this email', exact: true }).click();
      await expect(dialog.locator('.email-body')).toContainText('END OF EMAIL');
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Damaged.eml',
        mimeType: 'message/rfc822',
        buffer: Buffer.from('not an email'),
      });
      await draft.getByRole('button', { name: 'Open Damaged.eml', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('does not look like an email');
      await expect(dialog.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought');
      expect(f.store.read().messages).toHaveLength(count);
      expect(f.requests).toHaveLength(requests);
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'real EML upload/reload, international headers and inert HTML-only body',
          'inline enclosed-file preview and exact CSV download',
          'idempotent extraction, original EML unchanged',
          'worker/model email read, attachment import and content read',
          'long-body pagination and damaged-file recovery',
          'no remote tracking, preview-created chat messages or lost drafts',
          'accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: email preview, attachments, model reads and preserved drafts`);
    } catch (e) {
      if (page) await page.screenshot({ path: join(evidence, `email-failure-${surface}.png`) });
      throw e;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `email-${native ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Original MIME fixtures and independent controlled HTTP model with real Relay server/worker. No actual mail account or live model quality claim.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
