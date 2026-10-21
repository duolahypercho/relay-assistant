import { withSteering } from '../shared/steering.mjs';
import { runAppContext } from '../shared/app-mentions.mjs';
// SPDX-License-Identifier: MIT
import { createHash, randomBytes, randomUUID } from 'node:crypto';
const active = new Set(['starting', 'running', 'uncertain']);
const terminal = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'interrupted']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

// Host-owned identities and continuation context never come from the guest.
// Guest process state/output is bounded untrusted source data.
export class ComputerJobs {
  constructor(computer) {
    this.computer = computer;
    this.store = computer.store;
    this.db = computer.db;
    this.nextPoll = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS computer_jobs
      (id TEXT PRIMARY KEY, operation_key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL)`);
  }
  rows() {
    return this.db
      .prepare('SELECT body FROM computer_jobs ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.body))
      .filter((r) => r.status !== 'expired');
  }
  get(id, threadId) {
    const row = this.db.prepare('SELECT body FROM computer_jobs WHERE id=?').get(id);
    if (!row) throw fail('This computer job was not found.', 404);
    const job = JSON.parse(row.body);
    if (threadId && job.threadId !== threadId)
      throw fail('That job belongs to another conversation.', 403);
    return job;
  }
  save(job) {
    this.db.prepare('UPDATE computer_jobs SET body=? WHERE id=?').run(JSON.stringify(job), job.id);
  }
  public(job) {
    const {
      id,
      title,
      command,
      cwd,
      status,
      createdAt,
      updatedAt,
      result,
      continuation,
      error,
      seconds,
      pty,
    } = job;
    return {
      id,
      title,
      command,
      cwd,
      status: active.has(status) && this.computer.controller === 'owner' ? 'paused' : status,
      createdAt,
      updatedAt,
      result,
      continuation,
      error,
      seconds,
      pty: !!pty,
    };
  }
  list(threadId) {
    return this.rows()
      .filter((r) => !threadId || r.threadId === threadId)
      .map((r) => this.public(r));
  }
  origin(runId) {
    const s = this.store.read();
    const run = s.runs.find((r) => r.id === runId);
    if (!run || !['running', 'queued'].includes(run.status))
      throw fail('Start this job from an active request.');
    if ((run.jobContext?.depth || 0) >= 12)
      throw fail(
        'This request reached its background-job limit. Review the results before continuing.',
      );
    const original = s.messages.find((m) => m.id === run.messageId);
    return {
      runId,
      assistant: structuredClone(run.assistant),
      handoffId: run.handoffId,
      modelConnection: structuredClone(run.modelConnection),
      appContext: structuredClone(runAppContext(run)),
      threadId: run.threadId,
      messageId: run.messageId,
      depth: (run.jobContext?.depth || 0) + 1,
      questionContext: structuredClone(
        run.questionContext || {
          origin: {
            assistant: structuredClone(run.assistant),
            handoffId: run.handoffId,
            request: run.routineId ? run.instructions : original?.text || '',
            fileIds: original?.fileIds || [],
            skill: run.skill || null,
            skillInput: run.skillInput || '',
            restrictedRoutine: !!run.routineId,
            mailSource: run.mailSource || null,
            templateContext: run.templateContext || null,
            connectionGeneration: run.connectionGeneration ?? null,
          },
          answers: [],
        },
      ),
    };
  }
  async start(p, { runId, signal, guard = () => {} } = {}) {
    const c = this.computer,
      epoch = c.epoch;
    c.assertControl('agent', epoch);
    const command = p.command,
      cwd = p.cwd ?? '.',
      title = p.title?.trim(),
      seconds = p.seconds ?? 3600,
      pty = p.pty ?? false;
    if (
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 8000 ||
      typeof cwd !== 'string' ||
      cwd.length > 1024 ||
      !title ||
      title.length > 120 ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 86400 ||
      typeof pty !== 'boolean' ||
      !/^[a-zA-Z0-9_.:-]{1,120}$/.test(p.operationId || '')
    )
      throw fail(
        'Give the job a short title, command, unique operation ID and a time limit of up to one day.',
        400,
      );
    const key = hash(`${runId}:${p.operationId}`),
      requestHash = hash(JSON.stringify({ command, cwd, title, seconds, ...(pty ? { pty } : {}) }));
    return c.serial(async () => {
      guard();
      signal?.throwIfAborted();
      c.assertControl('agent', epoch);
      const previous = this.db
        .prepare('SELECT * FROM computer_jobs WHERE operation_key=?')
        .get(key);
      if (previous) {
        if (previous.hash !== requestHash)
          throw fail('That operation ID belongs to a different job.');
        const saved = JSON.parse(previous.body);
        if (saved.status === 'expired')
          throw fail(
            'This older job result was removed. Inspect its saved files; its command will not be relaunched.',
          );
        return { ...this.public(saved), repeated: true };
      }
      if (this.rows().filter((r) => active.has(r.status)).length >= 4)
        throw fail('Four jobs are already active. Finish or stop one before starting more.');
      const old = this.rows()
        .filter((r) => terminal.has(r.status) && r.continuation)
        .slice(63);
      for (const r of old) {
        r.status = 'expired';
        r.context = {};
        r.result = {};
        r.command = '';
        this.save(r);
      }
      const context = this.origin(runId);
      await c.runtime.ensure(await c.requireRunning());
      const runtime = await c.runtime.inspect();
      if (old.length)
        await c.rpc({ kind: 'jobs', action: 'forget', ids: old.map((r) => r.id) }, c.runtime.name);
      guard();
      signal?.throwIfAborted();
      c.assertControl('agent', epoch);
      const job = {
        id: randomBytes(16).toString('hex'),
        title,
        command,
        cwd,
        seconds,
        pty,
        status: 'starting',
        createdAt: now(),
        updatedAt: now(),
        context,
        runId,
        threadId: context.threadId,
        runtimeId: runtime.Id,
        runtimeBoot: runtime.State.StartedAt,
        result: {},
        continuation: null,
      };
      this.db
        .prepare('INSERT INTO computer_jobs VALUES (?,?,?,?)')
        .run(job.id, key, requestHash, JSON.stringify(job));
      try {
        const data = await c.rpc(
          { kind: 'jobs', action: 'start', id: job.id, command, cwd, seconds, pty },
          c.runtime.name,
        );
        this.apply(job, data);
        guard();
        signal?.throwIfAborted();
        c.assertControl('agent', epoch);
        return this.public(job);
      } catch (error) {
        // A lost acknowledgement cannot cause a second launch. Poll the same
        // runtime/id later to discover whether the guest accepted the work.
        if (active.has(job.status)) {
          job.status = 'uncertain';
          job.error =
            'The start acknowledgement was interrupted. Checking the existing job; it will not be relaunched.';
          this.save(job);
        }
        throw error;
      }
    });
  }
  async input(p, { actor = 'owner', threadId, scope = 'owner', signal, guard = () => {} } = {}) {
    const c = this.computer,
      epoch = c.epoch;
    if (!['owner', 'agent'].includes(actor) || (actor === 'agent' && !threadId))
      throw fail('A terminal input needs its owning conversation.', 403);
    if (
      typeof p.data !== 'string' ||
      !p.data ||
      Buffer.byteLength(p.data, 'utf8') > 4096 ||
      !/^[a-zA-Z0-9_.:-]{1,120}$/.test(p.operationId || '')
    )
      throw fail('Send up to 4,096 bytes with a unique input operation ID.', 400);
    if (c.controller !== 'agent')
      throw fail('Give control back to Relay before sending job input.');
    c.assertControl('agent', epoch);
    return c.serial(async () => {
      guard();
      signal?.throwIfAborted();
      c.assertControl('agent', epoch);
      const job = this.get(p.id, actor === 'agent' ? threadId : undefined);
      if (actor === 'agent') {
        const run = this.store.read().runs.find((r) => r.id === scope);
        if (!run || run.threadId !== threadId || !['running', 'queued'].includes(run.status))
          throw fail('Send terminal input from an active request in its owning conversation.', 403);
      }
      if (!job.pty) throw fail('This job was not started as an interactive session.');
      const runtime = await c.runtime.inspect();
      guard();
      signal?.throwIfAborted();
      c.assertControl('agent', epoch);
      if (
        !runtime?.State.Running ||
        runtime.State.Paused ||
        runtime.Id !== job.runtimeId ||
        runtime.State.StartedAt !== job.runtimeBoot
      )
        throw fail('This terminal session is no longer available. Its input will not be replayed.');
      const inputId = hash(`${actor}:${scope}:${p.operationId}`);
      if (actor === 'agent') {
        job.lastInputRunId = scope;
        this.save(job);
      }
      const result = await c.rpc(
        { kind: 'jobs', action: 'input', id: job.id, inputId, data: p.data },
        c.runtime.name,
      );
      guard();
      signal?.throwIfAborted();
      c.assertControl('agent', epoch);
      if (
        result?.id !== job.id ||
        result.inputId !== inputId ||
        result.accepted !== true ||
        result.bytes !== Buffer.byteLength(p.data, 'utf8')
      )
        throw fail(
          'Input acknowledgement was not confirmed. Inspect the program; reuse the same operation ID if checking this input again.',
        );
      this.nextPoll = 0;
      return { id: job.id, accepted: true, bytes: result.bytes, repeated: !!result.repeated };
    });
  }
  observed(id, runId) {
    if (typeof runId !== 'string' || !runId) return;
    const job = this.get(id);
    if (
      job.pty &&
      terminal.has(job.status) &&
      !job.continuation &&
      [job.runId, job.lastInputRunId].includes(runId)
    ) {
      job.continuation = `observed:${runId}`;
      this.save(job);
    }
  }
  apply(job, data) {
    if (
      !data ||
      data.id !== job.id ||
      (!active.has(data.status) && !terminal.has(data.status) && data.status !== 'missing')
    )
      throw fail('The computer returned an invalid job status.');
    job.status = data.status === 'missing' ? 'interrupted' : data.status;
    job.updatedAt = now();
    job.error =
      data.status === 'missing'
        ? 'The computer lost this process. Its command was not rerun.'
        : String(data.error || '').slice(0, 500);
    job.result = {
      stdout: String(data.stdout || '').slice(-96000),
      stderr: String(data.stderr || '').slice(-96000),
      truncated: !!data.truncated,
      exitCode: Number.isInteger(data.exitCode) ? data.exitCode : null,
    };
    this.save(job);
  }
  activeCount() {
    return this.rows().filter((r) => active.has(r.status)).length;
  }
  due() {
    return (
      this.computer.enabled &&
      this.computer.controller === 'agent' &&
      Date.now() >= this.nextPoll &&
      this.rows().some((r) => active.has(r.status) || (!r.continuation && r.status !== 'cancelled'))
    );
  }
  async poll(signal) {
    this.nextPoll = Date.now() + 3000;
    return this.computer.serial(async () => {
      const c = this.computer,
        epoch = c.epoch;
      const check = () => {
        signal?.throwIfAborted();
        if (epoch !== c.epoch || c.controller !== 'agent')
          throw new DOMException('Computer control changed. Wait for handback.', 'AbortError');
      };
      check();
      signal?.throwIfAborted();
      const jobs = this.rows().filter((r) => active.has(r.status));
      if (jobs.length) {
        const runtime = await c.runtime.inspect();
        check();
        signal?.throwIfAborted();
        const connected = [];
        for (const job of jobs) {
          if (
            !runtime?.State.Running ||
            runtime.Id !== job.runtimeId ||
            runtime.State.StartedAt !== job.runtimeBoot
          ) {
            this.apply(job, {
              id: job.id,
              status: 'interrupted',
              error: 'The computer restarted or stopped. This command was not rerun.',
            });
          } else connected.push(job);
        }
        if (connected.length && !runtime.State.Paused) {
          const data = await c.rpc(
            { kind: 'jobs', action: 'list', ids: connected.map((j) => j.id) },
            c.runtime.name,
          );
          check();
          signal?.throwIfAborted();
          if (!Array.isArray(data.jobs) || data.jobs.length !== connected.length)
            throw fail('The computer returned incomplete job status.');
          for (const job of connected)
            this.apply(
              job,
              data.jobs.find((j) => j.id === job.id),
            );
        }
      }
      check();
      signal?.throwIfAborted();
      this.continueFinished();
    });
  }
  continueFinished() {
    for (const job of this.rows().filter((r) => terminal.has(r.status) && !r.continuation)) {
      const s = this.store.read();
      const original = s.runs.find((r) => r.id === job.runId);
      if (original && ['running', 'queued'].includes(original.status)) continue;
      const answering = s.runs.find((r) => r.id === job.lastInputRunId);
      if (answering && ['running', 'queued'].includes(answering.status)) continue;
      const thread = s.threads.find((t) => t.id === job.threadId);
      const generation = job.context.questionContext.origin.connectionGeneration;
      if (
        job.status === 'cancelled' ||
        (original?.handoffId &&
          s.handoffs?.find((h) => h.id === original.handoffId)?.status === 'cancelled') ||
        original?.status !== 'completed' ||
        original.stopControlId ||
        !thread ||
        thread.archived ||
        (generation != null &&
          (!s.connections.google.connected || s.connections.google.generation !== generation))
      ) {
        job.continuation = 'stopped';
        this.save(job);
        continue;
      }
      this.store.mutate((state) => {
        const id = `run-${randomUUID()}`;
        state.runs.push({
          id,
          threadId: job.threadId,
          messageId: job.context.messageId,
          assistant: job.context.assistant,
          handoffId: job.context.handoffId,
          modelConnection: job.context.modelConnection,
          appContext: structuredClone(job.context.appContext || []),
          questionContext: withSteering(state, original, job.context.questionContext),
          connectionGeneration: generation,
          jobContext: {
            id: job.id,
            depth: job.context.depth,
            title: job.title,
            status: job.status,
            error: job.error,
            result: {
              ...job.result,
              stdout: job.result.stdout.slice(-14000),
              stderr: job.result.stderr.slice(-6000),
            },
          },
          status: 'queued',
          partial: '',
          leaseUntil: 0,
          createdAt: now(),
        });
        job.continuation = id;
        this.save(job);
      });
    }
  }
  async stop(id, { actor = 'owner', threadId } = {}) {
    const c = this.computer,
      epoch = c.epoch;
    if (actor === 'agent') c.assertControl(actor, epoch);
    return c.serial(async () => {
      if (actor === 'agent') c.assertControl(actor, epoch);
      const job = this.get(id, threadId);
      if (active.has(job.status)) {
        const runtime = await c.runtime.inspect();
        if (
          !runtime?.State.Running ||
          runtime.Id !== job.runtimeId ||
          runtime.State.StartedAt !== job.runtimeBoot
        )
          this.apply(job, {
            id,
            status: 'interrupted',
            error: 'The computer no longer has this process.',
          });
        else {
          const result = await c.runtime.jobStop(runtime, id);
          this.apply(job, result);
        }
      }
      // An explicit Stop also prevents a completion that was queued but has not
      // begun. It never repeats or rolls back already-finished external work.
      this.store.mutate((s) => {
        const resumed = s.runs.find((r) => r.id === job.continuation);
        if (resumed && ['queued', 'running'].includes(resumed.status)) resumed.status = 'cancelled';
        job.continuation ||= 'stopped';
        this.save(job);
      });
      return this.public(job);
    });
  }
  stopped() {
    for (const job of this.rows().filter((r) => active.has(r.status)))
      this.apply(job, {
        id: job.id,
        status: 'interrupted',
        error: 'The computer was stopped. Saved files remain; this command was not rerun.',
      });
  }
}
