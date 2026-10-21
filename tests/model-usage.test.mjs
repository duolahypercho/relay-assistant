import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { usageCollector, ModelUsage } from '../server/model-usage.mjs';
import { ModelProvider } from '../server/model.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const stream = (frames) =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
const record = {
  id: 'test',
  name: 'Personal model',
  model: 'fixture',
  protocol: 'chat',
  apiKey: 'never-store-secret',
  baseUrl: 'http://127.0.0.1:1234/v1',
};
const draft = (extra = {}) => ({ ...record, id: undefined, preset: 'custom', ...extra });
const answer = (usage) => ({
  choices: [{ message: { role: 'assistant', content: 'Connected' }, finish_reason: 'stop' }],
  usage,
});
const plain = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 70 },
  completion_tokens_details: { reasoning_tokens: 5 },
};

test('cumulative reports replace counters and cache/reasoning stay subsets', () => {
  const c = usageCollector('chat');
  c.accept({ usage: plain });
  c.accept({ usage: plain });
  c.accept({ usage: null });
  assert.deepEqual(c.value, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedTokens: 70,
    cacheWriteTokens: null,
    reasoningTokens: 5,
  });
  const a = usageCollector('anthropic');
  a.accept({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
        output_tokens: 1,
      },
    },
  });
  a.accept({ type: 'message_delta', usage: { output_tokens: 12 } });
  a.accept({ type: 'message_delta', usage: { output_tokens: 12 } });
  assert.equal(a.value.inputTokens, 110);
  assert.equal(a.value.outputTokens, 12);
  assert.equal(a.value.totalTokens, 122);
  const g = usageCollector('gemini');
  g.accept({
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 30,
      totalTokenCount: 140,
      cachedContentTokenCount: 80,
    },
  });
  assert.equal(g.value.outputTokens, 40);
  assert.equal(g.value.totalTokens, 140);
  assert.equal(g.value.cachedTokens, 80);
});

test('unknown and malformed counts never turn into fabricated zeroes or negative totals', () => {
  const c = usageCollector('responses');
  c.accept({
    response: { usage: { input_tokens: '80', output_tokens: -1, total_tokens: Infinity } },
  });
  assert.equal(c.value, null);
  c.accept({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  assert.equal(c.value.totalTokens, 0);
  c.accept({ usage: { input_tokens: 10, output_tokens: null, total_tokens: null } });
  assert.equal(c.value.totalTokens, null);
  assert.equal(c.value.inputTokens, 10);
  const a = usageCollector('anthropic');
  a.accept({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: '100' } });
  assert.equal(a.value.inputTokens, null);
  assert.equal(a.value.totalTokens, null);
});

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
  for (const streaming of [true, false])
    test(`${protocol} ${streaming ? 'stream' : 'JSON'} reports persist through the actual provider adapter`, async () => {
      const store = new Store(':memory:', { sample: false });
      const ledger = new ModelUsage(store);
      let body;
      const usage =
        protocol === 'chat'
          ? plain
          : protocol === 'responses'
            ? {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
                input_tokens_details: { cached_tokens: 70 },
                output_tokens_details: { reasoning_tokens: 5 },
              }
            : protocol === 'anthropic'
              ? {
                  input_tokens: 30,
                  cache_read_input_tokens: 70,
                  cache_creation_input_tokens: 0,
                  output_tokens: 20,
                }
              : {
                  promptTokenCount: 100,
                  candidatesTokenCount: 15,
                  thoughtsTokenCount: 5,
                  totalTokenCount: 120,
                  cachedContentTokenCount: 70,
                };
      const whole =
        protocol === 'chat'
          ? answer(usage)
          : protocol === 'responses'
            ? {
                status: 'completed',
                output: [
                  { type: 'message', content: [{ type: 'output_text', text: 'Connected' }] },
                ],
                usage,
              }
            : protocol === 'anthropic'
              ? { content: [{ type: 'text', text: 'Connected' }], stop_reason: 'end_turn', usage }
              : {
                  candidates: [
                    { content: { parts: [{ text: 'Connected' }] }, finishReason: 'STOP' },
                  ],
                  usageMetadata: usage,
                };
      const frames =
        protocol === 'chat'
          ? [
              { choices: [{ delta: { content: 'Connected' }, finish_reason: 'stop' }] },
              { choices: [], usage },
              { choices: [], usage },
            ]
          : protocol === 'responses'
            ? [
                { type: 'response.output_text.delta', delta: 'Connected' },
                { type: 'response.completed', response: whole },
              ]
            : protocol === 'anthropic'
              ? [
                  { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } },
                  {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: 'Connected' },
                  },
                  { type: 'message_delta', usage: { output_tokens: 20 } },
                  { type: 'message_stop' },
                ]
              : [whole];
      try {
        const p = new ModelProvider({
          ...record,
          protocol,
          observe: () => ledger.begin({ ...record, protocol }),
          fetcher: async (_url, init) => {
            body = JSON.parse(init.body);
            return streaming ? stream(frames) : json(whole);
          },
        });
        const result = await p.complete([{ role: 'user', content: 'PRIVATE PROMPT' }]);
        assert.equal(result.text, 'Connected');
        const s = ledger.summary();
        assert.equal(s.totals.requests, 1);
        assert.equal(s.totals.completed, 1);
        assert.equal(s.totals.totalTokens, 120);
        assert.equal(s.totals.inputTokens, 100);
        assert.equal(s.totals.outputTokens, 20);
        assert.equal(s.totals.cachedTokens, 70);
        if (protocol === 'chat') assert.equal(body.stream_options.include_usage, true);
        assert.doesNotMatch(
          JSON.stringify(store.db.prepare('SELECT * FROM model_usage').all()),
          /PRIVATE PROMPT|never-store-secret|http:\/\//,
        );
        assert.deepEqual(store.read().messages, []);
      } finally {
        store.close();
      }
    });
}

