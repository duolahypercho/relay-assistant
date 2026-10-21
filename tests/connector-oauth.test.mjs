// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { Connectors } from '../server/connectors.mjs';
import { oauthFetch } from '../server/connector-oauth.mjs';
import { appSignInURL } from '../native/desktop/urls.mjs';
import { oauthConnectorFixture } from '../scripts/connector-oauth-fixture.mjs';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-oauth-')),
    key = randomBytes(32),
    remote = await oauthConnectorFixture();
  const store = new Store(join(dir, 'state.sqlite'), { sample: false });
  let connectors = new Connectors(store, { key });
  t.after(async () => {
    connectors.close();
    store.close();
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  });
  const begin = (input = {}) =>
    connectors.oauth.begin(
      { name: 'Notebook', endpoint: remote.endpoint, ...input },
      'http://127.0.0.1:9999',
    );
  async function consent(start, allow = true) {
    const open = new URL(start.openUrl),
      opened = connectors.oauth.open(start.id, open.searchParams.get('ticket'));
    const response = await fetch(opened.url);
    assert.equal(response.status, 200);
    const id = (await response.text()).match(/name="id" value="([^"]+)"/)[1];
    const r = await fetch(`${remote.root}/consent`, {
      method: 'POST',
      body: new URLSearchParams({ id, choice: allow ? 'allow' : 'deny' }),
      redirect: 'manual',
    });
    return {
      params: Object.fromEntries(new URL(r.headers.get('location')).searchParams),
      cookies: { [opened.cookie]: opened.nonce },
    };
  }
  async function connect(input) {
    const start = await begin(input),
      auth = await consent(start);
    await connectors.oauth.callback(auth.params, auth.cookies);
    const result = await connectors.oauth.result(start.id);
    connectors.save({
      discoveryId: result.discoveryId,
      permissions: { find_note: 'auto', save_note: 'ask', get_picture: 'off' },
    });
    return connectors.read().at(-1);
  }
  const expire = (r) =>
    connectors.oauth.replaceCredentials(r, { ...r.oauth, expiresAt: Date.now() - 1 });
  const payload = (r) => ({
    connectionId: r.id,
    revision: r.revision,
    toolName: 'find_note',
    arguments: { topic: 'Sunday' },
  });
  return {
    store,
    remote,
    begin,
    consent,
    connect,
    expire,
    payload,
    get connectors() {
      return connectors;
    },
    reopen() {
      connectors.close();
      connectors = new Connectors(store, { key });
    },
  };
}
test('browser OAuth binds state and browser, validates PKCE/resource, encrypts secrets and only connects after tool review', async (t) => {
  const f = await fixture(t),
    start = await f.begin();
  const auth = await f.consent(start);
  assert.throws(
    () => f.connectors.oauth.open(start.id, new URL(start.openUrl).searchParams.get('ticket')),
    /expired/,
  );
  await assert.rejects(f.connectors.oauth.callback(auth.params, {}), /browser/);
  await assert.rejects(
    f.connectors.oauth.callback({ ...auth.params, iss: 'https://wrong.example' }, auth.cookies),
    /invalid/,
  );
  assert.equal(f.remote.exchanges.length, 0);
  await f.connectors.oauth.callback(auth.params, auth.cookies);
  await assert.rejects(f.connectors.oauth.callback(auth.params, auth.cookies), /browser/);
  const [a, b] = await Promise.all([
    f.connectors.oauth.result(start.id),
    f.connectors.oauth.result(start.id),
  ]);
  assert.equal(a.discoveryId, b.discoveryId);
  assert.equal(a.connection.tools.length, 3);
  assert.equal(f.connectors.read().length, 0);
  assert.equal(f.remote.calls.length, 0);
  assert(a.connection.tools.every((t) => t.mode === 'ask'));
  const exchange = f.remote.exchanges[0];
  assert.equal(exchange.resource, f.remote.endpoint);
  assert(exchange.code_verifier.length >= 43);
  const result = f.connectors.save({
    discoveryId: a.discoveryId,
    permissions: { find_note: 'auto', save_note: 'ask' },
  });
  const record = f.connectors.read()[0];
  assert.equal(record.oauth.tokens.access_token, record.token);
  for (const secret of [record.token, record.oauth.tokens.refresh_token, exchange.code_verifier]) {
    assert(!JSON.stringify(result).includes(secret));
    assert(!JSON.stringify(f.store.read()).includes(secret));
    assert(!f.store.secret('app-connectors').includes(secret));
    assert(!f.store.secret('connector-oauth').includes(secret));
  }
  assert.equal(f.connectors.oauth.flow(start.id), undefined);
  f.reopen();
  assert.equal(f.connectors.publicState().connections[0].authentication, 'oauth');
  await f.connectors.call(f.payload(record), 'relay', 'read:1');
  assert.equal(f.remote.calls.length, 1);
});
test('expiry refresh is serialized, durable, preserves policy revisions and never repeats a completed tool call', async (t) => {
  const f = await fixture(t),
    record = await f.connect();
  f.expire(record);
  const a = await Promise.all([
    f.connectors.call(f.payload(record), 'relay', 'read:a'),
    f.connectors.call(f.payload(record), 'relay', 'read:b'),
  ]);
  assert.equal(a.length, 2);
  assert.equal(f.remote.exchanges.filter((e) => e.grant_type === 'refresh_token').length, 1);
  const fresh = f.connectors.record(record.id);
  assert.equal(fresh.revision, record.revision);
  assert.notEqual(fresh.token, record.token);
  assert.notEqual(fresh.oauth.tokens.refresh_token, record.oauth.tokens.refresh_token);
  f.expire(fresh);
  f.remote.setRefreshFailure(true);
  await f.connectors.call(f.payload(record), 'relay', 'read:a');
  assert.equal(f.remote.calls.length, 2);
  await assert.rejects(f.connectors.call(f.payload(record), 'relay', 'read:c'), /Sign in/);
  assert.equal(f.connectors.publicState().connections[0].signInNeeded, true);
  await assert.rejects(f.connectors.call(f.payload(record), 'relay', 'read:d'), /Sign in/);
  assert.equal(f.remote.exchanges.filter((e) => e.grant_type === 'refresh_token').length, 2);
  assert.equal(f.remote.calls.length, 2);
});
test('lost refresh response and process interruption require a fresh sign-in without retrying credentials or actions', async (t) => {
  const f = await fixture(t),
    record = await f.connect();
  f.expire(record);
  f.remote.setRefreshFailure('lost');
  await assert.rejects(f.connectors.call(f.payload(record), 'relay', 'lost'), /Sign in/);
  f.reopen();
  await assert.rejects(f.connectors.call(f.payload(record), 'relay', 'lost2'), /Sign in/);
  assert.equal(f.remote.calls.length, 0);
  assert.equal(f.remote.exchanges.length, 2);
  const flow = await f.begin();
  const saved = f.connectors.oauth.flow(flow.id);
  saved.phase = 'exchanging';
  f.connectors.oauth.writeFlow(saved);
  f.reopen();
  assert.equal((await f.connectors.oauth.result(flow.id)).phase, 'failed');
});
test('removal during refresh cannot restore the app or dispatch its tool', async (t) => {
  const f = await fixture(t),
    record = await f.connect();
  f.expire(record);
  let release;
  f.remote.setRefreshHold(new Promise((r) => (release = r)));
  const work = assert.rejects(
    f.connectors.call(f.payload(record), 'relay', 'deleted'),
    /Sign in|changed|aborted/i,
  );
  while (f.remote.exchanges.length < 2) await new Promise((r) => setTimeout(r, 5));
  f.connectors.remove(record.id);
  release();
  await work;
  assert.equal(f.connectors.read().length, 0);
  assert.equal(f.remote.calls.length, 0);
});
test('cancelled and denied authorization cannot install an app; changed policies invalidate pending sign-in', async (t) => {
  const f = await fixture(t),
    denied = await f.begin(),
    auth = await f.consent(denied, false);
  await f.connectors.oauth.callback(auth.params, auth.cookies);
  assert.equal((await f.connectors.oauth.result(denied.id)).phase, 'failed');
  const cancelled = await f.begin(),
    callback = await f.consent(cancelled);
  f.connectors.oauth.cancel(cancelled.id);
  await assert.rejects(f.connectors.oauth.callback(callback.params, callback.cookies), /browser/);
  const record = await f.connect(),
    changing = await f.begin({ id: record.id, revision: record.revision });
  f.connectors.update({ id: record.id, revision: record.revision, enabled: false });
  await assert.rejects(f.connectors.oauth.result(changing.id), /expired/);
  assert.equal(f.remote.calls.length, 0);
});
test('untrusted metadata cannot move credential requests to other loopback origins or change issuer/resource/PKCE', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { issuer: 'https://wrong.example' },
    { code_challenge_methods_supported: ['plain'] },
    { token_endpoint: 'http://127.0.0.1:1/token' },
  ]) {
    f.remote.setMetadata(patch);
    await assert.rejects(f.begin(), /could not start/);
  }
  f.remote.setMetadata({});
  f.remote.setResource({ resource: `${f.remote.root}/other` });
  await assert.rejects(f.begin(), /could not start/);
  await assert.rejects(
    oauthFetch('https://public.example/mcp')('https://127.0.0.1/token'),
    /private/,
  );
  await assert.rejects(
    oauthFetch('https://public.example/mcp')('https://192.168.1.1/token'),
    /Private/,
  );
  assert.equal(f.remote.clients.size, 0);
});
test('native browser opener accepts only a one-time sign-in URL from the main connected workspace', () => {
  const root = 'https://relay.example',
    url = `${root}/api/connectors/oauth/open?id=12345678-1234-1234-1234-123456789012&ticket=${'a'.repeat(43)}`;
  assert.equal(appSignInURL(url, `${root}/#apps`, root), url);
  for (const [target, frame] of [
    [url.replace('relay.example', 'evil.example'), root],
    [url, `${root}/api/files/preview`],
    [url + '&next=evil', root],
    [url.replace('/open?', '/callback?'), root],
    [url, 'https://elsewhere.example'],
  ])
    assert.throws(() => appSignInURL(target, frame, root));
});

