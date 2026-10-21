// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http2';
import { generateKeyPairSync, verify, randomBytes } from 'node:crypto';
import express from 'express';
import { Store } from '../server/store.mjs';
import { Notifications } from '../server/notifications.mjs';
import { PushProviders } from '../server/push-providers.mjs';
import { command, createApproval } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
import {
  attentionEvents,
  attentionAllowed,
  attentionTarget,
  attentionCommand,
} from '../shared/attention.mjs';
import { createApp } from '../server/app.mjs';
const uuid = 'a1234567-1234-1234-1234-123456789012',
  deviceKey = 'a'.repeat(64);
function fixture(t, { platform = 'ios', providers } = {}) {
  const store = new Store(':memory:', { sample: false });
  let now = Date.now();
  const sent = [];
  const n = new Notifications(store, {
    key: randomBytes(32),
    clock: () => now,
    providers: providers || {
      status: () => ({ ios: true, android: true, desktop: true }),
      send: async (d, e, p) => {
        sent.push({ d, e, p });
        return { accepted: true };
      },
    },
  });
  n.enroll({
    workspaceId: n.workspaceId,
    id: uuid,
    key: deviceKey,
    name: 'My test device',
    platform,
    token: platform === 'ios' ? 'b'.repeat(64) : 'fictional-fcm-token',
    preview: false,
  });
  const credentials = { id: uuid, key: deviceKey };
  n.presence({ ...credentials, focused: false });
  t.after(async () => {
    await n.close();
    store.close();
  });
  const message = (text = 'The plan is ready.', extra = {}) => {
    now++;
    return store.mutate((s) =>
      appendAssistant(
        s,
        'main',
        { text, cards: [] },
        { createdAt: new Date(now).toISOString(), ...extra },
      ),
    );
  };
  return {
    store,
    n,
    sent,
    credentials,
    message,
    advance(ms) {
      now += ms;
    },
    rows: () => store.db.prepare('SELECT * FROM attention_outbox ORDER BY rowid').all(),
  };
}
test('attention events route replies, questions and reviews precisely without duplicate review alerts', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const a = store.mutate((s) =>
      createApproval(s, { kind: 'connector', title: 'Save note', payload: {} }),
    );
    const m = store.mutate((s) =>
      appendAssistant(s, 'main', { text: 'Please review.', cards: [{ kind: 'review', id: a.id }] }),
    );
    const events = attentionEvents(store.read());
    assert.equal(events.length, 1);
    assert.equal(events[0].category, 'review');
    assert.deepEqual(attentionTarget(store.read(), events[0].id), {
      id: events[0].id,
      threadId: 'main',
      messageId: m.id,
    });
    store.mutate((s) => attentionCommand(s, { threadId: 'main', throughMessageId: m.id }));
    assert.equal(attentionEvents(store.read())[0].read, true);
    assert.throws(() => attentionTarget(store.read(), 'https://other.example/'), /no longer/);
    const profile = store.mutate((s) =>
      command(s, 'assistant.create', {
        name: 'Mochi',
        tone: 'Gentle',
        description: 'Plans',
        avatarColor: '#a0c5ac',
        notificationMode: 'attention',
      }),
    );
    assert.equal(
      attentionAllowed(store.read(), { assistantId: profile.id, category: 'result' }),
      false,
    );
    assert.equal(
      attentionAllowed(store.read(), { assistantId: profile.id, category: 'question' }),
      true,
    );
    assert.throws(
      () => store.mutate((s) => command(s, 'profile.update', { notificationMode: 'nope' })),
      /Choose/,
    );
  } finally {
    store.close();
  }
});
test('push is private by default, persists one receipt, and never emits again after acceptance', async (t) => {
  const f = fixture(t);
  const m = f.message('Private client details');
  await f.n.tick();
  await f.n.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].d.preview, false);
  assert.equal(f.rows()[0].status, 'accepted');
  assert(!JSON.stringify(f.n.status()).includes('b'.repeat(64)));
  assert(!JSON.stringify(f.store.read()).includes(deviceKey));
  assert(!f.store.secret('notification-devices').includes(deviceKey));
  assert.equal(
    f.n.open({ workspaceId: f.n.workspaceId, noticeId: `message:${m.id}` }).messageId,
    m.id,
  );
  assert.equal(attentionEvents(f.store.read())[0].read, true);
  assert.throws(
    () => f.n.open({ workspaceId: 'other', noticeId: `message:${m.id}` }),
    /another Relay/,
  );
  assert.throws(() => f.n.device({ id: uuid, key: '界'.repeat(64) }), /Enable/);
});
test('manual chat reminders do not re-send a delivered alert or mute later results', async (t) => {
  const f = fixture(t);
  f.message('First result');
  await f.n.tick();
  assert.equal(f.sent.length, 1);
  f.store.mutate((s) => command(s, 'thread.read', { id: 'main', read: true }));
  f.store.mutate((s) => command(s, 'thread.read', { id: 'main', read: false }));
  assert.equal(attentionEvents(f.store.read())[0].read, true);
  await f.n.tick();
  assert.equal(f.sent.length, 1);
  f.message('Later result');
  await f.n.tick();
  assert.equal(f.sent.length, 2);
});
test('focused devices, read updates, muted assistants and pre-enrollment history stay quiet', async (t) => {
  const f = fixture(t);
  f.n.presence({ ...f.credentials, focused: true });
  f.message('Focused');
  await f.n.tick();
  f.n.presence({ ...f.credentials, focused: false });
  await f.n.tick();
  assert.equal(f.sent.length, 0);
  const m = f.message('Already read');
  f.store.mutate((s) => attentionCommand(s, { threadId: 'main', throughMessageId: m.id }));
  await f.n.tick();
  assert.equal(f.sent.length, 0);
  f.store.mutate((s) => command(s, 'profile.update', { notificationMode: 'off' }));
  f.message('Muted');
  await f.n.tick();
  assert.equal(f.sent.length, 0);
  f.store.mutate((s) => command(s, 'profile.update', { notificationMode: 'all' }));
  await f.n.tick();
  assert.equal(f.sent.length, 0);
  f.message('New result');
  await f.n.tick();
  assert.equal(f.sent.length, 1);
});
test('unknown push outcomes and interrupted claims do not replay; only explicit retryable rejections retry', async (t) => {
  let calls = 0,
    mode = 'unknown';
  const f = fixture(t, {
    providers: {
      status: () => ({ ios: true }),
      async send() {
        calls++;
        if (mode === 'unknown') throw Object.assign(Error('lost'), { uncertain: true });
        if (mode === 'retry')
          throw Object.assign(Error('busy'), { retryable: true, pushFailure: true });
        return { accepted: true };
      },
    },
  });
  f.message('First');
  await f.n.tick();
  await f.n.tick();
  assert.equal(calls, 1);
  assert.equal(f.rows()[0].status, 'unknown');
  mode = 'retry';
  f.message('Second');
  await f.n.tick();
  assert.equal(calls, 2);
  assert.equal(f.rows()[1].status, 'pending');
  await f.n.tick();
  assert.equal(calls, 2);
  f.advance(15001);
  mode = 'ok';
  await f.n.tick();
  assert.equal(calls, 3);
  assert.equal(f.rows()[1].status, 'accepted');
  const next = f.message('Third');
  f.n.queue();
  const row = f.rows().find((r) => r.event_id === `message:${next.id}`);
  f.n.claim(row);
  f.n.recover();
  await f.n.tick();
  assert.equal(calls, 3);
  assert.equal(f.rows().at(-1).status, 'unknown');
});
test('revoking a device while push is in flight aborts and never resends it', async (t) => {
  let started, release;
  const ready = new Promise((r) => {
    started = r;
  });
  let calls = 0;
  const f = fixture(t, {
    providers: {
      status: () => ({ ios: true }),
      async send(_d, _e, { signal }) {
        calls++;
        started();
        await new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(Error('stop'), { uncertain: true })),
            { once: true },
          );
        });
      },
    },
  });
  f.message();
  const pending = f.n.tick();
  await ready;
  f.n.update({ ...f.credentials, enabled: false });
  await pending;
  release();
  await f.n.tick();
  assert.equal(calls, 1);
  assert.equal(f.rows()[0].status, 'unknown');
  assert.equal(f.n.status().devices[0].enabled, false);
});
test('desktop poll claims only background updates, preserves preview choice and accepts one acknowledgement', async (t) => {
  const f = fixture(t, { platform: 'desktop' });
  f.message();
  assert.equal(f.n.desktopPoll({ ...f.credentials, focused: false }).events.length, 1);
  assert.equal(f.n.desktopPoll({ ...f.credentials, focused: false }).events.length, 0);
  const row = f.rows()[0];
  f.n.desktopAck({ ...f.credentials, receiptId: row.id, status: 'shown' });
  assert.equal(f.rows()[0].status, 'shown');
  f.n.update({ ...f.credentials, preview: true });
  f.message('Visible content');
  const e = f.n.desktopPoll({ ...f.credentials, focused: false }).events[0];
  assert.equal(e.body, 'Visible content');
  f.message('Foreground');
  assert.equal(f.n.desktopPoll({ ...f.credentials, focused: true }).events.length, 0);
});
test('Apple HTTP/2 uses verifiable ES256 tokens, exact topic, private payload and revokes invalid devices', async (t) => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const server = createServer();
  const requests = [];
  let invalid = false;
  server.on('stream', (stream, headers) => {
    let data = '';
    stream.on('data', (c) => (data += c));
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(data) });
      stream.respond({ ':status': invalid ? 410 : 200 });
      stream.end(invalid ? JSON.stringify({ reason: 'Unregistered' }) : '');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const providers = new PushProviders({
    apns: {
      key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      keyId: 'ABCDEFGHIJ',
      teamId: '1234567890',
      topic: 'org.relay.assistant',
      environment: 'development',
    },
    testEndpoints: { apns: `http://127.0.0.1:${server.address().port}` },
  });
  const f = fixture(t, { providers });
  f.message('Sensitive test content');
  await f.n.tick();
  assert.equal(requests.length, 1);
  const r = requests[0];
  const token = r.headers.authorization.slice(7).split('.');
  assert(
    verify(
      'sha256',
      Buffer.from(token.slice(0, 2).join('.')),
      { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(token[2], 'base64url'),
    ),
  );
  assert.equal(r.headers['apns-topic'], 'org.relay.assistant');
  assert.equal(r.headers['apns-push-type'], 'alert');
  assert.equal(r.headers[':path'], `/3/device/${'b'.repeat(64)}`);
  assert(!JSON.stringify(r.body).includes('Sensitive'));
  assert.equal(r.body.relayWorkspace, f.n.workspaceId);
  assert.match(r.body.relayNotice, /^message:/);
  invalid = true;
  f.message();
  await f.n.tick();
  assert.equal(f.n.status().devices[0].enabled, false);
});
test('Firebase HTTP v1 authenticates with a verified RSA assertion, caches access and keeps content private', async (t) => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = express(),
    assertions = [],
    messages = [];
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.post('/token', (req, res) => {
    assertions.push(req.body.assertion);
    res.json({ access_token: 'fictional-oauth-token', expires_in: 3600 });
  });
  app.post('/send', (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fictional-oauth-token');
    messages.push(req.body.message);
    res.json({ name: 'projects/fictional/messages/one' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const providers = new PushProviders({
    fcm: {
      key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      email: 'relay@fictional.iam.gserviceaccount.com',
      projectId: 'fictional',
    },
    testEndpoints: { oauth: base + '/token', fcm: base + '/send' },
  });
  const f = fixture(t, { platform: 'android', providers });
  f.message('Sensitive Android details');
  await f.n.tick();
  f.message('Second secret');
  await f.n.tick();
  assert.equal(messages.length, 2);
  assert.equal(assertions.length, 1);
  const parts = assertions[0].split('.');
  assert(
    verify(
      'RSA-SHA256',
      Buffer.from(parts.slice(0, 2).join('.')),
      keys.publicKey,
      Buffer.from(parts[2], 'base64url'),
    ),
  );
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(messages[0].android.notification.channel_id, 'relay_updates');
  assert.equal(messages[0].data.relayWorkspace, f.n.workspaceId);
  assert(!JSON.stringify(messages).includes('Sensitive'));
  assert(!JSON.stringify(messages).includes('Second secret'));
});
test('attention API requires owner authentication, validates origin, and omits device secrets from status/export', async (t) => {
  const f = fixture(t);
  const accessKey = 'fictional-owner-key-for-attention-tests';
  const app = createApp(
    f.store,
    {
      notifications: f.n,
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
      mode: 'sample',
    },
    { host: '127.0.0.1', port: 0, accessKey },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/attention')).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: accessKey }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (
      await fetch(base + '/api/attention/forget', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://elsewhere.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: uuid }),
      })
    ).status,
    403,
  );
  for (const path of ['/api/attention', '/api/export']) {
    const r = await fetch(base + path, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const value = await r.text();
    assert(!value.includes(deviceKey));
    assert(!value.includes('b'.repeat(64)));
  }
});

test('a stale failed send cannot revoke a device whose token was refreshed in flight', async (t) => {
  let started, finish;
  const ready = new Promise((r) => (started = r));
  const f = fixture(t, {
    providers: {
      status: () => ({ ios: true }),
      async send() {
        started();
        await new Promise((r) => (finish = r));
        throw Object.assign(Error('gone'), { invalidDevice: true, pushFailure: true });
      },
    },
  });
  f.message();
  const pending = f.n.tick();
  await ready;
  f.n.enroll({
    ...f.credentials,
    workspaceId: f.n.workspaceId,
    name: 'Fresh device',
    platform: 'ios',
    preview: false,
    token: 'c'.repeat(64),
  });
  finish();
  await pending;
  assert.equal(f.n.status().devices[0].enabled, true);
  assert.equal(f.n.read()[0].token, 'c'.repeat(64));
  assert.equal(f.n.status().devices[0].lastError, '');
});

test('a backlog of desktop events does not block native push dispatch', async (t) => {
  const f = fixture(t);
  f.n.enroll({
    workspaceId: f.n.workspaceId,
    id: 'desktop-12345678901234567890',
    key: deviceKey,
    name: 'Desktop',
    platform: 'desktop',
    preview: false,
  });
  f.n.presence({ id: 'desktop-12345678901234567890', key: deviceKey, focused: false });
  for (let i = 0; i < 12; i++) f.message(`Update ${i}`);
  await f.n.tick();
  assert.equal(f.sent.length, 10);
  await f.n.tick();
  assert.equal(f.sent.length, 12);
});
