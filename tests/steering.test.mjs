import { ignoreMemoryReviews } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { command } from '../shared/domain.mjs';
import { steeringContext, withSteering } from '../shared/steering.mjs';
const call = (name, args, id = name) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const answer = (text = '', ...toolCalls) => ({ text, toolCalls });
const send = (store, text, extra = {}) =>
  store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text, ...extra }));
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error('Steering state not reached');
}
function fixture(complete, services = {}, path = ':memory:') {
  const store = new Store(path, { sample: false });
  const worker = new BackgroundWorker(
    store,
    {
      mode: 'live',
      provider: { configured: true, complete: ignoreMemoryReviews(complete) },
      ...services,
    },
    { pollMs: 5 },
  );
  return {
    store,
    worker,
    async close() {
      await worker.stop();
      store.close();
    },
  };
}

test('explicit Send updates the active direct request; Queue and other chats remain separate', () => {
  const s = new Store(':memory:', { sample: false });
  const first = send(s, 'Original');
  s.mutate((state) => {
    state.runs[0].status = 'running';
    state.runs[0].partial = 'Old partial';
    state.threads[0].draft = 'Correction';
  });
  const second = send(s, 'Correction', { delivery: 'now' });
  assert.equal(second.id, first.id);
  assert.equal(s.read().runs.length, 1);
  assert.equal(second.partial, '');
  assert.equal(second.steeringMessageIds.length, 1);
  assert.equal(s.read().threads[0].draft, '');
  assert.equal(s.read().messages.at(-1).steeringRunId, first.id);
  const queued = send(s, 'Afterward', { delivery: 'queue' });
  assert.notEqual(queued.id, first.id);
  assert.equal(queued.status, 'queued');
  const other = s.mutate((state) => command(state, 'thread.create', { title: 'Other' }));
  const side = send(s, 'Separate', { threadId: other.id, delivery: 'now' });
  assert.notEqual(side.id, first.id);
  assert.throws(() => send(s, 'Invalid', { delivery: 'unknown' }), /Choose Send/);
  s.mutate((state) => {
    state.runs[0].routineId = 'scheduled-reminder';
    state.runs[0].execution = 'reminder';
  });
  const afterReminder = send(s, 'A request after a reminder', { delivery: 'now' });
  assert.notEqual(afterReminder.id, first.id);
  assert.equal(afterReminder.status, 'queued');
  assert.equal(s.read().runs[0].steeringMessageIds.length, 1);
  s.close();
});

test('a follow-up aborts thinking and drops late text and tool plans from an uncooperative provider', async () => {
  let calls = 0,
    waiting = false,
    aborted = false;
  const f = fixture(async (messages, _tools, { signal, onText }) => {
    if (++calls === 1) {
      assert.ok(
        messages.some(
          (m) =>
            m.role === 'user' &&
            m.content.startsWith('[Relay timestamp: 2026-10-14T10:00:00.000Z]'),
        ),
      );
      onText('Old partial');
      waiting = true;
      await new Promise((r) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            r();
          },
          { once: true },
        ),
      );
      onText('Stale partial');
      return answer('Stale final', call('remember', { text: 'Wrong stale memory' }));
    }
    assert.match(messages.at(-1).content, /Use Tuesday instead/);
    assert.ok(
      messages.some(
        (m) =>
          m.role === 'user' && m.content.startsWith('[Relay timestamp: 2026-10-14T10:05:00.000Z]'),
      ),
    );
    return answer('Updated to Tuesday.');
  });
  send(f.store, 'Plan Monday');
  f.store.mutate((s) => {
    s.messages.at(-1).createdAt = '2026-10-14T10:00:00.000Z';
  });
  f.worker.start();
  try {
    await until(() => waiting);
    const r = send(f.store, 'Use Tuesday instead', { delivery: 'now' });
    f.store.mutate((s) => {
      s.messages.at(-1).createdAt = '2026-10-14T10:05:00.000Z';
    });
    await until(() => f.store.read().runs[0].status === 'completed');
    assert(aborted);
    assert.equal(calls, 2);
    assert.equal(f.store.read().memories.length, 0);
    const replies = f.store.read().messages.filter((m) => m.role === 'assistant');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, 'Updated to Tuesday.');
    assert.equal(replies[0].replyTo, r.steeringMessageIds[0]);
    assert.equal(f.store.listenerCount('change'), 0);
  } finally {
    await f.close();
  }
});

