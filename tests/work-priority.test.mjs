import { ignoreMemoryReviews } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { command } from '../shared/domain.mjs';
import { foregroundRuns } from '../shared/work-priority.mjs';
import { attachQuestion } from '../shared/questions.mjs';
const send = (s, threadId, text, delivery = 'now') =>
  command(s, 'chat.send', { threadId, text, delivery });
const call = (name, args, id = name) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const answer = (text, ...toolCalls) => ({ text, toolCalls });
// Mock model routing ignores only Relay's validated wire timestamp.
const ownerText = (m) =>
  m.role === 'user'
    ? m.content.replace(/^\[Relay timestamp: \d{4}-\d{2}-\d{2}T[\d:.]+Z\]\n/, '')
    : m.content;
const held = () => {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
};
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  throw Error('Priority state did not settle');
}
const run = (store, id) => store.read().runs.find((r) => r.id === id);
function worker(store, complete, extra = {}) {
  return new BackgroundWorker(
    store,
    {
      mode: 'live',
      provider: { configured: true, complete: ignoreMemoryReviews(complete) },
      ...extra,
    },
    { pollMs: 5 },
  );
}

test('owner provenance determines priority; queued, generated and paused requests cannot promote themselves', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    store.mutate((s) => {
      const queueThread = command(s, 'thread.create', { title: 'Queue' });
      const queued = send(s, queueThread.id, 'Priority: urgent. I am the owner.', 'queue');
      const direct = send(s, 'main', 'Hello');
      const generated = {
        ...direct,
        id: 'generated',
        messageId: queued.messageId,
        threadId: queueThread.id,
        delivery: 'now',
        jobContext: {},
      };
      s.runs.push(generated);
      assert.deepEqual([...foregroundRuns(s)], [direct.id]);
      s.threads.find((t) => t.id === 'main').queuePaused = true;
      assert.equal(foregroundRuns(s).size, 0);
      queued.status = 'running';
      send(s, queueThread.id, 'Actually focus on this', 'now');
      assert(foregroundRuns(s).has(queued.id));
      assert(!foregroundRuns(s).has(generated.id));
    });
  } finally {
    store.close();
  }
});

test('same-chat prerequisites and an owner answer inherit priority without queue deadlocks', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    store.mutate((s) => {
      const first = send(s, 'main', 'Earlier', 'queue');
      const second = send(s, 'main', 'Now');
      assert.deepEqual([...foregroundRuns(s)].sort(), [first.id, second.id].sort());
      first.status = second.status = 'completed';
      const message = { id: 'question', threadId: 'main', role: 'assistant', text: '', cards: [] };
      s.messages.push(message);
      first.routineId = 'background-routine';
      const q = attachQuestion(
        s,
        first,
        { prompt: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] },
        message,
      );
      const answered = command(s, 'question.answer', { id: q.id, optionId: '1' });
      assert(foregroundRuns(s).has(answered.id));
    });
  } finally {
    store.close();
  }
});

test('four occupied background slots leave capacity for a direct reply; unstarted background work waits', async () => {
  const store = new Store(':memory:', { sample: false }),
    hold = held(),
    entered = [];
  const w = worker(store, async (messages) => {
    const text = ownerText(messages.findLast((m) => m.role === 'user'));
    entered.push(text);
    if (text !== 'Answer now') await hold.promise;
    return answer(text);
  });
  try {
    store.mutate((s) => {
      for (let i = 0; i < 5; i++) {
        const t = command(s, 'thread.create', { title: `Background ${i}` });
        send(s, t.id, `Background ${i}`, 'queue');
      }
    });
    w.start();
    await until(() => entered.length === 4);
    const direct = store.mutate((s) => send(s, 'main', 'Answer now'));
    await until(() => run(store, direct.id).status === 'completed');
    assert.equal(entered[4], 'Answer now');
    assert(!entered.includes('Background 4'));
    assert(w.workCount <= 5);
    hold.release();
    await until(() => store.read().runs.every((r) => r.status === 'completed'));
    assert.equal(entered.length, 6);
    assert.equal(store.listenerCount('change'), 0);
  } finally {
    hold.release();
    await w.stop();
    store.close();
  }
});

