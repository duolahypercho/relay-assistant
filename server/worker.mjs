import { settleChatStop } from './chat-stop.mjs';
import { safeReplyCheckpoint, pruneReplyCheckpoints, replyRetryLifetime } from './chat-retry.mjs';
import { foregroundRuns, prioritizeRuns, ownerActivity } from '../shared/work-priority.mjs';
import { sampleSteeringRun } from '../shared/steering.mjs';
import { routeGroup } from './groups.mjs';
import { commitGroupRoute } from '../shared/groups.mjs';
import { reconcileHandoffs, bindHandoffRun } from './handoffs.mjs';
// SPDX-License-Identifier: MIT
import { ensureTeaching } from './teaching.mjs';
import { ensureVoiceCalls } from './voice-calls.mjs';
import { IdeasService } from './ideas.mjs';
import { reviewRoutineUpdate } from './routine-updates.mjs';
import { randomUUID } from 'node:crypto';
import { sampleRunReply, appendAssistant } from '../shared/assistant.mjs';
import { calculateStep, commitStep } from '../shared/task-step.mjs';
import { completeApproval, recordObservation } from '../shared/domain.mjs';
import { agentReply, systemPrompt } from './agent.mjs';
import { hasDueRoutines, dispatchRoutines, finishRoutine } from '../shared/routines.mjs';
export function recoverWork(store) {
  store.mutate((s) => {
    for (const collection of ['runs', 'tasks'])
      for (const item of s[collection].filter((x) => x.status === 'running')) {
        item.status = 'queued';
        item.leaseUntil = 0;
        item.leaseOwner = null;
        delete item.waitingForReply;
      }
    for (const a of s.approvals.filter((a) => a.status === 'executing')) {
      a.status = 'outcome_unknown';
      a.error = 'The server restarted during this action. Check the provider before trying again.';
      const task = s.tasks.find((t) => t.id === a.taskId);
      if (task) {
        task.status = 'failed';
        task.error = a.error;
      }
    }
  });
  pruneReplyCheckpoints(store);
}
export class BackgroundWorker {
  constructor(store, services, { pollMs = 400, stepDelay = 300, leaseMs = 30000 } = {}) {
    ensureTeaching(store, services);
    ensureVoiceCalls(store, services);
    this.store = store;
    this.services = services;
    if (
      services.provider &&
      (!services.ideas ||
        services.ideas.store !== store ||
        services.ideas.provider !== services.provider)
    )
      services.ideas = new IdeasService(store, services.provider, {
        canRun: () => !this.pausedForOwner && !this.hasForeground,
      });
    if (services.ideas) services.ideas.canRun = () => !this.pausedForOwner && !this.hasForeground;
    this.pollMs = pollMs;
    this.stepDelay = stepDelay;
    this.leaseMs = leaseMs;
    this.active = new Map();
    this.stopped = false;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }
  abort(id) {
    this.active.get(id)?.controller.abort();
  }
  stopChat(id) {
    const receipt = this.store.read().messages.find((m) => m.id === id)?.stopControl;
    if (!receipt || receipt.status === 'completed') return;
    for (const key of [...receipt.runIds, ...receipt.taskIds]) this.abort(key);
    this.track(
      `stop:${id}`,
      (signal) =>
        settleChatStop(this.store, this.services, id, (key) => this.active.has(key), signal),
      { control: true },
    );
  }
  get workCount() {
    return [...this.active.values()].filter((entry) => !entry.control).length;
  }
  get hasForeground() {
    return foregroundRuns(this.store.read()).size > 0;
  }
  get canStartBackground() {
    // Keep one of five work slots available for a new owner message.
    return this.workCount < 4 && !this.hasForeground;
  }
  shouldYield(id) {
    const state = this.store.read();
    const work = state.runs.find((r) => r.id === id) || state.tasks.find((t) => t.id === id);
    if (work && !['running', 'queued'].includes(work.status)) return false;
    if (
      work?.voiceCallId &&
      state.voiceCalls?.some(
        (c) => c.id === work.voiceCallId && c.status === 'active' && c.listening,
      )
    )
      return true;
    const foreground = foregroundRuns(state);
    return foreground.size > 0 && !foreground.has(id);
  }
  async waitForTurn(id, signal) {
    await this.waitForOwner(signal);
    if (!this.shouldYield(id)) return false;
    const mark = (waiting) => {
      const run = this.store.read().runs.find((r) => r.id === id);
      if (!run || !!run.waitingForReply === waiting) return;
      this.store.mutate((s) => {
        const current = s.runs.find((r) => r.id === id);
        if (waiting) current.waitingForReply = true;
        else delete current.waitingForReply;
      });
    };
    mark(true);
    try {
      do {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            this.store.off('change', changed);
            signal.removeEventListener('abort', aborted);
          };
          const aborted = () => {
            cleanup();
            reject(signal.reason || new DOMException('Stopped', 'AbortError'));
          };
          const changed = () => {
            if (signal.aborted) return aborted();
            if (!this.shouldYield(id)) {
              cleanup();
              resolve();
            }
          };
          this.store.on('change', changed);
          signal.addEventListener('abort', aborted, { once: true });
          changed();
        });
        await this.waitForOwner(signal);
      } while (this.shouldYield(id));
      return true;
    } finally {
      mark(false);
    }
  }
  get pausedForOwner() {
    return this.services.computer?.enabled && this.services.computer.controller === 'owner';
  }
  async waitForOwner(signal) {
    await this.services.computer?.waitForAgent?.(signal);
    signal.throwIfAborted();
  }
  track(id, fn, { control = false } = {}) {
    if (this.active.has(id) || this.stopped) return;
    const controller = new AbortController();
    const value = { controller, promise: null, control };
    this.active.set(id, value);
    value.promise = fn(controller.signal)
      .catch((e) => {
        if (e.name !== 'AbortError') console.error('Background work failed:', e.message);
      })
      .finally(() => this.active.delete(id));
  }
  tick() {
    if (this.stopped) return;
    if (!(this.nextRetryPrune > Date.now())) {
      this.nextRetryPrune = Date.now() + 60000;
      pruneReplyCheckpoints(this.store);
    }
    for (const message of this.store.read().messages)
      if (
        message.stopControl &&
        message.stopControl.status !== 'completed' &&
        !(message.stopControl.retryAt > Date.now())
      )
        this.stopChat(message.id);
    this.services.voiceCalls.sweep();
    // The owner explicitly shared a stopped recording. This task has no live computer access or tools.
    if (
      this.workCount < 4 &&
      (this.pausedForOwner || !this.hasForeground) &&
      this.services.teaching?.due()
    )
      this.track('teaching-draft', (signal) => this.services.teaching.poll(signal));
    if (this.pausedForOwner) {
      // Read-only monitors may be retried. Never abort an external write already
      // accepted by a provider; record its outcome once, including uncertainty.
      this.abort('mail-trigger-poll');
      this.abort('ideas-poll');
      for (const watch of this.store.read().watches) this.abort(watch.id);
      return;
    }
    if (this.services.computer?.jobs?.due())
      this.track('computer-job-poll', (signal) => this.services.computer.jobs.poll(signal), {
        control: true,
      });
    if (this.canStartBackground && this.services.mailTriggers?.due())
      this.track('mail-trigger-poll', (signal) => this.services.mailTriggers.poll(signal));
    this.services.connectors?.tick();
    reconcileHandoffs(this.store, this.services);
    let s = this.store.read();
    if (hasDueRoutines(s)) {
      this.store.mutate((state) => dispatchRoutines(state));
      s = this.store.read();
    }
    const foreground = foregroundRuns(s);
    for (const run of prioritizeRuns(s)) {
      if (this.workCount >= 5) break;
      if (!foreground.has(run.id) && !this.canStartBackground) continue;
      if (this.active.has(run.id)) continue;
      const sameThread = s.runs.some(
        (r) =>
          (r.threadId === run.threadId || (run.routineId && r.routineId === run.routineId)) &&
          r.id !== run.id &&
          r.status === 'running' &&
          r.leaseUntil > Date.now(),
      );
      if (
        !sameThread &&
        ((run.status === 'queued' && !s.threads.find((t) => t.id === run.threadId)?.queuePaused) ||
          (run.status === 'running' && run.leaseUntil < Date.now()))
      )
        this.track(run.id, (signal) => this.reply(run.id, signal));
    }
    for (const t of s.tasks) {
      if (!this.canStartBackground) break;
      if (t.status === 'queued' || (t.status === 'running' && t.leaseUntil < Date.now()))
        this.track(t.id, (signal) => this.step(t.id, signal));
    }
    for (const a of s.approvals) {
      if (a.status === 'approved' && this.canStartBackground)
        this.track(a.id, (signal) => this.execute(a.id, signal));
      else if (a.status === 'pending' && a.expiresAt < Date.now())
        this.store.mutate((s) => {
          const x = s.approvals.find((x) => x.id === a.id);
          if (x?.status === 'pending') {
            x.status = 'expired';
            if (x.taskId) {
              const t = s.tasks.find((t) => t.id === x.taskId);
              if (t) {
                t.status = 'failed';
                t.error = 'The action review expired. Retry to prepare a fresh review.';
              }
            }
          }
        });
    }
    for (const w of s.watches) {
      if (!this.canStartBackground) break;
      if (!w.paused && w.nextCheck <= Date.now())
        this.track(w.id, (signal) => this.observe(w.id, signal));
    }
    if (this.canStartBackground && this.services.ideas?.due())
      this.track('ideas-poll', (signal) => this.services.ideas.poll(signal));
  }
  claim(collection, id) {
    if (this.pausedForOwner) return null;
    const owner = randomUUID();
    return this.store.mutate((s) => {
      const item = s[collection].find((i) => i.id === id);
      if (
        !item ||
        !['queued', 'running'].includes(item.status) ||
        (item.status === 'running' && item.leaseUntil > Date.now())
      )
        return null;
      if (collection === 'runs') {
        if (bindHandoffRun(s, item) === false) {
          item.status = 'cancelled';
          item.leaseUntil = 0;
          return null;
        }
        if (s.threads.find((t) => t.id === item.threadId)?.queuePaused) return null;
        if (
          s.runs.some(
            (r) =>
              (r.threadId === item.threadId ||
                (item.routineId && r.routineId === item.routineId)) &&
              r.id !== item.id &&
              r.status === 'running' &&
              r.leaseUntil > Date.now(),
          )
        )
          return null;
        const first = s.runs.find((r) => r.threadId === item.threadId && r.status === 'queued');
        if (item.status === 'queued' && first?.id !== id) return null;
      }
      item.status = 'running';
      item.leaseOwner = owner;
      item.leaseUntil = Date.now() + this.leaseMs;
      return structuredClone(item);
    });
  }
  guard(collection, item, signal) {
    signal.throwIfAborted();
    const current = this.store.read()[collection].find((x) => x.id === item.id);
    if (current?.status !== 'running' || current.leaseOwner !== item.leaseOwner)
      throw new DOMException('Work was stopped or claimed by another worker.', 'AbortError');
  }
  heartbeat(collection, item, signal) {
    return setInterval(
      () => {
        try {
          this.guard(collection, item, signal);
          this.store.mutate((s) => {
            const x = s[collection].find((x) => x.id === item.id);
            if (x?.leaseOwner === item.leaseOwner && x.status === 'running')
              x.leaseUntil = Date.now() + this.leaseMs;
          });
        } catch {}
      },
      Math.floor(this.leaseMs / 3),
    );
  }
  async reply(id, signal) {
    const run = this.claim('runs', id);
    if (!run) return;
    const beat = this.heartbeat('runs', run, signal);
    let lastSave = 0;
    let activity = ownerActivity(this.store.read(), id);
    const beforeWork = async (attemptSignal) => {
      const waited = await this.waitForTurn(id, attemptSignal);
      const latest = ownerActivity(this.store.read(), id);
      const changed = activity !== latest;
      activity = latest;
      return waited || changed;
    };
    try {
      let response;
      const provider =
        this.services.provider.forRun?.(run, {
          beforeAttempt: (attemptSignal) => this.waitForOwner(attemptSignal),
        }) || this.services.provider;
      if (run.groupRouting) {
        await this.waitForTurn(id, signal);
        const recipients = await routeGroup(this.store, provider, run, signal);
        await this.waitForTurn(id, signal);
        this.guard('runs', run, signal);
        this.store.mutate((s) => commitGroupRoute(s, run.id, recipients));
        return;
      }
      if (run.routineId && run.execution === 'reminder')
        response = { text: run.instructions, cards: [] };
      else if (provider.configured) {
        do {
          response = await agentReply(this.store, provider, run, this.services, {
            signal,
            durable: true,
            beforeWork,
            onText: (text) => {
              if (this.shouldYield(id)) return;
              if (Date.now() - lastSave < 100) return;
              lastSave = Date.now();
              this.guard('runs', run, signal);
              this.store.mutate((s) => {
                const r = s.runs.find((r) => r.id === id);
                if (r?.leaseOwner === run.leaseOwner && r.status === 'running') r.partial = text;
              });
            },
          });
          await this.waitForTurn(id, signal);
          this.guard('runs', run, signal);
          const latest = this.store.read().runs.find((r) => r.id === id);
          if ((latest.steeringMessageIds?.length || 0) <= (latest.steeringApplied || 0)) break;
        } while (true);
      } else {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 600);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DOMException('Stopped', 'AbortError'));
            },
            { once: true },
          );
        });
        await this.waitForTurn(id, signal);
        this.guard('runs', run, signal);
        response = this.store.mutate((s) =>
          sampleRunReply(s, sampleSteeringRun(s.runs.find((r) => r.id === id))),
        );
      }
      await this.waitForTurn(id, signal);
      this.guard('runs', run, signal);
      const resultReview = await reviewRoutineUpdate(
        this.store.read(),
        run,
        response,
        provider,
        signal,
        (attemptSignal) => this.waitForTurn(id, attemptSignal),
      );
      await this.waitForTurn(id, signal);
      this.guard('runs', run, signal);
      this.store.mutate((s) => {
        const r = s.runs.find((r) => r.id === id);
        if (r?.leaseOwner !== run.leaseOwner || r.status !== 'running') return;
        const surface = !r.routineId || finishRoutine(s, r, response, '', resultReview);
        if (surface && (!response.handoffWaiting || response.text || response.cards?.length))
          appendAssistant(
            s,
            r.threadId,
            response,
            r.routineId
              ? { routineId: r.routineId, routineTitle: r.routineTitle, routineRunId: r.id }
              : { replyTo: r.activeMessageId || r.messageId },
            r,
          );
        r.status = 'completed';
        r.leaseUntil = 0;
        r.partial = '';
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        const saved = safeReplyCheckpoint(this.store, run);
        this.store.mutate((s) => {
          const r = s.runs.find((r) => r.id === id);
          if (r?.leaseOwner === run.leaseOwner && r.status === 'running') {
            r.status = 'failed';
            r.error = e.message;
            r.retryable = !!saved && e.retryable !== false;
            if (r.retryable) r.retryUntil = Date.now() + replyRetryLifetime;
            const response = {
              text: `I could not finish ${r.routineId ? 'this routine' : 'this reply'}: ${e.message}`,
              cards: saved?.cards || saved?.result?.cards || [],
            };
            if (r.routineId) finishRoutine(s, r, response, e.message);
            const failure = appendAssistant(
              s,
              r.threadId,
              response,
              {
                error: true,
                replyTo: r.activeMessageId || r.messageId,
                ...(r.routineId
                  ? { routineId: r.routineId, routineTitle: r.routineTitle, routineRunId: r.id }
                  : {}),
              },
              r,
            );
            if (r.retryable) r.retryMessageId = failure.id;
          }
        });
      }
    } finally {
      clearInterval(beat);
      const current = this.store.read().runs.find((r) => r.id === id);
      if (
        !current ||
        (!['running', 'queued'].includes(current.status) &&
          !(current.status === 'failed' && current.retryable))
      )
        this.store.db.prepare('DELETE FROM agent_checkpoints WHERE run_id=?').run(id);
      pruneReplyCheckpoints(this.store);
    }
  }
  async step(id, signal) {
    const t = this.claim('tasks', id);
    if (!t) return;
    const beat = this.heartbeat('tasks', t, signal);
    try {
      if (this.stepDelay) await new Promise((r) => setTimeout(r, this.stepDelay));
      await this.waitForTurn(id, signal);
      this.guard('tasks', t, signal);
      const step = await calculateStep(this.store.read(), t, {
        readPage: async (url) => {
          await this.waitForTurn(id, signal);
          return this.services.readPage(url, signal);
        },
        ...(this.services.provider.configured
          ? {
              reason: async (description, s, context) => {
                await this.waitForTurn(id, signal);
                const r = await this.services.provider.complete(
                  [
                    {
                      role: 'system',
                      content:
                        systemPrompt(s) +
                        '\nProduce a useful Markdown result for this task. Use only the provided source notes for factual research; do not invent citations or completed external actions.',
                    },
                    { role: 'user', content: description },
                    { role: 'user', content: `Source notes and preliminary work:\n${context}` },
                  ],
                  [],
                  { signal, beforeAttempt: (attemptSignal) => this.waitForTurn(id, attemptSignal) },
                );
                return r.text;
              },
            }
          : {}),
      });
      await this.waitForTurn(id, signal);
      this.guard('tasks', t, signal);
      this.store.mutate((s) => {
        const latest = s.tasks.find((x) => x.id === id);
        if (latest?.leaseOwner === t.leaseOwner && latest.status === 'running')
          commitStep(s, id, step);
      });
    } catch (e) {
      if (e.name !== 'AbortError')
        this.store.mutate((s) => {
          const x = s.tasks.find((x) => x.id === id);
          if (x?.leaseOwner === t.leaseOwner && x.status === 'running') {
            x.status = 'failed';
            x.error = e.message;
            x.leaseUntil = 0;
          }
        });
    } finally {
      clearInterval(beat);
    }
  }
  async execute(id, signal) {
    if (this.pausedForOwner) return;
    const approval = this.store.mutate((s) => {
      const a = s.approvals.find((a) => a.id === id);
      if (a?.status !== 'approved') return null;
      const task = s.tasks.find((t) => t.id === a.taskId);
      if (task?.status === 'cancelled') {
        a.status = 'rejected';
        return null;
      }
      if (
        a.connectionGeneration !== null &&
        (!s.connections.google.connected ||
          a.connectionGeneration !== s.connections.google.generation)
      ) {
        a.status = 'failed';
        a.error = 'The connected account changed. Prepare a fresh review.';
        return null;
      }
      if (
        a.kind === 'calendar' &&
        a.payload.operation !== 'create' &&
        s.events.find((e) => e.id === a.payload.event.id)?.version !== a.payload.expectedVersion
      ) {
        a.status = 'failed';
        a.error = 'The event changed. Prepare a fresh review.';
        return null;
      }
      a.status = 'executing';
      a.startedAt = Date.now();
      return structuredClone(a);
    });
    if (!approval) return;
    try {
      let result;
      if (approval.kind === 'connector') {
        const output = await this.services.connectors.executeApproval(approval, signal);
        if (output.isError)
          throw Object.assign(
            new Error('The app reported an error. Review its returned output before trying again.'),
            { connectorResult: output },
          );
        result = {
          detail: `${output.appName}: ${
            output.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n')
              .slice(0, 2000) || 'The reviewed action returned a result.'
          }`,
          connectorResult: output,
        };
      } else if (approval.kind === 'terminal')
        result = await this.services.terminal.run(approval.payload.command);
      else if (approval.connectionGeneration !== null)
        result = await this.services.google.execute(approval);
      else if (this.services.mode === 'sample')
        result = {
          detail:
            approval.kind === 'email'
              ? 'Reply saved to the sample Sent folder.'
              : 'Sample calendar updated.',
        };
      else throw new Error('Connect Google before executing this live action.');
      this.store.mutate((s) => {
        const a = s.approvals.find((a) => a.id === id);
        if (a && result.connectorResult) a.connectorResult = result.connectorResult;
        return completeApproval(s, id, result);
      });
    } catch (e) {
      this.store.mutate((s) => {
        const a = s.approvals.find((a) => a.id === id);
        if (a?.status === 'executing') {
          a.status = e.name === 'UncertainActionError' ? 'outcome_unknown' : 'failed';
          a.error = e.message;
          if (e.connectorResult) a.connectorResult = e.connectorResult;
          if (a.taskId) {
            const t = s.tasks.find((t) => t.id === a.taskId);
            if (t) {
              t.status = 'failed';
              t.error = e.message;
            }
          }
        }
      });
    }
  }
  async observe(id, signal) {
    const w = this.store.read().watches.find((w) => w.id === id);
    if (!w || w.paused) return;
    try {
      const text =
        w.url === 'relay://workshop'
          ? this.store.read().fixture.text
          : (await this.services.readPage(w.url, signal)).text;
      await this.waitForTurn(id, signal);
      this.store.mutate((s) => recordObservation(s, id, text));
    } catch (e) {
      if (e.name !== 'AbortError')
        this.store.mutate((s) => recordObservation(s, id, '', e.message));
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map((v) => v.promise));
  }
}
