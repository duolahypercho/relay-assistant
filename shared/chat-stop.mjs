// SPDX-License-Identifier: MIT
import { uid, iso } from './seed.mjs';
import { assistantSnapshot, threadAssistantId } from './assistant-scope.mjs';
import { cancelHandoff } from './handoffs.mjs';

// Match only the owner's whole message. Never search attachments, quotes or model output.
export function isStopMessage(text) {
  const value = text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[.!。！]+$/u, '')
    .trim();
  return /^(?:stop(?: now)?(?: please)?|please stop(?: now)?|cancel (?:that|this)|停止|现在停止|現在停止|请停止|請停止|停下|停下来|停下來)$/u.test(
    value,
  );
}

export function stopReply(s, run) {
  if (!['queued', 'running'].includes(run.status)) return run;
  const active = run.status === 'running';
  run.status = 'cancelled';
  const thread = s.threads.find((t) => t.id === run.threadId);
  if (active && s.runs.some((r) => r.threadId === run.threadId && r.status === 'queued'))
    thread.queuePaused = true;
  if (run.partial)
    s.messages.push({
      id: uid('message'),
      threadId: run.threadId,
      role: 'assistant',
      text: run.partial,
      replyTo: run.activeMessageId || run.messageId,
      assistantId: run.assistant?.id || threadAssistantId(s, run.threadId),
      assistantName: run.assistant?.name,
      runId: run.id,
      handoffId: run.handoffId,
      interrupted: true,
      createdAt: iso(),
      cards: [],
    });
  return run;
}

// A durable stop boundary includes finished source runs with deferred continuations.
// Explicit queued owner messages stay available for manual resumption.
export function requestChatStop(s, thread, message) {
  const id = uid('message');
  const preserved = (r) =>
    r.status === 'queued' &&
    !r.routineId &&
    !r.handoffId &&
    !r.questionContext &&
    !r.jobContext &&
    !r.connectorContext &&
    !r.websiteContext &&
    !r.handoffContext;
  const runIds = new Set(
    s.runs.filter((r) => r.threadId === thread.id && !preserved(r)).map((r) => r.id),
  );
  const taskIds = new Set(s.tasks.filter((t) => t.threadId === thread.id).map((t) => t.id));
  for (const run of s.runs.filter((r) => runIds.has(r.id))) stopReply(s, run);
  for (const handoff of s.handoffs || []) {
    if (handoff.sourceThreadId !== thread.id) continue;
    const cancelled = cancelHandoff(s, handoff.id);
    for (const key of cancelled.runIds) {
      if (s.runs.some((r) => r.id === key)) runIds.add(key);
      if (s.tasks.some((t) => t.id === key)) taskIds.add(key);
    }
  }
  for (const run of s.runs.filter((r) => runIds.has(r.id))) {
    run.stopControlId = id;
    stopReply(s, run);
  }
  for (const question of s.questions || [])
    if (
      (question.threadId === thread.id || runIds.has(question.sourceRunId)) &&
      question.status === 'pending'
    ) {
      question.status = 'dismissed';
      question.dismissedAt = iso();
    }
  const runningReviews = [];
  for (const review of s.approvals) {
    if (
      review.threadId !== thread.id &&
      !runIds.has(review.sourceRunId) &&
      !runIds.has(review.connectorOrigin?.runId) &&
      !taskIds.has(review.taskId)
    )
      continue;
    if (['pending', 'approved'].includes(review.status)) review.status = 'rejected';
    else if (review.status === 'executing') runningReviews.push(review.id);
  }
  const stoppedTasks = [];
  for (const task of s.tasks.filter((t) => taskIds.has(t.id))) {
    if (!['queued', 'running', 'paused', 'needs_input', 'needs_approval'].includes(task.status))
      continue;
    // Preserve the receipt of a write the owner already approved and dispatched.
    if (s.approvals.some((a) => a.taskId === task.id && a.status === 'executing')) continue;
    task.status = 'cancelled';
    task.updatedAt = iso();
    task.leaseUntil = 0;
    task.leaseOwner = null;
    stoppedTasks.push(task.id);
  }
  for (const task of s.tasks)
    if (taskIds.has(task.id) && task.status === 'cancelled' && !stoppedTasks.includes(task.id))
      stoppedTasks.push(task.id);
  const queued = s.runs.filter((r) => r.threadId === thread.id && r.status === 'queued').length;
  if (queued) thread.queuePaused = true;
  const identity = assistantSnapshot(s, thread.id);
  const receipt = {
    id,
    threadId: thread.id,
    role: 'assistant',
    text: 'Stopping work in this chat…',
    assistantId: identity.id,
    assistantName: identity.name,
    replyTo: message.id,
    createdAt: iso(),
    cards: [],
    stopControl: {
      status: 'requested',
      runIds: [...runIds],
      taskIds: stoppedTasks,
      runningReviews,
      queued,
      requestedAt: iso(),
    },
  };
  s.messages.push(receipt);
  return { stopControlId: id, runIds: [...runIds], taskIds: stoppedTasks };
}

export function completeChatStop(s, id) {
  const message = s.messages.find((m) => m.id === id && m.stopControl);
  if (!message || message.stopControl.status === 'completed') return;
  const control = message.stopControl;
  control.status = 'completed';
  control.completedAt = iso();
  delete control.error;
  delete control.retryAt;
  message.text =
    'Stopped work in this chat.' +
    (control.queued ? ' Queued follow-ups are paused.' : '') +
    (control.runningReviews.length
      ? ' An approved action was already in progress; its outcome will be recorded separately.'
      : '');
}
