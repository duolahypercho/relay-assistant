// SPDX-License-Identifier: MIT
// Ordinary chat requests against an explicitly selected installed local model.
// No scripted model responses, injected artifacts, downloads or owner workspace writes.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';

const model = process.env.RELAY_ARTIFACT_TEST_MODEL;
const revisionOnly = process.argv.includes('--revision');
const native = process.argv.includes('--mac');
let app;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed test model and isolated weight directory.');
const directory = await mkdtemp(join(tmpdir(), 'relay-artifacts-live-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const requests = [],
  responses = [],
  captures = [],
  checks = [],
  errors = [];
const marker = 'WILLOW-' + randomInt(1000, 9999);
const transport = f.provider.fetcher;
f.provider.fetcher = async (url, init) => {
  const index = requests.length;
  const completion = url.endsWith('/chat/completions');
  if (completion) requests.push(JSON.parse(init.body));
  const response = await transport(url, init);
  if (completion)
    captures.push(
      response
        .clone()
        .text()
        .then((body) => {
          const frames = body
            .split('\n')
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6)));
          responses[index] = {
            status: response.status,
            contentType: response.headers.get('content-type'),
            finishReasons: frames
              .flatMap((frame) => frame.choices || [])
              .map((choice) => choice.finish_reason)
              .filter(Boolean),
            usage: frames.findLast((frame) => frame.usage)?.usage,
            body,
          };
        })
        .catch((error) => {
          responses[index] = { error: String(error) };
        }),
    );
  return response;
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const terminal = (s) => ['completed', 'failed', 'cancelled'].includes(s);
let desktop = native ? null : await browser.newPage({ viewport: { width: 1365, height: 950 } });
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
for (const page of [desktop, phone].filter(Boolean))
  page.on('pageerror', (e) => errors.push(e.message));
const composer = (page) => page.getByRole('textbox', { name: 'Message Relay', exact: true });

async function send(page, text) {
  const previous = f.store.read().runs.length;
  const started = performance.now();
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => f.store.read().runs.length, { timeout: 10000 }).toBe(previous + 1);
  await expect
    .poll(() => terminal(f.store.read().runs.at(-1)?.status), { timeout: 240000 })
    .toBe(true);
  const run = f.store.read().runs.at(-1);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const reply = f.store.read().messages.findLast((m) => m.role === 'assistant' && !m.streaming);
  assert.doesNotMatch(
    reply.text,
    /Saved result references:|(?:file|artifact)-[0-9a-f]{8}-/i,
    'A normal reply must not expose internal result IDs or context metadata.',
  );
  return {
    prompt: text,
    reply: reply.text,
    elapsedMs: Math.round(performance.now() - started),
    runId: run.id,
  };
}

async function openResult(page, kind, version) {
  const artifact = f.store.read().artifacts?.find((a) => a.kind === kind);
  assert(artifact, `Actual ${kind} artifact is required; a claim or text file is insufficient.`);
  version ??= artifact.versions.at(-1).number;
  const v = artifact.versions.find((v) => v.number === version);
  assert(v, `Expected saved version ${version}.`);
  const card = page.locator('.messages').getByRole('button', {
    name: new RegExp(v.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*Version ' + version),
  });
  await expect(card.last()).toBeVisible({ timeout: 10000 });
  await composer(page).fill('Keep this unfinished thought.');
  const messages = f.store.read().messages.length;
  await card.last().click();
  const viewer = page.getByRole('article', { name: 'Result viewer' });
  await expect(viewer).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const extension = { document: 'DOCX', spreadsheet: 'XLSX', presentation: 'PPTX', web: 'HTML' }[
    kind
  ];
  const path = join(evidence, `artifacts-live-${kind}-v${version}.${extension.toLowerCase()}`);
  const link = viewer.getByRole('link', { name: `Download ${extension}`, exact: true });
  if (native && page === desktop) {
    // Only automate the OS destination choice; retain the real download bytes.
    await app.evaluate(({ app, BrowserWindow }, path) => {
      app.artifactDownload = null;
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_event, state) => {
          app.artifactDownload = state;
        });
      });
    }, path);
    await link.click();
    await expect.poll(() => app.evaluate(({ app }) => app.artifactDownload)).toBe('completed');
  } else {
    const pending = page.waitForEvent('download');
    await link.click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    await download.saveAs(path);
  }
  const bytes = await readFile(path);
  const file = f.store.read().files.find((file) => file.id === v.fileId);
  assert.deepEqual(bytes, Buffer.from(file.base64, 'base64'));
  assert.equal(f.store.read().messages.length, messages);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  return { artifact, version: v, bytes, viewer, messages, path, sha256: digest(bytes) };
}

async function back(page, result) {
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(composer(page)).toHaveValue('Keep this unfinished thought.');
  assert.equal(f.store.read().messages.length, result.messages);
}

