// SPDX-License-Identifier: MIT
// Owner-requested, pinned runtime installation. No shell, sudo or model-accessible endpoint.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { release } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const exec = promisify(execFile);
const key = 'local-model-installation';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export const ollamaRelease = Object.freeze({
  version: '0.40.3',
  bytes: 167455486,
  sha256: 'a2d1d906a2c8febd9cb18f5c183854d0a6db5dc522940d68b0c0ed048e8dfdea',
  url: 'https://github.com/ollama/ollama/releases/download/v0.40.3/ollama-darwin.tgz',
  details: 'https://github.com/ollama/ollama/releases/tag/v0.40.3',
});

export async function downloadOllama(fetcher, artifact, signal) {
  let url = new URL(artifact.url);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('location') || '', url);
      if (
        next.protocol !== 'https:' ||
        next.hostname !== 'release-assets.githubusercontent.com' ||
        next.port ||
        next.username ||
        next.password
      )
        throw Error('Unexpected release redirect');
      url = next;
      continue;
    }
    if (
      !response.ok ||
      !response.body ||
      (response.headers.has('content-length') &&
        Number(response.headers.get('content-length')) !== artifact.bytes)
    ) {
      await response.body?.cancel();
      throw Error('Release unavailable or changed');
    }
    return response;
  }
  throw Error('Too many release redirects');
}

export async function unpackOllama(archive, destination, signal) {
  // Only called after the exact published archive digest passes. Native tar is fixed,
  // with no environment options, owner changes or client-supplied arguments.
  const options = {
    signal,
    timeout: 60000,
    maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  };
  const { stdout } = await exec('/usr/bin/tar', ['-tzf', archive], options);
  const entries = stdout.trim().split('\n');
  if (
    !entries.includes('ollama') ||
    entries.length > 200 ||
    entries.some(
      (name) =>
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\/?$/.test(name) || name.split('/').includes('..'),
    )
  )
    throw Error('Unexpected archive contents');
  await exec(
    '/usr/bin/tar',
    ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'],
    options,
  );
  const root = await realpath(destination);
  let bytes = 0,
    count = 0;
  const inspect = async (directory) => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name),
        stat = await lstat(path);
      if (++count > 200) throw Error('Too many runtime files');
      if (stat.isSymbolicLink()) {
        if (!(await realpath(path)).startsWith(root + sep)) throw Error('External runtime link');
      } else if (stat.isDirectory()) await inspect(path);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 600 * 1024 * 1024 || stat.mode & 0o6000)
          throw Error('Unexpected runtime size or permissions');
      } else throw Error('Unexpected runtime file');
    }
  };
  await inspect(destination);
  const executable = join(destination, 'ollama');
  if (!(await lstat(executable)).isFile()) throw Error('No regular runtime executable');
  await access(executable, constants.X_OK);
}

