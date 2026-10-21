import { ignoreMemoryReviews } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { command } from '../shared/domain.mjs';
const call = (name, args, id = name) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const response = (...toolCalls) => ({ text: '', toolCalls });
const send = (store, text = 'Save my requested preferences.') =>
  store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('Expected takeover state was not reached.');
}
function setup(provider, path = ':memory:') {
  provider = { ...provider, complete: ignoreMemoryReviews(provider.complete) };
  const store = new Store(path, { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.runtime = {
    name: computer.name + '-commands',
    ensure: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
  };
  computer.inspect = async () => null;
  const services = {
    mode: 'live',
    computer,
    provider,
    readPage: async () => ({ text: 'Read-only source' }),
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 10, stepDelay: 0 });
  return { store, computer, services, worker };
}

test('owner control holds queued replies and delegated work, including after reopening SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-takeover-'));
  let calls = 0;
  const provider = {
    configured: true,
    complete: async () => {
      calls++;
      return { text: 'Finished.', toolCalls: [] };
    },
  };
  let f = setup(provider, join(dir, 'state.sqlite'));
  try {
    await f.computer.takeControl();
    const run = send(f.store);
    const task = f.store.mutate((s) =>
      command(s, 'task.create', {
        title: 'My work',
        description: 'Write a note.',
        kind: 'general',
      }),
    );
    f.store.close();
    f = setup(provider, join(dir, 'state.sqlite'));
    recoverWork(f.store);
    f.worker.start();
    await delay(140);
    assert.equal(calls, 0);
    assert.equal(f.store.read().runs.find((r) => r.id === run.id).status, 'queued');
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id).status, 'queued');
    await f.computer.release();
    await until(() => f.store.read().runs.find((r) => r.id === run.id).status === 'completed');
    await until(() => f.store.read().tasks.find((t) => t.id === task.id).status === 'completed');
    assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
  } finally {
    await f.worker.stop();
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a model response produced across takeover cannot execute stale desktop input', async () => {
  let resolveModel,
    calls = 0,
    inputs = 0;
  const provider = {
    configured: true,
    complete: async () => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          resolveModel = resolve;
        });
      return { text: 'I have checked where we left off.', toolCalls: [] };
    },
  };
  const f = setup(provider);
  f.computer.perform = async () => {
    inputs++;
    return {};
  };
  const run = send(f.store, 'Continue work on the computer.');
  f.worker.start();
  try {
    await until(() => !!resolveModel);
    await f.computer.takeControl();
    resolveModel(
      response(call('computer_use', { action: 'click', x: 1, y: 1, operationId: 'stale' })),
    );
    await delay(140);
    assert.equal(inputs, 0);
    assert.equal(calls, 1);
    assert.equal(f.store.read().runs.find((r) => r.id === run.id).status, 'running');
    await f.computer.release();
    await until(() => f.store.read().runs.find((r) => r.id === run.id).status === 'completed');
    assert.equal(calls, 2);
    assert.equal(inputs, 0);
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

test('takeover between tools preserves completed work and discards the remaining old plan', async () => {
  let f,
    calls = 0,
    take;
  const provider = {
    configured: true,
    complete: async (messages) => {
      calls++;
      if (calls === 1)
        return response(
          call('remember', { text: 'I prefer morning walks.' }, 'first'),
          call('remember', { text: 'This stale step must not execute.' }, 'second'),
        );
      assert.ok(
        messages.some((m) => m.content?.includes('Not executed: computer control changed')),
      );
      return { text: 'Kept the completed preference and inspected the handoff.', toolCalls: [] };
    },
  };
  f = setup(provider);
  const run = send(f.store);
  const onChange = (s) => {
    if (!take && s.memories.some((m) => m.text === 'I prefer morning walks.'))
      take = f.computer.takeControl();
  };
  f.store.on('change', onChange);
  f.worker.start();
  try {
    await until(() => !!take);
    await take;
    await delay(140);
    assert.equal(calls, 1);
    assert.equal(f.store.read().memories.filter((m) => m.type === 'note').length, 1);
    await f.computer.release();
    await until(() => f.store.read().runs.find((r) => r.id === run.id).status === 'completed');
    assert.equal(f.store.read().memories.filter((m) => m.type === 'note').length, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_checkpoints').get().n, 0);
  } finally {
    f.store.off('change', onChange);
    await f.worker.stop();
    f.store.close();
  }
});

test('SQLite restart resumes after completed tools without recreating their effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-resume-'));
  let enteredSecond = false;
  let f = setup(
    {
      configured: true,
      complete: async (messages, tools, { signal }) => {
        if (!messages.some((m) => m.role === 'tool'))
          return response(call('remember', { text: 'A preference saved once.' }));
        enteredSecond = true;
        return new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Stopped', 'AbortError')),
            { once: true },
          ),
        );
      },
    },
    join(dir, 'state.sqlite'),
  );
  const run = send(f.store);
  f.worker.start();
  try {
    await until(() => enteredSecond);
    await f.worker.stop();
    assert.equal(f.store.read().memories.filter((m) => m.type === 'note').length, 1);
    f.store.close();
    let resumed = 0;
    f = setup(
      {
        configured: true,
        complete: async (messages) => {
          resumed++;
          assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
          assert.ok(messages.some((m) => m.content?.includes('A preference saved once.')));
          return { text: 'Continued after the completed step.', toolCalls: [] };
        },
      },
      join(dir, 'state.sqlite'),
    );
    recoverWork(f.store);
    f.worker.start();
    await until(() => f.store.read().runs.find((r) => r.id === run.id).status === 'completed');
    assert.equal(resumed, 1);
    assert.equal(f.store.read().memories.filter((m) => m.type === 'note').length, 1);
  } finally {
    await f.worker.stop();
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an uncertain interrupted tool is surfaced for inspection and never automatically replayed', async () => {
  let calls = 0;
  const f = setup({
    configured: true,
    complete: async () => {
      calls++;
      return response();
    },
  });
  const run = send(f.store);
  const journal = new AgentCheckpoint(f.store, run.id);
  journal.save('acting', {
    messages: [],
    round: 0,
    nextTool: 0,
    cards: [],
    prefix: '',
    response: response(call('remember', { text: 'Uncertain' })),
  });
  f.worker.start();
  try {
    await until(() => f.store.read().runs.find((r) => r.id === run.id).status === 'failed');
    assert.equal(calls, 0);
    assert.match(
      f.store.read().runs.find((r) => r.id === run.id).error,
      /will not repeat it automatically/,
    );
    assert.equal(f.store.read().memories.length, 0);
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

test('a paused run can be cancelled without a late result or leaked waiting promise', async () => {
  let done;
  const f = setup({
    configured: true,
    complete: async () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  });
  const run = send(f.store);
  f.worker.start();
  try {
    await until(() => !!done);
    await f.computer.takeControl();
    done({ text: 'Should never appear.', toolCalls: [] });
    f.store.mutate((s) => command(s, 'chat.stop', { id: run.id }));
    f.worker.abort(run.id);
    await until(() => !f.worker.active.has(run.id));
    await f.computer.release();
    assert.equal(
      f.store.read().messages.some((m) => m.text === 'Should never appear.'),
      false,
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_checkpoints').get().n, 0);
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

test('an external write already accepted before takeover records its outcome once; new writes wait', async () => {
  const f = setup({ configured: false });
  let finish,
    calls = 0;
  f.services.google = {
    execute: async () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  f.store.mutate((s) => {
    s.connections.google = {
      connected: true,
      generation: 1,
      write: true,
      email: 'fixture@example.invalid',
    };
  });
  const prepare = (subject) =>
    f.store.mutate((s) => {
      const a = command(s, 'mail.prepare', {
        to: 'fixture@example.invalid',
        subject,
        body: 'Controlled fixture only',
      });
      command(s, 'approval.decide', { id: a.id, decision: 'approve' });
      return a;
    });
  const first = prepare('First');
  f.worker.start();
  try {
    await until(() => !!finish);
    await f.computer.takeControl();
    const second = prepare('Second');
    finish({ detail: 'Controlled provider confirmed the write.', providerId: 'fixture-1' });
    await until(
      () => f.store.read().approvals.find((a) => a.id === first.id).status === 'completed',
    );
    await delay(140);
    assert.equal(calls, 1);
    assert.equal(f.store.read().approvals.find((a) => a.id === second.id).status, 'approved');
    f.services.google.execute = async () => {
      calls++;
      return { detail: 'Second controlled write.', providerId: 'fixture-2' };
    };
    await f.computer.release();
    await until(
      () => f.store.read().approvals.find((a) => a.id === second.id).status === 'completed',
    );
    assert.equal(calls, 2);
    assert.equal(f.store.read().receipts.filter((r) => r.approvalId === first.id).length, 1);
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

test('final reply checkpoints commit once without another model call and omit screen pixels', async () => {
  let calls = 0;
  const f = setup({
    configured: true,
    complete: async () => {
      calls++;
      return response();
    },
  });
  const run = send(f.store);
  const journal = new AgentCheckpoint(f.store, run.id);
  assert.throws(
    () => journal.save('ready', { text: '界'.repeat(4_000_001) }),
    /saved-context limit/,
  );
  journal.save('ready', {
    messages: [{ role: 'user', content: 'screen', visual: { base64: 'private pixels' } }],
  });
  assert.equal(
    f.store.db.prepare('SELECT body FROM agent_checkpoints').get().body.includes('private pixels'),
    false,
  );
  journal.final({ text: 'Recovered final answer.', cards: [] });
  f.worker.start();
  try {
    await until(() => f.store.read().runs.find((r) => r.id === run.id).status === 'completed');
    assert.equal(calls, 0);
    assert.equal(
      f.store.read().messages.filter((m) => m.text === 'Recovered final answer.').length,
      1,
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_checkpoints').get().n, 0);
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

test('takeover cancels in-flight read-only monitors without committing their late observations', async () => {
  const f = setup({ configured: false });
  let signal, finish;
  f.services.mailTriggers = {
    due: () => !finish,
    poll: async (s) => {
      signal = s;
      await new Promise((resolve) => {
        finish = resolve;
      });
      s.throwIfAborted();
      throw new Error('Late poll should not pass its abort guard');
    },
  };
  f.worker.start();
  try {
    await until(() => !!finish);
    await f.computer.takeControl();
    await until(() => signal.aborted);
    finish();
    await until(() => !f.worker.active.has('mail-trigger-poll'));
    assert.equal(f.store.read().runs.length, 0);
  } finally {
    finish?.();
    await f.worker.stop();
    f.store.close();
  }
});
