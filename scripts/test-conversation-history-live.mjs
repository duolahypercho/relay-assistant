// SPDX-License-Identifier: MIT
// Real inference against explicitly selected, already installed test weights. No download.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomInt } from 'node:crypto';
import { localModelStartFixture } from './local-model-start-fixture.mjs';

const model = process.env.RELAY_HISTORY_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
assert(
  model && modelsDirectory,
  'Choose an installed model and an isolated test weight directory.',
);
const directory = await mkdtemp(join(tmpdir(), 'relay-history-live-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 });
let browser;
const diagnostics = [];
const captures = [];
const requests = [];
const elapsedMs = [];
try {
  await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
  f.provider.save({
    preset: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    protocol: 'chat',
    apiKey: '',
    activate: true,
    abilities: { tools: 'unsupported', vision: 'unsupported' },
  });
  const code = String(randomInt(1000, 5000));
  const replacement = String(randomInt(5001, 9999));
  f.store.mutate((s) => {
    s.messages = [
      {
        id: 'old-workshop',
        threadId: 'main',
        role: 'user',
        text: `The kite workshop meeting code is ${code}.`,
        createdAt: '2026-10-01T00:00:00.000Z',
        cards: [],
        fileIds: [],
      },
    ];
    const topics = [
      [
        'What is an easy stretch after sitting?',
        'Try gently rolling your shoulders and standing up.',
      ],
      ['Suggest a rainy afternoon activity.', 'You could sketch a view from your window.'],
      ['How do I store fresh mint?', 'Keep the stems in a little water and refrigerate it.'],
      ['Give me a short writing exercise.', 'Describe a familiar room using only sounds.'],
      ['What goes well with roasted carrots?', 'Lemon, cumin and yogurt make a simple topping.'],
      [
        'Explain why leaves change color.',
        'As chlorophyll breaks down, other pigments become visible.',
      ],
      ['Suggest a gentle walk idea.', 'Try a short loop through a nearby park.'],
      ['How can I tidy a desk quickly?', 'Start by gathering loose papers into one pile.'],
      ['Give me a creative drawing prompt.', 'Draw a tiny bookstore inside a tree.'],
      ['How should I water a succulent?', 'Let its soil dry between thorough waterings.'],
      ['What is a simple lunch idea?', 'A bean salad with chopped vegetables is easy to prepare.'],
      ['Explain a metaphor.', 'It describes one thing as another to suggest a shared quality.'],
      ['Suggest a weekend craft.', 'Try folding a few paper bookmarks.'],
      ['How do I keep bread fresh?', 'Freeze portions you will not eat soon.'],
      ['Give me an observation exercise.', 'Notice three different textures on your next walk.'],
      ['Suggest a warm drink without caffeine.', 'Try warm milk with a little cinnamon.'],
      ['How can I make a room feel calmer?', 'Clear one visible surface and soften the lighting.'],
      ['Explain how a rainbow forms.', 'Sunlight bends and reflects inside water droplets.'],
      ['What is an easy pasta topping?', 'Olive oil, garlic and herbs make a simple sauce.'],
      ['Suggest a small creative habit.', 'Write one sentence about your day each evening.'],
      ['How do I clean a glass vase?', 'Warm water and a little dish soap usually work.'],
      ['What is a good indoor plant for shade?', 'A pothos can tolerate lower indirect light.'],
      ['Suggest a simple dessert.', 'Baked apples with cinnamon are easy to make.'],
      [
        'Explain the difference between weather and climate.',
        'Weather is short-term conditions; climate describes longer patterns.',
      ],
      ['What is a relaxing evening activity?', 'Try reading a short story before bed.'],
    ];
    for (let i = 0; i < 50; i++)
      s.messages.push({
        id: `filler-${i}`,
        threadId: 'main',
        role: i % 2 ? 'assistant' : 'user',
        text: topics[Math.floor(i / 2)][i % 2],
        ...(i % 2 ? { replyTo: `filler-${i - 1}` } : {}),
        createdAt: '2026-10-02T00:00:00.000Z',
        cards: [],
        fileIds: [],
      });
    s.threads.push({
      id: 'side-test',
      title: 'Separate topic',
      createdAt: '2026-10-03T00:00:00.000Z',
      archived: false,
      draft: '',
    });
    s.messages.push({
      id: 'side-secret',
      threadId: 'side-test',
      role: 'user',
      text: 'The kite workshop meeting code is SIDE-SECRET.',
      createdAt: '2026-10-03T00:00:00.000Z',
      cards: [],
      fileIds: [],
    });
  });
  const transport = f.provider.fetcher;
  f.provider.fetcher = async (url, init) => {
    if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    const response = await transport(url, init);
    if (url.endsWith('/chat/completions'))
      captures.push(
        response
          .clone()
          .text()
          .then((text) => {
            const frames = text
              .split('\n')
              .filter((l) => l.startsWith('data: {'))
              .map((l) => JSON.parse(l.slice(6)));
            diagnostics.push({
              finishReasons: frames
                .flatMap((f) => f.choices || [])
                .map((c) => c.finish_reason)
                .filter(Boolean),
              usage: frames.findLast((f) => f.usage)?.usage,
            });
          })
          .catch((error) => diagnostics.push({ error: String(error) })),
      );
    return response;
  };
  browser = await chromium.launch({
    ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(f.url + '/#chat/main');
  const send = async (text) => {
    const started = performance.now();
    await page.getByRole('textbox', { name: 'Message Relay', exact: true }).fill(text);
    const prior = f.store.read().runs.length;
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => f.store.read().runs.length, { timeout: 10000 }).toBe(prior + 1);
    await expect
      .poll(
        () => ['completed', 'failed', 'cancelled'].includes(f.store.read().runs.at(-1)?.status),
        { timeout: 180000 },
      )
      .toBe(true);
    assert.equal(
      f.store.read().runs.at(-1)?.status,
      'completed',
      JSON.stringify(f.store.read().runs.at(-1)),
    );
    elapsedMs.push(Math.round(performance.now() - started));
    return f.store.read().messages.findLast((m) => m.role === 'assistant').text;
  };
  const first = await send(
    'What is the kite workshop meeting code? Reply with only the four digits.',
  );
  assert.equal(first.trim(), code);
  assert.match(requests[0].messages[1].content, new RegExp(code));
  assert(!JSON.stringify(requests[0]).includes('SIDE-SECRET'));
  const second = await send(
    `The kite workshop meeting code has changed to ${replacement}. Tell me the new code only, four digits.`,
  );
  assert.equal(second.trim(), replacement);
  assert.equal(f.store.read().memories.length, 0);
  assert.equal(
    f.store.read().messages.length,
    56,
    'Only the two user requests and replies are added.',
  );
  assert.equal(requests.length, 2, 'Recall makes no auxiliary model call.');
  assert(requests.every((r) => !r.tools));
  await Promise.all(captures);
  await page.screenshot({ path: join(evidence, 'conversation-history-live-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'conversation-history-live-phone.png') });
  await writeFile(
    join(evidence, 'conversation-history-live.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        model,
        replyMode: f.provider.current.replyMode || 'default',
        reasoningEfforts: requests.map((r) => r.reasoning_effort || 'default'),
        elapsedMs,
        diagnostics,
        first,
        second,
        requests: requests.length,
        checks: [
          'Actual recall of a random code beyond 40 messages',
          'Latest correction wins',
          'Other chat excluded from wire payload',
          'No memory write or extra model call',
          'Normal desktop and phone chat with no extra step',
        ],
        scope:
          'Real Mac local model and browser UI on isolated fixture; text-only inference. Tool loop and other adapters are separately covered with controlled responses. No physical-device or hosted-provider certification.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS actual long-chat recall', { model, first, second });
} catch (error) {
  await Promise.all(captures);
  await writeFile(
    join(evidence, 'conversation-history-live-failure.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: false,
        error: String(error),
        runs: f.store.read().runs,
        diagnostics,
        requestContext: requests.map((r) => ({
          recall: r.messages[1],
          latest: r.messages.slice(-3),
          reasoningEffort: r.reasoning_effort,
        })),
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
