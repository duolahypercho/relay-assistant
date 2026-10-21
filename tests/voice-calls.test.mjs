// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { VoiceCalls } from '../server/voice-calls.mjs';
import { VoiceSegmenter, speechWav, voiceActivityFrames } from '../shared/voice-activity.mjs';
import { SpeechService } from '../server/speech.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { command } from '../shared/domain.mjs';
import { audioFixture } from '../scripts/audio-fixture.mjs';
const cid = 'call-test-00000001',
  tid = 'turn-test-00000001';
function fixture() {
  const store = new Store(':memory:', { sample: false });
  let now = 100000;
  const services = {
    provider: { configured: true },
    transcription: {
      configured: true,
      async transcribe() {
        return { text: 'Remember I prefer green tea' };
      },
    },
    speech: { configured: true },
    google: { configured: false },
  };
  const calls = new VoiceCalls(store, services, { clock: () => now });
  services.voiceCalls = calls;
  return {
    store,
    services,
    calls,
    advance: (ms) => {
      now += ms;
    },
  };
}
test('voice starts explicitly, prevents parallel calls, transcribes exactly once and preserves typed drafts', async () => {
  const f = fixture();
  try {
    f.store.mutate((s) => {
      s.threads[0].draft = 'My unfinished draft';
    });
    const messages = f.store.read().messages.length;
    const c = f.calls.start(cid, 'main');
    assert.equal(f.store.read().messages.length, messages);
    assert.deepEqual(f.calls.start(cid, 'main'), c);
    assert.throws(() => f.calls.start('call-test-00000002', 'main'), /already open/);
    const t = await f.calls.turn(cid, tid, audioFixture(1), 'audio/wav');
    assert.deepEqual(await f.calls.turn(cid, tid, audioFixture(1), 'audio/wav'), t);
    const s = f.store.read();
    assert.equal(s.messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(s.threads[0].draft, 'My unfinished draft');
    assert.equal(s.runs[0].voiceCallId, cid);
    assert.equal(s.messages.find((m) => m.id === t.messageId).text, 'Remember I prefer green tea');
    assert.equal(s.approvals.length, 0);
    f.calls.end(cid);
    f.calls.end(cid);
    assert.equal(f.store.read().runs[0].status, 'cancelled');
    assert.equal(f.store.read().messages.filter((m) => m.id === `voice-summary-${cid}`).length, 1);
    await assert.rejects(
      f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav'),
      /ended/,
    );
  } finally {
    f.store.close();
  }
});
test('ending or interrupting during transcription rejects late text without creating a request', async () => {
  for (const action of ['end', 'interrupt']) {
    const f = fixture();
    let finish;
    f.services.transcription.transcribe = () =>
      new Promise((r) => {
        finish = r;
      });
    try {
      f.calls.start(cid, 'main');
      const result = f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
      f.calls[action](cid);
      finish({ text: 'Late request must not run' });
      await assert.rejects(result, /ended|interrupted/);
      assert.equal(f.store.read().runs.length, 0);
      assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('voice uses selected files and apps on each turn without consuming typed draft context', async () => {
  const f = fixture();
  const app = { id: 'library', revision: 1, name: 'Library' };
  f.services.connectors = { chatCatalog: () => [{ ...app, enabled: true, toolCount: 1 }] };
  const draft = {
    draft: 'Unfinished text',
    draftFileIds: ['file-context'],
    draftApps: [app],
    draftShareIds: [],
  };
  try {
    f.store.mutate((s) => {
      s.files.push({ id: 'file-context', name: 'Brief.txt' });
      Object.assign(s.threads[0], draft);
    });
    const context = { fileIds: ['file-context'], apps: [app] };
    f.calls.start(cid, 'main', context);
    context.fileIds.length = 0;
    for (const id of [tid, 'turn-test-00000002']) {
      const turn = await f.calls.turn(cid, id, audioFixture(), 'audio/wav');
      const s = f.store.read();
      const message = s.messages.find((m) => m.id === turn.messageId);
      assert.deepEqual(message.fileIds, ['file-context']);
      assert.deepEqual(message.appContext, [app]);
      assert.deepEqual(s.runs.find((r) => r.id === turn.runId).appContext, [app]);
      for (const [field, value] of Object.entries(draft))
        assert.deepEqual(s.threads[0][field], value);
    }
  } finally {
    f.store.close();
  }
});
test('voice rejects stale app access and removed files before queuing a spoken request', async () => {
  for (const removed of ['app', 'file']) {
    const f = fixture();
    let available = true;
    const app = { id: 'library', revision: 1, name: 'Library' };
    f.services.connectors = {
      chatCatalog: () => (available ? [{ ...app, enabled: true, toolCount: 1 }] : []),
    };
    try {
      f.store.mutate((s) => s.files.push({ id: 'file-context', name: 'Brief.txt' }));
      f.calls.start(cid, 'main', { fileIds: ['file-context'], apps: [app] });
      if (removed === 'app') available = false;
      else
        f.store.mutate((s) => {
          s.files = [];
        });
      await assert.rejects(
        f.calls.turn(cid, tid, audioFixture(), 'audio/wav'),
        /unavailable|not found/,
      );
      assert.equal(f.store.read().runs.length, 0);
      assert.equal(f.store.read().messages.length, 0);
      assert.equal(f.calls.get(cid).turns[0].status, 'failed');
    } finally {
      f.store.close();
    }
  }
});
test('voice rejects invalid call selections without starting a call or microphone task', () => {
  const f = fixture();
  try {
    for (const context of [
      null,
      [],
      { fileIds: 'bad' },
      { fileIds: ['missing'] },
      { apps: [{}] },
    ]) {
      assert.throws(() => f.calls.start(cid, 'main', context), /Choose/);
      assert.equal(f.store.read().voiceCalls?.length || 0, 0);
    }
  } finally {
    f.store.close();
  }
});
test('failed transcription can retry its key without duplicate messages; malformed recordings never reach service', async () => {
  const f = fixture();
  let attempts = 0;
  f.services.transcription.transcribe = async () => {
    if (!attempts++) throw new Error('Unavailable');
    return { text: 'Try this again' };
  };
  try {
    f.calls.start(cid, 'main');
    await assert.rejects(f.calls.turn(cid, tid, Buffer.from('invalid'), 'audio/wav'), /recording/);
    assert.equal(attempts, 0);
    await assert.rejects(f.calls.turn(cid, tid, audioFixture(), 'audio/wav'), /Unavailable/);
    await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    assert.equal(f.calls.get(cid).turns.length, 1);
    assert.equal(f.store.read().runs.length, 1);
  } finally {
    f.store.close();
  }
});
test('heartbeat expiry, duration limit, server restart and owner takeover end calls and their work', async () => {
  for (const reason of ['expiry', 'deadline', 'restart', 'takeover']) {
    const f = fixture();
    try {
      f.calls.start(cid, 'main');
      await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
      if (reason === 'expiry') f.advance(21000);
      if (reason === 'deadline') {
        f.advance(30 * 60000);
      }
      if (reason === 'takeover') f.services.computer = { enabled: true, controller: 'owner' };
      if (reason === 'restart') new VoiceCalls(f.store, f.services);
      else f.calls.sweep();
      assert.equal(f.calls.get(cid).status, 'ended');
      assert.equal(f.store.read().runs[0].status, 'cancelled');
    } finally {
      f.store.close();
    }
  }
});
test('interrupt cancels only this call, keeps its transcript and leaves unrelated work intact', async () => {
  const f = fixture();
  try {
    f.calls.start(cid, 'main');
    const t = await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    const other = f.store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'Unrelated request' }, true),
    );
    f.calls.interrupt(cid);
    assert.equal(f.store.read().runs.find((r) => r.id === t.runId).status, 'cancelled');
    assert.equal(f.store.read().runs.find((r) => r.id === other.id).status, 'queued');
    assert.equal(f.calls.get(cid).status, 'active');
  } finally {
    f.store.close();
  }
});
test('speech belongs to this call and a late synthesis cannot attach audio after interruption', async () => {
  const f = fixture();
  let finish;
  const speech = new SpeechService({ baseUrl: 'http://127.0.0.1:1', model: 'test', voice: 'test' });
  speech.synthesize = () =>
    new Promise((r) => {
      finish = r;
    });
  f.services.speech = speech;
  try {
    f.calls.start(cid, 'main');
    const t = await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    f.store.mutate((s) => {
      s.runs[0].status = 'completed';
      s.messages.push({
        id: 'reply',
        threadId: 'main',
        role: 'assistant',
        text: 'Saved your note.',
        replyTo: t.messageId,
        cards: [],
      });
    });
    await assert.rejects(f.calls.reply(cid, 'missing'), /Choose a reply/);
    const result = f.calls.reply(cid, 'reply');
    f.calls.interrupt(cid);
    finish(audioFixture());
    await assert.rejects(result, /interrupted|aborted|cancelled/i);
    assert.equal(f.store.read().messages.at(-1).cards.length, 0);
    assert.equal(f.store.exportVoiceMemos().length, 0);
  } finally {
    f.store.close();
  }
});
test('energy detection ignores silence and short clicks, segments speech, bounds long utterances and encodes PCM WAV', () => {
  const rate = 24000,
    block = new Float32Array(1200).fill(0.1),
    silent = new Float32Array(1200);
  const v = new VoiceSegmenter(rate, { maximum: 2 });
  for (let i = 0; i < 60; i++) assert.equal(v.push(silent).started, undefined);
  v.push(block);
  for (let i = 0; i < 25; i++) assert.equal(v.push(silent).finished, undefined);
  let started = false,
    end;
  for (let i = 0; i < 12; i++) {
    const event = v.push(block);
    started = started || !!event.started;
  }
  for (let i = 0; i < 12; i++) v.push(block);
  for (let i = 0; i < 25; i++) {
    const event = v.push(silent);
    if (event.finished) end = event;
  }
  assert.ok(started && end.chunks);
  const wav = Buffer.from(speechWav(end.chunks, rate));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.ok(wav.length > 32000);
  let bounded = false;
  for (let i = 0; i < 50; i++) if (v.push(block).finished) bounded = true;
  assert.ok(bounded);
  v.reset();
  assert.equal(v.active, false);
});
test('voice capture rejects short noise consistently across sample rates and callback boundaries', () => {
  for (const rate of [8000, 16000, 22050, 24000, 44100, 48000]) {
    for (const callback of [128, 512, 2048, 4096]) {
      for (const lead of [0.05, 0.13, 0.27, 0.42, 0.57]) {
        for (const duration of [0.18, 0.65]) {
          const samples = new Float32Array(Math.ceil(rate * (lead + duration + 1.2)));
          for (let i = Math.floor(rate * lead); i < Math.floor(rate * (lead + duration)); i++)
            samples[i] = 0.15 * Math.sin((2 * Math.PI * 330 * i) / rate);
          const detector = new VoiceSegmenter(rate),
            events = [];
          for (let i = 0; i < samples.length; i += callback)
            for (const frame of voiceActivityFrames(samples.subarray(i, i + callback), rate)) {
              const event = detector.push(frame);
              if (event.finished) events.push(event);
            }
          const context = JSON.stringify({ rate, callback, lead, duration });
          assert.equal(events.length, 1, context);
          assert.equal(!!events[0].chunks, duration === 0.65, context);
          if (duration === 0.65) {
            const wav = Buffer.from(speechWav(events[0].chunks, rate));
            assert.equal(wav.readUInt32LE(24), 16000);
            assert(wav.length > 32000, context);
          }
        }
      }
    }
  }
});

test('voice framing preserves every sample and reset discards an unfinished onset', () => {
  const rate = 16000;
  const original = Float32Array.from({ length: 2051 }, (_, i) => i / 2051);
  const frames = [...voiceActivityFrames(original, rate)];
  assert(frames.every((frame) => frame.length <= 320));
  assert.deepEqual(Float32Array.from(frames.flatMap((frame) => [...frame])), original);
  const detector = new VoiceSegmenter(rate);
  for (const frame of voiceActivityFrames(new Float32Array(1600).fill(0.1), rate))
    detector.push(frame);
  detector.reset();
  for (const frame of voiceActivityFrames(new Float32Array(rate * 2), rate))
    assert.equal(detector.push(frame).finished, undefined);
  assert.equal(detector.active, false);
});

test('voice endpoints require owner auth and same-origin writes', async () => {
  const f = fixture(),
    app = createApp(f.store, f.services, {
      host: '127.0.0.1',
      port: 0,
      accessKey: 'voice-test-key',
    });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (
        await fetch(`${base}/api/voice-calls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: cid, threadId: 'main' }),
        })
      ).status,
      401,
    );
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'voice-test-key' }),
    });
    const headers = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      'Content-Type': 'application/json',
    };
    const start = await fetch(`${base}/api/voice-calls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: cid, threadId: 'main' }),
    });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    assert.equal(
      (
        await fetch(`${base}/api/voice-calls/${cid}/end`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.invalid' },
        })
      ).status,
      403,
    );
    const turn = await fetch(`${base}/api/voice-calls/${cid}/turn?turn=${tid}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'audio/wav' },
      body: audioFixture(),
    });
    assert.equal(turn.status, 200);
    assert.ok((await turn.json()).turn.runId);
    assert.equal(
      (await fetch(`${base}/api/voice-calls/${cid}/end`, { method: 'POST', headers })).status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});
test('actual worker retains voice guidance through prompt refresh and cancels an interrupted model request', async () => {
  const f = fixture();
  let resolveStarted,
    aborted = false;
  const started = new Promise((r) => {
    resolveStarted = r;
  });
  f.services.mode = 'live';
  f.services.provider.complete = async (messages, tools, options) => {
    assert.match(messages[0].content, /live voice conversation/);
    assert.ok(!tools.some((t) => t.name === 'create_voice_memo'));
    resolveStarted();
    await new Promise((_, reject) =>
      options.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new DOMException('Stopped', 'AbortError'));
        },
        { once: true },
      ),
    );
  };
  const worker = new BackgroundWorker(f.store, f.services, { pollMs: 10 });
  f.services.worker = worker;
  try {
    f.calls.start(cid, 'main');
    await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    worker.start();
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Model did not start')), 3000).unref(),
      ),
    ]);
    f.calls.interrupt(cid);
    assert.equal(aborted, true);
    assert.equal(f.store.read().runs[0].status, 'cancelled');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

async function waitVoice(check) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Voice work did not reach its expected state');
}
const voiceTool = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });

test('spoken correction retains completed tools, skips the old next action and finishes the same request', async () => {
  const f = fixture();
  let releaseRead,
    reading = false,
    round = 0;
  const read = new Promise((resolve) => {
    releaseRead = resolve;
  });
  f.store.mutate((s) => {
    s.profile.memoryLearning = false;
    s.threads[0].draft = 'Unsent draft';
  });
  f.services.mode = 'live';
  f.services.transcription.transcribe = async () => ({
    text: round ? 'Keep the saved original and add Sunday instead.' : 'Create my meeting brief.',
  });
  f.services.readPage = async () => {
    reading = true;
    await read;
    return { url: 'https://example.com', title: 'Plan', text: 'Useful source' };
  };
  f.services.provider.complete = async (messages, tools) => {
    if (++round === 1)
      return {
        text: '',
        toolCalls: [
          voiceTool('load-voice-work', 'load_tools', { names: ['write_note', 'read_web'] }),
        ],
      };
    assert(tools.some((t) => t.name === 'write_note') && tools.some((t) => t.name === 'read_web'));
    if (round === 2)
      return {
        text: '',
        toolCalls: [
          voiceTool('original', 'write_note', { name: 'original.md', text: 'Saved once' }),
          voiceTool('read', 'read_web', { url: 'https://example.com' }),
          voiceTool('stale', 'write_note', { name: 'stale.md', text: 'Must never execute' }),
        ],
      };
    if (round === 3) {
      assert.match(messages.find((m) => m.tool_call_id === 'stale').content, /Not executed/);
      assert(messages.some((m) => m.tool_call_id === 'original'));
      assert(
        messages.some(
          (m) =>
            m.role === 'user' &&
            m.content.endsWith('Keep the saved original and add Sunday instead.'),
        ),
      );
      return {
        text: '',
        toolCalls: [voiceTool('corrected', 'write_note', { name: 'corrected.md', text: 'Sunday' })],
      };
    }
    return { text: 'Kept your original and saved the Sunday correction.', toolCalls: [] };
  };
  const worker = (f.services.worker = new BackgroundWorker(f.store, f.services, { pollMs: 10 }));
  try {
    f.calls.start(cid, 'main');
    const first = await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    worker.start();
    await waitVoice(() => reading);
    f.calls.listen(cid);
    releaseRead();
    await waitVoice(() => f.store.read().runs[0].waitingForReply);
    assert.deepEqual(
      f.store.read().files.map((x) => x.name),
      ['original.md'],
    );
    const correction = await f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav');
    assert.equal(correction.runId, first.runId);
    assert.notEqual(correction.messageId, first.messageId);
    await waitVoice(() => f.store.read().runs[0].status === 'completed');
    const s = f.store.read();
    assert.equal(s.runs.length, 1);
    assert.equal(round, 4);
    assert.deepEqual(s.files.map((x) => [x.name, x.text]).sort(), [
      ['corrected.md', 'Sunday'],
      ['original.md', 'Saved once'],
    ]);
    assert.equal(s.messages.at(-1).replyTo, correction.messageId);
    assert.equal(s.threads[0].draft, 'Unsent draft');
    assert.equal(f.calls.get(cid).listening, false);
    assert.equal(s.runs[0].steeringApplied, 1);
  } finally {
    releaseRead();
    await worker.stop();
    f.store.close();
  }
});

test('a short utterance can release the listening boundary without cancelling or creating a request', async () => {
  const f = fixture();
  f.services.mode = 'live';
  f.services.transcription.transcribe = async () => ({ text: 'Explain this idea.' });
  f.services.provider.complete = async () => ({ text: 'The original answer.', toolCalls: [] });
  f.store.mutate((s) => {
    s.profile.memoryLearning = false;
  });
  const worker = (f.services.worker = new BackgroundWorker(f.store, f.services, { pollMs: 10 }));
  try {
    f.calls.start(cid, 'main');
    await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    f.calls.listen(cid);
    worker.start();
    await waitVoice(() => f.store.read().runs[0].waitingForReply);
    f.calls.resume(cid);
    await waitVoice(() => f.store.read().runs[0].status === 'completed');
    assert.equal(f.store.read().runs.length, 1);
    assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(f.store.read().messages.at(-1).text, 'The original answer.');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

test('failed recognition keeps work held; retry steers once and payloads cannot impersonate voice provenance', async () => {
  const f = fixture();
  try {
    f.calls.start(cid, 'main');
    const first = await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    f.store.mutate((s) => {
      s.runs[0].status = 'running';
    });
    f.calls.listen(cid);
    const typed = f.store.mutate((s) =>
      command(s, 'chat.send', {
        threadId: 'main',
        text: 'Typed unrelated request',
        delivery: 'now',
        voiceCallId: cid,
      }),
    );
    assert.notEqual(typed.id, first.runId);
    f.services.transcription.transcribe = async () => {
      throw Error('Recognizer unavailable');
    };
    await assert.rejects(
      f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav'),
      /unavailable/,
    );
    assert.equal(f.calls.get(cid).listening, true);
    f.services.transcription.transcribe = async () => ({ text: 'Use the corrected detail.' });
    const second = await f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav');
    assert.equal(second.runId, first.runId);
    assert.deepEqual(
      await f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav'),
      second,
    );
    assert.equal(f.store.read().runs.length, 2);
    assert.equal(f.store.read().runs[0].steeringMessageIds.length, 1);
    assert.equal(f.calls.get(cid).listening, false);
    const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Side' }));
    assert.throws(
      () =>
        f.store.mutate((s) =>
          command(
            s,
            'chat.send',
            { threadId: side.id, text: 'Wrong conversation', delivery: 'now' },
            true,
            [],
            { voiceCallId: cid },
          ),
        ),
      /ended/,
    );
  } finally {
    f.store.close();
  }
});

test('a spoken stop uses the durable stop control and is idempotent without ending the call', async () => {
  const f = fixture();
  f.services.mode = 'live';
  f.services.transcription.transcribe = async () => ({ text: 'Keep working on my brief.' });
  let started = false;
  f.services.provider.complete = async (_messages, _tools, { signal }) => {
    started = true;
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  };
  const worker = (f.services.worker = new BackgroundWorker(f.store, f.services, { pollMs: 10 }));
  try {
    f.store.mutate((s) =>
      s.files.push({
        id: 'source',
        name: 'Source.txt',
        mime: 'text/plain',
        text: 'Source content',
      }),
    );
    f.calls.start(cid, 'main', { fileIds: ['source'] });
    await f.calls.turn(cid, tid, audioFixture(), 'audio/wav');
    worker.start();
    await waitVoice(() => started);
    f.calls.listen(cid);
    f.store.mutate((s) => {
      s.files = [];
    });
    f.services.transcription.transcribe = async () => ({ text: 'Stop now.' });
    const stop = await f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav');
    assert.equal(stop.status, 'stopped');
    await waitVoice(
      () =>
        f.store.read().messages.find((m) => m.id === stop.stopControlId).stopControl.status ===
        'completed',
    );
    assert.equal(f.store.read().runs[0].status, 'cancelled');
    assert.equal(f.store.read().runs.length, 1);
    const count = f.store.read().messages.length;
    assert.deepEqual(
      await f.calls.turn(cid, 'turn-test-00000002', audioFixture(), 'audio/wav'),
      stop,
    );
    assert.equal(f.store.read().messages.length, count);
    assert.equal(f.calls.get(cid).status, 'active');
    assert.equal(f.calls.get(cid).listening, false);
  } finally {
    await worker.stop();
    f.store.close();
  }
});
