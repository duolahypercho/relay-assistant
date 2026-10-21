// SPDX-License-Identifier: MIT
// Direct forgetting through a chat-only provider, using real HTTP, agent and SQLite.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { command } from '../shared/domain.mjs';
import { assistantsFixture } from './assistants-fixture.mjs';
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const expect = baseExpect.configure({ timeout: 12000 });
const live = process.argv.includes('--live');
const mac = process.argv.includes('--mac');
const failedSelection = process.argv.includes('--failed-selection');
assert(!(live && failedSelection), 'Failure injection is only for the controlled fixture.');
const model = process.env.RELAY_MEMORY_TEST_MODEL;
const replyMode = process.env.RELAY_MEMORY_TEST_REPLY_MODE || 'quick';
assert(['quick', 'default'].includes(replyMode));
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
if (live) assert(model && modelsDirectory, 'Choose an installed model and dedicated cache.');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/memory-forgetting');
await mkdir(evidence, { recursive: true });
const selecting = (body) =>
  /^(?:Select (?:saved personal notes|which saved notes)|Identify saved notes)/.test(
    body.messages[0].content,
  );
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const width of mac ? [1365] : live ? [390] : [1365, 390]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-memory-forgetting-'));
    let failureSent = false;
    const f = live
      ? await localModelStartFixture(directory, { modelsDirectory, isolatedPort: 41334 })
      : await assistantsFixture(directory, {
          respond(body) {
            assert(!body.tools);
            if (selecting(body)) {
              if (failedSelection && !failureSent) {
                failureSent = true;
                return { role: 'assistant', content: 'I deleted it.' };
              }
              const input = JSON.parse(body.messages.at(-1).content);
              return {
                role: 'assistant',
                content: JSON.stringify({
                  slots: input.currentOwnerMessage.includes('hotel')
                    ? input.existingNotes
                        .filter((n) => n.text.includes('hotels'))
                        .map((n) => n.slot)
                    : [],
                }),
              };
            }
            const system = body.messages[0].content;
            return {
              role: 'assistant',
              content: system.includes('operation completed')
                ? 'I forgot the saved preference you requested.'
                : system.includes('no saved personal notes to remove')
                  ? 'There are no saved personal notes to remove.'
                  : system.includes('not clearly identified')
                    ? 'Which saved preference should I forget?'
                    : 'You prefer jazz in the evening.',
            };
          },
        });
    const requests = [],
      responses = [];
    const transport = f.provider.fetcher;
    f.provider.fetcher = async (url, init) => {
      if (url.endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
      const response = await transport(url, init);
      if (url.endsWith('/chat/completions')) responses.push(response.clone().text().catch(String));
      return response;
    };
    let context, page, app;
    const record = {
      width,
      surface: mac ? 'mac' : width === 390 ? 'phone-browser' : 'desktop-browser',
      live,
      model: live ? model : 'controlled HTTP model',
      replyMode,
      failedSelection,
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
        ...(live ? { replyMode } : {}),
      });
      const hotel = f.store.mutate((s) =>
        command(s, 'memory.add', { text: 'Prefers quiet hotels away from nightlife.' }),
      );
      const music = f.store.mutate((s) =>
        command(s, 'memory.add', { text: 'Prefers jazz in the evening.' }),
      );
      if (mac) {
        await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        context = await browser.newContext({
          viewport: { width, height: 844 },
          isMobile: width === 390,
          hasTouch: width === 390,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
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
          receipt: run.memoryForgetReceipt,
          memories: state.memories,
          requests: requests.length - start,
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
        assert.equal(state.profile.memoryLearning, false);
        assert(requests.slice(start).every((body) => !body.tools));
        await expect(page.getByRole('dialog')).toHaveCount(0);
        return { state, run, reply, wire: requests.slice(start) };
      };
      const first = await send('Forget my saved hotel preference. Acknowledge in one sentence.');
      if (failedSelection) {
        assert.equal(first.run.memoryForgetReceipt, undefined);
        assert.equal(first.state.memories.length, 2);
        assert.match(first.reply.text, /couldn.t remove a saved note/);
        assert.equal(
          first.reply.cards.filter((c) => c.kind === 'memory' && c.action === 'review').length,
          1,
        );
        await page.locator('.memory-link').getByText('My memories', { exact: true }).click();
        await dialog
          .getByRole('button', { name: `Remove memory ${hotel.text}`, exact: true })
          .click();
        await expect(dialog.getByText(hotel.text, { exact: true })).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        assert.deepEqual(f.store.read().memories, [music]);
      } else {
        assert.equal(first.run.memoryForgetReceipt?.status, 'forgotten');
        assert.deepEqual(first.run.memoryForgetReceipt.ids, [hotel.id]);
        assert.deepEqual(first.state.memories, [music]);
        assert.doesNotMatch(
          first.reply.text,
          /cannot|can't|unable|open.*settings|go to.*memories/i,
        );
      }
      assert.equal(first.wire.filter(selecting).length, 1);
      assert.equal(first.reply.cards.filter((c) => c.kind === 'memory').length, 1);
      await composer.fill('Keep my next thought.');
      await page.screenshot({ path: join(evidence, `memory-forgetting-${width}.png`) });
      await page
        .locator('.memory-link')
        .filter({ hasText: failedSelection ? 'My memories' : 'Memory forgotten' })
        .click();
      await expect(dialog.getByText(music.text, { exact: true })).toBeVisible();
      await expect(dialog.getByText(hotel.text, { exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought.');
      await page.reload();
      await expect(composer).toHaveValue('Keep my next thought.');
      assert.deepEqual(f.store.read().memories, [music]);
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      const recalled = await send(
        'What personal preference do you remember about me? Use one sentence.',
      );
      assert.match(recalled.reply.text, /jazz/i);
      assert.doesNotMatch(recalled.reply.text, /hotel|nightlife/i);
      assert(!recalled.wire.some(selecting));
      const ambiguous = await send('Forget that preference I might change someday.');
      assert.equal(ambiguous.run.memoryForgetReceipt?.status, 'no_selection');
      assert.doesNotMatch(
        ambiguous.reply.text,
        /(?:can(?:not|'t|’t)|unable to)[^.!?\n]{0,70}(?:directly here|from (?:this )?chat)|can only (?:remove|delete|forget)[^.!?\n]{0,60}(?:settings|My memories)/i,
      );
      assert.deepEqual(ambiguous.state.memories, [music]);
      const all = await send('Forget all my saved memories.');
      assert.equal(all.run.memoryForgetReceipt?.status, 'forgotten');
      assert.equal(all.state.memories.length, 0);
      assert(!all.wire.some(selecting));
      const empty = await send('Forget my saved hotel preference.');
      assert.equal(empty.run.memoryForgetReceipt?.status, 'empty');
      assert(!empty.wire.some(selecting));
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
      await page?.screenshot({ path: join(evidence, `memory-forgetting-${width}-failure.png`) });
      if (page)
        await writeFile(
          join(evidence, `memory-forgetting-${width}-failure.txt`),
          await page.locator('body').innerText(),
        );
      throw error;
    } finally {
      await writeFile(
        join(evidence, `memory-forgetting-${width}-transport.json`),
        JSON.stringify({ requests, responses: await Promise.all(responses) }, null, 2),
      );
      await context?.close();
      await app?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
  await writeFile(
    join(evidence, 'memory-forgetting-acceptance.json'),
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
