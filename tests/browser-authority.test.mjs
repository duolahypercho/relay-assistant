// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { Store } from '../server/store.mjs';
import { encrypt } from '../server/google.mjs';
import { BrowserVault } from '../server/browser-vault.mjs';
import { BrowserRequests, pinnedBrowserRequest } from '../server/browser-requests.mjs';
import { resolveDestination } from '../server/network.mjs';

const origin = 'https://account.example';
const request = (extra = {}) => ({
  url: `${origin}/notes`,
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: Buffer.from('original note'),
  ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const resolver = async (value) => ({ url: new URL(value), address: '93.184.216.34' });
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('Expected browser state did not arrive.');
}
function fixture(t, options = {}) {
  const store = new Store(':memory:', { sample: false }),
    key = randomBytes(32);
  const vault = new BrowserVault(store, key),
    sent = [];
  const transport = async (input, { beforeSend }) => {
    beforeSend();
    sent.push(input);
    return { status: 200, headers: {}, body: Buffer.from('saved') };
  };
  const broker = new BrowserRequests(store, { key, vault, resolver, transport, ...options });
  t.after(() => {
    broker.cancelAll();
    store.close();
  });
  const submit = (input = request(), authority = {}) =>
    broker.submit(input, { actor: 'agent', guard() {}, ...authority });
  const pending = async () => {
    await waitFor(() => broker.list().some((r) => r.phase === 'pending'));
    return broker.list().find((r) => r.phase === 'pending');
  };
  return { store, key, vault, broker, sent, submit, pending };
}

test('cookie surrogates persist encrypted; workspace exports contain no browser credentials', (t) => {
  const { vault, store, key } = fixture(t);
  const [header] = vault.sealCookies(origin, [
    'session=sensitive_cookie_9; Path=/; Secure; HttpOnly; SameSite=Lax',
  ]);
  const alias = header.match(/relay_cookie_[a-f0-9]{48}/)[0];
  assert(!header.includes('sensitive_cookie_9'));
  assert(header.endsWith('; Path=/; Secure; HttpOnly; SameSite=Lax'));
  assert.equal(vault.sealCookies(origin, 'session=sensitive_cookie_9')[0], `session=${alias}`);
  vault.saveLogin(origin, { username: 'owner@example.test', password: 'Secret password&42' });
  vault.saveStorage({ cookies: [{ value: alias }], origins: [] });
  const restored = new BrowserVault(store, key);
  assert.equal(
    restored.request(request({ headers: { cookie: `session=${alias}` } })).headers.cookie,
    'session=sensitive_cookie_9',
  );
  assert.equal(restored.login(origin).password, 'Secret password&42');
  assert.equal(restored.storage().cookies[0].value, alias);
  for (const value of ['sensitive_cookie_9', alias, 'Secret password&42', 'owner@example.test']) {
    assert(!store.secret('trusted-browser-vault').includes(value));
    assert(!JSON.stringify(store.read()).includes(value));
  }
  assert.equal(
    restored.redact(`cookie ${alias} password Secret%20password%2642`),
    'cookie [private] password [private]',
  );
});

test('vault corruption and wrong keys fail closed rather than silently logging out or sending aliases', (t) => {
  const f = fixture(t);
  f.vault.sealCookies(origin, 'session=value');
  assert.throws(() => new BrowserVault(f.store, randomBytes(32)), /unlocked/);
  f.store.secret(
    'trusted-browser-vault',
    encrypt({ version: 1, revision: 0, cookies: [{ alias: 'bad' }], logins: [] }, f.key),
  );
  assert.throws(() => new BrowserVault(f.store, f.key), /unlocked/);
});

test('cookie scope cannot cross origin, subdomain, port or HTTPS downgrade, including body and URL tokens', (t) => {
  const { vault } = fixture(t);
  const cookie = vault.sealCookies(origin, 'session=top_secret')[0],
    alias = cookie.split('=')[1];
  for (const destination of [
    'https://thief.example',
    'https://child.account.example',
    'https://account.example:444',
    'http://account.example',
  ]) {
    for (const input of [
      request({ url: `${destination}/?token=${alias}` }),
      request({ url: destination, headers: { cookie } }),
      request({ url: destination, body: Buffer.from(alias) }),
    ]) {
      assert.throws(() => vault.request(input), /destination|HTTPS/);
    }
  }
  assert.throws(
    () => vault.request(request({ headers: { cookie: `session=relay_cookie_${'a'.repeat(48)}` } })),
    /destination/,
  );
  for (const bad of [
    'http://account.example',
    'file:///tmp/login',
    'https://user:password@account.example',
  ])
    assert.throws(() => vault.saveLogin(bad, { username: 'owner', password: 'private' }), /HTTPS/);
});

test('binary uploads survive cookie substitution, form tokens are encoded and cookie rotation retains old valid aliases', (t) => {
  const { vault } = fixture(t);
  const a = vault.sealCookies(origin, 'csrf=a&b=+%')[0].split('=')[1];
  const b = vault.sealCookies(origin, 'csrf=rotated')[0].split('=')[1];
  assert.notEqual(a, b);
  const binary = Buffer.concat([
    Buffer.from([0, 0xff, 0x80]),
    Buffer.from(a),
    Buffer.from([0xfe, 0]),
  ]);
  const result = vault.request(request({ body: binary }));
  assert.deepEqual(
    result.body,
    Buffer.concat([Buffer.from([0, 0xff, 0x80]), Buffer.from('a&b=+%'), Buffer.from([0xfe, 0])]),
  );
  const form = vault.request(
    request({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from(`csrf=${a}&note=hello`),
    }),
  );
  assert.equal(form.body.toString(), 'csrf=a%26b%3D%2B%25&note=hello');
  assert.equal(
    vault.request(request({ url: `${origin}/?csrf=${a}` })).url,
    `${origin}/?csrf=a%26b%3D%2B%25`,
  );
  assert.equal(vault.materialize(b, origin), 'rotated');
});

test('every agent request, including GET, waits for its exact immutable review', async (t) => {
  const f = fixture(t),
    input = request({ method: 'GET', body: undefined });
  const response = f.submit(input),
    review = await f.pending();
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.broker.decide(review.id, 'wrong', true), /matches/);
  assert.equal(f.sent.length, 0);
  await f.broker.decide(review.id, review.fingerprint, true);
  assert.equal((await response).status, 200);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
});