export class LocalModelInstallation {
  constructor(
    store,
    directory,
    {
      platform = process.platform,
      arch = process.arch,
      osRelease = release(),
      artifact = ollamaRelease,
      fetcher = fetch,
      unpack = unpackOllama,
      timeout = 15 * 60 * 1000,
      stall = 120000,
    } = {},
  ) {
    Object.assign(this, { store, artifact, fetcher, unpack, timeout, stall });
    this.root = resolve(directory, 'runtimes', 'ollama');
    this.destination = join(this.root, 'v' + artifact.version);
    this.supported =
      platform === 'darwin' &&
      ['arm64', 'x64'].includes(arch) &&
      Number(osRelease.split('.')[0]) >= 23;
    this.pending = null;
    this.closed = false;
    this.state = null;
    const saved = store.secret(key);
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (
          !uuid.test(state.id) ||
          !['running', 'ready', 'cancelled', 'error', 'interrupted'].includes(state.phase)
        )
          throw Error();
        const phase = ['running', 'interrupted'].includes(state.phase)
          ? 'interrupted'
          : state.phase;
        this.state = {
          id: state.id,
          phase,
          completed: 0,
          stage: '',
          error:
            phase === 'interrupted'
              ? 'Installation interrupted. Try again when you’re ready.'
              : phase === 'error'
                ? 'Ollama was not installed. Try again.'
                : '',
        };
        this.persist();
      } catch {
        throw fail('Local installation status could not be read.', 503);
      }
    }
  }
  persist() {
    this.store.secret(key, JSON.stringify(this.state));
  }
  status() {
    return {
      supported: this.supported,
      version: this.artifact.version,
      bytes: this.artifact.bytes,
      details: this.artifact.details,
      installation: this.state && { ...this.state },
    };
  }
  async executable() {
    if (!this.supported) return null;
    try {
      for (const path of [this.root, this.destination])
        if (!(await lstat(path)).isDirectory()) return null;
      const marker = join(this.destination, 'relay-install.json');
      if (!(await lstat(marker)).isFile()) return null;
      const receipt = JSON.parse(await readFile(marker, 'utf8'));
      if (receipt.version !== this.artifact.version || receipt.sha256 !== this.artifact.sha256)
        return null;
      const path = join(this.destination, 'ollama');
      if (!(await lstat(path)).isFile()) return null;
      await access(path, constants.X_OK);
      return path;
    } catch {
      return null;
    }
  }
  start(input) {
    if (!this.supported || this.closed)
      throw fail('In-app installation needs macOS 14 or later on the Relay computer.', 503);
    const id = input?.id || randomUUID();
    if (typeof id !== 'string' || !uuid.test(id))
      throw fail('Choose a new installation request.', 400);
    if (this.state?.id === id) return this.status();
    if (this.pending) throw fail('Wait for the current installation, or cancel it first.');
    const previous = this.state?.id;
    this.controller = new AbortController();
    this.state = {
      id,
      phase: 'running',
      stage: 'Preparing installation…',
      completed: 0,
      error: '',
    };
    this.persist();
    this.pending = this.run(id, previous, this.controller.signal).finally(() => {
      this.pending = null;
    });
    return this.status();
  }
  async run(id, previous, ownerSignal) {
    const stalled = new AbortController();
    const signal = AbortSignal.any([
      ownerSignal,
      stalled.signal,
      AbortSignal.timeout(this.timeout),
    ]);
    let stage, timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), this.stall);
    };
    try {
      reset();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.root)).isDirectory()) throw Error('Runtime directory is not private');
      signal.throwIfAborted();
      if (!(await this.executable())) {
        if (previous)
          await rm(join(this.root, '.install-' + previous), { recursive: true, force: true });
        const staging = join(this.root, '.install-' + id);
        await mkdir(staging, { mode: 0o700 });
        stage = staging;
        const archive = join(stage, 'release.tgz'),
          files = join(stage, 'files');
        await mkdir(files, { mode: 0o700 });
        this.state.stage = 'Downloading Ollama…';
        const response = await downloadOllama(this.fetcher, this.artifact, signal);
        const hash = createHash('sha256');
        const meter = new Transform({
          transform: (chunk, _encoding, callback) => {
            this.state.completed += chunk.length;
            reset();
            if (this.state.completed > this.artifact.bytes)
              return callback(Error('Release too large'));
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          meter,
          createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
          { signal },
        );
        if (
          this.state.completed !== this.artifact.bytes ||
          hash.digest('hex') !== this.artifact.sha256
        )
          throw fail('The download could not be verified. Nothing was installed. Try again.', 503);
        this.state.stage = 'Installing Ollama…';
        await this.unpack(archive, files, signal);
        signal.throwIfAborted();
        await writeFile(
          join(files, 'relay-install.json'),
          JSON.stringify({ version: this.artifact.version, sha256: this.artifact.sha256 }),
          { flag: 'wx', mode: 0o600 },
        );
        // Never replace any existing runtime directory, including an incomplete one.
        try {
          await lstat(this.destination);
          throw fail(
            'A previous Ollama installation needs attention in the Relay data folder.',
            503,
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        signal.throwIfAborted();
        await rename(files, this.destination);
      }
      this.state = {
        ...this.state,
        phase: 'ready',
        stage: 'Ollama installed',
        completed: this.artifact.bytes,
      };
    } catch (error) {
      const phase = ownerSignal.aborted ? (this.closed ? 'interrupted' : 'cancelled') : 'error';
      this.state = {
        ...this.state,
        phase,
        stage: '',
        completed: 0,
        error:
          phase === 'error'
            ? error.status
              ? error.message
              : 'Ollama could not be installed. Check your connection and free disk space, then try again.'
            : phase === 'interrupted'
              ? 'Installation interrupted. Try again when you’re ready.'
              : '',
      };
    } finally {
      clearTimeout(timer);
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
      this.persist();
    }
  }
  async cancel(input) {
    if (!this.state || input?.id !== this.state.id)
      throw fail('This installation changed. Check its current status.');
    if (this.pending) {
      this.controller.abort();
      await this.pending;
    }
    return this.status();
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
  }
}
