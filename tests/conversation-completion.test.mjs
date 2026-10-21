// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { agentReply } from '../server/agent.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { command } from '../shared/domain.mjs';
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

test('completed tool work keeps only its final answer and result cards, with full context retained for recovery', async () => {
  const store = new Store(':memory:', { sample: false });
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  const run = store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Save a short packing list.' }),
  );
  const replies = [
    {
      text: 'I will create your file.',
      toolCalls: [call('write_note', { name: 'packing.txt', text: 'Passport\nCharger\n' })],
    },
    {
      text: 'I will check the saved file.',
      toolCalls: [call('read_file', { name: 'packing.txt' })],
    },
    { text: 'Your packing list is ready.', toolCalls: [] },
  ];
  const streamed = [];
  let count = 0;
  const provider = {
    complete: async (_messages, _tools, options) => {
      const response = replies[count++];
      options.onText(response.text);
      return response;
    },
  };
  try {
    const result = await agentReply(
      store,
      provider,
      run,
      {},
      { durable: true, onText: (text) => streamed.push(text) },
    );
    assert.equal(result.text, 'Your packing list is ready.');
    assert.deepEqual(
      streamed,
      replies.map((r) => r.text),
    );
    assert.equal(result.cards.filter((c) => c.kind === 'file').length, 1);
    assert.equal(store.read().files.length, 1);
    const saved = new AgentCheckpoint(store, run.id).load();
    for (const reply of replies.slice(0, 2))
      assert(saved.messages.some((m) => m.content === reply.text));
    assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
    assert.equal(count, 3, 'Recovery must not replay completed actions.');
  } finally {
    store.close();
  }
});

test('a required question retains its current explanation without previous tool narration', async () => {
  const store = new Store(':memory:', { sample: false });
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  const run = store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Review my tasks and arrange a meeting.' }),
  );
  let count = 0;
  const provider = {
    complete: async () =>
      ++count === 1
        ? { text: 'I will check your tasks first.', toolCalls: [call('list_tasks', {})] }
        : {
            text: 'I need the day to arrange this.',
            toolCalls: [
              call('ask_question', {
                prompt: 'Which day?',
                options: [{ label: 'Monday' }, { label: 'Tuesday' }],
              }),
            ],
          },
  };
  try {
    const result = await agentReply(store, provider, run, {});
    assert.equal(result.text, 'I need the day to arrange this.');
    assert.equal(result.question.prompt, 'Which day?');
    assert.equal(count, 2);
  } finally {
    store.close();
  }
});
