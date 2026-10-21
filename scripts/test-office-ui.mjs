// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { officeFixture } from './office-fixture.mjs';
import { renderArtifact } from '../server/artifacts.mjs';
import { command } from '../shared/domain.mjs';
import { readOffice } from '../server/office-files.mjs';
const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-office-ui-'));
    const fixture = await officeFixture(directory);
    let app, context, page;
    try {
      if (native) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: fixture.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
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
      for (const [kind, source] of Object.entries(fixture.sources)) {
        const before = fixture.store.read().messages.length;
        await composer.fill(
          `Please revise this ${kind}: change tea to 9 and keep the other details.`,
        );
        await page.locator('.composer input[type=file]').setInputFiles(source);
        await page
          .locator('.composer')
          .getByRole('button', { name: `Open ${source.name}`, exact: true })
          .click();
        const dialog = page.getByRole('region', { name: 'File preview', exact: true });
        const preview = dialog.getByRole('region', { name: 'Office file text preview' });
        await expect(preview.locator('pre')).toContainText('Tea');
        await expect(preview.locator('pre')).toContainText('8');
        if (kind === 'spreadsheet')
          await expect(preview.locator('pre')).toContainText('saved result: 33');
        if (kind === 'presentation')
          await expect(preview.locator('pre')).toContainText('Speaker notes');
        expect(fixture.store.read().messages).toHaveLength(before);
        await page.screenshot({ path: join(evidence, `office-preview-${label}-${kind}.png`) });
        expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
          [],
        );
        // Exact original download remains available beside the extracted preview.
        if (!native) {
          const download = page.waitForEvent('download');
          await dialog.getByRole('link', { name: 'Download', exact: true }).click();
          const saved = await download;
          const path = await saved.path();
          expect(await readFile(path)).toEqual(source.buffer);
        }
        await dialog.getByRole('button', { name: 'Back to chat' }).click();
        await expect(composer).toHaveValue(
          `Please revise this ${kind}: change tea to 9 and keep the other details.`,
        );
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const card = page
          .locator('.messages')
          .getByRole('button', { name: new RegExp(`Revised ${kind}.*Version 1`) });
        await expect(card).toBeVisible({ timeout: 30000 });
        await card.click();
        const viewer = page.getByRole('article', { name: 'Result viewer' });
        await expect(viewer).toBeVisible();
        await expect(page.getByRole('region', { name: 'File preview', exact: true })).toHaveCount(
          0,
        );
        const state = fixture.store.read();
        const result = state.files.find(
          (f) => f.artifactId && f.name.startsWith(`Revised ${kind}`),
        );
        expect(result).toBeTruthy();
        expect((await readOffice(result)).text).toContain('9');
        if (kind === 'spreadsheet')
          expect((await readOffice(result)).text).toContain('saved result: 34');
        const original = state.files.find((f) => f.name === source.name);
        expect(Buffer.from(original.base64, 'base64')).toEqual(source.buffer);
        expect(state.messages).toHaveLength(before + 2);
        expect(fixture.errors).toEqual([]);
        await page.screenshot({ path: join(evidence, `office-revised-${label}-${kind}.png`) });
        await page
          .getByRole('navigation', { name: 'Workspace shortcuts' })
          .getByRole('button', { name: 'Main chat', exact: true })
          .click();
        checks.push(
          `${label}: ${kind} upload, accessible text preview, unchanged original and revised export through actual HTTP model/tool/worker loop`,
        );
      }
      await composer.fill('Keep this unfinished thought');
      const long = await renderArtifact({
        kind: 'document',
        title: 'Long source',
        source: 'Readable long source 你好 🌱.\n\n'.repeat(1000),
      });
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Long source.docx',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(long.bytes),
      });
      await page
        .locator('.composer')
        .getByRole('button', { name: 'Open Long source.docx', exact: true })
        .click();
      const preview = page.getByRole('region', { name: 'Office file text preview' });
      await expect(preview.getByRole('button', { name: 'Read more' })).toBeVisible();
      while (await preview.getByRole('button', { name: 'Read more' }).count()) {
        await preview.getByRole('button', { name: 'Read more' }).click();
        await expect(preview.getByRole('status')).toHaveCount(0);
      }
      expect(
        (await preview.locator('pre').textContent()).match(/Readable long source/g),
      ).toHaveLength(1000);
      await page.getByRole('button', { name: 'Back to chat' }).click();
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Broken.docx',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('not-an-office-file'),
      });
      await page
        .locator('.composer')
        .getByRole('button', { name: 'Open Broken.docx', exact: true })
        .click();
      await expect(preview.getByRole('alert')).toContainText('not a readable');
      await expect(
        page
          .getByRole('region', { name: 'File preview', exact: true })
          .getByRole('link', { name: 'Download', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat' }).click();
      await expect(composer).toHaveValue('Keep this unfinished thought');
      expect(fixture.store.read().messages).toHaveLength(6);
      expect(fixture.requests).toHaveLength(9);
      expect(fixture.readResults).toHaveLength(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push(
        `${label}: long text pagination, octet-stream file detection, damaged-file fallback and draft/history preservation`,
      );
      console.log(
        `PASS ${label}: all three Office formats, previews, native exports and original preservation`,
      );
    } catch (e) {
      await page
        ?.screenshot({ path: join(evidence, `office-failure-${label}.png`) })
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
    join(evidence, native ? 'office-native-mac-acceptance.json' : 'office-ui-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Controlled HTTP model; proves transport/tool/file flows, not hosted model judgment. Native Mac uses the packaged remote client. Office preview extracts text rather than original layout; no macros or formulas execute.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