test('changes during initial DNS and after review cannot change authorized URL, headers or bytes', async (t) => {
  const gate = deferred();
  const f = fixture(t, {
    resolver: async (u) => {
      await gate.promise;
      return resolver(u);
    },
  });
  const input = request(),
    response = f.submit(input);
  input.url = 'https://thief.example/delete';
  input.headers['content-type'] = 'application/json';
  input.body.fill('x');
  gate.resolve();
  const review = await f.pending();
  assert.equal(review.url, `${origin}/notes`);
  assert.equal(review.body, 'original note');
  await f.broker.decide(review.id, review.fingerprint, true);
  await response;
  assert.equal(f.sent[0].url, `${origin}/notes`);
  assert.equal(f.sent[0].headers['content-type'], 'text/plain');
  assert.equal(f.sent[0].body.toString(), 'original note');
});

test('simultaneous approvals dispatch once and the losing approval cannot cancel the winner', async (t) => {
  const entered = deferred(),
    release = deferred();
  let sends = 0;
  const f = fixture(t, {
    transport: async (_input, { beforeSend }) => {
      entered.resolve();
      await release.promise;
      beforeSend();
      sends++;
      return { status: 204, headers: {} };
    },
  });
  const response = f.submit(),
    review = await f.pending();
  const approval = f.broker.decide(review.id, review.fingerprint, true);
  await entered.promise;
  await assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /already/);
  assert.equal(f.broker.row(review.id).phase, 'pending');
  release.resolve();
  await approval;
  assert.equal((await response).status, 204);
  assert.equal(sends, 1);
  assert.equal(f.broker.row(review.id).phase, 'completed');
});

test('decline sends no network bytes and removes the live review', async (t) => {
  const f = fixture(t),
    response = f.submit();
  const rejected = assert.rejects(response, /declined/),
    review = await f.pending();
  await f.broker.decide(review.id, review.fingerprint, false);
  await rejected;
  assert.equal(f.sent.length, 0);
  assert.equal(f.broker.active.size, 0);
  assert.equal(f.broker.row(review.id).phase, 'declined');
});

