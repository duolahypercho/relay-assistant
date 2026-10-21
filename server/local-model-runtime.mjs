// SPDX-License-Identifier: MIT
// Owner-only startup for an installed Ollama. No model tool can launch host programs.
import { fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const origin = 'http://127.0.0.1:11434';

export async function installedOllama(platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) return null;
  const paths =
    platform === 'darwin'
      ? [
          '/Applications/Ollama.app/Contents/Resources/ollama',
          '/opt/homebrew/bin/ollama',
          '/usr/local/bin/ollama',
        ]
      : ['/usr/local/bin/ollama', '/usr/bin/ollama'];
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}
export async function ollamaProbe(signal, { connect = createConnection, fetcher = fetch } = {}) {
  signal?.throwIfAborted();
  const occupied = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 11434 });
    const finish = (value) => {
      socket.destroy();
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => finish(true);
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(800, () => finish(true));
    signal?.addEventListener('abort', cancel, { once: true });
  });
  signal?.throwIfAborted();
  if (!occupied) return { running: false, occupied: false };
  try {
    const response = await fetcher(origin + '/api/version', {
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]),
    });
    const reader = response.body.getReader();
    let bytes = 0,
      text = '';
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > 4096) throw Error('Too large');
        text += Buffer.from(item.value).toString();
      }
      const data = JSON.parse(text);
      if (response.ok && typeof data.version === 'string' && /^[\w.+-]{1,80}$/.test(data.version))
        return { running: true, occupied: true };
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    signal?.throwIfAborted();
  }
  return { running: false, occupied: true };
}

