import {
  isMemoryReview,
  emptyMemoryReply,
  emptyMemoryWireReply,
} from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { BackgroundWorker, recoverWork } from '../server/worker.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import {
  retryReply,
  pruneReplyCheckpoints,
  replyRetryLimit,
  replyRetryLifetime,
} from '../server/chat-retry.mjs';
import { replyRetryReason } from '../shared/chat-retry.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { createApp } from '../server/app.mjs';

function fixture(
  t,
  complete = async () => {
    throw Error('The model connection ended.');
  },
) {
  const store = new Store(':memory:', { sample: false });
  const services = {
    mode: 'live',
    provider: { configured: true, complete },
    google: {},
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 10 });
  services.worker = worker;
  t.after(async () => {
    await worker.stop();
    store.close();
  });
  return { store, services, worker };
}
const send = (store, more = {}) =>
  store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Help with this request.', ...more }),
  );
const fail = async (f, more) => {
  const run = send(f.store, more);
  await f.worker.reply(run.id, new AbortController().signal);
  const failed = f.store.read().runs.find((r) => r.id === run.id);
  assert.equal(failed.status, 'failed');
  return { id: run.id, messageId: failed.retryMessageId };
};

test('retry reuses the original request and preserves the unsent draft, attachments and request count', async (t) => {
  const f = fixture(t);
  const file = f.store.mutate((s) =>
    command(s, 'file.add', { name: 'Note.txt', text: 'Original attachment', mime: 'text/plain' }),
  );
  const input = await fail(f, { fileIds: [file.id], text: 'Read this note.' });
  f.store.mutate((s) =>
    command(s, 'thread.update', {
      id: 'main',
      draft: 'Unsent next thought',
      draftFileIds: [file.id],
    }),
  );
  const before = f.store.read();
  f.services.provider.complete = async (messages) => {
    if (isMemoryReview(messages)) return emptyMemoryReply();
    assert(
      messages.some(
        (m) =>
          m.content ===
          `[Relay timestamp: ${before.messages.find((m) => m.role === 'user').createdAt}]\nRead this note.\nAttached workspace file IDs: ${file.id}`,
      ),
    );
    return { text: 'Ready now.', toolCalls: [] };
  };
  retryReply(f.store, f.services, input);
  assert.throws(() => retryReply(f.store, f.services, input), /no saved recovery point/);
  await f.worker.reply(input.id, new AbortController().signal);
  const after = f.store.read();
  assert.equal(after.runs.length, before.runs.length);
  assert.equal(after.runs[0].status, 'completed');
  assert.equal(after.runs[0].retryCount, 1);
  assert.equal(after.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(after.messages.at(-1).text, 'Ready now.');
  assert.deepEqual(after.threads[0], before.threads[0]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_checkpoints').get().n, 0);
});

test('retrying an older undated checkpoint preserves its history and supplies a canonical request clock', async (t) => {
  const f = fixture(t);
  const input = await fail(f, { text: 'What did I ask for today?' });
  const journal = new AgentCheckpoint(f.store, input.id);
  const saved = journal.load();
  delete saved.timestampedHistory;
  for (const message of saved.messages) {
    if (message.role === 'user')
      message.content = message.content.replace(/^\[Relay timestamp: [^\n]+\]\n/, '');
  }
  journal.save(saved.phase, saved);
  const before = f.store.read();
  const received = before.messages.find((m) => m.role === 'user').createdAt;
  f.services.provider.complete = async (messages) => {
    if (isMemoryReview(messages)) return emptyMemoryReply();
    assert(messages.some((m) => m.content === 'What did I ask for today?'));
    for (const prompt of [messages[0].content, messages[0].chatOnlyContent]) {
      assert(prompt.includes(`Fallback request timestamp for older saved messages: ${received}.`));
      assert(prompt.includes('Prefer any newer dated owner message.'));
    }
    return { text: 'Your original dated request is retained.', toolCalls: [] };
  };
  retryReply(f.store, f.services, input);
  await f.worker.reply(input.id, new AbortController().signal);
  const after = f.store.read();
  assert.equal(after.runs[0].status, 'completed');
  assert.equal(after.runs.length, before.runs.length);
  assert.deepEqual(
    after.messages.filter((m) => m.role === 'user'),
    before.messages.filter((m) => m.role === 'user'),
  );
  assert.equal(after.messages.at(-1).text, 'Your original dated request is retained.');
});

test('a saved result survives failure and SQLite restart; retry resumes after its tool without creating a second file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-retry-restart-'));
  let store = new Store(join(directory, 'db'), { sample: false }),
    worker;
  let calls = 0;
  const services = {
    mode: 'live',
    google: {},
    terminal: { enabled: false },
    provider: {
      configured: true,
      complete: async (messages) => {
        if (isMemoryReview(messages)) return emptyMemoryReply();
        if (++calls === 1)
          return {
            text: '',
            toolCalls: [
              {
                id: 'save',
                type: 'function',
                function: {
                  name: 'save_artifact',
                  arguments: JSON.stringify({
                    kind: 'document',
                    title: 'Saved plan',
                    source: '# Plan\n\nKeep this.',
                  }),
                },
              },
            ],
          };
        throw Error('Connection lost after save.');
      },
    },
  };
  try {
    worker = new BackgroundWorker(store, services);
    const run = send(store);
    await worker.reply(run.id, new AbortController().signal);
    const first = store.read();
    assert.equal(first.artifacts.length, 1);
    assert.equal(first.messages.at(-1).cards[0].id, first.files[0].id);
    await worker.stop();
    store.close();
    store = new Store(join(directory, 'db'), { sample: false });
    recoverWork(store);
    const f = store.read().runs[0];
    assert.equal(f.status, 'failed');
    assert.equal(f.retryable, true);
    services.provider.complete = async (messages) => {
      if (isMemoryReview(messages)) return emptyMemoryReply();
      calls++;
      assert(messages.some((m) => m.role === 'tool' && m.content.includes(first.files[0].id)));
      return { text: 'Your saved plan is ready.', toolCalls: [] };
    };
    worker = new BackgroundWorker(store, services);
    retryReply(store, services, { id: run.id, messageId: f.retryMessageId });
    await worker.reply(run.id, new AbortController().signal);
    assert.equal(calls, 3);
    assert.deepEqual(store.read().artifacts, first.artifacts);
    assert.deepEqual(store.read().files, first.files);
    assert.equal(store.read().messages.at(-1).cards[0].id, first.files[0].id);
  } finally {
    await worker?.stop();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('retry uses the newly selected model while stripping old private provider context and keeping completed tool receipts', async (t) => {
  const f = fixture(t);
  const payloads = [];
  let attempts = 0;
  const provider = new ModelConnections(f.store, {
    key: Buffer.alloc(32, 7),
    fetcher: async (url, init) => {
      if (init?.body && isMemoryReview(JSON.parse(init.body)))
        return Response.json(emptyMemoryWireReply());
      const body = JSON.parse(init.body);
      payloads.push(body);
      if (body.model === 'old') {
        if (++attempts > 1) return new Response('', { status: 503 });
        return Response.json({
          choices: [
            {
              message: {
                content: '',
                reasoning: 'PRIVATE-OLD-THINKING',
                tool_calls: [
                  {
                    id: 'note',
                    type: 'function',
                    function: {
                      name: 'write_note',
                      arguments: '{"name":"kept.txt","text":"Kept exactly once"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      }
      return Response.json({
        choices: [
          { message: { content: 'Recovered with the selected model.' }, finish_reason: 'stop' },
        ],
      });
    },
  });
  provider.save({
    preset: 'custom',
    name: 'Old',
    baseUrl: 'https://old.example/v1',
    protocol: 'chat',
    model: 'old',
    apiKey: 'old-key',
    activate: true,
  });
  f.services.provider = provider;
  const input = await fail(f);
  const files = f.store.read().files;
  assert.equal(files.length, 1);
  provider.save({
    preset: 'custom',
    name: 'New',
    baseUrl: 'https://new.example/v1',
    protocol: 'chat',
    model: 'new',
    apiKey: 'new-key',
    activate: true,
  });
  retryReply(f.store, f.services, input);
  await f.worker.reply(input.id, new AbortController().signal);
  assert.equal(f.store.read().runs[0].status, 'completed');
  assert.equal(payloads.at(-1).model, 'new');
  assert(!JSON.stringify(payloads.at(-1)).includes('PRIVATE-OLD-THINKING'));
  assert(
    payloads.at(-1).messages.some((m) => m.role === 'tool' && m.content.includes(files[0].id)),
  );
  assert.deepEqual(f.store.read().files, files);
});

test('stale, stopped, expired, archived, wrong-message and AI-off retries leave saved work unchanged', async (t) => {
  for (const change of [
    (f) =>
      f.store.mutate((s) => {
        s.runs[0].status = 'cancelled';
      }),
    (f) =>
      f.store.mutate((s) => {
        s.runs[0].retryUntil = Date.now() - 1;
      }),
    (f) =>
      f.store.mutate((s) => {
        s.threads[0].archived = true;
      }),
    (f) => send(f.store, { text: 'A newer request.' }),
    (f) => {
      f.services.provider.configured = false;
    },
    (f, input) => {
      input.messageId = 'wrong-message';
    },
  ]) {
    const f = fixture(t),
      input = await fail(f);
    change(f, input);
    const before = f.store.read();
    assert.throws(() => retryReply(f.store, f.services, input));
    const after = f.store.read();
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.files, before.files);
    assert.deepEqual(after.threads, before.threads);
    assert.equal(after.runs[0].status, before.runs[0].status);
  }
});

test('an interrupted tool action never offers retry or replays the uncertain action', async (t) => {
  const f = fixture(t);
  const run = send(f.store);
  new AgentCheckpoint(f.store, run.id).save('acting', {
    messages: [],
    response: { toolCalls: [{ function: { name: 'write_note' } }] },
    nextTool: 0,
  });
  await f.worker.reply(run.id, new AbortController().signal);
  const failed = f.store.read().runs[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryable, false);
  assert.match(replyRetryReason(f.store.read(), failed), /no saved recovery point/);
  assert.equal(f.store.read().files.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_checkpoints').get().n, 0);
});

test('failed recovery journals are bounded and expire, while active journals survive cleanup', async (t) => {
  const f = fixture(t);
  const now = Date.now();
  f.store.mutate((s) => {
    for (let i = 0; i < replyRetryLimit + 3; i++)
      s.runs.push({
        id: 'failed-' + i,
        status: 'failed',
        retryable: true,
        retryUntil: now + 1000 + i,
      });
    s.runs.push({ id: 'active', status: 'running' });
  });
  for (const run of f.store.read().runs)
    new AgentCheckpoint(f.store, run.id).save('ready', { messages: [], cards: [] });
  pruneReplyCheckpoints(f.store, now);
  assert.equal(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_checkpoints').get().n,
    replyRetryLimit + 1,
  );
  assert.equal(f.store.read().runs.filter((r) => r.retryable).length, replyRetryLimit);
  pruneReplyCheckpoints(f.store, now + replyRetryLifetime);
  assert.deepEqual(
    f.store.db
      .prepare('SELECT run_id FROM agent_checkpoints')
      .all()
      .map((r) => r.run_id),
    ['active'],
  );
});

test('retry remains queued during owner takeover and can be cancelled before any new model call', async (t) => {
  let attempts = 0;
  const f = fixture(t, async () => {
    attempts++;
    throw Error('Try later.');
  });
  const input = await fail(f);
  f.services.computer = { enabled: true, controller: 'owner' };
  retryReply(f.store, f.services, input);
  f.worker.tick();
  assert.equal(attempts, 1);
  assert.equal(f.store.read().runs[0].status, 'queued');
  f.store.mutate((s) => command(s, 'chat.stop', { id: input.id }));
  f.services.computer.controller = 'agent';
  f.worker.tick();
  assert.equal(attempts, 1);
  assert.equal(f.store.read().runs[0].status, 'cancelled');
});

test('HTTP retry is owner-only and same-origin; it returns no private checkpoint state', async (t) => {
  const f = fixture(t),
    input = await fail(f);
  const checkpoint = new AgentCheckpoint(f.store, input.id);
  checkpoint.save('ready', { ...checkpoint.load(), privateRetryMarker: 'PRIVATE-RETRY-CONTEXT' });
  const accessKey = 'retry-owner-key-with-at-least-24-characters';
  const app = createApp(f.store, f.services, { host: '127.0.0.1', port: 0, accessKey });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (headers = {}) =>
    fetch(url + '/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, ...headers },
      body: JSON.stringify({ action: 'chat.retry', payload: input }),
    });
  assert.equal((await post()).status, 401);
  const login = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ key: accessKey }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post({ cookie, origin: 'https://other.example' })).status, 403);
  const response = await post({ cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.status, 'queued');
  assert(!JSON.stringify(body).includes('agent_checkpoints'));
  assert(!JSON.stringify(body).includes('PRIVATE-RETRY-CONTEXT'));
  for (const path of ['/api/state', '/api/export']) {
    const response = await fetch(url + path, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert(!(await response.text()).includes('PRIVATE-RETRY-CONTEXT'));
  }
  assert.equal((await post({ cookie })).status, 400);
});

test('retry retains an existing email review without duplicating or sending it', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    if (++calls === 1)
      return {
        text: '',
        toolCalls: [
          {
            id: 'review',
            function: {
              name: 'prepare_email',
              arguments: JSON.stringify({
                to: 'sample@example.invalid',
                subject: 'Saturday',
                body: 'Tea by the river?',
              }),
            },
          },
        ],
      };
    throw Error('Connection interrupted after preparing a review.');
  });
  const input = await fail(f);
  const before = f.store.read();
  assert.equal(before.approvals.length, 1);
  assert.equal(before.approvals[0].status, 'pending');
  assert.equal(before.messages.at(-1).cards[0].kind, 'review');
  f.services.provider.complete = async (messages) => {
    if (isMemoryReview(messages)) return emptyMemoryReply();
    assert(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'review'));
    return { text: 'The email is ready for your review.', toolCalls: [] };
  };
  retryReply(f.store, f.services, input);
  await f.worker.reply(input.id, new AbortController().signal);
  assert.deepEqual(f.store.read().approvals, before.approvals);
  assert.deepEqual(f.store.read().mail, before.mail);
});

test('side-chat recovery keeps its scope and removed group participants cannot resume', async (t) => {
  const f = fixture(t);
  const act = (a, p) => f.store.mutate((s) => command(s, a, p));
  const side = act('thread.create', { title: 'Saturday side chat' });
  const sideInput = await fail(f, { threadId: side.id });
  f.services.provider.complete = async () => ({ text: 'Side chat recovered.', toolCalls: [] });
  retryReply(f.store, f.services, sideInput);
  await f.worker.reply(sideInput.id, new AbortController().signal);
  assert.equal(f.store.read().messages.at(-1).threadId, side.id);
  assert.equal(f.store.read().messages.filter((m) => m.threadId === 'main').length, 0);
  const assistant = act('assistant.create', {
    name: 'Pip',
    description: 'Write clearly.',
    tone: 'Warm',
    avatarColor: '#9cb3c6',
  });
  const group = act('group.create', {
    title: 'Saturday team',
    participantIds: [assistant.id, 'relay'],
  });
  f.services.provider.complete = async (messages) => {
    if (isMemoryReview(messages)) return emptyMemoryReply();
    throw Error('Temporary interruption');
  };
  const input = await fail(f, { threadId: group.id, recipientIds: [assistant.id] });
  assert.equal(
    replyRetryReason(
      f.store.read(),
      f.store.read().runs.find((r) => r.id === input.id),
    ),
    '',
  );
  const replacement = act('assistant.create', {
    name: 'Lark',
    description: 'Plan trips.',
    tone: 'Warm',
    avatarColor: '#9cb3c6',
  });
  act('group.update', { id: group.id, participantIds: ['relay', replacement.id] });
  assert.throws(() => retryReply(f.store, f.services, input), /no longer in the conversation/);
});

test('a retry follows the latest applied correction and replaces an older failed attempt control', async (t) => {
  let attempts = 0;
  const f = fixture(t, async () => {
    if (++attempts === 1) send(f.store, { text: 'Use Tuesday instead.', delivery: 'now' });
    throw Error('Temporary interruption');
  });
  const first = await fail(f);
  const state = f.store.read(),
    run = state.runs[0];
  assert.equal(state.messages.at(-1).replyTo, state.messages.findLast((m) => m.role === 'user').id);
  assert.equal(replyRetryReason(state, run), '');
  retryReply(f.store, f.services, first);
  await f.worker.reply(first.id, new AbortController().signal);
  const latest = f.store.read().runs[0];
  assert.notEqual(latest.retryMessageId, first.messageId);
  assert.throws(() => retryReply(f.store, f.services, first), /latest failed reply/);
  f.services.provider.complete = async (messages) => {
    if (isMemoryReview(messages)) return emptyMemoryReply();
    assert(
      messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('Use Tuesday instead.'),
      ),
    );
    return { text: 'Tuesday it is.', toolCalls: [] };
  };
  retryReply(f.store, f.services, { id: run.id, messageId: latest.retryMessageId });
  await f.worker.reply(run.id, new AbortController().signal);
  assert.equal(f.store.read().runs[0].status, 'completed');
  assert.equal(f.store.read().runs[0].retryCount, 2);
  assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 2);
});