test('takeover during dispatch DNS cancels before the durable claim or any send', async (t) => {
  const gate = deferred(),
    entered = deferred();
  let owner = false,
    sends = 0;
  const f = fixture(t, {
    transport: async (_input, { beforeSend }) => {
      entered.resolve();
      await gate.promise;
      beforeSend();
      sends++;
      return { status: 200, headers: {} };
    },
  });
  const response = f.submit(request(), {
    guard() {
      if (owner) throw Error('owner took control');
    },
  });
  const rejected = assert.rejects(response, /authorized/),
    review = await f.pending();
  const approval = assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
  await entered.promise;
  owner = true;
  gate.resolve();
  await approval;
  await rejected;
  assert.equal(sends, 0);
  assert.equal(f.broker.row(review.id).phase, 'cancelled');
});

test('abort during initial validation or queued review never reaches transport', async (t) => {
  const gate = deferred(),
    controller = new AbortController();
  const f = fixture(t, {
    resolver: async (u) => {
      await gate.promise;
      return resolver(u);
    },
  });
  const response = f.submit(request(), { signal: controller.signal });
  const rejected = assert.rejects(response, /abort/i);
  controller.abort();
  await rejected;
  gate.resolve();
  assert.equal(f.broker.list().length, 0);
  const second = new AbortController();
  const pending = f.submit(request(), { signal: second.signal });
  const cancelled = assert.rejects(pending, /cancelled/);
  await f.pending();
  second.abort();
  await cancelled;
  assert.equal(f.sent.length, 0);
  assert.equal(f.broker.active.size, 0);
});

test('a lost response after send is uncertain, sanitized and never replayed', async (t) => {
  let sends = 0;
  const f = fixture(t, {
    transport: async (_input, { beforeSend }) => {
      beforeSend();
      sends++;
      throw Error('socket failed with private_password_123');
    },
  });
  const response = f.submit(),
    rejected = assert.rejects(response, /uncertain/),
    review = await f.pending();
  await assert.rejects(
    f.broker.decide(review.id, review.fingerprint, true),
    (e) => !e.message.includes('private_password_123'),
  );
  await rejected;
  assert.equal(f.broker.row(review.id).phase, 'uncertain');
  await assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
  assert.equal(sends, 1);
  assert(!JSON.stringify(f.broker.list()).includes('private_password_123'));
});

test('revocation during an in-flight request discards response and prevents new cookies being saved', async (t) => {
  const started = deferred(),
    release = deferred();
  const f = fixture(t, {
    transport: async (_input, { beforeSend, signal }) => {
      beforeSend();
      started.resolve(signal);
      await release.promise;
      return { status: 200, headers: { 'set-cookie': ['session=late_cookie'] } };
    },
  });
  const response = f.submit(),
    rejected = assert.rejects(response, /session changed/),
    review = await f.pending();
  const approved = assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
  const signal = await started.promise;
  f.broker.cancelAll();
  assert(signal.aborted);
  release.resolve();
  await rejected;
  await approved;
  assert.equal(f.broker.row(review.id).phase, 'uncertain');
  assert.equal(f.vault.read().cookies.length, 0);
});

test('server restart interrupts pending and executing requests; none are reconstructed or sent', async (t) => {
  const f = fixture(t),
    response = f.submit(),
    rejected = assert.rejects(response, /session changed/);
  const review = await f.pending();
  const next = new BrowserRequests(f.store, {
    key: f.key,
    vault: f.vault,
    resolver,
    transport: async () => assert.fail('replayed'),
  });
  assert.equal(next.list()[0].phase, 'interrupted');
  await assert.rejects(next.decide(review.id, review.fingerprint, true), /ended/);
  f.broker.cancelAll();
  await rejected;
  f.store.db
    .prepare("UPDATE trusted_browser_requests SET phase='executing' WHERE id=?")
    .run(review.id);
  const again = new BrowserRequests(f.store, { key: f.key, vault: f.vault, resolver });
  assert.equal(again.list()[0].phase, 'interrupted');
  assert.equal(again.active.size, 0);
});

test('owner requests use the same credential and durable transport boundary without an extra review', async (t) => {
  const f = fixture(t);
  const cookie = f.vault.sealCookies(origin, 'session=owner_secret')[0];
  await f.submit(request({ headers: { cookie } }), { actor: 'owner' });
  assert.equal(f.sent[0].headers.cookie, 'session=owner_secret');
  assert.equal(f.broker.list()[0].phase, 'completed');
  assert.equal(f.broker.list()[0].headers.cookie, '[private]');
  assert(!f.broker.row(f.broker.list()[0].id).payload.includes(cookie));
});

