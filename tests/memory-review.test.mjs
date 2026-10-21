// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import {
  reviewPersonalMemory,
  memoryLearningContext,
  memorySaveReply,
} from '../server/memory-learning.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { ModelProvider } from '../server/model.mjs';
import {
  explicitMemoryRequest,
  mayContainMemoryStatement,
  learnMemory,
} from '../shared/memory.mjs';

function fixture(t) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const act = (name, p) => store.mutate((s) => command(s, name, p));
  const send = (text) => act('chat.send', { threadId: 'main', text });
  return { store, act, send };
}
const fact = {
  slot: 0,
  text: 'Prefers vegetarian dinners without mushrooms.',
  evidence: 'I prefer vegetarian dinners without mushrooms',
};
const answer = (memories) => ({ text: JSON.stringify({ memories }), toolCalls: [] });
const proposal = (memories) => ({
  text: '',
  toolCalls: [
    {
      id: 'memory-proposal',
      function: { name: 'propose_memories', arguments: JSON.stringify({ memories }) },
    },
  ],
});

test('ordinary questions and tasks skip memory inference, while direct English and Chinese statements remain eligible', async (t) => {
  const { store, send } = fixture(t);
  for (const text of [
    'What food preferences should you keep in mind for my dinners? Use one sentence.',
    'Suggest dinner.',
    'Summarize this quote: I prefer quiet hotels.',
    'Do I prefer quiet hotels?',
    '我的偏好是什么？',
  ]) {
    let called = false;
    const result = await reviewPersonalMemory(
      store,
      {
        complete: async () => {
          called = true;
          return proposal([fact]);
        },
      },
      send(text),
    );
    assert.deepEqual(result, []);
    assert.equal(called, false);
  }
  for (const text of [
    'I prefer vegetarian dinners.',
    'For future dinner ideas, I prefer vegetarian dishes without mushrooms.',
    'My dinner preference has changed: include mushrooms now.',
    '我喜欢安静的酒店。',
    '请记住我喜欢素食。',
  ])
    assert(mayContainMemoryStatement({ role: 'user', text }), text);
  for (const text of [
    'Remember that Friday is for reading.',
    'Please remember my quiet-hotel preference.',
    'I prefer quiet hotels. Remember this.',
    '请记住我喜欢素食。',
  ])
    assert(explicitMemoryRequest({ role: 'user', text }), text);
  for (const text of [
    'I prefer jazz for background music.',
    'Do you remember my dinners?',
    'Do not remember this.',
    'Don’t remember this.',
    '“Remember I like jazz” is a quote.',
  ])
    assert(!explicitMemoryRequest({ role: 'user', text }), text);
});

test('focused review learns once from only the current owner text, then updates the same topic', async (t) => {
  const { store, send } = fixture(t);
  const run = send(fact.evidence + '. Suggest dinner.');
  let calls = 0;
  const provider = {
    complete: async (messages, tools, options) => {
      calls++;
      assert.equal(messages.length, 2);
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'propose_memories');
      assert.equal(options.maxOutputTokens, 1200);
      assert.equal(
        JSON.parse(messages[1].content).currentOwnerMessage,
        fact.evidence + '. Suggest dinner.',
      );
      return proposal([fact]);
    },
  };
  const saved = await reviewPersonalMemory(store, provider, run);
  assert.equal(saved[0].status, 'saved');
  assert.deepEqual(await reviewPersonalMemory(store, provider, run), []);
  assert.equal(calls, 1);
  const corrected = send('My dinner preference has changed: include mushrooms, still vegetarian.');
  const result = await reviewPersonalMemory(
    store,
    {
      complete: async () =>
        answer([
          {
            ...fact,
            slot: 1,
            text: 'Prefers vegetarian dinners including mushrooms.',
            evidence: 'My dinner preference has changed: include mushrooms, still vegetarian.',
          },
        ]),
    },
    corrected,
  );
  assert.equal(result[0].id, saved[0].id);
  assert.equal(result[0].status, 'updated');
  assert.equal(store.read().memories.length, 1);
});