test('failed streams retain partial usage; cancelled and unreported calls remain explicit', async () => {
  const store = new Store(':memory:', { sample: false });
  const ledger = new ModelUsage(store);
  try {
    const p = new ModelProvider({
      ...record,
      protocol: 'anthropic',
      observe: () => ledger.begin(record),
      fetcher: async () =>
        stream([
          { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } },
          { type: 'error', error: { type: 'overloaded_error' } },
        ]),
    });
    await assert.rejects(p.complete([]));
    let s = ledger.summary().totals;
    assert.equal(s.failed, 1);
    assert.equal(s.totalTokens, 41);
    const abort = new AbortController();
    const cancelled = new ModelProvider({
      ...record,
      observe: () => ledger.begin(record),
      fetcher: async () => {
        abort.abort();
        throw new DOMException('Stop', 'AbortError');
      },
    });
    await assert.rejects(cancelled.complete([], [], { signal: abort.signal }));
    s = ledger.summary().totals;
    assert.equal(s.cancelled, 1);
    assert.equal(s.unreported, 1);
    assert.equal(s.totalTokens, 41);
    await assert.rejects(cancelled.complete([], [], { signal: abort.signal }));
    assert.equal(ledger.summary().totals.requests, 2, 'pre-aborted calls never dispatch or count');
    await new ModelProvider({
      ...record,
      observe: () => ledger.begin(record),
      fetcher: async () => json(answer()),
    }).complete([]);
    assert.equal(ledger.summary().totals.unreported, 2);
  } finally {
    store.close();
  }
});

test('each backup attempt has its own connection usage and tests are labeled', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const m = new ModelConnections(store, {
      key: Buffer.alloc(32, 5),
      fetcher: async (url) =>
        url.startsWith('http://127.0.0.1:1234') ? json({}, 503) : json(answer(plain)),
    });
    const a = m.save(draft({ name: 'Primary' }));
    const b = m.save(draft({ name: 'Backup', baseUrl: 'http://127.0.0.1:1235/v1' }));
    m.select(a.id);
    m.setFallbacks(a.id, [b.id]);
    await m.complete([{ role: 'user', content: 'Secret prompt' }]);
    let s = m.usage.summary();
    assert.equal(s.totals.requests, 2);
    assert.equal(s.totals.failed, 1);
    assert.equal(s.totals.completed, 1);
    assert.equal(s.totals.unreported, 1);
    assert.equal(s.totals.totalTokens, 120);
    assert.equal(s.models.length, 2);
    await m.test(draft({ name: 'Check', baseUrl: 'http://127.0.0.1:1235/v1' }));
    assert.equal(m.usage.summary().totals.connectionTests, 1);
    m.remove(a.id);
    m.remove(b.id);
    assert.equal(m.usage.summary().totals.requests, 3, 'removing models retains history');
  } finally {
    store.close();
  }
});

