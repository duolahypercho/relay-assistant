import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import { Store } from '../server/store.mjs';
import { agentReply } from '../server/agent.mjs';
test('quoted replies freeze the chosen message and reject cross-chat references before sending', () => {
  const s = createWorkspace();
  const first = command(s, 'chat.send', { threadId: 'main', text: 'An original thought' });
  const reply = command(s, 'chat.send', {
    threadId: 'main',
    text: 'A reply',
    replyToMessageId: first.messageId,
  });
  const original = s.messages.find((m) => m.id === first.messageId);
  original.text = 'A subsequent edit';
  assert.equal(s.messages.find((m) => m.id === reply.messageId).quoted.text, 'An original thought');
  const side = command(s, 'thread.create');
  const before = s.messages.length;
  assert.throws(
    () =>
      command(s, 'chat.send', { threadId: side.id, text: 'No', replyToMessageId: first.messageId }),
    /this conversation/,
  );
  assert.equal(s.messages.length, before);
});
test('reactions are local saved message state; they neither queue model work nor approve actions', () => {
  const s = createWorkspace();
  const run = command(s, 'chat.send', { threadId: 'main', text: 'A thought' });
  const runs = s.runs.length,
    messages = s.messages.length;
  command(s, 'message.react', { id: run.messageId, reaction: '❤️' });
  assert.equal(s.messages.at(-1).reaction, '❤️');
  command(s, 'message.react', { id: run.messageId, reaction: '' });
  assert.equal(s.messages.at(-1).reaction, '');
  assert.throws(
    () => command(s, 'message.react', { id: run.messageId, reaction: '<script>' }),
    /available reaction/,
  );
  assert.equal(s.runs.length, runs);
  assert.equal(s.messages.length, messages);
  assert.equal(s.approvals.length, 0);
});
test('the model receives the selected quote with the actual user reply', async () => {
  const store = new Store(':memory:');
  try {
    const run = store.mutate((s) => {
      const first = command(s, 'chat.send', { threadId: 'main', text: 'The blue notebook' });
      return command(s, 'chat.send', {
        threadId: 'main',
        text: 'Use this for Friday',
        replyToMessageId: first.messageId,
      });
    });
    await agentReply(
      store,
      {
        complete: async (messages) => {
          assert.match(messages.at(-1).content, /quoted context.*The blue notebook/s);
          assert.match(messages.at(-1).content, /My reply: Use this for Friday/);
          return { text: 'Understood.', toolCalls: [] };
        },
      },
      run,
      {},
    );
  } finally {
    store.close();
  }
});
