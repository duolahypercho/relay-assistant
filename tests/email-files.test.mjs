// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readEmail, importEmailAttachment } from '../server/email-files.mjs';
import { isEmailFile } from '../shared/email-files.mjs';
import { emailBytes, enclosedBytes } from '../scripts/email-fixture.mjs';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { executeTool } from '../server/agent.mjs';
import { createApp } from '../server/app.mjs';
const file = (bytes = emailBytes()) => ({
  name: 'Weekend.eml',
  mime: 'message/rfc822',
  base64: Buffer.from(bytes).toString('base64'),
});
const add = (s) => s.mutate((state) => command(state, 'file.add', file()));
test('EML recognition respects explicit media types and handles native generic and text file types', () => {
  for (const mime of [
    '',
    'text/plain',
    'application/octet-stream',
    'MESSAGE/RFC822; charset=utf-8',
  ])
    assert(isEmailFile({ name: 'PLAN.EML', mime }));
  for (const mime of ['text/html', 'image/svg+xml', 'application/pdf'])
    assert(!isEmailFile({ name: 'plan.eml', mime }));
  assert(!isEmailFile({ name: 'file.msg', mime: 'application/octet-stream' }));
});
test('email decoding preserves international headers, addresses, body, attachment index and complete pagination', async () => {
  const f = file(emailBytes({ long: true }));
  let result = await readEmail(f);
  assert.equal(result.subject, 'Weekend — plan');
  assert.match(result.from, /Café Team <team@example.invalid>/);
  assert.match(result.replyTo, /reply@example.invalid/);
  assert.match(result.text, /你好 🌱/);
  assert.equal(result.attachments[0].name, 'Budget.csv');
  assert.equal(result.attachments[0].base64, undefined);
  assert.match(result.sourceNotice, /untrusted/);
  let text = result.text;
  while (result.nextOffset !== null) {
    result = await readEmail(f, { offset: result.nextOffset, contentHash: result.contentHash });
    text += result.text;
  }
  assert(text.endsWith('END OF EMAIL'));
  assert.equal(text.length, result.totalLength);
  await assert.rejects(readEmail(f, { offset: 12000 }), /offset/);
  await assert.rejects(readEmail(file(), { contentHash: result.contentHash }), /changed/);
});
test('HTML-only email converts to inert text and never returns active HTML or trackers', async () => {
  const r = await readEmail(file(emailBytes({ html: true })));
  assert.match(r.text, /noon & bring a book/);
  assert.match(r.text, /https:\/\/example.invalid\/notes/);
  assert.doesNotMatch(r.text, /window.emailRan|tracking.invalid|<script|<img/);
  assert.equal(r.html, undefined);
});
test('email attachment imports are guarded, idempotent, byte-preserving and keep the source immutable', async () => {
  const s = new Store(':memory:', { sample: false });
  try {
    const source = add(s),
      before = s.read(),
      r = await readEmail(source),
      p = { id: source.id, index: 0, contentHash: r.contentHash };
    const [a, b] = await Promise.all([importEmailAttachment(s, p), importEmailAttachment(s, p)]);
    assert.equal(a.id, b.id);
    assert.deepEqual(Buffer.from(a.base64, 'base64'), enclosedBytes);
    assert.equal(s.read().files.length, 2);
    assert.deepEqual(
      s.read().files.find((f) => f.id === source.id),
      source,
    );
    assert.deepEqual(s.read().messages, before.messages);
    assert.deepEqual(s.read().actions, before.actions);
    s.mutate((state) => command(state, 'file.edit', { id: a.id, text: 'Owner changed this' }));
    const fresh = await importEmailAttachment(s, p);
    assert.notEqual(fresh.id, a.id);
    assert.deepEqual(Buffer.from(fresh.base64, 'base64'), enclosedBytes);
    await assert.rejects(importEmailAttachment(s, { ...p, index: 8 }), /not found/);
    await assert.rejects(
      importEmailAttachment(s, { ...p, contentHash: 'a'.repeat(64) }),
      /changed/,
    );
    let count = 0;
    await assert.rejects(
      importEmailAttachment(s, p, {
        guard() {
          if (++count === 2) throw Error('authority lost');
        },
      }),
      /authority lost/,
    );
    await assert.rejects(
      importEmailAttachment(s, p, {
        guard() {
          if (++count === 4)
            s.mutate((state) => {
              state.files = state.files.filter((f) => f.id !== source.id);
            });
        },
      }),
      /changed/,
    );
  } finally {
    s.close();
  }
});
test('bounded workers reject malformed, excessive, deeply nested and cancelled email input', async () => {
  await assert.rejects(readEmail(file('not an email')), /does not look/);
  await assert.rejects(readEmail(file(Buffer.alloc(8 * 1024 * 1024 + 1))), /8 MB/);
  await assert.rejects(
    readEmail(file('Subject: ' + 'x'.repeat(130000) + '\r\n\r\nbody')),
    /header/i,
  );
  const parts = [
    'Subject: Parts',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    ...Array.from({ length: 205 }, () => 'Content-Type: text/plain\r\n\r\nbody\r\n--b'),
    '--',
  ].join('\r\n');
  await assert.rejects(readEmail(file(parts)), /part/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readEmail(file(), { signal: controller.signal }), { name: 'AbortError' });
  const c = new AbortController();
  const pending = readEmail(file(), { signal: c.signal });
  setTimeout(() => c.abort(), 5);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.match((await readEmail(file())).text, /noon/);
});
test('assistant tools read emails then extract attachments without creating approvals, messages or learned memory', async () => {
  const s = new Store(':memory:', { sample: false });
  try {
    const f = add(s),
      before = s.read();
    const r = await executeTool(s, 'read_file', { id: f.id });
    const a = await executeTool(s, 'import_email_attachment', {
      id: f.id,
      index: 0,
      contentHash: r.result.contentHash,
    });
    const text = await executeTool(s, 'read_file', { id: a.result.id });
    assert.match(text.result.text, /Tea,8/);
    assert.equal(a.card.id, a.result.id);
    for (const key of ['messages', 'actions', 'memories', 'tasks'])
      assert.deepEqual(s.read()[key], before[key]);
  } finally {
    s.close();
  }
});
test('email HTTP preview/import require owner access, reject cross-origin writes, and preserve saved state on read', async () => {
  const store = new Store(':memory:', { sample: false }),
    f = add(store),
    before = store.read();
  const services = {
    mode: 'live',
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(store, services, {
    host: '127.0.0.1',
    port: 0,
    accessKey: 'email-owner-key',
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const path = `/api/files/${f.id}/email`;
    assert.equal((await fetch(base + path)).status, 401);
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'email-owner-key' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const r = await (await fetch(base + path, { headers })).json();
    assert.equal(r.subject, 'Weekend — plan');
    assert.deepEqual(store.read(), before);
    const body = JSON.stringify({ index: 0, contentHash: r.contentHash });
    assert.equal(
      (
        await fetch(base + path + '/attachments', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.invalid' },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + path + '/attachments', { method: 'POST', headers, body })).status,
      200,
    );
    assert.equal(store.read().files.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('quoted-printable character sets, nested email attachments and HTML omission notices stay readable', async () => {
  const qp = file(
    'From: Team <team@example.invalid>\r\nSubject: Charset\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=E9 tomorrow.',
  );
  assert.equal((await readEmail(qp)).text.trim(), 'Café tomorrow.');
  const nested = file(
    'Subject: Forward\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nPlease read the attachment.\r\n--b\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="source.eml"\r\n\r\nSubject: Inner\r\n\r\nInside message.\r\n--b--\r\n',
  );
  const r = await readEmail(nested);
  assert.equal(r.attachments[0].name, 'source.eml');
  assert.doesNotMatch(r.text, /Inside message/);
  const html = file(
    'Subject: Deep HTML\r\nContent-Type: text/html\r\n\r\n' +
      '<div>'.repeat(60) +
      'DEEP CONTENT' +
      '</div>'.repeat(60),
  );
  assert.match((await readEmail(html)).text, /HTML preview limit reached/);
  let body = 'Content-Type: text/plain\r\n\r\nDeep';
  for (let i = 0; i < 25; i++)
    body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
  await assert.rejects(readEmail(file('Subject: Deep MIME\r\n' + body)), /nesting|depth/i);
});

test('empty plain alternatives fall back to a readable HTML body', async () => {
  const value = file(
    'Subject: Alternatives\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n  \r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Bring a book.</p>\r\n--b--\r\n',
  );
  assert.match((await readEmail(value)).text, /Bring a book/);
});
