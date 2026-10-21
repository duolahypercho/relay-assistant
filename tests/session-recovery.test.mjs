import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

async function fixture() {
  const store = new Store(':memory:');
  const services = { mode: 'sample', provider: {}, browser: {}, terminal: {}, google: {} };
  const app = createApp(store, services, {
    host: '127.0.0.1',
    port: 0,
    accessKey: 'a-fixture-owner-key-long-enough',
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = async () => {
    const r = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'a-fixture-owner-key-long-enough' }),
    });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  return {
    store,
    url,
    login,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
async function stream(f, cookie) {
  const response = await fetch(f.url + '/api/events', {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /^data: /);
  return reader;
}
async function ended(reader) {
  let text = '';
  while (true) {
    const r = await reader.read();
    if (r.done) return text;
    text += Buffer.from(r.value).toString();
  }
}
test('signing out closes every stream for that session before another workspace snapshot', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(),
      first = await stream(f, cookie),
      second = await stream(f, cookie);
    const r = await fetch(f.url + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    f.store.mutate((s) => {
      s.profile.name = 'must-not-leak';
    });
    for (const reader of [first, second]) {
      const output = await ended(reader);
      assert.equal(output, 'event: signin\ndata: {}\n\n');
      assert.doesNotMatch(output, /must-not-leak|profile/);
    }
    assert.equal(f.store.listenerCount('change'), 0);
  } finally {
    await f.close();
  }
});
test('expired authorization is checked before each live snapshot and commands stay rejected', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(),
      reader = await stream(f, cookie);
    f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
    f.store.mutate((s) => {
      s.profile.name = 'post-expiry-secret';
    });
    assert.equal(await ended(reader), 'event: signin\ndata: {}\n\n');
    assert.equal((await fetch(f.url + '/api/state', { headers: { Cookie: cookie } })).status, 401);
    assert.equal(
      (
        await fetch(f.url + '/api/command', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'profile.update', payload: { name: 'bad' } }),
        })
      ).status,
      401,
    );
    assert.equal(f.store.read().profile.name, 'post-expiry-secret');
  } finally {
    await f.close();
  }
});
test('one device can sign out while a separately authenticated device continues receiving updates', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(),
      other = await f.login();
    assert.notEqual(cookie, other);
    const one = await stream(f, cookie),
      two = await stream(f, other);
    await fetch(f.url + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.match(await ended(one), /event: signin/);
    f.store.mutate((s) => {
      s.profile.name = 'still-connected';
    });
    assert.match(Buffer.from((await two.read()).value).toString(), /still-connected/);
    await two.cancel();
    const token = other.split('=')[1];
    assert.ok(
      f.store.db
        .prepare('SELECT * FROM sessions WHERE digest=?')
        .get(createHash('sha256').update(token).digest('hex')),
    );
  } finally {
    await f.close();
  }
});
