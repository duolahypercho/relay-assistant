import { withSteering } from '../shared/steering.mjs';
import { runAppContext } from '../shared/app-mentions.mjs';
import { acceptsAssistant } from '../shared/assistant-scope.mjs';
// SPDX-License-Identifier: MIT
// The guest has no network interface. A localhost proxy exchanges bounded frames
// over Docker stdin/stdout; only this host process resolves and connects sites.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { resolveDestination } from './network.mjs';
import { uid, iso } from '../shared/seed.mjs';

export function website(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a complete website address, including https://.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    url.href.length > 3000
  )
    throw new Error('Use a public HTTP or HTTPS website on its standard port.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || host.includes('..'))
    throw new Error('Use a valid public website name.');
  url.hostname = host;
  url.hash = '';
  return { host, url: url.href };
}

export class ComputerNetwork {
  constructor(
    computer,
    {
      resolver = resolveDestination,
      connector = connect,
      spawner = spawn,
      now = Date.now,
      maxBytes = 64_000_000,
    } = {},
  ) {
    this.computer = computer;
    this.db = computer.db;
    this.resolve = resolver;
    this.connect = connector;
    this.spawn = spawner;
    this.now = now;
    this.maxBytes = maxBytes;
    this.sockets = new Map();
    this.pending = new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS computer_websites (
      host TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL,
      expires INTEGER NOT NULL DEFAULT 0, requested INTEGER NOT NULL, reason TEXT NOT NULL
    );`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS computer_web_waits (
      run_id TEXT NOT NULL, host TEXT NOT NULL, context TEXT NOT NULL, resume_run TEXT,
      PRIMARY KEY(run_id,host)
    );`);
    // A slow desktop screenshot must not overwrite a newer website decision.
    // SQL triggers cover expiry, revoke and restart as well as owner mutations.
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS computer_web_revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO computer_web_revision VALUES (1,0);
      CREATE TRIGGER IF NOT EXISTS computer_web_insert AFTER INSERT ON computer_websites BEGIN UPDATE computer_web_revision SET value=value+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS computer_web_update AFTER UPDATE ON computer_websites BEGIN UPDATE computer_web_revision SET value=value+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS computer_web_delete AFTER DELETE ON computer_websites BEGIN UPDATE computer_web_revision SET value=value+1 WHERE id=1; END;`);
    // Retire unreviewed background-traffic prompts from the initial broker.
    // Keep owner decisions and every request tied to an actual waiting task.
    this.db
      .prepare(
        `DELETE FROM computer_websites
      WHERE status='pending' AND reason='Requested by the computer’s browser or an app.'
      AND NOT EXISTS (SELECT 1 FROM computer_web_waits w WHERE w.host=computer_websites.host)`,
      )
      .run();
    // A service restart cannot silently restore a permission session.
    this.db
      .prepare("UPDATE computer_websites SET status='expired',expires=0 WHERE status='allowed'")
      .run();
  }
  sites() {
    this.expire();
    return this.db
      .prepare('SELECT * FROM computer_websites ORDER BY requested DESC LIMIT 40')
      .all();
  }
  allowed(host) {
    const row = this.db
      .prepare('SELECT status,expires FROM computer_websites WHERE host=?')
      .get(host);
    return row?.status === 'allowed' && row.expires > this.now();
  }
  expire() {
    this.db
      .prepare(
        "UPDATE computer_websites SET status='expired' WHERE status='allowed' AND expires<=?",
      )
      .run(this.now());
    for (const [id, entry] of this.sockets) if (!this.allowed(entry.host)) this.close(id);
  }
  async request(value, reason = '') {
    const { host, url } = website(value);
    await this.resolve(url);
    if (this.allowed(host)) return { host, url, allowed: true };
    const existing = this.db.prepare('SELECT * FROM computer_websites WHERE host=?').get(host);
    if (!existing) {
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM computer_websites WHERE status='pending'")
        .get().n;
      if (count >= 20) throw new Error('Review the pending websites before requesting more.');
      this.db
        .prepare(
          `INSERT INTO computer_websites VALUES (?,?,'pending',0,?,?)
        ON CONFLICT(host) DO UPDATE SET url=excluded.url,status='pending',expires=0,requested=excluded.requested,reason=excluded.reason`,
        )
        .run(host, url, this.now(), String(reason).slice(0, 240));
    }
    return { host, url, allowed: false };
  }
  waitForOwner(runId, host, url) {
    const s = this.computer.store.read();
    const run = s.runs.find((r) => r.id === runId);
    if (!run) throw new Error('The original computer request was not found.');
    const original = s.messages.find((m) => m.id === run.messageId);
    const context = run.questionContext || {
      origin: {
        assistant: structuredClone(run.assistant),
        handoffId: run.handoffId,
        request: run.routineId ? run.instructions : original?.text || '',
        fileIds: original?.fileIds || [],
        appContext: structuredClone(runAppContext(run)),
        skill: run.skill || null,
        skillInput: run.skillInput || '',
        restrictedRoutine: !!run.routineId,
        mailSource: run.mailSource || null,
        templateContext: run.templateContext || null,
        connectionGeneration: run.connectionGeneration ?? null,
      },
      answers: [],
    };
    this.db.prepare('INSERT OR IGNORE INTO computer_web_waits VALUES (?,?,?,NULL)').run(
      runId,
      host,
      JSON.stringify({
        threadId: run.threadId,
        messageId: run.messageId,
        assistant: structuredClone(run.assistant),
        handoffId: run.handoffId,
        modelConnection: structuredClone(run.modelConnection),
        appContext: structuredClone(runAppContext(run)),
        questionContext: context,
        websiteContext: { host, url },
      }),
    );
  }
  continuation(runId, host) {
    const row = this.db
      .prepare('SELECT * FROM computer_web_waits WHERE run_id=? AND host=?')
      .get(runId, host);
    if (!row) throw new Error('This website request has no saved conversation to continue.');
    const context = JSON.parse(row.context);
    const s = this.computer.store.read();
    const thread = s.threads.find((t) => t.id === context.threadId);
    if (!thread || thread.archived) throw new Error('Restore this conversation before continuing.');
    if (context.assistant && !acceptsAssistant(s, context.threadId, context.assistant.id))
      throw new Error(
        'The original assistant is no longer in this conversation. Send a new request.',
      );
    const original = s.runs.find((r) => r.id === runId);
    if (
      original?.handoffId &&
      s.handoffs?.find((h) => h.id === original.handoffId)?.status === 'cancelled'
    )
      throw new Error('This specialist request was stopped. Send a new request.');
    if (!original || original.status !== 'completed' || original.stopControlId)
      throw new Error('This request is no longer waiting for website access.');
    const generation = context.questionContext.origin.connectionGeneration;
    if (
      generation != null &&
      (!s.connections.google.connected || s.connections.google.generation !== generation)
    )
      throw new Error('The connected account changed. Start a new request.');
    return { ...row, context };
  }
  waitState(runId, host) {
    const row = this.db
      .prepare('SELECT resume_run FROM computer_web_waits WHERE run_id=? AND host=?')
      .get(runId, host);
    const run =
      row?.resume_run && this.computer.store.read().runs.find((r) => r.id === row.resume_run);
    return { requested: !!row, resumed: row?.resume_run || null, status: run?.status || null };
  }
  resume(runId, host) {
    const row = this.continuation(runId, host);
    if (row.resume_run) return { resumed: row.resume_run, repeated: true };
    return this.computer.store.mutate((s) => {
      const run = {
        ...row.context,
        questionContext: withSteering(
          s,
          s.runs.find((r) => r.id === runId),
          row.context.questionContext,
        ),
        id: uid('run'),
        status: 'queued',
        partial: '',
        leaseUntil: 0,
        createdAt: iso(),
        connectionGeneration: row.context.questionContext.origin.connectionGeneration,
      };
      s.runs.push(run);
      this.db
        .prepare('UPDATE computer_web_waits SET resume_run=? WHERE run_id=? AND host=?')
        .run(run.id, runId, host);
      return { resumed: run.id };
    });
  }
  async decide(host, decision) {
    const row = this.db.prepare('SELECT * FROM computer_websites WHERE host=?').get(host);
    if (!row) throw new Error('Request this website before granting access.');
    if (!['allow', 'revoke', 'deny'].includes(decision))
      throw new Error('Choose allow, deny or revoke.');
    if (decision === 'allow') {
      await this.resolve(row.url);
      this.db
        .prepare("UPDATE computer_websites SET status='allowed',expires=? WHERE host=?")
        .run(this.now() + 60 * 60 * 1000, host);
    } else {
      this.db
        .prepare('UPDATE computer_websites SET status=?,expires=0 WHERE host=?')
        .run(decision === 'deny' ? 'denied' : 'revoked', host);
      for (const [id, entry] of this.sockets) if (entry.host === host) this.close(id);
    }
    return { host, decision, ...this.status() };
  }
  status() {
    const sites = this.sites();
    return {
      enabled: true,
      connected: !!this.ready,
      error: this.error || '',
      sites,
      revision: this.db.prepare('SELECT value FROM computer_web_revision WHERE id=1').get().value,
    };
  }
  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const child = this.spawn(
        this.computer.docker,
        [
          ...(this.computer.dockerHost ? ['--host', this.computer.dockerHost] : []),
          'exec',
          '-i',
          this.computer.name,
          'python3',
          '/opt/relay/network-bridge.py',
        ],
        {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...this.computer.dockerEnvironment,
            DOCKER_HOST: this.computer.dockerHost ? '' : process.env.DOCKER_HOST,
            DOCKER_CONTEXT: this.computer.dockerHost ? '' : process.env.DOCKER_CONTEXT,
          },
        },
      );
      this.child = child;
      this.error = '';
      let buffer = '',
        settled = false;
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'The computer web connection did not start. Stop and start the computer after updating its image.',
            ),
          ),
        10000,
      );
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.error = error.message;
          child.kill();
          reject(error);
        } else resolve();
      };
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 1_000_000) return child.kill();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            if (line.length > 90000) throw new Error('Oversized proxy frame');
            const frame = JSON.parse(line);
            if (frame.type === 'ready') {
              if (settled) {
                child.kill();
                return;
              }
              this.ready = true;
              this.expirationTimer = setInterval(() => this.expire(), 1000);
              this.expirationTimer.unref?.();
              finish();
            } else this.frame(frame).catch(() => this.close(frame.id));
          } catch {
            child.kill();
          }
        }
      });
      child.stderr.on('data', () => {}); // Never send guest logs or URLs into server logs.
      child.stdin.on('error', () => child.kill());
      child.on('error', (e) =>
        finish(
          new Error(
            e.code === 'ENOENT' ? 'Docker is unavailable.' : 'The computer web connection failed.',
          ),
        ),
      );
      child.on('exit', () => {
        if (this.child !== child) return;
        this.ready = false;
        this.child = null;
        clearInterval(this.expirationTimer);
        for (const id of this.sockets.keys()) this.close(id);
        this.pending.clear();
        finish(new Error('The computer web connection closed. Restart its computer to reconnect.'));
      });
    });
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }
  send(frame) {
    if (!this.child || this.child.stdin.destroyed) return;
    if (this.child.stdin.writableLength > 1_000_000) {
      this.child.kill();
      return;
    }
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  close(id) {
    const entry = this.sockets.get(id);
    this.sockets.delete(id);
    this.pending.delete(id);
    if (entry) {
      clearTimeout(entry.lifetime);
      entry.socket.destroy();
    }
    this.send({ type: 'close', id });
  }
  async frame(frame) {
    const { type, id } = frame;
    if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Invalid connection ID');
    if (type === 'close') return this.close(id);
    if (type === 'data') {
      const entry = this.sockets.get(id);
      if (!entry || !this.allowed(entry.host)) return this.close(id);
      if (
        typeof frame.data !== 'string' ||
        frame.data.length > 65536 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)
      )
        return this.close(id);
      const data = Buffer.from(frame.data, 'base64');
      entry.bytes += data.length;
      if (entry.bytes > this.maxBytes || entry.socket.writableLength > 1_000_000)
        return this.close(id);
      entry.socket.write(data);
      return;
    }
    if (type !== 'open' || this.sockets.has(id) || this.pending.has(id)) return this.close(id);
    if (this.sockets.size + this.pending.size >= 32)
      return this.send({ type: 'denied', id, error: 'Too many connections. Try again shortly.' });
    this.pending.add(id);
    try {
      if (![80, 443].includes(frame.port)) throw new Error('Only public web ports are available.');
      const { host } = website(`${frame.port === 443 ? 'https' : 'http'}://${frame.host}/`);
      if (!this.allowed(host)) {
        // Browser telemetry and third-party assets cannot manufacture approval cards.
        // Only an explicit owner or agent website request creates a decision.
        throw new Error(`Add and allow ${host} in Computer → Websites before using it.`);
      }
      const destination = await this.resolve(`${frame.port === 443 ? 'https' : 'http'}://${host}/`);
      if (!this.pending.has(id)) return;
      if (!this.allowed(host)) throw new Error('Website access ended.');
      this.pending.delete(id);
      const socket = this.connect({ host: destination.address, port: frame.port });
      const entry = {
        socket,
        host,
        bytes: 0,
        lifetime: setTimeout(() => this.close(id), 5 * 60 * 1000),
      };
      this.sockets.set(id, entry);
      socket.setTimeout(30000, () => this.close(id));
      socket.once('connect', () => {
        if (this.sockets.get(id) !== entry) return;
        if (!this.allowed(host)) return this.close(id);
        this.send({ type: 'opened', id });
      });
      socket.on('data', (chunk) => {
        if (this.sockets.get(id) !== entry) return;
        entry.bytes += chunk.length;
        if (!this.allowed(host) || entry.bytes > this.maxBytes) return this.close(id);
        for (let offset = 0; offset < chunk.length; offset += 48000)
          this.send({
            type: 'data',
            id,
            data: chunk.subarray(offset, offset + 48000).toString('base64'),
          });
      });
      socket.on('error', () => this.close(id));
      socket.on('end', () => this.close(id));
      socket.on('close', () => {
        if (this.sockets.has(id)) this.close(id);
      });
    } catch (error) {
      this.pending.delete(id);
      this.send({ type: 'denied', id, error: error.message });
    }
  }
  stop({ revoke = true } = {}) {
    if (revoke)
      this.db
        .prepare("UPDATE computer_websites SET status='expired',expires=0 WHERE status='allowed'")
        .run();
    for (const id of this.sockets.keys()) this.close(id);
    this.pending.clear();
    this.ready = false;
    clearInterval(this.expirationTimer);
    // EOF asks the guest process to close its listener before Docker exec exits.
    const child = this.child;
    child?.stdin.end();
    if (child) {
      const timer = setTimeout(() => child.kill(), 2000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
}