test('source restrictions skip inference and do not process disabled learning, old or generated owner messages', async (t) => {
  for (const mutate of [
    (s) => {
      s.profile.memoryLearning = false;
    },
    (s) => {
      s.runs[0].routineId = 'routine';
    },
    (s) => {
      s.runs[0].ideaId = 'idea';
    },
    (s) => {
      s.runs[0].mailSource = {};
    },
    (s) => {
      s.messages[0].delegation = {};
    },
    (s) => {
      s.messages[0].skill = {};
    },
    (s) => {
      s.runs[0].status = 'cancelled';
    },
    (s) => {
      command(s, 'memory.add', { text: 'Owner edit after send.' });
    },
  ]) {
    const { store, send } = fixture(t);
    const run = send(fact.evidence);
    store.mutate(mutate);
    let calls = 0;
    assert.deepEqual(
      await reviewPersonalMemory(
        store,
        {
          complete: async () => {
            calls++;
            return answer([fact]);
          },
        },
        run,
      ),
      [],
    );
    assert.equal(calls, 0);
  }
});

test('late extraction cannot overwrite owner edits, restore forgotten notes, or save after learning is disabled', async (t) => {
  for (const action of ['memory.update', 'memory.delete', 'profile.update']) {
    const { store, act, send } = fixture(t);
    const note = act('memory.add', { text: 'Prefers quiet dinners.' });
    const run = send(fact.evidence);
    const provider = {
      complete: async () => {
        act(
          action,
          action === 'profile.update'
            ? { memoryLearning: false }
            : { id: note.id, text: 'Owner keeps this wording.' },
        );
        return answer([{ ...fact, slot: 1 }]);
      },
    };
    assert.deepEqual(await reviewPersonalMemory(store, provider, run), []);
    assert(!store.read().memories.some((m) => m.text === fact.text || m.proposal));
  }
});

test('invalid output, tool names, unquoted evidence and model failures cannot write notes or fail the main answer', async (t) => {
  const { store, send } = fixture(t),
    run = send(fact.evidence);
  for (const output of [
    { text: 'not JSON', toolCalls: [] },
    answer([fact, fact, fact, fact]),
    answer([{ ...fact, evidence: 'An external fact' }]),
    {
      text: '',
      toolCalls: [
        { function: { name: 'remember', arguments: JSON.stringify({ text: fact.text }) } },
      ],
    },
    null,
  ]) {
    assert.deepEqual(
      await reviewPersonalMemory(
        store,
        {
          complete: async () => {
            if (output === null) throw Error('offline');
            return output;
          },
        },
        run,
      ),
      [],
    );
  }
  assert.equal(store.read().memories.length, 0);
});

