// SPDX-License-Identifier: MIT
import { replyRetryReason } from '../shared/chat-retry.mjs';
import { runAssistantId } from '../shared/assistant-scope.mjs';
import { AgentCheckpoint } from './agent-checkpoint.mjs';

export const replyRetryLifetime = 7 * 86400000;
export const replyRetryLimit = 8;

export function safeReplyCheckpoint(store, run) {
  if (!run || run.routineId || run.voiceCallId || run.handoffId || run.groupRouting) return null;
  const row = store.db.prepare('SELECT phase FROM agent_checkpoints WHERE run_id=?').get(run.id);
  if (!row || !['ready', 'final'].includes(row.phase)) return null;
  try {
    return new AgentCheckpoint(store, run.id).load();
  } catch {
    return null;
  }
}

export function pruneReplyCheckpoints(store, now = Date.now()) {
  const state = store.read();
  const rows = store.db.prepare('SELECT run_id,phase FROM agent_checkpoints').all();
  const safe = new Set(
    rows.filter((r) => ['ready', 'final'].includes(r.phase)).map((r) => r.run_id),
  );
  const failed = state.runs
    .filter((r) => r.status === 'failed' && r.retryable && r.retryUntil > now && safe.has(r.id))
    .sort((a, b) => b.retryUntil - a.retryUntil)
    .slice(0, replyRetryLimit);
  const retained = new Set(
    [...state.runs.filter((r) => ['running', 'queued'].includes(r.status)), ...failed].map(
      (r) => r.id,
    ),
  );
  const invalid = state.runs.filter((r) => r.retryable && !retained.has(r.id));
  if (invalid.length)
    store.mutate((s) => {
      for (const old of invalid) {
        const run = s.runs.find((r) => r.id === old.id);
        delete run.retryable;
        delete run.retryUntil;
      }
    });
  for (const row of rows)
    if (!retained.has(row.run_id))
      store.db.prepare('DELETE FROM agent_checkpoints WHERE run_id=?').run(row.run_id);
}

export function retryReply(store, services, input) {
  if (typeof input.id !== 'string' || typeof input.messageId !== 'string')
    throw Error('Choose the failed reply to try again.');
  pruneReplyCheckpoints(store);
  const current = store.read();
  const run = current.runs.find((r) => r.id === input.id);
  const reason = replyRetryReason(current, run);
  if (reason) throw Error(reason);
  const failure = current.messages.find(
    (m) => m.id === input.messageId && m.runId === run.id && m.error,
  );
  if (!failure || run.retryMessageId !== failure.id) throw Error('Choose the latest failed reply.');
  runAssistantId(current, run);
  if (!services.provider?.configured)
    throw Error('Connect an AI model, then try this reply again.');
  if (!safeReplyCheckpoint(store, run))
    throw Error(
      'This reply cannot safely resume. Inspect its saved work and continue with a new message.',
    );
  return store.mutate((s) => {
    const r = s.runs.find((r) => r.id === run.id);
    const changed = replyRetryReason(s, r);
    if (changed) throw Error(changed);
    r.status = 'queued';
    r.partial = '';
    r.leaseUntil = 0;
    r.leaseOwner = null;
    r.retryCount = (r.retryCount || 0) + 1;
    r.retryFromMessageId = failure.id;
    r.retryRequestedAt = new Date().toISOString();
    delete r.retryable;
    delete r.retryUntil;
    delete r.error;
    delete r.waitingForReply;
    // A fresh owner gesture uses the currently selected connection. Existing
    // provider-origin checks strip private state if that selection changed.
    delete r.modelConnection;
    return r;
  });
}
