// SPDX-License-Identifier: MIT
// Plain chat -> actual local model -> isolated office tools -> verified exported bytes.
// Requires existing dedicated weights and an explicitly selected test Docker engine.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Footer,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
} from 'docx';
import JSZip from 'jszip';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { readPdf } from '../server/pdf-reader.mjs';
import { command } from '../shared/domain.mjs';
const model = process.env.RELAY_COMPUTER_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const dockerHost = process.env.RELAY_COMPUTER_TEST_DOCKER_HOST;
assert(
  model && modelsDirectory && dockerHost?.startsWith('unix:///'),
  'Choose installed test weights and a dedicated local Docker engine.',
);
const mac = process.argv.includes('--mac');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-office-live',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-office-live-'));
let f, computer, browser, page;
const requests = [],
  responses = [],
  captures = [],
  checks = [];
const check = (s) => {
  checks.push(s);
  console.log('PASS', s);
};
const report = {
  passed: false,
  model,
  surface: mac ? 'mac' : 'desktop-browser',
  checks,
  turns: [],
};
const marker = `CEDAR-${randomInt(10000, 99999)}`;
const hash = (b) => createHash('sha256').update(b).digest('hex');
try {
  f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  computer = new PrivateComputer(f.store, { deployment: directory });
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment: { DOCKER_HOST: dockerHost },
  });
  setup.start();
  await setup.pending;
  assert.equal(setup.status().phase, 'ready', setup.status().error);
  await computer.start();
  f.worker.services.computer = computer;
  f.worker.services.computerSetup = setup;
  const original = await Packer.toBuffer(
    new Document({
      sections: [
        {
          footers: {
            default: new Footer({
              children: [new Paragraph('Internal planning copy · ' + marker)],
            }),
          },
          children: [
            new Paragraph({ text: 'Team meeting plan', heading: HeadingLevel.TITLE }),
            new Paragraph({
              children: [new TextRun({ text: 'Meeting time: ', bold: true }), new TextRun('09:00')],
            }),
            new Paragraph('Location: Cedar room. Bring the printed agenda.'),
            new Table({
              rows: [
                ['Item', 'Owner'],
                ['Roadmap review', 'Morgan'],
                ['Open questions', 'Sam'],
              ].map(
                (row) =>
                  new TableRow({
                    children: row.map((text) => new TableCell({ children: [new Paragraph(text)] })),
                  }),
              ),
            }),
          ],
        },
      ],
    }),
  );
  const put = (path, bytes) =>
    computer.perform({
      kind: 'files',
      action: 'write',
      operationId: 'seed-' + hash(Buffer.from(path)),
      path,
      base64: Buffer.from(bytes).toString('base64'),
    });
  await put('Meeting Plan.docx', original);
  report.originalSha256 = hash(original);
  report.image = computer.image;
  const transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    const completion = url.endsWith('/chat/completions'),
      index = requests.length;
    if (completion) requests.push(JSON.parse(init.body));
    const response = await transport(url, init);
    if (completion)
      captures.push(
        response
          .clone()
          .text()
          .then((body) => {
            responses[index] = { status: response.status, body };
          })
          .catch((error) => {
            responses[index] = { error: String(error) };
          }),
      );
    return response;
  };
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    model,
    apiKey: '',
    replyMode: 'quick',
  });
  f.store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  if (mac) {
    await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
    browser = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${directory}`],
    });
    page = await browser.firstWindow();
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
    await page.goto(f.url + '/#chat');
  }
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  async function send(prompt) {
    const count = f.store.read().runs.length,
      start = Date.now();
    await composer.fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => f.store.read().runs.length, { timeout: 10000 }).toBe(count + 1);
    await expect
      .poll(
        () =>
          ['completed', 'failed', 'cancelled', 'waiting'].includes(
            f.store.read().runs.at(-1)?.status,
          ),
        { timeout: 600000 },
      )
      .toBe(true);
    const state = f.store.read(),
      run = state.runs.at(-1),
      reply = state.messages.findLast((m) => m.role === 'assistant' && !m.streaming)?.text;
    const turn = {
      prompt,
      runId: run.id,
      status: run.status,
      reply,
      elapsedMs: Date.now() - start,
    };
    report.turns.push(turn);
    console.log(JSON.stringify(turn));
    return { state, run, reply };
  }
  const edited = await send(
    'On your computer, update Meeting Plan.docx: change the meeting time from 09:00 to 10:30. Keep its design and all other text. Leave the original file untouched, and attach the updated Word document and a PDF here.',
  );
  assert.equal(edited.run.status, 'completed', JSON.stringify(edited.run));
  const doc = edited.state.files.find((file) => /\.docx$/i.test(file.name)),
    pdf = edited.state.files.find((file) => /\.pdf$/i.test(file.name));
  assert(doc && pdf, 'Both actual Word and PDF files are required, not completion prose.');
  const zip = await JSZip.loadAsync(Buffer.from(doc.base64, 'base64'));
  const text = await zip.file('word/document.xml').async('string');
  assert.match(text, /10:30/);
  assert.doesNotMatch(text, /09:00/);
  for (const value of [
    'Team meeting plan',
    'Location: Cedar room. Bring the printed agenda.',
    'Roadmap review',
    'Morgan',
    'Open questions',
    'Sam',
  ])
    assert(text.includes(value), value);
  assert.match(text, /<w:tbl[ >]/);
  assert.match(text, /<w:b[ />]/);
  const footer = Object.keys(zip.files).find((path) => /^word\/footer\d+\.xml$/.test(path));
  assert(footer);
  assert((await zip.file(footer).async('string')).includes(marker));
  assert.equal(
    hash(Buffer.from((await computer.read('Meeting Plan.docx')).base64, 'base64')),
    hash(original),
  );
  const parsed = await readPdf(pdf);
  const pdfText = JSON.stringify(parsed);
  assert.match(pdfText, /10:30/);
  assert.doesNotMatch(pdfText, /09:00/);
  assert(pdfText.includes(marker));
  assert(pdfText.includes('Morgan'));
  await writeFile(join(evidence, 'edited.docx'), Buffer.from(doc.base64, 'base64'));
  await writeFile(join(evidence, 'edited.pdf'), Buffer.from(pdf.base64, 'base64'));
  report.delivered = [doc, pdf].map((file) => ({
    name: file.name,
    mime: file.mime,
    sha256: hash(Buffer.from(file.base64, 'base64')),
  }));
  check(
    'One ordinary chat request edits the real DOCX, preserves content/table/footer/style and original bytes, and delivers an independently parsed PDF',
  );
  await composer.fill('Keep my next thought.');
  await page.screenshot({ path: join(evidence, 'delivered-chat.png') });
  await page
    .locator('.messages')
    .getByRole('button', { name: new RegExp(pdf.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .last()
    .click();
  await expect(page.getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'pdf-preview.png') });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(composer).toHaveValue('Keep my next thought.');
  check('The delivered PDF opens from chat on its own page and preserves the composer draft');
  await put('Broken.docx', Buffer.from([0, 255, 12, 9, 177, 0, 66, 0, 255]));
  const fileIds = f.store.read().files.map((file) => file.id);
  const failed = await send('Convert Broken.docx on your computer into a PDF and attach it here.');
  assert.deepEqual(
    f.store.read().files.map((file) => file.id),
    fileIds,
    'An unreadable document must not yield invented substitute content.',
  );
  assert.match(
    failed.reply || '',
    /corrupt|invalid|unreadable|cannot|couldn.t|unable|failed|problem|not.*valid|can.t/i,
  );
  assert.doesNotMatch(
    failed.reply || '',
    /\b(?:successfully converted|here(?:’s| is) (?:your|the) pdf|pdf is ready)\b/i,
  );
  check(
    'A real malformed document produces an honest failure or request for a replacement, with no invented output file',
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  if (f) {
    report.runs = f.store.read().runs;
    report.messages = f.store.read().messages;
    report.files = f.store.read().files.map(({ base64, ...file }) => file);
  }
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await f?.worker.stop();
  await Promise.allSettled(captures);
  report.checkedAt = new Date().toISOString();
  report.receipts = computer?.receipts();
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2));
  await writeFile(
    join(evidence, 'transport.json'),
    JSON.stringify({ requests, responses }, null, 2),
  );
  await browser?.close();
  if (computer) {
    await computer.stop().catch(() => {});
    await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]).catch(() => {});
    await computer
      .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
      .catch(() => {});
  }
  await f?.close();
  await rm(directory, { recursive: true, force: true });
}
