// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { ModelProvider } from '../server/model.mjs';

const fileRequest = 'Create a plain text file named Route.txt containing Start → Finish.';
const fileCall = ['write_note', { name: 'Route.txt', text: 'Start → Finish' }];
const marker = /Current requested result:|Relay result check:/;
function fixture(t, text = fileRequest) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    s.profile.memoryLearning = false;
    return command(s, 'chat.send', { threadId: 'main', text });
  });
  return { store, run };
}
function response(call) {
  return Response.json({
    choices: [
      {
        finish_reason: call ? 'tool_calls' : 'stop',
        message: call
          ? {
              content: '',
              tool_calls: [
                {
                  id: 'action',
                  type: 'function',
                  function: {
                    name: call[0],
                    arguments: JSON.stringify(call[1]),
                  },
                },
              ],
            }
          : { content: 'Ready.' },
      },
    ],
  });
}
function provider(fetcher) {
  return new ModelProvider({
    baseUrl: 'https://model.example.test/v1',
    model: 'fixture',
    protocol: 'chat',
    fetcher: async (_url, options) => fetcher(JSON.parse(options.body)),
  });
}

for (const example of [
  {
    label: 'current reminder',
    request: 'Remind me in five minutes to take a break. Also tell me what 14 plus 27 equals.',
    call: ['create_reminder', { text: 'Take a break', delayMinutes: 5, finish: false }],
    missing: /no saved routine exists/,
    collection: 'routines',
  },
  {
    label: 'plain text',
    request: fileRequest,
    call: fileCall,
    missing: /plain-text file is not saved yet/,
    collection: 'files',
  },
  {
    label: 'email review',
    request:
      'Draft an email for my review to friend@example.test. Subject: "Trip". Body: "Bring a notebook."',
    call: [
      'prepare_email',
      { to: 'friend@example.test', subject: 'Trip', body: 'Bring a notebook.' },
    ],
    missing: /email saved for review is still missing/,
    collection: 'approvals',
  },
  {
    label: 'reusable skill',
    request: 'Save a reusable skill titled Packing. Do not run it.',
    call: [
      'save_skill',
      { title: 'Packing', slug: 'packing', instructions: 'Check the packing list.' },
    ],
    missing: /no verified saved skill exists/,
    collection: 'skills',
  },
])
  test(`${example.label} is guided before work without invalidating the shared system prompt`, async (t) => {
    const { store, run } = fixture(t, example.request);
    let attempts = 0,
      system;
    const result = await agentReply(
      store,
      provider((body) => {
        attempts++;
        const systemNow = body.messages.filter((m) => m.role === 'system');
        assert.doesNotMatch(JSON.stringify(systemNow), marker);
        if (attempts === 1) {
          system = structuredClone(systemNow);
          assert.equal(store.read()[example.collection].length, 0);
          assert.match(body.messages.at(-1).content, example.missing);
          assert.equal(body.messages.filter((m) => marker.test(m.content)).length, 1);
          return response(example.call);
        }
        assert.deepEqual(systemNow, system, 'Saving the result must not change the system prefix');
        assert.equal(store.read()[example.collection].length, 1);
        assert(
          !body.messages.some((m) => marker.test(m.content)),
          'Resolved status is not replayed',
        );
        return response();
      }),
      run,
      {},
      { durable: true },
    );
    assert.equal(attempts, 2);
    assert.equal(result.text, 'Ready.');
    assert.equal(store.read()[example.collection].length, 1);
    assert(result.cards.length > 0);
    if (example.collection === 'approvals')
      assert.equal(store.read().approvals[0].status, 'pending');
    if (example.collection === 'files')
      assert.equal(
        Buffer.from(store.read().files[0].base64, 'base64').toString(),
        'Start → Finish',
      );
    if (example.collection === 'skills')
      assert.equal(store.read().runs.length, 1, 'Saving a method does not run it');
  });

