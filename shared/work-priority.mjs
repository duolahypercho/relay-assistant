// SPDX-License-Identifier: MIT
// Priority comes from owner message provenance, never from model/source text.
export function foregroundRuns(state) {
  const pending = state.runs.filter(
    (run) =>
      run.status === 'running' ||
      (run.status === 'queued' &&
        !state.threads.find((thread) => thread.id === run.threadId)?.queuePaused),
  );
  const foreground = new Set();
  for (const run of pending) if (ownerRequested(state, run)) foreground.add(run.id);
  // Preserve conversation order. A prerequisite must not wait for the owner
  // reply that it blocks (including a fixed reminder that cannot be steered).
  let added;
  do {
    added = false;
    for (let index = 0; index < pending.length; index++) {
      const run = pending[index];
      if (!foreground.has(run.id)) continue;
      for (let other = 0; other < pending.length; other++) {
        const before = pending[other];
        if (
          !foreground.has(before.id) &&
          ((before.threadId === run.threadId && (other < index || before.status === 'running')) ||
            (run.routineId && before.routineId === run.routineId && before.status === 'running'))
        ) {
          foreground.add(before.id);
          added = true;
        }
      }
    }
  } while (added);
  return foreground;
}

export function prioritizeRuns(state) {
  const foreground = foregroundRuns(state);
  return state.runs.toSorted((a, b) => Number(foreground.has(b.id)) - Number(foreground.has(a.id)));
}

function ownerRequested(state, run) {
  if (state.threads.find((thread) => thread.id === run.threadId)?.participantIds) return false;
  const message = state.messages.find((m) => m.id === run.messageId);
  if (run.steeringMessageIds?.length) return true;
  else if (
    run.delivery !== 'queue' &&
    message?.role === 'user' &&
    message.threadId === run.threadId &&
    ((message.questionId &&
      state.questions?.some((q) => q.id === message.questionId && q.answerRunId === run.id)) ||
      (!run.routineId &&
        !run.handoffId &&
        !run.questionContext &&
        !run.jobContext &&
        !run.connectorContext &&
        !run.websiteContext &&
        !run.handoffContext))
  )
    return true;
  return false;
}

// Keep a lightweight boundary even when a short owner reply finishes before
// background work reaches its next checkpoint. No other chat contents are shared.
export function ownerActivity(state, exceptRunId) {
  const ids = new Set();
  for (const run of state.runs) {
    if (run.id === exceptRunId || !ownerRequested(state, run)) continue;
    ids.add(run.messageId);
    for (const id of run.steeringMessageIds || []) ids.add(id);
  }
  return state.messages.findLast((message) => ids.has(message.id))?.id || '';
}
