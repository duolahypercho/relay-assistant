// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopNotifications } from '../native/desktop/notifications.mjs';
const identity = {
  id: '12345678-1234-1234-1234-123456789012',
  key: 'a'.repeat(64),
  workspaceId: '22345678-1234-1234-1234-123456789012',
};
const event = {
  workspaceId: identity.workspaceId,
  noticeId: 'message:reply-1',
  receiptId: 'receipt-1',
  title: 'Relay',
  body: 'You have an update. Open Relay to see it.',
};
async function fixture(t, { fetcher, focused = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-desktop-notices-')),
    shown = [],
    opened = [],
    acks = [];
  const client = new DesktopNotifications({
    url: 'http://127.0.0.1:18000',
    path: join(directory, 'notifications.json'),
    fetcher:
      fetcher ||
      (async (url, options) => {
        const p = JSON.parse(options.body);
        if (url.endsWith('desktopAck')) acks.push(p);
        return Response.json(url.endsWith('desktopPoll') ? { events: [event] } : { ok: true });
      }),
    isFocused: () => focused,
    show: async (p) => {
      shown.push(p);
      return true;
    },
    open: (p) => opened.push(p),
  });
  client.identity = identity;
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { client, shown, opened, acks, setFocus: (value) => (focused = value) };
}
test('desktop alerts work without a window, acknowledge display and route clicks using IDs only', async (t) => {
  const f = await fixture(t);
  await f.client.poll();
  assert.equal(f.shown.length, 1);
  assert.equal(f.acks[0].status, 'shown');
  f.shown[0].onClick();
  assert.deepEqual(f.opened, [{ workspaceId: identity.workspaceId, noticeId: event.noticeId }]);
  f.client.identity = { ...identity, workspaceId: 'other' };
  f.shown[0].onClick();
  assert.equal(f.opened.length, 1);
});
test('desktop checks focus again after receiving a queued alert', async (t) => {
  let release;
  const pending = new Promise((r) => (release = r));
  const f = await fixture(t, {
    fetcher: async (url) => (url.endsWith('desktopPoll') ? pending : Response.json({ ok: true })),
  });
  const poll = f.client.poll();
  f.setFocus(true);
  release(Response.json({ events: [event] }));
  await poll;
  assert.equal(f.shown.length, 0);
});
test('revoking settings while a desktop poll is pending suppresses display and saves the final choice', async (t) => {
  let release;
  const pending = new Promise((r) => (release = r));
  const f = await fixture(t, {
    fetcher: async (url) => (url.endsWith('desktopPoll') ? pending : Response.json({ ok: true })),
  });
  const poll = f.client.poll();
  await Promise.all([f.client.configure(identity), f.client.configure(null)]);
  release(Response.json({ events: [event] }));
  await poll;
  assert.equal(f.shown.length, 0);
  assert.equal(f.client.identity, null);
  const saved = JSON.parse(await readFile(f.client.path, 'utf8'));
  assert.equal(saved.identity, null);
  assert.equal((await stat(f.client.path)).mode & 0o777, 0o600);
});
test('desktop ignores stored enrollment from another server and rejects malformed payloads', async (t) => {
  const f = await fixture(t);
  f.client.stopped = true;
  await f.client.configure(identity);
  const other = new DesktopNotifications({ url: 'https://other.example', path: f.client.path });
  await other.start();
  assert.equal(other.identity, undefined);
  await other.close();
  f.client.stopped = false;
  f.client.fetcher = async () => Response.json({ events: [{ ...event, workspaceId: 'foreign' }] });
  await f.client.poll();
  assert.equal(f.shown.length, 0);
  assert(f.client.status().error);
  f.client.fetcher = async () => Response.json({ events: [{ ...event, title: 'x'.repeat(161) }] });
  await f.client.poll();
  assert.equal(f.shown.length, 0);
});