test('response cookies become surrogates; review bodies and auth headers mask known credentials', async (t) => {
  const f = fixture(t, {
    transport: async (_input, { beforeSend }) => {
      beforeSend();
      return {
        status: 200,
        headers: { 'set-cookie': ['session=response_secret; Secure; Path=/'] },
        body: Buffer.from('ok'),
      };
    },
  });
  f.vault.saveLogin(origin, { username: 'example-owner', password: 'private&password' });
  const response = f.submit(
    request({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Bearer hidden',
      },
      body: Buffer.from('password=private%26password'),
    }),
  );
  const review = await f.pending();
  assert.equal(review.body, 'password=[private]');
  assert.equal(review.headers.authorization, '[private]');
  await f.broker.decide(review.id, review.fingerprint, true);
  const result = await response;
  assert(!result.headers['set-cookie'][0].includes('response_secret'));
  assert.match(result.headers['set-cookie'][0], /^session=relay_cookie_/);
});

test('invalid protocols, malformed framing, duplicate headers and excessive requests are rejected before send', async (t) => {
  const f = fixture(t);
  for (const input of [
    request({ method: 'CONNECT' }),
    request({ url: 'http://account.example' }),
    request({ url: 'https://user:secret@account.example' }),
    request({ headers: { test: 'bad\r\nx: y' } }),
    request({ headers: { Cookie: 'a', cookie: 'b' } }),
    request({ body: 'not bytes' }),
    request({ body: Buffer.alloc(8_000_001) }),
  ])
    await assert.rejects(f.submit(input));
  await f.submit(
    request({
      headers: {
        connection: 'x-secret',
        'x-secret': 'must not send',
        host: 'thief.example',
        'transfer-encoding': 'chunked',
        referer: 'https://private.example',
        'x-valid': 'yes',
      },
    }),
    { actor: 'owner' },
  );
  assert.deepEqual({ ...f.sent[0].headers }, { 'x-valid': 'yes' });
  const pending = Array.from({ length: 30 }, () => f.submit().catch(() => {}));
  await waitFor(() => f.broker.active.size === 30);
  await assert.rejects(f.submit(), /waiting/);
  f.broker.cancelAll();
  await Promise.all(pending);
  assert.equal(f.sent.length, 1);
});

test('final DNS resolution is pinned, requests are sent once, and HTTPS redirects are returned for a new decision', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-browser-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'key.pem'),
    '-out',
    join(directory, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=relay-browser.test',
    '-addext',
    'subjectAltName=DNS:relay-browser.test',
  ]);
  const cert = await readFile(join(directory, 'cert.pem'));
  const incoming = [];
  const server = https.createServer(
    { key: await readFile(join(directory, 'key.pem')), cert },
    async (req, res) => {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      incoming.push({
        url: req.url,
        method: req.method,
        body: Buffer.concat(chunks).toString(),
        host: req.headers.host,
      });
      if (req.url === '/large') {
        res.end(Buffer.alloc(101));
        return;
      }
      if (req.url === '/lost') {
        req.socket.destroy();
        return;
      }
      if (req.url === '/slow') {
        const interval = setInterval(() => res.write('x'), 5);
        res.on('close', () => clearInterval(interval));
        return;
      }
      res.writeHead(302, {
        location: 'https://thief.example/steal',
        'set-cookie': ['session=new_cookie; Secure'],
      });
      res.end('redirect');
    },
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  const base = `https://relay-browser.test:${server.address().port}`;
  let resolutions = 0,
    claimed = false;
  const local = async (url) => {
    resolutions++;
    return { url: new URL(url), address: '127.0.0.1' };
  };
  const response = await pinnedBrowserRequest(request({ url: `${base}/save` }), {
    resolver: local,
    ca: cert,
    beforeSend() {
      claimed = true;
    },
  });
  assert(claimed);
  assert.equal(resolutions, 1);
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, 'https://thief.example/steal');
  assert.deepEqual(incoming, [
    { url: '/save', method: 'POST', body: 'original note', host: new URL(base).host },
  ]);
  await assert.rejects(
    pinnedBrowserRequest(request({ url: `${base}/large` }), {
      resolver: local,
      ca: cert,
      maxBytes: 100,
    }),
    /limit/,
  );
  await assert.rejects(
    pinnedBrowserRequest(request({ url: `${base}/lost` }), { resolver: local, ca: cert }),
  );
  assert.equal(incoming.filter((r) => r.url === '/lost').length, 1);
  const gate = deferred(),
    controller = new AbortController();
  const aborted = pinnedBrowserRequest(request({ url: `${base}/aborted` }), {
    resolver: async (url) => {
      await gate.promise;
      return local(url);
    },
    ca: cert,
    signal: controller.signal,
    beforeSend() {
      assert.fail('claimed after abort');
    },
  });
  const rejected = assert.rejects(aborted, /abort/i);
  controller.abort();
  gate.resolve();
  await rejected;
  assert.equal(incoming.length, 3);
  await assert.rejects(
    pinnedBrowserRequest(request({ url: `${base}/forbidden` }), {
      resolver: local,
      ca: cert,
      beforeSend() {
        throw Error('takeover');
      },
    }),
    /takeover/,
  );
  assert.equal(incoming.length, 3);
  await assert.rejects(
    pinnedBrowserRequest(
      request({ url: `https://wrong-browser.test:${server.address().port}/bad-certificate` }),
      { resolver: local, ca: cert },
    ),
    (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID',
  );
  assert.equal(incoming.length, 3);
  await assert.rejects(
    pinnedBrowserRequest(request({ url: `${base}/slow` }), {
      resolver: local,
      ca: cert,
      timeoutMs: 500,
    }),
    /abort|too long/i,
  );
  assert.equal(incoming.length, 4);
});

