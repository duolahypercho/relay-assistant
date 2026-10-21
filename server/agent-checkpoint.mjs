// SPDX-License-Identifier: MIT
import { computerReceiptCheckpoint } from './computer-receipts.mjs';
// A private, bounded journal. It is not part of browser workspace snapshots.
export class AgentCheckpoint {
  constructor(store, runId) {
    this.db = store.db;
    this.runId = runId;
  }
  load() {
    if (!this.runId) return null;
    const row = this.db
      .prepare('SELECT phase,body FROM agent_checkpoints WHERE run_id=?')
      .get(this.runId);
    if (!row) return null;
    const body = JSON.parse(row.body);
    // Handoffs commit work and their immutable operation key in a single
    // SQLite mutation. Replaying the same call recovers the existing request.
    const safeHandoff =
      body.response?.toolCalls?.[body.nextTool]?.function.name === 'ask_assistant';
    // Browser actions resume by their server-generated durable ID. Interrupted receipts
    // return uncertainty instead of replaying a click.
    const safeBrowserReceipt =
      body.response?.toolCalls?.[body.nextTool]?.function.name === 'private_browser_action';
    // The answer binding and old-checkpoint removal share a SQLite transaction.
    const safeQuestion = ['answer_question', 'start_new_request'].includes(
      body.response?.toolCalls?.[body.nextTool]?.function.name,
    );
    // New computer checkpoints may reconcile an exact completed receipt. The
    // agent's recovery path cannot run an action when that receipt is absent.
    if (
      row.phase === 'acting' &&
      !safeHandoff &&
      !safeBrowserReceipt &&
      !safeQuestion &&
      !computerReceiptCheckpoint(body)
    )
      throw new Error(
        'The server stopped during a tool action. Inspect the saved work before retrying; Relay will not repeat it automatically.',
      );
    return { ...body, phase: row.phase };
  }
  save(phase, state) {
    if (!this.runId) return;
    // Images are observations, not durable conversation state. Reinspect after restart.
    const body = JSON.stringify({ ...state, phase: undefined }, (key, value) =>
      key === 'visual' ? undefined : value,
    );
    if (Buffer.byteLength(body, 'utf8') > 12_000_000)
      throw new Error(
        'This run reached its saved-context limit. Inspect its results and continue in a new request.',
      );
    this.db
      .prepare(
        'INSERT INTO agent_checkpoints VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET phase=excluded.phase,body=excluded.body',
      )
      .run(this.runId, phase, body);
  }
  final(result, state = {}) {
    this.save('final', { ...state, result });
    return result;
  }
}
