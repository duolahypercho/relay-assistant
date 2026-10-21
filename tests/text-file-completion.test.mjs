// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import {
  computerFileFingerprint,
  deliveredComputerFile,
} from '../server/computer-file-delivery.mjs';
import {
  textFileCompletionRequired,
  textFileRequestText,
  deliveredTextFile,
} from '../server/text-file-completion.mjs';

const request = 'Create a plain text file named Route.txt containing Start → Finish.';
const call = (name, args) => ({
  text: '',
  toolCalls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const done = { text: 'Your file is ready.', toolCalls: [] };
function fixture(t, text = request) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    s.profile.memoryLearning = false;
    return command(s, 'chat.send', { threadId: 'main', text });
  });
  return {
    store,
    run,
    context: { runId: run.id, threadId: run.threadId, sourceMessageId: run.messageId },
  };
}

test('only explicit plain text output needs this result, and active corrections replace bound requests', () => {
  for (const text of [
    request,
    'Please save a .txt file named Empty.txt.',
    '请创建一个纯文本文件，内容为你好。',
  ])
    assert(textFileCompletionRequired({}, text), text);
  for (const text of [
    'Save a note about tomorrow.',
    'Write a note to Alex.',
    'Create a Word document.',
    'How do I create a text file?',
    '"Create a text file" is a quotation.',
    'Create a text file example in chat only.',
    'Do not create a text file.',
  ])
    assert.equal(textFileCompletionRequired({}, text), false, text);
  const run = { questionContext: { origin: { request } } };
  assert(textFileCompletionRequired(run, 'Meeting Notes'));
  assert.equal(textFileRequestText(run, 'Meeting Notes'), request);
  assert.equal(
    textFileCompletionRequired(
      { ...run, activeMessageId: 'correction' },
      'Tell me the time instead.',
    ),
    false,
  );
});

test('real text writes carry host provenance and a visible result bound to this request', async (t) => {
  const { store, run, context } = fixture(t);
  const saved = await executeTool(
    store,
    'write_note',
    { name: 'Route.txt', text: 'Start → Finish', creation: { sourceMessageId: 'forged' } },
    context,
  );
  const state = store.read(),
    file = state.files[0];
  assert.equal(file.creation.sourceMessageId, run.messageId);
  assert.equal(file.creation.fingerprint, computerFileFingerprint(file));
  assert(deliveredTextFile(state, run, [saved.card]));
  assert.equal(deliveredTextFile(state, run, []), false);
  for (const patch of [
    { activeMessageId: 'another' },
    { threadId: 'side' },
    { assistant: { id: 'another' } },
  ])
    assert.equal(deliveredTextFile(state, { ...run, ...patch }, [saved.card]), false);
  for (const patch of [
    { creation: null },
    { creation: { ...file.creation, runId: 'invented' } },
    { base64: Buffer.from('changed').toString('base64') },
    { name: 'Changed.txt' },
    { mime: 'text/markdown' },
  ])
    assert.equal(
      deliveredTextFile({ ...state, files: [{ ...file, ...patch }] }, run, [saved.card]),
      false,
    );
  assert.equal(
    deliveredComputerFile(state, run.messageId, [], [saved.card]),
    false,
    'A local write is never a computer export',
  );
});

test('uploaded and previous-request files cannot prove new creation, including a read source card', async (t) => {
  const { store, run, context } = fixture(t);
  const upload = store.mutate((s) =>
    command(s, 'file.add', {
      name: 'Upload.txt',
      mime: 'text/plain',
      text: 'input',
      base64: Buffer.from('input').toString('base64'),
      creation: { kind: 'assistant-text', ...context },
    }),
  );
  assert.equal(upload.creation, undefined);
  assert.equal(
    deliveredTextFile(store.read(), run, [{ kind: 'file', id: upload.id, purpose: 'source' }]),
    false,
  );
  const saved = await executeTool(store, 'write_note', { name: 'Route.txt', text: 'old' }, context);
  const next = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: request }));
  assert.equal(deliveredTextFile(store.read(), next, [saved.card]), false);
});

test('an intentionally empty text file is valid and a current verified computer export also qualifies', async (t) => {
  const { store, run, context } = fixture(t);
  const saved = await executeTool(store, 'write_note', { name: 'Empty.txt', text: '' }, context);
  assert.equal(store.read().files[0].size, 0);
  assert(deliveredTextFile(store.read(), run, [saved.card]));
  const state = store.read();
  delete state.files[0].creation;
  const receipt = {
    sourceId: run.messageId,
    fileId: saved.card.id,
    fingerprint: computerFileFingerprint(state.files[0]),
  };
  assert(deliveredTextFile(state, run, [saved.card], [receipt]));
  assert.equal(deliveredTextFile(state, run, [], [receipt]), false);
  assert.equal(
    deliveredTextFile(state, run, [saved.card], [{ ...receipt, sourceId: 'old' }]),
    false,
  );
  state.files[0].name = 'Renamed.txt';
  assert.equal(deliveredTextFile(state, run, [saved.card], [receipt]), false);
});