test('stopping during review aborts without saving even if a model ignores cancellation', async (t) => {
  const { store, send } = fixture(t),
    run = send(fact.evidence);
  const controller = new AbortController();
  await assert.rejects(
    reviewPersonalMemory(
      store,
      {
        complete: async () => {
          controller.abort();
          return answer([fact]);
        },
      },
      run,
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(store.read().memories.length, 0);
});

test('ordinary corrections cannot delete notes and learning-off cannot be bypassed with remember', async (t) => {
  const { store, act, send } = fixture(t);
  const note = act('memory.add', { text: 'Prefers quiet hotels.' });
  const run = send('My hotel preference has changed: lively hotels now.');
  const context = { runId: run.id, sourceMessageId: run.messageId, threadId: 'main' };
  await assert.rejects(
    executeTool(store, 'forget_memory', { id: note.id }, context),
    /did not ask/,
  );
  act('profile.update', { memoryLearning: false });
  const ordinary = send('I prefer jazz for background music.');
  await assert.rejects(
    executeTool(
      store,
      'remember',
      { text: 'Prefers jazz.' },
      { ...context, runId: ordinary.id, sourceMessageId: ordinary.messageId },
    ),
    /Learning from chats is off/,
  );
  assert.equal(store.read().memories.length, 1);
  const forget = send('Forget my saved hotel preference.');
  await executeTool(
    store,
    'forget_memory',
    { id: note.id },
    { ...context, runId: forget.id, sourceMessageId: forget.messageId },
  );
  assert.equal(store.read().memories.length, 0);
});

test('numbered targets bind to the frozen note identity; out-of-range or invented IDs cannot write', async (t) => {
  const { store, send } = fixture(t);
  const first = send(fact.evidence);
  const [saved] = await reviewPersonalMemory(
    store,
    { complete: async () => proposal([fact]) },
    first,
  );
  const corrected = send('My dinner preference has changed: include mushrooms now.');
  const update = {
    slot: 1,
    text: 'Prefers vegetarian dinners with mushrooms.',
    evidence: 'include mushrooms now',
  };
  const [changed] = await reviewPersonalMemory(
    store,
    {
      complete: async (messages) => {
        const data = JSON.parse(messages[1].content);
        assert.deepEqual(data.existingNotes, [{ slot: 1, text: fact.text }]);
        assert(!JSON.stringify(data).includes(saved.id));
        return proposal([update]);
      },
    },
    corrected,
  );
  assert.equal(changed.id, saved.id);
  const next = send('My dinner preference has changed: include mushrooms now.');
  for (const slot of [-1, 2, 1.5, '1', undefined])
    assert.deepEqual(
      await reviewPersonalMemory(
        store,
        { complete: async () => proposal([{ ...update, slot, memoryId: saved.id }]) },
        next,
      ),
      [],
    );
  assert.equal(store.read().memories.length, 1);
});

test('normal agent answers and shows one memory link; learning-on exposes one save action and durable finish avoids repeated inference', async (t) => {
  const { store, send } = fixture(t),
    run = send(fact.evidence + '. Suggest dinner.');
  let calls = 0;
  const provider = {
    complete: async (messages, tools) => {
      calls++;
      if (tools[0]?.name !== 'propose_memories') {
        assert(!tools.some((t) => t.name === 'learn_memory'));
        assert(!tools.some((t) => t.name === 'remember'));
        for (const prompt of [messages[0].content, messages[0].chatOnlyContent]) {
          assert.match(prompt, /The saved entries above are already stored/);
          assert.match(prompt, /"saved":\["Prefers vegetarian dinners without mushrooms\."\]/);
        }
        return { text: 'Try a vegetable bowl.', toolCalls: [] };
      }
      assert.equal(tools[0].name, 'propose_memories');
      return proposal([fact]);
    },
  };
  const result = await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(result.text, 'Try a vegetable bowl.');
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].kind, 'memory');
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(calls, 2);
});

test('a current-owner follow-up aborts stale memory review and learns only the applied correction', async (t) => {
  const { store, act, send } = fixture(t),
    run = send(fact.evidence);
  store.mutate((s) => {
    s.runs[0].status = 'running';
  });
  let reviews = 0;
  const provider = {
    complete: async (_messages, tools, options) => {
      if (tools[0]?.name !== 'propose_memories')
        return { text: 'Updated for the new request.', toolCalls: [] };
      if (++reviews === 1) {
        act('chat.send', {
          threadId: 'main',
          delivery: 'now',
          text: 'I now prefer vegetarian dinners with mushrooms.',
        });
        assert(options.signal.aborted);
        return proposal([fact]); // An uncooperative model still returns its old plan.
      }
      return proposal([
        {
          ...fact,
          text: 'Prefers vegetarian dinners with mushrooms.',
          evidence: 'I now prefer vegetarian dinners with mushrooms',
        },
      ]);
    },
  };
  const result = await agentReply(store, provider, run, {});
  assert.equal(reviews, 2);
  assert.equal(result.text, 'Updated for the new request.');
  assert.equal(store.read().memories.length, 1);
  assert.doesNotMatch(store.read().memories[0].text, /without/);
  assert.equal(store.read().memories[0].sourceMessageId, store.read().runs[0].activeMessageId);
});

test('chat-only model uses bounded JSON fallback through the real adapter without tools or extra history', async (t) => {
  const { store, send } = fixture(t),
    run = send(fact.evidence);
  let body;
  const provider = new ModelProvider({
    baseUrl: 'https://test.example/v1',
    model: 'text',
    protocol: 'chat',
    getCapabilities: async () => ({ tools: false }),
    fetcher: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        choices: [
          { message: { content: JSON.stringify({ memories: [fact] }) }, finish_reason: 'stop' },
        ],
      });
    },
  });
  assert.equal((await reviewPersonalMemory(store, provider, run))[0].status, 'saved');
  assert.equal(body.tools, undefined);
  assert.equal(body.max_tokens, 1200);
  assert.equal(body.messages.length, 2);
});

