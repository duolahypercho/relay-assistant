// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';

const call = (name, input, id = 'completed-action') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(input) },
});
const actions = [
  ['computer_run', { command: 'printf saved', seconds: 2 }],
  ['computer_files', { action: 'write', path: 'saved.txt', text: 'Saved once.' }],
  ['computer_files', { action: 'mkdir', path: 'notes' }],
  ['computer_use', { action: 'click', x: 250, y: 500, coordinateSpace: 'normalized_1000' }],
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-receipts-'));
  let store, computer;
  let guestCalls = 0,
    runtimeCalls = 0;
  const open = () => {
    store = new Store(join(directory, 'db'), { sample: false });
    computer = new PrivateComputer(store, { enabled: true, deployment: directory });
    computer.status = async () => ({ state: 'running', controller: computer.controller });
    computer.requireRunning = async () => {
      runtimeCalls++;
      return {};
    };
    computer.runtime.ensure = async () => {
      runtimeCalls++;
    };
    computer.rpc = async (input) => {
      guestCalls++;
      return {
        path: input.path,
        stdout: 'Saved once.',
        exitCode: 0,
        screenshot: 'old-image',
        accessibility: [{ text: 'stale-screen' }],
        base64: 'old-bytes',
      };
    };
  };
  open();
  const run = store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: 'Perform the requested local operation.',
    }),
  );
  store.mutate((s) => {
    s.runs[0].status = 'running';
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get computer() {
      return computer;
    },
    run,
    counts: () => ({ guestCalls, runtimeCalls }),
    reopen() {
      store.close();
      open();
    },
    async interrupt(name, input, more = []) {
      const abort = new AbortController();
      const original = computer.perform.bind(computer);
      computer.perform = async (...args) => {
        const result = await original(...args);
        abort.abort(); // Durable guest receipt exists, agent's ready checkpoint does not.
        return result;
      };
      const provider = {
        configured: true,
        complete: async () => ({
          text: '',
          toolCalls: [call(name, input), ...more],
        }),
      };
      await assert.rejects(
        agentReply(
          store,
          provider,
          run,
          { computer },
          {
            durable: true,
            signal: abort.signal,
          },
        ),
        { name: 'AbortError' },
      );
      assert.equal(store.db.prepare('SELECT phase FROM agent_checkpoints').get().phase, 'acting');
      assert.equal(
        store.db.prepare('SELECT status FROM computer_operations').get().status,
        'completed',
      );
      computer.perform = original;
    },
    resume(complete, options = {}) {
      return agentReply(
        store,
        { configured: true, complete },
        run,
        { computer },
        {
          durable: true,
          ...options,
        },
      );
    },
  };
}

for (const [name, input] of actions) {
  test(`SQLite restart recovers ${name}/${input.action || 'exec'} without any guest call`, async (t) => {
    const f = fixture(t);
    await f.interrupt(name, input, [
      call('computer_use', { action: 'click', x: 1, y: 2 }, 'stale-click'),
    ]);
    const before = f.counts();
    f.reopen();
    const result = await f.resume(async (messages) => {
      const completed = JSON.parse(
        messages.find((m) => m.tool_call_id === 'completed-action').content,
      );
      assert.equal(completed.recoveredReceipt, true);
      assert.equal(completed.result.repeated, true);
      assert.equal(completed.result.stdout, 'Saved once.');
      assert.equal(completed.result.screenshot, undefined);
      assert.equal(completed.result.accessibility, undefined);
      assert.equal(completed.result.base64, undefined);
      assert(!messages.some((m) => m.visual));
      assert.match(messages.find((m) => m.tool_call_id === 'stale-click').content, /Not executed/);
      assert(messages.some((m) => m.content?.includes('Previous screen observations are stale')));
      return { text: 'The confirmed operation is retained.', toolCalls: [] };
    });
    assert.equal(result.text, 'The confirmed operation is retained.');
    assert.deepEqual(f.counts(), before);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM computer_operations').get().n, 1);
    assert.equal(new AgentCheckpoint(f.store, f.run.id).load().phase, 'final');
  });
}

for (const outcome of ['missing', 'running', 'interrupted', 'mismatched', 'scope', 'legacy']) {
  test(`${outcome} receipt cannot execute or silently resume an interrupted action`, async (t) => {
    const f = fixture(t);
    await f.interrupt(...actions[0]);
    if (outcome === 'missing') f.store.db.exec('DELETE FROM computer_operations');
    if (['running', 'interrupted'].includes(outcome))
      f.store.db.prepare('UPDATE computer_operations SET status=?').run(outcome);
    if (outcome === 'mismatched')
      f.store.db.exec("UPDATE computer_operations SET hash='different'");
    if (outcome === 'scope') f.store.db.exec("UPDATE computer_operations SET id='another-run'");
    if (outcome === 'legacy') {
      const journal = new AgentCheckpoint(f.store, f.run.id),
        saved = journal.load();
      delete saved.computerReceiptVersion;
      journal.save('acting', saved);
    }
    f.reopen();
    const before = f.counts();
    await assert.rejects(
      f.resume(async () => assert.fail('Do not ask the model to replay uncertainty')),
      /no confirmed receipt|interrupted|different action|server stopped/,
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(f.store.db.prepare('SELECT phase FROM agent_checkpoints').get().phase, 'acting');
  });
}

test('recovery keeps the actual completed result before applying an owner correction', async (t) => {
  const f = fixture(t);
  await f.interrupt(...actions[1]);
  f.store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: 'Leave the existing file alone and just say hello.',
      delivery: 'now',
    }),
  );
  f.reopen();
  const before = f.counts();
  await f.resume(async (messages) => {
    const index = messages.findIndex((m) => m.tool_call_id === 'completed-action');
    assert.equal(JSON.parse(messages[index].content).recoveredReceipt, true);
    assert(
      messages.slice(index + 1).some((m) => m.content?.includes('Leave the existing file alone')),
    );
    return { text: 'Hello.', toolCalls: [] };
  });
  assert.deepEqual(f.counts(), before);
});

