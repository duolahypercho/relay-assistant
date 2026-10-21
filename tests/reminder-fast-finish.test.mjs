// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool, toolDefinitions } from '../server/agent.mjs';
import { ModelProvider } from '../server/model.mjs';
import { dispatchRoutines } from '../shared/routines.mjs';

function fixture(t, text = 'Remind me in five minutes to drink water.') {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    s.profile.memoryLearning = false;
    return command(s, 'chat.send', { threadId: 'main', text });
  });
  return { store, run };
}
function call(name, args, id = name) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
const reminder = (extra = {}) =>
  call('create_reminder', { text: 'Drink water', delayMinutes: 5, finish: true, ...extra });
const actions = (...toolCalls) => ({ text: '', toolCalls });
const done = (text = 'Done.') => ({ text, toolCalls: [] });

test('explicit reminder completion saves and speaks once in one model step, including replay', async (t) => {
  const { store, run } = fixture(t);
  run.voiceCallId = 'synthetic-voice';
  let rounds = 0;
  const spoken = [];
  const provider = {
    complete: async (_messages, tools) => {
      rounds++;
      assert(tools.find((tool) => tool.name === 'create_reminder').parameters.properties.finish);
      assert.equal(rounds, 1, 'A verified confirmation needs no second inference');
      return actions(reminder());
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    {},
    {
      durable: true,
      onText: (text) => {
        assert.equal(store.read().routines.length, 1, 'Save precedes speech');
        spoken.push(text);
      },
    },
  );
  assert.equal(result.text, 'Reminder scheduled.');
  assert.equal(result.cards.length, 1);
  assert.equal(store.read().routines[0].instructions, 'Drink water');
  assert.deepEqual(spoken, [result.text]);
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(rounds, 1);
  assert.equal(store.read().routines.length, 1);
});

for (const finish of [undefined, false])
  test(`omitted/false completion keeps the normal model continuation (${finish})`, async (t) => {
    const { store, run } = fixture(
      t,
      'Remind me in five minutes to drink water. Explain why hydration matters.',
    );
    let rounds = 0;
    const result = await agentReply(
      store,
      {
        complete: async () =>
          ++rounds === 1
            ? actions(reminder({ finish }))
            : done('Hydration supports normal body function.'),
      },
      run,
      {},
    );
    assert.equal(rounds, 2, 'Saving a reminder alone must not cut off further model work');
    assert.equal(result.cards.length, 1);
    if (finish === false) assert.equal(result.text, 'Hydration supports normal body function.');
  });

test('a finish flag cannot discard later actions in its batch', async (t) => {
  const { store, run } = fixture(
    t,
    'Remind me in five minutes to drink water and save a plain text file named Water.txt containing Drink water.',
  );
  let rounds = 0;
  const result = await agentReply(
    store,
    {
      complete: async () =>
        ++rounds === 1
          ? actions(reminder(), call('write_note', { name: 'Water.txt', text: 'Drink water' }))
          : done('The reminder and Water.txt are ready.'),
    },
    run,
    {},
  );
  assert.equal(rounds, 2);
  assert.equal(store.read().files.length, 1);
  assert.equal(result.cards.length, 2);
  assert.equal(result.text, 'The reminder and Water.txt are ready.');
});

test('a finish flag cannot bypass a missing requested file', async (t) => {
  const { store, run } = fixture(
    t,
    'Create a plain text file named Water.txt containing Drink water. Remind me in five minutes to drink water.',
  );
  let rounds = 0;
  const result = await agentReply(
    store,
    {
      complete: async () => {
        rounds++;
        if (rounds === 1) return actions(reminder());
        if (rounds === 2)
          return actions(call('write_note', { name: 'Water.txt', text: 'Drink water' }));
        return done('Both are ready.');
      },
    },
    run,
    {},
  );
  assert.equal(rounds, 3);
  assert.equal(result.cards.length, 2);
});

test('failed saves stay silent and can be repaired before fast completion', async (t) => {
  const { store, run } = fixture(t);
  let rounds = 0;
  const spoken = [];
  const result = await agentReply(
    store,
    {
      complete: async () => {
        rounds++;
        if (rounds === 2) {
          assert.equal(store.read().routines.length, 0);
          assert.deepEqual(spoken, []);
        }
        return actions(reminder({ delayMinutes: rounds === 1 ? -1 : 5 }));
      },
    },
    run,
    {},
    { onText: (text) => spoken.push(text) },
  );
  assert.equal(rounds, 2);
  assert.deepEqual(spoken, ['Reminder scheduled.']);
  assert.equal(result.cards.length, 1);
});

test('completion checks current saved state after the tool, including a removed result', async (t) => {
  const { store, run } = fixture(t);
  let removed = false,
    rounds = 0;
  store.on('change', () => {
    if (!removed && store.read().routines.length) {
      removed = true;
      store.mutate((s) => {
        s.routines = [];
      });
    }
  });
  const spoken = [];
  await assert.rejects(
    agentReply(
      store,
      {
        complete: async () => {
          if (++rounds === 2) throw Error('Result removed; no completion was published.');
          return actions(reminder());
        },
      },
      run,
      {},
      { onText: (text) => spoken.push(text) },
    ),
    /Result removed/,
  );
  assert.equal(rounds, 2);
  assert.equal(store.read().routines.length, 0);
  assert.deepEqual(spoken, []);
});

test('a named reminder can finish immediately with an accurate paused receipt', async (t) => {
  const { store, run } = fixture(
    t,
    'Create a daily reminder called Water at 09:00 in Asia/Shanghai. Start it paused.',
  );
  let rounds = 0;
  const result = await agentReply(
    store,
    {
      complete: async () => {
        assert.equal(++rounds, 1);
        return actions(
          call('create_reminder', {
            text: 'Water',
            schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
            paused: true,
            finish: true,
          }),
        );
      },
    },
    run,
    {},
  );
  assert.equal(result.text, 'Reminder saved and paused.');
  assert.equal(store.read().routines[0].paused, true);
});

test('a due reminder uses its current delivery receipt instead of a relative-time promise', async (t) => {
  const { store, run } = fixture(t);
  store.mutate((s) => {
    s.messages.find((m) => m.id === run.messageId).createdAt = new Date(
      Date.now() - 600000,
    ).toISOString();
  });
  let delivered = false;
  store.on('change', () => {
    if (!delivered && store.read().routines.length) {
      delivered = true;
      store.mutate((s) => {
        dispatchRoutines(s, Date.now());
        s.runs.find((r) => r.routineId).status = 'completed';
      });
    }
  });
  const result = await agentReply(store, { complete: async () => actions(reminder()) }, run, {});
  assert.equal(result.text, 'Scheduling took too long; your reminder arrived late.');
});

test('an in-flight correction prevents the old reminder from ending the request', async (t) => {
  const { store, run } = fixture(t);
  let corrected = false,
    rounds = 0;
  store.on('change', () => {
    if (!corrected && store.read().routines.length) {
      corrected = true;
      store.mutate((s) =>
        command(s, 'chat.send', {
          threadId: 'main',
          text: 'Also save a plain text file named Water.txt containing Bring water.',
          delivery: 'now',
        }),
      );
    }
  });
  // Steering targets an active run, as it does in the worker.
  store.mutate((s) => {
    s.runs.find((r) => r.id === run.id).status = 'running';
  });
  const result = await agentReply(
    store,
    {
      complete: async () => {
        rounds++;
        if (rounds === 1) return actions(reminder());
        if (rounds === 2)
          return actions(call('write_note', { name: 'Water.txt', text: 'Bring water' }));
        return done('The reminder and file are ready.');
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(rounds, 3);
  assert.equal(store.read().files.length, 1);
  assert.equal(result.cards.length, 2);
});

test('completion is a boolean control, not stored reminder data or authorization', async (t) => {
  const { store, run } = fixture(t);
  const context = { threadId: run.threadId, sourceMessageId: run.messageId, runId: run.id };
  for (const finish of ['true', null, {}, 1])
    await assert.rejects(
      executeTool(store, 'create_reminder', { text: 'Water', delayMinutes: 5, finish }, context),
      /true or false/,
    );
  assert.equal(store.read().routines.length, 0);
  await assert.rejects(
    executeTool(
      store,
      'create_reminder',
      { text: 'Water', delayMinutes: 5, finish: true },
      { ...context, routineRun: true },
    ),
    /routine cannot/,
  );
  const result = await executeTool(
    store,
    'create_reminder',
    { text: 'Water', delayMinutes: 5, finish: true },
    context,
  );
  assert.equal(result.finishReminder, true);
  assert(!Object.hasOwn(store.read().routines[0], 'finish'));
  const schema = toolDefinitions.find((tool) => tool.name === 'create_reminder');
  assert(!schema.parameters.required.includes('finish'), 'Existing providers may omit it');
});

test('stopping after the save prevents speech and final completion', async (t) => {
  const { store, run } = fixture(t);
  const controller = new AbortController();
  const spoken = [];
  store.on('change', () => {
    if (store.read().routines.length) controller.abort();
  });
  await assert.rejects(
    agentReply(
      store,
      { complete: async () => actions(reminder()) },
      run,
      {},
      {
        signal: controller.signal,
        onText: (text) => spoken.push(text),
        durable: true,
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(store.read().routines.length, 1, 'Stop does not undo a completed save');
  assert.deepEqual(spoken, []);
});

test('compound continuation survives a checkpoint restart without repeating the save', async (t) => {
  const { store, run } = fixture(
    t,
    'Remind me in five minutes to drink water. Also tell me what 14 plus 27 equals.',
  );
  let rounds = 0;
  await assert.rejects(
    agentReply(
      store,
      {
        complete: async () => {
          if (++rounds === 2) throw Error('Connection interrupted');
          return actions(reminder({ finish: false }));
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Connection interrupted/,
  );
  assert.equal(store.read().routines.length, 1);
  const result = await agentReply(
    store,
    { complete: async () => done('Reminder scheduled. 14 + 27 = 41.') },
    run,
    {},
    { durable: true },
  );
  assert.equal(result.text, 'Reminder scheduled. 14 + 27 = 41.');
  assert.equal(store.read().routines.length, 1);
});

test('compound continuation receives fresh status without replacing its system prefix or answer', async (t) => {
  const { store, run } = fixture(
    t,
    'Remind me in five minutes to drink water. Also tell me what 14 plus 27 equals.',
  );
  let rounds = 0,
    system;
  const provider = new ModelProvider({
    baseUrl: 'https://model.example.test/v1',
    model: 'fixture',
    protocol: 'chat',
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (++rounds === 1) {
        system = body.messages[0];
        return Response.json({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { content: '', tool_calls: [reminder({ finish: false })] },
            },
          ],
        });
      }
      assert.deepEqual(body.messages[0], system);
      assert.match(
        body.messages.at(-1).content,
        /Current saved reminder status: "Reminder scheduled\."/,
      );
      return Response.json({
        choices: [
          { finish_reason: 'stop', message: { content: 'Reminder scheduled. 14 + 27 = 41.' } },
        ],
      });
    },
  });
  const result = await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(result.text, 'Reminder scheduled. 14 + 27 = 41.');
  assert(!JSON.stringify(store.read()).includes('Current saved reminder status:'));
});

test('a true finish flag cannot discard an answer alongside its tool call', async (t) => {
  const { store, run } = fixture(
    t,
    'Remind me in five minutes to take a break. Also tell me what 14 plus 27 equals.',
  );
  let rounds = 0;
  const spoken = [];
  const result = await agentReply(
    store,
    {
      complete: async () =>
        ++rounds === 1
          ? {
              text: 'I will set the reminder. Also, 14 plus 27 equals 41.',
              toolCalls: [reminder()],
            }
          : done('Reminder scheduled. 14 plus 27 equals 41.'),
    },
    run,
    {},
    { durable: true, onText: (text) => spoken.push(text) },
  );
  assert.equal(rounds, 2);
  assert.equal(result.text, 'Reminder scheduled. 14 plus 27 equals 41.');
  assert.deepEqual(spoken, [], 'Pre-save narration must not be spoken as a completed action');
  assert.equal(store.read().routines.length, 1);
});

test('an answer from an earlier tool round also prevents a shortened confirmation', async (t) => {
  const { store, run } = fixture(
    t,
    'Remind me in five minutes to drink water. Also tell me what 14 plus 27 equals.',
  );
  let rounds = 0;
  const result = await agentReply(
    store,
    {
      complete: async () => {
        rounds++;
        if (rounds === 1)
          return { text: '14 plus 27 equals 41.', toolCalls: [call('list_routines', {})] };
        if (rounds === 2) return actions(reminder());
        return done('Reminder scheduled. 14 plus 27 equals 41.');
      },
    },
    run,
    {},
  );
  assert.equal(rounds, 3);
  assert.match(result.text, /41/);
});

test('a selected saved method keeps its model continuation', async (t) => {
  const { store, run } = fixture(t);
  run.skill = {
    id: 'method',
    version: 1,
    title: 'Hydration plan',
    instructions: 'Create a reminder, then explain hydration.',
  };
  let rounds = 0;
  await agentReply(
    store,
    { complete: async () => (++rounds === 1 ? actions(reminder()) : done('Ready.')) },
    run,
    {},
  );
  assert.equal(rounds, 2);
});
