// SPDX-License-Identifier: MIT
// Real local inference: ordinary replies stay in chat, requested files remain actionable.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';

const model = process.env.RELAY_CONVERSATION_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const replyMode = process.env.RELAY_CONVERSATION_TEST_REPLY_MODE || 'quick';
const mainChat = process.argv.includes('--main-chat');
assert(model && modelsDirectory, 'Choose an installed model and dedicated acceptance cache.');
assert(['quick', 'default'].includes(replyMode));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-conversation-intent-'));
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
const checks = [],
  requests = [],
  responses = [];
const result = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode,
  mainChat,
  checks,
};
let browser;
try {
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
  const transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    const response = await transport(url, init);
    if (url.endsWith('/chat/completions'))
      responses.push(
        response
          .clone()
          .text()
          .catch((error) => JSON.stringify({ captureError: error.name, message: error.message })),
      );
    return response;
  };
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  await page.goto(f.url);
  const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
  const marker = 'BIRCH-' + randomBytes(6).toString('hex');
  const ordinaryCases = [
    {
      name: 'suggestion',
      text: 'I have twenty minutes at home before dinner. Suggest a relaxing activity.',
      maxSentences: 3,
    },
    { name: 'explanation', text: 'What makes bread rise? Explain in two sentences.' },
    { name: 'Chinese draft', text: '帮我写一句简短的生日祝福，适合朋友。' },
  ];
  const continuousCases = [
    {
      name: 'one simple suggestion',
      text: 'I have twenty minutes at home before dinner. Suggest one relaxing activity in one or two sentences.',
      maxSentences: 2,
    },
    {
      name: 'simpler follow-up',
      text: 'That sounds like too much effort. Give me an even easier idea in one sentence.',
      maxSentences: 1,
    },
    ordinaryCases[1],
    ordinaryCases[2],
    {
      name: 'Chinese follow-up',
      text: '改得俏皮一点，还是只要一句中文祝福。',
      chineseDraft: true,
    },
    {
      name: 'plan stays in chat',
      text: 'Help me plan a small birthday picnic. Give me three things to prepare; just a short list.',
      listItems: 3,
    },
    {
      name: 'one-line plan title',
      text: 'Give that picnic plan a playful one-line title. Just the title, and do not save anything.',
      maxLines: 1,
    },
  ];
  const cases = [
    ...(mainChat ? continuousCases : ordinaryCases),
    {
      name: 'requested file',
      text:
        'Create a downloadable plain text file named birch-proof.txt containing exactly ' +
        marker +
        '.',
      create: true,
    },
    {
      name: 'read saved file in a new chat',
      text: 'Read my saved file birch-proof.txt and tell me its complete text.',
      read: true,
      newChat: true,
    },
  ];
  for (const [index, item] of cases.entries()) {
    if (index && (!mainChat || item.newChat)) {
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await expect(composer).toHaveValue('');
    }
    const before = f.store.read();
    const start = performance.now(),
      requestStart = requests.length;
    const record = { name: item.name, text: item.text, passed: false, requestStart };
    checks.push(record);
    const captureFirstText = () => {
      const current = f.store.read().runs.at(-1);
      if (
        record.firstStoredTextMs === undefined &&
        current?.id !== before.runs.at(-1)?.id &&
        current?.partial?.trim()
      )
        record.firstStoredTextMs = Math.round(performance.now() - start);
    };
    f.store.on('change', captureFirstText);
    await composer.fill(item.text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => f.store.read().runs.length, { timeout: 10000 })
      .toBe(before.runs.length + 1);
    await expect
      .poll(
        () => ['completed', 'failed', 'cancelled'].includes(f.store.read().runs.at(-1)?.status),
        { timeout: 180000 },
      )
      .toBe(true);
    f.store.off('change', captureFirstText);
    if (index === 0) {
      const status = await fetch('http://127.0.0.1:41334/api/ps', {
        signal: AbortSignal.timeout(3000),
      });
      assert(status.ok);
      result.runtimeModels = await status.json();
    }
    const after = f.store.read(),
      run = after.runs.at(-1);
    const reply = after.messages.findLast(
      (m) => m.role === 'assistant' && m.replyTo === run.messageId,
    );
    const questions = after.questions.filter(
      (q) => !before.questions.some((old) => old.id === q.id),
    );
    Object.assign(record, {
      elapsedMs: Math.round(performance.now() - start),
      requestEnd: requests.length,
      reply: reply?.text,
      replyCharacters: [...(reply?.text || '')].length,
      status: run.status,
      questions,
      files: after.files
        .filter((file) => !before.files.some((old) => old.id === file.id))
        .map(({ id, name }) => ({ id, name })),
    });
    try {
      assert.equal(run.status, 'completed');
      assert(reply?.text?.trim());
      const plainReply = reply.text.replace(/[*_`]/g, '').trim();
      if (item.maxSentences) {
        const sentences = (plainReply.match(/[.!?](?:\s|$)/g) || []).length;
        assert(
          sentences >= 1 && sentences <= item.maxSentences,
          'The requested short answer grew extra sentences',
        );
      }
      if (item.listItems)
        assert.equal(
          (reply.text.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) || []).length,
          item.listItems,
          'The plan did not contain the requested three items',
        );
      if (item.maxLines)
        assert.equal(
          plainReply.split('\n').filter((line) => line.trim()).length,
          item.maxLines,
          'The title gained extra lines',
        );
      if (!item.create && !item.read)
        assert(!/[?？]\s*$/.test(plainReply), 'An unnecessary follow-up question was appended');
      if (item.name === 'explanation')
        assert.equal(
          (reply.text.replace(/[*_`]/g, '').match(/[.!?](?:\s|$)/g) || []).length,
          2,
          'The explanation did not use the requested two sentences',
        );
      if (item.name === 'Chinese draft' || item.chineseDraft) {
        assert(/[\u4e00-\u9fff]/u.test(reply.text), 'The Chinese request needs a Chinese reply');
        assert(
          [...reply.text.trim()].length <= 60,
          'The short birthday wish gained unnecessary commentary',
        );
      }
      assert.equal(questions.length, 0, 'Unnecessary clarification interrupted the request');
      assert.deepEqual(after.tasks, before.tasks, 'Unrequested task mutation');
      assert.deepEqual(after.routines, before.routines, 'Unrequested routine mutation');
      assert.deepEqual(after.goals, before.goals, 'Unrequested goal mutation');
      assert.deepEqual(
        after.memories,
        before.memories,
        'One-off conversation unexpectedly changed personal memory',
      );
      if (item.create) {
        assert.equal(record.files.length, 1, 'Explicit file request must create exactly one file');
        const file = after.files.find((file) => file.id === record.files[0].id);
        assert.equal(file.name, 'birch-proof.txt');
        assert.equal(Buffer.from(file.base64, 'base64').toString(), marker);
      } else
        assert.deepEqual(
          after.files,
          before.files,
          'Conversation unexpectedly changed saved files',
        );
      if (item.read) assert(reply.text.includes(marker), 'Saved file content was not recovered');
      await expect(page.locator('.chat-workspace .message.assistant').last()).toBeVisible();
      record.passed = true;
    } catch (error) {
      record.error = error.message;
    }
    await page.screenshot({ path: join(evidence, 'conversation-intent-' + index + '.png') });
    console.log(JSON.stringify(record));
  }
  await composer.fill('Keep my next thought');
  await page.reload();
  await expect(composer).toHaveValue('Keep my next thought');
  result.draftPreserved = true;
  result.passed = checks.every((check) => check.passed);
  assert(result.passed, 'One or more real-model conversation cases failed; see recorded evidence.');
} catch (error) {
  result.error = error.stack;
  throw error;
} finally {
  result.finishedAt = new Date().toISOString();
  result.scope = mainChat
    ? 'Nine English/Chinese cases: seven continuous Main-chat requests and follow-ups, explicit file creation, and saved-file recall in a side chat. Actual local inference; not broad model certification.'
    : 'Five English/Chinese conversation and explicit-file cases on one installed local model, not broad model certification.';
  result.reviewRequired =
    'The automated gate verifies output shape and recorded side effects. Inspect the replies separately for relevance, factual quality and whether a single requested suggestion really stayed singular. firstStoredTextMs measures the worker partial, not a browser paint.';
  await writeFile(
    join(evidence, 'conversation-intent-acceptance.json'),
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    join(evidence, 'conversation-intent-transport.json'),
    JSON.stringify({ requests, responses: await Promise.all(responses) }, null, 2),
  );
  await browser?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
