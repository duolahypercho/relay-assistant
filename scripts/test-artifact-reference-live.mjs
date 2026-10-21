// SPDX-License-Identifier: MIT
// Actual inference and exported DOCX bytes; recognized speech text, not audio capture.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import JSZip from 'jszip';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { fileBytes } from '../shared/pdf.mjs';
const model = process.env.RELAY_VOICE_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const replyMode = process.env.RELAY_VOICE_TEST_REPLY_MODE || 'quick';
assert(model && modelsDirectory && ['quick', 'default'].includes(replyMode));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/artifact-reference');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-artifact-reference-live-'));
const marker = 'FERN-' + randomInt(10000, 99999),
  mac = process.argv.includes('--mac');
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode,
  marker,
  scope:
    'Actual local inference, two consecutive same-document revisions, exact DOCX XML replacement, saved versions and renderer. Requests represent recognized speech; no audio, owner accounts or sending.',
  checks: [],
  requests: [],
};
let f, browser, app, page, artifactId, previousXml;
try {
  f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  f.store.mutate((s) => {
    s.profile.memoryLearning = false;
  });
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    protocol: 'chat',
    replyMode,
    apiKey: '',
    activate: true,
  });
  const fetcher = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) report.requests.push(JSON.parse(init.body));
    return fetcher(url, init);
  };
  if (mac) {
    const data = join(directory, 'desktop');
    await mkdir(data);
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
    app = await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${data}`],
    });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.hide()),
    );
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  }
  page.setDefaultTimeout(15000);
  await page.goto(f.url + '/#chat');
  const steps = [
    [
      'word-document',
      `Create a Word document titled Packing Checklist. Include trip reference ${marker}, departure time 10:30, and three bullet entries: Notebook, Charging cable, Blue folder. Attach the Word file and give a short spoken confirmation.`,
    ],
    [
      'word-revision',
      'Update that same Word document: replace Charging cable with USB-C charger. Keep its title, trip reference, departure time and all other content exactly. Attach the updated Word file.',
      'Charging cable',
      'USB-C charger',
    ],
    [
      'word-second-revision',
      'Update that same Word document: replace Blue folder with Green folder. Keep its title, trip reference, departure time and all other content exactly. Attach the updated Word file.',
      'Blue folder',
      'Green folder',
    ],
  ];
  for (const [index, [name, text, before, after]] of steps.entries()) {
    const started = performance.now(),
      requestIndex = report.requests.length;
    const run = f.store.mutate((s) => {
      const r = command(s, 'chat.send', { threadId: 'main', text });
      r.voiceCallId = 'synthetic-recognized-speech';
      return r;
    });
    await expect
      .poll(() => f.store.read().runs.find((r) => r.id === run.id)?.status, {
        timeout: 240000,
        intervals: [250, 1000],
      })
      .toMatch(/^(completed|failed|waiting)$/);
    const state = f.store.read(),
      finished = state.runs.find((r) => r.id === run.id);
    const answer = state.messages.findLast(
      (m) => m.role === 'assistant' && m.replyTo === run.messageId,
    );
    const check = {
      name,
      passed: false,
      status: finished.status,
      elapsedMs: Math.round(performance.now() - started),
      requestIndex,
      answer: answer?.text || '',
    };
    report.checks.push(check);
    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    assert.equal(state.artifacts.length, 1, 'Revisions must retain one result identity');
    const artifact = state.artifacts[0];
    artifactId ||= artifact.id;
    assert.equal(artifact.id, artifactId);
    assert.equal(artifact.kind, 'document');
    assert.equal(artifact.versions.length, index + 1);
    const version = artifact.versions.at(-1),
      file = state.files.find((v) => v.id === version.fileId);
    assert.equal(version.title, 'Packing Checklist');
    assert(file);
    assert(answer.cards.some((c) => c.kind === 'file' && c.id === file.id));
    const bytes = await fileBytes(file),
      zip = await JSZip.loadAsync(bytes),
      xml = await zip.file('word/document.xml').async('string');
    for (const value of [
      marker,
      '10:30',
      'Notebook',
      index ? 'USB-C charger' : 'Charging cable',
      index === 2 ? 'Green folder' : 'Blue folder',
    ])
      assert(xml.includes(value), value);
    if (index) {
      assert.equal(
        xml,
        previousXml.replace(before, after),
        'Only the requested content may change in Word XML',
      );
      assert(!xml.includes(before));
      const definitions = report.requests[requestIndex].tools.map((t) => t.function || t);
      for (const name of ['read_artifact', 'save_artifact'])
        assert.match(definitions.find((t) => t.name === name).description, /id "current"/);
    }
    previousXml = xml;
    const path = join(evidence, `packing-v${index + 1}.docx`);
    await writeFile(path, bytes);
    check.document = {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      version: version.number,
      artifactId,
      fileId: file.id,
      exactDocumentXmlReplacement: index > 0,
    };
    check.passed = true;
    await page.reload();
    await expect(page.locator('.message.assistant').last()).toBeVisible();
    await page.screenshot({ path: join(evidence, name + '.png'), timeout: 60000 });
    console.log(`CHECKPOINT ${name}: exact saved result and renderer verified`);
  }
  const calls = new Map();
  for (const request of report.requests)
    for (const message of request.messages)
      for (const call of message.tool_calls || [])
        calls.set(call.id, {
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments),
        });
  report.artifactCalls = [...calls.values()].filter((c) =>
    ['read_artifact', 'save_artifact'].includes(c.name),
  );
  // Normal exact IDs remain valid. Prove a successful read and save through
  // the new reference without demanding that every valid revision choose it.
  const receipts = new Map();
  for (const request of report.requests)
    for (const message of request.messages) {
      if (message.role !== 'tool') continue;
      const action = calls.get(message.tool_call_id);
      if (action?.arguments.id !== 'current') continue;
      let body;
      try {
        body = JSON.parse(message.content);
      } catch {
        continue;
      }
      if (body.result?.id !== artifactId || body.error) continue;
      receipts.set(message.tool_call_id, {
        name: action.name,
        version: body.result.version,
        revisionTarget: body.result.revisionTarget,
      });
    }
  report.referenceReceipts = [...receipts.values()];
  assert(
    report.referenceReceipts.some(
      (r) => r.name === 'read_artifact' && r.revisionTarget?.id === 'current',
    ),
    'The real model must successfully read through the bound reference',
  );
  assert(
    report.referenceReceipts.some((r) => r.name === 'save_artifact' && r.version > 1),
    'The real model must successfully save through the bound reference',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.message.assistant').last()).toBeVisible();
  await page.screenshot({ path: join(evidence, 'phone-revision.png'), timeout: 60000 });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  await page?.screenshot({ path: join(evidence, 'failure.png'), timeout: 60000 }).catch(() => {});
} finally {
  if (f)
    report.modelUsage = f.store.db
      .prepare(
        'SELECT status,started_at,finished_at,input_tokens,output_tokens,cached_tokens FROM model_usage ORDER BY started_at',
      )
      .all();
  const cleanup = [];
  for (const [name, close] of [
    ['app', () => app?.close()],
    ['browser', () => browser?.close()],
    ['fixture', () => f?.close()],
    ['temporary directory', () => rm(directory, { recursive: true, force: true })],
  ]) {
    try {
      await close();
    } catch (error) {
      cleanup.push({ name, error: error.message });
    }
  }
  report.cleanedUp = !cleanup.length;
  if (cleanup.length) {
    report.cleanupErrors = cleanup;
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence,
      checks: report.checks.map(({ name, passed, elapsedMs }) => ({ name, passed, elapsedMs })),
      error: report.error,
    }),
  );
}
