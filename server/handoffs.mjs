// SPDX-License-Identifier: MIT
import { uid, iso } from '../shared/seed.mjs';
import { handoffForRun, belongsToHandoff, handoffActive } from '../shared/handoffs.mjs';
const running = (r) => ['queued', 'running'].includes(r.status);
function outcome(s, h, services) {
  const thread = s.threads.find((t) => t.id === h.threadId);
  if (!thread) return { status: 'failed', error: 'The specialist conversation is missing.' };
  const runs = s.runs.filter((r) => belongsToHandoff(r, h)),
    last = runs.at(-1);
  if (!last) return { status: 'failed', error: 'The specialist request is missing.' };
  if (runs.some(running)) return { status: thread.queuePaused ? 'paused' : 'working' };
  if (
    (s.handoffs || []).some(
      (x) =>
        x.parentId === h.id && (handoffActive(x) || (!x.continuationId && !x.returnSuppressed)),
    )
  )
    return { status: 'waiting', reason: 'Waiting for another specialist' };
  const questions = (s.questions || []).filter((q) => belongsToHandoff(q, h));
  if (questions.some((q) => q.status === 'pending'))
    return { status: 'needs_input', reason: 'A question is ready for you' };
  if (questions.some((q) => q.sourceRunId === last.id && q.status === 'dismissed'))
    return { status: 'failed', error: 'The specialist’s question was dismissed.' };
  const jobs = (services.computer?.jobs?.rows?.() || []).filter((j) =>
    runs.some((r) => r.id === j.runId),
  );
  if (jobs.some((j) => !j.continuation && j.status !== 'cancelled'))
    return { status: 'waiting', reason: 'Computer work is still running' };
  const waiting = s.messages
    .filter((m) => belongsToHandoff(m, h))
    .flatMap((m) => m.cards || [])
    .filter((c) => c.kind === 'computer-access');
  if (
    waiting.some((c) => {
      const w = services.computer?.network?.waitState?.(c.runId, c.host);
      return w?.requested && !w.resumed;
    })
  )
    return { status: 'needs_input', reason: 'Website access needs your review' };
  const appReviews = s.approvals.filter((a) => a.kind === 'connector' && a.handoffId === h.id);
  if (appReviews.some((a) => ['pending', 'approved', 'executing'].includes(a.status)))
    return { status: 'needs_input', reason: 'An app action needs your review or is running' };
  if (
    appReviews.some((a) => ['failed', 'outcome_unknown', 'rejected', 'expired'].includes(a.status))
  )
    return {
      status: 'failed',
      error:
        'A connected app action failed, was declined, or has an uncertain result. Review the action in this conversation.',
    };
  const tasks = s.tasks.filter((t) => belongsToHandoff(t, h));
  if (tasks.some((t) => !['completed', 'failed', 'cancelled'].includes(t.status)))
    return { status: 'waiting', reason: 'A delegated task is still open' };
  if (last.status !== 'completed')
    return {
      status: last.status === 'cancelled' ? 'cancelled' : 'failed',
      error: last.error || 'The specialist stopped before finishing.',
    };
  const messages = s.messages.filter(
    (m) =>
      belongsToHandoff(m, h) &&
      m.role === 'assistant' &&
      (!h.groupId || m.assistantId === h.targetId),
  );
  const reply = messages.findLast(
    (m) => m.replyTo === (last.activeMessageId || last.messageId) && m.text,
  );
  const files = [
    ...new Set([
      ...messages.flatMap((m) => (m.cards || []).filter((c) => c.kind === 'file').map((c) => c.id)),
      ...tasks.flatMap((t) => [t.resultFileId, t.filledFileId].filter(Boolean)),
    ]),
  ].filter((id) => s.files.some((f) => f.id === id));
  return {
    status: 'completed',
    result: {
      messageId: reply?.id || null,
      text: [
        reply?.text || '',
        ...tasks.map((t) => `${t.title} (${t.status}): ${t.error || t.result || ''}`),
      ]
        .join('\n\n')
        .slice(0, 24000),
      fileIds: files.slice(0, 20),
      reviewIds: messages
        .flatMap((m) => (m.cards || []).filter((c) => c.kind === 'review').map((c) => c.id))
        .slice(0, 20),
    },
  };
}
function updates(s, services) {
  return (s.handoffs || [])
    .filter(handoffActive)
    .map((h) => ({ id: h.id, ...outcome(s, h, services) }))
    .filter((u) => {
      const h = s.handoffs.find((h) => h.id === u.id);
      return h.status !== u.status || h.reason !== u.reason || !handoffActive(u);
    });
}
export function reconcileHandoffs(store, services) {
  const s = store.read();
  const changes = updates(s, services);
  const pending = (s.handoffs || []).some(
    (h) =>
      !handoffActive(h) &&
      !h.continuationId &&
      !h.returnSuppressed &&
      !['queued', 'running'].includes(s.runs.find((r) => r.id === h.sourceRunId)?.status),
  );
  if (!changes.length && !pending) return;
  store.mutate((state) => {
    for (const u of updates(state, services)) {
      const h = state.handoffs.find((x) => x.id === u.id);
      Object.assign(h, u);
      if (!u.reason) delete h.reason;
      if (!handoffActive(h)) h.completedAt = iso();
    }
    for (const h of state.handoffs || []) {
      if (handoffActive(h) || h.continuationId || h.returnSuppressed) continue;
      const source = state.runs.find((r) => r.id === h.sourceRunId),
        thread = state.threads.find((t) => t.id === h.sourceThreadId);
      if (source && running(source)) continue;
      if (
        !source ||
        source.status !== 'completed' ||
        source.stopControlId ||
        !thread ||
        thread.archived
      ) {
        h.returnSuppressed = true;
        continue;
      }
      const { id, status, partial, leaseUntil, leaseOwner, error, createdAt, ...context } = source;
      const continuation = {
        ...structuredClone(context),
        id: uid('run'),
        status: 'queued',
        createdAt: iso(),
        partial: '',
        leaseUntil: 0,
        handoffRootId: h.rootId,
        handoffContext: {
          id: h.id,
          from: h.targetName,
          title: h.title,
          status: h.status,
          result: h.result || null,
          error: h.error || null,
          threadId: h.threadId,
        },
      };
      // A routine was already recorded when it asked for help. Continue its frozen context once.
      if (source.routineId) {
        delete continuation.routineId;
        continuation.questionContext ||= {
          origin: {
            request: source.instructions,
            fileIds: [],
            skill: source.skill || null,
            skillInput: source.skillInput || '',
            restrictedRoutine: true,
            mailSource: source.mailSource || null,
            assistant: source.assistant,
            connectionGeneration: source.connectionGeneration ?? null,
          },
          answers: [],
        };
      }
      state.runs.push(continuation);
      h.continuationId = continuation.id;
    }
  });
}
export function bindHandoffRun(s, run) {
  const h = handoffForRun(s, run);
  if (!h) return;
  if (!handoffActive(h)) return false;
  run.handoffId ||= h.id;
  run.modelConnection ||= structuredClone(h.modelConnection);
  run.assistant ||= structuredClone(h.assistant);
  run.handoffRootId = h.rootId;
  run.handoffRestricted = !!h.restrictedRoutine;
}
