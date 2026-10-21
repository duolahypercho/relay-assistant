// SPDX-License-Identifier: MIT
// Actual local inference and unsent review state. No account or send capability.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { command } from '../shared/domain.mjs';

const model = process.env.RELAY_VOICE_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const replyMode = process.env.RELAY_VOICE_TEST_REPLY_MODE || 'quick';
assert(model && modelsDirectory && ['quick', 'default'].includes(replyMode));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/email-review-live');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-email-review-live-'));
const marker = 'ORBIT-' + randomInt(10000, 99999);
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode,
  marker,
  scope:
    'Actual local inference in the Mac renderer: inline wording, exact unsent reviews, an existing attachment, Chinese text and a required recipient clarification. Synthetic recognized text; no audio, owner accounts or sending.',
  checks: [],
  requests: [],
};
let f, app, page;
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
  const data = join(directory, 'desktop');
  await mkdir(data);
  await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${data}`],
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  page.setDefaultTimeout(15000);
  await page.goto(f.url + '/#chat');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function run(name, create, expected = 'completed') {
    const started = performance.now(),
      requestIndex = report.requests.length;
    const active =
      typeof create === 'function'
        ? f.store.mutate((s) => {
            const r = create(s);
            r.voiceCallId = 'synthetic-recognized-speech';
            return r;
          })
        : create;
    await expect
      .poll(() => f.store.read().runs.find((r) => r.id === active.id)?.status, {
        timeout: 240000,
        intervals: [250, 1000],
      })
      .toMatch(/^(completed|failed|waiting)$/);
    const state = f.store.read(),
      finished = state.runs.find((r) => r.id === active.id);
    const message = state.messages.findLast(
      (m) => m.role === 'assistant' && m.replyTo === active.messageId,
    );
    const check = {
      name,
      passed: false,
      status: finished.status,
      elapsedMs: Math.round(performance.now() - started),
      requestIndex,
      answer: message?.text || '',
      cards: message?.cards || [],
      runId: active.id,
    };
    report.checks.push(check);
    assert.equal(finished.status, expected, JSON.stringify(finished));
    await page.reload();
    await expect(page.locator('.message.assistant').last()).toBeVisible();
    return check;
  }
  const send = (name, text, status) =>
    run(name, (s) => command(s, 'chat.send', { threadId: 'main', text }), status);
  async function capture(check) {
    await page.screenshot({ path: join(evidence, check.name + '.png'), timeout: 60000 });
    console.log(`CHECKPOINT ${check.name}: verified state and captured renderer`);
  }
  function verifyReview(check, fields) {
    const reviews = f.store.read().approvals.filter((a) => a.creation?.runId === check.runId);
    assert.equal(reviews.length, 1, 'One current-request review is required.');
    const review = reviews[0];
    assert.equal(review.kind, 'email');
    assert.equal(review.status, 'pending');
    for (const [key, value] of Object.entries(fields))
      assert.deepEqual(review.payload[key], value, key);
    assert(check.cards.some((c) => c.kind === 'review' && c.id === review.id));
    check.review = review;
    check.passed = true;
  }
  const inline = await send(
    'inline-wording',
    `Write a short email in chat only, asking a colleague to bring a notebook for trip ${marker}. I only need the wording; do not save a draft or prepare a review.`,
  );
  assert.match(inline.answer, new RegExp(marker));
  assert.match(inline.answer, /notebook/i);
  assert.equal(f.store.read().approvals.length, 0);
  assert.equal(f.store.read().questions.length, 0);
  inline.passed = true;
  await capture(inline);
  const bytes = Buffer.from(`Checklist ${marker}\nNotebook\nUSB-C charger\n`);
  const attachment = f.store.mutate((s) =>
    command(s, 'file.add', {
      name: `Checklist-${marker}.txt`,
      mime: 'text/plain',
      base64: bytes.toString('base64'),
    }),
  );
  report.attachment = {
    id: attachment.id,
    name: attachment.name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const english = await send(
    'attached-review',
    `Prepare an email for my review to colleague@example.test. Use exactly this subject: "Trip ${marker}". Use exactly this body: "The departure time is 10:30.\nPlease bring your notebook." Attach the saved file ${attachment.name}. Do not send it.`,
  );
  verifyReview(english, {
    to: 'colleague@example.test',
    subject: `Trip ${marker}`,
    body: 'The departure time is 10:30.\nPlease bring your notebook.',
    attachmentIds: [attachment.id],
  });
  assert.deepEqual(
    english.review.attachments.map((a) => a.id),
    [attachment.id],
  );
  assert.equal(
    f.store.read().files.find((x) => x.id === attachment.id).base64,
    bytes.toString('base64'),
  );
  await capture(english);
  const chinese = await send(
    'chinese-review',
    `请起草一封邮件让我审核，不要发送。收件人是 colleague@example.test。主题必须是「行程 ${marker}」。正文必须是「出发时间是10:30。请带好笔记本。」。不要添加附件。`,
  );
  verifyReview(chinese, {
    to: 'colleague@example.test',
    subject: `行程 ${marker}`,
    body: '出发时间是10:30。请带好笔记本。',
    attachmentIds: [],
  });
  await capture(chinese);
  const count = f.store.read().approvals.length;
  const missing = await send(
    'recipient-question',
    `Draft an email for my review. Subject: "Meetup ${marker}". Body: "See you at 14:00." The recipient is a different person and I have not supplied their address yet. Ask me for it; do not reuse an earlier recipient.`,
    'completed',
  );
  const question = f.store
    .read()
    .questions.find((q) => q.sourceRunId === missing.runId && q.status === 'pending');
  assert(question);
  assert.match(question.prompt, /recipient|address|email|send/i);
  assert.deepEqual(
    question.options,
    [],
    'An unknown address needs a text answer, not invented choices.',
  );
  assert.equal(f.store.read().approvals.length, count);
  missing.question = question;
  missing.passed = true;
  await capture(missing);
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my next thought');
  const card = page.getByRole('group', { name: question.prompt, exact: true });
  await card.getByLabel('Your own answer', { exact: true }).fill('different@example.test');
  await card.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect
    .poll(() => f.store.read().questions.find((q) => q.id === question.id)?.status)
    .toBe('answered');
  const answerId = f.store.read().questions.find((q) => q.id === question.id).answerRunId;
  const clarified = await run(
    'clarified-review',
    f.store.read().runs.find((r) => r.id === answerId),
  );
  assert.equal(f.store.read().threads.find((t) => t.id === 'main').draft, 'Keep my next thought');
  assert.equal(f.store.read().runs.filter((r) => r.id === answerId).length, 1);
  verifyReview(clarified, {
    to: 'different@example.test',
    subject: `Meetup ${marker}`,
    body: 'See you at 14:00.',
    attachmentIds: [],
  });
  await capture(clarified);
  assert.equal(f.store.read().approvals.length, 3);
  assert(f.store.read().approvals.every((a) => a.status === 'pending'));
  assert.equal(f.store.read().connections.google.connected, false);
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, 'phone-review.png'), timeout: 60000 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  await page?.screenshot({ path: join(evidence, 'failure.png'), timeout: 60000 }).catch(() => {});
} finally {
  report.cleanupErrors = [];
  for (const [name, close] of [
    ['app', () => app?.close()],
    ['fixture', () => f?.close()],
    ['scratch', () => rm(directory, { recursive: true, force: true })],
  ]) {
    try {
      await close();
    } catch (error) {
      report.cleanupErrors.push({ name, error: error.message });
    }
  }
  report.cleanedUp = report.cleanupErrors.length === 0;
  if (!report.cleanedUp) {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        evidence,
        checks: report.checks.map(({ name, passed, elapsedMs }) => ({ name, passed, elapsedMs })),
        error: report.error,
        cleanedUp: report.cleanedUp,
      },
      null,
      2,
    ),
  );
}
