import { isMemoryReview, emptyMemoryReply } from '../scripts/memory-review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { command } from '../shared/domain.mjs';
import { UncertainActionError } from '../server/google.mjs';
import { boundedProcess, IsolatedTerminal } from '../server/terminal.mjs';
const services = () => ({
  mode: 'sample',
  provider: { configured: false },
  readPage: async (url) => ({ url, title: 'Public source', text: 'A sourced fact.' }),
  terminal: { run: async () => ({ stdout: '/workspace', exitCode: 0, detail: 'Exit 0' }) },
});
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for worker state.');
    await delay(10);
  }
}

test('SQLite transactions roll back invalid and asynchronous mutations and persist across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-store-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  const revision = store.read().revision;
  assert.throws(
    () =>
      store.mutate((s) => {
        s.profile.name = 'Wrong';
        throw new Error('Rollback');
      }),
    /Rollback/,
  );
  assert.equal(store.read().profile.name, '');
  assert.equal(store.read().revision, revision);
  assert.throws(() => store.mutate(async () => {}), /synchronous/);
  store.mutate((s) => command(s, 'profile.update', { name: 'Saved owner' }));
  store.close();
  store = new Store(path);
  assert.equal(store.read().profile.name, 'Saved owner');
  store.close();
  await rm(dir, { recursive: true });
});
test('durable work runs without a browser client and saves a result and receipt', async () => {
  const store = new Store(':memory:');
  const t = store.mutate((s) =>
    command(s, 'task.create', { title: 'Review spending', kind: 'finance' }),
  );
  const worker = new BackgroundWorker(store, services(), { pollMs: 10, stepDelay: 0 });
  worker.start();
  try {
    await until(() => store.read().tasks[0].status === 'completed');
    const s = store.read();
    assert.ok(s.files.find((f) => f.id === s.tasks[0].resultFileId).text.includes('$4,650.00'));
    assert.equal(s.receipts[0].taskId, t.id);
  } finally {
    await worker.stop();
    store.close();
  }
});
test('two queued replies in one conversation never execute concurrently and preserve order', async () => {
  const store = new Store(':memory:');
  const ids = [];
  store.mutate((s) => {
    ids.push(
      command(s, 'chat.send', { threadId: 'main', text: 'First' }).id,
      command(s, 'chat.send', { threadId: 'main', text: 'Second' }).id,
    );
  });
  let active = 0,
    max = 0,
    count = 0;
  const provider = {
    configured: true,
    complete: async (messages) => {
      if (isMemoryReview(messages)) return emptyMemoryReply();
      active++;
      max = Math.max(max, active);
      await delay(50);
      active--;
      return { text: `Reply ${++count}`, toolCalls: [] };
    },
  };
  const worker = new BackgroundWorker(store, { ...services(), provider }, { pollMs: 5 });
  worker.start();
  try {
    await until(() => store.read().runs.every((r) => r.status === 'completed'));
    assert.equal(max, 1);
    assert.deepEqual(
      store
        .read()
        .messages.filter((m) => m.role === 'assistant' && m.id !== 'welcome')
        .map((m) => m.text),
      ['Reply 1', 'Reply 2'],
    );
    assert.deepEqual(
      store.read().runs.map((r) => r.id),
      ids,
    );
  } finally {
    await worker.stop();
    store.close();
  }
});
test('lease ownership blocks stale workers and allows expired work to be reclaimed', () => {
  const store = new Store(':memory:');
  const task = store.mutate((s) => command(s, 'task.create', { title: 'Recover' }));
  const a = new BackgroundWorker(store, services()),
    b = new BackgroundWorker(store, services());
  const original = a.claim('tasks', task.id);
  assert.equal(b.claim('tasks', task.id), null);
  store.mutate((s) => (s.tasks[0].leaseUntil = 0));
  const replacement = b.claim('tasks', task.id);
  assert.notEqual(replacement.leaseOwner, original.leaseOwner);
  assert.throws(() => a.guard('tasks', original, new AbortController().signal), /claimed/);
  b.guard('tasks', replacement, new AbortController().signal);
  store.close();
});
test('pause and cancel discard in-flight step results; retry can complete safely', async () => {
  const store = new Store(':memory:');
  const task = store.mutate((s) => command(s, 'task.create', { title: 'Hold', kind: 'finance' }));
  const worker = new BackgroundWorker(store, services(), { pollMs: 10, stepDelay: 80 });
  worker.start();
  try {
    await until(() => store.read().tasks[0].status === 'running');
    store.mutate((s) => command(s, 'task.action', { id: task.id, action: 'pause' }));
    worker.abort(task.id);
    await delay(100);
    assert.equal(store.read().tasks[0].status, 'paused');
    assert.equal(store.read().files.filter((f) => f.source === 'Hold').length, 0);
    store.mutate((s) => command(s, 'task.action', { id: task.id, action: 'cancel' }));
    store.mutate((s) => command(s, 'task.action', { id: task.id, action: 'retry' }));
    await until(() => store.read().tasks[0].status === 'completed');
    assert.equal(store.read().tasks[0].attempt, 1);
  } finally {
    await worker.stop();
    store.close();
  }
});
test('stopped streaming replies cannot append a late final answer or drain a paused follow-up', async () => {
  const store = new Store(':memory:');
  const first = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: 'First' }));
  let finish;
  const provider = {
    configured: true,
    complete: async (_messages, _tools, { onText }) => {
      if (isMemoryReview(_messages)) return emptyMemoryReply();
      onText('Partial');
      await new Promise((r) => (finish = r));
      return { text: 'Late final', toolCalls: [] };
    },
  };
  const worker = new BackgroundWorker(store, { ...services(), provider }, { pollMs: 5 });
  worker.start();
  try {
    await until(() => store.read().runs[0].partial === 'Partial');
    store.mutate((s) => {
      command(s, 'chat.send', { threadId: 'main', text: 'Follow-up' });
      command(s, 'thread.update', { id: 'main', draft: 'Unsent' });
      command(s, 'chat.stop', { id: first.id });
    });
    worker.abort(first.id);
    finish();
    await delay(70);
    const s = store.read();
    assert.equal(s.runs[0].status, 'cancelled');
    assert.equal(s.runs[1].status, 'queued');
    assert.equal(s.threads[0].draft, 'Unsent');
    assert.ok(!s.messages.some((m) => m.text === 'Late final'));
    assert.ok(s.messages.some((m) => m.interrupted && m.text === 'Partial'));
  } finally {
    finish?.();
    await worker.stop();
    store.close();
  }
});
test('pending actions never execute; approved writes are claimed once even across workers', async () => {
  const store = new Store(':memory:');
  const a = store.mutate((s) =>
    command(s, 'mail.prepare', {
      to: 'test@example.invalid',
      subject: 'One write',
      body: 'Review',
    }),
  );
  const worker = new BackgroundWorker(store, services(), { pollMs: 5 });
  worker.start();
  try {
    await delay(50);
    assert.equal(store.read().approvals[0].status, 'pending');
    assert.equal(store.read().receipts.length, 0);
    store.mutate((s) => command(s, 'approval.decide', { id: a.id, decision: 'approve' }));
    const other = new BackgroundWorker(store, services());
    await Promise.all([
      worker.execute(a.id, new AbortController().signal),
      other.execute(a.id, new AbortController().signal),
    ]);
    await until(() => store.read().approvals[0].status === 'completed');
    assert.equal(store.read().receipts.length, 1);
    assert.equal(store.read().mail.filter((m) => m.subject === 'One write').length, 1);
  } finally {
    await worker.stop();
    store.close();
  }
});
test('uncertain live writes leave a warning and are not retried on subsequent worker ticks', async () => {
  const store = new Store(':memory:');
  let count = 0;
  store.mutate(
    (s) =>
      (s.connections.google = {
        connected: true,
        generation: 1,
        email: 'a@example.com',
        write: true,
      }),
  );
  const a = store.mutate((s) =>
    command(s, 'mail.prepare', { to: 'b@example.com', subject: 'External', body: 'One attempt' }),
  );
  store.mutate((s) => command(s, 'approval.decide', { id: a.id, decision: 'approve' }));
  const worker = new BackgroundWorker(
    store,
    {
      ...services(),
      mode: 'live',
      google: {
        execute: async () => {
          count++;
          throw new UncertainActionError();
        },
      },
    },
    { pollMs: 5 },
  );
  worker.start();
  try {
    await until(() => store.read().approvals[0].status === 'outcome_unknown');
    await delay(60);
    assert.equal(count, 1);
    assert.equal(store.read().receipts.length, 0);
  } finally {
    await worker.stop();
    store.close();
  }
});
test('recovery preserves paused work, requeues safe steps, and never resends executing actions', () => {
  const store = new Store(':memory:');
  store.mutate((s) => {
    const running = command(s, 'task.create', { title: 'Interrupted' });
    running.status = 'running';
    running.leaseOwner = 'dead';
    running.leaseUntil = Date.now() + 60000;
    const paused = command(s, 'task.create', { title: 'Paused' });
    paused.status = 'paused';
    const a = command(s, 'mail.prepare', {
      to: 'a@example.invalid',
      subject: 'Uncertain',
      body: 'x',
    });
    a.status = 'executing';
  });
  recoverWork(store);
  const s = store.read();
  assert.equal(s.tasks.find((t) => t.title === 'Interrupted').status, 'queued');
  assert.equal(s.tasks.find((t) => t.title === 'Paused').status, 'paused');
  assert.equal(s.approvals[0].status, 'outcome_unknown');
  assert.ok(s.approvals[0].error.includes('Check the provider'));
  store.close();
});
test('trackers run headlessly; a paused tracker discards a stale network observation', async () => {
  const store = new Store(':memory:');
  const w = store.mutate((s) =>
    command(s, 'watch.create', {
      title: 'Public watcher',
      url: 'https://example.com',
      kind: 'text',
      expected: 'available',
      intervalMinutes: 1,
    }),
  );
  let resolvePage;
  const worker = new BackgroundWorker(
    store,
    { ...services(), readPage: async () => new Promise((r) => (resolvePage = r)) },
    { pollMs: 5 },
  );
  worker.start();
  try {
    await until(() => !!resolvePage);
    store.mutate((s) => command(s, 'watch.update', { id: w.id, paused: true }));
    resolvePage({ text: 'Available now' });
    await delay(40);
    assert.equal(store.read().notifications.length, 0);
    assert.equal(store.read().watches[0].lastHash, null);
  } finally {
    resolvePage?.({ text: '' });
    await worker.stop();
    store.close();
  }
});
test('terminal is disabled by default and bounded processes cannot expand a host shell', async () => {
  await assert.rejects(() => new IsolatedTerminal().run('pwd'), /Enable RELAY_COMPUTER_ENABLED/);
  const literal = '$(touch /tmp/relay-unwanted-test)';
  const r = await boundedProcess(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    literal,
  ]);
  assert.equal(r.stdout, literal);
  assert.equal(r.exitCode, 0);
  const timeout = await boundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeout: 40,
  });
  assert.equal(timeout.exitCode, 124);
  assert.equal(timeout.timedOut, true);
  const limited = await boundedProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(200000))'],
    { maxOutput: 1000 },
  );
  assert.ok(limited.stderr.includes('Output limit'));
});