test('a completed bound handoff accepts its child file, never forged or unrelated handoff context', async (t) => {
  const { store, run, context } = fixture(t);
  await executeTool(store, 'write_note', { name: 'Child.txt', text: 'result' }, context);
  const state = store.read(),
    file = state.files[0];
  const child = {
    id: 'child',
    threadId: 'child-chat',
    messageId: 'child-message',
    assistant: { id: 'helper' },
    status: 'completed',
    handoffRootId: 'root',
  };
  file.creation = {
    ...file.creation,
    runId: child.id,
    threadId: child.threadId,
    sourceMessageId: child.messageId,
    assistantId: child.assistant.id,
  };
  const continuation = { ...run, id: 'continuation', handoffContext: { id: 'handoff' } };
  state.runs.push(child, continuation);
  state.handoffs = [
    {
      id: 'handoff',
      rootId: 'root',
      sourceRunId: run.id,
      sourceThreadId: run.threadId,
      childRunId: child.id,
      continuationId: continuation.id,
      status: 'completed',
      result: { fileIds: [file.id] },
    },
  ];
  assert(deliveredTextFile(state, continuation));
  for (const patch of [
    { status: 'running' },
    { sourceRunId: 'unrelated' },
    { continuationId: 'another' },
    { result: { fileIds: [] } },
  ]) {
    const changed = structuredClone(state);
    Object.assign(changed.handoffs[0], patch);
    assert.equal(deliveredTextFile(changed, continuation), false);
  }
  for (const patch of [
    { status: 'running' },
    { threadId: 'wrong' },
    { assistant: { id: 'other' } },
    { messageId: 'wrong' },
  ]) {
    const changed = structuredClone(state);
    Object.assign(
      changed.runs.find((r) => r.id === 'child'),
      patch,
    );
    assert.equal(deliveredTextFile(changed, continuation), false);
  }
  const changed = structuredClone(state);
  changed.handoffs[0].childRunId = 'another';
  delete changed.handoffs[0].rootId;
  delete changed.runs.find((r) => r.id === 'child').handoffRootId;
  assert.equal(deliveredTextFile(changed, continuation), false, 'Missing root IDs never match');
  const nested = structuredClone(state);
  nested.handoffs[0].childRunId = 'other-child';
  assert(
    deliveredTextFile(nested, continuation),
    'A returned nested result must retain the real handoff root',
  );
});

test('an unsupported spoken completion stays hidden, then one repair creates the actual file exactly once', async (t) => {
  const { store, run } = fixture(t);
  run.voiceCallId = 'synthetic-voice';
  const streamed = [];
  let rounds = 0;
  const provider = {
    async complete(messages, tools, options) {
      assert(tools.some((t) => t.name === 'write_note'));
      if (++rounds === 1) {
        assert(options.requiresTools);
        options.onText(done.text);
        return done;
      }
      if (rounds === 2) {
        assert.match(messages.at(-1).content, /no verified saved result/);
        return call('write_note', { name: 'Route.txt', text: 'Start → Finish' });
      }
      assert.equal(options.requiresTools, false);
      options.onText(done.text);
      return done;
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    {},
    { durable: true, onText: (t) => streamed.push(t) },
  );
  assert.equal(rounds, 3);
  assert.deepEqual(streamed, [done.text]);
  assert.equal(store.read().files.length, 1);
  assert.equal(Buffer.from(store.read().files[0].base64, 'base64').toString(), 'Start → Finish');
  assert(deliveredTextFile(store.read(), run, result.cards));
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(rounds, 3);
});

test('repeated fabricated completion fails honestly and the repair budget survives restart', async (t) => {
  const { store, run } = fixture(t);
  let calls = 0;
  const streamed = [];
  const provider = {
    async complete(_m, _t, o) {
      calls++;
      o.onText(done.text);
      return done;
    },
  };
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true, onText: (x) => streamed.push(x) }),
    /text file could not be verified/,
  );
  assert.equal(calls, 2);
  assert.equal(store.read().files.length, 0);
  assert.deepEqual(streamed, []);
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true }),
    /text file could not be verified/,
  );
  assert.equal(calls, 3);
});

test('a disconnect after a successful repaired write resumes without a duplicate', async (t) => {
  const { store, run } = fixture(t);
  let calls = 0;
  await assert.rejects(
    agentReply(
      store,
      {
        async complete() {
          if (++calls === 1) return done;
          if (calls === 2) return call('write_note', { name: 'Route.txt', text: 'Start → Finish' });
          throw Error('Synthetic disconnect');
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Synthetic disconnect/,
  );
  assert.equal(store.read().files.length, 1);
  const result = await agentReply(
    store,
    {
      async complete(_m, _t, o) {
        assert.equal(o.requiresTools, false);
        return done;
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(store.read().files.length, 1);
  assert(deliveredTextFile(store.read(), run, result.cards));
});

test('ordinary saved notes may use a document and are not forced into plain text', async (t) => {
  const { store, run } = fixture(t, 'Save a note about tomorrow.');
  let calls = 0;
  const result = await agentReply(
    store,
    {
      async complete() {
        return ++calls === 1
          ? call('save_artifact', {
              kind: 'document',
              title: 'Tomorrow',
              source: '# Tomorrow\nPack a charger.',
            })
          : done;
      },
    },
    run,
    {},
  );
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].kind, 'document');
  assert.equal(result.cards.length, 1);
});
