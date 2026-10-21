// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TranscriptionService, recordingFormat } from '../server/transcription.mjs';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { isWorkspaceMicrophone } from '../native/desktop/permissions.mjs';
const wav = Buffer.alloc(44);
wav.write('RIFF');
wav.write('WAVE', 8);
async function provider(handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
test('transcription sends only audio, model and JSON format; returns editable text without writing workspace state', async () => {
  let received;
  const p = await provider(async (req, res) => {
    const form = await new Request('http://localhost', {
      method: 'POST',
      headers: req.headers,
      body: req,
      duplex: 'half',
    }).formData();
    received = {
      auth: req.headers.authorization,
      path: req.url,
      fields: [...form.keys()],
      model: form.get('model'),
      format: form.get('response_format'),
      file: form.get('file'),
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '  Morning planning.  ' }));
  });
  const transcription = new TranscriptionService({
    baseUrl: p.url,
    model: 'test-transcriber',
    apiKey: 'private-test-key',
  });
  const store = new Store(':memory:');
  const before = store.read();
  const services = { transcription, provider: {}, google: {}, browser: {}, terminal: {} };
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: 'owner-key' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (
        await fetch(url + '/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wav,
        })
      ).status,
      401,
    );
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'owner-key' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { 'Content-Type': 'audio/wav', Cookie: cookie };
    assert.equal(
      (
        await fetch(url + '/api/transcribe', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://untrusted.invalid' },
          body: wav,
        })
      ).status,
      403,
    );
    const response = await fetch(url + '/api/transcribe', { method: 'POST', headers, body: wav });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'Morning planning.' });
    assert.equal(received.path, '/v1/audio/transcriptions');
    assert.equal(received.auth, 'Bearer private-test-key');
    assert.deepEqual(received.fields, ['model', 'response_format', 'file']);
    assert.equal(received.model, 'test-transcriber');
    assert.equal(received.format, 'json');
    assert.equal(received.file.name, 'recording.wav');
    assert.deepEqual(Buffer.from(await received.file.arrayBuffer()), wav);
    assert.deepEqual(store.read(), before);
    const state = await (await fetch(url + '/api/state', { headers: { Cookie: cookie } })).json();
    assert.equal(state.connections.runtime.transcription.configured, true);
    assert.ok(!JSON.stringify(state).includes('private-test-key'));
    assert.equal(
      (
        await fetch(url + '/api/transcribe', {
          method: 'POST',
          headers,
          body: Buffer.alloc(8 * 1024 * 1024 + 1),
        })
      ).status,
      413,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
    await p.close();
  }
});
test('audio validation and explicit service configuration reject invalid input before transmission', async () => {
  for (const baseUrl of [
    'http://remote.invalid/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=secret',
    'file:///tmp',
  ])
    assert.throws(() => new TranscriptionService({ baseUrl, model: 'x' }));
  await assert.rejects(
    new TranscriptionService().transcribe(wav, 'audio/wav'),
    (error) => error.status === 503 && /Settings/.test(error.message),
  );
  assert.deepEqual(recordingFormat(wav, 'audio/wav'), { mime: 'audio/wav', extension: 'wav' });
  const webm = Buffer.from('1a45dfa30000000000000000', 'hex');
  assert.equal(recordingFormat(webm, 'audio/webm;codecs=opus').extension, 'webm');
  const mp4 = Buffer.alloc(12);
  mp4.write('ftyp', 4);
  assert.equal(recordingFormat(mp4, 'audio/mp4').extension, 'm4a');
  const ogg = Buffer.alloc(12);
  ogg.write('OggS');
  assert.equal(recordingFormat(ogg, 'audio/ogg').extension, 'ogg');
  for (const [bytes, mime] of [
    [wav, 'text/html'],
    [wav, 'audio/mp4'],
    [Buffer.alloc(3), 'audio/wav'],
    [Buffer.alloc(8 * 1024 * 1024 + 1), 'audio/wav'],
  ])
    assert.throws(() => recordingFormat(bytes, mime));
});
test('provider errors, redirects, silence and malformed or oversized responses are surfaced without leaking bodies or retrying', async () => {
  let count = 0;
  let kind = 'error';
  const p = await provider((_req, res) => {
    count++;
    if (kind === 'error') {
      res.writeHead(401);
      res.end('private-test-key');
    } else if (kind === 'redirect') {
      res.writeHead(302, { Location: '/other' });
      res.end();
    } else if (kind === 'silence') res.end(JSON.stringify({ text: ' ' }));
    else if (kind === 'huge') res.end('x'.repeat(270000));
    else res.end('broken');
  });
  const service = new TranscriptionService({ baseUrl: p.url, model: 'test' });
  try {
    for (const scenario of ['error', 'redirect', 'silence', 'huge', 'invalid']) {
      kind = scenario;
      const before = count;
      await assert.rejects(
        service.transcribe(wav, 'audio/wav'),
        (e) => !e.message.includes('private-test-key') && e.status >= 400,
      );
      assert.equal(count, before + 1);
      assert.equal(service.busy, false);
    }
  } finally {
    await p.close();
  }
});
test('cancellation, timeout and concurrency release the active transcription slot', async () => {
  let entered;
  const first = new Promise((r) => (entered = r));
  const p = await provider((_req, _res) => entered());
  try {
    const service = new TranscriptionService({ baseUrl: p.url, model: 'test', timeout: 3000 });
    const controller = new AbortController();
    const pending = service.transcribe(wav, 'audio/wav', controller.signal);
    const rejected = assert.rejects(pending, (e) => e.status === 499);
    await first;
    await assert.rejects(service.transcribe(wav, 'audio/wav'), (e) => e.status === 429);
    controller.abort();
    await rejected;
    assert.equal(service.busy, false);
    const timed = new TranscriptionService({ baseUrl: p.url, model: 'test', timeout: 30 });
    await assert.rejects(timed.transcribe(wav, 'audio/wav'), (e) => e.status === 504);
    assert.equal(timed.busy, false);
  } finally {
    await p.close();
  }
});
test('desktop microphone permission excludes subframes, other origins, camera and unrelated access', () => {
  const url = 'https://relay.example';
  const details = { isMainFrame: true, requestingUrl: url + '/#chat', mediaTypes: ['audio'] };
  assert.equal(isWorkspaceMicrophone('media', details, url), true);
  for (const change of [
    { isMainFrame: false },
    { requestingUrl: 'https://relay.example.evil.invalid' },
    { mediaTypes: ['video'] },
    { mediaTypes: ['audio', 'video'] },
    { mediaTypes: [] },
    { requestingUrl: 'file:///tmp' },
  ])
    assert.equal(isWorkspaceMicrophone('media', { ...details, ...change }, url), false);
  assert.equal(isWorkspaceMicrophone('geolocation', details, url), false);
  assert.equal(
    isWorkspaceMicrophone('media', { ...details, mediaType: 'audio' }, url, 'check'),
    true,
  );
  assert.equal(
    isWorkspaceMicrophone('media', { ...details, mediaType: 'unknown' }, url, 'check'),
    false,
  );
});
