// Original chat content and an independent HTTP model for gesture acceptance.
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { profileSnapshot } from '../shared/assistant-scope.mjs';
export const question = 'Shall we meet at noon by the river?';
export const draft = 'Noon sounds lovely. I will bring the picnic.';
export const answer = 'Noon by the river it is. Your picnic note is attached.';
export async function swipeReplyFixture(directory, options = {}) {
  const errors = [];
  let original, file, outgoing, group, groupMessage, pip;
  const f = await assistantsFixture(directory, {
    ...options,
    configure(store) {
      store.mutate((s) => {
        const add = (text, threadId = 'main', assistantId = 'relay') =>
          appendAssistant(
            s,
            threadId,
            { text, cards: [] },
            {},
            {
              assistant: profileSnapshot(s, assistantId),
            },
          );
        for (let i = 0; i < 10; i++)
          add(`Weekend thought ${i + 1}: leave a little room to wander and enjoy the afternoon.`);
        add('You can read the [picnic guide](https://example.invalid/picnic).');
        add(
          'A little packing list:\n\n```text\n' +
            'blanket, water, sandwiches, '.repeat(15) +
            '\n```',
        );
        outgoing = {
          id: 'picnic-owner-message',
          threadId: 'main',
          role: 'user',
          text: 'A quiet picnic sounds good.',
          createdAt: new Date().toISOString(),
        };
        s.messages.push(outgoing);
        original = add(question);
        file = command(s, 'file.add', {
          name: 'Picnic note.txt',
          mime: 'text/plain',
          text: 'Bring a blanket and sandwiches.',
        });
        command(s, 'thread.update', { id: 'main', draft, draftFileIds: [file.id] });
        pip = command(s, 'assistant.create', {
          name: 'Pip',
          description: 'Help with small plans.',
          tone: 'Warm',
          avatarColor: '#a0c5ac',
        });
        group = command(s, 'group.create', {
          title: 'Picnic planning',
          participantIds: ['relay', pip.id],
        });
        groupMessage = add('I can bring a picnic checklist.', group.id, pip.id);
      });
    },
    respond(body) {
      try {
        const last = body.messages.at(-1).content;
        if (body.messages[0].content.startsWith('You are Pip,')) {
          assert.match(last, /I can bring a picnic checklist/);
          return { role: 'assistant', content: 'Pip: Your checklist is ready.' };
        }
        assert.match(last, /quoted context/);
        assert(last.includes(question));
        assert(last.includes(draft));
        assert(JSON.stringify(body.messages).includes(file.id));
        return { role: 'assistant', content: answer };
      } catch (error) {
        errors.push(error.message);
        return { role: 'assistant', content: 'Fixture failed.' };
      }
    },
  });
  return { ...f, errors, original, file, outgoing, group, groupMessage, pip };
}
