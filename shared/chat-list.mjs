// SPDX-License-Identifier: MIT
import { attentionCommand, attentionEvents } from './attention.mjs';
import { uid } from './seed.mjs';

export const pinnedFirst = (a, b) => Number(!!b.pinned) - Number(!!a.pinned);
export function conversationThreadIds(s, id) {
  return new Set([id, ...s.threads.filter((t) => t.replyTo?.threadId === id).map((t) => t.id)]);
}
export function conversationUnread(s, id, events = attentionEvents(s)) {
  const ids = conversationThreadIds(s, id);
  return (
    s.threads.some((t) => ids.has(t.id) && !t.archived && !!t.unreadMarker) ||
    events.some((event) => !event.read && ids.has(event.target.threadId))
  );
}
export function markConversation(s, p) {
  const thread = s.threads.find((t) => t.id === p.id && !t.archived);
  if (!thread) throw Error('Choose an active conversation.');
  if (typeof p.read !== 'boolean') throw Error('Choose read or unread.');
  if (!p.read) {
    // A reminder flag, not a new notification or an instruction to the assistant.
    thread.unreadMarker = uid('unread');
  } else {
    const ids = conversationThreadIds(s, thread.id);
    const events = attentionEvents(s).filter((e) => ids.has(e.target.threadId));
    for (const id of ids) {
      const child = s.threads.find((t) => t.id === id);
      if (!child || child.archived) continue;
      const latest = s.messages.findLast((m) => m.threadId === id);
      if (latest) attentionCommand(s, { threadId: id, throughMessageId: latest.id });
      delete child.unreadMarker;
    }
    const read = new Set(s.attentionReadIds || []);
    for (const event of events) read.add(event.id);
    s.attentionReadIds = [...read].slice(-1000);
    for (const notice of s.notifications || []) if (read.has(notice.id)) notice.read = true;
  }
  return { id: thread.id, read: p.read };
}
