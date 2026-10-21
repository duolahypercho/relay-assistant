import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { createApp } from '../server/app.mjs';
const response = (data) => new Response(JSON.stringify({ data }));

test('local discovery checks only two fixed loopback catalogs, without credentials, inference, activation or workspace changes', async () => {
  const store = new Store(':memory:', { sample: false });
  const calls = [];
  const manager = new ModelConnections(store, {
    key: Buffer.alloc(32, 1),
    fetcher: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.body, undefined);
      if (url.includes(':1234/')) throw Error('Do not expose raw provider errors or secrets');
      return response([{ id: 'chat-model' }, { id: 'chat-model' }, { id: '' }, { id: 'bad\nid' }]);
    },
  });
  try {
    manager.save({
      name: 'Keep selected',
      preset: 'custom',
      baseUrl: 'https://example.com/v1',
      protocol: 'chat',
      model: 'saved-model',
      apiKey: 'private-saved-key',
      activate: true,
    });
    const before = store.read(),
      vault = store.secret('model-connections');
    const result = await manager.discoverLocal();
    assert.deepEqual(
      calls.map((c) => c.url).sort(),
      ['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:1234/v1/models'].sort(),
    );
    assert.deepEqual(
      result.services.map((s) => s.status),
      ['ready', 'unavailable'],
    );
    assert.deepEqual(result.services[0].models, [{ id: 'chat-model', name: 'chat-model' }]);
    assert(!JSON.stringify(result).includes('secrets'));
    assert.deepEqual(store.read(), before);
    assert.equal(store.secret('model-connections'), vault);
  } finally {
    store.close();
  }
});

test('local discovery distinguishes empty catalogs, isolates malformed services and honors cancellation', async () => {
  const store = new Store(':memory:', { sample: false });
  let pending = false;
  const manager = new ModelConnections(store, {
    key: Buffer.alloc(32, 2),
    fetcher: async (url, init) => {
      if (pending)
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
        );
      return url.includes(':11434/') ? response([]) : new Response('invalid json');
    },
  });
  try {
    assert.deepEqual(
      (await manager.discoverLocal()).services.map((s) => s.status),
      ['empty', 'unavailable'],
    );
    pending = true;
    const controller = new AbortController();
    const result = manager.discoverLocal(controller.signal);
    controller.abort(new Error('Owner left setup'));
    await assert.rejects(result, /Owner left setup/);
    assert.equal(manager.configured, false);
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
  }
});

test('a slow local catalog is bounded independently, retaining results from the available service', async () => {
  const store = new Store(':memory:', { sample: false });
  let aborted = false;
  const manager = new ModelConnections(store, {
    key: Buffer.alloc(32, 3),
    fetcher: async (url, init) => {
      if (url.includes(':11434/')) return response([{ id: 'ready-model' }]);
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(Error('deadline failed')), 8000);
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  try {
    const result = await manager.discoverLocal();
    assert.equal(aborted, true);
    assert.deepEqual(
      result.services.map((s) => s.status),
      ['ready', 'unavailable'],
    );
  } finally {
    store.close();
  }
});

test('local discovery is owner-only and same-origin; caller data cannot change discovery targets', async () => {
  const store = new Store(':memory:', { sample: false }),
    urls = [];
  const provider = new ModelConnections(store, {
    key: Buffer.alloc(32, 4),
    fetcher: async (url) => {
      urls.push(url);
      return response([]);
    },
  });
  const app = createApp(
    store,
    { mode: 'live', provider, google: {}, browser: {}, terminal: {} },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', source = origin) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('models/local', {})).status, 401);
    const cookie = (await post('login', { key: 'owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal((await post('models/local', {}, cookie, 'https://outside.example')).status, 403);
    assert.deepEqual(urls, []);
    const result = await post(
      'models/local',
      { baseUrl: 'http://169.254.169.254', apiKey: 'must-not-send' },
      cookie,
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).services.length, 2);
    assert(urls.every((url) => /^http:\/\/127\.0\.0\.1:(11434|1234)\/v1\/models$/.test(url)));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