test('custom Chat endpoints can disable the optional streaming usage parameter', async () => {
  const store = new Store(':memory:', { sample: false });
  let body;
  try {
    const m = new ModelConnections(store, {
      key: Buffer.alloc(32, 6),
      fetcher: async (_url, init) => {
        body = JSON.parse(init.body);
        assert.ok(!body.stream_options);
        return json(answer());
      },
    });
    const saved = m.save(draft({ reportUsage: false }));
    await m.complete([]);
    assert.equal(m.usage.summary().totals.unreported, 1);
    m.save(draft({ id: saved.id, model: 'renamed' }));
    assert.equal(m.current.reportUsage, false);
    assert.throws(() => m.save(draft({ reportUsage: 'no' })), /on or off/);
  } finally {
    store.close();
  }
});

test('periods use request start time, keep zero distinct from unknown, and identify an interrupted previous process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-usage-'));
  let store;
  try {
    const path = join(dir, 'state.sqlite');
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import {Store} from './server/store.mjs';import {ModelUsage} from './server/model-usage.mjs';const s=new Store(process.argv[1],{sample:false});new ModelUsage(s).begin(${JSON.stringify(record)});s.close();`,
      path,
    ]);
    store = new Store(path);
    const u = new ModelUsage(store);
    assert.equal(u.summary().totals.interrupted, 1);
    assert.equal(u.summary().totals.running, 0);
    const now = Date.now();
    const old = u.begin({ ...record, id: 'older' }, 'assistant', now - 2 * 86400000);
    old.report({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    old.finish('completed');
    old.finish('failed');
    old.report({ totalTokens: 900 });
    assert.equal(u.summary('24h', now).totals.requests, 1);
    assert.equal(u.summary('7d', now).totals.requests, 2);
    assert.equal(u.summary('7d', now).totals.totalTokens, 0);
    assert.equal(u.summary('7d', now).totals.completed, 1);
    assert.throws(() => u.summary('__proto__'), /Choose/);
    assert.throws(() => u.summary(['7d']), /Choose/);
    assert.throws(() => u.summary('365d'), /Choose/);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('usage API requires the owner session, rejects invalid periods, and reading leaves history untouched', async () => {
  const store = new Store(':memory:', { sample: false });
  const provider = new ModelConnections(store, { key: Buffer.alloc(32, 3) });
  const app = createApp(
    store,
    {
      provider,
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey: 'a-long-fixture-key-24-characters' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/api/usage')).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ key: 'a-long-fixture-key-24-characters' }),
    });
    assert.equal(login.status, 200);
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const before = store.read();
    const res = await fetch(url + '/api/usage?period=7d', { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const data = await res.json();
    assert.equal(data.totals.requests, 0);
    assert.equal(data.totals.totalTokens, null);
    assert.equal((await fetch(url + '/api/usage?period=999d', { headers })).status, 400);
    assert.equal((await fetch(url + '/api/usage?period=7d&period=24h', { headers })).status, 400);
    assert.deepEqual(store.read(), before);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('local validation failures do not create outbound usage records', async () => {
  const store = new Store(':memory:', { sample: false });
  const ledger = new ModelUsage(store);
  try {
    const p = new ModelProvider({
      ...record,
      protocol: 'anthropic',
      observe: () => ledger.begin(record),
      fetcher: async () => {
        throw Error('Should not dispatch');
      },
    });
    await assert.rejects(
      p.complete([
        {
          role: 'assistant',
          tool_calls: [{ id: 'bad', function: { name: 'lookup', arguments: 'invalid-json' } }],
        },
      ]),
      /invalid tool arguments/,
    );
    assert.equal(ledger.summary().totals.requests, 0);
  } finally {
    store.close();
  }
});
