// SPDX-License-Identifier: MIT
// Explicit owner saves with learning off, including chat-only model transports.
import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
import { isMemoryReview } from './memory-review-fixture.mjs';
const expect = baseExpect.configure({ timeout: 12000 });
const live = process.argv.includes('--live');
const model = process.env.RELAY_MEMORY_TEST_MODEL;
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
if (live) assert(model && modelsDirectory, 'Choose an installed model and dedicated cache.');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/memory-explicit');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const width of live ? [390] : [1365, 390]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-memory-explicit-'));
    const reviews = [];
    const f = live
      ? await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 })
      : await assistantsFixture(directory, {
          review(body) {
            reviews.push(body);
            const source = JSON.parse(body.messages.at(-1).content).currentOwnerMessage;
            assert(source.startsWith('Please remember:'));
            return {
              role: 'assistant',
              content: JSON.stringify({
                memories: [
                  {
                    slot: 0,
                    text: 'Prefers quiet hotels away from nightlife.',
                    evidence: 'I prefer quiet hotels away from nightlife',
                  },
                ],
              }),
            };
          },
          respond(body) {
            assert(!body.tools);
            const source = body.messages.at(-1).content;
            if (source.startsWith('Please remember:'))
              return {
                role: 'assistant',
                content: 'Saved your preference for quiet hotels away from nightlife.',
              };
            if (source.startsWith('What hotel'))
              return { role: 'assistant', content: 'You prefer quiet hotels away from nightlife.' };
            return { role: 'assistant', content: 'An evening walk could be relaxing.' };
          },
        });
    const requests = [],
      responses = [];
    const transport = f.provider.fetcher;
    f.provider.fetcher = async (url, init) => {
      if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
      const response = await transport(url, init);
      if (url.endsWith('/chat/completions'))
        responses.push(
          response
            .clone()
            .text()
            .catch((error) => String(error)),
        );
      return response;
    };
    let context;
    const record = {
      width,
      live,
      model: live ? model : 'controlled HTTP model',
      passed: false,
      turns: [],
    };
    results.push(record);
    try {
      if (live)
        await f.runtime.start({ revision: f.runtime.preference().revision, startWithRelay: false });
      const existing = live ? {} : f.provider.publicState().connections[0];
      f.provider.save({
        ...existing,
        preset: live ? 'ollama' : 'custom',
        baseUrl: live ? 'http://127.0.0.1:11434/v1' : existing.baseUrl,
        model: live ? model : existing.model,
        protocol: 'chat',
        apiKey: '',
        abilities: { tools: 'unsupported' },
        ...(live ? { replyMode: 'quick' } : {}),
      });
      context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.goto(f.url);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await expect(composer).toBeVisible();
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Your assistant', exact: true });
      await dialog.getByRole('button', { name: 'My memories', exact: true }).click();
      await dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }).click();
      await expect(
        dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      const send = async (text) => {
        const prior = f.store.read().runs.length,
          start = requests.length;
        await composer.fill(text);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => f.store.read().runs.length).toBe(prior + 1);
        await expect
          .poll(
            () => ['completed', 'failed', 'cancelled'].includes(f.store.read().runs.at(-1)?.status),
            { timeout: 180000 },
          )
          .toBe(true);
        const state = f.store.read(),
          run = state.runs.at(-1),
          reply = state.messages.findLast(
            (m) => m.role === 'assistant' && m.replyTo === run.messageId,
          );
        record.turns.push({
          text,
          reply: reply?.text,
          requests: requests.length - start,
          memories: state.memories,
        });
        assert.equal(run.status, 'completed');
        assert(reply?.text);
        assert.equal(state.files.length, 0);
        assert.equal(state.tasks.length, 0);
        assert.equal(
          state.messages.flatMap((m) => (m.cards || []).filter((c) => c.kind === 'question'))
            .length,
          0,
        );
        return { state, run, reply, wire: requests.slice(start) };
      };
      const first = await send(
        'Please remember: I prefer quiet hotels away from nightlife. Acknowledge in one sentence.',
      );
      assert(first.wire.some(isMemoryReview));
      assert(first.wire.every((body) => !body.tools));
      assert.equal(first.state.memories.length, 1);
      const note = first.state.memories[0];
      assert.equal(note.origin, 'manual');
      assert.equal(note.sourceMessageId, first.run.messageId);
      assert.match(note.text, /quiet/i);
      assert.match(note.text, /nightlife/i);
      assert(
        first.state.messages
          .find((m) => m.id === note.sourceMessageId)
          .text.includes(note.evidence),
      );
      assert.equal(first.reply.cards.filter((c) => c.kind === 'memory').length, 1);
      assert.doesNotMatch(first.reply.text, /cannot|can't|unable|connect.*model|AI models/i);
      const newChat = async () => {
        await page.getByRole('button', { name: 'Show chats', exact: true }).click();
        await page.getByRole('button', { name: 'New side chat', exact: true }).click();
        await expect(composer).toHaveValue('');
      };
      await newChat();
      const recalled = await send(
        'What hotel preference have I asked you to remember? Use one sentence.',
      );
      assert.match(recalled.reply.text, /quiet/i);
      assert.match(recalled.reply.text, /nightlife/i);
      assert(!recalled.wire.some(isMemoryReview));
      const unchanged = structuredClone(f.store.read().memories);
      const ordinary = await send('I prefer jazz in the evening. Suggest one relaxing activity.');
      assert.deepEqual(ordinary.state.memories, unchanged);
      assert(!ordinary.wire.some(isMemoryReview));
      assert.equal(ordinary.state.profile.memoryLearning, false);
      await composer.fill('Keep my next travel question.');
      await page.reload();
      await expect(composer).toHaveValue('Keep my next travel question.');
      assert.deepEqual(f.store.read().memories, unchanged);
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await dialog.getByRole('button', { name: 'My memories', exact: true }).click();
      await expect(
        dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await expect(dialog.getByText(note.text, { exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `memory-explicit-${width}.png`) });
      record.passed = true;
      console.log(
        JSON.stringify({
          width,
          live,
          passed: true,
          turns: record.turns.map((t) => ({ text: t.text, reply: t.reply })),
        }),
      );
    } catch (error) {
      record.error = error.stack;
      throw error;
    } finally {
      await writeFile(
        join(evidence, `memory-explicit-${width}-transport.json`),
        JSON.stringify({ requests, responses: await Promise.all(responses) }, null, 2),
      );
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  await writeFile(
    join(evidence, 'memory-explicit-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: results.length > 0 && results.every((r) => r.passed),
        results,
      },
      null,
      2,
    ),
  );
}
