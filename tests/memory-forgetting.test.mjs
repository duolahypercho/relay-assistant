// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { explicitForgetAllRequest, explicitForgetRequest } from '../shared/memory.mjs';
import {
  reviewMemoryForgetting,
  memoryForgetContext,
  memoryForgetReply,
} from '../server/memory-forgetting.mjs';
import { reviewPersonalMemory } from '../server/memory-learning.mjs';
import { agentReply } from '../server/agent.mjs';
import { ModelProvider } from '../server/model.mjs';
const json = (slots) => ({ text: JSON.stringify({ slots }), toolCalls: [] });
const tool = (slots) => ({
  text: '',
  toolCalls: [
    {
      id: 'select',
      function: { name: 'select_memories_to_forget', arguments: JSON.stringify({ slots }) },
    },
  ],
});
function fixture(t, path = ':memory:') {
  const store = new Store(path, { sample: false });
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  const act = (action, p) => store.mutate((s) => command(s, action, p));
  const hotel = act('memory.add', { text: 'Prefers quiet hotels.' });
  const music = act('memory.add', { text: 'Prefers jazz in the evening.' });
  const send = (text) => act('chat.send', { threadId: 'main', text });
  return { store, act, hotel, music, send };
}
test('specific forgetting removes only selected owner notes with learning on or off', async (t) => {
  for (const enabled of [true, false]) {
    const f = fixture(t);
    f.act('profile.update', { memoryLearning: enabled });
    const assistant = f.act('assistant.create', {
      name: 'Pip',
      description: 'Independent',
      tone: 'Warm',
      avatarColor: '#88ccaa',
    });
    const other = f.act('memory.add', { assistantId: assistant.id, text: 'Prefers quiet hotels.' });
    const run = f.send('Forget my saved hotel preference.');
    const events = [];
    f.store.on('change', (s) => events.push(s.memories.map((m) => m.id)));
    const result = await reviewMemoryForgetting(
      f.store,
      {
        complete: async (messages, tools, options) => {
          assert.equal(messages.length, 2);
          assert.equal(tools.length, 1);
          assert.equal(options.maxOutputTokens, 2400);
          const body = JSON.parse(messages[1].content);
          assert(!JSON.stringify(body).includes(other.id));
          assert.equal(body.existingNotes.length, 2);
          return tool(
            body.existingNotes.filter((n) => n.text.includes('hotels')).map((n) => n.slot),
          );
        },
      },
      run,
    );
    assert.equal(result.status, 'forgotten');
    assert.deepEqual(result.ids, [f.hotel.id]);
    assert(f.store.read().memories.some((m) => m.id === f.music.id));
    assert(f.store.read().memories.some((m) => m.id === other.id));
    assert.equal(events.length, 1);
    assert.equal(f.store.read().profile.memoryLearning, enabled);
    assert.equal(f.store.read().files.length, 0);
    assert(!JSON.stringify(result).includes('quiet hotels'));
  }
});
test('an explicit all-memory request is scoped and requires no model, including Chinese', async (t) => {
  for (const text of [
    'Forget all my saved memories.',
    'Please delete all my saved personal notes.',
    '请忘记我的所有记忆。',
    '请删除我的所有记忆。',
  ]) {
    const f = fixture(t);
    const assistant = f.act('assistant.create', {
      name: 'Pip',
      description: 'Independent',
      tone: 'Warm',
      avatarColor: '#88ccaa',
    });
    const other = f.act('memory.add', { assistantId: assistant.id, text: 'Keep this.' });
    assert(explicitForgetRequest({ role: 'user', text }), text);
    assert(explicitForgetAllRequest({ role: 'user', text }), text);
    const result = await reviewMemoryForgetting(
      f.store,
      { complete: () => assert.fail('Unexpected inference') },
      f.send(text),
    );
    assert.equal(result.ids.length, 2);
    assert.deepEqual(
      f.store.read().memories.map((m) => m.id),
      [other.id],
    );
  }
  for (const text of [
    'Do not forget all my memories.',
    '“Forget all my memories” is a quote.',
    'Forget all memories except my hotel preference.',
    'Forget all preferences.',
    '请删除我的所有偏好。',
    'Forget all memories if I ask later.',
    'Can you explain how to forget all memories?',
  ])
    assert(!explicitForgetAllRequest({ role: 'user', text }), text);
});
test('ordinary requests, generated sources, stale control versions and inactive chats cannot delete', async (t) => {
  for (const change of [
    (s) => {
      s.messages[0].delegation = {};
    },
    (s) => {
      s.messages[0].skill = {};
    },
    (s) => {
      s.messages[0].role = 'assistant';
    },
    (s) => {
      s.runs[0].routineId = 'routine';
    },
    (s) => {
      s.runs[0].mailSource = {};
    },
    (s) => {
      s.runs[0].ideaId = 'idea';
    },
    (s) => {
      s.runs[0].status = 'cancelled';
    },
    (s) => {
      s.threads[0].archived = true;
    },
    (s) => {
      s.runs[0].activeMessageId = 'different';
    },
    (s) => {
      command(s, 'memory.update', { id: s.memories[0].id, text: 'Owner updated wording.' });
    },
  ]) {
    const f = fixture(t),
      run = f.send('Forget my saved hotel preference.');
    f.store.mutate(change);
    assert.equal(
      await reviewMemoryForgetting(f.store, { complete: () => assert.fail('Invalid source') }, run),
      null,
    );
    assert.equal(f.store.read().memories.length, 2);
  }
  for (const text of [
    'What hotel preference do you remember?',
    'I now prefer lively hotels.',
    'Do not forget my hotel preference.',
    'Summarize this quote: forget my hotel preference.',
  ]) {
    const f = fixture(t);
    assert.equal(
      await reviewMemoryForgetting(
        f.store,
        { complete: () => assert.fail('Not a forget request') },
        f.send(text),
      ),
      null,
    );
    assert.equal(f.store.read().memories.length, 2);
  }
});
test('invalid or ambiguous selections cannot delete or leak internal note IDs to the selector', async (t) => {
  for (const response of [
    json([0]),
    json([3]),
    json([1, 1]),
    json(['1']),
    { text: '{"slots":[1],"all":true}', toolCalls: [] },
    { text: 'not json', toolCalls: [] },
    {
      text: '',
      toolCalls: [{ function: { name: 'forget_memory', arguments: '{"id":"anything"}' } }],
    },
  ]) {
    const f = fixture(t),
      run = f.send('Forget my saved hotel preference.');
    const before = f.store.read();
    assert.equal(
      await reviewMemoryForgetting(f.store, { complete: async () => response }, run),
      null,
    );
    assert.deepEqual(f.store.read(), before);
  }
  const f = fixture(t),
    run = f.send('Forget the preference we talked about.');
  const result = await reviewMemoryForgetting(
    f.store,
    {
      complete: async (messages) => {
        assert(!JSON.stringify(messages).includes(f.hotel.id));
        return json([]);
      },
    },
    run,
  );
  assert.equal(result.status, 'no_selection');
  assert.equal(f.store.read().memories.length, 2);
  assert.match(memoryForgetContext(f.store.read(), run), /no saved notes were removed/);
});
test('changed targets abort the entire deletion batch and owner edits or cancellation win', async (t) => {
  for (const change of [
    (f) => f.act('memory.update', { id: f.hotel.id, text: 'Owner protected wording.' }),
    (f) =>
      f.store.mutate((s) => {
        s.memories.find((m) => m.id === f.hotel.id).text = 'New automatic correction.';
      }),
    (f) => f.act('profile.update', { memoryLearning: false }),
    (f) =>
      f.store.mutate((s) => {
        s.runs[0].status = 'cancelled';
      }),
  ]) {
    const f = fixture(t),
      run = f.send('Forget my hotel and music preferences.');
    const result = await reviewMemoryForgetting(
      f.store,
      {
        complete: async () => {
          change(f);
          return json([1, 2]);
        },
      },
      run,
    );
    assert.equal(result, null);
    assert.equal(f.store.read().memories.length, 2);
    assert.equal(f.store.read().runs[0].memoryForgetReceipt, undefined);
  }
  const f = fixture(t),
    controller = new AbortController(),
    run = f.send('Forget my hotel preference.');
  await assert.rejects(
    reviewMemoryForgetting(
      f.store,
      {
        complete: async () => {
          controller.abort();
          return json([2]);
        },
      },
      run,
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(f.store.read().memories.length, 2);
});
test('atomic receipts survive SQLite reopen and never delete a newly saved replacement on replay', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-forget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, 'store.sqlite')),
    run = f.send('Forget my saved hotel preference.');
  const first = await reviewMemoryForgetting(f.store, { complete: async () => json([2]) }, run);
  f.store.close();
  const reopened = new Store(join(dir, 'store.sqlite'));
  t.after(() => reopened.close());
  const replacement = reopened.mutate((s) =>
    command(s, 'memory.add', { text: 'Prefers quiet hotels.' }),
  );
  const before = reopened.read();
  const replay = await reviewMemoryForgetting(
    reopened,
    { complete: () => assert.fail('Repeated inference') },
    run,
  );
  assert.deepEqual(replay, first);
  assert.deepEqual(reopened.read(), before);
  assert(reopened.read().memories.some((m) => m.id === replacement.id));
});
test('forgetting invalidates an older pending learning pass', async (t) => {
  const f = fixture(t),
    old = f.send('I prefer quiet hotels.');
  let release;
  const pending = reviewPersonalMemory(
    f.store,
    {
      complete: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    old,
  );
  const removal = f.send('Forget my saved hotel preference.');
  await reviewMemoryForgetting(f.store, { complete: async () => json([2]) }, removal);
  release({
    text: JSON.stringify({
      memories: [{ slot: 0, text: 'Prefers quiet hotels.', evidence: 'I prefer quiet hotels' }],
    }),
    toolCalls: [],
  });
  assert.deepEqual(await pending, []);
  assert(!f.store.read().memories.some((m) => m.id === f.hotel.id));
});
test('chat-only agent gets a truthful completion result and one existing memory link with no action tools', async (t) => {
  const f = fixture(t);
  f.act('profile.update', { memoryLearning: false });
  const run = f.send('Forget my saved hotel preference.');
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
      const selecting = /^Select (?:saved personal notes|which saved notes)/.test(
        body.messages[0].content,
      );
      assert(selecting);
      assert(!body.messages[0].content.includes('This connection has no tools'));
      assert(body.messages[0].content.includes('Return ONLY a JSON object'));
      return Response.json({
        choices: [
          {
            message: {
              content: selecting ? '{"slots":[2]}' : 'I forgot your saved hotel preference.',
            },
            finish_reason: 'stop',
          },
        ],
      });
    },
  });
  const reply = await agentReply(f.store, provider, run, {}, { durable: true });
  assert.equal(requests.length, 1);
  assert.equal(reply.text, 'I forgot that saved note.');
  assert.deepEqual(reply.cards, [{ kind: 'memory', id: f.hotel.id }]);
  assert.deepEqual(await agentReply(f.store, provider, run, {}, { durable: true }), reply);
  assert.equal(requests.length, 1);
  assert.equal(reply.text, 'I forgot that saved note.');
  assert.equal(f.store.read().memories.length, 1);
});
test('empty memory is reported honestly without inference or deletion claims', async (t) => {
  const f = fixture(t);
  f.act('memory.delete', { id: f.hotel.id });
  f.act('memory.delete', { id: f.music.id });
  const run = f.send('Forget my saved hotel preference.');
  const result = await reviewMemoryForgetting(
    f.store,
    { complete: () => assert.fail('No notes to select') },
    run,
  );
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.ids, []);
  assert.match(memoryForgetContext(f.store.read(), run), /no saved personal notes/);
});