test('owner control, cancellation and a revoked lease cannot consume recovery checkpoints', async (t) => {
  for (const boundary of ['owner', 'cancelled', 'lease']) {
    await t.test(boundary, async (t) => {
      const f = fixture(t);
      await f.interrupt(...actions[0]);
      f.reopen();
      const before = f.counts();
      const abort = new AbortController();
      let beforeWork;
      if (boundary === 'owner') {
        f.store.db.exec("UPDATE computer_meta SET controller='owner'");
        beforeWork = async () => {
          abort.abort();
        };
      } else if (boundary === 'cancelled') abort.abort();
      else f.run.leaseOwner = 'expired-worker';
      await assert.rejects(
        f.resume(async () => assert.fail('Recovery must wait'), {
          signal: abort.signal,
          beforeWork,
        }),
        { name: 'AbortError' },
      );
      assert.deepEqual(f.counts(), before);
      assert.equal(f.store.db.prepare('SELECT phase FROM agent_checkpoints').get().phase, 'acting');
    });
  }
});

test('receipt-only mode rejects tools that could read, export, attach or derive new file bytes', async (t) => {
  const f = fixture(t);
  for (const [name, input] of [
    ['computer_files', { action: 'write', attach: true }],
    ['computer_files', { action: 'read' }],
    ['computer_files', { action: 'write', attach: 'false' }],
    ['computer_export', { path: 'file.txt' }],
    ['computer_import', { fileId: 'file' }],
    ['computer_edit_docx', {}],
    ['computer_start', {}],
    ['write_note', { text: 'Not allowed' }],
  ])
    await assert.rejects(
      executeTool(f.store, name, input, {
        computer: f.computer,
        computerReceiptOnly: true,
      }),
      /cannot be recovered/,
    );
  assert.deepEqual(f.counts(), { guestCalls: 0, runtimeCalls: 0 });
});

test('a model argument cannot enable receipt-only mode or bypass missing-receipt protection', async (t) => {
  const f = fixture(t);
  await executeTool(
    f.store,
    'computer_run',
    { command: 'printf saved', receiptOnly: true },
    {
      computer: f.computer,
      operationId: 'normal-call',
      runId: f.run.id,
    },
  );
  assert.equal(f.counts().guestCalls, 1, 'Only host options select recovery mode');
  await assert.rejects(
    f.computer.perform(
      { kind: 'exec', command: 'printf new', operationId: 'missing' },
      {
        scope: f.run.id,
        receiptOnly: true,
      },
    ),
    /no confirmed receipt/,
  );
  assert.equal(f.counts().guestCalls, 1);
});

test('a connection failure after receipt recovery preserves a retryable ready checkpoint', async (t) => {
  const f = fixture(t);
  await f.interrupt(...actions[0]);
  f.reopen();
  const before = f.counts();
  await assert.rejects(
    f.resume(async () => {
      throw Error('Connection unavailable');
    }),
    /Connection unavailable/,
  );
  const saved = new AgentCheckpoint(f.store, f.run.id).load();
  assert.equal(saved.phase, 'ready');
  assert.equal(saved.response, null);
  assert.equal(saved.round, 1, 'Recovery does not reset the work budget');
  f.reopen();
  await f.resume(async (messages) => {
    assert.equal(messages.filter((m) => m.tool_call_id === 'completed-action').length, 1);
    return { text: 'Recovered.', toolCalls: [] };
  });
  assert.deepEqual(f.counts(), before);
});

test('disabled computer and owner takeover refuse receipt access without touching the guest', async (t) => {
  const f = fixture(t);
  await f.interrupt(...actions[1]);
  f.reopen();
  const before = f.counts();
  const context = { computer: f.computer, computerReceiptOnly: true, runId: f.run.id };
  f.computer.enabled = false;
  await assert.rejects(executeTool(f.store, ...actions[1], context), /not enabled/);
  f.computer.enabled = true;
  f.store.db.exec("UPDATE computer_meta SET controller='owner'");
  await assert.rejects(executeTool(f.store, ...actions[1], context), /owner has taken control/);
  assert.deepEqual(f.counts(), before);
});
