import { isMemoryReview, emptyMemoryWireReply } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatPhotoMessages } from '../server/chat-photos.mjs';
import { capabilityMessages } from '../server/model-capabilities.mjs';
import { ModelProvider } from '../server/model.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { ModelFailover } from '../server/model-failover.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { command } from '../shared/domain.mjs';
import { avatarFixture } from './fixtures/avatar.mjs';
const bytes = avatarFixture({ metadata: false });
const file = {
  id: 'photo',
  name: 'portrait.png',
  mime: 'image/png',
  base64: bytes.toString('base64'),
};
const caps = { tools: false, vision: true, text: true };
const history = [
  { role: 'system', content: 'Tools', chatOnlyContent: 'Chat only' },
  { role: 'user', content: 'Describe it', attachmentIds: [file.id] },
];
const reply = (content = 'A peach shape.') =>
  Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const local = {
  preset: 'ollama',
  protocol: 'chat',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'picture',
};
const prepare = (m, c) => chatPhotoMessages(m, { files: [file] }, c, { requiredIds: [file.id] });
test('photo-only chat sends exact inline bytes without tools or internal fields in all four protocols', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    let body;
    const provider = new ModelProvider({
      ...local,
      protocol,
      getCapabilities: async () => caps,
      fetcher: async (_url, init) => {
        if (init?.body && isMemoryReview(JSON.parse(init.body)))
          return Response.json(emptyMemoryWireReply());
        body = JSON.parse(init.body);
        if (protocol === 'responses')
          return Response.json({
            output: [
              { type: 'message', content: [{ type: 'output_text', text: 'A peach shape.' }] },
            ],
          });
        if (protocol === 'anthropic')
          return Response.json({
            content: [{ type: 'text', text: 'A peach shape.' }],
            stop_reason: 'end_turn',
          });
        if (protocol === 'gemini')
          return Response.json({
            candidates: [
              { content: { parts: [{ text: 'A peach shape.' }] }, finishReason: 'STOP' },
            ],
          });
        return reply();
      },
    });
    assert.equal(
      (await provider.complete(history, [{ name: 'read_file' }], { prepareMessages: prepare }))
        .text,
      'A peach shape.',
    );
    const payload = JSON.stringify(body);
    assert(payload.includes(file.base64), protocol);
    assert(payload.includes('portrait.png'));
    assert(!payload.includes('attachmentIds'));
    assert(!payload.includes('chatOnlyContent'));
    assert(!body.tools?.length);
  }
  assert.equal(history.length, 2);
  assert.equal(history[1].visual, undefined);
});
test('photos retain chronological association, newest duplicate and original order without reading unrelated files', () => {
  const other = { ...file, id: 'second', name: 'second.png' };
  const messages = [
    history[0],
    { ...history[1], attachmentIds: ['photo', 'second'] },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'user', content: 'Compare', attachmentIds: ['photo'] },
  ];
  const result = chatPhotoMessages(
    messages,
    { files: [file, other, { ...file, id: 'secret', name: 'other-chat.png' }] },
    caps,
  );
  assert.deepEqual(
    result.filter((m) => m.visual).map((m) => /file (\w+)/.exec(m.content)[1]),
    ['second', 'photo'],
  );
  assert.equal(result[3].content, null);
  assert(!JSON.stringify(result).includes('other-chat.png'));
  assert.deepEqual(
    capabilityMessages(messages, { tools: true }).map((m) => m.attachmentIds),
    [undefined, undefined, undefined, undefined],
  );
});
test('current missing, malformed, unsupported, non-photo and oversized attachments fail before inference', async () => {
  const cases = [
    [{ files: [] }, caps, /no longer available/],
    [{ files: [file] }, { ...caps, vision: false }, /cannot read images/],
    [{ files: [{ ...file, mime: 'text/plain' }] }, caps, /cannot open files/],
    [
      { files: [{ ...file, base64: Buffer.from('not an image').toString('base64') }] },
      caps,
      /valid PNG/,
    ],
    [{ files: [{ ...file, base64: 'A'.repeat(11_184_816) }] }, caps, /up to 8 MB/],
  ];
  for (const [workspace, abilities, message] of cases) {
    let calls = 0;
    const provider = new ModelProvider({
      ...local,
      getCapabilities: async () => abilities,
      fetcher: async () => {
        calls++;
        return reply();
      },
    });
    await assert.rejects(
      provider.complete(history, [], {
        prepareMessages: (m, c) => chatPhotoMessages(m, workspace, c, { requiredIds: [file.id] }),
      }),
      message,
    );
    assert.equal(calls, 0);
  }
  const nine = Array.from({ length: 9 }, (_, i) => ({ ...file, id: `image${i}` }));
  assert.throws(
    () =>
      chatPhotoMessages(
        [{ role: 'user', content: 'All', attachmentIds: nine.map((f) => f.id) }],
        { files: nine },
        caps,
        { requiredIds: nine.map((f) => f.id) },
      ),
    /fewer or smaller/,
  );
});
test('older unavailable/unsupported or over-budget photos are explicitly omitted, preserving a new ordinary chat', () => {
  const result = chatPhotoMessages(history, { files: [file] }, { ...caps, vision: false });
  assert(!result.some((m) => m.visual));
  assert.match(result[1].content, /bytes are not included/);
  const nine = Array.from({ length: 9 }, (_, i) => ({ ...file, id: `image${i}` }));
  const messages = nine.map((f) => ({ role: 'user', content: f.id, attachmentIds: [f.id] }));
  const bounded = chatPhotoMessages(messages, { files: nine }, caps, { requiredIds: ['image8'] });
  assert.equal(bounded.filter((m) => m.visual).length, 8);
  assert.match(bounded[0].content, /bytes are not included/);
  assert.match(bounded.at(-1).content, /image8/);
});
test('saved old checkpoints recover only current explicit photos and do not include image bytes in durable history', () => {
  const old = [{ role: 'user', content: 'Describe my photo' }];
  const result = chatPhotoMessages(old, { files: [file] }, caps, { requiredIds: ['photo'] });
  assert.equal(result.filter((m) => m.visual).length, 1);
  assert.equal(old.length, 1);
  assert(!JSON.stringify(old).includes(file.base64));
  assert.equal(chatPhotoMessages(history, { files: [] }, { tools: true }), history);
  const existing = {
    role: 'user',
    content: 'Previously observed photo',
    visual: `data:image/png;base64,${file.base64}`,
  };
  assert.equal(
    chatPhotoMessages([...history, existing], { files: [file] }, caps, {
      requiredIds: ['photo'],
    }).filter((m) => m.visual).length,
    1,
  );
  const full = Array.from({ length: 8 }, (_, i) => ({
    role: 'user',
    content: 'Earlier observation',
    visual: `data:image/png;base64,${i}`,
  }));
  assert.throws(
    () =>
      chatPhotoMessages([...full, ...history], { files: [file] }, caps, { requiredIds: ['photo'] }),
    /fewer or smaller/,
  );
});
test('owner takeover/cancellation during model metadata prevents photo preparation and transmission', async () => {
  let release,
    prepared = 0,
    requests = 0;
  const provider = new ModelProvider({
    ...local,
    getCapabilities: () =>
      new Promise((r) => {
        release = r;
      }),
    fetcher: async () => {
      requests++;
      return reply();
    },
  });
  const result = provider.complete(history, [], {
    prepareMessages: (m, c) => {
      prepared++;
      return prepare(m, c);
    },
    beforeAttempt: () => {
      throw new DOMException('Stopped', 'AbortError');
    },
  });
  release(caps);
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(prepared, 0);
  assert.equal(requests, 0);
});
test('actual worker preserves photo follow-ups through SQLite restart, scopes side/reply chats and never executes actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-photo-worker-'));
  const database = join(directory, 'relay.sqlite');
  const calls = [];
  let store, provider, worker;
  const open = () => {
    store = new Store(database, { sample: false });
    provider = new ModelConnections(store, {
      key: Buffer.alloc(32, 9),
      fetcher: async (url, init) => {
        if (init?.body && isMemoryReview(JSON.parse(init.body)))
          return Response.json(emptyMemoryWireReply());
        if (url.endsWith('/api/show'))
          return Response.json({ capabilities: ['completion', 'vision'] });
        calls.push(JSON.parse(init.body));
        return reply('The supplied photo has a peach shape.');
      },
    });
    worker = new BackgroundWorker(
      store,
      {
        mode: 'live',
        provider,
        google: { configured: false },
        browser: { enabled: false },
        terminal: { enabled: false },
      },
      { pollMs: 10 },
    );
  };
  const send = async (threadId, text, fileIds) => {
    const result = store.mutate((s) => command(s, 'chat.send', { threadId, text, fileIds }));
    const count = calls.length,
      until = Date.now() + 5000;
    while (
      (calls.length === count ||
        store.read().runs.some((r) => ['queued', 'running'].includes(r.status))) &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 15));
    assert.equal(store.read().runs.at(-1).status, 'completed');
    return result;
  };
  try {
    open();
    provider.save({ ...local, activate: true });
    const photo = store.mutate((s) => command(s, 'file.add', file));
    worker.start();
    await send('main', 'Describe my photo', [photo.id]);
    assert.equal(calls[0].tools, undefined);
    assert(JSON.stringify(calls[0]).includes(file.base64));
    const original = store.read().messages.find((m) => m.role === 'user');
    await worker.stop();
    store.close();
    open();
    worker.start();
    await send('main', 'What color is it?');
    assert(JSON.stringify(calls.at(-1)).includes(file.base64));
    const side = store.mutate((s) => command(s, 'thread.create', { title: 'Separate' }));
    await send(side.id, 'Hello');
    assert(!JSON.stringify(calls.at(-1)).includes(file.base64));
    const thread = store.mutate((s) => command(s, 'reply.open', { messageId: original.id }));
    await send(thread.id, 'Describe the original picture');
    assert(JSON.stringify(calls.at(-1)).includes(file.base64));
    assert.equal(store.read().memories.length, 0);
    assert.equal(store.read().files.length, 1);
    const checkpoints = store.db.prepare('SELECT body FROM agent_checkpoints').all();
    assert(checkpoints.every((r) => !r.body.includes(file.base64)));
  } finally {
    await worker?.stop();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('an approved vision-only backup receives exact photos after an outage; an incompatible backup cannot silently discard them', async () => {
  for (const vision of [true, false]) {
    const requests = [];
    const fallback = new ModelFailover(
      [
        { id: 'primary', revision: 1 },
        { id: 'backup', revision: 1 },
      ],
      {
        provider: (record) =>
          new ModelProvider({
            ...local,
            getCapabilities: async () =>
              record.id === 'primary' ? { tools: true, vision: true } : { ...caps, vision },
            fetcher: async (_url, init) => {
              if (init?.body && isMemoryReview(JSON.parse(init.body)))
                return Response.json(emptyMemoryWireReply());
              requests.push({ id: record.id, body: JSON.parse(init.body) });
              return record.id === 'primary' ? new Response('{}', { status: 503 }) : reply();
            },
          }),
      },
    );
    const result = fallback.complete(history, [], { prepareMessages: prepare });
    if (vision) {
      assert.equal((await result).text, 'A peach shape.');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.tools, undefined);
      assert(JSON.stringify(requests[1]).includes(file.base64));
    } else {
      await assert.rejects(result, /cannot read images/);
      assert.equal(requests.length, 1);
    }
  }
});
