// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { BrowserVault } from '../server/browser-vault.mjs';
import { BrowserRequests } from '../server/browser-requests.mjs';
const origin = 'https://notebook.example';
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('Expected browser request state');
}
function fixture(t, overrides = {}) {
  const store = new Store(':memory:', { sample: false }),
    key = randomBytes(32),
    vault = new BrowserVault(store, key),
    sent = [];
  let current = true;
  const options = {
    key,
    vault,
    resolver: async (url) => ({ url: new URL(url), address: '93.184.216.34' }),
    transport: async (input, { beforeSend }) => {
      beforeSend();
      sent.push(input);
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    },
    ...overrides,
  };
  const broker = new BrowserRequests(store, options);
  t.after(() => {
    broker.cancelAll();
    store.close();
  });
  function submit(type = 'Document', extra = {}, context = {}) {
    const promise = broker.submit(
      { url: `${origin}/${type}`, method: 'GET', headers: {}, ...extra },
      {
        actor: 'agent',
        guard() {},
        page: {
          id: 'page-one',
          resourceType: type,
          mainDocument: type === 'Document',
          current: () => current,
          ...context,
        },
      },
    );
    promise.catch(() => {});
    return promise;
  }
  const pending = async () => {
    await waitFor(() => broker.list().some((r) => r.phase === 'pending'));
    return broker.list().find((r) => r.phase === 'pending');
  };
  async function grant() {
    const promise = submit(),
      review = await pending();
    assert.deepEqual(review.pageLoad, { origin, requests: 64, milliseconds: 30000 });
    await broker.decide(review.id, review.fingerprint, true, true);
    await promise;
    assert.equal(broker.public(broker.row(review.id)).authorization, 'page-load-root');
    return review;
  }
  async function declined(promise) {
    const review = await pending();
    const before = sent.length;
    await broker.decide(review.id, review.fingerprint, false);
    await assert.rejects(promise);
    assert.equal(sent.length, before);
  }
  return {
    store,
    key,
    vault,
    broker,
    options,
    sent,
    submit,
    pending,
    grant,
    declined,
    expire() {
      broker.pageLoads.get('page-one').expires = Date.now() - 1;
    },
    stale() {
      current = false;
    },
  };
}

test('page-load permission is explicit, fingerprint-bound, typed, and cannot come from request data', async (t) => {
  const f = fixture(t),
    p = f.submit(),
    r = await f.pending();
  assert.equal(r.reviewRequired, true);
  await assert.rejects(f.broker.decide(r.id, 'wrong', true, true));
  await assert.rejects(f.broker.decide(r.id, r.fingerprint, true, 'true'));
  await assert.rejects(f.broker.decide(r.id, r.fingerprint, false, true));
  assert.equal(f.broker.pageLoads.size, 0);
  assert.equal(f.sent.length, 0);
  await f.broker.decide(r.id, r.fingerprint, true);
  await p;
  assert.equal(f.broker.pageLoads.size, 0);
  await f.declined(f.submit('Image'));
  const forged = f.broker.submit(
    {
      url: `${origin}/image`,
      method: 'GET',
      page: {
        id: 'page-one',
        mainDocument: true,
        resourceType: 'Document',
        current: () => true,
      },
    },
    { actor: 'agent', guard() {} },
  );
  forged.catch(() => {});
  const review = await f.pending();
  assert.equal(review.pageLoad, undefined);
  await assert.rejects(f.broker.decide(review.id, review.fingerprint, true, true));
  await f.declined(forged);
});

test('one page approval covers same-origin rendering resources with durable authorization receipts', async (t) => {
  const f = fixture(t);
  await f.grant();
  for (const type of ['Image', 'Stylesheet', 'Font', 'Script']) await f.submit(type);
  await f.submit('Other', { url: `${origin}/favicon.ico` });
  assert.equal(f.sent.length, 6);
  assert.equal(f.broker.list().filter((r) => r.authorization === 'page-load').length, 5);
  assert.equal(f.broker.pageLoads.get('page-one').used, 5);
});

test('forms, documents, frames, API calls, other origins and bodies still need exact review', async (t) => {
  const f = fixture(t);
  await f.grant();
  for (const [type, extra, context] of [
    ['Document'],
    ['Fetch'],
    ['XHR'],
    ['Ping'],
    ['Other'],
    ['Image', { url: 'https://other.example/pixel' }],
    ['Image', { url: 'https://notebook.example:444/pixel' }],
    ['Image', { method: 'POST', body: Buffer.from('write') }],
    ['Image', { body: Buffer.from('write') }],
    ['Other', { url: `${origin}/favicon.ico?secret=value` }],
    ['Image', {}, { id: 'child-frame' }],
  ])
    await f.declined(f.submit(type, extra, context));
  assert.equal(f.sent.length, 1);
  assert.equal(f.broker.pageLoads.get('page-one').used, 0);
});