test('chat-only explicit remembering works with learning off and the reply sees actual saved facts', async (t) => {
  const { store, act, send } = fixture(t);
  act('profile.update', { memoryLearning: false });
  const run = send('Please remember this: I prefer vegetarian dinners without mushrooms.');
  const requests = [];
  const provider = new ModelProvider({
    baseUrl: 'https://test.example/v1',
    model: 'text',
    protocol: 'chat',
    getCapabilities: async () => ({ tools: false }),
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.equal(body.tools, undefined);
      const reviewing = body.messages[0].content.startsWith("Review the current owner's message");
      if (!reviewing) {
        assert.match(body.messages[0].content, /Automatic learning is off/);
        assert.match(body.messages[0].content, /personal notes below are actually saved facts/);
        assert.match(body.messages[0].content, /Prefers vegetarian dinners without mushrooms/);
        assert.doesNotMatch(body.messages[0].content, /cannot[^.]*save memories/);
      }
      return Response.json({
        choices: [
          {
            message: {
              content: reviewing
                ? JSON.stringify({ memories: [fact] })
                : 'Saved your dinner preference.',
            },
            finish_reason: 'stop',
          },
        ],
      });
    },
  });
  const result = await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(result.text, 'Saved your dinner preference.');
  assert.equal(requests.length, 2);
  assert.equal(result.cards.filter((c) => c.kind === 'memory').length, 1);
  const memory = store.read().memories[0];
  assert.equal(memory.origin, 'manual');
  assert.equal(memory.sourceMessageId, run.messageId);
  assert.equal(memory.evidence, fact.evidence);
  assert.equal(store.read().profile.memoryLearning, false);
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(requests.length, 2);
  // An ordinary statement never starts a review while learning is off.
  await reviewPersonalMemory(
    store,
    { complete: () => assert.fail('Unexpected inference') },
    send('I prefer loud hotels.'),
  );
  assert.equal(store.read().memories.length, 1);
});

test('explicit-save review preserves source gates, exact quoting and intervening owner controls', async (t) => {
  for (const mutation of [
    (s) => {
      s.messages[0].delegation = {};
    },
    (s) => {
      s.messages[0].skill = {};
    },
    (s) => {
      s.runs[0].routineId = 'scheduled';
    },
    (s) => {
      s.runs[0].status = 'cancelled';
    },
    (s) => {
      s.threads[0].archived = true;
    },
  ]) {
    const { store, act, send } = fixture(t);
    act('profile.update', { memoryLearning: false });
    const run = send('Remember: ' + fact.evidence);
    store.mutate(mutation);
    assert.deepEqual(
      await reviewPersonalMemory(store, { complete: () => assert.fail('Invalid source') }, run),
      [],
    );
  }
  const { store, act, send } = fixture(t);
  act('profile.update', { memoryLearning: false });
  const run = send('Remember: ' + fact.evidence);
  const context = {
    runId: run.id,
    sourceMessageId: run.messageId,
    threadId: 'main',
    controlVersion: store.read().profile.memoryControlVersion,
  };
  assert.throws(
    () =>
      store.mutate((s) =>
        learnMemory(s, { ...fact, key: 'dinner', allowExplicitSave: true }, context),
      ),
    /turned off/,
  );
  assert.deepEqual(
    await reviewPersonalMemory(
      store,
      { complete: async () => answer([{ ...fact, evidence: 'an invented quote' }]) },
      run,
    ),
    [],
  );
  assert.deepEqual(
    await reviewPersonalMemory(
      store,
      {
        complete: async () => {
          act('memory.add', { text: 'Keep my own wording.' });
          return answer([fact]);
        },
      },
      run,
    ),
    [],
  );
  assert.deepEqual(
    store.read().memories.map((m) => m.text),
    ['Keep my own wording.'],
  );
});

