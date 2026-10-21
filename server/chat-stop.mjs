// SPDX-License-Identifier: MIT
import { completeChatStop } from '../shared/chat-stop.mjs';

// Retried from the persisted receipt after restart, including while the owner has control.
export async function settleChatStop(store, services, id, isActive, signal) {
  const receipt = store.read().messages.find((m) => m.id === id)?.stopControl;
  if (!receipt || receipt.status === 'completed') return;
  try {
    signal?.throwIfAborted();
    // A start already dispatched may still be returning its job ID. Wait for its guard/abort.
    if ([...receipt.runIds, ...receipt.taskIds].some(isActive)) return;
    const jobs = services.computer?.jobs;
    for (const job of jobs?.rows() || []) {
      if (!receipt.runIds.includes(job.runId) && !receipt.runIds.includes(job.lastInputRunId))
        continue;
      signal?.throwIfAborted();
      const result = await jobs.stop(job.id);
      if (['starting', 'running', 'paused', 'uncertain'].includes(result.status))
        throw Error('The computer has not confirmed that this process ended.');
    }
    signal?.throwIfAborted();
    store.mutate((s) => completeChatStop(s, id));
  } catch (error) {
    if (signal?.aborted) return;
    store.mutate((s) => {
      const message = s.messages.find((m) => m.id === id);
      if (!message || message.stopControl.status === 'completed') return;
      message.stopControl.status = 'retrying';
      message.stopControl.retryAt = Date.now() + 3000;
      message.stopControl.error = String(error.message || error).slice(0, 500);
      message.text =
        'The reply is stopped. I’m still checking that its computer work has ended. You can inspect it on the Computer page.';
    });
  }
}
