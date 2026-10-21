import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SystemSpeechService, systemSpeechProcess } from '../server/system-speech.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { audioFixture } from '../scripts/audio-fixture.mjs';
const audio = audioFixture(0.3);
const supported = { platform: 'darwin', exists: () => true };
const manager = (store, systemSpeech) =>
  new VoiceConnections(store, { key: Buffer.alloc(32, 1), systemSpeech });

test('system voice is explicit, speech-only, portable, revision-checked and keeps a saved provider connection', async () => {
  const store = new Store(':memory:', { sample: false });
  const service = new SystemSpeechService({
    ...supported,
    runner: ({ file }) => writeFile(file, audio),
  });
  try {
    const v = manager(store, service);
    assert.equal(v.speech.configured, false);
    assert.equal(v.publicState().speech.system.available, true);
    assert.throws(
      () => v.update('transcription', { revision: 0, action: 'select', mode: 'system' }),
      /unavailable/,
    );
    v.update('speech', {
      revision: 0,
      action: 'save',
      baseUrl: 'https://voice.example/v1',
      model: 'tts',
      voice: 'calm',
      apiKey: 'keep-private-key',
    });
    v.update('speech', { revision: 1, action: 'select', mode: 'system' });
    assert.equal(v.speech.configured, true);
    assert.equal(v.record('speech').source, 'system');
    assert.equal(v.read().speech.saved.apiKey, 'keep-private-key');
    assert(!JSON.stringify(v.publicState()).includes('keep-private-key'));
    assert.throws(
      () => v.update('speech', { revision: 1, action: 'select', mode: 'off' }),
      /another window/,
    );
    const moved = manager(store, new SystemSpeechService({ platform: 'linux' }));
    assert.equal(moved.speech.configured, false);
    assert.equal(moved.publicState().speech.mode, 'system');
    assert.throws(
      () => moved.update('speech', { revision: 2, action: 'select', mode: 'system' }),
      /unavailable/,
    );
    v.update('speech', { revision: 2, action: 'select', mode: 'off' });
    assert.equal(manager(store, service).speech.configured, false);
    v.update('speech', { revision: 3, action: 'select', mode: 'saved' });
    assert.equal(v.record('speech').apiKey, 'keep-private-key');
  } finally {
    store.close();
  }
});