try {
  if (native) {
    const data = join(directory, 'desktop');
    await mkdir(data);
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
    app = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${data}`],
    });
    desktop = await app.firstWindow();
    desktop.on('pageerror', (e) => errors.push(e.message));
    await expect(composer(desktop)).toBeVisible();
  }
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model,
    apiKey: '',
    activate: true,
    ...(process.env.RELAY_ARTIFACT_REPLY_MODE
      ? { replyMode: process.env.RELAY_ARTIFACT_REPLY_MODE }
      : {}),
  });
  await Promise.all([desktop.goto(f.url + '/#chat'), phone.goto(f.url + '/#chat')]);
  let trial = await send(
    desktop,
    `Make a downloadable Word document titled Willow workshop. Include the reference ${marker}, location Willow library, start time 10:30 AM, and a packing list with a green notebook and a pencil. Keep it short.`,
  );
  let result = await openResult(desktop, 'document');
  const doc = await JSZip.loadAsync(result.bytes);
  const xml = await doc.file('word/document.xml').async('string');
  for (const fact of [marker, 'Willow library', '10:30', 'green notebook', 'pencil'])
    assert(xml.toLowerCase().includes(fact.toLowerCase()), `Missing document fact: ${fact}`);
  assert.match(xml, /Heading1/);
  assert.match(xml, /w:numPr/);
  const originalDocument = {
    source: result.version.source,
    sha256: result.sha256,
    id: result.artifact.id,
    fileId: result.version.fileId,
    version: result.version.number,
  };
  await desktop.screenshot({ path: join(evidence, 'artifacts-live-document.png') });
  await back(desktop, result);
  checks.push({ kind: 'document', passed: true, ...trial, exportSha256: result.sha256 });
  console.log('PASS live Word document');

  if (!revisionOnly) {
    trial = await send(
      phone,
      'Make a downloadable Excel budget titled Willow budget. Use two columns, Item and Amount. Include Train 27, Tea 8, Lunch 19, and a Total calculated with a formula.',
    );
    result = await openResult(phone, 'spreadsheet');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.bytes);
    const sheet = workbook.worksheets[0];
    for (const [label, value] of [
      ['Train', 27],
      ['Tea', 8],
      ['Lunch', 19],
    ]) {
      let found = false;
      sheet.eachRow((row) => {
        if (row.getCell(1).value === label) {
          assert.equal(row.getCell(2).value, value);
          found = true;
        }
      });
      assert(found, `Missing budget row: ${label}`);
    }
    let total;
    sheet.eachRow((row) => {
      if (/total/i.test(String(row.getCell(1).value))) total = row.getCell(2);
    });
    assert(total?.formula, 'Total must remain an editable Excel formula.');
    assert.equal(total.result, 54);
    await phone.screenshot({ path: join(evidence, 'artifacts-live-spreadsheet-phone.png') });
    await back(phone, result);
    checks.push({
      kind: 'spreadsheet',
      passed: true,
      ...trial,
      exportSha256: result.sha256,
      formula: total.formula,
      total: total.result,
    });
    console.log('PASS live Excel formulas');

    trial = await send(
      desktop,
      'Make a downloadable PowerPoint with exactly three slides for the Willow workshop: Welcome, What to bring, and Schedule. Include the meeting details from our document and speaker notes on every slide. Keep the bullets concise.',
    );
    result = await openResult(desktop, 'presentation');
    const slides = JSON.parse(result.version.source).slides;
    assert.equal(slides.length, 3);
    assert(slides.every((s) => s.notes.trim().length > 0));
    const pptx = await JSZip.loadAsync(result.bytes);
    assert.equal(
      Object.keys(pptx.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length,
      3,
    );
    for (let i = 1; i <= 3; i++)
      assert((await pptx.file(`ppt/notesSlides/notesSlide${i}.xml`).async('string')).length > 0);
    for (const fact of ['Willow library', '10:30', 'green notebook'])
      assert(
        result.version.source.toLowerCase().includes(fact.toLowerCase()),
        `Missing slide fact: ${fact}`,
      );
    await desktop.screenshot({ path: join(evidence, 'artifacts-live-presentation.png') });
    await back(desktop, result);
    checks.push({ kind: 'presentation', passed: true, ...trial, exportSha256: result.sha256 });
    console.log('PASS live PowerPoint and notes');

    trial = await send(
      phone,
      'Make a little interactive page titled Workshop counter. Show a count starting at 0, an Add one button that increases it by 1, and a Reset button that returns it to 0. Make it work offline and fit on my phone.',
    );
    result = await openResult(phone, 'web');
    const frame = phone.frameLocator('iframe[title$="interactive preview"]');
    const counter = (n) => frame.getByText(String(n), { exact: true });
    await expect(counter(0)).toBeVisible();
    await frame.getByRole('button', { name: /\bAdd one\b/i }).click();
    await frame.getByRole('button', { name: /\bAdd one\b/i }).click();
    await expect(counter(2)).toBeVisible();
    await frame.getByRole('button', { name: /\bReset\b/i }).click();
    await expect(counter(0)).toBeVisible();
    assert.equal(
      await frame
        .locator('html')
        .evaluate((el) => el.scrollWidth <= el.ownerDocument.defaultView.innerWidth),
      true,
      'The generated page itself must fit the phone preview without horizontal overflow.',
    );
    await phone.screenshot({ path: join(evidence, 'artifacts-live-interactive-phone.png') });
    await back(phone, result);
    checks.push({ kind: 'web', passed: true, ...trial, exportSha256: result.sha256 });
    console.log('PASS live interactive page');
  }

  const requestStart = requests.length;
  trial = await send(
    desktop,
    'Update the Willow workshop Word document we made: change only the start time to 11:15 AM. Keep the location, packing list and reference unchanged.',
  );
  result = await openResult(desktop, 'document', originalDocument.version + 1);
  assert.equal(result.artifact.id, originalDocument.id);
  assert.equal(
    result.artifact.versions.find((v) => v.number === originalDocument.version).source,
    originalDocument.source,
  );
  const oldFile = f.store
    .read()
    .files.find(
      (file) =>
        file.id ===
        result.artifact.versions.find((v) => v.number === originalDocument.version).fileId,
    );
  assert.equal(digest(Buffer.from(oldFile.base64, 'base64')), originalDocument.sha256);
  const revisedZip = await JSZip.loadAsync(result.bytes);
  const revisedXml = await revisedZip.file('word/document.xml').async('string');
  for (const fact of [marker, 'Willow library', '11:15', 'green notebook', 'pencil'])
    assert(revisedXml.toLowerCase().includes(fact.toLowerCase()), `Lost revised fact: ${fact}`);
  assert(!revisedXml.includes('10:30'));
  assert.equal(result.version.source, originalDocument.source.replace('10:30', '11:15'));
  const revisedCalls = requests
    .slice(requestStart)
    .flatMap((r) => r.messages.flatMap((m) => m.tool_calls || []));
  assert(
    revisedCalls.some((c) => {
      const parameters = JSON.parse(c.function.arguments);
      return (
        (c.function.name === 'read_artifact' && parameters.id === originalDocument.id) ||
        (c.function.name === 'read_file' && parameters.id === originalDocument.fileId)
      );
    }),
    'Model must read the existing source before revising.',
  );
  assert.equal(
    f.store.read().artifacts.length,
    revisionOnly ? 1 : 4,
    'Revision must not create a disconnected copy.',
  );
  await desktop.screenshot({ path: join(evidence, 'artifacts-live-revision.png') });
  await back(desktop, result);
  checks.push({ kind: 'revision', passed: true, ...trial, exportSha256: result.sha256 });
  console.log('PASS live revision keeps original');
  assert.deepEqual(errors, []);
  assert.equal(
    f.store.read().messages.filter((m) => m.role === 'user').length,
    revisionOnly ? 2 : 5,
  );
  await writeFile(
    join(evidence, 'artifacts-live-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        model,
        desktopSurface: native ? 'packaged Mac app with isolated backend' : 'desktop browser',
        scenarios: revisionOnly ? 'document and revision' : 'all four formats and revision',
        replyMode: f.provider.current.replyMode,
        checks,
        modelRequests: requests.length,
        scope:
          'Actual local inference through production worker/tools for the scenarios listed in checks. Exports are read back independently; no test artifact injection or forced tool choice. Phone/HTML checks run only in the full scenario. Mac mode connects the packaged client to the isolated backend and automates only the OS download destination. Physical/native mobile, hosted providers and broader generation quality are separate gates.',
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  await Promise.all(captures);
  await writeFile(
    join(evidence, 'artifacts-live-failure.json'),
    JSON.stringify(
      {
        passed: false,
        checkedAt: new Date().toISOString(),
        model,
        desktopSurface: native ? 'packaged Mac app with isolated backend' : 'desktop browser',
        replyMode: f.provider.current.replyMode,
        error: String(error),
        checks,
        errors,
        runs: f.store.read().runs,
        messages: f.store.read().messages,
        artifacts: f.store.read().artifacts,
        requests,
        responses,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await Promise.all(captures);
  await writeFile(
    join(evidence, 'artifacts-live-transport.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        model,
        requests,
        responses,
        scope:
          'Synthetic acceptance workspace only. Raw responses diagnose transport and model behavior; no owner credentials or conversations.',
      },
      null,
      2,
    ) + '\n',
  );
  await app?.close();
  await browser.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
