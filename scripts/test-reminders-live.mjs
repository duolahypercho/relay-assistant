// SPDX-License-Identifier: MIT
// Actual local inference and wall-clock reminder delivery, using only synthetic data.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';

const model = process.env.RELAY_REMINDER_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(model && modelsDirectory, 'Choose an installed model and independent acceptance cache.');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/simple-reminders/live',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-reminders-live-'));
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode: 'default',
  requests: [],
  checks: [],
  scope:
    'Actual local inference, real wall-clock fixed reminder delivery after worker restart, synthetic typed and recognized-text requests. No microphone, physical phone, OS notification or server-process restart claim.',
};
let f, browser, restartedWorker;
try {
  f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
  f.store.mutate((s) => {
    s.profile.memoryLearning = false;
    s.profile.timeZone = 'Asia/Shanghai';
  });
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    protocol: 'chat',
    replyMode: 'default',
    apiKey: '',
    activate: true,
  });
  const fetcher = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) report.requests.push(JSON.parse(init.body));
    return fetcher(url, init);
  };
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  await page.goto(f.url + '/#chat');
  async function send(name, text, voice = false) {
    const started = performance.now();
    let run;
    if (voice)
      run = f.store.mutate((s) => {
        const r = command(s, 'chat.send', { threadId: 'main', text });
        r.voiceCallId = 'synthetic-recognized-reminder';
        return r;
      });
    else {
      await page.locator('.composer textarea').fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect
        .poll(() => f.store.read().messages.some((m) => m.role === 'user' && m.text === text))
        .toBe(true);
      run = f.store
        .read()
        .runs.find(
          (r) =>
            r.messageId ===
            f.store.read().messages.find((m) => m.role === 'user' && m.text === text).id,
        );
    }
    await expect
      .poll(() => f.store.read().runs.find((r) => r.id === run.id)?.status, {
        timeout: 240000,
        intervals: [250, 1000],
      })
      .toMatch(/^(completed|failed|waiting)$/);
    const s = f.store.read(),
      done = s.runs.find((r) => r.id === run.id);
    const reminder = s.routines.find((r) => r.creation?.sourceMessageId === run.messageId);
    const check = {
      name,
      elapsedMs: Math.round(performance.now() - started),
      status: done.status,
      answer: s.messages.findLast((m) => m.replyTo === run.messageId)?.text,
      reminder,
      passed: false,
    };
    report.checks.push(check);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert(reminder, 'The model must actually save a reminder for this request.');
    assert.equal(reminder.execution, 'reminder');
    assert.equal(s.routines.filter((r) => r.creation?.sourceMessageId === run.messageId).length, 1);
    assert.equal(
      s.messages
        .findLast((m) => m.replyTo === run.messageId)
        ?.cards?.filter((c) => c.kind === 'reminder').length,
      1,
    );
    return { check, reminder, source: s.messages.find((m) => m.id === run.messageId) };
  }
  const first = await send(
    'relative',
    'Remind me in three minutes to stretch. Use the reminder text exactly: Time to stretch.',
  );
  assert.equal(first.reminder.schedule.at, Date.parse(first.source.createdAt) + 180000);
  assert.equal(first.reminder.instructions, 'Time to stretch.');
  assert.equal(first.check.answer, 'Reminder scheduled.');
  assert.equal(first.reminder.paused, false);
  assert(first.reminder.schedule.at > Date.now(), 'Model took longer than the requested delay');
  assert.equal(f.store.read().messages.filter((m) => m.routineId === first.reminder.id).length, 0);
  const count = report.requests.length;
  await f.worker.stop();
  recoverWork(f.store);
  restartedWorker = new BackgroundWorker(f.store, f.services, { pollMs: 100 });
  restartedWorker.start();
  await expect
    .poll(() => f.store.read().messages.filter((m) => m.routineId === first.reminder.id).length, {
      timeout: 200000,
      intervals: [250, 1000],
    })
    .toBe(1);
  const delivered = f.store.read().messages.find((m) => m.routineId === first.reminder.id);
  assert.equal(delivered.text, 'Time to stretch.');
  assert.equal(report.requests.length, count);
  assert(Date.parse(delivered.createdAt) >= first.reminder.schedule.at, 'Never deliver early');
  first.check.deliveryDelayMs = Date.parse(delivered.createdAt) - first.reminder.schedule.at;
  assert(first.check.deliveryDelayMs < 5000, 'Excessive delivery delay');
  first.check.passed = true;
  await expect(
    page.getByRole('article', { name: 'Reminder', exact: true }).getByRole('status'),
  ).toHaveText('Delivered');
  await page.screenshot({ path: join(evidence, 'delivered.png') });
  console.log(
    `PASS relative: actual delivery ${first.check.deliveryDelayMs} ms after deadline, no extra model call`,
  );
  const paused = await send(
    'paused-daily',
    'Remind me every day at 9 AM Asia/Shanghai to water the fern. Save this reminder paused for now. Use the reminder text exactly: Water the fern.',
  );
  assert.equal(paused.reminder.paused, true);
  assert.equal(paused.reminder.schedule.kind, 'daily');
  assert.equal(paused.reminder.schedule.time, '09:00');
  assert.equal(paused.reminder.schedule.timeZone, 'Asia/Shanghai');
  assert.equal(paused.reminder.instructions, 'Water the fern.');
  assert.match(paused.check.answer, /paused|暂停|暫停/i);
  paused.check.passed = true;
  console.log('PASS paused-daily: exact schedule, text and paused state');
  const chinese = await send(
    'recognized-chinese',
    '五分钟后提醒我喝水。提醒内容请只写：该喝水了。',
    true,
  );
  assert.equal(chinese.reminder.schedule.at, Date.parse(chinese.source.createdAt) + 300000);
  assert.equal(chinese.reminder.paused, false);
  assert.equal(chinese.reminder.instructions, '该喝水了。');
  assert.match(chinese.check.answer, /提醒/);
  chinese.check.passed = true;
  await page.reload();
  await page.screenshot({ path: join(evidence, 'three-reminders.png') });
  console.log('PASS recognized-chinese: enabled, exact text and request-relative deadline');
  assert.equal(f.store.read().routines.length, 3);
  report.passed = true;
} finally {
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await restartedWorker?.stop();
  await f?.close();
  await rm(directory, { recursive: true, force: true });
}
