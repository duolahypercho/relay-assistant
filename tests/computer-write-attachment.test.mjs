// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { agentReply, executeTool, toolDefinitions } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';

const request = 'On your computer, create a Markdown brief and attach the file here.';
const input = {
  action: 'write',
  path: '/workspace/brief.md',
  text: '# Brief\nBring a book.\n',
  attach: true,
};
function fixture(path = ':memory:') {
  const store = new Store(path, { sample: false });
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: request }));
  let writes = 0,
    reads = 0,
    bytes,
    afterWrite,
    afterRead;
  const operations = new Map();
  const computer = {
    enabled: true,
    epoch: 0,
    assertControl(_actor, epoch) {
      assert.equal(epoch, this.epoch, 'Owner took control');
    },
    waitForAgent: async () => {},
    async perform(action, options) {
      const key = `${options.scope}:${action.operationId}`;
      const hash = JSON.stringify(action);
      if (operations.has(key)) {
        assert.equal(operations.get(key), hash, 'Operation already belongs to another write');
        return { repeated: true };
      }
      options.guard?.();
      options.signal?.throwIfAborted();
      operations.set(key, hash);
      writes++;
      bytes = action.base64;
      await afterWrite?.();
      return { path: action.path, size: Buffer.byteLength(bytes, 'base64') };
    },
    async read(path) {
      reads++;
      await afterRead?.();
      return { name: path.split('/').at(-1), base64: bytes };
    },
  };
  const context = {
    computer,
    runId: run.id,
    threadId: 'main',
    sourceMessageId: run.messageId,
    operationId: 'host-tool-1',
  };
  return {
    store,
    run,
    computer,
    context,
    counts: () => ({ writes, reads }),
    afterWrite(fn) {
      afterWrite = fn;
    },
    afterRead(fn) {
      afterRead = fn;
    },
    bytes(value) {
      bytes = value;
    },
    execute(p = input, overrides = {}) {
      return executeTool(store, 'computer_files', p, { ...context, ...overrides });
    },
    steer() {
      store.mutate((s) => {
        s.runs[0].status = 'running';
      });
      const changed = store.mutate((s) =>
        command(s, 'chat.send', {
          threadId: 'main',
          text: 'Use a sketchbook instead. Update the same computer file and attach it here.',
          delivery: 'now',
        }),
      );
      return changed.steeringMessageIds.at(-1);
    },
  };
}

test('write and attach uses actual readback bytes, preserves Unicode and returns one real file card', async () => {
  const f = fixture();
  try {
    const text = '# 你好 🌱\nA real saved brief.\n';
    const result = await f.execute({ ...input, text });
    const file = f.store.read().files[0];
    assert.equal(file.source, 'Computer');
    assert.equal(file.mime, 'text/markdown');
    assert.equal(file.text, text);
    assert.equal(file.base64, Buffer.from(text).toString('base64'));
    assert.equal(result.result.bytes, Buffer.byteLength(text));
    assert.equal(result.result.verified, true);
    assert.deepEqual(result.card, { kind: 'file', id: file.id });
    assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
  } finally {
    f.store.close();
  }
});

test('invalid attachment arguments and oversized or malformed text fail before any computer action', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { attach: 'true' },
      { action: 'read' },
      { action: 'list' },
      { action: 'mkdir' },
      { text: undefined },
      { text: 3 },
      { text: 'x'.repeat(256001) },
      { text: '\ud800' },
      { operationId: 'not a valid identity' },
    ])
      await assert.rejects(f.execute({ ...input, ...patch }));
    await assert.rejects(
      f.execute(input, { sourceMessageId: 'unrelated' }),
      /originating chat request/,
    );
    assert.deepEqual(f.counts(), { writes: 0, reads: 0 });
    assert.equal(f.store.read().files.length, 0);
  } finally {
    f.store.close();
  }
});

test('empty and maximum sized text are verified without truncation', async () => {
  for (const text of ['', '界'.repeat(256000)]) {
    const f = fixture();
    try {
      const result = await f.execute({ ...input, text });
      assert.equal(result.result.bytes, Buffer.byteLength(text));
      assert.equal(f.store.read().files[0].text, text);
      assert.equal(result.result.textTruncated, text.length > 4000);
    } finally {
      f.store.close();
    }
  }
});

