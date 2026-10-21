// Original fixtures and an independent HTTP model for the saved-file draft flow.
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
export async function askFileFixture(directory, options = {}) {
  const files = [],
    reads = [],
    errors = [];
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store) {
      store.mutate((s) => {
        for (let i = 0; i < 9; i++)
          files.push(
            command(s, 'file.add', {
              name: i === 0 ? 'Weekend plans.txt' : `Saved note ${i}.txt`,
              mime: 'text/plain',
              text: i === 0 ? 'Meet at noon. Bring a book.' : `Original note ${i}.`,
            }),
          );
      });
    },
    respond(body) {
      try {
        const last = body.messages.at(-1);
        if (last.role !== 'tool') {
          assert(JSON.stringify(body.messages).includes(files[0].id));
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'read-saved-file',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ id: files[0].id }),
                },
              },
            ],
          };
        }
        const value = JSON.parse(last.content);
        assert(!value.error, value.error);
        assert.match(value.result.text, /Meet at noon\. Bring a book\./);
        reads.push(value.result);
        return {
          role: 'assistant',
          content: 'Your saved plan says to meet at noon and bring a book.',
        };
      } catch (error) {
        errors.push(error.message);
        return { role: 'assistant', content: 'Fixture failed.' };
      }
    },
  });
  return { ...f, files, reads, errors };
}
