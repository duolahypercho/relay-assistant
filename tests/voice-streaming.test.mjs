// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemSpeechService } from '../server/system-speech.mjs';
import { systemPcmLayout } from '../server/system-speech-stream.mjs';
import { VoicePlayback, voiceReplyFrames } from '../shared/voice-playback.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { audioFixture } from '../scripts/audio-fixture.mjs';

const deferred = () => Promise.withResolvers();
function wav() {
  const bytes = audioFixture(2);
  bytes.writeUInt32LE(22050, 24);
  bytes.writeUInt32LE(44100, 28);
  return bytes;
}
function partial(bytes) {
  const copy = Buffer.from(bytes.subarray(0, 24044));
  copy.writeUInt32LE(36, 4);
  copy.writeUInt32LE(0, 40);
  return copy;
}

test(
  'Mac preview starts before synthesis completes, delivers each sample once, and saves one exact recording',
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-stream-test-'));
    const first = deferred(),
      finish = deferred(),
      store = new Store(':memory:', { sample: false });
    const bytes = wav(),
      parts = [];
    let calls = 0;
    const service = new SystemSpeechService({
      platform: 'darwin',
      exists: () => true,
      temporaryRoot: root,
      runner: async ({ file }) => {
        calls++;
        await writeFile(file, partial(bytes));
        await finish.promise;
        await writeFile(file, bytes);
      },
    });
    store.mutate((s) =>
      s.messages.push({
        id: 'answer',
        role: 'assistant',
        threadId: 'main',
        text: 'Your complete answer.',
        cards: [],
      }),
    );
    try {
      const pending = service.forMessage(store, 'answer', undefined, undefined, (part) => {
        parts.push(part.audio);
        first.resolve();
      });
      await first.promise;
      assert.equal(
        store.exportVoiceMemos().length,
        0,
        'Partial speech must not become a complete saved memo',
      );
      finish.resolve();
      const card = await pending;
      assert.deepEqual(Buffer.concat(parts), bytes.subarray(44));
      assert.deepEqual(Buffer.from(store.voiceMemo(card.id).audio), bytes);
      assert.deepEqual(await service.forMessage(store, 'answer'), card);
      assert.equal(calls, 1);
      assert.equal(store.read().messages[0].cards.length, 1);
      assert.deepEqual(await readdir(root), []);
    } finally {
      finish.resolve();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'streaming cancellation and changed source never save a partial or stale voice memo',
  { timeout: 5000 },
  async () => {
    for (const mode of ['cancel', 'changed', 'role']) {
      const root = await mkdtemp(join(tmpdir(), 'relay-stream-cancel-'));
      const first = deferred(),
        finish = deferred(),
        controller = new AbortController();
      const store = new Store(':memory:', { sample: false });
      const bytes = wav();
      const service = new SystemSpeechService({
        platform: 'darwin',
        exists: () => true,
        temporaryRoot: root,
        runner: async ({ file }) => {
          await writeFile(file, partial(bytes));
          await finish.promise;
          await writeFile(file, bytes);
        },
      });
      store.mutate((s) =>
        s.messages.push({ id: 'answer', role: 'assistant', text: 'Original text.', cards: [] }),
      );
      try {
        const pending = service.forMessage(store, 'answer', controller.signal, undefined, () =>
          first.resolve(),
        );
        const rejected = assert.rejects(pending, /aborted|changed|cancelled/i);
        await first.promise;
        if (mode === 'cancel') controller.abort();
        else if (mode === 'role')
          store.mutate((s) => {
            s.messages[0].role = 'user';
          });
        else
          store.mutate((s) => {
            s.messages[0].text = 'Revised text.';
          });
        finish.resolve();
        await rejected;
        assert.equal(store.exportVoiceMemos().length, 0);
        assert.deepEqual(await readdir(root), []);
      } finally {
        finish.resolve();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test('WAV preview skips padded metadata, rejects truncated final PCM and unsupported formats', () => {
  const bytes = wav();
  const filler = Buffer.from([...'JUNK'].map((s) => s.charCodeAt(0)).concat([1, 0, 0, 0, 99, 0]));
  const padded = Buffer.concat([bytes.subarray(0, 36), filler, bytes.subarray(36)]);
  assert.deepEqual(systemPcmLayout(padded, true), { offset: 54, size: bytes.length - 44 });
  assert.equal(systemPcmLayout(bytes.subarray(0, 25)), null);
  assert.throws(() => systemPcmLayout(bytes.subarray(0, 100), true), /incomplete/);
  const wrong = Buffer.from(bytes);
  wrong.writeUInt16LE(3, 20);
  assert.throws(() => systemPcmLayout(wrong), /unsupported/);
});

test(
  'authenticated voice stream starts early and interruption ends it without a saved partial memo',
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-stream-http-'));
    const store = new Store(':memory:', { sample: false }),
      finish = deferred();
    const services = {
      provider: { configured: true },
      transcription: {
        configured: true,
        transcribe: async () => ({ text: 'Tell me about my day.' }),
      },
      speech: new SystemSpeechService({
        platform: 'darwin',
        exists: () => true,
        temporaryRoot: root,
        runner: async ({ file, signal }) => {
          await writeFile(file, partial(wav()));
          await Promise.race([
            finish.promise,
            new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
          ]);
          signal.throwIfAborted();
          await writeFile(file, wav());
        },
      }),
    };
    const server = createApp(store, services, {
      host: '127.0.0.1',
      port: 0,
      accessKey: 'test-stream-key',
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test-stream-key' }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const call = services.voiceCalls;
      call.start('stream-call-000001', 'main');
      const turn = await call.turn(
        'stream-call-000001',
        'stream-turn-000001',
        audioFixture(),
        'audio/wav',
      );
      store.mutate((s) => {
        s.runs[0].status = 'completed';
        s.messages.push({
          id: 'answer',
          threadId: 'main',
          role: 'assistant',
          text: 'Here is the answer.',
          replyTo: turn.messageId,
          cards: [],
        });
      });
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
        body: JSON.stringify({ messageId: 'answer' }),
      };
      const denied = await fetch(base + '/api/voice-calls/stream-call-000001/reply-stream', {
        ...options,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(denied.status, 401);
      const response = await fetch(
        base + '/api/voice-calls/stream-call-000001/reply-stream',
        options,
      );
      const frames = voiceReplyFrames(response);
      assert.equal((await frames.next()).value.type, 'audio');
      assert.equal(store.exportVoiceMemos().length, 0);
      call.interrupt('stream-call-000001');
      await assert.rejects(async () => {
        for await (const frame of frames) assert.notEqual(frame.type, 'done');
      }, /cancelled|aborted|interrupted/i);
      assert.equal(store.exportVoiceMemos().length, 0);
    } finally {
      finish.resolve();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('voice stream detects dropped final receipt and preserves split UTF-8 text', async () => {
  const read = async (frames) => {
    const bytes = new TextEncoder().encode(
      frames.map((frame) => JSON.stringify(frame) + '\n').join(''),
    );
    const body = new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    });
    const result = [];
    for await (const frame of voiceReplyFrames(
      new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
    ))
      result.push(frame);
    return result;
  };
  assert.deepEqual(await read([{ type: 'done', card: { id: 'memo', transcript: '你好' } }]), [
    { type: 'done', card: { id: 'memo', transcript: '你好' } },
  ]);
  await assert.rejects(read([{ type: 'audio', audio: 'AAAA' }]), /ended before/);
  await assert.rejects(read([{ type: 'error', error: 'Speech stopped.' }]), /Speech stopped/);
});

test('playback joins PCM without overlaps, awaits the last source and stops every queued source', async () => {
  const nodes = [];
  const context = {
    currentTime: 10,
    destination: {},
    createBuffer: (_channels, length, rate) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const node = {
        connect() {},
        disconnect() {},
        start(at) {
          this.at = at;
        },
        stop() {
          this.stopped = true;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const part = {
    encoding: 'pcm16',
    sampleRate: 22050,
    channels: 1,
    audio: wav().subarray(44).toString('base64'),
  };
  // Each transport frame is capped at 64 KiB.
  part.audio = wav().subarray(44, 44144).toString('base64');
  let decoded;
  const createBuffer = context.createBuffer;
  context.createBuffer = (_channels, length, rate) => {
    decoded = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => decoded };
  };
  const decoding = new VoicePlayback(context);
  decoding.pcm({ ...part, audio: Buffer.from([0, 128, 255, 127, 0, 0]).toString('base64') });
  assert.deepEqual([...decoded], [-1, 32767 / 32768, 0]);
  decoding.stop();
  nodes.pop();
  context.createBuffer = createBuffer;
  const playback = new VoicePlayback(context);
  playback.pcm(part);
  playback.pcm(part);
  assert.equal(nodes[1].at, nodes[0].at + nodes[0].buffer.duration);
  let ended = false;
  playback.finish().then(() => {
    ended = true;
  });
  nodes[0].onended();
  await Promise.resolve();
  assert.equal(ended, false);
  nodes[1].onended();
  await playback.done;
  assert.equal(ended, true);
  const second = new VoicePlayback(context);
  second.pcm(part);
  second.pcm(part);
  second.stop();
  assert(nodes.slice(2).every((node) => node.stopped && node.onended === null));
  const count = nodes.length;
  second.pcm(part);
  assert.equal(nodes.length, count, 'Late chunks cannot revive playback');
});
