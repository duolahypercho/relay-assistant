// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
export const directRequest = 'Can you help me now?';
export const directReply = 'Of course. What do you need?';
export async function priorityFixture(directory, options = {}) {
  let releaseBackground, releaseForeground;
  const background = new Promise((r) => {
    releaseBackground = r;
  });
  const foreground = new Promise((r) => {
    releaseForeground = r;
  });
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store) {
      store.mutate((s) => {
        for (let i = 1; i <= 4; i++) {
          const thread = command(s, 'thread.create', { title: `Background ${i}` });
          command(s, 'chat.send', {
            threadId: thread.id,
            text: `Prepare note ${i}`,
            delivery: 'queue',
          });
        }
      });
    },
    async respond(body) {
      const text = body.messages.findLast((m) => m.role === 'user').content;
      if (text === directRequest) {
        await foreground;
        return { role: 'assistant', content: directReply };
      }
      const number = text.match(/^Prepare note (\d)$/)?.[1];
      assert(number, `Unexpected model request: ${text}`);
      if (body.messages.at(-1).role === 'tool')
        return { role: 'assistant', content: `Note ${number} is ready.` };
      await background;
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `note-${number}`,
            type: 'function',
            function: {
              name: 'write_note',
              arguments: JSON.stringify({
                name: `note-${number}.md`,
                text: `Background note ${number}, saved once.`,
              }),
            },
          },
        ],
      };
    },
  });
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await delay(25);
    }
    throw Error('Priority acceptance state did not settle');
  }
  await until(() => f.requests.length === 4);
  return {
    ...f,
    async checkPriority() {
      await until(() => f.requests.length === 5);
      assert.equal(
        f.requests[4].messages.findLast((m) => m.role === 'user').content,
        directRequest,
      );
      releaseBackground();
      await until(() => f.store.read().runs.filter((r) => r.waitingForReply).length === 4);
      assert.equal(f.store.read().files.length, 0);
      assert.equal(f.requests.length, 5);
    },
    releaseForeground,
    async verify() {
      await until(() => f.store.read().runs.every((r) => r.status === 'completed'));
      assert.equal(f.store.read().files.length, 4);
      assert.equal(f.requests.length, 9);
      assert.deepEqual(
        f.store
          .read()
          .files.map((file) => file.text)
          .sort(),
        [1, 2, 3, 4].map((i) => `Background note ${i}, saved once.`),
      );
      assert.equal(
        f.store.read().runs.some((r) => r.waitingForReply),
        false,
      );
      assert.equal(f.store.read().messages.filter((m) => m.threadId === 'main').length, 2);
    },
    async close() {
      releaseBackground();
      releaseForeground();
      await f.close();
    },
  };
}
