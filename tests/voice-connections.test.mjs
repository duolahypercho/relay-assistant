// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { voiceConnectionsFixture } from '../scripts/voice-connections-fixture.mjs';
import { audioFixture } from '../scripts/audio-fixture.mjs';
const draft = (more = {}) => ({
  revision: 0,
  action: 'save',
  baseUrl: 'http://127.0.0.1:12345/v1',
  model: 'controlled-audio',
  voice: 'calm',
  apiKey: 'private-audio-key',
  ...more,
});
test('voice connections persist encrypted, redact keys, and retain off state across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-voice-vault-'));
  let store;
  try {
    const key = modelVaultKey(dir);
    store = new Store(join(dir, 'state.sqlite'), { sample: false });
    const v = new VoiceConnections(store, { key, environment: { speech: draft() } });
    assert.equal(v.speech.configured, true);
    v.update('transcription', draft());
    v.update('speech', { revision: 0, action: 'select', mode: 'off' });
    for (const value of [v.publicState(), store.read(), store.secret('voice-connections')])
      assert.ok(!JSON.stringify(value).includes('private-audio-key'));
    assert.throws(
      () => new VoiceConnections(store, { key: Buffer.alloc(32) }),
      /could not be unlocked/,
    );
    store.close();
    store = new Store(join(dir, 'state.sqlite'), { sample: false });
    const reopened = new VoiceConnections(store, {
      key: modelVaultKey(dir),
      environment: { speech: draft() },
    });
    assert.equal(reopened.transcription.configured, true);
    assert.equal(reopened.record('transcription').apiKey, 'private-audio-key');
    assert.equal(reopened.speech.configured, false);
    reopened.update('transcription', { revision: 1, action: 'remove' });
    assert.equal(reopened.publicState().transcription.saved, null);
    assert.equal(reopened.transcription.configured, false);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('voice settings reject stale edits, invalid endpoints, injection and silent credential forwarding', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const v = new VoiceConnections(store, { key: Buffer.alloc(32, 4) });
    for (const baseUrl of [
      'http://example.com/v1',
      'https://user:key@example.com',
      'https://example.com/?key=secret',
      'https://example.com/#key',
      'file:///tmp',
      'http://169.254.169.254',
    ])
      assert.throws(() => v.update('speech', draft({ baseUrl })));
    for (const value of [{ model: '' }, { voice: '' }, { apiKey: 'key\nheader' }])
      assert.throws(() => v.update('speech', draft(value)));
    v.update('speech', draft());
    assert.throws(() => v.update('speech', draft()), /another window/);
    assert.throws(() => v.update('invalid', draft()), /listening or speaking/);
    v.update('speech', draft({ revision: 1, apiKey: undefined, model: 'new-model' }));
    assert.equal(v.record('speech').apiKey, 'private-audio-key');
    v.update(
      'speech',
      draft({ revision: 2, apiKey: undefined, baseUrl: 'https://different.example/v1' }),
    );
    assert.equal(v.record('speech').apiKey, '');
    v.update('speech', draft({ revision: 3 }));
    v.update('speech', draft({ revision: 4, apiKey: '' }));
    assert.equal(v.record('speech').apiKey, '');
    assert.throws(
      () => v.update('transcription', { revision: 0, action: 'select', mode: 'saved' }),
      /Save a connection/,
    );
    assert.throws(
      () => v.update('transcription', { revision: 0, action: 'select', mode: 'environment' }),
      /No voice connection/,
    );
  } finally {
    store.close();
  }
});
async function withFixture(run, options) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-voice-settings-'));
  const f = await voiceConnectionsFixture(dir, options);
  try {
    await run(f);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test('saved voice services send real multipart and WAV requests; tests never write chat history or audio memos', () =>
  withFixture(async (f) => {
    const v = f.voiceConnections,
      before = f.store.read();
    const input = draft({ baseUrl: f.baseUrl });
    const recording = { data: audioFixture(0.3).toString('base64'), mime: 'audio/wav' };
    assert.deepEqual(await v.test('transcription', { ...input, recording }), {
      text: 'Plan a quiet afternoon.',
    });
    const testAudio = await v.test('speech', input);
    assert.equal(Buffer.from(testAudio.audio, 'base64').toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(f.store.read(), before);
    assert.equal(v.speech.configured, false);
    v.update('speech', input);
    v.update('transcription', input);
    assert.equal(v.speech.destination, new URL(f.baseUrl).host);
    assert.deepEqual(await v.transcription.transcribe(audioFixture(0.3), 'audio/wav'), {
      text: 'Plan a quiet afternoon.',
    });
    const card = await v.speech.createMemo(f.store, {
      text: 'Listen to this reply.',
      sourceKey: 'saved-connection-test',
    });
    assert.ok(f.store.voiceMemo(card.id).audio.length > 44);
    assert.equal(f.requests.filter((r) => r.kind === 'speech').at(-1).voice, 'calm');
    assert.ok(f.requests.every((r) => r.key === 'Bearer private-audio-key'));
    assert.deepEqual(f.requests.find((r) => r.kind === 'transcription').bytes, audioFixture(0.3));
  }));
test('pending audio and active calls prevent provider edits; cancelled tests release the guard', () =>
  withFixture(async (f) => {
    const v = f.voiceConnections,
      input = draft({ baseUrl: f.baseUrl });
    v.update('speech', input);
    f.controls.hold = true;
    const abort = new AbortController();
    const pending = v.test('speech', { ...input, revision: 1 }, abort.signal);
    const rejection = assert.rejects(pending, /cancelled/);
    assert.throws(
      () => v.update('speech', { revision: 1, action: 'remove' }),
      /Finish the voice chat/,
    );
    await assert.rejects(v.test('speech', { ...input, revision: 1 }), /already in progress/);
    abort.abort();
    await rejection;
    v.update('speech', { revision: 1, action: 'select', mode: 'off' });
    f.store.mutate((s) => {
      s.voiceCalls = [{ id: 'active-test-call', status: 'active' }];
    });
    assert.throws(() => v.update('transcription', input), /Finish the voice chat/);
    f.store.mutate((s) => {
      s.voiceCalls[0].status = 'ended';
    });
    v.update('transcription', input);
  }));
test('invalid or oversized audio is rejected before outbound I/O and provider failures stay redacted', () =>
  withFixture(async (f) => {
    const v = f.voiceConnections,
      input = draft({ baseUrl: f.baseUrl });
    for (const recording of [
      null,
      { data: 'not-base64' },
      { data: 'a'.repeat(11184816) },
      { data: Buffer.alloc(44).toString('base64'), mime: 'audio/wav' },
    ])
      await assert.rejects(v.test('transcription', { ...input, recording }));
    assert.equal(f.requests.length, 0);
    await assert.rejects(
      v.test('speech', { ...input, apiKey: 'rejected-key' }),
      (e) => e.message.includes('HTTP 401') && !e.message.includes('rejected-key'),
    );
    assert.equal(v.pending.speech, 0);
  }));
test('voice settings APIs enforce owner access, same origin, secret-free state and runtime activation', () =>
  withFixture(
    async (f) => {
      const path = f.url + '/api/voice-connections';
      assert.equal((await fetch(path)).status, 401);
      const login = await fetch(f.url + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'owner-test-key' }),
      });
      const headers = {
        'Content-Type': 'application/json',
        Cookie: login.headers.get('set-cookie').split(';')[0],
      };
      const input = draft({ baseUrl: f.baseUrl });
      assert.equal(
        (
          await fetch(path + '/speech/save', {
            method: 'POST',
            headers: { ...headers, Origin: 'https://outsider.invalid' },
            body: JSON.stringify(input),
          })
        ).status,
        403,
      );
      const saved = await fetch(path + '/speech/save', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(saved.status, 200);
      assert.ok(!(await saved.text()).includes('private-audio-key'));
      const state = await (await fetch(f.url + '/api/state', { headers })).json();
      assert.equal(state.connections.runtime.speech.configured, true);
      assert.ok(!JSON.stringify(state).includes('private-audio-key'));
      const stale = await fetch(path + '/speech/save', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(stale.status, 409);
      const tested = await fetch(path + '/speech/test', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, revision: 1, apiKey: undefined }),
      });
      assert.equal(tested.status, 200);
      assert.equal((await tested.json()).mime, 'audio/wav');
      assert.equal(f.store.read().messages.length, 0);
    },
    { accessKey: 'owner-test-key' },
  ));