test('explicit saves keep manual protection and do not expose a second save tool after review', async (t) => {
  const { store, act, send } = fixture(t);
  act('profile.update', { memoryLearning: false });
  const run = send('Remember: ' + fact.evidence);
  const provider = {
    complete: async (_messages, tools) => {
      if (tools[0]?.name === 'propose_memories') return proposal([fact]);
      assert(!tools.some((tool) => ['learn_memory', 'remember'].includes(tool.name)));
      return { text: 'Saved.', toolCalls: [] };
    },
  };
  await agentReply(store, provider, run, {});
  const saved = store.read().memories[0];
  const repeated = await agentReply(store, provider, send('Remember: ' + fact.evidence), {});
  assert.equal(repeated.cards.length, 0);
  assert.deepEqual(store.read().memories, [saved]);
  act('profile.update', { memoryLearning: true });
  const correction = send('My dinner preference has changed: include mushrooms now.');
  await reviewPersonalMemory(
    store,
    {
      complete: async () =>
        answer([
          {
            slot: 1,
            text: 'Prefers vegetarian dinners with mushrooms.',
            evidence: 'include mushrooms now',
          },
        ]),
    },
    correction,
  );
  assert.equal(store.read().memories[0].id, saved.id);
  assert.equal(store.read().memories[0].text, fact.text);
  assert.match(store.read().memories[0].proposal.text, /with mushrooms/);
});

test('an explicit batch saves atomically and invalidates older in-flight memory extraction', async (t) => {
  const { store, act, send } = fixture(t);
  act('profile.update', { memoryLearning: false });
  const older = send('Remember: I prefer coffee.');
  let release;
  const pending = reviewPersonalMemory(
    store,
    {
      complete: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    older,
  );
  const newer = send('Remember: I prefer quiet hotels. I prefer tea.');
  const beforeVersion = store.read().profile.memoryControlVersion;
  const observations = [];
  store.on('change', (s) =>
    observations.push({ count: s.memories.length, version: s.profile.memoryControlVersion }),
  );
  const saved = await reviewPersonalMemory(
    store,
    {
      complete: async () =>
        answer([
          { slot: 0, text: 'Prefers quiet hotels.', evidence: 'I prefer quiet hotels' },
          { slot: 0, text: 'Prefers tea.', evidence: 'I prefer tea' },
        ]),
    },
    newer,
  );
  assert.equal(saved.length, 2);
  assert.deepEqual(observations, [{ count: 2, version: beforeVersion + 1 }]);
  release(answer([{ slot: 0, text: 'Prefers coffee.', evidence: 'I prefer coffee' }]));
  assert.deepEqual(await pending, []);
  assert.deepEqual(
    store
      .read()
      .memories.map((m) => m.text)
      .sort(),
    ['Prefers quiet hotels.', 'Prefers tea.'],
  );
  assert(
    store
      .read()
      .memories.every((m) => m.origin === 'manual' && m.sourceMessageId === newer.messageId),
  );
  assert.equal(observations.length, 1);
});

test('explicitly confirming an already learned fact gives it manual protection without a duplicate', async (t) => {
  const { store, act, send } = fixture(t);
  const initial = await reviewPersonalMemory(
    store,
    { complete: async () => answer([fact]) },
    send(fact.evidence),
  );
  act('profile.update', { memoryLearning: false });
  const run = send('Please remember: ' + fact.evidence);
  const confirmed = await reviewPersonalMemory(
    store,
    { complete: async () => answer([{ ...fact, slot: 1 }]) },
    run,
  );
  assert.equal(confirmed[0].id, initial[0].id);
  assert.equal(confirmed[0].status, 'updated');
  assert.equal(store.read().memories.length, 1);
  assert.equal(store.read().memories[0].origin, 'manual');
  assert.equal(store.read().memories[0].sourceMessageId, run.messageId);
  const beforeVersion = store.read().profile.memoryControlVersion;
  const repeated = await reviewPersonalMemory(
    store,
    { complete: async () => answer([{ ...fact, slot: 1 }]) },
    send('Remember: ' + fact.evidence),
  );
  assert.equal(repeated[0].status, 'unchanged');
  assert.equal(store.read().profile.memoryControlVersion, beforeVersion + 1);
  assert.equal(store.read().memories.length, 1);
});

function localMemoryProvider(reply, requests = []) {
  return new ModelProvider({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'small-local',
    protocol: 'chat',
    replyMode: 'quick',
    getCapabilities: async () => ({
      source: 'ollama',
      tools: true,
      thinking: { values: [false, true], default: true },
    }),
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return Response.json({
        choices: [
          { message: { content: JSON.stringify(await reply(body)) }, finish_reason: 'stop' },
        ],
      });
    },
  });
}

