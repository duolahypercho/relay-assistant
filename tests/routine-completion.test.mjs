// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { routineCreationRequested, deliveredRoutine } from '../server/routine-completion.mjs';

const request =
  'Create a daily reminder called Water the fern at 09:00 in Asia/Shanghai. Start it paused.';
const routine = {
  title: 'Water the fern',
  instructions: 'Water the fern',
  execution: 'reminder',
  schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
};
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
function fixture(t, text = request) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.profile.memoryLearning = false;
  });
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
  return { store, run };
}

test('routine tools require an explicit execution choice before saving anything', async (t) => {
  const { store } = fixture(t);
  for (const execution of [undefined, null, '', 'automatic']) {
    await assert.rejects(
      executeTool(store, 'create_routine', { ...routine, execution }, { threadId: 'main' }),
      /Choose execution.*No routine was created/,
    );
    assert.equal(store.read().routines.length, 0);
  }
  for (const execution of ['reminder', 'assistant']) {
    await executeTool(store, 'create_routine', { ...routine, execution }, { threadId: 'main' });
    const saved = store.read().routines.filter((r) => r.execution === execution);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].paused, true);
  }
  assert.equal(store.read().routines.length, 2);
});

test('routine result checks recognize direct creation but not quotes, examples, advice or negation', () => {
  for (const text of [
    request,
    'Please set up a weekly routine.',
    'Could you please create a reminder?',
    '请帮我设置一个每日提醒',
  ])
    assert(routineCreationRequested(text), text);
  for (const text of [
    null,
    '',
    '> Create a reminder',
    '“Create a reminder” is written in the document.',
    'Explain how to create a reminder.',
    'How do I create a daily routine?',
    'Create a routine example.',
    'Create a reminder outline in chat only.',
    'Do not create a reminder.',
    'Please do not create a reminder.',
    '请不要设置提醒',
    'Remind me what the note said.',
    'Open my routines.',
    'List my reminders.',
    'Create a new Word document with a reminder schedule.',
  ])
    assert.equal(routineCreationRequested(text), false, text);
});

test('unbacked spoken confirmation is withheld and repaired into a real paused reminder', async (t) => {
  const { store, run } = fixture(t);
  run.voiceCallId = 'test-voice';
  const streamed = [];
  let rounds = 0;
  const provider = {
    complete: async (messages, tools, options) => {
      rounds++;
      if (rounds === 1) {
        assert(options.requiresTools);
        options.onText('I saved your reminder.');
        return { text: 'I saved your reminder.', toolCalls: [] };
      }
      if (rounds === 2) {
        assert.match(messages.at(-1).content, /no saved routine exists/);
        return { text: '', toolCalls: [call('load_tools', { names: ['create_routine'] })] };
      }
      if (rounds === 3) {
        assert(tools.some((t) => t.name === 'create_routine'));
        return { text: '', toolCalls: [call('create_routine', routine)] };
      }
      assert.equal(options.requiresTools, false);
      options.onText('Saved, paused until you enable it.');
      return { text: 'Saved, paused until you enable it.', toolCalls: [] };
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    {},
    { durable: true, onText: (text) => streamed.push(text) },
  );
  assert.equal(store.read().routines.length, 1);
  assert.equal(store.read().routines[0].paused, true);
  assert.equal(store.read().routines[0].schedule.time, '09:00');
  assert(deliveredRoutine(store.read(), run));
  assert.deepEqual(streamed, ['Saved, paused until you enable it.']);
  assert(result.cards.some((c) => c.kind === 'reminder' && c.id === store.read().routines[0].id));
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(rounds, 4);
});

test('navigation and invented confirmation do not satisfy a missing routine, including on restart', async (t) => {
  const { store, run } = fixture(t);
  let rounds = 0;
  const provider = {
    complete: async () =>
      ++rounds === 1
        ? { text: '', toolCalls: [call('show_workspace', { page: 'routines' })] }
        : { text: 'Your reminder is ready.', toolCalls: [] },
  };
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true }),
    /reminder was not saved/,
  );
  assert.equal(rounds, 3);
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true }),
    /reminder was not saved/,
  );
  assert.equal(rounds, 4, 'Restart does not grant another repair cycle');
  assert.equal(store.read().routines.length, 0);
});

test('failed schedule validation cannot become a successful reminder claim', async (t) => {
  const { store, run } = fixture(t);
  let rounds = 0;
  const provider = {
    complete: async () =>
      ++rounds === 1
        ? {
            text: '',
            toolCalls: [
              call('create_routine', {
                ...routine,
                schedule: { kind: 'daily', time: '37:70', timeZone: 'invalid' },
              }),
            ],
          }
        : { text: 'Saved your reminder.', toolCalls: [] },
  };
  await assert.rejects(agentReply(store, provider, run, {}), /reminder was not saved/);
  assert.equal(store.read().routines.length, 0);
});

test('old, unrelated and archived routines cannot attest completion of this request', () => {
  const run = { id: 'run', messageId: 'message', threadId: 'main', assistant: { id: 'relay' } };
  const saved = { threadId: 'main', creation: { runId: 'run', sourceMessageId: 'message' } };
  assert(deliveredRoutine({ routines: [saved] }, run));
  for (const value of [
    { threadId: 'main' },
    { ...saved, threadId: 'other' },
    { ...saved, archived: true },
    { ...saved, creation: { runId: 'old', sourceMessageId: 'message' } },
    { ...saved, creation: { runId: 'run', sourceMessageId: 'old' } },
  ])
    assert.equal(deliveredRoutine({ routines: [value] }, run), false);
  assert(deliveredRoutine({ routines: [saved], runs: [run] }, { ...run, id: 'retry' }));
  assert.equal(
    deliveredRoutine(
      { routines: [saved], runs: [run] },
      { ...run, id: 'retry', assistant: { id: 'other' } },
    ),
    false,
  );
  assert.equal(
    deliveredRoutine({ routines: [saved] }, { ...run, activeMessageId: 'correction' }),
    false,
  );
});

test('a saved reminder survives a model disconnect without duplicate creation', async (t) => {
  const { store, run } = fixture(t);
  let rounds = 0;
  const first = {
    complete: async () => {
      if (++rounds === 1) return { text: '', toolCalls: [call('create_routine', routine)] };
      throw Error('Connection lost');
    },
  };
  await assert.rejects(agentReply(store, first, run, {}, { durable: true }), /Connection lost/);
  assert.equal(store.read().routines.length, 1);
  const result = await agentReply(
    store,
    {
      complete: async (_messages, _tools, options) => {
        assert.equal(options.requiresTools, false);
        return { text: 'Saved and paused.', toolCalls: [] };
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(result.text, 'Saved and paused.');
  assert.equal(store.read().routines.length, 1);
});

test('an explicit creation request can still pause for genuinely missing information', async (t) => {
  const { store, run } = fixture(t, 'Create a daily reminder.');
  const result = await agentReply(
    store,
    {
      complete: async () => ({
        text: '',
        toolCalls: [
          call('ask_question', {
            prompt: 'What should I remind you about?',
            options: [{ label: 'Water plants' }, { label: 'Take a walk' }],
          }),
        ],
      }),
    },
    run,
    {},
  );
  assert(result.question);
  assert.equal(store.read().routines.length, 0);
});
