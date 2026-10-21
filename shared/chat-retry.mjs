// SPDX-License-Identifier: MIT
// A retry resumes the latest failed owner request, never a new or cancelled task.
export function replyRetryReason(state, run, now = Date.now()) {
  if (!run || run.status !== 'failed' || !run.retryable || !(run.retryUntil > now))
    return 'This reply has no saved recovery point. Continue with a new message.';
  if (run.routineId || run.voiceCallId || run.handoffId || run.groupRouting)
    return 'Continue this work from its original controls.';
  const thread = state.threads.find((t) => t.id === run.threadId);
  if (!thread || thread.archived) return 'Restore this chat before trying again.';
  const source = state.messages.find((m) => m.id === (run.activeMessageId || run.messageId));
  const latest = state.messages.findLast((m) => m.threadId === run.threadId && m.role === 'user');
  if (
    !source ||
    source.threadId !== run.threadId ||
    source.role !== 'user' ||
    latest?.id !== source.id
  )
    return 'This chat has a newer request. Continue with a new message instead.';
  if (
    state.runs.some(
      (r) =>
        r.threadId === run.threadId &&
        r.id !== run.id &&
        ['queued', 'running', 'waiting'].includes(r.status),
    )
  )
    return 'Wait for this chat’s current work to finish before trying again.';
  return '';
}