test('a DNS lookup that never returns is bounded by the same total deadline, before send', async () => {
  await assert.rejects(
    pinnedBrowserRequest(request(), {
      resolver: () => new Promise(() => {}),
      timeoutMs: 20,
      beforeSend() {
        assert.fail('Sent after DNS timeout');
      },
    }),
    /too long/,
  );
});

test('private destinations and DNS rebinding are denied by the production destination policy', async (t) => {
  const f = fixture(t, { resolver: undefined });
  for (const url of [
    'https://127.0.0.1/',
    'https://10.1.2.3/',
    'https://169.254.169.254/',
    'https://localhost/',
    'https://account.example:8000/',
  ])
    await assert.rejects(f.submit(request({ url })), /Private|standard ports/);
  assert.equal(f.broker.list().length, 0);
  let resolutions = 0;
  const changing = (value) =>
    resolveDestination(value, async () => [
      { address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 },
    ]);
  const r = fixture(t, {
    resolver: changing,
    transport: (input, options) =>
      pinnedBrowserRequest(input, {
        ...options,
        beforeSend() {
          assert.fail('Private destination reached dispatch');
        },
      }),
  });
  const response = r.submit(),
    rejected = assert.rejects(response, /authorized/),
    review = await r.pending();
  await assert.rejects(r.broker.decide(review.id, review.fingerprint, true), /ended/);
  await rejected;
  assert.equal(resolutions, 2);
  assert.equal(r.broker.row(review.id).phase, 'cancelled');
});

test('changed durable review data or a transport bypassing the send claim cannot complete', async (t) => {
  const f = fixture(t),
    response = f.submit(),
    rejected = assert.rejects(response, /authorized/),
    review = await f.pending();
  f.store.db
    .prepare('UPDATE trusted_browser_requests SET payload=? WHERE id=?')
    .run(encrypt({ url: `${origin}/delete`, method: 'DELETE', headers: {} }, f.key), review.id);
  await assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
  await rejected;
  assert.equal(f.sent.length, 0);
  const r = fixture(t, { transport: async () => ({ status: 200, headers: {} }) });
  await assert.rejects(r.submit(request(), { actor: 'owner' }), /authorized/);
  assert.equal(r.broker.list()[0].phase, 'cancelled');
});

test('approval requires a boolean and an explicit false or asynchronous control guard cannot authorize a request', async (t) => {
  const f = fixture(t),
    response = f.submit(),
    review = await f.pending();
  for (const allow of ['true', 'false', 1, {}, undefined])
    await assert.rejects(f.broker.decide(review.id, review.fingerprint, allow), /Choose/);
  assert.equal(f.sent.length, 0);
  const declined = assert.rejects(response, /declined/);
  await f.broker.decide(review.id, review.fingerprint, false);
  await declined;
  await assert.rejects(f.submit(request(), { guard: () => false }), /authorized/);
  await assert.rejects(f.submit(request(), { guard: async () => true }), /authorized/);
  assert.equal(f.broker.active.size, 0);
});