test('failed selection produces an honest host reply, never a second model claim of success', async (t) => {
  const f = fixture(t),
    run = f.send('Forget my saved hotel preference.');
  const before = f.store.read().memories;
  let calls = 0;
  const reply = await agentReply(
    f.store,
    {
      complete: async () => {
        calls++;
        return { text: 'I deleted it.', toolCalls: [] };
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(calls, 1);
  assert.equal(reply.text, 'I couldn’t remove a saved note. You can choose it in My memories.');
  assert.deepEqual(reply.cards, [{ kind: 'memory', id: 'relay', action: 'review' }]);
  assert.deepEqual(f.store.read().memories, before);
});
test('compound tasks continue with authoritative memory context; simple Chinese commands use host replies', async (t) => {
  const f = fixture(t),
    run = f.send('Forget my saved hotel preference. Suggest a relaxing activity.');
  let calls = 0;
  const reply = await agentReply(
    f.store,
    {
      complete: async (messages, tools) => {
        if (++calls === 1) return json([2]);
        assert(!tools.some((tool) => tool.name === 'forget_memory'));
        assert.match(messages[0].content, /removed 1 saved personal note/);
        assert(!messages[0].content.includes('Prefers quiet hotels.'));
        assert(messages[0].content.includes('Prefers jazz'));
        return { text: 'I forgot that note. Try listening to jazz.', toolCalls: [] };
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(calls, 2);
  assert.match(reply.text, /jazz/);
  for (const text of [
    'Forget my note and suggest preferences.',
    'Forget my preferences if I ask later.',
    '请忘记我的偏好然后推荐音乐。',
  ]) {
    const next = f.send(text);
    assert.equal(memoryForgetReply(f.store.read(), next), '');
  }
  const chinese = f.send('请删除我的所有记忆。');
  await reviewMemoryForgetting(
    f.store,
    { complete: () => assert.fail('Exact all needs no model') },
    chinese,
  );
  assert.equal(memoryForgetReply(f.store.read(), chinese), '已删除1条已保存的记忆。');
});

test('grounded selection resolves exact frozen note text and never crosses assistant scope', async (t) => {
  const f = fixture(t);
  const other = f.act('assistant.create', {
    name: 'Pip',
    description: 'Private',
    tone: 'Warm',
    avatarColor: '#88ccaa',
  });
  const privateNote = f.act('memory.add', { assistantId: other.id, text: f.music.text });
  const run = f.send('Forget my saved music preference.');
  const receipt = await reviewMemoryForgetting(
    f.store,
    {
      complete: async (messages, tools, options) => {
        assert.deepEqual(
          new Set(options.localStructuredOutput.schema.properties.forget.items.enum),
          new Set([f.hotel.text, f.music.text]),
        );
        assert(messages[0].jsonOnlyContent.includes('Copy the selected note text exactly'));
        return {
          text: JSON.stringify({ forget: [f.music.text] }),
          toolCalls: [],
          structuredOutput: true,
        };
      },
    },
    run,
  );
  assert.deepEqual(receipt.ids, [f.music.id]);
  assert.deepEqual(
    f.store.read().memories.find((n) => n.id === privateNote.id),
    privateNote,
  );
  assert(f.store.read().memories.some((n) => n.id === f.hotel.id));
  assert(!JSON.stringify(receipt).includes(f.music.text));
});

test('grounded selection rejects invented, partial, duplicate and legacy slot output without writes', async (t) => {
  for (const selection of [
    { forget: ['jazz'] },
    { forget: ['Invented note.'] },
    { forget: ['Prefers quiet hotels.', 'Prefers quiet hotels.'] },
    { forget: [1] },
    { forget: ['Prefers quiet hotels.'], all: true },
    { slots: [1] },
  ]) {
    const f = fixture(t),
      run = f.send('Forget my saved hotel preference.');
    const before = f.store.read();
    assert.equal(
      await reviewMemoryForgetting(
        f.store,
        {
          complete: async () => ({
            text: JSON.stringify(selection),
            toolCalls: [],
            structuredOutput: true,
          }),
        },
        run,
      ),
      null,
    );
    assert.deepEqual(f.store.read(), before);
  }
});

test('unresolved references ask for a target without letting a model guess a saved note', async (t) => {
  for (const text of [
    'Forget that preference.',
    'Please delete those saved notes.',
    'Forget it.',
    'Forget that preference I might change someday.',
    'Remove those saved notes we may revise later.',
    'Please forget that preference I could reconsider in the future.',
    'Forget the preference we talked about.',
    '请忘记那个偏好。',
    '忘记它。',
  ]) {
    const f = fixture(t),
      run = f.send(text);
    const before = f.store.read().memories;
    const result = await reviewMemoryForgetting(
      f.store,
      { complete: () => assert.fail('Unresolved reference reached a model') },
      run,
    );
    assert.equal(result.status, 'no_selection', text);
    assert.deepEqual(f.store.read().memories, before);
    assert.equal(
      memoryForgetReply(f.store.read(), run),
      /\p{Script=Han}/u.test(text)
        ? '你想让我忘记哪条已保存的记忆？'
        : 'Which saved note would you like me to forget?',
    );
  }
  const compound = fixture(t);
  const compoundRun = compound.send(
    'Forget that preference I might change someday. Suggest a song.',
  );
  assert.equal(memoryForgetReply(compound.store.read(), compoundRun), '');
  const f = fixture(t),
    run = f.send('Forget that preference for quiet hotels.');
  let selected = false;
  const result = await reviewMemoryForgetting(
    f.store,
    {
      complete: async () => {
        selected = true;
        return json([1]);
      },
    },
    run,
  );
  assert(selected);
  assert.equal(result.status, 'forgotten');
});

test('grounded selections still reject a note edited during inference', async (t) => {
  const f = fixture(t),
    run = f.send('Forget my saved hotel preference.');
  const result = await reviewMemoryForgetting(
    f.store,
    {
      complete: async () => {
        f.store.mutate((s) => {
          s.memories.find((n) => n.id === f.hotel.id).text = 'An updated hotel note.';
        });
        return {
          text: JSON.stringify({ forget: [f.hotel.text] }),
          toolCalls: [],
          structuredOutput: true,
        };
      },
    },
    run,
  );
  assert.equal(result, null);
  assert.equal(f.store.read().memories.length, 2);
  assert.equal(
    f.store.read().memories.find((n) => n.id === f.hotel.id).text,
    'An updated hotel note.',
  );
});

test('presentation suffixes do not erase substantive corrections or authorize unspecified targets', async (t) => {
  const f = fixture(t),
    run = f.send('Forget my saved hotel preference. No, keep it. Acknowledge in one sentence.');
  let reviewed;
  const result = await reviewMemoryForgetting(
    f.store,
    {
      complete: async (messages) => {
        reviewed = JSON.parse(messages[1].content).currentOwnerMessage;
        return json([]);
      },
    },
    run,
  );
  assert.equal(reviewed, 'Forget my saved hotel preference. No, keep it');
  assert.equal(result.status, 'no_selection');
  assert.equal(f.store.read().memories.length, 2);
  for (const request of ['Forget that preference. Confirm briefly.', 'Forget it. Reply briefly.']) {
    const result = await reviewMemoryForgetting(
      f.store,
      { complete: () => assert.fail('Unspecified target must not reach inference') },
      f.send(request),
    );
    assert.equal(result.status, 'no_selection');
  }
});