test('system preview creates no saved memo or selection; actual replies use durable authenticated memo storage and deduplication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-system-speech-test-'));
  const store = new Store(join(root, 'state.sqlite'), { sample: false });
  let calls = 0;
  const service = new SystemSpeechService({
    ...supported,
    temporaryRoot: root,
    runner: async ({ file, text }) => {
      calls++;
      assert(text.length > 0);
      await writeFile(file, audio);
    },
  });
  try {
    const v = manager(store, service),
      before = store.read();
    const preview = await v.test('speech', { revision: 0, source: 'system' });
    assert.deepEqual(Buffer.from(preview.audio, 'base64'), audio);
    assert.deepEqual(store.read(), before);
    assert.equal(store.exportVoiceMemos().length, 0);
    assert.equal(v.speech.configured, false);
    v.update('speech', { revision: 0, action: 'select', mode: 'system' });
    store.mutate((s) =>
      s.messages.push({
        id: 'spoken',
        threadId: 'main',
        role: 'assistant',
        text: 'Hello from Relay.',
        cards: [],
      }),
    );
    const card = await v.speech.forMessage(store, 'spoken');
    assert.deepEqual(Buffer.from(store.voiceMemo(card.id).audio), audio);
    assert.deepEqual(await v.speech.forMessage(store, 'spoken'), card);
    assert.equal(calls, 2);
    const reopened = new Store(join(root, 'state.sqlite'));
    assert.equal(manager(reopened, service).speech.configured, true);
    assert.deepEqual(Buffer.from(reopened.voiceMemo(card.id).audio), audio);
    reopened.close();
    assert(!(await readdir(root)).some((name) => name.startsWith('relay-system-voice-')));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native speech rejects invalid input/output, limits concurrency, blocks setting edits during work and cleans temporary files after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-system-speech-test-'));
  const store = new Store(':memory:', { sample: false });
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const service = new SystemSpeechService({
    ...supported,
    temporaryRoot: root,
    runner: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      }),
  });
  try {
    for (const text of ['', 'x'.repeat(4097), 'bad\0input'])
      await assert.rejects(service.synthesize(text), /characters/);
    const controller = new AbortController(),
      v = manager(store, service);
    const preview = v.test('speech', { revision: 0, source: 'system' }, controller.signal);
    await running;
    await new Promise((r) => setTimeout(r, 20));
    assert.throws(
      () => v.update('speech', { revision: 0, action: 'select', mode: 'system' }),
      /Finish the voice/,
    );
    controller.abort(new Error('cancel test'));
    await assert.rejects(preview, /cancel test/);
    assert.equal(service.running, 0);
    assert.deepEqual(await readdir(root), []);
    const invalid = new SystemSpeechService({
      ...supported,
      temporaryRoot: root,
      runner: ({ file }) => writeFile(file, Buffer.alloc(80)),
    });
    await assert.rejects(invalid.synthesize('Hello'), /WAV/);
    assert.deepEqual(await readdir(root), []);
    const missing = new SystemSpeechService({
      ...supported,
      temporaryRoot: root,
      runner: async () => {},
    });
    await assert.rejects(missing.synthesize('Hello'), (error) => {
      assert.equal(error.status, 502);
      assert(!error.message.includes(root));
      return true;
    });
    assert.deepEqual(await readdir(root), []);
    const held = new SystemSpeechService({
      ...supported,
      temporaryRoot: root,
      runner: async ({ file }) => {
        await new Promise((r) => setTimeout(r, 50));
        await writeFile(file, audio);
      },
    });
    const a = held.synthesize('One'),
      b = held.synthesize('Two');
    await assert.rejects(held.synthesize('Three'), /busy/);
    await Promise.all([a, b]);
    assert.deepEqual(await readdir(root), []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native process uses fixed arguments, sanitized stdin, no shell, bounded files and confirmed process exit on abort or timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-say-process-test-'));
  const file = join(root, 'reply.wav');
  try {
    let child,
      input = '';
    const run = systemSpeechProcess(
      { file, text: 'Hello [[slnc 999999]] $HOME `command`', timeout: 5000 },
      (binary, args, options) => {
        assert.equal(binary, '/usr/bin/say');
        assert.deepEqual(args, [
          '--file-format=WAVE',
          '--data-format=LEI16@22050',
          '-o',
          file,
          '-f',
          '-',
        ]);
        assert.equal(options.shell, false);
        assert.equal(options.detached, true);
        child = spawn(
          process.execPath,
          ['-e', 'process.stdin.on("data",x=>process.stdout.write(x))'],
          { ...options, stdio: ['pipe', 'pipe', 'ignore'] },
        );
        child.stdout.on('data', (x) => (input += x));
        return child;
      },
    );
    await run;
    assert.equal(input, 'Hello  slnc 999999  $HOME `command`');
    for (const kind of ['abort', 'timeout', 'oversize']) {
      const controller = new AbortController();
      let pid;
      const result = systemSpeechProcess(
        {
          file,
          text: 'bounded',
          signal: controller.signal,
          timeout: kind === 'timeout' ? 80 : 5000,
        },
        (_binary, _args, options) => {
          const code =
            kind === 'oversize'
              ? `require('fs').writeFileSync(process.argv[1],Buffer.alloc(9*1024*1024));setInterval(()=>{},1000)`
              : 'setInterval(()=>{},1000)';
          const child = spawn(process.execPath, ['-e', code, file], options);
          pid = child.pid;
          if (kind === 'abort') child.once('spawn', () => controller.abort());
          return child;
        },
      );
      await assert.rejects(
        result,
        kind === 'abort' ? /cancelled/ : kind === 'timeout' ? /too long/ : /8 MB/,
      );
      assert.throws(
        () => process.kill(pid, 0),
        (e) => e.code === 'ESRCH',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('system voice preview/selection retain owner-session and origin checks, without receiving caller commands', async () => {
  const store = new Store(':memory:', { sample: false });
  let calls = 0;
  const voice = manager(
    store,
    new SystemSpeechService({
      ...supported,
      runner: async ({ file, text }) => {
        calls++;
        assert.equal(text, 'Hi, I’m Relay. This is how I’ll sound.');
        await writeFile(file, audio);
      },
    }),
  );
  const app = createApp(
    store,
    {
      voiceConnections: voice,
      speech: voice.speech,
      transcription: voice.transcription,
      provider: {},
      google: {},
      browser: {},
      terminal: {},
    },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', source = origin) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const payload = {
      source: 'system',
      revision: 0,
      command: 'do not run',
      text: 'must not replace fixed preview',
    };
    assert.equal((await post('voice-connections/speech/test', payload)).status, 401);
    const cookie = (await post('login', { key: 'owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('voice-connections/speech/test', payload, cookie, 'https://outside.example'))
        .status,
      403,
    );
    assert.equal(calls, 0);
    const result = await post('voice-connections/speech/test', payload, cookie);
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from((await result.json()).audio, 'base64'), audio);
    assert.equal(calls, 1);
    assert.equal(store.read().messages.length, 0);
    assert.equal(voice.speech.configured, false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
