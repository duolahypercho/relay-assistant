// SPDX-License-Identifier: MIT
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { artifactExamples } from './artifacts-fixture.mjs';
const data = await mkdtemp(join(tmpdir(), 'relay-native-results-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const executable =
  process.env.RELAY_DESKTOP_EXECUTABLE ||
  resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay');
const env = {
  ...process.env,
  RELAY_MODE: 'sample',
  RELAY_ACCESS_KEY: '',
  RELAY_MODEL_BASE_URL: '',
  RELAY_MODEL_ID: '',
  RELAY_MODEL_API_KEY: '',
  RELAY_BROWSER_ENABLED: 'false',
  RELAY_DESKTOP_ENABLED: 'false',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};
delete env.RELAY_DESKTOP_ENV;
const launch = () =>
  electron.launch({
    executablePath: executable,
    args: [`--relay-test-data=${data}`, '--relay-local-port=0'],
    env,
    timeout: 40000,
  });
let application;
const checks = [];
try {
  application = await launch();
  let page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await application.evaluate(({ app, BrowserWindow }, directory) => {
    app.artifactDownloads = [];
    BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (_event, item) => {
      const name = item.getFilename();
      item.setSavePath(directory + '/' + name);
      item.once('done', (_e, state) => app.artifactDownloads.push({ name, state }));
    });
  }, evidence);
  const initialMessageCount = await page.evaluate(
    async () => (await (await fetch('/api/state')).json()).messages.length,
  );
  const origin = new URL(page.url()).origin;
  for (const kind of ['document', 'spreadsheet', 'presentation', 'web']) {
    const example = artifactExamples[kind];
    await page.goto(origin + '/#files/new');
    await page.getByLabel('Result type', { exact: true }).selectOption(kind);
    await page.getByLabel('Result title', { exact: true }).fill('Native ' + kind);
    if (kind === 'document')
      await page.getByLabel('Document text (Markdown)', { exact: true }).fill(example.source);
    if (kind === 'web')
      await page
        .getByLabel('Page source (HTML, CSS, JavaScript)', { exact: true })
        .fill(example.source);
    if (kind === 'presentation')
      await page.getByLabel('Speaker notes', { exact: true }).fill('Native speaker notes.');
    await page.getByRole('button', { name: 'Save result', exact: true }).click();
    await expect(page.getByLabel('Result version', { exact: true })).toHaveValue('1');
    if (kind === 'web') {
      const frame = page.frameLocator('iframe');
      await frame.getByRole('button', { name: 'Take a breath', exact: true }).click();
      await expect(frame.getByText('1 quiet moments', { exact: true })).toBeVisible();
    }
    const extension = { document: 'DOCX', spreadsheet: 'XLSX', presentation: 'PPTX', web: 'HTML' }[
      kind
    ];
    await page.getByRole('link', { name: 'Download ' + extension, exact: true }).click();
    await expect
      .poll(() => application.evaluate(({ app }) => app.artifactDownloads.length))
      .toBe(checks.length + 1);
    const saved = await application.evaluate(({ app }) => app.artifactDownloads.at(-1));
    assert.equal(saved.state, 'completed');
    assert.ok((await readFile(join(evidence, saved.name))).length > 300);
    checks.push({
      kind,
      passed: true,
      check: 'packaged Electron UI creates a real saved result and downloads its bytes',
      filename: saved.name,
    });
  }
  await page.screenshot({ path: join(evidence, 'artifacts-native-mac-web.png') });
  await application.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  for (const kind of ['document', 'spreadsheet', 'presentation', 'web'])
    await expect(page.getByRole('button', { name: new RegExp('Native ' + kind) })).toBeVisible();
  assert.equal(
    await page.evaluate(async () => (await (await fetch('/api/state')).json()).messages.length),
    initialMessageCount,
  );
  checks.push({
    passed: true,
    check: 'all four results survive complete packaged app restart without any chat messages',
  });
} finally {
  if (application) await application.close();
  await rm(data, { recursive: true, force: true });
  await writeFile(
    join(evidence, 'artifacts-native-mac.json'),
    JSON.stringify({ testedAt: new Date().toISOString(), executable, checks }, null, 2),
  );
}
console.log(`${checks.length} packaged Mac artifact checks passed.`);