test('changed or malformed readback never becomes a successful attachment', async () => {
  for (const base64 of [
    Buffer.from('Changed outside this write').toString('base64'),
    'bad!',
    undefined,
  ]) {
    const f = fixture();
    try {
      f.afterRead(() => f.bytes(base64));
      await assert.rejects(f.execute(), /readback differs/);
      assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
      assert.equal(f.store.read().files.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('failed readback states the write completed; exact retry attaches once without rewriting', async () => {
  const f = fixture();
  try {
    f.afterRead(() => {
      throw Error('Read connection lost');
    });
    let retryId;
    await assert.rejects(f.execute(), (error) => {
      assert.match(error.message, /write completed, but readback failed/);
      retryId = error.message.match(/operationId: ([a-zA-Z0-9_.:-]+)/)?.[1];
      assert(retryId, 'A lost readback must expose the completed write identity to its caller');
      return true;
    });
    f.afterRead(null);
    const first = await f.execute(
      { ...input, operationId: retryId },
      { operationId: 'next-model-call' },
    );
    const retry = await f.execute({ ...input, operationId: first.result.retryOperationId });
    assert.equal(retry.card.id, first.card.id);
    assert.equal(retry.result.repeated, true);
    assert.deepEqual(f.counts(), { writes: 1, reads: 2 });
    assert.equal(f.store.read().files.length, 1);
  } finally {
    f.store.close();
  }
});

test('attachment receipt survives reopening the database and binds the original action', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-attach-'));
  const path = join(directory, 'data.sqlite');
  const f = fixture(path);
  let reopened;
  try {
    const first = await f.execute();
    f.store.close();
    reopened = new Store(path);
    const again = (p) => executeTool(reopened, 'computer_files', p, f.context);
    const retry = await again(input);
    assert.equal(retry.card.id, first.card.id);
    for (const patch of [{ text: 'Other' }, { overwrite: true }, { path: '/workspace/other.md' }])
      await assert.rejects(again({ ...input, ...patch }), /different action or request/);
    assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
  } finally {
    reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retry neither recreates a deleted attachment nor replaces an owner edit', async () => {
  for (const change of ['delete', 'edit']) {
    const f = fixture();
    try {
      const result = await f.execute();
      f.store.mutate((s) =>
        command(s, `file.${change}`, { id: result.card.id, text: 'Owner edit' }),
      );
      await assert.rejects(f.execute(), /removed or changed/);
      assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
      assert.equal(f.store.read().files.length, change === 'delete' ? 0 : 1);
    } finally {
      f.store.close();
    }
  }
});

test('concurrent exact retries produce a single durable attachment', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.execute(), f.execute()]);
    assert.equal(results[0].card.id, results[1].card.id);
    assert.equal(f.counts().writes, 1);
    assert.equal(f.store.read().files.length, 1);
  } finally {
    f.store.close();
  }
});

test('owner takeover or cancellation during write or read prevents attachment', async () => {
  for (const stage of ['afterWrite', 'afterRead'])
    for (const kind of ['takeover', 'abort']) {
      const f = fixture(),
        controller = new AbortController();
      try {
        f[stage](() => (kind === 'abort' ? controller.abort() : f.computer.epoch++));
        await assert.rejects(
          f.execute(input, { signal: controller.signal }),
          /Owner took control|aborted/,
        );
        assert.equal(f.store.read().files.length, 0);
      } finally {
        f.store.close();
      }
    }
});

test('a correction before or during the write/read skips stale delivery and attaches only corrected work', async () => {
  for (const stage of ['before', 'afterWrite', 'afterRead']) {
    const f = fixture();
    let source;
    try {
      if (stage === 'before') source = f.steer();
      else
        f[stage](() => {
          source = f.steer();
        });
      const stale = await f.execute();
      assert.equal(stale.result.attached, false);
      assert.equal(stale.result.written, stage !== 'before');
      assert.equal(stale.result.superseded, true);
      assert.equal(stale.result.retryOperationId, undefined);
      if (stage !== 'before')
        assert.match(stale.result.instruction, /overwrite:true and omit operationId/);
      assert.equal(stale.card, undefined);
      assert.equal(f.store.read().files.length, 0);
      f.afterWrite(null);
      f.afterRead(null);
      const text = '# Brief\nBring a sketchbook.\n';
      const corrected = await f.execute(
        { ...input, text, overwrite: true },
        { sourceMessageId: source, operationId: 'corrected-write' },
      );
      assert.equal(corrected.result.attached, true);
      assert.equal(f.store.read().files[0].text, text);
      assert.equal(f.store.read().files.length, 1);
    } finally {
      f.store.close();
    }
  }
});

test('normal writes remain unattached and the shared tool exposes the optional verified delivery field', async () => {
  const f = fixture();
  try {
    await f.execute({ ...input, attach: false });
    assert.equal(f.store.read().files.length, 0);
    assert.deepEqual(f.counts(), { writes: 1, reads: 0 });
    const definition = toolDefinitions.find((t) => t.name === 'computer_files');
    assert.equal(definition.parameters.properties.attach.type, 'boolean');
  } finally {
    f.store.close();
  }
});

test('agent delivery check accepts verified write-and-attach without another export round trip', async () => {
  const f = fixture();
  let calls = 0;
  const provider = {
    async complete(_messages, _tools, options) {
      if (++calls === 1)
        return {
          text: '',
          toolCalls: [
            {
              id: 'save-1',
              type: 'function',
              function: { name: 'computer_files', arguments: JSON.stringify(input) },
            },
          ],
        };
      assert.equal(calls, 2, 'No delivery-recovery model request should be needed');
      options.onText('Your brief is attached.');
      return { text: 'Your brief is attached.', toolCalls: [] };
    },
  };
  try {
    const result = await agentReply(
      f.store,
      provider,
      f.run,
      { computer: f.computer },
      { durable: true },
    );
    assert.equal(result.text, 'Your brief is attached.');
    assert.equal(result.cards.filter((c) => c.kind === 'file').length, 1);
    assert.equal(new AgentCheckpoint(f.store, f.run.id).load().artifactExports.length, 1);
    assert.deepEqual(
      await agentReply(f.store, provider, f.run, { computer: f.computer }, { durable: true }),
      result,
    );
    assert.equal(calls, 2);
    assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
  } finally {
    f.store.close();
  }
});

test('agent applies an in-flight correction in one run and proves delivery only for that current request', async () => {
  const f = fixture();
  let calls = 0,
    source;
  f.afterWrite(() => {
    source = f.steer();
    f.afterWrite(null);
  });
  const provider = {
    async complete(messages, _tools, options) {
      calls++;
      if (calls < 3) {
        if (calls === 2) {
          assert(messages.some((m) => m.role === 'tool' && m.content.includes('superseded')));
          assert.equal(f.store.read().files.length, 0);
        }
        return {
          text: '',
          toolCalls: [
            {
              id: `write-${calls}`,
              type: 'function',
              function: {
                name: 'computer_files',
                arguments: JSON.stringify(
                  calls === 1 ? input : { ...input, text: 'Bring a sketchbook.', overwrite: true },
                ),
              },
            },
          ],
        };
      }
      assert.equal(calls, 3);
      options.onText('The corrected brief is attached.');
      return { text: 'The corrected brief is attached.', toolCalls: [] };
    },
  };
  try {
    const result = await agentReply(
      f.store,
      provider,
      f.run,
      { computer: f.computer },
      { durable: true },
    );
    const state = f.store.read();
    assert.equal(state.runs.length, 1);
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0].text, 'Bring a sketchbook.');
    assert.equal(result.cards.filter((c) => c.kind === 'file').length, 1);
    const checkpoint = new AgentCheckpoint(f.store, f.run.id).load();
    assert.equal(checkpoint.artifactExports.length, 1);
    assert.equal(checkpoint.artifactExports[0].sourceId, source);
    assert.deepEqual(f.counts(), { writes: 2, reads: 1 });
  } finally {
    f.store.close();
  }
});
