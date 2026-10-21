import {
  isMemoryReview,
  emptyMemoryReply,
  emptyMemoryWireReply,
} from '../scripts/memory-review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import {
  ModelFailover,
  ModelUnavailableError,
  messagesForConnection,
} from '../server/model-failover.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { createApp } from '../server/app.mjs';
import { command } from '../shared/domain.mjs';
const key = Buffer.alloc(32, 13);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const reply = (content = 'Backup answered') =>
  json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const stream = (...frames) =>
  new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
const draft = (model, more = {}) => ({
  preset: 'custom',
  name: model,
  model,
  protocol: 'chat',
  baseUrl: `https://${model}.example/v1`,
  apiKey: `${model}-private-key`,
  ...more,
});
const input = [{ role: 'user', content: 'Help with my plan' }];
function setup(fetcher, store = new Store(':memory:', { sample: false })) {
  const models = new ModelConnections(store, { key, fetcher });
  const primary = models.save(draft('primary')).id;
  const backup = models.save(draft('backup')).id;
  return { store, models, primary, backup };
}
function run(store, id = 'run') {
  store.mutate((s) => s.runs.push({ id, status: 'running' }));
  return store.read().runs.find((r) => r.id === id);
}

test('fallback stays off until selected; ordered settings validate, persist and never add history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-backups-'));
  let store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const { models, primary, backup } = setup(async () => json({}, 503), store);
  try {
    assert.deepEqual(models.publicState().fallbacks, {});
    await assert.rejects(models.complete(input), /HTTP 503/);
    for (const ids of [[primary], [backup, backup], ['missing'], {}, [backup, 'a', 'b', 'c']])
      assert.throws(() => models.setFallbacks(primary, ids), /different saved/);
    assert.throws(() => models.setFallbacks('missing', []), /saved primary/);
    models.setFallbacks(primary, [backup]);
    assert.equal(store.read().messages.length, 0);
    assert(!JSON.stringify(store.read()).includes('-private-key'));
    assert(!store.secret('model-connections').includes('-private-key'));
    store.close();
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const restored = new ModelConnections(store, { key });
    assert.deepEqual(restored.publicState().fallbacks[primary], [backup]);
    restored.remove(backup);
    assert.deepEqual(restored.publicState().fallbacks[primary], []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('only approved destinations receive their own keys; fallback succeeds without changing the selected model', async () => {
  const calls = [];
  const { models, store, primary, backup } = setup(async (url, req) => {
    calls.push({ url, auth: req.headers.Authorization, body: JSON.parse(req.body) });
    return url.includes('primary') ? json({ error: 'Do not echo provider secrets' }, 429) : reply();
  });
  try {
    models.setFallbacks(primary, [backup]);
    const result = await models.forRun(run(store)).complete(input);
    assert.equal(result.text, 'Backup answered');
    assert.deepEqual(
      calls.map((c) => [new URL(c.url).hostname, c.auth]),
      [
        ['primary.example', 'Bearer primary-private-key'],
        ['backup.example', 'Bearer backup-private-key'],
      ],
    );
    assert.equal(models.publicState().active, primary);
    assert.equal(store.read().runs[0].modelConnection.selected, backup);
    assert.equal(store.read().runs[0].modelConnection.display.name, 'backup');
    assert.equal(store.read().runs[0].modelConnection.failovers.length, 1);
    assert(!JSON.stringify(store.read()).includes('private-key'));
  } finally {
    store.close();
  }
});

test('frozen order and chosen backup survive reopening while future requests use new policy', async () => {
  const called = [];
  const { models, store, primary, backup } = setup(async (_url, req) => {
    const name = JSON.parse(req.body).model;
    called.push(name);
    return name === 'primary' ? json({}, 503) : reply();
  });
  try {
    models.setFallbacks(primary, [backup]);
    const pinned = models.forRun(run(store));
    models.setFallbacks(primary, []);
    assert.throws(() => models.remove(backup), /answering/);
    assert.throws(() => models.save({ ...draft('backup'), id: backup }), /answering/);
    await pinned.complete(input);
    const reopened = new ModelConnections(store, { key, fetcher: models.fetcher });
    await reopened.forRun(store.read().runs[0]).complete(input);
    await assert.rejects(reopened.forRun(run(store, 'next')).complete(input), /HTTP 503/);
    assert.deepEqual(called, ['primary', 'backup', 'backup', 'primary']);
    store.mutate((s) =>
      s.runs.forEach((r) => {
        r.status = 'completed';
      }),
    );
    models.remove(backup);
    assert.throws(() => reopened.forRun(store.read().runs[0]), /connection.*changed/);
  } finally {
    store.close();
  }
});

test('three backups are attempted in explicit order at most once and exhaustion remains a single failure', async () => {
  const called = [];
  const { models, store, primary, backup } = setup(async (_url, req) => {
    called.push(JSON.parse(req.body).model);
    return json({}, 503);
  });
  try {
    const b = models.save(draft('second')).id,
      c = models.save(draft('third')).id;
    models.setFallbacks(primary, [b, backup, c]);
    await assert.rejects(models.forRun(run(store)).complete(input), /HTTP 503/);
    assert.deepEqual(called, ['primary', 'second', 'backup', 'third']);
    assert.equal(store.read().runs[0].modelConnection.failovers.length, 3);
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
  }
});

test('HTTP failures are classified narrowly; malformed output, refusal and output limits never visit a backup', async () => {
  const failures = [
    () => json({}, 400),
    () => json({}, 403),
    () => json({}, 404),
    () => json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
    () => json({ choices: [{ message: { content: 'unfinished' }, finish_reason: 'length' }] }),
    () => new Response('bad-json', { headers: { 'Content-Type': 'application/json' } }),
    () => stream({ error: { type: 'policy_refusal', message: 'provider-private-error' } }),
  ];
  for (const failure of failures) {
    const called = [];
    const { models, store, primary, backup } = setup(async (url) => {
      called.push(url);
      return failure();
    });
    try {
      models.setFallbacks(primary, [backup]);
      await assert.rejects(models.complete(input));
      assert.equal(called.length, 1);
    } finally {
      store.close();
    }
  }
  for (const status of [401, 402, 408, 429, 500, 503, 529]) {
    const { models, store, primary, backup } = setup(async (url) =>
      url.includes('primary') ? json({}, status) : reply(),
    );
    try {
      models.setFallbacks(primary, [backup]);
      assert.equal((await models.complete(input)).text, 'Backup answered');
    } finally {
      store.close();
    }
  }
});

test('cancellation and a stopped durable run prevent every later dispatch', async () => {
  const control = new AbortController();
  let calls = 0;
  const { models, store, primary, backup } = setup(async () => {
    calls++;
    control.abort();
    throw new TypeError('fetch failed');
  });
  try {
    models.setFallbacks(primary, [backup]);
    await assert.rejects(
      models.forRun(run(store)).complete(input, [], { signal: control.signal }),
      { name: 'AbortError' },
    );
    assert.equal(calls, 1);
    const pinned = models.forRun(store.read().runs[0]);
    store.mutate((s) => {
      s.runs[0].status = 'cancelled';
    });
    await assert.rejects(pinned.complete(input), { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(store.read().runs[0].modelConnection.selected, undefined);
  } finally {
    store.close();
  }
});

test('network errors and structured overloads may recover before text, but partial text is never replaced', async () => {
  for (const failure of [
    () => {
      throw new TypeError('Connection failed with secret URL');
    },
    () => stream({ error: { type: 'overloaded_error' } }),
    () => stream({ choices: [{ delta: { role: 'assistant' } }] }),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new TypeError('broken connection'));
          },
        }),
      ),
  ]) {
    const { models, store, primary, backup } = setup(async (url) =>
      url.includes('primary') ? failure() : reply(),
    );
    try {
      models.setFallbacks(primary, [backup]);
      assert.equal((await models.complete(input)).text, 'Backup answered');
    } finally {
      store.close();
    }
  }
  let calls = 0;
  const seen = [];
  const { models, store, primary, backup } = setup(async () => {
    calls++;
    return stream(
      { choices: [{ delta: { content: 'Visible start' } }] },
      { error: { type: 'overloaded_error' } },
    );
  });
  try {
    models.setFallbacks(primary, [backup]);
    await assert.rejects(
      models.complete(input, [], { onText: (text) => seen.push(text) }),
      /could not complete/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(seen, ['Visible start']);
  } finally {
    store.close();
  }
});

