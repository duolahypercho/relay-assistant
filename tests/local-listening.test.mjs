// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import {
  LocalListeningInstallation,
  listeningDownload,
  listeningLibrary,
} from '../server/local-listening-installation.mjs';
import {
  LocalTranscriptionService,
  localWavPCM,
  listeningProcess,
} from '../server/local-transcription.mjs';
import { speechWav } from '../shared/voice-activity.mjs';
import { createApp } from '../server/app.mjs';
import { once } from 'node:events';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const model = Buffer.from('fake-model'),
  zip = Buffer.from('fake-zip'),
  library = Buffer.from('fake-library');
const artifact = {
  version: 'test',
  name: 'Fixture',
  details: 'https://example.invalid',
  modelDetails: 'https://example.invalid',
  libraryBytes: library.length,
  librarySha256: hash(library),
  artifacts: [
    {
      name: 'whisper.zip',
      bytes: zip.length,
      sha256: hash(zip),
      url: 'https://github.com/fixture',
    },
    {
      name: 'model.bin',
      bytes: model.length,
      sha256: hash(model),
      url: 'https://huggingface.co/fixture',
    },
  ],
};
const wav = (seconds = 0.3, rate = 16000) =>
  Buffer.from(
    speechWav(
      [Float32Array.from({ length: Math.floor(rate * seconds) }, (_, i) => Math.sin(i / 20) / 10)],
      rate,
    ),
  );
