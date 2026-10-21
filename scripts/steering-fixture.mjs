// SPDX-License-Identifier: MIT
// Independent HTTP-model scenario, without paid credentials or owner data.
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
export const initialRequest = 'Plan the weekend.';
export const correction = 'Make it Sunday instead and use the attached notes.';
export const queuedRequest = 'Afterward, give me a packing list.';
export const correctedReply = 'Your Sunday plan uses the attached notes: meet at the garden at 10.';
export const queuedReply = 'Your packing list: water, a notebook, and a light jacket.';
export async function steeringFixture(directory, options = {}) {
  let releaseFirst,
    releaseCorrected,
    firstWaiting = false,
    correctedWaiting = false;
  const f = await assistantsFixture(directory, {
    ...options,
    respond: async (body) => {
      const last = body.messages.at(-1),
        users = body.messages.filter((m) => m.role === 'user');
      if (users.at(-1)?.content === queuedRequest)
        return { role: 'assistant', content: queuedReply };
      if (users.some((m) => m.content.includes(correction))) {
        if (last.role === 'tool') {
          assert.match(last.content, /garden at 10/);
          correctedWaiting = true;
          await new Promise((r) => (releaseCorrected = r));
          return { role: 'assistant', content: correctedReply };
        }
        const fileId = users.at(-1).content.match(/Attached workspace file IDs: (\S+)/)?.[1];
        assert(fileId);
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'read-current-notes',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ id: fileId }) },
            },
          ],
        };
      }
      assert(users.some((m) => m.content === initialRequest));
      firstWaiting = true;
      await new Promise((r) => (releaseFirst = r));
      return {
        role: 'assistant',
        content: 'Obsolete Saturday plan.',
        tool_calls: [
          {
            id: 'stale-memory',
            type: 'function',
            function: {
              name: 'remember',
              arguments: JSON.stringify({ text: 'Obsolete Saturday plan' }),
            },
          },
        ],
      };
    },
  });
  return {
    ...f,
    get firstWaiting() {
      return firstWaiting;
    },
    get correctedWaiting() {
      return correctedWaiting;
    },
    release() {
      releaseFirst?.();
      releaseCorrected?.();
    },
    async close() {
      releaseFirst?.();
      releaseCorrected?.();
      await f.close();
    },
  };
}
