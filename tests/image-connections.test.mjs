// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { ImageConnections } from '../server/image-connections.mjs';
import { createApp } from '../server/app.mjs';
import { avatarFixture } from './fixtures/avatar.mjs';
const key = Buffer.alloc(32, 19);
const record = {
  baseUrl: 'https://image.example/v1',
  model: 'image-test',
  format: 'gpt-image',
  apiKey: 'private-image-key',
};
const input = { revision: 1, prompt: 'A shy moon rabbit with a leaf scarf', style: 'anime' };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const reply = () => json({ data: [{ b64_json: avatarFixture().toString('base64') }] });
function fixture(fetcher = async () => reply(), options = {}) {
  const store = new Store(':memory:', { sample: false });
  const images = new ImageConnections(store, { key, fetcher, ...options });
  images.update({ ...record, action: 'save', revision: 0 });
  return { store, images };
}
test('image settings are opt-in, encrypted and durable; stale edits and wrong vault keys fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-images-'));
  let store = new Store(join(dir, 'state.sqlite'), { sample: false });
  try {
    let images = new ImageConnections(store, { key });
    assert.equal(images.publicState().configured, false);
    await assert.rejects(
      () => images.generate({ ...input, revision: 0 }),
      /Connect an image service/,
    );
    images.update({ ...record, revision: 0, action: 'save' });
    assert(!JSON.stringify(images.publicState()).includes('private-image-key'));
    assert(!store.secret('image-connections').includes('private-image-key'));
    assert(!JSON.stringify(store.read()).includes(record.baseUrl));
    assert.throws(
      () => images.update({ ...record, action: 'save', revision: 0 }),
      /another window/,
    );
    store.close();
    store = new Store(join(dir, 'state.sqlite'));
    images = new ImageConnections(store, { key });
    assert.equal(images.record().apiKey, record.apiKey);
    assert.throws(
      () => new ImageConnections(store, { key: Buffer.alloc(32, 20) }),
      /could not be unlocked/,
    );
    const before = images.publicState();
    images.update({ revision: 1, action: 'select', mode: 'off' });
    assert.equal(images.publicState().configured, false);
    assert.equal(images.publicState().saved.hasKey, true);
    images.update({ revision: 2, action: 'select', mode: 'saved' });
    assert.deepEqual(images.publicState().saved, before.saved);
    images.update({ revision: 3, action: 'remove' });
    assert.equal(images.publicState().saved, null);
    assert.equal(images.publicState().configured, false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('both image formats send one bounded owner description with destination-specific credentials and no chat context', async () => {
  const calls = [];
  const { store, images } = fixture(async (url, request) => {
    calls.push({ url, ...request, body: JSON.parse(request.body) });
    return reply();
  });
  try {
    store.mutate((s) => {
      s.profile.name = 'Private profile name';
      s.messages.push({
        id: 'private',
        text: 'Do not include this chat',
        threadId: 'main',
        role: 'user',
      });
    });
    const before = structuredClone(store.read());
    const result = await images.generate(input);
    assert.equal(result.mime, 'image/png');
    assert.deepEqual(Buffer.from(result.data, 'base64'), avatarFixture());
    assert.equal(calls[0].url, record.baseUrl + '/images/generations');
    assert.equal(calls[0].redirect, 'error');
    assert.equal(calls[0].headers.Authorization, 'Bearer private-image-key');
    assert.deepEqual(Object.keys(calls[0].body).sort(), [
      'model',
      'n',
      'output_format',
      'prompt',
      'quality',
      'size',
    ]);
    assert.match(calls[0].body.prompt, /original anime/);
    assert.match(calls[0].body.prompt, /moon rabbit/);
    assert.equal(calls[0].body.n, 1);
    assert(!JSON.stringify(calls[0].body).includes('Private profile'));
    assert(!JSON.stringify(calls[0].body).includes('Do not include'));
    assert.deepEqual(store.read(), before);
    images.update({
      ...record,
      baseUrl: 'https://other.example/v1',
      format: 'base64',
      apiKey: undefined,
      action: 'save',
      revision: 1,
    });
    assert.equal(images.publicState().saved.hasKey, false);
    await images.generate({ ...input, revision: 2, style: 'soft' });
    assert.equal(calls[1].headers.Authorization, undefined);
    assert.deepEqual(Object.keys(calls[1].body).sort(), [
      'model',
      'n',
      'prompt',
      'response_format',
    ]);
    assert.equal(calls[1].body.response_format, 'b64_json');
    assert.match(calls[1].body.prompt, /plush texture/);
  } finally {
    store.close();
  }
});
test('secret reuse requires the same image endpoint and format; all invalid setup inputs fail before saving', () => {
  const { store, images } = fixture();
  try {
    images.update({
      ...record,
      apiKey: undefined,
      model: 'another-image',
      action: 'save',
      revision: 1,
    });
    assert.equal(images.record().apiKey, record.apiKey);
    images.update({ ...record, apiKey: undefined, format: 'base64', action: 'save', revision: 2 });
    assert.equal(images.record().apiKey, '');
    for (const change of [
      { baseUrl: 'http://remote.example' },
      { baseUrl: 'https://user:key@example.com' },
      { baseUrl: 'https://example.com/?key=secret' },
      { model: '' },
      { format: 'unsupported' },
      { apiKey: '\nheader' },
    ])
      assert.throws(() => images.update({ ...record, ...change, action: 'save', revision: 3 }));
    assert.equal(images.publicState().revision, 3);
  } finally {
    store.close();
  }
});
test('invalid prompts/styles and stale consent revisions never reach the provider', async () => {
  let calls = 0;
  const { store, images } = fixture(async () => {
    calls++;
    return reply();
  });
  try {
    for (const change of [
      { prompt: '' },
      { prompt: 'x'.repeat(2001) },
      { prompt: 2 },
      { prompt: 'x\0y' },
      { style: 'unknown' },
      { revision: 0 },
    ])
      await assert.rejects(() => images.generate({ ...input, ...change }));
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
test('image errors are bounded; provider 401 never becomes an owner-session 401; generation never retries', async () => {
  let calls = 0;
  const { store, images } = fixture(async () => {
    calls++;
    return json({ error: record.apiKey }, 401);
  });
  try {
    await assert.rejects(
      () => images.generate(input),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /HTTP 401/);
        assert(!error.message.includes(record.apiKey));
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(images.pending, false);
    images.fetcher = async () => {
      throw new Error(record.apiKey);
    };
    await assert.rejects(() => images.generate(input), /could not be reached/);
  } finally {
    store.close();
  }
});
test('image outputs reject URLs, SVG, malformed base64, multiple images and excessive dimensions/response bytes', async () => {
  const huge = avatarFixture({ width: 8193, height: 1, raw: Buffer.from([0]) }).toString('base64');
  const wrong = [
    { data: [{ url: 'http://127.0.0.1/private' }] },
    { data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] },
    { data: [{ b64_json: '!!!!' }] },
    { data: [{ b64_json: huge }] },
    { data: [{ b64_json: 'eA==' }, { b64_json: 'eA==' }] },
    { error: { message: 'private-image-key' } },
  ];
  const { store, images } = fixture();
  try {
    for (const value of wrong) {
      images.fetcher = async () => json(value);
      await assert.rejects(
        () => images.generate(input),
        (e) => !e.message.includes(record.apiKey),
      );
    }
    images.fetcher = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.alloc(14_000_001));
            controller.close();
          },
        }),
      );
    await assert.rejects(() => images.generate(input), /exceeded the limit/);
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
  }
});
test('concurrent generation/settings changes are blocked; cancellation and timeout release the operation', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = async (_url, request) =>
    new Promise((_resolve, reject) => {
      entered();
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  const { store, images } = fixture(waiting);
  const abort = new AbortController();
  try {
    const request = images.generate(input, abort.signal);
    const rejected = assert.rejects(request, /stopped/);
    await started;
    assert.throws(() => images.update({ revision: 1, action: 'remove' }), /Finish or stop/);
    await assert.rejects(() => images.generate(input), /already being generated/);
    abort.abort();
    await rejected;
    assert.equal(images.pending, false);
    images.timeoutMs = 20;
    await Promise.all([assert.rejects(() => images.generate(input), /timed out/), delay(35)]);
    assert.equal(images.pending, false);
    images.fetcher = async () => reply();
    await images.generate(input);
  } finally {
    store.close();
  }
});
test('explicit server image settings are redacted, selectable and validated separately from saved credentials', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const images = new ImageConnections(store, { key, environment: record });
    assert.equal(images.publicState().mode, 'environment');
    assert(!JSON.stringify(images.publicState()).includes(record.apiKey));
    images.update({ action: 'save', revision: 0, ...record, apiKey: undefined });
    assert.equal(images.record().apiKey, '');
    images.update({ action: 'select', revision: 1, mode: 'environment' });
    assert.equal(images.record().apiKey, record.apiKey);
    assert.throws(
      () => new ImageConnections(store, { key, environment: { ...record, format: 'bad' } }),
      /format/,
    );
  } finally {
    store.close();
  }
});
test('owner image APIs require sign-in and same-origin writes, return bounded errors, and never add history', async () => {
  const { store, images } = fixture();
  const app = createApp(
    store,
    {
      mode: 'live',
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
      imageConnections: images,
    },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = (path, payload, origin = url) =>
    fetch(url + path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  try {
    assert.equal((await fetch(url + '/api/image-connection')).status, 401);
    assert.equal((await post('/api/avatar/generate', input)).status, 401);
    cookie = (await post('/api/login', { key: 'owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('/api/avatar/generate', input, 'https://elsewhere.invalid')).status,
      403,
    );
    const result = await post('/api/avatar/generate', input);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).mime, 'image/png');
    images.fetcher = async () => json({ secret: record.apiKey }, 401);
    const failure = await post('/api/avatar/generate', input);
    assert.equal(failure.status, 400);
    assert.match((await failure.json()).error, /HTTP 401/);
    for (const path of ['/api/image-connection', '/api/state', '/api/export']) {
      const state = await fetch(url + path, { headers: { Cookie: cookie } });
      assert.equal(state.status, 200);
      assert(!(await state.text()).includes(record.apiKey));
    }
    assert.equal(store.read().messages.length, 0);
    assert.equal(store.read().runs.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
