// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { startHandoff, cancelHandoff, handoffForRun } from '../shared/handoffs.mjs';
import { reconcileHandoffs, bindHandoffRun } from '../server/handoffs.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { recoverWork } from '../server/worker.mjs';
import { learnMemory } from '../shared/memory.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerNetwork } from '../server/computer-network.mjs';
import { assistantsFixture } from '../scripts/assistants-fixture.mjs';
function fixture(store = new Store(':memory:', { sample: false })) {
  const act = (a, p) => store.mutate((s) => command(s, a, p));
  const a = act('assistant.create', {
    name: 'Mochi',
    description: 'Review designs.',
    tone: 'Gentle',
    avatarColor: '#a0c5ac',
  });
  const b = act('assistant.create', {
    name: 'Pip',
    description: 'Write clearly.',
    tone: 'Warm',
    avatarColor: '#c7a5d6',
  });
  const group = act('group.create', {
    participantIds: ['relay', a.id, b.id],
    title: 'Little team',
  });
  const send = (assistantId = 'relay', text = 'Prepare a clear plan.') =>
    act('chat.send', { threadId: group.id, recipientIds: [assistantId], text });
  const ask = (run, target = a.id, p = {}, key = 'ask-' + run.id) =>
    store.mutate((s) =>
      startHandoff(
        s,
        run.id,
        {
          assistantId: target,
          title: 'A clear plan',
          request: 'Help make this plan clearer.',
          ...p,
        },
        key,
      ),
    );
  const getRun = (id) => store.read().runs.find((r) => r.id === id);
  const finish = (run, response = { text: 'Ready.', cards: [] }) =>
    store.mutate((s) => {
      const r = s.runs.find((r) => r.id === run.id);
      r.status = 'completed';
      return appendAssistant(s, r.threadId, response, { replyTo: r.messageId }, r);
    });
  return { store, act, a, b, group, send, ask, getRun, finish };
}
const question = {
  text: 'One detail first.',
  cards: [],
  question: { prompt: 'Which tone?', options: [{ label: 'Friendly' }, { label: 'Formal' }] },
};
const toolsFor = (f, run) => ({
  terminal: { enabled: true },
  threadId: f.group.id,
  runId: run.id,
  sourceMessageId: run.messageId,
});
const waitFor = async (fn) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Group handoff timed out');
};
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('a group handoff atomically posts an attributed request and queues the target without a side chat', () => {
  const f = fixture();
  try {
    const origin = f.send();
    const before = f.store.read().threads.length;
    f.store.mutate((s) => {
      s.runs[0].modelConnection = { id: 'pinned', revision: 2 };
    });
    const h = f.ask(origin),
      child = f.getRun(h.childRunId);
    assert.equal(h.threadId, f.group.id);
    assert.equal(h.groupId, f.group.id);
    assert.equal(child.assistant.id, f.a.id);
    assert.equal(child.handoffId, h.id);
    assert.deepEqual(child.modelConnection, { id: 'pinned', revision: 2 });
    assert.equal(f.store.read().threads.length, before);
    const m = f.store.read().messages.find((m) => m.id === h.messageId);
    assert.equal(m.role, 'assistant');
    assert.equal(m.assistantName, 'Relay');
    assert.equal(m.delegation.targetName, 'Mochi');
    assert.equal(m.cards[0].id, h.id);
    assert.equal(f.ask(origin).id, h.id);
    assert.equal(f.store.read().handoffs.length, 1);
    assert.throws(() => f.ask(origin, f.a.id, { groupId: f.group.id }), /different instructions/);
  } finally {
    f.store.close();
  }
});
test('nested and independent group requests have separate ancestry even in the same transcript', () => {
  const f = fixture();
  try {
    const origin = f.send(),
      root = f.ask(origin),
      child = f.getRun(root.childRunId);
    const nested = f.ask(child, f.b.id);
    assert.equal(nested.parentId, root.id);
    assert.deepEqual(nested.path, ['relay', f.a.id, f.b.id]);
    assert.throws(() => f.ask(f.getRun(nested.childRunId), 'relay'), /loop/);
    const independent = f.ask(f.send(f.b.id, 'An unrelated request'), f.a.id);
    assert.equal(independent.parentId, null);
    assert.deepEqual(independent.path, [f.b.id, f.a.id]);
    assert.equal(
      handoffForRun(f.store.read(), f.getRun(independent.childRunId)).id,
      independent.id,
    );
    assert.equal(handoffForRun(f.store.read(), origin), undefined);
  } finally {
    f.store.close();
  }
});
test('group outcomes ignore unrelated questions, tasks and result files and return once after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-group-handoff-'));
  let store = new Store(join(dir, 'state.sqlite'), { sample: false });
  const f = fixture(store);
  try {
    const origin = f.send(),
      h = f.ask(origin);
    f.finish(origin);
    const unrelated = f.send(f.b.id, 'Separate work');
    f.finish(unrelated, question);
    const otherFile = f.act('file.add', {
      name: 'other.md',
      mime: 'text/markdown',
      text: 'Other result',
    });
    f.act('task.create', { threadId: f.group.id, title: 'Separate task', kind: 'general' });
    f.store.mutate((s) =>
      appendAssistant(
        s,
        f.group.id,
        { text: 'Unrelated result', cards: [{ kind: 'file', id: otherFile.id }] },
        { replyTo: unrelated.messageId },
        unrelated,
      ),
    );
    const file = f.act('file.add', { name: 'own.md', mime: 'text/markdown', text: 'Owned result' });
    const result = f.finish(f.getRun(h.childRunId), {
      text: 'Only my result.',
      cards: [{ kind: 'file', id: file.id }],
    });
    reconcileHandoffs(store, {});
    const done = store.read().handoffs[0];
    assert.equal(done.status, 'completed');
    assert.equal(done.result.text, 'Only my result.');
    assert.deepEqual(done.result.fileIds, [file.id]);
    assert.equal(done.result.messageId, result.id);
    const continuation = done.continuationId;
    store.close();
    store = new Store(join(dir, 'state.sqlite'), { sample: false });
    recoverWork(store);
    reconcileHandoffs(store, {});
    assert.equal(store.read().handoffs[0].continuationId, continuation);
    assert.equal(store.read().runs.filter((r) => r.handoffContext?.id === h.id).length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('stopping a group handoff cancels its descendants without touching other participants’ work', async () => {
  const f = fixture();
  try {
    const origin = f.send(),
      root = f.ask(origin),
      child = f.getRun(root.childRunId),
      nested = f.ask(child, f.b.id),
      leaf = f.getRun(nested.childRunId);
    f.finish(origin);
    f.finish(child);
    f.finish(leaf, question);
    const answer = f.act('question.answer', { id: f.store.read().questions[0].id, optionId: '1' });
    const ownedTask = await executeTool(
      f.store,
      'delegate_task',
      { title: 'Owned task', kind: 'general' },
      toolsFor(f, answer),
    );
    const ownedReview = await executeTool(
      f.store,
      'prepare_command',
      { command: 'pwd' },
      toolsFor(f, answer),
    );
    const other = f.send(f.a.id, 'Unrelated owner request');
    const otherTask = await executeTool(
      f.store,
      'delegate_task',
      { title: 'Other task', kind: 'general' },
      toolsFor(f, other),
    );
    const otherReview = await executeTool(
      f.store,
      'prepare_command',
      { command: 'ls' },
      toolsFor(f, other),
    );
    f.finish(other, question);
    const waitingOther = f.send(f.a.id, 'Keep this queued');
    const cancelled = f.act('handoff.cancel', { id: root.id });
    const s = f.store.read();
    assert(cancelled.runIds.includes(answer.id));
    assert(!cancelled.runIds.includes(waitingOther.id));
    assert.equal(s.runs.find((r) => r.id === answer.id).status, 'cancelled');
    assert.equal(s.runs.find((r) => r.id === waitingOther.id).status, 'queued');
    assert.equal(s.tasks.find((t) => t.id === ownedTask.result.id).status, 'cancelled');
    assert.equal(s.tasks.find((t) => t.id === otherTask.result.id).status, 'queued');
    assert.equal(s.approvals.find((a) => a.id === ownedReview.result.id).status, 'rejected');
    assert.equal(s.approvals.find((a) => a.id === otherReview.result.id).status, 'pending');
    assert.equal(s.questions.find((q) => q.sourceRunId === other.id).status, 'pending');
    reconcileHandoffs(f.store, {});
    assert(!f.store.read().runs.some((r) => r.handoffContext));
  } finally {
    f.store.close();
  }
});
test('a stopped inner group request reports back to its coordinator and then the original owner', () => {
  const f = fixture();
  try {
    const origin = f.send(),
      root = f.ask(origin),
      child = f.getRun(root.childRunId),
      nested = f.ask(child, f.b.id);
    f.finish(origin);
    f.finish(child);
    f.finish(f.getRun(nested.childRunId), question);
    reconcileHandoffs(f.store, {});
    assert.equal(f.store.read().handoffs.find((h) => h.id === nested.id).status, 'needs_input');
    f.act('handoff.cancel', { id: nested.id });
    assert.equal(f.store.read().handoffs.find((h) => h.id === nested.id).reason, undefined);
    reconcileHandoffs(f.store, {});
    const back = f.getRun(f.store.read().handoffs.find((h) => h.id === nested.id).continuationId);
    assert.equal(back.assistant.id, f.a.id);
    assert.equal(back.handoffId, root.id);
    assert.equal(back.handoffContext.status, 'cancelled');
    f.finish(back, { text: 'The writing step was stopped; my review is saved.', cards: [] });
    reconcileHandoffs(f.store, {});
    const returned = f.store.read().handoffs.find((h) => h.id === root.id);
    assert.equal(returned.status, 'completed');
    assert.match(returned.result.text, /writing step was stopped/);
    assert.equal(f.getRun(returned.continuationId).assistant.id, 'relay');
  } finally {
    f.store.close();
  }
});
test('explicit group destinations validate membership and do not copy the private conversation', async () => {
  const f = fixture();
  try {
    const origin = f.act('chat.send', {
      threadId: 'main',
      text: 'Private context that must not be copied.',
    });
    const h = f.ask(origin, f.a.id, {
      groupId: f.group.id,
      request: 'Review only this public outline.',
    });
    assert.equal(h.groupId, f.group.id);
    assert.equal(
      f.store.read().messages.filter((m) => m.cards?.some((c) => c.id === h.id)).length,
      2,
    );
    let history;
    await agentReply(
      f.store,
      {
        complete: async (messages) => {
          history = JSON.stringify(messages);
          return { text: 'Reviewed', toolCalls: [] };
        },
      },
      f.getRun(h.childRunId),
      {},
    );
    assert.doesNotMatch(history, /Private context that must not be copied/);
    assert.match(history, /Review only this public outline/);
    assert.match(history, /untrusted/i);
    const otherGroup = f.act('group.create', {
      participantIds: [f.a.id, f.b.id],
      title: 'Specialists only',
    });
    const listed = await executeTool(
      f.store,
      'list_groups',
      {},
      { runId: origin.id, threadId: 'main', sourceMessageId: origin.messageId },
    );
    assert.deepEqual(
      listed.result.map((g) => g.id),
      [f.group.id],
    );
    assert.throws(
      () => f.ask(origin, f.a.id, { groupId: otherGroup.id }, 'new-key'),
      /Both assistants/,
    );
    assert.throws(() => f.ask(origin, f.a.id, { groupId: 'missing' }, 'bad-key'), /existing group/);
  } finally {
    f.store.close();
  }
});
test('attachments use a private specialist conversation and explicit group attachments are rejected', () => {
  const f = fixture();
  try {
    const origin = f.send(),
      file = f.act('file.add', { name: 'outline.md', mime: 'text/markdown', text: 'Outline' });
    const h = f.ask(origin, f.a.id, { fileIds: [file.id] });
    assert.notEqual(h.threadId, f.group.id);
    assert.equal(h.groupId, null);
    const before = f.store.read();
    assert.throws(
      () => f.ask(origin, f.a.id, { groupId: f.group.id, fileIds: [file.id] }, 'explicit-file'),
      /text-only/,
    );
    assert.deepEqual(f.store.read(), before);
  } finally {
    f.store.close();
  }
});
test('generated group requests cannot teach memories; question continuations retain request ownership', () => {
  const f = fixture();
  try {
    const origin = f.send();
    f.store.mutate((s) => {
      s.runs[0].questionContext = { origin: { restrictedRoutine: true }, answers: [] };
    });
    const h = f.ask(origin),
      child = f.getRun(h.childRunId);
    f.store.mutate((s) =>
      bindHandoffRun(
        s,
        s.runs.find((r) => r.id === child.id),
      ),
    );
    assert.throws(
      () =>
        f.store.mutate((s) =>
          learnMemory(
            s,
            { key: 'preference.plan', text: 'Likes a clear plan', evidence: 'plan' },
            {
              runId: child.id,
              threadId: f.group.id,
              sourceMessageId: child.messageId,
              controlVersion: 0,
            },
          ),
        ),
      /owner’s message/,
    );
    f.finish(child, question);
    const q = f.store.read().questions[0];
    assert.equal(q.handoffId, h.id);
    assert.equal(q.origin.restrictedRoutine, true);
    const answer = f.act('question.answer', { id: q.id, optionId: '1' });
    assert.equal(answer.handoffId, h.id);
    assert.equal(answer.assistant.id, f.a.id);
  } finally {
    f.store.close();
  }
});
test('a crash at an atomic handoff tool boundary recovers its existing request without replaying other tools', async () => {
  const f = fixture();
  try {
    const origin = f.send(),
      args = {
        assistantId: f.a.id,
        title: 'A clear plan',
        request: 'Help make this plan clearer.',
      };
    const call = {
      id: 'handoff-call',
      function: { name: 'ask_assistant', arguments: JSON.stringify(args) },
    };
    const key = `artifact:${origin.id}:0:0:${call.id}`;
    const h = f.ask(origin, f.a.id, {}, key);
    const journal = new AgentCheckpoint(f.store, origin.id);
    const state = {
      messages: [{ role: 'system', content: 'System' }],
      cards: [],
      prefix: '',
      round: 0,
      response: { text: '', toolCalls: [call] },
      nextTool: 0,
    };
    journal.save('acting', state);
    recoverWork(f.store);
    const answer = await agentReply(
      f.store,
      {
        complete: async () => {
          throw Error('Should use saved tool response');
        },
      },
      origin,
      {},
      { durable: true },
    );
    assert.equal(answer.handoffWaiting, true);
    assert.equal(f.store.read().handoffs.length, 1);
    assert.equal(f.store.read().handoffs[0].id, h.id);
    journal.save('acting', {
      ...state,
      response: { toolCalls: [{ ...call, function: { name: 'prepare_email', arguments: '{}' } }] },
    });
    assert.throws(() => journal.load(), /stopped during a tool action/);
  } finally {
    f.store.close();
  }
});
test('computer waits keep group request IDs; a stopped request cannot restart through a late job or website', () => {
  const f = fixture(),
    computer = new PrivateComputer(f.store, { enabled: true });
  computer.network = new ComputerNetwork(computer);
  try {
    const origin = f.send(),
      h = f.ask(origin),
      child = f.getRun(h.childRunId);
    const context = computer.jobs.origin(child.id);
    assert.equal(context.handoffId, h.id);
    assert.equal(context.questionContext.origin.handoffId, h.id);
    const job = {
      id: 'finished-job',
      threadId: f.group.id,
      runId: child.id,
      context,
      status: 'completed',
      continuation: null,
      title: 'Write result',
      result: { stdout: 'Done', stderr: '', exitCode: 0 },
    };
    f.store.db
      .prepare('INSERT INTO computer_jobs VALUES (?,?,?,?)')
      .run(job.id, job.id, 'fixture', JSON.stringify(job));
    computer.network.waitForOwner(child.id, 'example.com', 'https://example.com');
    f.finish(origin);
    f.finish(child);
    assert.equal(computer.network.continuation(child.id, 'example.com').context.handoffId, h.id);
    f.act('handoff.cancel', { id: h.id });
    computer.jobs.continueFinished();
    assert.equal(computer.jobs.get('finished-job').continuation, 'stopped');
    assert.throws(
      () => computer.network.continuation(child.id, 'example.com'),
      /specialist request was stopped/,
    );
    const synthetic = { ...child, id: 'late-run', status: 'queued' };
    assert.equal(bindHandoffRun(f.store.read(), synthetic), false);
  } finally {
    f.store.close();
  }
});
test('actual HTTP worker completes nested group handoffs, one inline question and files in one transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-group-pipeline-'));
  let f;
  const server = await assistantsFixture(dir, {
    respond: ({ messages }) => {
      const all = JSON.stringify(messages),
        system = messages[0].content;
      if (system.startsWith('You are Pip,')) {
        if (!all.includes('Saved questions and my answers:'))
          return tool('ask_question', {
            prompt: 'Which tone?',
            options: [{ label: 'Friendly' }, { label: 'Formal' }],
          });
        if (messages.at(-1).role !== 'tool')
          return tool('write_note', {
            name: 'group-plan.md',
            text: '# Group plan\n\nStart with one small step.',
          });
        return { role: 'assistant', content: 'Pip saved the friendly plan.' };
      }
      if (system.startsWith('You are Mochi,')) {
        if (all.includes('Continue the original request using this specialist result.'))
          return { role: 'assistant', content: 'Mochi reviewed Pip’s plan: it is clear.' };
        return tool('ask_assistant', {
          assistantId: f.b.id,
          title: 'Write the plan',
          request: 'Write a small plan. Ask which tone to use.',
        });
      }
      if (all.includes('Continue the original request using this specialist result.'))
        return { role: 'assistant', content: 'The group finished the plan and review.' };
      return tool('ask_assistant', {
        assistantId: f.a.id,
        title: 'Review a plan',
        request: 'Ask Pip to write the plan, then review it.',
      });
    },
  });
  try {
    f = fixture(server.store);
    const count = f.store.read().threads.length;
    f.send();
    const q = await waitFor(() => f.store.read().questions.find((q) => q.status === 'pending'));
    assert.equal(q.origin.assistant.id, f.b.id);
    assert(q.handoffId);
    f.act('question.answer', { id: q.id, optionId: '1' });
    await waitFor(() =>
      f.store.read().messages.some((m) => m.text === 'The group finished the plan and review.'),
    );
    const s = f.store.read();
    assert.equal(s.threads.length, count);
    assert.equal(s.handoffs.length, 2);
    assert(s.handoffs.every((h) => h.groupId === f.group.id && h.status === 'completed'));
    assert.equal(
      s.files.find((x) => x.name === 'group-plan.md').text,
      '# Group plan\n\nStart with one small step.',
    );
    assert.equal(
      s.messages.filter((m) => m.text === 'The group finished the plan and review.').length,
      1,
    );
    assert.equal(s.messages.filter((m) => m.delegation).length, 2);
    assert(s.runs.every((r) => r.status === 'completed'));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