test('local Quick memory review uses constrained proposals, preserves note identity and keeps normal replies unconstrained', async (t) => {
  const f = fixture(t),
    requests = [];
  let candidate = { previous: null, text: fact.text, evidence: fact.evidence };
  const provider = localMemoryProvider(() => ({ memories: [candidate] }), requests);
  const first = f.send(fact.evidence + '. Suggest dinner.');
  const [saved] = await reviewPersonalMemory(f.store, provider, first);
  assert.equal(saved.status, 'saved');
  const body = requests[0],
    schema = body.response_format.json_schema.schema;
  assert.equal(body.tools, undefined);
  assert.equal(body.temperature, 0);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(schema.properties.memories.maxItems, 3);
  assert.equal(schema.properties.memories.items.properties.previous.enum.length, 1);
  assert.equal(schema.properties.memories.items.properties.evidence.maxLength, 500);
  assert.match(body.messages[0].content, /host validates the source/);
  assert.doesNotMatch(body.messages[0].content, /Call propose_memories/);
  assert.equal(f.store.read().messages.length, 1);
  const corrected = f.send(
    'My dinner preference has changed: include mushrooms, still vegetarian.',
  );
  candidate = {
    previous: fact.text,
    text: 'Prefers vegetarian dinners with mushrooms.',
    evidence: 'include mushrooms, still vegetarian',
  };
  const [changed] = await reviewPersonalMemory(f.store, provider, corrected);
  assert.equal(changed.id, saved.id);
  assert.equal(changed.status, 'updated');
  assert.equal(
    requests[1].response_format.json_schema.schema.properties.memories.items.properties.previous
      .enum[1],
    fact.text,
  );
  await provider.complete([{ role: 'user', content: 'Suggest dinner.' }], []);
  assert.equal(requests[2].response_format, undefined);
  assert.equal(requests[2].temperature, undefined);
});

test('constrained memory proposals still require exact owner evidence and valid frozen targets', async (t) => {
  const f = fixture(t),
    run = f.send(fact.evidence);
  const grounded = { previous: null, text: fact.text, evidence: fact.evidence };
  for (const value of [
    { memories: [grounded], enableLearning: true },
    { memories: [{ ...grounded, memoryId: 'foreign' }] },
    { memories: [{ ...grounded, previous: 'foreign note' }] },
    { memories: [{ ...grounded, previous: 0 }] },
    { memories: [{ ...grounded, evidence: 'A fact from an external website.' }] },
    { memories: [{ ...grounded, text: 'x'.repeat(501) }] },
    { memories: [grounded, grounded, grounded, grounded] },
  ]) {
    assert.deepEqual(
      await reviewPersonalMemory(
        f.store,
        localMemoryProvider(() => value),
        run,
      ),
      [],
    );
    assert.equal(f.store.read().memories.length, 0);
  }
});

