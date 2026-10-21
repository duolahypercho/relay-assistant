// SPDX-License-Identifier: MIT
// Real local inference in a disposable workspace. Owner data/configuration stay untouched.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const model = process.env.RELAY_MEMORY_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const replyMode = process.env.RELAY_MEMORY_TEST_REPLY_MODE || 'quick';
const preciseSampling = process.env.RELAY_MEMORY_TEST_SAMPLING === 'precise';
// Accept clear natural-language recall, not just a repeated keyword.
const vegetarianRecall =
  /\b(?:vegetarian|meat[- ]free|(?:without|no|avoid(?:ing)?)\s+(?:any\s+)?meat)\b/i;
const excludesMushrooms =
  /(without|no |not (?:want|eat|like|contain|include)|avoid|dislike|exclud\w*).*mushroom/i;
assert(['quick', 'default'].includes(replyMode));
assert(model && modelsDirectory, 'Select an installed model and dedicated acceptance cache.');
const directory = await mkdtemp(join(tmpdir(), 'relay-memory-live-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
let browser;
const checks = [],
  requests = [],
  responses = [],
  turns = [];
const result = {
  passed: false,
  checkedAt: new Date().toISOString(),
  model,
  replyMode,
  preciseSampling,
  checks,
  turns,
};
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
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      if (preciseSampling) {
        body.temperature = 0.2;
        body.presence_penalty = 0;
        init = { ...init, body: JSON.stringify(body) };
      }
      requests.push(body);
    }
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
  const send = async (text) => {
    const started = performance.now(),
      prior = f.store.read().runs.length,
      requestStart = requests.length;
    await composer.fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => f.store.read().runs.length, { timeout: 10000 }).toBe(prior + 1);
    await expect
      .poll(
        () => ['completed', 'failed', 'cancelled'].includes(f.store.read().runs.at(-1)?.status),
        { timeout: 180000 },
      )
      .toBe(true);
    const state = f.store.read(),
      run = state.runs.at(-1),
      reply = state.messages.findLast((m) => m.role === 'assistant' && m.replyTo === run.messageId);
    const record = {
      text,
      reply: reply?.text,
      elapsedMs: Math.round(performance.now() - started),
      requestStart,
      requestEnd: requests.length,
      memories: state.memories,
      files: state.files.map(({ id, name }) => ({ id, name })),
      tasks: state.tasks.map(({ id, title, status }) => ({ id, title, status })),
      questions: state.messages.flatMap((message) =>
        (message.cards || []).filter((card) => card.kind === 'question'),
      ),
    };
    turns.push(record);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert(reply?.text);
    assert.equal(state.files.length, 0, 'A conversation-only request created an unsolicited file');
    assert.equal(state.tasks.length, 0, 'A conversation-only request created an unsolicited task');
    assert.equal(record.questions.length, 0, 'A clear preference needed an unnecessary question');
    await expect(page.locator('.chat-workspace .message.assistant').last()).toBeVisible();
    assert(
      (await page.locator('.chat-workspace .message.assistant').last().innerText()).trim().length >
        0,
    );
    assert(
      !/memory-[a-z0-9]|sourceMessageId|memoryControlVersion/i.test(reply.text),
      'Internal metadata leaked into reply',
    );
    console.log(
      JSON.stringify({
        turn: turns.length,
        elapsedMs: record.elapsedMs,
        reply: reply.text,
        memories: state.memories.map((m) => ({
          id: m.id,
          key: m.key,
          text: m.text,
          origin: m.origin,
        })),
      }),
    );
    return record;
  };
  const newChat = async () => {
    await page.getByRole('button', { name: 'Show chats', exact: true }).click();
    await page.getByRole('button', { name: 'New side chat', exact: true }).click();
    await expect(composer).toHaveValue('');
  };
  const memoryText = () =>
    f.store
      .read()
      .memories.filter((m) => m.type === 'note')
      .map((m) => m.text)
      .join('\n');
  const first = await send(
    'For future dinner ideas, I prefer vegetarian dishes without mushrooms. Suggest one simple dinner.',
  );
  assert.match(memoryText(), /vegetarian/i);
  assert.match(memoryText(), excludesMushrooms);
  for (const m of f.store.read().memories) {
    if (m.origin === 'learned') {
      assert(m.sourceMessageId);
      assert(first.text.includes(m.evidence));
    }
  }
  checks.push(
    'Actual model learns the supplied dinner preferences with current-owner source evidence',
  );
  await newChat();
  const recalled = await send(
    'What food preferences should you keep in mind for my dinners? Use one sentence.',
  );
  assert.match(recalled.reply, vegetarianRecall);
  assert.match(recalled.reply, excludesMushrooms);
  const initialIds = f.store.read().memories.map((m) => m.id);
  const changed = await send(
    'My dinner preference has changed: include mushrooms now, but keep meals vegetarian. Keep this in mind for future dinners.',
  );
  assert.match(memoryText(), /vegetarian/i);
  assert.match(memoryText(), /mushroom/i);
  assert(!excludesMushrooms.test(memoryText()), 'A stale conflicting preference remains active');
  assert(
    f.store.read().memories.some((m) => initialIds.includes(m.id)),
    'Correction discarded every original memory identity',
  );
  checks.push(
    'Separate-chat recall and a newer correction retain useful context without an active stale contradiction',
  );
  await newChat();
  const updated = await send(
    'What food preferences should you keep in mind for my dinners? Use one sentence.',
  );
  assert.match(updated.reply, vegetarianRecall);
  assert.match(updated.reply, /mushroom/i);
  assert(!excludesMushrooms.test(updated.reply));
  await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Your assistant', exact: true });
  await dialog.getByRole('button', { name: 'My memories', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }).click();
  await expect(
    dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const beforeOff = structuredClone(f.store.read().memories);
  await send('I prefer jazz for background music. Suggest one quiet evening activity.');
  assert.deepEqual(f.store.read().memories, beforeOff, 'Learning-off added or changed a memory');
  checks.push('Actual model respects learning-off while answering the current request');
  // A fresh chat prevents transcript recall from masquerading as persistent memory.
  await newChat();
  await send('Forget my saved dinner preferences.');
  assert(
    !/vegetarian|mushroom/i.test(memoryText()),
    'Asked-to-forget dinner preferences remain saved',
  );
  await newChat();
  const forgotten = await send(
    'Have I told you any food preferences to keep in mind for dinners? Do not guess.',
  );
  assert(!/vegetarian|mushroom/i.test(forgotten.reply), 'Forgotten fact surfaced in a fresh chat');
  assert.match(
    forgotten.reply,
    /(?:\bno\b|\bnot\b|don[’']t|haven[’']t|doesn[’']t|nothing|none)/i,
    'After forgetting, the reply must acknowledge that no dinner preference is available',
  );
  assert.doesNotMatch(
    forgotten.reply,
    /^(?:yes|sure|of course)\b|\byou have .{0,50}preferences saved\b|\bi (?:have|remember) .{0,50}(?:dinner|food) preference/i,
    'An empty saved-memory list was presented as remembered preferences',
  );
  checks.push(
    'Explicit forget removes saved preferences; a fresh chat does not claim to remember them',
  );
  await composer.fill('Keep my next thought');
  await page.reload();
  await expect(composer).toHaveValue('Keep my next thought');
  await page.screenshot({ path: join(evidence, 'memory-live-final.png') });
  result.passed = true;
  result.scope =
    'One real local-model personal-memory scenario with automatic learning, cross-chat recall/correction, learning-off and forgetting. Not a broad semantic or provider-quality certification.';
} catch (error) {
  result.error = error.stack;
  throw error;
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(join(evidence, 'memory-live-acceptance.json'), JSON.stringify(result, null, 2));
  await writeFile(
    join(evidence, 'memory-live-transport.json'),
    JSON.stringify({ requests, responses: await Promise.all(responses) }, null, 2),
  );
  await browser?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