export function supervisedOllama(executable, environment) {
  const supervisor = fork(
    fileURLToPath(new URL('./local-model-supervisor.mjs', import.meta.url)),
    [],
    {
      execPath: process.execPath,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  let ended = false,
    pid;
  const done = new Promise((resolve) => {
    supervisor.once('error', () => {
      ended = true;
      resolve();
    });
    supervisor.once('exit', () => {
      ended = true;
      resolve();
    });
  });
  supervisor.on('message', (value) => {
    if (Number.isSafeInteger(value?.started)) pid = value.started;
  });
  supervisor.send({ executable, environment });
  return {
    get ended() {
      return ended;
    },
    done,
    async close() {
      if (!ended && supervisor.connected) supervisor.disconnect();
      const timeout = setTimeout(() => {
        // Only these still-owned children are targeted; never kill a service found on a port.
        if (pid && !ended) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {}
        }
        if (!ended) supervisor.kill('SIGKILL');
      }, 3500);
      try {
        await done;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export class LocalModelRuntime {
  constructor(
    store,
    {
      platform = process.platform,
      locate = () => installedOllama(platform),
      probe = ollamaProbe,
      launch = supervisedOllama,
      environment = process.env,
      timeout = 60000,
    } = {},
  ) {
    this.store = store;
    this.locate = locate;
    this.probe = probe;
    this.launch = launch;
    this.environment = environment;
    this.timeout = timeout;
    this.allowed = ['darwin', 'linux'].includes(platform);
    this.phase = 'idle';
    this.error = '';
    this.pending = null;
    this.owned = null;
    this.closed = false;
  }
  preference() {
    const saved = this.store.secret('local-model-runtime');
    if (!saved) return { revision: 0, startWithRelay: false };
    try {
      const value = JSON.parse(saved);
      if (
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        typeof value.startWithRelay !== 'boolean'
      )
        throw Error();
      return value;
    } catch {
      throw fail('Local model startup settings could not be read.', 503);
    }
  }
  save(input) {
    const previous = this.preference();
    if (input?.revision !== previous.revision)
      throw fail('Local model settings changed. Check again before saving.');
    if (typeof input?.startWithRelay !== 'boolean')
      throw fail('Choose whether Ollama starts with Relay.', 400);
    const value = { revision: previous.revision + 1, startWithRelay: input.startWithRelay };
    this.store.secret('local-model-runtime', JSON.stringify(value));
    return value;
  }
  async status(signal) {
    const [executable, state] = await Promise.all([
      this.allowed ? this.locate() : null,
      this.probe(signal),
    ]);
    return {
      ...this.preference(),
      available: this.allowed,
      installed: !!executable,
      running: state.running,
      managed: !!this.owned && !this.owned.ended,
      canStart:
        this.allowed &&
        !!executable &&
        !state.occupied &&
        !this.owned &&
        !this.pending &&
        !this.closed,
      occupied: state.occupied,
      busy: !!this.pending,
      phase: this.phase,
      error: this.error,
    };
  }
  async start(input, signal, restoring = false) {
    if (!this.allowed || this.closed)
      throw fail('Start Ollama on the computer running Relay.', 503);
    if (this.pending) throw fail('Ollama is already starting. Wait for it to finish.');
    if (this.owned && !this.owned.ended)
      throw fail('Relay’s Ollama is still running. Check again, or quit and reopen Relay.');
    if (
      input?.revision !== this.preference().revision ||
      typeof input?.startWithRelay !== 'boolean'
    )
      throw fail('Local model settings changed. Check again before starting.');
    this.controller = new AbortController();
    const combined = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(this.timeout),
      ...(signal ? [signal] : []),
    ]);
    this.phase = 'starting';
    this.error = '';
    this.pending = this.wake(input, combined, restoring);
    try {
      await this.pending;
    } catch (error) {
      this.phase = signal?.aborted || this.controller.signal.aborted ? 'idle' : 'error';
      this.error =
        this.phase === 'idle'
          ? ''
          : error.status
            ? error.message
            : combined.aborted
              ? 'Ollama took too long to start. Try starting it again.'
              : 'Ollama could not start. Open it on the Relay computer, then check again.';
      signal?.throwIfAborted();
      throw fail(this.error || 'Ollama startup was cancelled.', error.status || 503);
    } finally {
      this.pending = null;
    }
    return this.status(signal);
  }
  async wake(input, signal, restoring) {
    const state = await this.probe(signal);
    if (state.running) {
      this.phase = 'ready';
      return;
    }
    if (state.occupied)
      throw fail(
        'Another service is using Ollama’s local port. Open Ollama on the Relay computer, then check again.',
      );
    const executable = await this.locate();
    signal.throwIfAborted();
    if (!executable) throw fail('Install Ollama on the Relay computer, then check again.', 503);
    const environment = Object.fromEntries(
      ['HOME', 'PATH', 'TMPDIR', 'LANG', 'OLLAMA_MODELS']
        .filter((k) => typeof this.environment[k] === 'string')
        .map((k) => [k, this.environment[k]]),
    );
    Object.assign(environment, {
      OLLAMA_HOST: '127.0.0.1:11434',
      OLLAMA_NO_CLOUD: '1',
      OLLAMA_NOPRUNE: '1',
    });
    const child = this.launch(executable, environment);
    try {
      for (;;) {
        signal.throwIfAborted();
        if (child.ended)
          throw fail(
            'Ollama stopped before it was ready. Open it on the Relay computer, then check again.',
            503,
          );
        if ((await this.probe(signal)).running) break;
        await delay(150, undefined, { signal });
      }
      signal.throwIfAborted();
      if (child.ended) throw fail('Ollama could not stay running. Try again.', 503);
      if (!restoring) this.save(input);
      this.owned = child;
      this.phase = 'ready';
      void child.done.then(() => {
        if (this.owned !== child) return;
        this.owned = null;
        if (!this.closed) {
          this.phase = 'error';
          this.error = 'Ollama stopped. Start it again when you’re ready.';
        }
      });
    } catch (error) {
      await child.close();
      throw error;
    }
  }
  async update(input) {
    if (this.pending || this.closed) throw fail('Wait for Ollama startup to finish.');
    if (input?.startWithRelay && (!this.allowed || !(await this.locate())))
      throw fail('Install Ollama on the Relay computer first.');
    this.save(input);
    return this.status();
  }
  async restore() {
    const input = this.preference();
    if (input.startWithRelay) await this.start(input, undefined, true);
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending?.catch(() => {});
    const child = this.owned;
    this.owned = null;
    await child?.close();
  }
}
