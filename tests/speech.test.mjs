import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { SpeechService } from '../server/speech.mjs';
import { createApp } from '../server/app.mjs';
import { agentReply } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { audioFixture } from '../scripts/audio-fixture.mjs';
const audio = audioFixture();
async function harness(handler) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-memo-test-'));
  const path = join(dir, 'workspace.sqlite');
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const speech = new SpeechService({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'test-tts',
    voice: 'coral',
    apiKey: 'private-tts-key',
  });
  const store = new Store(path);
  store.mutate((s) =>
    s.messages.push({
      id: 'assistant-source',
      threadId: 'main',
      role: 'assistant',
      text: 'A short reply worth hearing.',
      cards: [],
    }),
  );
  return {
    dir,
    path,
    store,
    speech,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('voice memo preserves exact transcript and audio across restart; state stays small and duplicate requests do not regenerate', async () => {
  let calls = 0,
    input;
  const h = await harness(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/audio/speech');
    assert.equal(req.headers.authorization, 'Bearer private-tts-key');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    input = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'audio/wav');
    res.end(audio);
  });
  try {
    const card = await h.speech.forMessage(h.store, 'assistant-source');
    assert.equal(card.kind, 'voice');
    assert.equal(card.transcript, 'A short reply worth hearing.');
    assert.deepEqual(input, {
      model: 'test-tts',
      voice: 'coral',
      input: card.transcript,
      response_format: 'wav',
    });
    assert.equal(h.store.read().messages.find((m) => m.id === 'assistant-source').cards.length, 1);
    assert.ok(!JSON.stringify(h.store.read()).includes(audio.toString('base64')));
    assert.deepEqual(await h.speech.forMessage(h.store, 'assistant-source'), card);
    assert.equal(calls, 1);
    const reopened = new Store(h.path);
    assert.deepEqual(Buffer.from(reopened.voiceMemo(card.id).audio), audio);
    assert.equal(reopened.exportVoiceMemos()[0].transcript, card.transcript);
    assert.deepEqual(Buffer.from(reopened.exportVoiceMemos()[0].base64, 'base64'), audio);
    reopened.close();
  } finally {
    await h.close();
  }
});
test('authenticated memo audio supports seeking and downloads; external writes and user-message synthesis are rejected', async () => {
  const h = await harness((_req, res) => res.end(audio));
  const app = createApp(
    h.store,
    { speech: h.speech, provider: {}, google: {}, browser: {}, terminal: {} },
    { host: '127.0.0.1', port: 0, accessKey: 'owner-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (await fetch(url + '/api/messages/assistant-source/voice', { method: 'POST' })).status,
      401,
    );
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'owner-key' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0],
      headers = { Cookie: cookie };
    assert.equal(
      (
        await fetch(url + '/api/messages/assistant-source/voice', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://wrong.invalid' },
        })
      ).status,
      403,
    );
    const response = await fetch(url + '/api/messages/assistant-source/voice', {
      method: 'POST',
      headers,
    });
    assert.equal(response.status, 200);
    const { card } = await response.json();
    const path = `/api/voice-memos/${card.id}/audio`;
    assert.equal((await fetch(url + path)).status, 401);
    const part = await fetch(url + path, { headers: { ...headers, Range: 'bytes=10-29' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-29/${audio.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), audio.subarray(10, 30));
    const suffix = await fetch(url + path, { headers: { ...headers, Range: 'bytes=-12' } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), audio.subarray(-12));
    for (const Range of ['bytes=-0', 'bytes=99999999-', 'bytes=3-1', 'bytes=0-1,8-9', 'bytes=-'])
      assert.equal((await fetch(url + path, { headers: { ...headers, Range } })).status, 416);
    const download = await fetch(url + path + '?download=1', { headers });
    assert.ok(download.headers.get('content-disposition').startsWith('attachment'));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), audio);
    const exported = await (await fetch(url + '/api/export', { headers })).json();
    assert.equal(exported.voiceMemos.length, 1);
    assert.ok(!JSON.stringify(exported).includes('private-tts-key'));
    const user = h.store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'User note' }),
    );
    assert.equal(
      (await fetch(url + `/api/messages/${user.messageId}/voice`, { method: 'POST', headers }))
        .status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  }
});
test('cancelling, changed source and stale run guards prevent committing late audio', async () => {
  let entered, release;
  let waiting = new Promise((r) => (entered = r)),
    finish = new Promise((r) => (release = r));
  const h = await harness(async (_req, res) => {
    entered();
    await finish;
    res.end(audio);
  });
  try {
    const controller = new AbortController();
    const pending = h.speech.forMessage(h.store, 'assistant-source', controller.signal);
    const rejected = assert.rejects(pending, (e) => e.name === 'AbortError');
    await waiting;
    controller.abort();
    release();
    await rejected;
    assert.equal(h.store.exportVoiceMemos().length, 0);
    waiting = new Promise((r) => (entered = r));
    finish = new Promise((r) => (release = r));
    const changed = h.speech.forMessage(h.store, 'assistant-source');
    const mismatch = assert.rejects(changed, (e) => e.status === 409);
    await waiting;
    h.store.mutate((s) => {
      s.messages.find((m) => m.id === 'assistant-source').text = 'Changed';
    });
    release();
    await mismatch;
    assert.equal(h.store.exportVoiceMemos().length, 0);
    await assert.rejects(
      h.speech.createMemo(
        h.store,
        { text: 'Late response', sourceKey: 'run:old' },
        undefined,
        () => {
          throw new DOMException('Stopped', 'AbortError');
        },
      ),
      (e) => e.name === 'AbortError',
    );
    assert.equal(h.store.exportVoiceMemos().length, 0);
  } finally {
    release();
    await h.close();
  }
});
test('speech errors are bounded, redacted and never retried automatically; duplicate active requests are rejected', async () => {
  let kind = 'error',
    calls = 0,
    release,
    entered;
  const held = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r));
  const h = await harness(async (_req, res) => {
    calls++;
    if (kind === 'error') {
      res.writeHead(403);
      res.end('private-tts-key');
    } else if (kind === 'bad') res.end('not audio');
    else if (kind === 'huge') res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
    else if (kind === 'redirect') {
      res.writeHead(302, { Location: '/other' });
      res.end();
    } else {
      entered();
      await held;
      res.end(audio);
    }
  });
  try {
    for (const k of ['error', 'bad', 'huge', 'redirect']) {
      kind = k;
      const before = calls;
      await assert.rejects(
        h.speech.forMessage(h.store, 'assistant-source'),
        (e) => e.status === 502 && !e.message.includes('private-tts-key'),
      );
      assert.equal(calls, before + 1);
      assert.equal(h.speech.active.size, 0);
    }
    kind = 'hold';
    const pending = h.speech.forMessage(h.store, 'assistant-source');
    await started;
    await assert.rejects(h.speech.forMessage(h.store, 'assistant-source'), (e) => e.status === 429);
    release();
    await pending;
    for (const baseUrl of [
      'http://remote.invalid',
      'https://user:pass@example.com',
      'https://example.com/?key=x',
      'file:///tmp',
    ])
      assert.throws(() => new SpeechService({ baseUrl, model: 'x' }));
    await assert.rejects(
      h.speech.createMemo(h.store, { text: 'x'.repeat(4097), sourceKey: 'too-long' }),
      /4,096/,
    );
  } finally {
    release();
    await h.close();
  }
});
test('the model can create a saved voice card through its tool loop and an absent speech service is not advertised', async () => {
  const h = await harness((_req, res) => res.end(audio));
  try {
    const run = h.store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'Please reply with a voice memo.' }),
    );
    let turns = 0;
    const provider = {
      complete: async (_messages, tools) => {
        assert.ok(tools.some((t) => t.name === 'create_voice_memo'));
        return ++turns === 1
          ? {
              text: '',
              toolCalls: [
                {
                  id: 'voice-tool',
                  function: {
                    name: 'create_voice_memo',
                    arguments: JSON.stringify({ text: 'Here is your spoken plan.' }),
                  },
                },
              ],
            }
          : { text: 'Your voice memo is ready.', toolCalls: [] };
      },
    };
    const reply = await agentReply(
      h.store,
      provider,
      run,
      { speech: h.speech },
      { signal: new AbortController().signal },
    );
    assert.equal(reply.cards[0].kind, 'voice');
    assert.equal(reply.cards[0].transcript, 'Here is your spoken plan.');
    assert.deepEqual(Buffer.from(h.store.voiceMemo(reply.cards[0].id).audio), audio);
    await agentReply(
      h.store,
      {
        complete: async (_messages, tools) => {
          assert.ok(!tools.some((t) => t.name === 'create_voice_memo'));
          return { text: 'No voice configured.', toolCalls: [] };
        },
      },
      run,
      {},
      {},
    );
  } finally {
    await h.close();
  }
});