test('provider revocation before dispatch asks for sign-in and does not run or retry a tool', async (t) => {
  const f = await fixture(t),
    record = await f.connect();
  f.remote.access.clear();
  await assert.rejects(f.connectors.call(f.payload(record), 'relay', 'revoked'), /Sign in/);
  assert.equal(f.connectors.publicState().connections[0].signInNeeded, true);
  await assert.rejects(f.connectors.call(f.payload(record), 'relay', 'revoked-again'), /Sign in/);
  assert.equal(f.remote.calls.length, 0);
  assert.equal(f.remote.exchanges.length, 1);
});

test('refresh before a reviewed write preserves the exact action and uncertain results are never replayed', async (t) => {
  const f = await fixture(t),
    record = await f.connect();
  f.expire(record);
  const payload = {
    ...f.payload(record),
    toolName: 'save_note',
    fingerprint: record.tools.find((t) => t.name === 'save_note').fingerprint,
    arguments: { title: 'Sunday', body: 'A quiet walk' },
  };
  await assert.rejects(f.connectors.call(payload, 'relay', 'unreviewed'), /review/);
  f.remote.setDisconnect(true);
  await assert.rejects(
    f.connectors.call(payload, 'relay', 'approved', { reviewed: true }),
    /no confirmed result/,
  );
  f.reopen();
  await assert.rejects(
    f.connectors.call(payload, 'relay', 'approved', { reviewed: true }),
    /no confirmed result/,
  );
  assert.equal(f.remote.notes.length, 1);
  assert.deepEqual(f.remote.notes[0], payload.arguments);
  assert.equal(f.remote.exchanges.filter((e) => e.grant_type === 'refresh_token').length, 1);
});