test('guidance neither leaks into a restarted conversation nor repeats a completed save', async (t) => {
  const { store, run } = fixture(t);
  let attempts = 0;
  await assert.rejects(
    agentReply(
      store,
      provider(() => {
        if (++attempts === 1) return response(fileCall);
        throw Error('Synthetic disconnect');
      }),
      run,
      {},
      { durable: true },
    ),
    /could not be reached/,
  );
  assert.equal(store.read().files.length, 1);
  const resumed = await agentReply(
    store,
    provider((body) => {
      assert(!body.messages.some((m) => marker.test(m.content)));
      return response();
    }),
    run,
    {},
    { durable: true },
  );
  assert.equal(resumed.cards.filter((c) => c.kind === 'file').length, 1);
  assert.equal(store.read().files.length, 1);
});

test('a failed save keeps the missing-result guidance and cannot release a success claim', async (t) => {
  const { store, run } = fixture(t);
  let attempts = 0;
  const streamed = [];
  await assert.rejects(
    agentReply(
      store,
      provider((body) => {
        attempts++;
        assert.match(body.messages.at(-1).content, /plain-text file is not saved yet/);
        if (attempts === 1) return response(['write_note', { name: 'Route.txt', text: null }]);
        assert.equal(store.read().files.length, 0);
        return response();
      }),
      run,
      {},
      { durable: true, onText: (s) => streamed.push(s) },
    ),
    /text file could not be verified/,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(streamed, []);
  assert.equal(store.read().files.length, 0);
});

test('a result removed before restart is rechecked from current state', async (t) => {
  const { store, run } = fixture(t);
  let attempts = 0;
  await assert.rejects(
    agentReply(
      store,
      provider(() => {
        if (++attempts === 1) return response(fileCall);
        throw Error('Synthetic disconnect');
      }),
      run,
      {},
      { durable: true },
    ),
    /could not be reached/,
  );
  store.mutate((s) => {
    s.files = [];
  });
  await assert.rejects(
    agentReply(
      store,
      provider((body) => {
        assert.match(body.messages.at(-1).content, /plain-text file is not saved yet/);
        return response();
      }),
      run,
      {},
      { durable: true },
    ),
    /text file could not be verified/,
  );
  assert.equal(store.read().files.length, 0);
});

test('ordinary wording requests keep the conversational path without output instructions', async (t) => {
  for (const text of [
    'Write a friendly email.',
    'Explain how to create a text file.',
    'How do I save a skill?',
  ]) {
    const { store, run } = fixture(t, text);
    let attempts = 0;
    await agentReply(
      store,
      provider((body) => {
        attempts++;
        assert(!body.messages.some((m) => marker.test(m.content)));
        return response();
      }),
      run,
      {},
      { durable: true },
    );
    assert.equal(attempts, 1);
    assert.equal(
      store.read().files.length + store.read().approvals.length + store.read().skills.length,
      0,
    );
  }
});

test('pending-question routing precedes output guidance for a separate new task', async (t) => {
  const { store, run: original } = fixture(t, 'Create a text file. Ask me for the name first.');
  const run = store.mutate((s) => {
    const old = s.runs.find((r) => r.id === original.id);
    appendAssistant(
      s,
      'main',
      {
        text: '',
        cards: [],
        question: { prompt: 'What should I name it?', options: [] },
      },
      { replyTo: old.messageId },
      old,
    );
    old.status = 'completed';
    return command(s, 'chat.send', { threadId: 'main', text: fileRequest });
  });
  let attempts = 0;
  await agentReply(
    store,
    provider((body) => {
      attempts++;
      if (attempts === 1) {
        assert(!body.messages.some((m) => marker.test(m.content)));
        assert.deepEqual(body.tools.map((t) => t.function.name).sort(), [
          'answer_question',
          'start_new_request',
        ]);
        return response(['start_new_request', {}]);
      }
      if (attempts === 2) {
        assert.match(body.messages.at(-1).content, /plain-text file is not saved yet/);
        return response(fileCall);
      }
      assert(!body.messages.some((m) => marker.test(m.content)));
      return response();
    }),
    run,
    {},
    { durable: true },
  );
  assert.equal(attempts, 3);
  assert.equal(store.read().questions[0].status, 'pending');
  assert.equal(store.read().files.length, 1);
});

test('an in-flight correction discards the old output guidance before replanning', async (t) => {
  const { store, run } = fixture(t);
  store.mutate((s) => {
    s.runs.find((r) => r.id === run.id).status = 'running';
  });
  let attempts = 0;
  await agentReply(
    store,
    provider((body) => {
      if (++attempts === 1) {
        assert.match(body.messages.at(-1).content, /plain-text file is not saved yet/);
        store.mutate((s) =>
          command(s, 'chat.send', {
            threadId: 'main',
            text: 'Actually cancel the file. Explain maps instead.',
            delivery: 'now',
          }),
        );
        return response(fileCall);
      }
      assert(!body.messages.some((m) => marker.test(m.content)));
      return response();
    }),
    run,
    {},
    { durable: true },
  );
  assert.equal(attempts, 2);
  assert.equal(store.read().files.length, 0);
});

function answeredFile(t) {
  const { store, run } = fixture(
    t,
    'Create a text file containing Start → Finish. Ask me for the filename first.',
  );
  const next = store.mutate((s) => {
    const old = s.runs.find((r) => r.id === run.id);
    appendAssistant(
      s,
      'main',
      {
        text: '',
        cards: [],
        question: { prompt: 'What would you like to name this .txt file?', options: [] },
      },
      { replyTo: old.messageId },
      old,
    );
    old.status = 'completed';
    return command(s, 'question.answer', { id: s.questions[0].id, text: 'Route' });
  });
  return {
    store,
    run: next,
    context: { runId: next.id, sourceMessageId: next.messageId, threadId: next.threadId },
  };
}

test('a repeated answered question is repaired inside the same run without another owner step', async (t) => {
  const { store, run } = answeredFile(t);
  let attempts = 0;
  await agentReply(
    store,
    provider((body) => {
      attempts++;
      if (attempts === 1) {
        assert.match(body.messages.at(-1).content, /owner has now answered/);
        return response([
          'ask_question',
          { prompt: 'What would you like to name this .txt file?' },
        ]);
      }
      if (attempts === 2) {
        const output = JSON.parse(body.messages.findLast((m) => m.role === 'tool').content);
        assert.match(output.error, /already answered/);
        assert.match(output.error, /Route/);
        assert.match(output.error, /different detail/);
        return response(fileCall);
      }
      return response();
    }),
    run,
    {},
    { durable: true },
  );
  assert.equal(attempts, 3);
  assert.equal(store.read().questions.length, 1);
  assert.equal(store.read().questions[0].status, 'answered');
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().files[0].name, 'Route.txt');
});