test('page-load limits stop further automatic requests at 64 and after expiry', async (t) => {
  const f = fixture(t);
  await f.grant();
  for (let i = 0; i < 64; i++) await f.submit('Image', { url: `${origin}/image-${i}` });
  await f.declined(f.submit('Image', { url: `${origin}/over-limit` }));
  await f.grant();
  f.expire();
  await f.declined(f.submit('Script'));
  assert.equal(f.sent.length, 66);
});

test('navigation, ended action, revoke and process restart do not inherit page permission', async (t) => {
  const f = fixture(t);
  await f.grant();
  await f.declined(f.submit('Image', {}, { id: 'next-page' }));
  f.stale();
  await f.declined(f.submit('Image'));
  const p = f.submit(),
    r = await f.pending();
  await assert.rejects(f.broker.decide(r.id, r.fingerprint, true, true));
  await f.declined(p);
  f.broker.revokePageLoads();
  assert.equal(f.broker.pageLoads.size, 0);
  const restarted = new BrowserRequests(f.store, f.options);
  assert.equal(restarted.pageLoads.size, 0);
  assert(f.broker.list().some((row) => row.authorization === 'page-load-root'));
});

test('revocation between admission and socket claim prevents request bytes', async (t) => {
  let waiting, unblock;
  const pause = new Promise((r) => {
    unblock = r;
  });
  const f = fixture(t, {
    transport: async (input, { beforeSend }) => {
      if (input.url.endsWith('/Script')) {
        waiting = true;
        await pause;
      }
      beforeSend();
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    },
  });
  await f.grant();
  const p = f.submit('Script');
  await waitFor(() => waiting);
  assert.equal(f.broker.list().find((r) => r.url.endsWith('/Script')).reviewRequired, false);
  f.broker.revokePageLoads();
  unblock();
  await assert.rejects(p);
  assert.equal(f.broker.list().find((r) => r.url.endsWith('/Script')).phase, 'cancelled');
});

test('duplicate page decisions cannot renew permission during a pending dispatch', async (t) => {
  let unblock;
  const pause = new Promise((r) => {
    unblock = r;
  });
  const f = fixture(t, {
    transport: async (_input, { beforeSend }) => {
      await pause;
      beforeSend();
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    },
  });
  const p = f.submit(),
    r = await f.pending();
  const decision = f.broker.decide(r.id, r.fingerprint, true, true);
  const original = f.broker.pageLoads.get('page-one');
  await assert.rejects(f.broker.decide(r.id, r.fingerprint, true, true));
  assert.equal(f.broker.pageLoads.get('page-one'), original);
  unblock();
  await decision;
  await p;
});

test('page permission preserves credential-scope checks and exact DNS/transport authorization', async (t) => {
  const f = fixture(t);
  await f.grant();
  const cookie = f.vault.sealCookies(origin, 'session=fixture-private-session')[0];
  await f.submit('Image', { headers: { cookie } });
  assert.equal(f.sent.at(-1).headers.cookie, 'session=fixture-private-session');
  await assert.rejects(
    f.submit('Image', { url: 'https://other.example/leak', headers: { cookie } }),
  );
  assert.equal(f.sent.length, 2);
});

test('CDP metadata arriving before or after interception binds the same loader; cancellation clears a waiter', async () => {
  const { TrustedBrowser } = await import('../server/trusted-browser.mjs');
  const broker = Object.create(TrustedBrowser.prototype);
  const session = {
    controller: new AbortController(),
    networkRequests: new Map(),
    networkWaiters: new Map(),
  };
  const metadata = { frameId: 'main', loaderId: 'new-document' };
  broker.recordRequestMetadata(session, 'before', metadata);
  assert.deepEqual(await broker.requestMetadata(session, 'before'), metadata);
  const later = broker.requestMetadata(session, 'after');
  broker.recordRequestMetadata(session, 'after', metadata);
  assert.deepEqual(await later, metadata);
  const cancelled = broker.requestMetadata(session, 'cancelled');
  session.controller.abort();
  assert.equal(await cancelled, undefined);
  assert.equal(await broker.requestMetadata(session, 'after-close'), undefined);
  assert.equal(session.networkWaiters.size, 0);
  assert.equal(session.networkRequests.size, 0);
});
