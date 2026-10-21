import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { DeviceLinks } from '../server/device-links.mjs';
import { connectionInput } from '../shared/device-link.mjs';
import { createApp } from '../server/app.mjs';
const config = {
  publicUrl: 'https://relay.example',
  accessKey: 'an-independent-fixture-owner-key',
  host: '127.0.0.1',
  port: 0,
};
const digest = (s) => createHash('sha256').update(s).digest('hex');
const token = (link) => connectionInput(link.url).token;
const owner = 'independent-fixture-owner-session';
function service(store, config, options = {}) {
  store.db
    .prepare('INSERT OR IGNORE INTO sessions VALUES (?,?)')
    .run(digest(owner), (options.now?.() || Date.now()) + 7 * 86400000);
  const links = new DeviceLinks(store, config, options),
    create = links.create.bind(links);
  links.create = () => create(owner);
  return links;
}

function fixture(options = {}) {
  const store = new Store(':memory:', { sample: false });
  let now = 1700000000000;
  const links = service(store, { ...config, ...options }, { now: () => now });
  return {
    store,
    links,
    tick: (n) => {
      now += n;
    },
    close: () => store.close(),
  };
}
test('one-use hashed grants produce independent durable sessions without changing or exporting workspace state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-pairing-')),
    file = join(dir, 'relay.sqlite');
  let store = new Store(file, { sample: false });
  try {
    let links = service(store, config);
    const before = store.read(),
      grant = links.create(),
      secret = token(grant);
    assert.doesNotMatch(
      JSON.stringify(store.db.prepare('SELECT * FROM device_links').all()),
      new RegExp(secret),
    );
    assert.doesNotMatch(JSON.stringify(links.list()), new RegExp(secret));
    store.close();
    store = new Store(file);
    links = service(store, config);
    const issued = links.redeem(secret, 'My phone', '', 'test');
    assert.ok(
      store.db.prepare('SELECT expires FROM sessions WHERE digest=?').get(digest(issued.session)),
    );
    assert.equal(links.list(issued.session).devices[0].current, true);
    assert.deepEqual(links.redeem(secret, 'ignored', issued.session, 'test'), { repeated: true });
    assert.throws(() => links.redeem(secret, 'Other phone', '', 'other'), /already used/);
    assert.deepEqual(store.read(), before);
    const device = links.list().devices[0];
    const disabled = new DeviceLinks(store, { ...config, publicUrl: '' });
    assert.equal(disabled.list().available, false);
    assert.equal(disabled.list().devices[0].id, device.id);
    disabled.disconnect(device.id);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    assert.throws(() => links.redeem(secret, 'Phone', issued.session, 'other'), /expired/);
    assert.equal(links.list().devices.length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('expiry, cancellation, replacement and configuration changes invalidate pending grants', () => {
  const f = fixture();
  try {
    const first = f.links.create(),
      second = f.links.create();
    assert.throws(() => f.links.redeem(token(first), 'Phone', '', 'a'), /expired/);
    f.links.cancel(second.id);
    assert.throws(() => f.links.redeem(token(second), 'Phone', '', 'a'), /expired/);
    const exp = f.links.create();
    f.tick(5 * 60000);
    assert.throws(() => f.links.redeem(token(exp), 'Phone', '', 'a'), /expired/);
    const current = f.links.create();
    for (const changed of [
      { publicUrl: 'https://other.example' },
      { accessKey: 'replacement-key' },
    ]) {
      const service = new DeviceLinks(f.store, { ...config, ...changed });
      assert.throws(() => service.redeem(token(current), 'Phone', '', 'a'), /expired/);
    }
  } finally {
    f.close();
  }
});
test('unprotected or noncanonical origins cannot mint a link, and inputs cannot redirect a credential', () => {
  for (const options of [
    { accessKey: '' },
    { publicUrl: undefined },
    { publicUrl: 'http://localhost' },
    { publicUrl: 'https://relay.example/elsewhere' },
    { publicUrl: 'https://user:pass@relay.example' },
    { publicUrl: 'https://relay.example/?x=1' },
  ]) {
    const f = fixture(options);
    try {
      assert.equal(f.links.list().available, false);
      assert.throws(() => f.links.create(), /HTTPS/);
    } finally {
      f.close();
    }
  }
  const good = 'https://relay.example/#connect=' + 'a'.repeat(43);
  assert.deepEqual(connectionInput(good), {
    server: 'https://relay.example',
    token: 'a'.repeat(43),
  });
  for (const invalid of [
    good + 'x',
    good + '&next=evil',
    'http://relay.example/',
    good.replace('https', 'http'),
    good.replace('/#', '/login#'),
    'https://relay.example/?token=x',
    'https://u:p@relay.example/',
    'javascript:alert(1)',
    'https://relay.example/#chat',
  ])
    assert.throws(() => connectionInput(invalid));
  assert.equal(connectionInput('http://127.0.0.1:1000/', { allowLoopbackHttp: true }).token, '');
});
test('token exchange and session insertion commit atomically and input names remain bounded', () => {
  const f = fixture();
  try {
    const grant = f.links.create();
    for (const name of ['', 'x'.repeat(61), 'bad\nname'])
      assert.throws(() => f.links.redeem(token(grant), name, '', 'test'), /short name/);
    f.store.db.exec(
      "CREATE TRIGGER break_device BEFORE INSERT ON paired_devices BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    assert.throws(() => f.links.redeem(token(grant), 'Phone', '', 'test'), /test failure/);
    assert.equal(
      f.store.db.prepare('SELECT session_digest FROM device_links').get().session_digest,
      null,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
    f.store.db.exec('DROP TRIGGER break_device');
    const saved = f.links.redeem(token(grant), 'Phone', '', 'test');
    const next = f.links.create();
    f.links.redeem(token(next), 'Replacement', saved.session, 'test');
    assert.equal(f.links.list().devices.length, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
  } finally {
    f.close();
  }
});
test('failed exchanges are bounded without consuming another valid link', () => {
  const f = fixture();
  try {
    const grant = f.links.create();
    for (let i = 0; i < 12; i++)
      assert.throws(() => f.links.redeem('not-a-token', 'Phone', '', 'same'), /expired/);
    assert.throws(
      () => f.links.redeem(token(grant), 'Phone', '', 'same'),
      (e) => e.status === 429,
    );
    f.tick(61000);
    assert.ok(f.links.redeem(token(grant), 'Phone', '', 'same').session);
    for (let i = 0; i < 20; i++) {
      const grant = f.links.create();
      f.links.redeem(token(grant), 'Another phone', '', 'new');
      if (i === 18) break;
    }
    assert.equal(f.links.list().devices.length, 20);
    assert.throws(() => f.links.create(), /older device/);
  } finally {
    f.close();
  }
});
test('owner HTTP guards, fragment links, secure sessions and immediate revocation of live streams', async () => {
  const store = new Store(':memory:', { sample: false });
  const app = createApp(
    store,
    { mode: 'sample', provider: {}, browser: {}, terminal: {}, google: {} },
    config,
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, cookie = '', origin = url) =>
    fetch(url + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('/api/device-links')).status, 401);
    const login = await post('/api/login', { key: config.accessKey });
    const owner = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/device-links', {}, owner, 'https://evil.example')).status, 403);
    const link = await (await post('/api/device-links', {}, owner)).json();
    assert.ok(link.url.startsWith('https://relay.example/#connect='));
    assert.equal(
      (
        await post(
          '/api/device-links/redeem',
          { token: token(link), name: 'Phone' },
          '',
          'https://evil.example',
        )
      ).status,
      403,
    );
    const result = await post('/api/device-links/redeem', { token: token(link), name: 'Phone' });
    assert.equal(result.status, 200);
    const setCookie = result.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const phone = setCookie.split(';')[0];
    const snapshot = await (await fetch(url + '/api/state', { headers: { Cookie: phone } })).json();
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(token(link)));
    const events = await fetch(url + '/api/events', {
      headers: { Cookie: phone },
      signal: AbortSignal.timeout(10000),
    });
    const reader = events.body.getReader();
    await reader.read();
    const devices = await (
      await fetch(url + '/api/device-links', { headers: { Cookie: owner } })
    ).json();
    assert.equal(
      (await post(`/api/devices/${devices.devices[0].id}/disconnect`, {}, owner)).status,
      200,
    );
    let tail = '';
    while (true) {
      const v = await reader.read();
      if (v.done) break;
      tail += Buffer.from(v.value).toString();
    }
    assert.equal(tail, 'event: signin\ndata: {}\n\n');
    assert.equal((await fetch(url + '/api/state', { headers: { Cookie: phone } })).status, 401);
    assert.equal((await fetch(url + '/api/state', { headers: { Cookie: owner } })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('an expired or disconnected issuing session cannot leave a usable pending access grant', () => {
  const f = fixture();
  try {
    const link = f.links.create();
    f.store.db.prepare('DELETE FROM sessions WHERE digest=?').run(digest(owner));
    assert.throws(() => f.links.redeem(token(link), 'Phone', '', 'other'), /expired/);
    assert.throws(
      () => f.links.create(),
      (e) => e.status === 401,
    );
  } finally {
    f.close();
  }
});