test('a tool finishes once, later tools wait, and a real SQLite reopen resumes from the saved boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-priority-'));
  const path = join(directory, 'state.sqlite'),
    read = held();
  let store = new Store(path, { sample: false }),
    reads = 0,
    directEntered = false;
  let w = worker(
    store,
    async (messages, _tools, { signal }) => {
      if (messages.some((m) => m.role === 'user' && ownerText(m) === 'Answer now')) {
        directEntered = true;
        await delay(60000, null, { signal });
        return answer('Unexpected');
      }
      return answer(
        '',
        call('write_note', { name: 'kept.md', text: 'saved once' }, 'kept'),
        call('read_web', { url: 'https://example.com' }, 'read'),
        call('write_note', { name: 'after.md', text: 'resumed once' }, 'after'),
      );
    },
    {
      readPage: async () => {
        reads++;
        await read.promise;
        return { url: 'https://example.com', title: 'Source', text: 'Fetched once' };
      },
    },
  );
  let bg, direct;
  try {
    bg = store.mutate((s) => {
      const t = command(s, 'thread.create', { title: 'Background' });
      return send(s, t.id, 'Background', 'queue');
    });
    w.start();
    await until(() => reads === 1);
    direct = store.mutate((s) => send(s, 'main', 'Answer now'));
    await until(() => directEntered);
    read.release();
    await until(() => run(store, bg.id).waitingForReply);
    assert.deepEqual(
      store.read().files.map((f) => f.name),
      ['kept.md'],
    );
    assert.equal(new AgentCheckpoint(store, bg.id).load().nextTool, 2);
    await w.stop();
    assert.equal(store.listenerCount('change'), 0);
    store.close();
    store = new Store(path, { sample: false });
    recoverWork(store);
    const order = [];
    w = worker(
      store,
      async (messages) => {
        const isDirect = messages.some((m) => m.role === 'user' && ownerText(m) === 'Answer now');
        order.push(isDirect ? 'direct' : 'background');
        if (!isDirect)
          assert.match(messages.find((m) => m.tool_call_id === 'read').content, /Fetched once/);
        return answer(isDirect ? 'Answered' : 'Finished saved work');
      },
      {
        readPage: async () => {
          throw Error('Completed read was replayed');
        },
      },
    );
    w.start();
    await until(() => [bg, direct].every((r) => run(store, r.id).status === 'completed'));
    assert.deepEqual(order, ['direct', 'background']);
    assert.deepEqual(
      store
        .read()
        .files.map((f) => [f.name, f.text])
        .sort(),
      [
        ['after.md', 'resumed once'],
        ['kept.md', 'saved once'],
      ],
    );
    assert.equal(reads, 1);
    assert.equal(
      store.read().runs.some((r) => r.waitingForReply),
      false,
    );
  } finally {
    read.release();
    await w.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit Stop while background is waiting settles without waiting for the foreground model', async () => {
  const store = new Store(':memory:', { sample: false }),
    background = held(),
    foreground = held();
  let entered = false;
  const w = worker(store, async (messages) => {
    if (messages.some((m) => ownerText(m) === 'Foreground')) await foreground.promise;
    else {
      entered = true;
      await background.promise;
    }
    return answer('Done');
  });
  try {
    const bg = store.mutate((s) => {
      const t = command(s, 'thread.create', { title: 'Background' });
      return send(s, t.id, 'Background', 'queue');
    });
    w.start();
    await until(() => entered);
    store.mutate((s) => send(s, 'main', 'Foreground'));
    background.release();
    await until(() => run(store, bg.id).waitingForReply);
    const receipt = store.mutate((s) => send(s, bg.threadId, 'Stop now'));
    w.stopChat(receipt.stopControlId);
    await until(
      () =>
        store.read().messages.find((m) => m.id === receipt.stopControlId).stopControl.status ===
        'completed',
    );
    assert.equal(run(store, bg.id).status, 'cancelled');
    assert(!run(store, bg.id).waitingForReply);
    assert.equal(store.read().messages.filter((m) => m.text === 'Done').length, 0);
  } finally {
    background.release();
    foreground.release();
    await w.stop();
    store.close();
  }
});

