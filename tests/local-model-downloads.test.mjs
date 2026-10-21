// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { LocalModelDownloads, localModelTag } from '../server/local-model-downloads.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { createApp } from '../server/app.mjs';
const tag = 'qwen3.5:4b';
const stream = (events) =>
  new Response(events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n'));
function fixture() {
  const store = new Store(':memory:', { sample: false });
  const calls = [];
  let mode = 'success',
    aborted = false;
  const make = (options = {}) =>
    new LocalModelDownloads(store, {
      probe: async () => ({ running: mode !== 'offline' }),
      stall: 100,
      timeout: 2000,
      fetcher: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/api/tags'))
          return Response.json({ models: mode === 'missing' ? [] : [{ name: tag }] });
        if (mode === 'hold')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      status: 'pulling abc',
                      digest: 'sha256:abc',
                      total: 1000,
                      completed: 400,
                    }) + '\n',
                  ),
                );
                init.signal.addEventListener(
                  'abort',
                  () => {
                    aborted = true;
                    controller.error(init.signal.reason);
                  },
                  { once: true },
                );
              },
            }),
          );
        if (mode === 'secret-error') return stream([{ error: 'DO-NOT-ECHO-private-key' }]);
        if (mode === 'oversized') return stream(['x'.repeat(66000)]);
        if (mode === 'unfinished') return stream([{ status: 'pulling manifest' }]);
        if (mode === 'http-error') return new Response('DO-NOT-ECHO-private-key', { status: 500 });
        return stream([
          { status: 'pulling manifest' },
          { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 1000 },
          { status: 'success' },
        ]);
      },
      ...options,
    });
  return {
    store,
    calls,
    make,
    setMode(value) {
      mode = value;
    },
    get aborted() {
      return aborted;
    },
  };
}
test('download requires explicit local registry tag; rejects paths, remote registries, cloud and implicit tags', () => {
  for (const value of ['qwen3.5:4b', 'publisher/chat-model:q4_0'])
    assert.equal(localModelTag(value), value);
  for (const value of [
    '',
    undefined,
    'qwen3.5',
    'qwen3.5:cloud-cloud',
    'qwen3.5:cloud',
    'https://evil/model:tag',
    'evil.example/model:tag',
    '127.0.0.1:9999/model:tag',
    '../secret:tag',
    '/tmp/model:tag',
    'foo:tag\n',
    'foo:tag;echo',
    'a/b/c:tag',
  ])
    assert.throws(() => localModelTag(value));
});
test('explicit pull is fixed loopback, credential-free, verifies installation, deduplicates and leaves chat/model choice untouched', async () => {
  const f = fixture(),
    manager = f.make(),
    before = f.store.read(),
    id = randomUUID();
  try {
    assert.equal(manager.status().download, null);
    assert.equal(f.calls.length, 0);
    manager.start({ id, model: tag, baseUrl: 'http://evil.test', apiKey: 'never-send' });
    manager.start({ id, model: tag });
    assert.throws(() => manager.start({ id, model: 'other:tag' }));
    assert.throws(() => manager.start({ model: 'other:tag' }));
    await manager.pending;
    assert.equal(manager.status().download.phase, 'ready');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].url, 'http://127.0.0.1:11434/api/pull');
    assert.equal(f.calls[0].init.redirect, 'error');
    assert.deepEqual(f.calls[0].init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(f.calls[0].init.body), {
      model: tag,
      stream: true,
      insecure: false,
    });
    assert.equal(f.calls[1].url, 'http://127.0.0.1:11434/api/tags');
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.store.secret('model-connections'), undefined);
    manager.start({ id, model: tag });
    assert.equal(f.calls.length, 2);
    const reopened = f.make();
    assert.equal(reopened.status().download.phase, 'ready');
    await reopened.close();
  } finally {
    await manager.close();
    f.store.close();
  }
});
test('cancel checks request identity, aborts the stream, preserves shared cache and allows a fresh retry', async () => {
  const f = fixture(),
    manager = f.make({ stall: 10000 });
  f.setMode('hold');
  try {
    const { download } = manager.start({ model: tag });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(manager.status().download.completed, 400);
    await assert.rejects(manager.cancel({ id: randomUUID() }), /changed/);
    await manager.cancel({ id: download.id });
    assert.equal(f.aborted, true);
    assert.equal(manager.status().download.phase, 'cancelled');
    assert.equal(f.calls.length, 1, 'Cancellation must never delete shared weights.');
    f.setMode('success');
    manager.start({ model: tag });
    await manager.pending;
    assert.equal(manager.status().download.phase, 'ready');
  } finally {
    await manager.close();
    f.store.close();
  }
});
test('shutdown and abrupt service restart expose interruption without restarting or activating a download', async () => {
  const f = fixture(),
    manager = f.make({ stall: 10000 });
  f.setMode('hold');
  try {
    manager.start({ model: tag });
    await new Promise((r) => setTimeout(r, 10));
    const afterCrash = f.make();
    assert.equal(afterCrash.status().download.phase, 'interrupted');
    assert.equal(f.calls.length, 1);
    await afterCrash.close();
    await manager.close();
    assert.equal(manager.status().download.phase, 'interrupted');
    assert.equal(f.aborted, true);
    assert.throws(() => manager.start({ model: tag }), /stopping/);
    const restarted = f.make();
    assert.equal(restarted.status().download.phase, 'interrupted');
    await restarted.close();
  } finally {
    await manager.close();
    f.store.close();
  }
});
test('missing success, absent installed model, oversized or rejected responses fail inline without leaking provider details', async () => {
  const f = fixture(),
    manager = f.make();
  try {
    for (const mode of [
      'offline',
      'secret-error',
      'oversized',
      'unfinished',
      'http-error',
      'missing',
    ]) {
      f.setMode(mode);
      manager.start({ model: tag });
      await manager.pending;
      assert.equal(manager.status().download.phase, 'error', mode);
      assert(!JSON.stringify(manager.status()).includes('DO-NOT-ECHO'));
    }
  } finally {
    await manager.close();
    f.store.close();
  }
});
test('a large model can emit more than 32 MB of bounded progress before verified completion', async () => {
  const f = fixture();
  let chunks = 0,
    bytes = 0;
  const encoder = new TextEncoder();
  const manager = f.make({
    timeout: 30000,
    fetcher: async (url) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: tag }] });
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (chunks === 400) {
              controller.enqueue(encoder.encode('{"status":"success"}\n'));
              controller.close();
              return;
            }
            const progress = Array.from(
              { length: 1000 },
              (_, i) =>
                JSON.stringify({
                  status: 'pulling abc',
                  digest: 'sha256:abc',
                  total: 8000000000,
                  completed: (chunks * 1000 + i + 1) * 20000,
                }) + '\n',
            ).join('');
            chunks++;
            const data = encoder.encode(progress);
            bytes += data.length;
            controller.enqueue(data);
          },
        }),
      );
    },
  });
  try {
    manager.start({ model: tag });
    await manager.pending;
    assert(bytes > 32 * 1024 * 1024);
    assert.equal(manager.status().download.phase, 'ready');
  } finally {
    await manager.close();
    f.store.close();
  }
});

