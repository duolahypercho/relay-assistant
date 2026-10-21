// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createWorkspace } from '../shared/seed.mjs';
import { command } from '../shared/domain.mjs';
import { attentionEvents, attentionCommand } from '../shared/attention.mjs';
import { conversationUnread, pinnedFirst } from '../shared/chat-list.mjs';

function fixture() {
  const s = createWorkspace({ sample: false });
  const first = command(s, 'thread.create', { title: 'First' });
  const second = command(s, 'thread.create', { title: 'Second' });
  const add = (threadId, id) => {
    const m = {
      id,
      threadId,
      role: 'assistant',
      text: `Result ${id}`,
      createdAt: new Date().toISOString(),
    };
    s.messages.push(m);
    return m;
  };
  return { s, first, second, add };
}
test('pins preserve the existing order within each section and reject unsupported values', () => {
  const { s, first, second } = fixture();
  command(s, 'thread.update', { id: first.id, pinned: true });
  assert.deepEqual(
    s.threads
      .toSorted(pinnedFirst)
      .slice(0, 2)
      .map((t) => t.id),
    [first.id, second.id],
  );
  command(s, 'thread.update', { id: second.id, pinned: true });
  assert.deepEqual(
    s.threads
      .toSorted(pinnedFirst)
      .slice(0, 2)
      .map((t) => t.id),
    [second.id, first.id],
  );
  command(s, 'thread.update', { id: first.id, archived: true });
  command(s, 'thread.update', { id: first.id, archived: false });
  assert.equal(first.pinned, true);
  for (const pinned of ['true', 1, null])
    assert.throws(() => command(s, 'thread.update', { id: first.id, pinned }), /valid pin/);
  assert.throws(
    () => command(s, 'thread.update', { id: 'main', pinned: true }),
    /side conversation/,
  );
});
test('a manual unread reminder creates no notification, message or work', () => {
  const { s, first } = fixture(),
    baseline = structuredClone(s);
  command(s, 'thread.read', { id: first.id, read: false });
  assert.equal(conversationUnread(s, first.id), true);
  assert.equal(attentionEvents(s).length, 0);
  for (const key of ['messages', 'runs', 'approvals', 'notifications'])
    assert.deepEqual(s[key], baseline[key]);
  assert.throws(() => command(s, 'thread.read', { id: first.id, read: 'false' }), /read or unread/);
  command(s, 'thread.update', { id: first.id, archived: true });
  assert.equal(conversationUnread(s, first.id), false);
  assert.throws(
    () => command(s, 'thread.read', { id: first.id, read: true }),
    /active conversation/,
  );
});
test('marking a parent read includes reply activity while preserving unrelated updates and decisions', () => {
  const { s, first, second, add } = fixture();
  const m = add(first.id, 'parent-result');
  const child = command(s, 'reply.open', { messageId: m.id });
  add(child.id, 'child-result');
  add(second.id, 'unrelated');
  command(s, 'thread.read', { id: child.id, read: false });
  s.approvals.push({ id: 'pending', status: 'pending', threadId: first.id });
  const decision = structuredClone(s.approvals);
  command(s, 'thread.read', { id: first.id, read: true });
  assert.equal(conversationUnread(s, first.id), false);
  assert.equal(conversationUnread(s, second.id), true);
  assert.equal(child.unreadMarker, undefined);
  assert.deepEqual(s.approvals, decision);
});
test('stale automatic reads never erase newer manual reminders or move read cursors backwards', () => {
  const { s, first, add } = fixture();
  add(first.id, 'old');
  add(first.id, 'new');
  command(s, 'thread.read', { id: first.id, read: false });
  const oldToken = first.unreadMarker;
  command(s, 'thread.read', { id: first.id, read: false });
  const currentToken = first.unreadMarker;
  assert.notEqual(currentToken, oldToken);
  attentionCommand(s, { threadId: first.id, throughMessageId: 'new', unreadMarker: oldToken });
  assert.equal(first.unreadMarker, currentToken);
  attentionCommand(s, { threadId: first.id, throughMessageId: 'old' });
  assert.equal(s.attentionReadThrough[first.id], 'new');
  attentionCommand(s, { threadId: first.id, throughMessageId: 'new', unreadMarker: currentToken });
  assert.equal(conversationUnread(s, first.id), false);
  add(first.id, 'later');
  assert.equal(conversationUnread(s, first.id), true);
});
test('empty marked conversations can be acknowledged without inventing a message', () => {
  const { s, first } = fixture();
  command(s, 'thread.read', { id: first.id, read: false });
  attentionCommand(s, { threadId: first.id, unreadMarker: first.unreadMarker });
  assert.equal(conversationUnread(s, first.id), false);
  assert.equal(s.messages.length, 0);
  assert.throws(() => attentionCommand(s, { threadId: first.id }), /Choose a message/);
  assert.throws(
    () =>
      attentionCommand(s, { threadId: first.id, throughMessageId: 'wrong', unreadMarker: 'any' }),
    /Choose a message/,
  );
});
test('chat organization persists through a real SQLite close and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-chat-list-')),
    path = join(dir, 'state.sqlite');
  let store = new Store(path, { sample: false });
  try {
    const thread = store.mutate((s) => command(s, 'thread.create', { title: 'Return later' }));
    store.mutate((s) => command(s, 'thread.update', { id: thread.id, pinned: true }));
    store.mutate((s) => command(s, 'thread.read', { id: thread.id, read: false }));
    store.close();
    store = new Store(path, { sample: false });
    const s = store.read();
    assert.equal(s.threads.find((t) => t.id === thread.id).pinned, true);
    assert.equal(conversationUnread(s, thread.id), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