test('in-flight tool output is retained once and remaining stale batch actions never execute', async () => {
  let release,
    reads = 0,
    calls = 0;
  const f = fixture(
    async (messages) => {
      if (++calls === 1)
        return answer(
          'Reading first.',
          call('read_web', { url: 'https://example.com' }, 'read'),
          call('remember', { text: 'Do not save this' }, 'stale'),
        );
      const receipt = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'read');
      assert.match(receipt.content, /already fetched source/);
      assert.match(
        messages.find((m) => m.role === 'tool' && m.tool_call_id === 'stale').content,
        /Not executed/,
      );
      assert.match(messages.at(-1).content, /Keep the source but change the format/);
      return answer('Reformatted the existing source.');
    },
    {
      readPage: async () => {
        reads++;
        await new Promise((r) => (release = r));
        return { url: 'https://example.com', title: 'Source', text: 'already fetched source' };
      },
    },
  );
  send(f.store, 'Read and remember');
  f.worker.start();
  try {
    await until(() => release);
    send(f.store, 'Keep the source but change the format', { delivery: 'now' });
    release();
    await until(() => f.store.read().runs[0].status === 'completed');
    assert.equal(reads, 1);
    assert.equal(f.store.read().memories.length, 0);
    assert.equal(f.store.read().messages.at(-1).cards[0].kind, 'browser');
  } finally {
    release?.();
    await f.close();
  }
});

test('multiple follow-ups retain order, attachments, frozen skill version and selected app scope', async () => {
  let release,
    waiting = false,
    calls = 0,
    observed;
  const f = fixture(async (messages) => {
    if (++calls === 1) {
      waiting = true;
      await new Promise((r) => (release = r));
      return answer('Stale');
    }
    observed = messages;
    return answer('Updated');
  });
  const method = f.store.mutate((s) =>
    command(s, 'skill.create', {
      title: 'Short brief',
      slug: 'short-brief',
      instructions: 'Use short paragraphs.',
    }),
  );
  f.store.mutate(
    (s) =>
      (s.connections.apps = [
        { id: 'chosen-app', revision: 2, name: 'Chosen app', enabled: true, toolCount: 1 },
      ]),
  );
  const file = f.store.mutate((s) =>
    command(s, 'file.add', { name: 'notes.txt', mime: 'text/plain', text: 'References' }),
  );
  send(f.store, 'Original');
  f.worker.start();
  try {
    await until(() => waiting);
    send(f.store, 'First correction', {
      delivery: 'now',
      fileIds: [file.id],
      apps: [{ id: 'chosen-app', revision: 2, name: 'Chosen app' }],
    });
    send(f.store, `/${method.slug} Second correction`, { delivery: 'now' });
    f.store.mutate((s) =>
      command(s, 'skill.update', {
        id: method.id,
        title: method.title,
        instructions: 'Changed after send.',
      }),
    );
    release();
    await until(() => f.store.read().runs[0].status === 'completed');
    assert.match(observed.at(-2).content, new RegExp(file.id));
    assert.match(observed.at(-1).content, /Second correction/);
    assert.match(observed.at(-1).content, /Use short paragraphs/);
    assert.doesNotMatch(observed.at(-1).content, /Changed after send/);
    assert.equal(f.store.read().runs[0].skill.version, 1);
    assert.equal(f.store.read().runs[0].appContext[0].id, 'chosen-app');
    assert.match(observed[0].content, /Chosen app/);
    assert.equal(steeringContext(f.store.read(), f.store.read().runs[0]).length, 2);
  } finally {
    release?.();
    await f.close();
  }
});