test('continuous valid progress cannot outlive the overall download deadline', async () => {
  const f = fixture();
  let timer,
    events = 0,
    abortReason,
    aborted = false;
  const manager = f.make({
    timeout: 60,
    stall: 30,
    fetcher: async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const emit = () => {
              events++;
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify({ status: 'pulling manifest' }) + '\n'),
              );
            };
            emit();
            timer = setInterval(emit, 5);
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                abortReason = signal.reason;
                clearInterval(timer);
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
          cancel() {
            clearInterval(timer);
          },
        }),
      ),
  });
  try {
    manager.start({ model: tag });
    await manager.pending;
    assert(events > 1);
    assert(aborted);
    assert.equal(abortReason?.name, 'TimeoutError');
    assert.equal(manager.status().download.phase, 'error');
  } finally {
    clearInterval(timer);
    await manager.close();
    f.store.close();
  }
});

test('a stalled stream is aborted and releases the next download slot', async () => {
  const f = fixture(),
    manager = f.make();
  f.setMode('hold');
  try {
    manager.start({ model: tag });
    await manager.pending;
    assert.equal(f.aborted, true);
    assert.equal(manager.status().download.phase, 'error');
    f.setMode('success');
    manager.start({ model: tag });
    await manager.pending;
    assert.equal(manager.status().download.phase, 'ready');
  } finally {
    await manager.close();
    f.store.close();
  }
});
test('download API is owner-only and same-origin; status reads never start a request', async () => {
  const f = fixture(),
    manager = f.make();
  const provider = new ModelConnections(f.store, { key: Buffer.alloc(32, 3) });
  const server = createApp(
    f.store,
    { mode: 'live', provider, localModelDownloads: manager, google: {}, browser: {}, terminal: {} },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-key' },
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', source = origin) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('models/local/download/start', { model: tag })).status, 401);
    const cookie = (await post('login', { key: 'owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('models/local/download/start', { model: tag }, cookie, 'https://evil.test'))
        .status,
      403,
    );
    const status = await fetch(origin + '/api/models/local/download', {
      headers: { Cookie: cookie },
    });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal(f.calls.length, 0);
    assert.equal((await post('models/local/download/start', { model: tag }, cookie)).status, 200);
    await manager.pending;
    assert.equal(manager.status().download.phase, 'ready');
    assert.equal(f.store.read().messages.length, 0);
  } finally {
    await manager.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});