test('reconnecting a registered client reuses its encrypted setup only for the same endpoint and issuer', async (t) => {
  const f = await fixture(t),
    clientId = 'registered-notebook',
    clientSecret = 'fictional-registered-client-secret';
  f.remote.clients.set(clientId, {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: ['http://127.0.0.1:9999/api/connectors/oauth/callback'],
  });
  const record = await f.connect({ clientId, clientSecret });
  const start = await f.begin({ id: record.id, revision: record.revision });
  const auth = await f.consent(start);
  await f.connectors.oauth.callback(auth.params, auth.cookies);
  const found = await f.connectors.oauth.result(start.id);
  assert.equal(f.remote.clients.size, 1);
  assert.equal(f.remote.exchanges.length, 2);
  assert(
    f.remote.exchanges.every((e) => e.client_id === clientId && e.client_secret === clientSecret),
  );
  const result = f.connectors.save({
    discoveryId: found.discoveryId,
    permissions: { find_note: 'auto', save_note: 'ask' },
  });
  assert.equal(result.connections[0].revision, record.revision + 1);
  assert(!JSON.stringify(result).includes(clientSecret));
  assert(!f.store.secret('app-connectors').includes(clientSecret));
  // A changed issuer must never receive the old client secret.
  f.remote.setMetadata({ issuer: 'https://another.example' });
  await assert.rejects(
    f.begin({ id: record.id, revision: record.revision + 1 }),
    /could not start/,
  );
  assert.equal(f.remote.exchanges.length, 2);
});