test('local constrained correction cannot overwrite protected owner wording or an intervening edit', async (t) => {
  const f = fixture(t);
  const note = f.act('memory.add', { text: 'I prefer quiet hotels.' });
  const run = f.send('My hotel preference has changed: lively hotels now.');
  const candidate = {
    previous: 'I prefer quiet hotels.',
    text: 'Prefers lively hotels.',
    evidence: 'lively hotels now',
  };
  const [proposal] = await reviewPersonalMemory(
    f.store,
    localMemoryProvider(() => ({ memories: [candidate] })),
    run,
  );
  assert.equal(proposal.status, 'proposed');
  const saved = f.store.read().memories.find((m) => m.id === note.id);
  assert.equal(saved.text, 'I prefer quiet hotels.');
  assert.equal(saved.proposal.text, candidate.text);
  const later = f.send('My hotel preference has changed: lively hotels now.');
  assert.deepEqual(
    await reviewPersonalMemory(
      f.store,
      localMemoryProvider(() => {
        f.act('memory.update', { id: note.id, text: 'Keep my latest wording.' });
        return { memories: [candidate] };
      }),
      later,
    ),
    [],
  );
  assert.equal(
    f.store.read().memories.find((m) => m.id === note.id).text,
    'Keep my latest wording.',
  );
});

test('local constrained learning respects the off switch and only explicit saves cross that boundary', async (t) => {
  const f = fixture(t),
    requests = [];
  f.act('profile.update', { memoryLearning: false });
  const provider = localMemoryProvider(
    () => ({ memories: [{ previous: null, text: fact.text, evidence: fact.evidence }] }),
    requests,
  );
  assert.deepEqual(await reviewPersonalMemory(f.store, provider, f.send(fact.evidence)), []);
  assert.equal(requests.length, 0);
  const explicit = f.send('Please remember: ' + fact.evidence);
  assert.equal((await reviewPersonalMemory(f.store, provider, explicit))[0].status, 'saved');
  assert.equal(f.store.read().memories[0].origin, 'manual');
  assert.equal(f.store.read().profile.memoryLearning, false);
  assert.equal(requests.length, 1);
});

test('memory review language hints follow recognized owner statements and leave mixed language unspecified', async (t) => {
  for (const [text, expected] of [
    ['For future trips, I prefer trains.', 'English'],
    ['我喜欢晚上喝茶。', 'Chinese'],
    ['Please remember: I prefer tea. 我喜欢爵士乐。', undefined],
    ['Please remember: Je préfère voyager en train.', undefined],
    [
      'Please remember the wording of this fictional line for this reply only: “I prefer noisy hotels.”',
      undefined,
    ],
  ]) {
    const f = fixture(t),
      requests = [];
    await reviewPersonalMemory(
      f.store,
      localMemoryProvider(() => ({ memories: [] }), requests),
      f.send(text),
    );
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].messages[1].content).noteLanguage, expected);
    const description =
      requests[0].response_format.json_schema.schema.properties.memories.items.properties.text
        .description;
    if (expected) assert(description.includes(expected));
    else assert.match(description, /without translation/);
    assert.equal(f.store.read().memories.length, 0);
  }
});

test('reply memory context follows current ownership, proposals and deletion instead of earlier save claims', async (t) => {
  const { store, act, send } = fixture(t);
  const run = send(fact.evidence);
  assert.match(memoryLearningContext(store.read(), run), /no saved personal notes/);
  const [saved] = await reviewPersonalMemory(
    store,
    { complete: async () => proposal([fact]) },
    run,
  );
  assert.match(
    memoryLearningContext(store.read(), run),
    /"saved":\["Prefers vegetarian dinners without mushrooms\."\]/,
  );
  // A different assistant's records and an earlier owner's message are never a
  // completed save for the current request.
  store.mutate((s) => {
    s.memories.push({
      id: 'other-note',
      type: 'note',
      assistantId: 'other',
      sourceMessageId: run.messageId,
      text: 'Other assistant private preference',
    });
  });
  assert.doesNotMatch(memoryLearningContext(store.read(), run), /Other assistant/);
  const correction = send('My dinner preference has changed: include mushrooms now.');
  assert.equal(memoryLearningContext(store.read(), correction), '');
  act('memory.update', { id: saved.id, text: 'Prefers vegetarian dinners without mushrooms.' });
  // Send after the manual edit so this is an eligible fresh proposal, not a
  // stale inference attempting to overwrite newer owner controls.
  const current = send('My dinner preference has changed: include mushrooms now.');
  const [update] = await reviewPersonalMemory(
    store,
    {
      complete: async () =>
        proposal([
          {
            slot: 1,
            text: 'Prefers vegetarian dinners with mushrooms.',
            evidence: 'include mushrooms now',
          },
        ]),
    },
    current,
  );
  assert.equal(update.status, 'proposed');
  const context = memoryLearningContext(store.read(), current);
  assert.match(
    context,
    /"saved":\[\],"pending":\[\{"active":"Prefers vegetarian dinners without mushrooms\.","suggested":"Prefers vegetarian dinners with mushrooms\."\}\]/,
  );
  assert.match(context, /have not replaced/);
  act('memory.delete', { id: saved.id });
  assert.match(memoryLearningContext(store.read(), current), /no saved personal notes/);
  assert.doesNotMatch(memoryLearningContext(store.read(), current), /mushrooms|Other assistant/);
});

