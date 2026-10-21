// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import {
  skillSaveRequested,
  skillSaveRequired,
  skillSaveFingerprint,
  deliveredSkill,
} from '../server/skill-completion.mjs';
const request =
  'Save a reusable skill titled Packing review with slug packing-review. Do not run it.';
const method = {
  title: 'Packing review',
  slug: 'packing-review',
  instructions: 'Inputs: a packing list.\nCheck the list.\nReport missing items.',
};
const call = (name, args) => ({
  text: '',
  toolCalls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const done = { text: 'Your skill is saved.', toolCalls: [] };
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

test('only direct saved-skill requests require a result and corrections replace bound context', () => {
  for (const text of [request, 'Please create a skill for later.', '请保存一个可复用的技能。'])
    assert(skillSaveRequested(text), text);
  for (const text of [
    null,
    'How do I save a skill?',
    'Write skill instructions in chat only.',
    'Do not save a skill.',
    '"Save a skill" is an example.',
    'Save a text file.',
    'Tell me what skills can do.',
  ])
    assert.equal(skillSaveRequested(text), false, String(text));
  const run = { questionContext: { origin: { request } } };
  assert(skillSaveRequired(run, 'Packing review'));
  assert.equal(skillSaveRequired({ ...run, activeMessageId: 'new' }, 'Explain it instead.'), false);
});

test('saved methods need host provenance, intact contents and a visible Skills result', async (t) => {
  const { store, run, context } = fixture(t);
  const saved = await executeTool(
    store,
    'save_skill',
    { ...method, savedBy: { runId: 'forged' } },
    context,
  );
  const state = store.read(),
    skill = state.skills[0];
  assert.equal(skill.savedBy.runId, run.id);
  assert.equal(skill.savedBy.fingerprint, skillSaveFingerprint(skill));
  assert(deliveredSkill(state, run, [saved.card]));
  assert.equal(deliveredSkill(state, run, []), false);
  for (const patch of [
    { activeMessageId: 'later' },
    { threadId: 'other' },
    { assistant: { id: 'other' } },
  ])
    assert.equal(deliveredSkill(state, { ...run, ...patch }, [saved.card]), false);
  for (const patch of [
    { archived: true },
    { savedBy: null },
    { savedBy: { ...skill.savedBy, runId: 'unknown' } },
    { instructions: 'Changed' },
    { title: 'Changed' },
    { version: 2 },
    { files: [{ path: 'notes.txt', base64: 'eA==' }] },
  ])
    assert.equal(
      deliveredSkill({ ...state, skills: [{ ...skill, ...patch }] }, run, [saved.card]),
      false,
    );
  const next = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: request }));
  assert.equal(deliveredSkill(store.read(), next, [saved.card]), false);
});

test('direct UI data cannot forge a save receipt and ordinary skill updates retain version checks', async (t) => {
  const { store, run, context } = fixture(t);
  const initial = store.mutate((s) =>
    command(s, 'skill.create', { ...method, savedBy: { ...context } }),
  );
  assert.equal(initial.savedBy, undefined);
  const card = { kind: 'workspace', page: 'skills' };
  assert.equal(deliveredSkill(store.read(), run, [card]), false);
  await assert.rejects(
    executeTool(store, 'save_skill', { ...method, id: initial.id, version: 99 }, context),
    /changed elsewhere/,
  );
  const result = await executeTool(
    store,
    'save_skill',
    { ...method, id: initial.id, version: 1, instructions: 'Updated steps.' },
    context,
  );
  assert.equal(store.read().skills.length, 1);
  assert.equal(store.read().skills[0].version, 2);
  assert(deliveredSkill(store.read(), run, [result.card]));
});

test('a false save claim is withheld while deferred discovery saves the exact method without running it', async (t) => {
  const { store, run } = fixture(t);
  let count = 0;
  const streamed = [];
  const provider = {
    compactTools: true,
    async complete(messages, tools, options) {
      if (++count === 1) {
        assert(!tools.some((t) => t.name === 'save_skill'));
        assert(options.requiresTools);
        options.onText(done.text);
        return done;
      }
      if (count === 2) {
        assert.match(messages.at(-1).content, /no verified saved skill/);
        return call('load_tools', { names: ['save_skill'] });
      }
      if (count === 3) {
        assert(tools.some((t) => t.name === 'save_skill'));
        return call('save_skill', method);
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
    { durable: true, onText: (x) => streamed.push(x) },
  );
  assert.equal(count, 4);
  assert.deepEqual(streamed, [done.text]);
  assert.equal(store.read().skills[0].instructions, method.instructions);
  assert.equal(store.read().runs.length, 1);
  assert.equal(store.read().files.length, 0);
  assert.equal(store.read().skills.length, 1);
  assert(deliveredSkill(store.read(), run, result.cards));
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(count, 4);
});

test('repeated false completion fails honestly and restart retains the repair limit', async (t) => {
  const { store, run } = fixture(t);
  const streamed = [];
  let calls = 0;
  const provider = {
    async complete(_m, _t, o) {
      calls++;
      o.onText(done.text);
      return done;
    },
  };
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true, onText: (x) => streamed.push(x) }),
    /skill could not be verified/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(streamed, []);
  assert.equal(store.read().skills.length, 0);
  await assert.rejects(
    agentReply(store, provider, run, {}, { durable: true }),
    /skill could not be verified/,
  );
  assert.equal(calls, 3);
});

test('a disconnect after saving resumes the same method without another version', async (t) => {
  const { store, run } = fixture(t);
  let calls = 0;
  await assert.rejects(
    agentReply(
      store,
      {
        async complete() {
          if (++calls === 1) return call('save_skill', method);
          throw Error('Synthetic disconnect');
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Synthetic disconnect/,
  );
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
  assert.equal(store.read().skills.length, 1);
  assert.equal(store.read().skills[0].version, 1);
  assert(deliveredSkill(store.read(), run, result.cards));
});

test('only a completed bound specialist save satisfies a handoff continuation', async (t) => {
  const { store, run, context } = fixture(t);
  await executeTool(store, 'save_skill', method, context);
  const state = store.read(),
    skill = state.skills[0];
  const child = {
    id: 'child',
    threadId: 'child-chat',
    messageId: 'child-message',
    assistant: { id: 'helper' },
    status: 'completed',
    handoffRootId: 'root',
  };
  skill.savedBy = {
    ...skill.savedBy,
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
      childRunId: child.id,
      continuationId: continuation.id,
      status: 'completed',
    },
  ];
  assert(deliveredSkill(state, continuation));
  for (const patch of [
    { status: 'running' },
    { sourceRunId: 'wrong' },
    { continuationId: 'wrong' },
  ]) {
    const changed = structuredClone(state);
    Object.assign(changed.handoffs[0], patch);
    assert.equal(deliveredSkill(changed, continuation), false);
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
    assert.equal(deliveredSkill(changed, continuation), false);
  }
  const changed = structuredClone(state);
  changed.handoffs[0].childRunId = 'other';
  delete changed.handoffs[0].rootId;
  delete changed.runs.find((r) => r.id === 'child').handoffRootId;
  assert.equal(deliveredSkill(changed, continuation), false);
});

test('an actual required question remains available before saving', async (t) => {
  const { store, run } = fixture(
    t,
    'Save a reusable skill. First ask me which method to save, then wait.',
  );
  const result = await agentReply(
    store,
    {
      async complete() {
        return call('ask_question', { prompt: 'Which method should I save?' });
      },
    },
    run,
    {},
  );
  assert.equal(result.question.prompt, 'Which method should I save?');
  assert.equal(store.read().skills.length, 0);
});
