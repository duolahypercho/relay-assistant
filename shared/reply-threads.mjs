// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';

// A reply thread uses the ordinary durable conversation/worker machinery, but
// belongs to one original message and is never a top-level sidebar conversation.
export function conversationFamily(s, id) {
  return new Set([id, ...s.threads.filter((t) => t.replyTo?.threadId === id).map((t) => t.id)]);
}
export function openReplyThread(s, messageId) {
  const message = s.messages.find((m) => m.id === messageId && m.id !== 'welcome');
  const parent = message && s.threads.find((t) => t.id === message.threadId);
  if (!message || !parent) throw new Error('This original message was not found.');
  if (parent.archived) throw new Error('Restore the conversation before replying.');
  if (parent.replyTo) return parent;
  const existing = s.threads.find((t) => t.replyTo?.message.id === messageId);
  if (existing) return existing;
  const root = {
    id: message.id,
    role: message.role,
    assistantId: message.assistantId,
    assistantName: message.assistantName,
    text: message.text.slice(0, 24000),
    createdAt: message.createdAt,
    fileIds: [...(message.fileIds || [])],
    ...(message.sharedTexts?.length ? { sharedTexts: [...message.sharedTexts] } : {}),
    cards: (message.cards || [])
      .slice(0, 20)
      .map(({ kind, id, title, page }) => ({ kind, id, title, page })),
  };
  const thread = {
    id: uid('thread'),
    title: (message.text.replace(/[#*`\n]/g, ' ').trim() || 'A result').slice(0, 80),
    assistantId: parent.assistantId || 'relay',
    ...(parent.participantIds ? { participantIds: [...parent.participantIds] } : {}),
    replyTo: { threadId: parent.id, message: root },
    archived: false,
    draft: '',
    createdAt: iso(),
  };
  s.threads.push(thread);
  s.revision++;
  return thread;
}
export function defaultReplyRecipient(thread) {
  const root = thread.replyTo?.message;
  return root?.role === 'assistant' && thread.participantIds?.includes(root.assistantId)
    ? root
    : null;
}
export function replyContext(s, threadId) {
  const root = s.threads.find((t) => t.id === threadId)?.replyTo?.message;
  if (!root) return null;
  return {
    ...root,
    results: root.cards.map((c) => {
      if (c.kind === 'review') {
        const review = s.approvals.find((a) => a.id === c.id);
        return {
          ...c,
          ...(review
            ? {
                title: review.title,
                status: review.status,
                kind: review.kind,
                payload: review.payload,
              }
            : {}),
        };
      }
      if (c.kind === 'file') return { ...c, name: s.files.find((f) => f.id === c.id)?.name };
      return c;
    }),
  };
}