test('clearing or changing credentials invalidates an already-reviewed request before it can send', async (t) => {
  const f = fixture(t);
  for (const change of [
    () => f.vault.clear(),
    () => f.vault.saveLogin(origin, { username: 'owner', password: 'replacement-password' }),
  ]) {
    const response = f.submit(),
      rejected = assert.rejects(response, /authorized/),
      review = await f.pending();
    change();
    await assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
    await rejected;
    assert.equal(f.broker.row(review.id).phase, 'cancelled');
  }
  assert.equal(f.sent.length, 0);
});

test('credential revocation while DNS or a response is pending cannot send cached secrets or restore cookies', async (t) => {
  for (const afterSend of [false, true]) {
    const gate = deferred(),
      entered = deferred();
    let sends = 0;
    const f = fixture(t, {
      transport: async (_input, { beforeSend }) => {
        if (afterSend) {
          beforeSend();
          sends++;
        }
        entered.resolve();
        await gate.promise;
        if (!afterSend) {
          beforeSend();
          sends++;
        }
        return { status: 200, headers: { 'set-cookie': 'session=late_secret' } };
      },
    });
    const cookie = f.vault.sealCookies(origin, 'session=cached_secret')[0];
    const response = f.submit(request({ headers: { cookie } }));
    const rejected = assert.rejects(response, afterSend ? /uncertain/ : /authorized/),
      review = await f.pending();
    const approval = assert.rejects(f.broker.decide(review.id, review.fingerprint, true), /ended/);
    await entered.promise;
    f.vault.clear();
    gate.resolve();
    await approval;
    await rejected;
    assert.equal(sends, afterSend ? 1 : 0);
    assert.equal(f.vault.read().cookies.length, 0);
    assert.equal(f.broker.row(review.id).phase, afterSend ? 'uncertain' : 'cancelled');
  }
});

test('bounded history keeps live reviews visible and retains a just-completed older request', async (t) => {
  const f = fixture(t),
    response = f.submit(),
    review = await f.pending();
  for (let i = 0; i < 45; i++) await f.submit(request(), { actor: 'owner' });
  assert.equal(f.broker.list().length, 41);
  assert.equal(f.broker.list()[0].id, review.id);
  assert.equal(f.broker.list()[0].phase, 'pending');
  const result = await f.broker.decide(review.id, review.fingerprint, true);
  await response;
  assert.equal(result.phase, 'completed');
  assert.equal(f.broker.list().length, 40);
  const large = request({ body: Buffer.alloc(8_000_000, 'x') });
  await f.submit(large, { actor: 'owner' });
  await f.submit(large, { actor: 'owner' });
  const retained = f.store.db
    .prepare('SELECT sum(length(payload)) AS bytes FROM trusted_browser_requests')
    .get();
  assert(retained.bytes <= 16_000_000);
});

test('completed review masking survives login replacement and clearing the credential vault', async (t) => {
  const f = fixture(t);
  f.vault.saveLogin(origin, { username: 'fixture-owner', password: 'old-password-secret' });
  await f.submit(
    request({
      url: `${origin}/login?hint=old-password-secret`,
      body: Buffer.from('password=old-password-secret'),
    }),
    { actor: 'owner' },
  );
  const before = f.broker.list()[0];
  assert(!JSON.stringify(before).includes('old-password-secret'));
  f.vault.saveLogin(origin, { username: 'fixture-owner', password: 'new-password-secret' });
  assert(!JSON.stringify(f.broker.list()).includes('old-password-secret'));
  f.vault.clear();
  assert(!JSON.stringify(f.broker.list()).includes('old-password-secret'));
  assert.equal(f.broker.list()[0].body, before.body);
  assert.equal(f.broker.list()[0].destination, origin);
});

test('the request limit includes DNS preparation and releases every reservation after cancellation', async (t) => {
  const gate = deferred(),
    signals = Array.from({ length: 30 }, () => new AbortController());
  let resolutions = 0;
  const f = fixture(t, {
    resolver: async (url) => {
      resolutions++;
      await gate.promise;
      return resolver(url);
    },
  });
  const pending = signals.map((controller) =>
    f.submit(request(), { signal: controller.signal }).catch(() => {}),
  );
  await assert.rejects(f.submit(), /waiting/);
  assert.equal(resolutions, 30);
  assert.equal(f.broker.preparing, 30);
  for (const controller of signals) controller.abort();
  await Promise.all(pending);
  gate.resolve();
  assert.equal(f.broker.preparing, 0);
  assert.equal(f.broker.active.size, 0);
  assert.equal(f.broker.list().length, 0);
});