test('local guard/callback errors never start failover, and an attempt shares the caller deadline', async () => {
  let calls = 0;
  const control = new AbortController();
  const wrapper = new ModelFailover([{ id: 'a' }, { id: 'b' }], {
    provider: () => ({
      complete: async (_m, _t, options) => {
        if (isMemoryReview(_m)) return emptyMemoryReply();
        calls++;
        assert.notEqual(options.signal, control.signal);
        control.abort(new DOMException('Stopped', 'AbortError'));
        throw new ModelUnavailableError('Unavailable', 'busy');
      },
    }),
  });
  await assert.rejects(wrapper.complete(input, [], { signal: control.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls, 1);
  const local = new ModelFailover([{ id: 'a' }, { id: 'b' }], {
    provider: () => ({
      complete: async (_m, _t, options) => {
        if (isMemoryReview(_m)) return emptyMemoryReply();
        calls++;
        options.onText('shown');
      },
    }),
  });
  await assert.rejects(
    local.complete(input, [], {
      onText: () => {
        throw new Error('Local transcript conflict');
      },
    }),
    /transcript conflict/,
  );
  assert.equal(calls, 2);
});

test('switching connection strips foreign encrypted/signature state while preserving canonical tools, images and its own native state', () => {
  const a = { id: 'a', revision: 2 },
    b = { id: 'b', revision: 1 };
  const message = {
    role: 'assistant',
    content: 'Working',
    modelOrigin: 'a:2',
    tool_calls: [{ id: 'call', function: { name: 'lookup', arguments: '{}' } }],
    providerOutput: {
      protocol: 'chat',
      content: { reasoning_content: 'private-native-state', reasoning: 'private-ollama-state' },
    },
    responseOutput: [{ encrypted_content: 'cipher' }],
    visual: 'data:image/png;base64,AA==',
  };
  const foreign = messagesForConnection([message], b, false)[0];
  assert.equal(foreign.providerOutput, undefined);
  assert.equal(foreign.responseOutput, undefined);
  assert.equal(foreign.modelOrigin, undefined);
  assert.deepEqual(foreign.tool_calls, message.tool_calls);
  assert.equal(foreign.visual, message.visual);
  assert.deepEqual(
    messagesForConnection([message], a, true)[0].providerOutput,
    message.providerOutput,
  );
  assert.equal(
    messagesForConnection([message], { ...a, revision: 3 }, true)[0].providerOutput,
    undefined,
  );
});

test('worker resumes after one completed tool on a different protocol without repeating the action', async () => {
  const bodies = [];
  let primaryCalls = 0;
  const { models, store, primary, backup } = setup(async (url, req) => {
    if (isMemoryReview(JSON.parse(req.body))) return Response.json(emptyMemoryWireReply());
    const body = JSON.parse(req.body);
    bodies.push({ url, body, headers: req.headers });
    if (url.includes('primary')) {
      if (++primaryCalls > 1) return json({}, 429);
      return json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'Do not send native thinking to another connection',
              tool_calls: [
                {
                  id: 'learn-once',
                  type: 'function',
                  function: {
                    name: 'learn_memory',
                    arguments: JSON.stringify({
                      key: 'preference.coffee',
                      text: 'Prefers iced coffee.',
                      evidence: 'I prefer iced coffee',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }
    assert.equal(req.headers['x-api-key'], 'backup-private-key');
    assert.equal(req.headers.Authorization, undefined);
    assert(!JSON.stringify(body).includes('Do not send native thinking'));
    const result = body.messages.flatMap((m) => m.content).find((p) => p.type === 'tool_result');
    assert.equal(result.tool_use_id, 'learn-once');
    assert.equal(JSON.parse(result.content).result.status, 'saved');
    return json({
      content: [{ type: 'text', text: 'I saved your preference with the backup.' }],
      stop_reason: 'end_turn',
    });
  });
  models.save({ ...draft('backup', { protocol: 'anthropic' }), id: backup });
  models.setFallbacks(primary, [backup]);
  const worker = new BackgroundWorker(store, { provider: models, mode: 'live' });
  try {
    store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'I prefer iced coffee. Any ideas?' }),
    );
    await worker.reply(store.read().runs[0].id, new AbortController().signal);
    const state = store.read();
    assert.equal(state.runs[0].status, 'completed');
    assert.equal(state.memories.length, 1);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages.at(-1).modelBackup.name, 'backup');
    assert.equal(bodies.length, 3);
    assert.equal(models.publicState().active, primary);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('backup policy API requires the owner and same origin, validates order, and exposes no credentials', async () => {
  const { models, store, primary, backup } = setup(async () => reply());
  const app = createApp(
    store,
    { provider: models, mode: 'live', google: { configured: false } },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = (path, body, origin = url) =>
    fetch(url + path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/api/models/fallbacks', { id: primary, ids: [backup] })).status, 401);
    cookie = (await post('/api/login', { key: 'owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (
        await post(
          '/api/models/fallbacks',
          { id: primary, ids: [backup] },
          'https://elsewhere.invalid',
        )
      ).status,
      403,
    );
    const saved = await post('/api/models/fallbacks', { id: primary, ids: [backup] });
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert(!body.includes('private-key'));
    assert(!body.includes('apiKey'));
    assert.deepEqual(JSON.parse(body).fallbacks[primary], [backup]);
    assert.equal(store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('selected backup and approved order survive actual SQLite close and reopen; AI off never sends to a backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-model-resume-'));
  let store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const called = [];
  const fetcher = async (_url, req) => {
    const model = JSON.parse(req.body).model;
    called.push(model);
    return model === 'primary' ? json({}, 503) : reply();
  };
  const { models, primary, backup } = setup(fetcher, store);
  try {
    models.setFallbacks(primary, [backup]);
    await models.forRun(run(store)).complete(input);
    store.close();
    store = new Store(join(directory, 'state.sqlite'), { sample: false });
    const reopened = new ModelConnections(store, { key, fetcher });
    await reopened.forRun(store.read().runs[0]).complete(input);
    assert.deepEqual(called, ['primary', 'backup', 'backup']);
    reopened.select(null);
    assert.equal(reopened.forRun(run(store, 'off')).configured, false);
    await assert.rejects(async () => reopened.complete(input), /Connect a model/);
    assert.equal(called.length, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider failover waits through owner takeover and invalidates prior computer observations before dispatch', async () => {
  let release, announce;
  const waiting = new Promise((resolve) => {
    announce = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const computer = {
    enabled: true,
    controller: 'agent',
    epoch: 0,
    async waitForAgent(signal) {
      signal?.throwIfAborted();
      if (this.controller === 'owner') {
        announce();
        await held;
      }
      signal?.throwIfAborted();
    },
  };
  const { models, store, primary, backup } = setup(async (url, req) => {
    if (isMemoryReview(JSON.parse(req.body))) return Response.json(emptyMemoryWireReply());
    requests++;
    if (url.includes('primary')) {
      computer.controller = 'owner';
      computer.epoch++;
      return json({}, 429);
    }
    const body = JSON.parse(req.body);
    assert.equal(computer.controller, 'agent');
    assert(
      body.messages.some((m) => m.content?.includes('Previous screen observations are stale')),
    );
    return reply('Continued after you finished');
  });
  models.setFallbacks(primary, [backup]);
  const worker = new BackgroundWorker(store, { mode: 'live', provider: models, computer });
  let pending;
  try {
    store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: 'Continue our work' }));
    pending = worker.reply(store.read().runs[0].id, new AbortController().signal);
    await waiting;
    assert.equal(requests, 1);
    computer.controller = 'agent';
    computer.epoch++;
    release();
    await pending;
    assert.equal(requests, 2);
    assert.equal(store.read().runs[0].status, 'completed');
  } finally {
    release();
    await pending;
    await worker.stop();
    store.close();
  }
});
