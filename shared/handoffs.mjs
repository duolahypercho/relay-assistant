import { runAppContext } from './app-mentions.mjs';
// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { assistantProfile, assistantSnapshot, profileSnapshot } from './assistant-scope.mjs';
export const handoffActive = (h) => !['completed', 'failed', 'cancelled'].includes(h.status);
export function activeThreadHandoff(s, threadId) {
  return (s.handoffs || []).find((h) => !h.groupId && h.threadId === threadId && handoffActive(h));
}
export function handoffForRun(s, run) {
  const id = run?.handoffId || run?.questionContext?.origin.handoffId;
  return id ? (s.handoffs || []).find((h) => h.id === id) : activeThreadHandoff(s, run?.threadId);
}
export function belongsToHandoff(item, h) {
  return h.groupId ? item.handoffId === h.id : item.threadId === h.threadId;
}
const text = (v, label, max) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max)
    throw new Error(`${label} must contain 1–${max} characters.`);
  return v.trim();
};
export function startHandoff(s, runId, p, operationId) {
  const origin = s.runs.find((r) => r.id === runId);
  if (!origin || !['running', 'queued'].includes(origin.status))
    throw new Error('Ask a specialist from an active request.');
  const key = text(operationId, 'Request identity', 300);
  const existing = (s.handoffs || []).find((h) => h.operationId === key);
  if (existing) {
    if (
      existing.targetId !== p.assistantId ||
      existing.title !== p.title?.trim() ||
      existing.request !== p.request?.trim() ||
      (existing.requestedGroupId || '') !== (p.groupId || '') ||
      JSON.stringify(existing.fileIds) !== JSON.stringify(p.fileIds || [])
    )
      throw new Error('This handoff identity already has different instructions.');
    if (existing.sourceRunId !== runId) throw new Error('This handoff belongs to another request.');
    return existing;
  }
  const from = origin.assistant || assistantSnapshot(s, origin.threadId);
  const target = assistantProfile(s, p.assistantId);
  const parent = handoffForRun(s, origin);
  const path = parent?.path || [from.id];
  if (path.includes(target.id))
    throw new Error(
      'This would send the work back around a loop. Finish with the current specialist.',
    );
  if (path.length >= 4)
    throw new Error(
      'This request reached its specialist depth limit. Return the work to its owner.',
    );
  const rootId = parent?.rootId || origin.handoffRootId || origin.id;
  if ((s.handoffs || []).filter((h) => h.rootId === rootId).length >= 8)
    throw new Error('This request reached its eight-handoff limit. Summarize the saved work.');
  if ((s.handoffs || []).filter(handoffActive).length >= 20)
    throw new Error('Wait for an existing specialist request to finish.');
  const title = text(p.title, 'Specialist task', 120),
    request = text(p.request, 'Specialist instructions', 12000);
  const fileIds = p.fileIds || [];
  if (
    !Array.isArray(fileIds) ||
    fileIds.length > 8 ||
    fileIds.some((id) => !s.files.some((f) => f.id === id))
  )
    throw new Error('Choose up to eight saved workspace files.');
  const sourceThread = s.threads.find((t) => t.id === origin.threadId);
  const group = p.groupId
    ? s.threads.find((t) => t.id === p.groupId && t.participantIds)
    : !fileIds.length && sourceThread?.participantIds?.includes(target.id)
      ? sourceThread
      : null;
  if (p.groupId && !group) throw new Error('Choose an existing group chat.');
  if (
    group &&
    (group.archived ||
      !group.participantIds.includes(from.id) ||
      !group.participantIds.includes(target.id))
  )
    throw new Error('Both assistants must belong to the active destination group.');
  if (group && fileIds.length)
    throw new Error(
      'Group handoff messages are text-only. Send attachments in a direct specialist request.',
    );
  const id = uid('handoff'),
    threadId = group?.id || uid('thread'),
    messageId = uid('message');
  if (!group)
    s.threads.unshift({
      id: threadId,
      assistantId: target.id,
      title: `${target.name}: ${title}`.slice(0, 100),
      archived: false,
      draft: '',
      createdAt: iso(),
      handoffId: id,
    });
  s.messages.push({
    id: messageId,
    threadId,
    role: group ? 'assistant' : 'user',
    ...(group
      ? {
          assistantId: from.id,
          assistantName: from.name,
          replyTo: threadId === origin.threadId ? origin.messageId : undefined,
          handoffId: id,
        }
      : {}),
    text: request,
    fileIds: [...new Set(fileIds)],
    cards: group ? [{ kind: 'handoff', id }] : [],
    createdAt: iso(),
    delegation: {
      handoffId: id,
      fromId: from.id,
      fromName: from.name,
      targetId: target.id,
      targetName: target.name,
    },
  });
  const child = {
    id: uid('run'),
    threadId,
    messageId,
    assistant: profileSnapshot(s, target.id),
    handoffId: id,
    ...(group ? { groupMembers: group.participantIds.map((id) => profileSnapshot(s, id)) } : {}),
    status: 'queued',
    createdAt: iso(),
    partial: '',
    leaseUntil: 0,
    modelConnection: structuredClone(origin.modelConnection),
    appContext: structuredClone(runAppContext(origin)),
    connectionGeneration: origin.connectionGeneration,
    handoffRootId: rootId,
  };
  s.runs.push(child);
  const h = {
    id,
    operationId: key,
    groupId: group?.id || null,
    requestedGroupId: p.groupId || '',
    messageId,
    rootId,
    parentId: parent?.id || null,
    path: [...path, target.id],
    sourceRunId: origin.id,
    sourceThreadId: origin.threadId,
    sourceName: from.name,
    targetId: target.id,
    targetName: target.name,
    title,
    request,
    fileIds: [...fileIds],
    threadId,
    childRunId: child.id,
    status: 'queued',
    createdAt: iso(),
    modelConnection: structuredClone(origin.modelConnection),
    assistant: structuredClone(child.assistant),
    restrictedRoutine:
      !!origin.routineId ||
      !!origin.questionContext?.origin.restrictedRoutine ||
      !!parent?.restrictedRoutine,
  };
  s.handoffs ||= [];
  s.handoffs.push(h);
  // Commit the visible receipt with the queued work, before any provider response or crash.
  if (!group || origin.threadId !== threadId)
    s.messages.push({
      id: uid('message'),
      threadId: origin.threadId,
      role: 'assistant',
      assistantId: from.id,
      assistantName: from.name,
      text: '',
      cards: [{ kind: 'handoff', id }],
      replyTo: origin.messageId,
      createdAt: iso(),
    });
  return h;
}
export function cancelHandoff(s, id) {
  const h = (s.handoffs || []).find((x) => x.id === id);
  if (!h) throw new Error('This specialist request was not found.');
  const family = new Set([id]);
  for (let i = 0; i < 4; i++)
    for (const row of s.handoffs) if (family.has(row.parentId)) family.add(row.id);
  const requests = s.handoffs.filter((row) => family.has(row.id));
  const owns = (item) => requests.some((row) => belongsToHandoff(item, row));
  const runIds = [];
  for (const row of s.handoffs.filter((row) => family.has(row.id))) {
    if (handoffActive(row)) {
      row.status = 'cancelled';
      delete row.reason;
      row.completedAt = iso();
      row.error = 'Stopped by the owner.';
    }
    if (row.continuationId) {
      const r = s.runs.find((r) => r.id === row.continuationId);
      if (r && ['queued', 'running'].includes(r.status)) {
        r.status = 'cancelled';
        runIds.push(r.id);
      }
    }
    row.returnSuppressed = row.id !== id || !row.parentId;
  }
  if (!h.parentId) {
    const source = s.runs.find((r) => r.id === h.sourceRunId);
    if (source && ['queued', 'running'].includes(source.status)) {
      source.status = 'cancelled';
      runIds.push(source.id);
    }
  }
  for (const r of s.runs.filter(owns)) {
    runIds.push(r.id);
    if (['queued', 'running'].includes(r.status)) r.status = 'cancelled';
  }
  for (const q of s.questions || []) if (owns(q) && q.status === 'pending') q.status = 'dismissed';
  for (const t of s.tasks)
    if (
      owns(t) &&
      ['queued', 'running', 'paused', 'needs_input', 'needs_approval'].includes(t.status) &&
      !s.approvals.some((a) => a.taskId === t.id && a.status === 'executing')
    ) {
      t.status = 'cancelled';
      runIds.push(t.id);
    }
  for (const a of s.approvals)
    if (
      (owns(a) || s.tasks.some((t) => owns(t) && t.id === a.taskId)) &&
      ['pending', 'approved'].includes(a.status)
    )
      a.status = 'rejected';
  return { id, runIds: [...new Set(runIds)] };
}
