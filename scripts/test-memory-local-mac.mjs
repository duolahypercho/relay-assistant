// SPDX-License-Identifier: MIT
// Controlled inference through the packaged Mac's own backend and persistent database.
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'relay-memory-local-mac-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const model = express(),
  reviews = [],
  forgetReviews = [];
model.use(express.json());
model.post('/v1/chat/completions', (req, res) => {
  let message;
  if (req.body.tools?.some((t) => t.function?.name === 'select_memories_to_forget')) {
    const input = JSON.parse(req.body.messages.at(-1).content);
    forgetReviews.push(input);
    message = {
      content: JSON.stringify({
        slots: input.existingNotes
          .filter((note) => /hotels/.test(note.text))
          .map((note) => note.slot),
      }),
    };
  } else if (req.body.tools?.some((t) => t.function?.name === 'propose_memories')) {
    const input = JSON.parse(req.body.messages.at(-1).content);
    reviews.push(input);
    const lively = input.currentOwnerMessage.includes('lively');
    const evidence = lively ? 'I now prefer lively hotels' : 'I prefer quiet hotels';
    message = {
      content: null,
      tool_calls: [
        {
          id: 'proposal',
          type: 'function',
          function: {
            name: 'propose_memories',
            arguments: JSON.stringify({
              memories: [
                {
                  slot: input.existingNotes.length ? 1 : 0,
                  text: lively ? 'Prefers lively hotels.' : 'Prefers quiet hotels.',
                  evidence,
                },
              ],
            }),
          },
        },
      ],
    };
  } else {
    const system = req.body.messages[0].content;
    message = {
      content: system.includes('Memory operation completed by Relay')
        ? 'I forgot your saved hotel preference.'
        : system.includes('Prefers lively hotels.')
          ? 'I will use your lively-hotel preference.'
          : 'I will use your quiet-hotel preference.',
    };
  }
  res.json({
    choices: [
      {
        message: { role: 'assistant', ...message },
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
  });
});
const server = model.listen(0, '127.0.0.1');
await once(server, 'listening');
let app,
  page,
  port = '0';
const launch = async () => {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${directory}`, `--relay-local-port=${port}`],
    env: {
      ...process.env,
      RELAY_DESKTOP_ENV: '',
      RELAY_MODE: 'live',
      RELAY_ACCESS_KEY: '',
      RELAY_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      RELAY_MODEL_ID: 'memory-acceptance',
      RELAY_MODEL_PROTOCOL: 'chat',
      RELAY_MODEL_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      RELAY_DESKTOP_ENABLED: 'false',
      RELAY_COMPUTER_ENABLED: 'false',
      RELAY_BROWSER_ENABLED: 'false',
    },
  });
  page = await app.firstWindow();
  port = new URL(page.url()).port;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
};
const state = () => page.evaluate(async () => (await fetch('/api/state')).json());
const composer = () => page.getByRole('textbox', { name: 'Message Relay', exact: true });
const send = async (text) => {
  const prior = (await state()).runs.length;
  await composer().fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await state()).runs.length).toBe(prior + 1);
  await expect.poll(async () => (await state()).runs.at(-1).status).toBe('completed');
};
try {
  await launch();
  await send('I prefer quiet hotels. Help me plan.');
  const saved = (await state()).memories[0];
  assert.equal(saved.text, 'Prefers quiet hotels.');
  assert.equal(saved.origin, 'learned');
  await expect(page.getByRole('button', { name: 'Memory saved', exact: true })).toBeVisible();
  await composer().fill('Keep my trip draft');
  await app.close();
  app = null;
  await launch();
  await expect(composer()).toHaveValue('Keep my trip draft');
  assert.equal((await state()).memories[0].id, saved.id);
  await page.getByRole('button', { name: 'Show chats', exact: true }).click();
  await page.getByRole('button', { name: 'New side chat', exact: true }).click();
  await send('What hotels do I prefer?');
  await expect(page.locator('.chat-workspace .message.assistant').last()).toContainText(
    'quiet-hotel',
  );
  assert.equal(reviews.length, 1, 'An ordinary question caused extra memory inference');
  await send('I now prefer lively hotels. Keep this in mind.');
  assert.equal((await state()).memories.length, 1);
  assert.equal((await state()).memories[0].id, saved.id);
  assert.equal((await state()).memories[0].text, 'Prefers lively hotels.');
  await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Your assistant', exact: true });
  await dialog.getByRole('button', { name: 'My memories', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const notes = (await state()).memories;
  await send('I prefer jazz for background music.');
  assert.deepEqual((await state()).memories, notes);
  assert.equal(reviews.length, 2);
  await send('Please remember: I prefer quiet hotels.');
  const explicit = (await state()).memories[0];
  assert.equal(explicit.id, saved.id);
  assert.equal(explicit.text, 'Prefers quiet hotels.');
  assert.equal(explicit.origin, 'manual');
  assert.equal((await state()).profile.memoryLearning, false);
  assert.equal(reviews.length, 3);
  const explicitChatId = (await state()).runs.at(-1).threadId;
  await composer().fill('Keep my next hotel question');
  await app.close();
  app = null;
  await launch();
  await expect(composer()).toHaveValue('Keep my trip draft');
  await page.goto(new URL('/#chat/' + explicitChatId, page.url()).href);
  await expect(composer()).toHaveValue('Keep my next hotel question');
  assert.deepEqual((await state()).memories[0], explicit);
  await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
  const reopenedDialog = page.getByRole('dialog', { name: 'Your assistant', exact: true });
  await reopenedDialog.getByRole('button', { name: 'My memories', exact: true }).click();
  await reopenedDialog
    .getByRole('textbox', { name: 'New memory', exact: true })
    .fill('Keep Fridays free.');
  await reopenedDialog.getByRole('button', { name: 'Add memory', exact: true }).click();
  await reopenedDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await send('Forget my saved hotel preference.');
  assert.equal(forgetReviews.length, 1);
  const forgotten = await state();
  assert.equal(forgotten.memories.length, 1);
  assert.equal(forgotten.memories[0].text, 'Keep Fridays free.');
  assert.deepEqual(forgotten.runs.at(-1).memoryForgetReceipt.ids, [explicit.id]);
  assert.equal(forgotten.profile.memoryLearning, false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.chat-workspace .message.assistant').last()).toContainText(
    'I forgot that saved note.',
  );
  await composer().fill('Keep my next hotel question');
  await app.close();
  app = null;
  await launch();
  await page.goto(new URL('/#chat/' + explicitChatId, page.url()).href);
  await expect(composer()).toHaveValue('Keep my next hotel question');
  assert.deepEqual((await state()).memories, forgotten.memories);
  assert.deepEqual(
    (await state()).runs.at(-1).memoryForgetReceipt,
    forgotten.runs.at(-1).memoryForgetReceipt,
  );
  await page.screenshot({ path: join(evidence, 'memory-local-mac.png') });
  const result = {
    passed: true,
    checkedAt: new Date().toISOString(),
    checks: [
      'Packaged app own backend saves exact-source personal memory',
      'Full app quit/relaunch preserves memory identity and unsent draft',
      'Fresh side chat receives saved context without extra memory inference',
      'Correction updates the original note',
      'Learning-off skips ordinary inference and preserves notes',
      'Explicit remembering while learning is off updates the original note with manual protection and survives another full relaunch',
      'Direct forgetting from chat preserves unrelated notes, makes a durable receipt, and survives full quit/relaunch with the draft',
    ],
    scope:
      'Unsigned arm64 Mac, controlled HTTP model, actual packaged backend/database/UI. Does not establish model judgment quality.',
  };
  await writeFile(join(evidence, 'memory-local-mac.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'memory-local-mac-failure.png') }).catch(() => {});
    await writeFile(
      join(evidence, 'memory-local-mac-failure.json'),
      JSON.stringify(
        {
          url: page.url(),
          error: error.message,
          body: await page
            .locator('body')
            .innerText()
            .catch(() => ''),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
