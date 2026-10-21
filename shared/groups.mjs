// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { assistantProfile, profileSnapshot } from './assistant-scope.mjs';
import { conversationFamily } from './reply-threads.mjs';

export function groupMembers(s, ids) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length)
    throw new Error('Choose two to six different assistants.');
  return ids.map((id) => profileSnapshot(s, id));
}
export function groupCommand(s, action, p) {
  const members = groupMembers(s, p.participantIds);
  const title =
    p.title === undefined
      ? members
          .map((a) => a.name)
          .join(', ')
          .slice(0, 100)
      : p.title;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100)
    throw new Error('Give the group a name of up to 100 characters.');
  let thread;
  if (action === 'group.create') {
    thread = { id: uid('thread'), archived: false, draft: '', createdAt: iso() };
    s.threads.unshift(thread);
  } else if (action === 'group.update') {
    thread = s.threads.find((t) => t.id === p.id && t.participantIds);
    if (!thread) throw new Error('This group was not found.');
    if (thread.replyTo) throw new Error('Change participants in the original group.');
    const family = conversationFamily(s, thread.id);
    const active =
      s.runs.some((r) => family.has(r.threadId) && ['queued', 'running'].includes(r.status)) ||
      (s.questions || []).some((q) => family.has(q.threadId) && q.status === 'pending') ||
      (s.handoffs || []).some(
        (h) =>
          (family.has(h.sourceThreadId) || family.has(h.threadId)) &&
          (!['completed', 'failed', 'cancelled'].includes(h.status) ||
            (!h.continuationId && !h.returnSuppressed)),
      ) ||
      s.tasks.some(
        (t) => family.has(t.threadId) && !['completed', 'failed', 'cancelled'].includes(t.status),
      );
    if (active && JSON.stringify(p.participantIds) !== JSON.stringify(thread.participantIds))
      throw new Error(
        'Finish or stop this group’s current work and answer or dismiss its questions before changing participants.',
      );
  } else throw new Error('Unknown group action.');
  Object.assign(thread, { title: title.trim(), participantIds: members.map((a) => a.id) });
  for (const child of s.threads.filter((t) => t.replyTo?.threadId === thread.id)) {
    child.participantIds = [...thread.participantIds];
    if (child.draftRecipientIds)
      child.draftRecipientIds = child.draftRecipientIds.filter((id) =>
        child.participantIds.includes(id),
      );
  }
  if (thread.draftRecipientIds)
    thread.draftRecipientIds = thread.draftRecipientIds.filter((id) =>
      thread.participantIds.includes(id),
    );
  s.revision++;
  return thread;
}

// Mentions are persisted as validated IDs. Visible text alone never changes recipients.
export function groupRecipients(s, thread, p, quoted) {
  if (!thread.participantIds) {
    if (p.recipientIds?.length) throw new Error('Direct participants in a group chat.');
    return null;
  }
  const supplied = p.recipientIds;
  if (
    supplied !== undefined &&
    (!Array.isArray(supplied) || supplied.length > 6 || new Set(supplied).size !== supplied.length)
  )
    throw new Error('Choose different group participants.');
  const replyId = quoted?.role === 'assistant' ? quoted.assistantId : null;
  const ids = supplied?.length ? supplied : replyId ? [replyId] : [];
  if (replyId && supplied?.length && !supplied.includes(replyId))
    throw new Error('Include the assistant you are replying to, or clear the reply.');
  for (const id of ids) {
    if (!thread.participantIds.includes(id)) throw new Error('Choose an assistant in this group.');
    assistantProfile(s, id);
  }
  return ids;
}
export function groupRuns(s, thread, message, recipients, invocation) {
  const members = groupMembers(s, thread.participantIds);
  const base = {
    threadId: thread.id,
    messageId: message.id,
    groupTurnId: message.id,
    groupMembers: members,
    status: 'queued',
    createdAt: iso(),
    partial: '',
    leaseUntil: 0,
    ...invocation,
  };
  const runs = recipients.length
    ? recipients.map((id) => ({ ...base, id: uid('run'), assistant: profileSnapshot(s, id) }))
    : [{ ...base, id: uid('run'), groupRouting: true }];
  s.runs.push(...runs);
  return runs[0];
}
export function commitGroupRoute(s, id, recipients) {
  const run = s.runs.find((r) => r.id === id);
  if (!run?.groupRouting || run.status !== 'running')
    throw new Error('Group routing is no longer active.');
  const thread = s.threads.find((t) => t.id === run.threadId);
  if (
    !Array.isArray(recipients) ||
    !recipients.length ||
    recipients.length > 6 ||
    new Set(recipients).size !== recipients.length ||
    recipients.some(
      (id) => !run.groupMembers.some((a) => a.id === id) || !thread?.participantIds?.includes(id),
    )
  )
    throw new Error(
      'The model must choose one to six current group participants. Try mentioning an assistant.',
    );
  const children = recipients.map((id) => {
    const { leaseOwner: _lease, groupRouting: _routing, ...base } = run;
    return {
      ...base,
      id: uid('run'),
      assistant: run.groupMembers.find((a) => a.id === id),
      status: 'queued',
      leaseUntil: 0,
      partial: '',
    };
  });
  // Keep all responses to this message ahead of later queued messages.
  s.runs.splice(s.runs.indexOf(run) + 1, 0, ...children);
  run.status = 'completed';
  run.leaseUntil = 0;
  run.recipientIds = recipients;
  const message = s.messages.find((m) => m.id === run.messageId);
  if (message) message.routedTo = recipients;
  return children;
}
