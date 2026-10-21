// SPDX-License-Identifier: MIT
// Verifies PDF reading/filling workers inside the packaged app's own backend.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { pdfFieldValue } from '../shared/pdf.mjs';
import { pdfFormsFixture, pdfFormRequest } from './pdf-forms-fixture.mjs';
import { pdfFormValues } from './pdf-form-document.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-forms-local-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await pdfFormsFixture(join(directory, 'fixture'));
let app;
try {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${join(directory, 'desktop')}`, '--relay-local-port=0'],
    env: {
      ...process.env,
      RELAY_DESKTOP_ENV: '',
      RELAY_MODE: 'live',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: f.provider.publicState().connections[0].baseUrl,
      RELAY_MODEL_ID: 'assistant-test',
      RELAY_MODEL_API_KEY: '',
      RELAY_MODEL_PROTOCOL: 'chat',
      RELAY_TRANSCRIPTION_BASE_URL: '',
      RELAY_TRANSCRIPTION_MODEL: '',
      RELAY_TRANSCRIPTION_API_KEY: '',
      RELAY_SPEECH_BASE_URL: '',
      RELAY_SPEECH_MODEL: '',
      RELAY_SPEECH_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
    },
  });
  const page = await app.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  await composer.fill(pdfFormRequest);
  await page
    .locator('.composer input[type=file]')
    .setInputFiles({ name: f.file.name, mimeType: 'application/pdf', buffer: f.bytes });
  await expect(page.getByRole('group', { name: 'Draft attachments', exact: true })).toContainText(
    f.file.name,
  );
  const before = await page.evaluate(async () => (await fetch('/api/state')).json());
  const saved = before.files.find((file) => file.name === f.file.name);
  assert(saved);
  f.file.id = saved.id;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByText('Your filled form is ready. I kept the original and its reference.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 40000 });
  const after = await page.evaluate(async () => (await fetch('/api/state')).json());
  assert.deepEqual(f.errors, []);
  assert.equal(after.messages.length, before.messages.length + 2);
  assert.equal(after.files.length, before.files.length + 1);
  assert.equal(after.tasks.length, before.tasks.length);
  assert.equal(after.approvals.length, before.approvals.length);
  assert.equal(after.files.find((file) => file.id === saved.id).base64, f.bytes.toString('base64'));
  const filled = after.files.find((file) => file.pdfForm?.sourceId === saved.id);
  assert(filled);
  const bytes = Buffer.from(filled.base64, 'base64'),
    pdf = await PDFDocument.load(bytes);
  for (const field of pdfFormValues)
    assert.deepEqual(
      pdfFieldValue(pdf.getForm().getField(field.name)),
      field.name === 'snack' ? [field.value] : field.value,
    );
  assert.equal(pdf.getForm().getTextField('reference').getText(), 'SOURCE-KEEP-42');
  await writeFile(join(evidence, 'pdf-forms-local-mac.pdf'), bytes);
  const card = page.getByRole('button').filter({ hasText: filled.name });
  await card.click();
  await expect(page.getByLabel(`${filled.name}, page 1`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next PDF page', exact: true }).click();
  await expect(page.getByLabel(`${filled.name}, page 2`, { exact: true })).toBeVisible();
  await expect(page.getByText('Rendering document…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, 'pdf-forms-local-mac.png') });
  const target = join(evidence, 'pdf-forms-local-mac-download.pdf');
  await app.evaluate(({ app, BrowserWindow }, target) => {
    app.pdfFormDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(target);
      item.once('done', (_e, state) => {
        app.pdfFormDownload = state;
      });
    });
  }, target);
  await page.getByRole('link', { name: 'Download', exact: true }).click();
  await expect.poll(() => app.evaluate(({ app }) => app.pdfFormDownload)).toBe('completed');
  assert.deepEqual(await readFile(target), bytes);
  const receipt = {
    passed: true,
    checkedAt: new Date().toISOString(),
    checks: [
      'Own packaged backend loads PDF read/fill workers from app archive',
      'Original upload and unmentioned value retained; exact filled field values',
      'One chat request produces one copy without another task or approval',
      'Both packaged PDF pages render and exact saved bytes download',
    ],
    scope:
      'Apple silicon unsigned packaged app; controlled model with real local backend, worker, database and file tools.',
  };
  await writeFile(join(evidence, 'pdf-forms-local-mac.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await app?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
