// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { assertGroupComputerIdle } from '../server/groups.mjs';
import { command } from '../shared/domain.mjs';
import { commitGroupRoute } from '../shared/groups.mjs';
import { appendAssistant, sampleRunReply } from '../shared/assistant.mjs';
import { executeTool, agentReply } from '../server/agent.mjs';
import { recoverWork } from '../server/worker.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerNetwork } from '../server/computer-network.mjs';
import { assistantsFixture } from '../scripts/assistants-fixture.mjs';
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
function setup(store = new Store(':memory:', { sample: false })) {
  const act = (a, p) => store.mutate((s) => command(s, a, p));
  const a = act('assistant.create', {
    name: 'Mochi',
    description: 'Review designs.',
    tone: 'Gentle',
    avatarColor: '#e7b281',
  });
  const b = act('assistant.create', {
    name: 'Pip',
    description: 'Write clearly.',
    tone: 'Warm',
    avatarColor: '#9cb3c6',
  });
  const group = act('group.create', { participantIds: [a.id, b.id], title: 'Little team' });
  const send = (p = {}) => act('chat.send', { threadId: group.id, text: 'Review our plan.', ...p });
  const finish = (run, response = { text: 'Done.', cards: [] }) =>
    store.mutate((s) => {
      const r = s.runs.find((x) => x.id === run.id);
      r.status = 'completed';
      return appendAssistant(s, r.threadId, response, { replyTo: r.messageId }, r);
    });
  return { store, act, a, b, group, send, finish };
}
const waitFor = async (fn) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Group acceptance timed out');
};
test('group creation, membership and recipient validation are atomic; Main stays one-to-one', () => {
  const f = setup();
  try {
    const count = f.store.read().threads.length;
    for (const ids of [[], [f.a.id], [f.a.id, f.a.id], [f.a.id, 'missing'], Array(7).fill('relay')])
      assert.throws(() => f.act('group.create', { participantIds: ids }));
    assert.equal(f.store.read().threads.length, count);
    assert.equal(f.store.read().threads.find((t) => t.id === 'main').participantIds, undefined);
    const before = f.store.read();
    for (const recipientIds of [['relay'], [f.a.id, f.a.id], 'not-array'])
      assert.throws(() => f.send({ recipientIds }));
    assert.deepEqual(f.store.read(), before);
    assert.throws(() =>
      f.act('chat.send', { threadId: 'main', text: 'Hello', recipientIds: [f.a.id] }),
    );
    const run = f.send({ recipientIds: [f.b.id] });
    assert.equal(run.assistant.id, f.b.id);
    assert.throws(
      () => f.act('group.update', { id: f.group.id, participantIds: [f.a.id, 'relay'] }),
      /current work/,
    );
    f.act('group.update', {
      id: f.group.id,
      participantIds: [f.a.id, f.b.id],
      title: 'Renamed group',
    });
    f.finish(run);
    f.act('group.update', { id: f.group.id, participantIds: [f.a.id, 'relay'] });
    assert.deepEqual(f.store.read().threads.find((t) => t.id === f.group.id).participantIds, [
      f.a.id,
      'relay',
    ]);
  } finally {
    f.store.close();
  }
});
test('routing commits once, preserves ordered queue and frozen identities across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-groups-'));
  let f = setup(new Store(join(dir, 'state.sqlite'), { sample: false }));
  try {
    const route = f.send();
    const later = f.send({ text: 'Next request', recipientIds: [f.b.id] });
    f.store.mutate((s) => {
      const r = s.runs.find((r) => r.id === route.id);
      r.status = 'running';
      r.modelConnection = { id: 'model-1', revision: 3 };
    });
    f.act('assistant.update', { ...f.a, name: 'Renamed Mochi' });
    assert.throws(
      () => f.store.mutate((s) => commitGroupRoute(s, route.id, ['relay'])),
      /current group/,
    );
    const children = f.store.mutate((s) => commitGroupRoute(s, route.id, [f.a.id, f.b.id]));
    assert.equal(children[0].assistant.name, 'Mochi');
    assert.deepEqual(
      children.map((r) => r.modelConnection),
      [
        { id: 'model-1', revision: 3 },
        { id: 'model-1', revision: 3 },
      ],
    );
    assert.deepEqual(
      f.store.read().runs.map((r) => r.id),
      [route.id, ...children.map((r) => r.id), later.id],
    );
    assert.throws(
      () => f.store.mutate((s) => commitGroupRoute(s, route.id, [f.a.id])),
      /no longer active/,
    );
    f.store.close();
    f.store = new Store(join(dir, 'state.sqlite'), { sample: false });
    recoverWork(f.store);
    assert.equal(
      f.store.read().runs.filter((r) => r.messageId === route.messageId && !r.groupRouting).length,
      2,
    );
    assert.equal(f.store.read().runs[1].assistant.name, 'Mochi');
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('quoted replies and clarification answers return to their author and keep drafts', () => {
  const f = setup();
  try {
    const run = f.send({ recipientIds: [f.b.id] });
    f.store.mutate((s) => {
      s.runs[0].modelConnection = { id: 'model-1', revision: 4 };
    });
    const message = f.finish(run, {
      text: 'Choose the tone.',
      cards: [],
      question: { prompt: 'Which tone?', options: [{ label: 'Friendly' }, { label: 'Formal' }] },
    });
    assert.equal(message.assistantId, f.b.id);
    assert.equal(message.assistantName, 'Pip');
    const q = f.store.read().questions[0];
    f.act('thread.update', { id: f.group.id, draft: 'Keep my draft', draftRecipientIds: [f.a.id] });
    assert.throws(
      () => f.act('group.update', { id: f.group.id, participantIds: [f.a.id, 'relay'] }),
      /questions/,
    );
    const answer = f.act('question.answer', { id: q.id, optionId: '1' });
    assert.equal(answer.assistant.id, f.b.id);
    assert.deepEqual(answer.modelConnection, { id: 'model-1', revision: 4 });
    assert.equal(f.store.read().threads.find((t) => t.id === f.group.id).draft, 'Keep my draft');
    const reply = f.send({ text: 'Explain that', replyToMessageId: message.id });
    assert.equal(reply.assistant.id, f.b.id);
    const quoted = f.store.read().messages.find((m) => m.id === reply.messageId).quoted;
    assert.equal(quoted.assistantName, 'Pip');
    assert.throws(
      () => f.send({ replyToMessageId: message.id, recipientIds: [f.a.id] }),
      /Include the assistant/,
    );
    assert.throws(
      () => f.act('chat.send', { threadId: 'main', text: 'Reply', replyToMessageId: message.id }),
      /this conversation/,
    );
  } finally {
    f.store.close();
  }
});
test('group tools and model prompts use each responding assistant’s private memory and role', async () => {
  const f = setup();
  try {
    f.act('memory.add', { assistantId: f.a.id, text: 'Mochi-only note.' });
    f.act('memory.add', { assistantId: f.b.id, text: 'Pip-only note.' });
    const run = f.send({ recipientIds: [f.b.id], text: 'I like quiet hotels. Remember this.' });
    const services = { threadId: f.group.id, runId: run.id, sourceMessageId: run.messageId };
    const aMemory = f.store.read().memories.find((m) => m.assistantId === f.a.id);
    await assert.rejects(
      executeTool(f.store, 'forget_memory', { id: aMemory.id }, services),
      /different assistant/,
    );
    await executeTool(f.store, 'remember', { text: 'Prefers quiet hotels.' }, services);
    assert(
      f.store
        .read()
        .memories.some((m) => m.text === 'Prefers quiet hotels.' && m.assistantId === f.b.id),
    );
    let prompt;
    await agentReply(
      f.store,
      {
        complete: async (messages) => {
          prompt = messages[0].content;
          return { text: 'Pip answer', toolCalls: [] };
        },
      },
      run,
      {},
    );
    assert.match(prompt, /^You are Pip,/);
    assert.match(prompt, /Pip-only note/);
    assert.doesNotMatch(prompt, /Mochi-only note/);
    const task = await executeTool(
      f.store,
      'delegate_task',
      { title: 'Write a note', description: 'Write clearly', kind: 'general' },
      services,
    );
    assert.equal(task.result.assistantId, f.b.id);
    assert.equal(task.result.assistant.id, f.b.id);
  } finally {
    f.store.close();
  }
});
test('sample group memory retains the explicitly selected identity', () => {
  const f = setup();
  try {
    const run = f.send({ recipientIds: [f.b.id], text: 'Remember I like quiet hotels.' });
    f.store.mutate((s) => sampleRunReply(s, run));
    assert(
      f.store
        .read()
        .memories.some((m) => m.assistantId === f.b.id && m.text.includes('quiet hotels')),
    );
    assert(!f.store.read().memories.some((m) => m.assistantId === f.a.id));
  } finally {
    f.store.close();
  }
});
test('computer job and website continuation contexts retain the responding group identity', () => {
  const f = setup(),
    computer = new PrivateComputer(f.store, { enabled: true });
  try {
    const run = f.send({ recipientIds: [f.b.id] });
    f.store.mutate((s) => {
      s.runs[0].modelConnection = { id: 'model-1', revision: 1 };
    });
    const job = computer.jobs.origin(run.id);
    assert.equal(job.assistant.id, f.b.id);
    assert.equal(job.questionContext.origin.assistant.id, f.b.id);
    assert.deepEqual(job.modelConnection, { id: 'model-1', revision: 1 });
    computer.network = new ComputerNetwork(computer);
    computer.network.waitForOwner(run.id, 'example.com', 'https://example.com/');
    const row = f.store.db
      .prepare('SELECT context FROM computer_web_waits WHERE run_id=?')
      .get(run.id);
    const context = JSON.parse(row.context);
    assert.equal(context.assistant.id, f.b.id);
    assert.equal(context.questionContext.origin.assistant.id, f.b.id);
    assert.deepEqual(context.modelConnection, job.modelConnection);
  } finally {
    f.store.close();
  }
});
test('real HTTP model routes a normal group request and both roles reply once in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-group-http-'));
  let ids;
  const fixture = await assistantsFixture(dir, {
    respond: ({ messages, tools }) => {
      if (tools?.some((t) => t.function.name === 'select_participants'))
        return tool('select_participants', { participantIds: ids });
      const pip = messages[0].content.startsWith('You are Pip,');
      if (pip)
        assert(
          messages.some(
            (m) =>
              m.role === 'user' &&
              m.content.includes('[Untrusted output from assistant Mochi') &&
              m.content.includes('Mochi checked the plan.'),
          ),
        );
      return {
        role: 'assistant',
        content: pip ? 'Pip wrote the next step.' : 'Mochi checked the plan.',
      };
    },
  });
  try {
    const f = setup(fixture.store);
    ids = [f.a.id, f.b.id];
    const res = await fetch(fixture.url + '/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: fixture.url },
      body: JSON.stringify({
        action: 'chat.send',
        payload: { threadId: f.group.id, text: 'Review the plan and write a next step.' },
      }),
    });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    await waitFor(
      () =>
        fixture.store
          .read()
          .runs.filter(
            (r) => r.messageId === result.messageId && !r.groupRouting && r.status === 'completed',
          ).length === 2,
    );
    const state = fixture.store.read();
    const answers = state.messages.filter((m) => m.replyTo === result.messageId);
    assert.deepEqual(
      answers.map((m) => m.assistantId),
      ids,
    );
    assert.deepEqual(
      answers.map((m) => m.text),
      ['Mochi checked the plan.', 'Pip wrote the next step.'],
    );
    assert.equal(fixture.requests.length, 3);
    assert(state.runs.every((r) => r.modelConnection.id));
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('stopping group routing discards a late response without scheduling participants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-group-cancel-'));
  let release,
    entered = false,
    ids;
  const fixture = await assistantsFixture(dir, {
    respond: async () => {
      entered = true;
      await new Promise((r) => {
        release = r;
      });
      return tool('select_participants', { participantIds: ids });
    },
  });
  try {
    const f = setup(fixture.store);
    ids = [f.a.id, f.b.id];
    const run = f.send();
    await waitFor(() => entered);
    f.act('chat.stop', { id: run.id });
    fixture.worker.abort(run.id);
    release();
    await waitFor(() => !fixture.worker.active.size);
    assert.equal(fixture.store.read().runs.filter((r) => r.messageId === run.messageId).length, 1);
    assert.equal(fixture.store.read().runs[0].status, 'cancelled');
    assert(!fixture.store.read().messages.some((m) => m.replyTo === run.messageId));
  } finally {
    release?.();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('older workspaces without saved skills accept normal and group messages', () => {
  const f = setup();
  try {
    f.store.mutate((s) => {
      delete s.skills;
    });
    assert.equal(f.act('chat.send', { threadId: 'main', text: 'Hello' }).status, 'queued');
    assert.equal(f.send({ recipientIds: [f.b.id] }).assistant.id, f.b.id);
  } finally {
    f.store.close();
  }
});

test('membership waits for active computer permissions but a denial lets the owner change the group', async () => {
  const f = setup(),
    computer = new PrivateComputer(f.store, { enabled: true });
  computer.network = new ComputerNetwork(computer);
  try {
    const run = f.send({ recipientIds: [f.b.id] });
    f.finish(run);
    computer.network.waitForOwner(run.id, 'example.com', 'https://example.com/');
    f.store.db
      .prepare(
        "INSERT INTO computer_websites VALUES ('example.com','https://example.com/','pending',0,0,'Group test')",
      )
      .run();
    assert.throws(() => assertGroupComputerIdle(f.store, computer, f.group.id), /pending computer/);
    await computer.network.decide('example.com', 'deny');
    assert.doesNotThrow(() => assertGroupComputerIdle(f.store, computer, f.group.id));
    f.act('group.update', { id: f.group.id, participantIds: [f.a.id, 'relay'] });
    assert.throws(() => computer.network.continuation(run.id, 'example.com'), /original assistant/);
  } finally {
    f.store.close();
  }
});