test('completed simple preference statements acknowledge once while compound and uncertain requests still get inference', async (t) => {
  const { store, send, act } = fixture(t);
  let calls = 0;
  const provider = {
    complete: async (messages, tools) => {
      calls++;
      assert.equal(tools[0].name, 'propose_memories');
      const input = JSON.parse(messages[1].content);
      const changed = input.currentOwnerMessage.startsWith('My ');
      return proposal([
        {
          slot: input.existingNotes.length ? 1 : 0,
          text: changed ? 'Prefers vegetarian dinners with mushrooms.' : fact.text,
          evidence: changed ? input.currentOwnerMessage.split('. ')[0] + '.' : fact.evidence,
        },
      ]);
    },
  };
  const first = send(fact.evidence);
  assert.equal(memorySaveReply(store.read(), first), '', 'No acknowledgment before any save');
  const saved = await agentReply(store, provider, first, {}, { durable: true });
  assert.equal(saved.text, 'Got it — I’ll keep that in mind.');
  assert.equal(calls, 1);
  assert.deepEqual(await agentReply(store, provider, first, {}, { durable: true }), saved);
  assert.equal(calls, 1);
  const correction = send(
    'My dinner preference has changed: include mushrooms now, but keep meals vegetarian. Keep this in mind for future dinners.',
  );
  const corrected = await agentReply(store, provider, correction, {});
  assert.equal(corrected.text, saved.text);
  assert.equal(calls, 2);
  const note = store.read().memories[0];
  act('memory.update', { id: note.id, text: 'My protected dinner wording.' });
  const pending = send(
    'My dinner preference has changed: include mushrooms now, but keep meals vegetarian. Keep this in mind for future dinners.',
  );
  const proposed = await agentReply(store, provider, pending, {});
  assert.match(proposed.text, /suggested an update/);
  assert.equal(store.read().memories[0].text, 'My protected dinner wording.');
  for (const text of [
    'I prefer vegetarian dinners. Suggest one.',
    'I prefer vegetarian dinners, please book a table.',
    'I prefer vegetarian dinners and a reservation tomorrow',
    'I prefer vegetarian dinners; show the menu',
    'I prefer vegetarian dinners, what do you suggest?',
    'I prefer vegetarian dinners, compare restaurants',
    'I prefer vegetarian dinners. Translate this to Chinese.',
    'I prefer vegetarian dinners, remind me tomorrow',
    'If I prefer vegetarian dinners, help me plan.',
    '“I prefer vegetarian dinners” is fictional.',
    '我喜欢素食，帮我推荐晚餐。',
  ]) {
    const run = send(text),
      s = store.read();
    s.memories = [
      {
        id: 'test',
        type: 'note',
        text: 'A saved preference.',
        sourceMessageId: run.messageId,
        evidence: text,
      },
    ];
    assert.equal(memorySaveReply(s, run), '', text);
  }
  const simple = send(fact.evidence),
    state = store.read();
  state.memories = [
    {
      id: 'test',
      type: 'note',
      text: fact.text,
      sourceMessageId: simple.messageId,
      evidence: fact.evidence,
    },
  ];
  assert.equal(memorySaveReply(state, { ...simple, appContext: [{ id: 'calendar' }] }), '');
  assert.equal(memorySaveReply(state, { ...simple, questionContext: { origin: {} } }), '');
  state.messages.find((message) => message.id === simple.messageId).fileIds = ['attachment'];
  assert.equal(memorySaveReply(state, simple), '');
});
