// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { listeningRelease } from './local-listening-artifacts.mjs';
import { linuxListeningBundle } from './local-listening-bundle.mjs';
const key = 'local-listening-installation';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const helperURL = new URL('../native/audio/relay-transcribe-macos', import.meta.url);

export async function listeningDownload(fetcher, artifact, signal) {
  let url = new URL(artifact.url);
  for (let i = 0; i < 6; i++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const target = new URL(response.headers.get('location') || '', url);
      const hosts =
        artifact.name === 'whisper.zip'
          ? ['release-assets.githubusercontent.com']
          : [
              'huggingface.co',
              'cas-bridge.xethub.hf.co',
              'cdn-lfs.huggingface.co',
              'cdn-lfs-us-1.huggingface.co',
              'cdn-lfs.hf.co',
              'us.aws.cdn.hf.co',
            ];
      if (
        target.protocol !== 'https:' ||
        target.port ||
        target.username ||
        target.password ||
        !hosts.includes(target.hostname)
      )
        throw Error('Unexpected listening download destination');
      url = target;
      continue;
    }
    if (
      !response.ok ||
      !response.body ||
      (response.headers.has('content-length') &&
        Number(response.headers.get('content-length')) !== artifact.bytes)
    ) {
      await response.body?.cancel();
      throw Error('Listening download unavailable or changed');
    }
    return response;
  }
  throw Error('Too many listening download redirects');
}

export async function listeningLibrary(bytes, artifact = listeningRelease) {
  const zip = await yauzl.fromBufferPromise(bytes, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  let result;
  try {
    if (zip.entryCount > 500) throw Error('Unexpected framework archive');
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== artifact.libraryEntry) continue;
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (
        result ||
        ![0, 0o100000].includes(type) ||
        entry.generalPurposeBitFlag & 1 ||
        entry.uncompressedSize !== artifact.libraryBytes
      )
        throw Error('Unexpected framework library');
      const stream = await zip.openReadStreamPromise(entry),
        chunks = [];
      let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > artifact.libraryBytes) {
          stream.destroy();
          throw Error('Library too large');
        }
        chunks.push(chunk);
      }
      result = Buffer.concat(chunks);
    }
    if (
      !result ||
      result.length !== artifact.libraryBytes ||
      hash(result) !== artifact.librarySha256
    )
      throw Error('Framework library integrity check failed');
    return result;
  } finally {
    zip.close();
  }
}

