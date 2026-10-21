// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { startHandoff, cancelHandoff } from '../shared/handoffs.mjs';
import { reconcileHandoffs, bindHandoffRun } from '../server/handoffs.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import { recoverWork } from '../server/worker.mjs';
import { learnMemory } from '../shared/memory.mjs';
import { executeTool } from '../server/agent.mjs';
import { assistantsFixture } from '../scripts/assistants-fixture.mjs';
const role = {
  name: 'Mochi',
  description: 'Review designs.',
  tone: 'Gentle',
  avatarColor: '#e7b281',
};
function fixture(path = ':memory:') {
  const store = new Store(path, { sample: false }),
    act = (a, p) => store.mutate((s) => command(s, a, p));
  const target = act('assistant.create', role),
    origin = act('chat.send', { threadId: 'main', text: 'Ask Mochi to review the plan.' });
  store.mutate((s) => {
    s.runs[0].modelConnection = { id: 'original', revision: 2 };
  });
  const ask = (p = {}, runId = origin.id, key = 'ask-1') =>
    store.mutate((s) =>
      startHandoff(
        s,
        runId,
        { assistantId: target.id, title: 'Review the plan', request: 'Check clarity.', ...p },
        key,
      ),
    );
  const finish = (id, response = { text: 'Reviewed: clear.', cards: [] }) =>
    store.mutate((s) => {
      const run = s.runs.find((r) => r.id === id);
      appendAssistant(s, run.threadId, response, { replyTo: run.messageId }, run);
      run.status = 'completed';
    });
  return { store, act, target, origin, ask, finish };
}
const waitFor = async (fn) => {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Timed out waiting for handoff state');
};
test('handoffs are durable, idempotent, scoped and return exactly once after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-handoff-'));
  const f = fixture(join(dir, 'state.sqlite'));
  let store = f.store;
  try {
    f.act('thread.update', { id: 'main', draft: 'Do not replace my draft' });
    const h = f.ask();
    assert.equal(f.ask().id, h.id);
    assert.throws(() => f.ask({ request: 'Changed instructions' }), /different instructions/);
    assert.equal(store.read().handoffs.length, 1);
    assert.equal(
      store.read().threads.find((t) => t.id === 'main').draft,
      'Do not replace my draft',
    );
    f.act('assistant.update', { ...f.target, name: 'Mochi renamed', description: 'A later role.' });
    const child = store.read().runs.find((r) => r.id === h.childRunId);
    assert.deepEqual(child.modelConnection, { id: 'original', revision: 2 });
    assert.equal(child.assistant.name, 'Mochi');
    assert.equal(
      store.read().messages.find((m) => m.id === child.messageId).delegation.fromName,
      'Relay',
    );
    f.finish(f.origin.id);
    f.finish(child.id);
    store.close();
    store = new Store(join(dir, 'state.sqlite'));
    recoverWork(store);
    reconcileHandoffs(store, {});
    reconcileHandoffs(store, {});
    const saved = store.read().handoffs[0],
      returned = store.read().runs.find((r) => r.id === saved.continuationId);
    assert.equal(saved.status, 'completed');
    assert.equal(returned.handoffContext.result.text, 'Reviewed: clear.');
    assert.equal(returned.messageId, f.origin.messageId);
    assert.deepEqual(returned.modelConnection, { id: 'original', revision: 2 });
    assert.equal(store.read().runs.length, 3);
    assert.equal(
      store.read().messages.filter((m) => m.threadId === 'main' && m.role === 'user').length,
      1,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('handoffs validate targets, files, ancestry and root budgets without partial writes', () => {
  const f = fixture();
  try {
    for (const p of [
      { assistantId: 'relay' },
      { assistantId: 'missing' },
      { fileIds: ['missing'] },
      { request: '' },
    ]) {
      const before = f.store.read();
      assert.throws(() => f.ask(p));
      assert.deepEqual(f.store.read(), before);
    }
    const h = f.ask();
    assert.throws(() => f.ask({ assistantId: 'relay' }, h.childRunId, 'cycle'), /loop/);
    f.store.mutate((s) => {
      for (let i = 0; i < 7; i++)
        s.handoffs.push({ ...h, id: `old-${i}`, operationId: `old-${i}`, status: 'completed' });
    });
    assert.throws(() => f.ask({}, f.origin.id, 'ninth'), /eight-handoff/);
  } finally {
    f.store.close();
  }
});
test('generated specialist requests cannot become owner memories, and restricted routines stay restricted', async () => {
  const f = fixture();
  try {
    f.store.mutate((s) => {
      s.runs[0].routineId = 'routine-test';
    });
    const h = f.ask({ request: 'I prefer bright rooms.' });
    const child = f.store.read().runs.find((r) => r.id === h.childRunId);
    assert.throws(
      () =>
        f.store.mutate((s) =>
          learnMemory(
            s,
            { text: 'Prefers bright rooms.', key: 'room', evidence: 'I prefer bright rooms.' },
            {
              runId: child.id,
              threadId: child.threadId,
              sourceMessageId: child.messageId,
              controlVersion: 0,
            },
          ),
        ),
      /owner’s message/,
    );
    f.store.mutate((s) =>
      bindHandoffRun(
        s,
        s.runs.find((r) => r.id === child.id),
      ),
    );
    assert.equal(f.store.read().runs.find((r) => r.id === child.id).handoffRestricted, true);
    await assert.rejects(
      () =>
        executeTool(
          f.store,
          'learn_memory',
          {},
          {
            threadId: child.threadId,
            runId: child.id,
            sourceMessageId: child.messageId,
            routineRun: true,
          },
        ),
      /routine/,
    );
  } finally {
    f.store.close();
  }
});
test('questions retain an active handoff until answered, then return the answer once', () => {
  const f = fixture();
  try {
    const h = f.ask();
    f.finish(f.origin.id);
    f.finish(h.childRunId, {
      text: 'One detail.',
      cards: [],
      question: { prompt: 'Which tone?', options: [{ label: 'Gentle' }, { label: 'Direct' }] },
    });
    reconcileHandoffs(f.store, {});
    assert.equal(f.store.read().handoffs[0].status, 'needs_input');
    assert.equal(f.store.read().runs.length, 2);
    const answer = f.act('question.answer', { id: f.store.read().questions[0].id, optionId: '1' });
    f.store.mutate((s) =>
      bindHandoffRun(
        s,
        s.runs.find((r) => r.id === answer.id),
      ),
    );
    assert.deepEqual(f.store.read().runs.find((r) => r.id === answer.id).modelConnection, {
      id: 'original',
      revision: 2,
    });
    f.finish(answer.id, { text: 'Gentle review ready.', cards: [] });
    reconcileHandoffs(f.store, {});
    assert.equal(f.store.read().handoffs[0].result.text, 'Gentle review ready.');
  } finally {
    f.store.close();
  }
});
test('computer jobs, website grants and delegated tasks keep handoffs waiting', () => {
  const f = fixture();
  try {
    const h = f.ask();
    f.finish(f.origin.id);
    f.finish(h.childRunId, {
      text: 'Working.',
      cards: [{ kind: 'computer-access', runId: h.childRunId, host: 'example.com' }],
    });
    const job = { id: 'job', runId: h.childRunId, status: 'running', continuation: null };
    const network = { waitState: () => ({ requested: true, resumed: null }) };
    const services = { computer: { jobs: { rows: () => [job] }, network } };
    reconcileHandoffs(f.store, services);
    assert.equal(f.store.read().handoffs[0].reason, 'Computer work is still running');
    job.continuation = 'observed';
    reconcileHandoffs(f.store, services);
    assert.equal(f.store.read().handoffs[0].status, 'needs_input');
    network.waitState = () => ({ requested: true, resumed: 'continued' });
    const task = f.act('task.create', { threadId: h.threadId, title: 'Review', kind: 'general' });
    reconcileHandoffs(f.store, services);
    assert.equal(f.store.read().handoffs[0].status, 'waiting');
    f.store.mutate((s) =>
      Object.assign(
        s.tasks.find((t) => t.id === task.id),
        { status: 'completed', result: 'Task result retained.' },
      ),
    );
    reconcileHandoffs(f.store, services);
    assert.match(f.store.read().handoffs[0].result.text, /Task result retained/);
  } finally {
    f.store.close();
  }
});
test('stopping a handoff cancels descendant work and prevents queued returns', () => {
  const f = fixture();
  try {
    const h = f.ask(),
      third = f.act('assistant.create', { ...role, name: 'Pip' }),
      nested = f.ask({ assistantId: third.id }, h.childRunId, 'nested');
    const qRun = f.store.read().runs.find((r) => r.id === nested.childRunId);
    f.finish(qRun.id, {
      text: 'Question',
      cards: [],
      question: { prompt: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
    });
    f.store.mutate((s) => cancelHandoff(s, h.id));
    reconcileHandoffs(f.store, {});
    assert.equal(
      f.store.read().handoffs.every((x) => x.status === 'cancelled'),
      true,
    );
    assert.equal(f.store.read().questions[0].status, 'dismissed');
    assert.equal(f.store.read().runs.find((r) => r.id === h.childRunId).status, 'cancelled');
    assert.equal(
      f.store.read().handoffs.some((x) => x.continuationId),
      false,
    );
  } finally {
    f.store.close();
  }
});
test('actual HTTP model worker hands off and resumes with frozen roles, scoped memory and original provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-handoff-worker-'));
  let target;
  const f = await assistantsFixture(dir, {
    respond: async (body) => {
      const messages = body.messages,
        system = messages[0].content,
        all = JSON.stringify(messages);
      if (system.startsWith('You are Mochi,')) {
        assert.match(system, /mochi-only-note/);
        assert.doesNotMatch(all, /relay-only-note/);
        return { role: 'assistant', content: 'Mochi review: simplify the first step.' };
      }
      if (all.includes('Continue the original request using this specialist result.'))
        return { role: 'assistant', content: 'Finished with Mochi: one clear first step.' };
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'ask-mochi',
            type: 'function',
            function: {
              name: 'ask_assistant',
              arguments: JSON.stringify({
                assistantId: target.id,
                title: 'Review the first step',
                request: 'Review this fictional onboarding plan.',
              }),
            },
          },
        ],
      };
    },
  });
  try {
    target = f.store.mutate((s) => command(s, 'assistant.create', role));
    f.store.mutate((s) => {
      command(s, 'memory.add', { text: 'relay-only-note' });
      command(s, 'memory.add', { assistantId: target.id, text: 'mochi-only-note' });
      command(s, 'chat.send', { threadId: 'main', text: 'Ask Mochi to review the plan.' });
    });
    await waitFor(() =>
      f.store.read().messages.some((m) => m.text === 'Finished with Mochi: one clear first step.'),
    );
    const h = f.store.read().handoffs[0];
    assert.equal(h.status, 'completed');
    assert.equal(f.store.read().runs.length, 3);
    assert.equal(f.requests.length, 3);
    assert.equal(
      f.store.read().messages.filter((m) => m.threadId === 'main' && m.role === 'assistant').length,
      2,
    );
    assert.equal(
      f.store.read().messages.filter((m) => m.role === 'user' && m.threadId === 'main').length,
      1,
    );
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('specialist failure returns an honest failed result instead of hanging or duplicating work', async () => {
  const f = fixture();
  try {
    const h = f.ask();
    f.finish(f.origin.id);
    f.store.mutate((s) =>
      Object.assign(
        s.runs.find((r) => r.id === h.childRunId),
        { status: 'failed', error: 'Provider unavailable' },
      ),
    );
    reconcileHandoffs(f.store, {});
    reconcileHandoffs(f.store, {});
    const saved = f.store.read().handoffs[0],
      run = f.store.read().runs.find((r) => r.id === saved.continuationId);
    assert.equal(saved.status, 'failed');
    assert.equal(run.handoffContext.error, 'Provider unavailable');
    assert.equal(run.handoffContext.result, null);
    assert.equal(f.store.read().runs.length, 3);
  } finally {
    f.store.close();
  }
});
test('nested handoffs settle through their original owners; archived source suppresses its return', () => {
  const f = fixture();
  try {
    const outer = f.ask(),
      pip = f.act('assistant.create', { ...role, name: 'Pip' }),
      inner = f.ask({ assistantId: pip.id }, outer.childRunId, 'nested-return');
    f.finish(f.origin.id);
    f.finish(outer.childRunId);
    f.finish(inner.childRunId, { text: 'Pip checked the facts.', cards: [] });
    reconcileHandoffs(f.store, {});
    let s = f.store.read();
    assert.equal(s.handoffs.find((h) => h.id === outer.id).status, 'waiting');
    const toMochi = s.handoffs.find((h) => h.id === inner.id).continuationId;
    assert.ok(toMochi);
    assert.equal(s.runs.find((r) => r.id === toMochi).threadId, outer.threadId);
    f.finish(toMochi, { text: 'Mochi incorporated the fact check.', cards: [] });
    reconcileHandoffs(f.store, {});
    s = f.store.read();
    assert.equal(
      s.handoffs.find((h) => h.id === outer.id).result.text,
      'Mochi incorporated the fact check.',
    );
    const side = f.act('thread.create', { title: 'Archived source' }),
      origin = f.act('chat.send', { threadId: side.id, text: 'Check this.' }),
      third = f.ask({}, origin.id, 'archived');
    f.finish(origin.id);
    f.finish(third.childRunId);
    f.act('thread.update', { id: side.id, archived: true });
    reconcileHandoffs(f.store, {});
    assert.equal(f.store.read().handoffs.find((h) => h.id === third.id).returnSuppressed, true);
  } finally {
    f.store.close();
  }
});
test('stopping nested work informs its coordinator; stopping an in-flight root also stops its announcement', () => {
  const f = fixture();
  try {
    const h = f.ask(),
      pip = f.act('assistant.create', { ...role, name: 'Pip' }),
      nested = f.ask({ assistantId: pip.id }, h.childRunId, 'nested-stop');
    f.finish(h.childRunId);
    f.store.mutate((s) => cancelHandoff(s, nested.id));
    reconcileHandoffs(f.store, {});
    const inner = f.store.read().handoffs.find((x) => x.id === nested.id);
    assert.ok(inner.continuationId);
    assert.equal(f.store.read().handoffs.find((x) => x.id === h.id).continuationId, undefined);
    assert.equal(
      f.store.read().runs.find((r) => r.id === inner.continuationId).handoffContext.status,
      'cancelled',
    );
    const cancelled = f.store.mutate((s) => cancelHandoff(s, h.id));
    assert.ok(cancelled.runIds.includes(f.origin.id));
    assert.equal(f.store.read().runs.find((r) => r.id === f.origin.id).status, 'cancelled');
  } finally {
    f.store.close();
  }
});