test('restart and a final checkpoint at the round limit still consume a pending correction without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-steering-recovery-'));
  const path = join(directory, 'workspace.sqlite');
  let seen;
  let f = fixture(async () => answer('Unused'), {}, path);
  const r = send(f.store, 'Original');
  f.store.mutate((s) => {
    s.runs[0].status = 'running';
    s.runs[0].leaseUntil = 0;
  });
  new AgentCheckpoint(f.store, r.id).final(
    { text: 'Old final', cards: [] },
    {
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'Original' },
        { role: 'tool', tool_call_id: 'saved', content: 'Completed action once' },
      ],
      cards: [],
      prefix: '',
      round: 8,
      response: null,
      nextTool: 0,
      steeringApplied: 0,
    },
  );
  send(f.store, 'New after restart', { delivery: 'now' });
  await f.close();
  f = fixture(
    async (m) => {
      seen = m;
      return answer('Recovered correction');
    },
    {},
    path,
  );
  recoverWork(f.store);
  f.worker.start();
  try {
    await until(() => f.store.read().runs[0].status === 'completed');
    assert.match(seen.at(-1).content, /New after restart/);
    assert(seen.some((m) => m.content === 'Completed action once'));
    assert.equal(f.store.read().messages.at(-1).text, 'Recovered correction');
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a question and deferred continuation retain the accepted owner correction', async () => {
  let started = false,
    release,
    calls = 0;
  const f = fixture(async (messages) => {
    calls++;
    if (calls === 1) {
      started = true;
      await new Promise((r) => (release = r));
      return answer('Stale');
    }
    if (calls === 2)
      return answer(
        '',
        call('ask_question', {
          prompt: 'Which time?',
          options: [{ label: 'Morning' }, { label: 'Evening' }],
        }),
      );
    assert(messages.some((m) => String(m.content).includes('Tuesday instead')));
    return answer('Tuesday morning.');
  });
  send(f.store, 'Plan Monday');
  f.worker.start();
  try {
    await until(() => started);
    send(f.store, 'Tuesday instead', { delivery: 'now' });
    release();
    await until(() => f.store.read().questions.length === 1);
    const q = f.store.read().questions[0];
    assert.equal(q.origin.steering[0].text, 'Tuesday instead');
    const context = withSteering(f.store.read(), f.store.read().runs[0], {
      origin: { request: 'Original' },
      answers: [],
    });
    assert.equal(context.origin.steering[0].text, 'Tuesday instead');
    f.store.mutate((s) => command(s, 'question.answer', { id: q.id, optionId: '1' }));
    await until(() => f.store.read().runs.every((r) => r.status === 'completed'));
    assert.equal(f.store.read().messages.at(-1).text, 'Tuesday morning.');
  } finally {
    release?.();
    await f.close();
  }
});

test('Stop still cancels a redirected request and pauses an explicitly queued follow-up', async () => {
  let calls = 0,
    second = false;
  const f = fixture(async (_m, _t, { signal }) => {
    calls++;
    if (calls === 2) second = true;
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const r = send(f.store, 'Original');
  f.worker.start();
  try {
    await until(() => calls === 1);
    send(f.store, 'Correction', { delivery: 'now' });
    await until(() => second);
    send(f.store, 'Later', { delivery: 'queue' });
    f.store.mutate((s) => command(s, 'chat.stop', { id: r.id }));
    f.worker.abort(r.id);
    await until(() => !f.worker.active.has(r.id));
    assert.equal(f.store.read().threads[0].queuePaused, true);
    assert.equal(f.store.read().runs[1].status, 'queued');
    assert.equal(f.store.listenerCount('change'), 0);
  } finally {
    await f.close();
  }
});

test('follow-up bounds roll back the message and retain the draft', () => {
  const store = new Store(':memory:', { sample: false });
  send(store, 'Original');
  store.mutate((s) => (s.runs[0].status = 'running'));
  for (let i = 0; i < 32; i++) send(store, `Update ${i}`, { delivery: 'now' });
  store.mutate((s) => (s.threads[0].draft = 'Keep this'));
  const count = store.read().messages.length;
  assert.throws(() => send(store, 'Too many', { delivery: 'now' }), /follow-up limit/);
  assert.equal(store.read().messages.length, count);
  assert.equal(store.read().threads[0].draft, 'Keep this');
  assert.equal(send(store, 'Later', { delivery: 'queue' }).status, 'queued');
  store.close();
});

test('checkpoint phase remains authoritative after continuing a previously final response', () => {
  const store = new Store(':memory:', { sample: false }),
    run = send(store, 'Request'),
    journal = new AgentCheckpoint(store, run.id);
  journal.final({ text: 'Old', cards: [] }, { messages: [], round: 0 });
  const saved = journal.load();
  assert.equal(saved.phase, 'final');
  journal.save('ready', { ...saved, steeringApplied: 1 });
  assert.equal(journal.load().phase, 'ready');
  store.close();
});

test('learning after steering is attributed only to the accepted follow-up', async () => {
  let started = false,
    calls = 0;
  const f = fixture(async (_m, _t, { signal }) => {
    if (++calls === 1) {
      started = true;
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    }
    if (calls === 2)
      return answer(
        '',
        call('learn_memory', {
          key: 'style.length',
          text: 'Prefers short replies.',
          evidence: 'I prefer short replies.',
        }),
      );
    return answer('Remembered.');
  });
  send(f.store, 'Plan a trip');
  f.worker.start();
  try {
    await until(() => started);
    const r = send(f.store, 'I prefer short replies.', { delivery: 'now' });
    await until(() => f.store.read().runs[0].status === 'completed');
    assert.equal(f.store.read().memories[0].sourceMessageId, r.steeringMessageIds[0]);
  } finally {
    await f.close();
  }
});