test('Docker commands enforce non-root, read-only, offline, bounded containers with only a named volume', async () => {
  const calls = [];
  const runner = async (binary, args) => {
    calls.push({ binary, args });
    if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Not found' };
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const terminal = new IsolatedTerminal({ enabled: true, deployment: 'test', runner });
  await terminal.run('pwd');
  const run = calls.find((c) => c.args[0] === 'run').args;
  assert.ok(run.includes('--read-only'));
  assert.ok(run.includes('--cap-drop'));
  assert.equal(run[run.indexOf('--network') + 1], 'none');
  assert.equal(run[run.indexOf('--user') + 1], '1000:1000');
  assert.equal(run[run.indexOf('--memory') + 1], '512m');
  assert.ok(run[run.indexOf('--mount') + 1].startsWith('type=volume,'));
  assert.ok(!run.some((v) => v.includes('docker.sock') || v.startsWith('type=bind')));
  const exec = calls.find((c) => c.args[0] === 'exec').args;
  assert.ok(exec.includes('timeout'));
  assert.equal(exec.at(-1), 'pwd');
  assert.ok(calls.every((c) => c.binary === 'docker'));
});
test('an existing container with weakened isolation is rejected before any command executes', async () => {
  let executed = false;
  const terminal = new IsolatedTerminal({
    enabled: true,
    runner: async (_binary, args) => {
      if (args[0] === 'inspect')
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { HostConfig: { Privileged: true }, Config: {}, State: { Running: true }, Mounts: [] },
          ]),
        };
      executed = true;
      return { exitCode: 0 };
    },
  });
  await assert.rejects(() => terminal.run('pwd'), /isolation settings/);
  assert.equal(executed, false);
});