test('only the same bound question is rejected; new details and later corrections may ask', async (t) => {
  const { store, run, context } = answeredFile(t);
  for (const prompt of [
    '  WHAT would you like to name this .txt file？ ',
    'What would you  like to name this .txt file',
  ])
    await assert.rejects(
      executeTool(store, 'ask_question', { prompt }, context),
      /already answered/,
    );
  const clarify = await executeTool(
    store,
    'ask_question',
    { prompt: 'Which date belongs in the file?' },
    context,
  );
  assert.equal(clarify.question.prompt, 'Which date belongs in the file?');
  store.mutate((s) => {
    s.runs.find((r) => r.id === run.id).activeMessageId = 'correction';
  });
  const repeated = await executeTool(
    store,
    'ask_question',
    {
      prompt: 'What would you like to name this .txt file?',
    },
    { ...context, sourceMessageId: 'correction' },
  );
  assert(repeated.question);
  assert.equal(store.read().questions.length, 1, 'Tool proposals do not mutate saved questions');
});

test('a question without a bound run still uses normal proposal validation', async (t) => {
  const { store } = fixture(t);
  const result = await executeTool(
    store,
    'ask_question',
    { prompt: 'Which destination?' },
    { threadId: 'main' },
  );
  assert.deepEqual(result.question, { prompt: 'Which destination?', options: [] });
  await assert.rejects(
    executeTool(store, 'ask_question', { prompt: '' }, { threadId: 'main' }),
    /Question must/,
  );
});
