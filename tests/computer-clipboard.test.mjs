// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { createApp } from '../server/app.mjs';
import { DesktopInputQueue } from '../shared/desktop-input.mjs';
function fixture() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
  computer.requireRunning = async () => {};
  computer.runtime.pause = async () => {};
  return { store, computer };
}
test('clipboard is owner-only, transient and separate from replayable computer actions', async () => {
  const { store, computer } = fixture();
  const before = store.read();
  let requests = 0;
  computer.rpc = async (p) => {
    requests++;
    assert.deepEqual(p, { kind: 'clipboard', action: 'copy' });
    return { text: 'Private 你好 🌱\nline 2', other: 'ignored' };
  };
  try {
    assert.deepEqual(await computer.copyClipboard('copy'), { text: 'Private 你好 🌱\nline 2' });
    assert.equal(computer.receipts().length, 0);
    assert.deepEqual(store.read(), before);
    await assert.rejects(
      computer.perform(
        { kind: 'clipboard', action: 'copy', operationId: 'bad' },
        { actor: 'owner' },
      ),
      /Unsupported/,
    );
    await assert.rejects(computer.copyClipboard('read'), /Choose Copy or Cut/);
    store.db.prepare("UPDATE computer_meta SET controller='agent'").run();
    await assert.rejects(computer.copyClipboard('copy'), /Take control/);
    assert.equal(requests, 1);
  } finally {
    store.close();
  }
});
test('clipboard bytes are bounded and malformed results never escape', async () => {
  const { store, computer } = fixture();
  try {
    for (const value of [undefined, null, 42, '', 'abc\0def', '界'.repeat(21846)]) {
      computer.rpc = async () => ({ text: value });
      await assert.rejects(computer.copyClipboard('copy'), /plain text/);
    }
    computer.rpc = async () => ({ text: 'a'.repeat(65536) });
    assert.equal((await computer.copyClipboard('copy')).text.length, 65536);
    assert.equal(computer.receipts().length, 0);
  } finally {
    store.close();
  }
});
test('control changes and cancellation suppress in-flight clipboard data and queued transfers', async () => {
  const { store, computer } = fixture();
  let started, finish;
  const ready = new Promise((r) => (started = r));
  computer.rpc = async () => {
    started();
    return await new Promise((r) => (finish = r));
  };
  try {
    const controller = new AbortController();
    const request = computer.copyClipboard('copy', { signal: controller.signal });
    await ready;
    const cancelled = assert.rejects(request, /abort/i);
    controller.abort();
    finish({ text: 'never returned' });
    await cancelled;
    computer.rpc = async () => {
      computer.epoch++;
      return { text: 'stale' };
    };
    await assert.rejects(computer.copyClipboard('copy'), /control changed/);
    let unblock;
    computer.queue = new Promise((r) => (unblock = r));
    const queued = computer.copyClipboard('cut');
    const stale = assert.rejects(queued, /control changed/);
    computer.epoch++;
    unblock();
    await stale;
    assert.equal(computer.receipts().length, 0);
  } finally {
    store.close();
  }
});
test('copy follows pending input in order and receives only its own result', async () => {
  const requests = [];
  const queue = new DesktopInputQueue(async (p) => {
    requests.push(p);
    return p.kind === 'clipboard' ? { text: 'selected' } : { ok: true };
  });
  queue.push({ action: 'type', text: 'one' });
  queue.push({ action: 'key', key: 'ctrl+a' });
  const copied = queue.request({ kind: 'clipboard', action: 'copy' });
  queue.push({ action: 'type', text: 'two' });
  await queue.drain();
  assert.deepEqual(await copied, { text: 'selected' });
  assert.deepEqual(
    requests.map((p) => p.text || p.action),
    ['one', 'key', 'copy', 'two'],
  );
});
test('leaving the view rejects active and queued clipboard promises without replay', async () => {
  let finish,
    calls = 0;
  const queue = new DesktopInputQueue(async () => {
    calls++;
    return await new Promise((r) => (finish = r));
  });
  const active = queue.request({ kind: 'clipboard', action: 'copy' });
  const rejected = assert.rejects(active, { name: 'AbortError' });
  const draining = queue.drain();
  const pending = queue.request({ kind: 'clipboard', action: 'cut' });
  const alsoRejected = assert.rejects(pending, { name: 'AbortError' });
  queue.clear();
  finish({ text: 'too late' });
  await Promise.all([rejected, alsoRejected, draining]);
  assert.equal(calls, 1);
});
test('clipboard endpoint requires owner authentication and same-origin explicit POST', async () => {
  const { store, computer } = fixture();
  let requests = 0;
  computer.rpc = async () => {
    requests++;
    return { text: 'Only requested text' };
  };
  const services = {
    computer,
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const key = 'clipboard-owner-fixture-key-more-than-24';
  const server = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: key }).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (headers = {}) =>
    fetch(url + '/api/computer/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url, ...headers },
      body: JSON.stringify({ action: 'copy' }),
    });
  try {
    assert.equal((await post()).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ key }),
    });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await post({ Cookie, Origin: 'https://wrong.test' })).status, 403);
    const res = await post({ Cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { text: 'Only requested text' });
    assert.equal(requests, 1);
    assert.equal(computer.receipts().length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