async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-listening-test-'));
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const installation = new LocalListeningInstallation(store, directory, {
    platform: 'darwin',
    arch: 'arm64',
    release: '25',
    artifact,
    helper: () => Buffer.from('fixture-helper'),
    extract: async () => library,
    fetcher: async (url) => new Response(url.includes('github') ? zip : model),
    ...options,
  });
  const service = new LocalTranscriptionService(installation, { temporaryRoot: directory });
  const voice = new VoiceConnections(store, {
    key: Buffer.alloc(32, 1),
    localTranscription: service,
  });
  installation.voice = voice;
  try {
    await run({ directory, store, installation, service, voice });
  } finally {
    await installation.close();
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const start = (installation, revision = 0) => installation.start({ id: randomUUID(), revision });

test('combined voice setup selects both connections once and retains saved providers', () =>
  fixture(async ({ installation, voice, store }) => {
    voice.systemSpeech = { configured: true };
    voice.update('speech', {
      revision: 0,
      action: 'save',
      baseUrl: 'https://voice.example/v1',
      model: 'saved-model',
      voice: 'saved-voice',
      apiKey: 'secret-to-retain',
    });
    voice.update('speech', { revision: 1, action: 'select', mode: 'off' });
    const input = { id: randomUUID(), revision: 0, speechRevision: 2 };
    installation.start(input);
    assert.throws(() => installation.start({ ...input, speechRevision: 1 }), /different/);
    await installation.pending;
    const data = voice.publicState();
    assert.equal(data.transcription.mode, 'local');
    assert.equal(data.speech.mode, 'system');
    assert.equal(data.transcription.revision, 1);
    assert.equal(data.speech.revision, 3);
    assert.equal(voice.read().speech.saved.apiKey, 'secret-to-retain');
    assert.equal(installation.state.connected, true);
    assert.equal(store.read().messages.length, 0);
    voice.update('speech', { revision: 3, action: 'select', mode: 'off' });
    installation.start(input);
    assert.equal(
      voice.publicState().speech.mode,
      'off',
      'retrying an old request cannot reactivate voice',
    );
    assert.equal(voice.publicState().transcription.revision, 1);
  }));

test('combined setup never partially selects when either revision changes or audio is in use', async () => {
  for (const conflict of ['transcription', 'speech', 'speech-request', 'call']) {
    await fixture(async ({ installation, voice, store }) => {
      voice.systemSpeech = { configured: true };
      installation.start({ id: randomUUID(), revision: 0, speechRevision: 0 });
      if (conflict === 'speech-request') voice.pending.speech++;
      else if (conflict === 'call')
        store.mutate((s) => {
          s.voiceCalls = [{ id: 'test', status: 'active' }];
        });
      else voice.update(conflict, { revision: 0, action: 'select', mode: 'off' });
      await installation.pending;
      assert.equal(installation.ready(), true);
      assert.equal(installation.state.connected, false);
      assert.match(installation.state.error, /neither connection/);
      const data = voice.publicState();
      assert.equal(data.transcription.mode, 'off');
      assert.equal(data.speech.mode, 'off');
      assert.equal(data.transcription.revision, conflict === 'transcription' ? 1 : 0);
      assert.equal(data.speech.revision, conflict === 'speech' ? 1 : 0);
    });
  }
});

test('combined voice setup rejects unsupported, stale and malformed consent before download', () =>
  fixture(async ({ installation, voice }) => {
    voice.systemSpeech = { configured: false };
    const input = { id: randomUUID(), revision: 0, speechRevision: 0 };
    assert.throws(() => installation.start(input), /installed voice/);
    voice.systemSpeech = { configured: true };
    for (const speechRevision of [null, -1, '0', NaN, 1.2])
      assert.throws(() => installation.start({ ...input, speechRevision }), /speaking settings/);
    assert.throws(() => installation.start({ ...input, speechRevision: 1 }), /another window/);
    voice.pending.speech = 1;
    assert.throws(() => installation.start(input), /Finish/);
    assert.equal(installation.state, null);
    assert.equal(installation.pending, null);
  }));

test('combined voice cancellation and interrupted restart never enable either connection', () =>
  fixture(async ({ installation, voice, store, directory }) => {
    voice.systemSpeech = { configured: true };
    let entered;
    installation.fetcher = async (_url, { signal }) =>
      new Promise((_r, reject) => {
        entered = true;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const input = { id: randomUUID(), revision: 0, speechRevision: 0 };
    installation.start(input);
    while (!entered) await new Promise((r) => setTimeout(r, 2));
    await installation.cancel({ id: input.id });
    assert.equal(installation.state.phase, 'cancelled');
    assert.equal(voice.publicState().speech.mode, 'off');
    assert.equal(voice.publicState().transcription.mode, 'off');
    store.secret('local-listening-installation', JSON.stringify({ ...input, phase: 'running' }));
    const reopened = new LocalListeningInstallation(store, directory, {
      platform: 'darwin',
      arch: 'arm64',
      release: '25',
      artifact,
    });
    assert.equal(reopened.state.phase, 'interrupted');
    assert.equal(reopened.state.speechRevision, 0);
    assert.equal(reopened.pending, null);
    await reopened.close();
    assert.equal(voice.publicState().speech.mode, 'off');
  }));

test('local listening installs verified files privately, selects once and persists without touching chats', () =>
  fixture(async ({ installation, directory, store, voice }) => {
    const before = store.read();
    const input = { id: randomUUID(), revision: 0 };
    installation.start(input);
    assert.equal(installation.start(input).installation.id, input.id);
    assert.throws(() => start(installation), /already running/);
    await installation.pending;
    assert.equal(installation.status().installation.phase, 'ready');
    assert.equal(installation.ready(), true);
    assert.equal(voice.publicState().transcription.mode, 'local');
    assert.equal(voice.transcription.inputFormat, 'wav');
    assert.equal(voice.transcription.destination, 'your Relay computer');
    assert.deepEqual(store.read().messages, before.messages);
    assert.deepEqual(store.read().threads, before.threads);
    assert.equal((await stat(installation.paths().model)).mode & 0o777, 0o600);
    assert.equal((await stat(installation.paths().helper)).mode & 0o777, 0o700);
    assert.match(
      await readFile(join(installation.destination, 'Whisper-LICENSE'), 'utf8'),
      /OpenAI/,
    );
    voice.update('transcription', { revision: 1, action: 'select', mode: 'off' });
    installation.start(input);
    assert.equal(
      voice.publicState().transcription.mode,
      'off',
      'old requests cannot reactivate listening',
    );
    start(installation, 2);
    await installation.pending;
    assert.equal(voice.publicState().transcription.mode, 'local');
    assert.deepEqual(await readdir(installation.root), ['test']);
  }));
test('download integrity failures never install or replace existing voice configuration', () =>
  fixture(
    async ({ installation, voice }) => {
      voice.update('transcription', {
        revision: 0,
        action: 'save',
        baseUrl: 'https://example.com/v1',
        model: 'saved',
        apiKey: 'secret',
      });
      start(installation, 1);
      await installation.pending;
      assert.equal(installation.state.phase, 'error');
      assert.equal(installation.ready(), false);
      assert.equal(voice.record('transcription').model, 'saved');
      assert.deepEqual(await readdir(installation.root), []);
    },
    { fetcher: async () => new Response(Buffer.from('changed!')) },
  ));
test('cancel, retry, revision conflicts and settings changed during installation do not overwrite selections', () =>
  fixture(async ({ installation, voice }) => {
    let release;
    const original = installation.fetcher;
    installation.fetcher = async (_url, { signal }) =>
      new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    start(installation);
    while (!release) await new Promise((r) => setTimeout(r, 2));
    await installation.cancel({ id: installation.state.id });
    assert.equal(installation.state.phase, 'cancelled');
    assert.equal(voice.publicState().transcription.mode, 'off');
    assert.deepEqual(await readdir(installation.root), []);
    installation.fetcher = original;
    start(installation);
    voice.update('transcription', { revision: 0, action: 'select', mode: 'off' });
    await installation.pending;
    assert.equal(installation.state.phase, 'ready');
    assert.equal(installation.state.connected, false);
    assert.match(installation.state.error, /settings changed/);
    assert.equal(voice.publicState().transcription.mode, 'off');
    assert.throws(() => start(installation, 0), /another window/);
    voice.update('transcription', { revision: 1, action: 'select', mode: 'local' });
    assert.equal(voice.transcription.configured, true);
  }));
test('restart does not resume installation and unsupported platforms cannot start it', () =>
  fixture(async ({ store, directory }) => {
    store.secret(
      'local-listening-installation',
      JSON.stringify({ id: randomUUID(), phase: 'running', revision: 0 }),
    );
    const stopped = new LocalListeningInstallation(store, directory, {
      platform: 'linux',
      bundle: null,
    });
    assert.equal(stopped.state.phase, 'interrupted');
    assert.equal(stopped.pending, null);
    assert.throws(() => start(stopped), /supported Relay server/);
    await stopped.close();
  }));
test('local listening cannot replace active audio or calls and switching off keeps saved service', () =>
  fixture(async ({ installation, voice, store }) => {
    voice.update('transcription', {
      revision: 0,
      action: 'save',
      baseUrl: 'https://example.com/v1',
      model: 'saved',
      apiKey: 'secret',
    });
    start(installation, 1);
    store.mutate((s) => {
      s.voiceCalls = [{ id: 'test', status: 'active' }];
    });
    await installation.pending;
    assert.equal(voice.publicState().transcription.mode, 'saved');
    assert.throws(
      () => voice.update('transcription', { revision: 1, action: 'select', mode: 'local' }),
      /Finish/,
    );
    store.mutate((s) => {
      s.voiceCalls = [];
    });
    voice.update('transcription', { revision: 1, action: 'select', mode: 'local' });
    voice.update('transcription', { revision: 2, action: 'select', mode: 'off' });
    assert.equal(voice.publicState().transcription.saved.model, 'saved');
    assert.throws(
      () => voice.update('speech', { revision: 0, action: 'select', mode: 'local' }),
      /local listening/,
    );
  }));
test('download redirects reject foreign hosts, credentials, protocols and modified lengths', async () => {
  for (const location of [
    'http://release-assets.githubusercontent.com/file',
    'https://other.invalid/file',
    'https://user:pass@release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com:444/file',
  ]) {
    await assert.rejects(
      listeningDownload(
        async () => new Response(null, { status: 302, headers: { location } }),
        artifact.artifacts[0],
        new AbortController().signal,
      ),
      /Unexpected/,
    );
  }
  await assert.rejects(
    listeningDownload(
      async () => new Response(zip, { headers: { 'Content-Length': '1' } }),
      artifact.artifacts[0],
      new AbortController().signal,
    ),
    /changed/,
  );
  await assert.rejects(listeningLibrary(Buffer.from('not a zip')));
});
test('WAV decoding resamples actual PCM and rejects malformed, excessive, nonfinite and incomplete samples', () => {
  const decoded = localWavPCM(wav(0.5, 48000));
  assert.equal(decoded.length, 8000 * 4);
  assert.ok(decoded.some((b) => b !== 0));
  for (const input of [Buffer.alloc(44), wav().subarray(0, 100), wav(0.01), wav(121)])
    assert.throws(() => localWavPCM(input));
  const unsupported = wav();
  unsupported.writeUInt16LE(3, 22);
  assert.throws(() => localWavPCM(unsupported), /mono or stereo/);
  const bad = wav();
  bad.writeUInt32LE(0xffffffff, 40);
  assert.throws(() => localWavPCM(bad), /incomplete/);
  const float = wav();
  float.writeUInt16LE(3, 20);
  float.writeUInt16LE(32, 34);
  float.writeUInt16LE(4, 32);
  float.writeFloatLE(NaN, 44);
  assert.throws(() => localWavPCM(float), /invalid audio/);
});
test('transcription private audio is cleaned after success, failure, cancellation and timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-listening-audio-'));
  const installation = {
    ready: () => true,
    paths: () => ({ helper: 'test', library: 'test-library', model: 'test-model' }),
  };
  let path;
  const service = new LocalTranscriptionService(installation, {
    temporaryRoot: directory,
    runner: async (_exe, args) => {
      path = args[2];
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      return Buffer.from(' Heard the original speech. ');
    },
  });
  try {
    assert.deepEqual(await service.transcribe(wav(), 'audio/wav'), {
      text: 'Heard the original speech.',
    });
    assert.deepEqual(await readdir(directory), []);
    service.runner = async () => {
      throw Error('private runtime path /secret');
    };
    await assert.rejects(
      service.transcribe(wav(), 'audio/wav'),
      (e) => e.status === 502 && !e.message.includes('/secret'),
    );
    assert.deepEqual(await readdir(directory), []);
    service.runner = (_exe, _args, { signal }) =>
      new Promise((_resolve, reject) => {
        // Match the real runner when cancellation wins the preceding file write.
        signal.throwIfAborted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const controller = new AbortController();
    const pending = service.transcribe(wav(), 'audio/wav', controller.signal);
    await assert.rejects(service.transcribe(wav(), 'audio/wav'), (e) => e.status === 429);
    const reject = assert.rejects(pending, (e) => e.status === 499);
    controller.abort();
    await reject;
    assert.deepEqual(await readdir(directory), []);
    service.timeout = 20;
    const keepAlive = setInterval(() => {}, 5);
    try {
      await assert.rejects(service.transcribe(wav(), 'audio/wav'), (e) => e.status === 504);
    } finally {
      clearInterval(keepAlive);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('local process runner bounds output, waits for cancellation and redacts child errors', async () => {
  await assert.rejects(
    listeningProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024))'], {
      signal: new AbortController().signal,
      limit: 50,
    }),
    (e) => e.status === 413,
  );
  await assert.rejects(
    listeningProcess(process.execPath, ['-e', 'process.stderr.write("secret");process.exit(1)'], {
      signal: new AbortController().signal,
      limit: 50,
    }),
    (e) => !e.message.includes('secret'),
  );
  const c = new AbortController(),
    p = listeningProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
      signal: c.signal,
      limit: 50,
    });
  const rejection = assert.rejects(p, (e) => e.name === 'AbortError');
  c.abort();
  await rejection;
});
test('listening setup APIs require the owner and same-origin writes, expose runtime readiness only after install', () =>
  fixture(async ({ installation, voice, store }) => {
    const services = {
      provider: {},
      google: {},
      browser: {},
      terminal: {},
      voiceConnections: voice,
      transcription: voice.transcription,
      localListeningInstallation: installation,
    };
    const server = createApp(store, services, {
      host: '127.0.0.1',
      port: 0,
      accessKey: 'test-owner-key',
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal((await fetch(url + '/api/voice-connections/local')).status, 401);
      const login = await fetch(url + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test-owner-key' }),
      });
      const headers = {
        Cookie: login.headers.get('set-cookie').split(';')[0],
        'Content-Type': 'application/json',
      };
      const body = JSON.stringify({ id: randomUUID(), revision: 0 });
      assert.equal(
        (
          await fetch(url + '/api/voice-connections/local/start', {
            method: 'POST',
            headers: { ...headers, Origin: 'https://outsider.invalid' },
            body,
          })
        ).status,
        403,
      );
      const response = await fetch(url + '/api/voice-connections/local/start', {
        method: 'POST',
        headers,
        body,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await installation.pending;
      const state = await (await fetch(url + '/api/state', { headers })).json();
      assert.equal(state.connections.runtime.transcription.inputFormat, 'wav');
      assert.equal(state.connections.runtime.transcription.configured, true);
      assert.equal(store.read().messages.length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }));

test('Linux bundled recognition downloads only the model and restores an explicit local selection', () => {
  const helper = Buffer.from('fixture-static-helper');
  const embedded = {
    ...artifact,
    embedded: true,
    version: 'test-linux-helper',
    helperBytes: helper.length,
    helperSha256: hash(helper),
    artifacts: [artifact.artifacts[1]],
  };
  const options = {
    platform: 'linux',
    arch: 'arm64',
    artifact: embedded,
    helper: () => helper,
    bundle: { artifact: embedded, helper: () => helper },
  };
  return fixture(async ({ installation, store, directory, voice }) => {
    let downloads = 0;
    installation.fetcher = async (url) => {
      assert.equal(url, artifact.artifacts[1].url);
      downloads++;
      return new Response(model);
    };
    installation.extract = () => {
      throw Error('Linux must not download or extract a Mac framework');
    };
    assert.equal(installation.status().supported, true);
    assert.equal(installation.status().bytes, model.length);
    start(installation);
    await installation.pending;
    assert.equal(installation.state.phase, 'ready');
    assert.equal(installation.ready(), true);
    assert.equal(installation.paths().library, '--builtin');
    assert.equal(downloads, 1);
    assert.equal(voice.publicState().transcription.mode, 'local');
    const files = await readdir(installation.destination);
    assert.ok(!files.includes('whisper') && !files.includes('whisper.zip'));
    const reopened = new LocalListeningInstallation(store, directory, options);
    assert.equal(reopened.ready(), true);
    await reopened.close();
    voice.update('transcription', { revision: 1, action: 'select', mode: 'off' });
    start(installation, 2);
    await installation.pending;
    assert.equal(downloads, 1);
    assert.equal(voice.publicState().transcription.mode, 'local');
  }, options);
});
test('a changed bundled Linux helper cannot be installed or activated', () => {
  const helper = Buffer.from('fixture-static-helper');
  const embedded = {
    ...artifact,
    embedded: true,
    version: 'test-linux-bad-helper',
    helperBytes: helper.length,
    helperSha256: hash(helper),
    artifacts: [artifact.artifacts[1]],
  };
  return fixture(
    async ({ installation, directory, voice }) => {
      start(installation);
      await installation.pending;
      assert.equal(installation.state.phase, 'error');
      assert.equal(installation.ready(), false);
      assert.equal(voice.publicState().transcription.mode, 'off');
      assert.deepEqual(await readdir(join(directory, 'runtimes/listening')), []);
    },
    {
      platform: 'linux',
      arch: 'arm64',
      artifact: embedded,
      helper: () => Buffer.from('changed-static-helper'),
      bundle: {},
    },
  );
});
