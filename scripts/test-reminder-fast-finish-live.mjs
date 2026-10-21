// SPDX-License-Identifier: MIT
// Actual inference for explicit reminder completion and compound requests.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelStartFixture } from './local-model-start-fixture.mjs';

const model = process.env.RELAY_REMINDER_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed model and independent acceptance cache.');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/reminder-fast-finish/live',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-reminder-finish-'));
const report = {
  passed: false,
  cleanedUp: false,
  checkedAt: new Date().toISOString(),
  model,
  scope:
    'Actual local Quick inference through the browser composer and worker, isolated synthetic workspace. No microphone, physical device, external account or email sending.',
  sourceHashes: {},
  requests: [],
  responses: [],
  checks: [],
};
for (const name of [
  'server/agent.mjs',
  'server/reminders.mjs',
  'scripts/test-reminder-fast-finish-live.mjs',
])
  report.sourceHashes[name] = createHash('sha256')
    .update(await readFile(name))
    .digest('hex');
let fixture, browser;
try {
  fixture = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  fixture.store.mutate((s) => {
    s.profile.memoryLearning = false;
    s.profile.timeZone = 'Asia/Shanghai';
  });
  await fixture.runtime.start({
    revision: fixture.runtime.preference().revision,
    startWithRelay: false,
  });
  fixture.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    protocol: 'chat',
    replyMode: 'quick',
    apiKey: '',
    activate: true,
  });
  const forRun = fixture.provider.forRun.bind(fixture.provider);
  fixture.provider.forRun = (...args) => {
    const provider = forRun(...args);
    const complete = provider.complete.bind(provider);
    provider.complete = async (...input) => {
      const response = await complete(...input);
      report.responses.push({
        runId: args[0].id,
        text: response.text,
        toolCalls: response.toolCalls,
      });
      return response;
    };
    return provider;
  };
  const fetcher = fixture.provider.fetcher;
  fixture.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) report.requests.push(JSON.parse(init.body));
    return fetcher(url, init);
  };
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  await page.goto(fixture.url + '/#chat');
  async function send(name, text, verify) {
    const started = performance.now(),
      requestStart = report.requests.length;
    await page.locator('.composer textarea').fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    let run;
    await expect
      .poll(
        () => {
          const state = fixture.store.read();
          const message = state.messages.findLast((m) => m.role === 'user' && m.text === text);
          run = state.runs.find((r) => r.messageId === message?.id);
          return run?.status;
        },
        { timeout: 300000, intervals: [250, 1000] },
      )
      .toMatch(/^(completed|failed)$/);
    const state = fixture.store.read();
    const reply = state.messages.findLast(
      (m) => m.replyTo === run.messageId && m.role === 'assistant',
    );
    const reminders = state.routines.filter((r) => r.creation?.sourceMessageId === run.messageId);
    const row = {
      name,
      text,
      elapsedMs: Math.round(performance.now() - started),
      modelCalls: report.requests.length - requestStart,
      run: structuredClone(run),
      reply,
      reminders,
      responses: report.responses.filter((response) => response.runId === run.id),
      passed: false,
    };
    report.checks.push(row);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(reminders.length, 1);
    assert.equal(reply.cards.filter((card) => card.kind === 'reminder').length, 1);
    const source = state.messages.find((m) => m.id === run.messageId);
    await verify(row, state, source);
    await expect(page.getByRole('article', { name: 'Reminder', exact: true }).last()).toBeVisible();
    await page.screenshot({ path: join(evidence, `${name}.png`) });
    row.passed = true;
    console.log(`PASS ${name}: ${row.modelCalls} model call(s), ${row.elapsedMs} ms`);
  }
  await send(
    'simple',
    'Remind me in five minutes to stretch. Use the reminder text exactly: Time to stretch.',
    (row, _state, source) => {
      assert.equal(row.reminders[0].instructions, 'Time to stretch.');
      assert.equal(row.reminders[0].schedule.at, Date.parse(source.createdAt) + 300000);
      assert.equal(row.reminders[0].paused, false);
      assert.match(row.reply.text, /^Reminder scheduled\.(?:$|\s)/);
      assert(row.modelCalls >= 1);
    },
  );
  await send(
    'paused',
    'Remind me every day at 9 AM Asia/Shanghai to water the fern. Save this reminder paused for now. Use the reminder text exactly: Water the fern.',
    (row) => {
      assert.equal(row.reminders[0].instructions, 'Water the fern.');
      assert.equal(row.reminders[0].paused, true);
      assert.equal(row.reminders[0].schedule.time, '09:00');
      assert.equal(row.reminders[0].schedule.timeZone, 'Asia/Shanghai');
      assert.match(row.reply.text, /^Reminder saved and paused\.(?:$|\s)/);
      assert(row.modelCalls >= 1);
    },
  );
  await send('chinese', '五分钟后提醒我喝水。提醒内容请只写：该喝水了。', (row, _state, source) => {
    assert.equal(row.reminders[0].instructions, '该喝水了。');
    assert.equal(row.reminders[0].schedule.at, Date.parse(source.createdAt) + 300000);
    assert.match(row.reply.text, /^提醒已安排。/);
    assert(row.modelCalls >= 1);
  });
  await send(
    'compound-answer',
    'Remind me in five minutes to take a break. Also tell me what 14 plus 27 equals.',
    (row) => {
      assert.match(row.reply.text, /\b41\b/, 'The other requested answer must not disappear');
      assert(row.modelCalls >= 2, 'This request requires a continuation after saving');
    },
  );
  await send(
    'compound-file',
    'Remind me in five minutes to pack. Also create a plain text file named Packing.txt containing exactly "Notebook, cable, keys."',
    (row, state) => {
      const file = state.files.find((f) => f.name === 'Packing.txt');
      assert(file, 'The additional deliverable must actually exist');
      assert.equal(Buffer.from(file.base64, 'base64').toString(), 'Notebook, cable, keys.');
      assert(row.reply.cards.some((card) => card.kind === 'file' && card.id === file.id));
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.composer textarea')).toBeVisible();
  await page.screenshot({ path: join(evidence, 'phone.png') });
  report.fastCompletions = report.checks
    .filter((row) => row.modelCalls === 1)
    .map((row) => row.name);
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  try {
    await browser?.close();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
    report.cleanedUp = true;
  } finally {
    await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
