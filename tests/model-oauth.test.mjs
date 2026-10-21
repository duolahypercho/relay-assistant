// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ModelConnections, modelVaultKey } from '../server/model-connections.mjs';
import { openRouterBase } from '../server/model-oauth.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { appSignInURL } from '../native/desktop/urls.mjs';
const origin = 'https://relay.example';
const key = 'private-openrouter-key';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(fetcher = async () => json({ key })) {
  const store = new Store(':memory:', { sample: false });
  const model = new ModelConnections(store, { key: Buffer.alloc(32, 9), fetcher });
  return { store, model };
}
function start(model) {
  const begin = model.oauth.begin(origin),
    url = new URL(begin.openUrl);
  const opened = model.oauth.open(begin.id, url.searchParams.get('ticket'), origin);
  return {
    ...begin,
    ...opened,
    state: new URL(opened.url).searchParams.get('state'),
    cookies: { [opened.cookie]: opened.nonce },
    input: {
      oauthId: begin.id,
      preset: 'openrouter',
      baseUrl: openRouterBase,
      protocol: 'chat',
      model: 'fixture/model',
    },
  };
}
async function authorize(model, flow) {
  return model.oauth.callback({ state: flow.state, code: 'single-use-code' }, flow.cookies, origin);
}

test('OpenRouter sign-in keeps its key encrypted across SQLite reopen and saves exactly once without activating early', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-model-oauth-'));
  let store;
  const exchanges = [],
    fetcher = async (url, options) => {
      if (url.endsWith('/auth/keys')) {
        exchanges.push({ url, options });
        return json({ key });
      }
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${key}`);
      return json({ data: [{ id: 'fixture/model', name: 'Fixture' }] });
    };
  try {
    store = new Store(join(dir, 'state.sqlite'), { sample: false });
    let model = new ModelConnections(store, { key: modelVaultKey(dir), fetcher });
    const initial = store.read(),
      flow = start(model);
    assert.equal(model.configured, false);
    assert.equal(new URL(flow.url).origin, 'https://openrouter.ai');
    assert.equal(new URL(flow.url).searchParams.get('code_challenge_method'), 'S256');
    await authorize(model, flow);
    assert.equal(exchanges.length, 1);
    const body = JSON.parse(exchanges[0].options.body);
    assert.equal(
      createHash('sha256').update(body.code_verifier).digest('base64url'),
      new URL(flow.url).searchParams.get('code_challenge'),
    );
    assert.equal(exchanges[0].options.redirect, 'error');
    assert.equal(exchanges[0].url, 'https://openrouter.ai/api/v1/auth/keys');
    assert.deepEqual(store.read(), initial);
    assert.equal(model.configured, false);
    for (const value of [
      store.secret('model-oauth'),
      JSON.stringify(model.oauth.result(flow.id)),
      JSON.stringify(model.publicState()),
    ])
      assert(!value.includes(key));
    store.close();
    store = new Store(join(dir, 'state.sqlite'));
    model = new ModelConnections(store, { key: modelVaultKey(dir), fetcher });
    assert.deepEqual(await model.discover(flow.input), {
      models: [{ id: 'fixture/model', name: 'Fixture' }],
      more: false,
    });
    const saved = model.save({ ...flow.input, activate: true });
    assert.equal(model.current.apiKey, key);
    assert.equal(model.oauth.flow(flow.id).apiKey, undefined);
    assert(!store.secret('model-connections').includes(key));
    model.select(null);
    const duplicate = model.save({ ...flow.input, activate: true });
    assert.equal(duplicate.id, saved.id);
    assert.equal(model.publicState().connections.length, 1);
    assert.equal(model.configured, false, 'lost-response retry must not reset a newer selection');
    model.remove(saved.id);
    assert.throws(() => model.save(flow.input), /removed/);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('sign-in is bound to the initiating browser, exact Relay origin, one-use ticket and official provider destination', async () => {
  let calls = 0;
  const { store, model } = fixture(async () => {
    calls++;
    return json({ key });
  });
  try {
    const begin = model.oauth.begin(origin),
      u = new URL(begin.openUrl);
    assert.throws(() => model.oauth.open(begin.id, 'wrong', origin));
    assert.throws(() =>
      model.oauth.open(begin.id, u.searchParams.get('ticket'), 'https://other.example'),
    );
    const opened = model.oauth.open(begin.id, u.searchParams.get('ticket'), origin);
    assert.throws(() => model.oauth.open(begin.id, u.searchParams.get('ticket'), origin));
    const state = new URL(opened.url).searchParams.get('state'),
      cookies = { [opened.cookie]: opened.nonce };
    await assert.rejects(model.oauth.callback({ state, code: 'code' }, {}, origin));
    await assert.rejects(model.oauth.callback({ state: 'wrong', code: 'code' }, cookies, origin));
    await assert.rejects(
      model.oauth.callback({ state, code: 'code' }, cookies, 'https://elsewhere.example'),
    );
    assert.equal(calls, 0);
    await model.oauth.callback({ state, code: 'code' }, cookies, origin);
    await assert.rejects(model.oauth.callback({ state, code: 'code' }, cookies, origin));
    for (const mutation of [
      { preset: 'custom' },
      { baseUrl: 'https://other.example/v1' },
      { protocol: 'anthropic' },
      { id: 'existing' },
      { apiKey: 'injected' },
    ])
      assert.throws(
        () => model.save({ oauthId: begin.id, preset: 'openrouter', model: 'test', ...mutation }),
        /only for a new OpenRouter/,
      );
    assert.equal(calls, 1);
    assert.equal(model.publicState().connections.length, 0);
  } finally {
    store.close();
  }
});

test('cancel, expiry and restart during code exchange cannot resurrect a key or replay a consumed code', async () => {
  for (const mode of ['cancel', 'expire', 'restart']) {
    let resolve, entered;
    const seen = new Promise((r) => {
      entered = r;
    });
    const { store, model } = fixture(async () => {
      entered();
      return new Promise((r) => {
        resolve = r;
      });
    });
    try {
      const flow = start(model),
        work = authorize(model, flow);
      await seen;
      if (mode === 'cancel') model.oauth.cancel(flow.id);
      if (mode === 'expire') {
        const pending = model.oauth.flow(flow.id);
        pending.expires = Date.now() - 1;
        model.oauth.write(pending);
      }
      if (mode === 'restart') new ModelConnections(store, { key: Buffer.alloc(32, 9) });
      resolve(json({ key }));
      await work;
      assert.throws(() => model.save(flow.input), /Sign in/);
      assert(!model.oauth.flow(flow.id)?.apiKey);
      assert.equal(model.configured, false);
    } finally {
      store.close();
    }
  }
});

test('declined, malformed, oversized and failed exchanges remain private and require a fresh sign-in', async () => {
  for (const respond of [
    () => json({ error: key }, 401),
    () => json({ key: 'has\nnewline' }),
    () => json({ key, large: 'x'.repeat(33000) }),
    () => {
      throw Error(key);
    },
  ]) {
    const { store, model } = fixture(respond);
    try {
      const flow = start(model);
      await authorize(model, flow);
      assert.equal(model.oauth.result(flow.id).phase, 'failed');
      assert(!JSON.stringify(model.oauth.result(flow.id)).includes(key));
      assert(!model.oauth.flow(flow.id).verifier);
      assert.throws(() => model.save(flow.input));
    } finally {
      store.close();
    }
  }
  const { store, model } = fixture(() => {
    throw Error('Must not exchange a denied code');
  });
  try {
    const flow = start(model);
    await model.oauth.callback({ flow: flow.id, error: 'access_denied' }, flow.cookies, origin);
    assert.equal(model.oauth.result(flow.id).phase, 'failed');
    assert(!model.oauth.flow(flow.id).browserHash);
  } finally {
    store.close();
  }
});

test('sign-in limits and failed save validation preserve the ready key without creating duplicate connections', async () => {
  const { store, model } = fixture();
  try {
    assert.throws(() => model.oauth.begin('http://remote.example'), /HTTPS/);
    const flow = start(model);
    await authorize(model, flow);
    assert.throws(() => model.save({ ...flow.input, model: '' }), /model ID/);
    assert.equal(model.oauth.result(flow.id).phase, 'ready');
    for (let i = 0; i < 3; i++) model.oauth.begin(origin);
    assert.throws(() => model.oauth.begin(origin), /Finish or cancel/);
    model.oauth.cancel(flow.id);
    assert.doesNotThrow(() => model.oauth.begin(origin));
    assert.equal(model.publicState().connections.length, 0);
  } finally {
    store.close();
  }
});

test('a storage failure rolls back both the connection and its sign-in receipt for an explicit retry', async () => {
  const { store, model } = fixture();
  try {
    const flow = start(model);
    await authorize(model, flow);
    const original = store.secret.bind(store);
    store.secret = (name, value) => {
      if (name === 'model-oauth' && value !== undefined) throw Error('Controlled storage failure');
      return original(name, value);
    };
    assert.throws(() => model.save(flow.input), /storage failure/);
    store.secret = original;
    assert.equal(model.publicState().connections.length, 0);
    assert.equal(model.oauth.result(flow.id).phase, 'ready');
    const saved = model.save(flow.input);
    assert.equal(model.current.apiKey, key);
    assert.equal(model.save(flow.input).id, saved.id);
    assert.equal(model.publicState().connections.length, 1);
  } finally {
    store.close();
  }
});

test('owner APIs require authentication and same-origin writes while browser callback uses only a scoped one-use cookie', async () => {
  const { store, model } = fixture();
  const services = {
    mode: 'live',
    provider: model,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: 'owner-secret' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', extra = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, ...extra },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/api/models/oauth/begin', {})).status, 401);
    assert.equal((await fetch(base + '/api/models/oauth/result?id=anything')).status, 401);
    const login = await post('/api/login', { key: 'owner-secret' });
    const owner = login.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (await post('/api/models/oauth/begin', {}, owner, { Origin: 'https://evil.example' })).status,
      403,
    );
    const begin = await (await post('/api/models/oauth/begin', {}, owner)).json();
    const open = await fetch(begin.openUrl, { redirect: 'manual' });
    assert.equal(open.status, 303);
    const browserCookie = open.headers.get('set-cookie');
    assert(browserCookie.includes('HttpOnly'));
    assert(browserCookie.includes('SameSite=Lax'));
    assert(browserCookie.includes('Path=/api/models/oauth/callback'));
    const state = new URL(open.headers.get('location')).searchParams.get('state');
    const callback = `${base}/api/models/oauth/callback?state=${state}&code=code`;
    assert.equal((await fetch(callback)).status, 400);
    const completed = await fetch(callback, { headers: { Cookie: browserCookie.split(';')[0] } });
    assert.equal(completed.status, 200);
    assert.equal(completed.headers.get('referrer-policy'), 'no-referrer');
    assert(!(await completed.text()).includes(key));
    assert.equal(
      (await fetch(base + '/api/state', { headers: { Cookie: browserCookie.split(';')[0] } }))
        .status,
      401,
    );
    assert.deepEqual(
      await (
        await fetch(base + '/api/models/oauth/result?id=' + begin.id, {
          headers: { Cookie: owner },
        })
      ).json(),
      { phase: 'ready' },
    );
    assert.equal(model.configured, false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('native model sign-in opener keeps strict workspace, path and parameter checks', () => {
  const url = `${origin}/api/models/oauth/open?id=12345678-1234-1234-1234-123456789012&ticket=${'a'.repeat(43)}`;
  assert.equal(appSignInURL(url, origin + '/#settings?section=models', origin), url);
  for (const [target, frame] of [
    [url, origin + '/preview'],
    [url.replace('relay.example', 'other.example'), origin],
    [url + '&next=x', origin],
    [url.replace('/open?', '/callback?'), origin],
    [url.replace('/models/', '/unknown/'), origin],
  ])
    assert.throws(() => appSignInURL(target, frame, origin));
});
