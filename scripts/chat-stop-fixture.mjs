// SPDX-License-Identifier: MIT
import { assistantsFixture } from './assistants-fixture.mjs';
export const initialRequest = 'Make a travel plan.';
export const queuedRequest = 'Write a packing list afterward.';
export const stoppedReply = 'Stopped work in this chat. Queued follow-ups are paused.';
export const queuedReply = 'Your queued packing list is ready.';
export async function chatStopFixture(directory, options = {}) {
  let release,
    waiting = false;
  const f = await assistantsFixture(directory, {
    ...options,
    respond: async (body) => {
      const user = body.messages.findLast((m) => m.role === 'user');
      if (user?.content === queuedRequest) return { role: 'assistant', content: queuedReply };
      if (user?.content !== initialRequest) throw Error('Stop must not reach the model.');
      waiting = true;
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        role: 'assistant',
        content: 'A late obsolete plan.',
        tool_calls: [
          {
            id: 'stale-memory',
            type: 'function',
            function: {
              name: 'remember',
              arguments: JSON.stringify({ text: 'Do not save this stopped plan.' }),
            },
          },
        ],
      };
    },
  });
  return {
    ...f,
    get waiting() {
      return waiting;
    },
    release() {
      release?.();
    },
    async close() {
      release?.();
      await f.close();
    },
  };
}