export class LocalListeningInstallation {
  constructor(
    store,
    directory,
    {
      platform = process.platform,
      arch = process.arch,
      release = osRelease(),
      artifact,
      fetcher = fetch,
      helper,
      bundle = platform === 'linux' ? linuxListeningBundle({ arch }) : null,
      extract = listeningLibrary,
      timeout = 900000,
      stall = 120000,
    } = {},
  ) {
    artifact ||= bundle?.artifact || listeningRelease;
    helper ||= bundle?.helper || (() => readFileSync(helperURL));
    Object.assign(this, { store, artifact, fetcher, helper, extract, timeout, stall });
    this.embedded = artifact.embedded === true;
    this.modelArtifact = artifact.artifacts.find((a) => a.name === 'model.bin');
    this.supported =
      (platform === 'darwin' && ['arm64', 'x64'].includes(arch) && parseInt(release) >= 23) ||
      (platform === 'linux' && ['arm64', 'x64'].includes(arch) && !!bundle && this.embedded);
    this.root = join(directory, 'runtimes', 'listening');
    this.destination = join(this.root, artifact.version);
    this.pending = null;
    this.closed = false;
    this.voice = null;
    this.state = JSON.parse(store.secret(key) || 'null');
    if (this.state?.phase === 'running') {
      this.state = {
        ...this.state,
        phase: 'interrupted',
        error: 'Listening setup was interrupted. Continue when you’re ready.',
      };
      this.persist();
    }
  }
  persist() {
    this.store.secret(key, JSON.stringify(this.state));
  }
  paths() {
    return {
      helper: join(this.destination, 'transcribe'),
      library: this.embedded ? '--builtin' : join(this.destination, 'whisper'),
      model: join(this.destination, 'model.bin'),
    };
  }
  ready() {
    if (!this.supported) return false;
    try {
      if (!lstatSync(this.root).isDirectory() || !lstatSync(this.destination).isDirectory())
        return false;
      const receiptPath = join(this.destination, 'receipt.json');
      if (!lstatSync(receiptPath).isFile()) return false;
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (
        receipt.version !== this.artifact.version ||
        receipt.model !== this.modelArtifact.sha256 ||
        receipt.library !== (this.embedded ? 'builtin' : this.artifact.librarySha256) ||
        receipt.helper !== hash(this.helper())
      )
        return false;
      const paths = this.paths();
      return (
        [paths.helper, paths.model, ...(this.embedded ? [] : [paths.library])].every((p) =>
          lstatSync(p).isFile(),
        ) &&
        lstatSync(paths.model).size === this.modelArtifact.bytes &&
        (this.embedded || lstatSync(paths.library).size === this.artifact.libraryBytes) &&
        !!(lstatSync(paths.helper).mode & 0o100)
      );
    } catch {
      return false;
    }
  }
  status() {
    return {
      supported: this.supported,
      installed: this.ready(),
      name: this.artifact.name,
      bytes: this.artifact.artifacts.reduce((n, a) => n + a.bytes, 0),
      details: this.artifact.details,
      modelDetails: this.artifact.modelDetails,
      installation: this.state && { ...this.state },
    };
  }
  start(input) {
    if (!this.supported || this.closed)
      throw fail(
        'Local listening needs a supported Relay server with its recognition helper installed.',
        503,
      );
    if (!uuid.test(input?.id || '') || !Number.isSafeInteger(input?.revision) || input.revision < 0)
      throw fail('Review your listening settings before starting setup.', 400);
    if (
      input.speechRevision !== undefined &&
      (!Number.isSafeInteger(input.speechRevision) || input.speechRevision < 0)
    )
      throw fail('Review your speaking settings before starting setup.', 400);
    if (this.state?.id === input.id) {
      if (
        this.state.revision !== input.revision ||
        this.state.speechRevision !== input.speechRevision
      )
        throw fail('This setup request has different listening settings.');
      return this.status();
    }
    if (this.pending) throw fail('Listening setup is already running. Wait or cancel it first.');
    this.voice?.fresh('transcription', input);
    if (input.speechRevision !== undefined) {
      if (!this.voice) throw fail('Voice setup is unavailable on this server.', 503);
      this.voice.checkLocalVoice(input);
    }
    const previous = this.state?.id;
    this.state = {
      id: input.id,
      revision: input.revision,
      ...(input.speechRevision !== undefined ? { speechRevision: input.speechRevision } : {}),
      phase: 'running',
      stage: 'Preparing local listening…',
      completed: 0,
      total: 0,
      error: '',
      connected: false,
    };
    this.persist();
    this.controller = new AbortController();
    this.pending = this.run(previous, this.controller.signal).finally(() => {
      this.pending = null;
    });
    return this.status();
  }
  async run(previous, ownerSignal) {
    const stalled = new AbortController(),
      signal = AbortSignal.any([ownerSignal, stalled.signal, AbortSignal.timeout(this.timeout)]);
    let stage, timer;
    const heartbeat = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), this.stall);
    };
    try {
      if (!this.ready()) {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if (!(await lstat(this.root)).isDirectory()) throw Error('Invalid runtime root');
        if (previous && uuid.test(previous))
          await rm(join(this.root, '.install-' + previous), { recursive: true, force: true });
        stage = join(this.root, '.install-' + this.state.id);
        await mkdir(stage, { mode: 0o700 });
        for (const artifact of this.artifact.artifacts) {
          signal.throwIfAborted();
          heartbeat();
          this.state.stage =
            artifact.name === 'whisper.zip'
              ? 'Downloading speech recognition…'
              : 'Downloading the listening model…';
          this.state.completed = 0;
          this.state.total = artifact.bytes;
          this.persist();
          const digest = createHash('sha256');
          const response = await listeningDownload(this.fetcher, artifact, signal);
          const progress = new Transform({
            transform: (chunk, _encoding, callback) => {
              this.state.completed += chunk.length;
              if (this.state.completed > artifact.bytes)
                return callback(Error('Oversized listening download'));
              digest.update(chunk);
              heartbeat();
              callback(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(response.body),
            progress,
            createWriteStream(join(stage, artifact.name), { flags: 'wx', mode: 0o600 }),
            { signal },
          );
          if (this.state.completed !== artifact.bytes || digest.digest('hex') !== artifact.sha256)
            throw Error('Listening download verification failed');
        }
        clearTimeout(timer);
        signal.throwIfAborted();
        this.state.stage = 'Finishing listening setup…';
        this.persist();
        const library = this.embedded
          ? null
          : await this.extract(await readFile(join(stage, 'whisper.zip')), this.artifact);
        signal.throwIfAborted();
        const helper = this.helper();
        if (
          this.embedded &&
          (helper.length !== this.artifact.helperBytes ||
            hash(helper) !== this.artifact.helperSha256)
        )
          throw Error('Bundled recognition helper integrity check failed');
        if (library) await writeFile(join(stage, 'whisper'), library, { flag: 'wx', mode: 0o600 });
        await writeFile(join(stage, 'transcribe'), helper, { flag: 'wx', mode: 0o700 });
        await writeFile(
          join(stage, 'receipt.json'),
          JSON.stringify({
            version: this.artifact.version,
            model: this.modelArtifact.sha256,
            library: library ? hash(library) : 'builtin',
            helper: hash(helper),
          }),
          { flag: 'wx', mode: 0o600 },
        );
        for (const name of ['whisper.cpp-LICENSE', 'Whisper-LICENSE']) {
          const notice = await readFile(
            new URL('../third-party-licenses/optional-listening/' + name, import.meta.url),
          );
          await writeFile(join(stage, name), notice, { flag: 'wx', mode: 0o600 });
        }
        if (!this.embedded) await rm(join(stage, 'whisper.zip'));
        signal.throwIfAborted();
        // Existing or unexpected destinations are not overwritten.
        try {
          await lstat(this.destination);
          throw fail(
            'The local listening folder already exists. Check your Relay data folder before retrying.',
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await rename(stage, this.destination);
        stage = null;
      }
      signal.throwIfAborted();
      this.state.phase = 'ready';
      this.state.stage = 'Local listening is ready.';
      if (this.voice) {
        try {
          if (this.state.speechRevision !== undefined) {
            this.voice.selectLocalVoice(this.state);
            this.state.stage = 'Voice is ready.';
          } else {
            this.voice.update('transcription', {
              revision: this.state.revision,
              action: 'select',
              mode: 'local',
            });
          }
          this.state.connected = true;
        } catch {
          this.state.error =
            this.state.speechRevision !== undefined
              ? 'Listening is installed. Your voice settings changed or are in use, so neither connection was switched. Review Voice options or choose Use local voice when you’re ready.'
              : 'Listening is installed. Your voice settings changed or are in use; choose Use local listening when you’re ready.';
        }
      }
    } catch (error) {
      this.state.phase = ownerSignal.aborted
        ? this.closed
          ? 'interrupted'
          : 'cancelled'
        : 'error';
      this.state.stage = '';
      this.state.completed = 0;
      this.state.error =
        this.state.phase === 'error'
          ? error.status
            ? error.message
            : 'Local listening could not be installed. Check your connection and free space, then try again.'
          : '';
    } finally {
      clearTimeout(timer);
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
      this.persist();
    }
  }
  async cancel(input) {
    if (input?.id !== this.state?.id)
      throw fail('Listening setup changed. Check its current progress.');
    this.controller?.abort();
    await this.pending;
    return this.status();
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
  }
}