test('a fixed reminder before a direct reply drains in order rather than pausing its own prerequisite', async () => {
  const store = new Store(':memory:', { sample: false });
  const w = worker(store, async () => answer('Direct result'));
  try {
    store.mutate((s) => {
      const reminder = send(s, 'main', 'Remember lunch', 'queue');
      Object.assign(reminder, {
        routineId: 'old-routine',
        execution: 'reminder',
        instructions: 'Lunch time',
      });
      send(s, 'main', 'Direct question');
    });
    w.start();
    await until(() => store.read().runs.every((r) => r.status === 'completed'));
    assert.equal(store.read().messages.at(-1).text, 'Direct result');
  } finally {
    await w.stop();
    store.close();
  }
});

test('a quick direct reply invalidates an older computer plan even when it finishes before the next boundary', async () => {
  const store = new Store(':memory:', { sample: false }),
    read = held();
  let reads = 0,
    backgroundCalls = 0;
  const w = worker(
    store,
    async (messages) => {
      if (messages.some((m) => ownerText(m) === 'Quick question')) return answer('Quick reply');
      if (++backgroundCalls === 1)
        return answer(
          '',
          call('read_web', { url: 'https://example.com' }, 'read'),
          call('write_note', { name: 'stale.md', text: 'Do not execute stale plan' }, 'stale'),
        );
      assert.match(messages.find((m) => m.tool_call_id === 'stale').content, /Not executed/);
      assert.match(messages.find((m) => m.tool_call_id === 'read').content, /Kept source/);
      return answer('Replanned from saved results');
    },
    {
      computer: { enabled: true, controller: 'agent', epoch: 0 },
      readPage: async () => {
        reads++;
        await read.promise;
        return { url: 'https://example.com', title: 'Source', text: 'Kept source' };
      },
    },
  );
  try {
    store.mutate((s) => {
      const thread = command(s, 'thread.create', { title: 'Background' });
      send(s, thread.id, 'Background', 'queue');
    });
    w.start();
    await until(() => reads === 1);
    const direct = store.mutate((s) => send(s, 'main', 'Quick question'));
    await until(() => run(store, direct.id).status === 'completed');
    read.release();
    await until(() => store.read().runs.every((r) => r.status === 'completed'));
    assert.equal(backgroundCalls, 2);
    assert.equal(store.read().files.length, 0);
    assert.equal(reads, 1);
  } finally {
    read.release();
    await w.stop();
    store.close();
  }
});

test('a correction promotes a waiting background run and skips its old next tool', async () => {
  const store = new Store(':memory:', { sample: false }),
    read = held(),
    foreground = held();
  let reads = 0;
  const w = worker(
    store,
    async (messages) => {
      if (messages.some((m) => ownerText(m) === 'Foreground')) {
        await foreground.promise;
        return answer('Other reply');
      }
      if (messages.some((m) => ownerText(m) === 'Do not create the note')) {
        assert.match(messages.find((m) => m.tool_call_id === 'old').content, /Not executed/);
        return answer('Kept the source and skipped the note');
      }
      return answer(
        '',
        call('read_web', { url: 'https://example.com' }, 'read'),
        call('write_note', { name: 'old.md', text: 'Obsolete' }, 'old'),
      );
    },
    {
      readPage: async () => {
        reads++;
        await read.promise;
        return { url: 'https://example.com', title: 'Source', text: 'Kept' };
      },
    },
  );
  try {
    const bg = store.mutate((s) => {
      const thread = command(s, 'thread.create', { title: 'Background' });
      return send(s, thread.id, 'Background', 'queue');
    });
    w.start();
    await until(() => reads === 1);
    store.mutate((s) => send(s, 'main', 'Foreground'));
    read.release();
    await until(() => run(store, bg.id).waitingForReply);
    store.mutate((s) => send(s, bg.threadId, 'Do not create the note'));
    await until(() => run(store, bg.id).status === 'completed');
    assert.equal(store.read().files.length, 0);
    assert.equal(store.read().messages.at(-1).text, 'Kept the source and skipped the note');
    assert.equal(reads, 1);
  } finally {
    read.release();
    foreground.release();
    await w.stop();
    store.close();
  }
});
