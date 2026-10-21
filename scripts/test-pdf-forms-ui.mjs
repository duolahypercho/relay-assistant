// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { pdfFieldValue } from '../shared/pdf.mjs';
import { pdfFormValues } from './pdf-form-document.mjs';
import { pdfFormsFixture, attachPdfForm, pdfFormRequest } from './pdf-forms-fixture.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const mac = process.argv.includes('--mac'),
  live = process.argv.includes('--live');
assert(!(mac && live), 'Choose the controlled Mac or real-model browser journey.');
const expect = baseExpect.configure({ timeout: live ? 240000 : 30000 });
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of mac ? [false] : live ? [true] : [false, true]) {
    const label = mac ? 'mac' : live ? 'live' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-pdf-forms-'));
    let f, context, page, app;
    const captures = [];
    try {
      if (live) {
        const model = process.env.RELAY_PDF_FORM_TEST_MODEL,
          modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
        assert(
          model && modelsDirectory,
          'Select an installed test model and separate model cache.',
        );
        f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
        await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
        f.provider.save({
          preset: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          protocol: 'chat',
          model,
          apiKey: '',
          activate: true,
        });
        Object.assign(f, await attachPdfForm(f.store));
        const transport = f.provider.fetcher;
        f.requests = [];
        f.provider.fetcher = async (url, init) => {
          if (url.endsWith('/chat/completions')) f.requests.push(JSON.parse(init.body));
          const response = await transport(url, init);
          if (url.endsWith('/chat/completions')) captures.push(response.clone().text());
          return response;
        };
      } else f = await pdfFormsFixture(directory);
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
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText(f.file.name);
      const started = performance.now();
      await composer.fill(pdfFormRequest);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect
        .poll(() => ['completed', 'failed'].includes(f.store.read().runs[0]?.status))
        .toBe(true);
      const state = f.store.read();
      assert.equal(state.runs[0].status, 'completed', JSON.stringify(state.runs[0]));
      assert.equal(state.files.length, 2, JSON.stringify(state.messages));
      assert.equal(state.tasks.length, 0);
      assert.equal(state.approvals.length, 0);
      const output = state.files.find((file) => file.id !== f.file.id),
        bytes = Buffer.from(output.base64, 'base64');
      const pdf = await PDFDocument.load(bytes);
      for (const field of pdfFormValues)
        assert.deepEqual(
          pdfFieldValue(pdf.getForm().getField(field.name)),
          field.name === 'snack' ? [field.value] : field.value,
        );
      assert.equal(pdf.getForm().getTextField('reference').getText(), 'SOURCE-KEEP-42');
      assert.deepEqual(
        Buffer.from(state.files.find((file) => file.id === f.file.id).base64, 'base64'),
        f.bytes,
      );
      await expect(page.getByRole('region', { name: 'File preview', exact: true })).toHaveCount(0);
      await composer.fill('Keep my next thought');
      await page.screenshot({ path: join(evidence, `pdf-forms-chat-${label}.png`) });
      await page
        .getByRole('button', { name: output.name + ' Saved to your files', exact: true })
        .click();
      const preview = page.getByRole('region', { name: 'File preview', exact: true });
      await expect(preview.getByText('Page 1 of 2', { exact: true })).toBeVisible();
      await expect(preview.getByText('Rendering document…', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: join(evidence, `pdf-forms-preview-${label}-1.png`) });
      await preview.getByRole('button', { name: 'Next PDF page', exact: true }).click();
      await expect(preview.getByText('Page 2 of 2', { exact: true })).toBeVisible();
      await expect(preview.getByText('Rendering document…', { exact: true })).toHaveCount(0);
      const path = join(evidence, `pdf-forms-${label}.pdf`);
      if (mac) {
        await app.evaluate(({ app, BrowserWindow }, target) => {
          app.pdfFormDownload = null;
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => {
              item.setSavePath(target);
              item.once('done', (_e, state) => {
                app.pdfFormDownload = state;
              });
            },
          );
        }, path);
        await preview.getByRole('link', { name: 'Download', exact: true }).click();
        await expect.poll(() => app.evaluate(({ app }) => app.pdfFormDownload)).toBe('completed');
      } else {
        const downloading = page.waitForEvent('download');
        await preview.getByRole('link', { name: 'Download', exact: true }).click();
        const download = await downloading;
        assert.equal(await download.failure(), null);
        await download.saveAs(path);
      }
      assert.deepEqual(await readFile(path), bytes);
      assert.deepEqual(
        (
          await new AxeBuilder({ page })
            .setLegacyMode(mac)
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
        [],
      );
      await page.screenshot({ path: join(evidence, `pdf-forms-preview-${label}-2.png`) });
      await preview.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.reload();
      await expect(composer).toHaveValue('Keep my next thought');
      assert.equal(f.store.read().messages.length, 2);
      assert.deepEqual(errors, []);
      assert.deepEqual(f.errors || [], []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      checks.push({
        surface: label,
        passed: true,
        model: live ? f.provider.current.model : 'Controlled HTTP fixture',
        elapsedMs: Math.round(performance.now() - started),
        calls: f.requests.length,
        checks: [
          'Original attachment to filled copy through normal chat without a task or repeated form',
          'Exact two-page text, checkbox, radio, dropdown and multiselect values',
          'Unchanged source and unmentioned field',
          'Actual PDF canvas, exact download, zero Axe violations and viewport fit',
          'Draft/reload retained; no extra messages for navigation',
        ],
      });
      console.log('PASS form completion', label);
    } catch (error) {
      await writeFile(
        join(evidence, `pdf-forms-${label}-failure.json`),
        JSON.stringify({ passed: false, error: error.stack, state: f?.store.read() }, null, 2),
      );
      throw error;
    } finally {
      if (live)
        await writeFile(
          join(evidence, 'pdf-forms-live-transport.json'),
          JSON.stringify(
            { requests: f?.requests, responses: await Promise.all(captures) },
            null,
            2,
          ),
        );
      await app?.close();
      await context?.close();
      await f?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `pdf-forms-${live ? 'live' : mac ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        scope: live
          ? 'One actual local-model form workflow; not general model-quality or physical-device certification.'
          : 'Controlled model, production PDF tools and database, real browser/Mac preview/download.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
