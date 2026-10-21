// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { Connectors } from '../server/connectors.mjs';
import { connectorEndpoint } from '../server/connector-transport.mjs';
import { command, completeApproval } from '../shared/domain.mjs';
import { recoverWork, BackgroundWorker } from '../server/worker.mjs';
import { connectorFixture } from '../scripts/connectors-fixture.mjs';
import { createApp } from '../server/app.mjs';
import { startHandoff, cancelHandoff } from '../shared/handoffs.mjs';
import { reconcileHandoffs } from '../server/handoffs.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-connectors-')),
    path = join(dir, 'state.sqlite'),
    key = randomBytes(32);
  let store = new Store(path, { sample: false });
  const remote = await connectorFixture(options);
  let connectors = new Connectors(store, { key, timeoutMs: 5000 });
  t.after(async () => {
    connectors.close();
    store.close();
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  });
  const found = await connectors.discover({
    name: 'Notebook',
    endpoint: remote.endpoint,
    token: remote.token,
  });
  const data = connectors.save({
    discoveryId: found.discoveryId,
    permissions: { find_note: 'auto', save_note: 'ask', get_picture: 'auto' },
  });
  const connection = data.connections[0];
  const run = store.mutate((s) => {
    const r = command(s, 'chat.send', {
      threadId: 'main',
      text: 'Find my Sunday plan and save it.',
    });
    r.status = 'running';
    return r;
  });
  const context = {
    assistantId: 'relay',
    runId: run.id,
    threadId: 'main',
    operationId: 'test:lookup',
    guard() {},
  };
  const payload = (toolName = 'find_note', args = { topic: 'Sunday' }) => ({
    connectionId: connection.id,
    revision: connection.revision,
    toolName,
    arguments: args,
  });
  return {
    dir,
    remote,
    connection,
    run,
    context,
    payload,
    get store() {
      return store;
    },
    get connectors() {
      return connectors;
    },
    reopen() {
      store.close();
      store = new Store(path, { sample: false });
      connectors = new Connectors(store, { key, timeoutMs: 5000 });
      return connectors;
    },
  };
}
test('MCP JSON and SSE sessions discover paginated tools, validate inputs, read real results and keep keys private', async (t) => {
  for (const sse of [false, true]) {
    const f = await fixture(t, { sse });
    assert.equal(f.remote.calls.length, 0);
    assert.equal(f.connection.tools.length, 3);
    assert(!JSON.stringify(f.connectors.publicState()).includes(f.remote.token));
    assert(!JSON.stringify(f.store.read()).includes(f.remote.token));
    assert(!f.store.secret('app-connectors').includes(f.remote.token));
    await assert.rejects(
      f.connectors.invoke(f.payload('find_note', { wrong: true }), f.context),
      /arguments/,
    );
    f.remote.setEchoSecret(true);
    const result = await f.connectors.invoke(f.payload(), f.context);
    assert.match(result.content[0].text, /slow Sunday/);
    assert(!JSON.stringify(result).includes(f.remote.token));
    assert.deepEqual(f.remote.calls[0], { name: 'find_note', arguments: { topic: 'Sunday' } });
    assert(f.remote.requests.some((r) => r.body.params?.cursor === 'second'));
    assert(
      f.remote.requests
        .filter((r) => r.body.method !== 'initialize')
        .every((r) => r.session && r.version === '2025-06-18'),
    );
    assert.equal(f.connectors.list('relay')[0].tools[0].inputSchema, undefined);
    assert.equal(
      f.connectors.list('relay', { connectionId: f.connection.id, toolName: 'find_note' })[0]
        .tools[0].inputSchema.type,
      'object',
    );
  }
});
test('reviewed writes freeze arguments, wait for a decision and continue once after completion/restart', async (t) => {
  const f = await fixture(t);
  const p = f.payload('save_note', { title: 'Sunday', body: 'A walk by the water.' });
  const { review } = await f.connectors.invoke(p, { ...f.context, operationId: 'test:write' });
  p.arguments.body = 'Changed after preparing';
  assert.equal(f.remote.calls.length, 0);
  assert.equal(review.payload.arguments.body, 'A walk by the water.');
  await assert.rejects(f.connectors.executeApproval(review), /stopped or changed/);
  f.store.mutate((s) => {
    command(s, 'approval.decide', { id: review.id, decision: 'approve' });
    s.approvals[0].status = 'executing';
  });
  const result = await f.connectors.executeApproval(f.store.read().approvals[0]);
  assert.equal(f.remote.notes.length, 1);
  assert.equal(f.remote.notes[0].body, 'A walk by the water.');
  f.store.mutate((s) => {
    const a = s.approvals[0];
    a.connectorResult = result;
    completeApproval(s, a.id, { connectorResult: result });
  });
  f.connectors.tick();
  assert.equal(f.store.read().runs.length, 1);
  f.store.mutate((s) => {
    s.runs[0].status = 'completed';
  });
  f.connectors.tick();
  f.connectors.tick();
  assert.equal(f.store.read().runs.length, 2);
  const continuation = f.store.read().runs[1];
  assert.equal(continuation.messageId, f.run.messageId);
  assert.equal(
    continuation.connectorContext.result.content[0].text,
    'Saved the Sunday plan in your notebook.',
  );
  f.reopen().tick();
  assert.equal(f.store.read().runs.length, 2);
});
test('Stop now preserves an already dispatched app write and prevents its deferred reply after reopen', async (t) => {
  const f = await fixture(t);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Keep this result', body: 'Approved before stopping.' }),
    { ...f.context, operationId: 'stop-after-dispatch' },
  );
  f.store.mutate((s) => {
    s.runs[0].status = 'completed';
    command(s, 'approval.decide', { id: review.id, decision: 'approve' });
  });
  let release;
  f.remote.setHold(
    new Promise((r) => {
      release = r;
    }),
  );
  const worker = new BackgroundWorker(f.store, { connectors: f.connectors });
  const executing = worker.execute(review.id, new AbortController().signal);
  try {
    for (let i = 0; i < 200 && !f.remote.calls.length; i++) await delay(5);
    assert.equal(f.remote.calls.length, 1);
    f.store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'Stop now', delivery: 'now' }),
    );
    assert.equal(f.store.read().approvals[0].status, 'executing');
  } finally {
    release();
    await executing;
    await worker.stop();
  }
  f.connectors.tick();
  assert.equal(f.remote.notes.length, 1);
  assert.equal(f.store.read().approvals[0].status, 'completed');
  assert.equal(f.store.read().approvals[0].connectorContinuation, 'stopped');
  assert.equal(f.store.read().runs.length, 1);
  assert.equal(f.store.read().receipts.filter((r) => r.approvalId === review.id).length, 1);
  f.reopen().tick();
  assert.equal(f.store.read().runs.length, 1);
});
test('a tool annotated read-only is never automatically retried after a dropped response', async (t) => {
  const f = await fixture(t);
  f.remote.setDisconnect(true);
  await assert.rejects(f.connectors.invoke(f.payload('get_picture', {}), f.context), {
    name: 'UncertainActionError',
  });
  assert.equal(f.remote.calls.length, 1);
  assert.equal(f.store.read().files.length, 0);
});
test('durable operation receipts prevent repeating reads, images and uncertain writes after restart', async (t) => {
  const f = await fixture(t);
  const a = await f.connectors.invoke(f.payload('get_picture', {}), f.context);
  assert.equal(a.fileIds.length, 1);
  assert.equal(f.store.read().files[0].mime, 'image/png');
  assert.deepEqual(await f.connectors.invoke(f.payload('get_picture', {}), f.context), a);
  assert.equal(f.remote.calls.length, 1);
  assert.equal(f.store.read().files.length, 1);
  f.reopen();
  assert.deepEqual(await f.connectors.invoke(f.payload('get_picture', {}), f.context), a);
  assert.equal(f.remote.calls.length, 1);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Once', body: 'Do not repeat.' }),
    { ...f.context, operationId: 'test:uncertain' },
  );
  f.store.mutate((s) => {
    command(s, 'approval.decide', { id: review.id, decision: 'approve' });
    s.approvals[0].status = 'executing';
  });
  f.remote.setDisconnect(true);
  await assert.rejects(f.connectors.executeApproval(f.store.read().approvals[0]), {
    name: 'UncertainActionError',
  });
  f.reopen();
  f.remote.setDisconnect(false);
  await assert.rejects(f.connectors.executeApproval(f.store.read().approvals[0]), {
    name: 'UncertainActionError',
  });
  assert.equal(f.remote.notes.length, 1);
  recoverWork(f.store);
  assert.equal(f.store.read().approvals[0].status, 'outcome_unknown');
});
test('connection changes invalidate pending reviews; schemas, destinations and assistant scope cannot change underneath calls', async (t) => {
  const f = await fixture(t);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'No', body: 'Old endpoint.' }),
    { ...f.context, operationId: 'test:old' },
  );
  f.connectors.update({ id: f.connection.id, revision: 1, enabled: false });
  assert.equal(f.store.read().approvals[0].status, 'failed');
  assert.throws(
    () =>
      f.store.mutate((s) => command(s, 'approval.decide', { id: review.id, decision: 'approve' })),
    /reviewed/,
  );
  await assert.rejects(f.connectors.invoke(f.payload(), f.context), /disabled/);
  assert.equal(f.remote.calls.length, 0);
  f.connectors.update({ id: f.connection.id, revision: 2, enabled: true, assistantIds: ['relay'] });
  assert.deepEqual(f.connectors.list('another-assistant'), []);
  const p = { ...f.payload(), revision: 3 };
  await assert.rejects(
    f.connectors.invoke(p, { ...f.context, assistantId: 'another-assistant' }),
    /unavailable/,
  );
  f.remote.tools[0].inputSchema.properties.topic.maxLength = 2;
  await assert.rejects(f.connectors.invoke(p, f.context), /connect/);
  assert.equal(f.remote.calls.length, 0);
  assert.throws(
    () =>
      f.connectors.update({ id: f.connection.id, revision: 3, permissions: { save_note: 'auto' } }),
    /read-only/,
  );
});
test('declined and cancelled work cannot dispatch or resume an app action', async (t) => {
  const f = await fixture(t);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'No', body: 'No' }),
    { ...f.context, operationId: 'test:decline' },
  );
  f.store.mutate((s) => command(s, 'approval.decide', { id: review.id, decision: 'reject' }));
  await assert.rejects(f.connectors.executeApproval(f.store.read().approvals[0]), /stopped/);
  f.connectors.tick();
  assert.equal(f.store.read().runs.length, 1);
  const { review: a } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Later', body: 'No' }),
    { ...f.context, operationId: 'test:cancel' },
  );
  f.store.mutate((s) => {
    command(s, 'approval.decide', { id: a.id, decision: 'approve' });
    s.approvals[0].status = 'executing';
    s.runs[0].status = 'cancelled';
  });
  await assert.rejects(f.connectors.executeApproval(f.store.read().approvals[0]), /stopped/);
  assert.equal(f.remote.calls.length, 0);
});
test('bearer tokens stay bound to the exact endpoint; redirects and unsupported URLs are rejected', async (t) => {
  const f = await fixture(t);
  const other = await connectorFixture();
  t.after(() => other.close());
  for (const url of [
    'file:///etc/passwd',
    'https://user:pass@example.com/mcp',
    'https://example.com/mcp?key=secret',
    'http://192.168.1.1/mcp',
    'javascript:alert(1)',
  ])
    assert.throws(() => connectorEndpoint(url));
  assert.equal(
    f.connectors.candidate({
      id: f.connection.id,
      revision: 1,
      name: 'Changed',
      endpoint: other.endpoint,
    }).token,
    '',
  );
  f.remote.setRedirect(other.endpoint);
  await assert.rejects(f.connectors.invoke(f.payload(), f.context), /connect/);
  assert.equal(other.requests.length, 0);
  assert.equal(other.calls.length, 0);
});

test('expired and archived reviews never reach the app; archived completed work does not resume', async (t) => {
  const f = await fixture(t);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'No', body: 'No' }),
    { ...f.context, operationId: 'expired' },
  );
  f.store.mutate((s) => {
    s.approvals[0].expiresAt = Date.now() - 1000;
  });
  assert.throws(
    () =>
      f.store.mutate((s) => command(s, 'approval.decide', { id: review.id, decision: 'approve' })),
    /expired/,
  );
  f.store.mutate((s) => {
    s.approvals[0].status = 'executing';
    s.threads[0].archived = true;
  });
  await assert.rejects(f.connectors.executeApproval(f.store.read().approvals[0]), /stopped/);
  f.store.mutate((s) => {
    s.approvals[0].status = 'completed';
    s.runs[0].status = 'completed';
  });
  f.connectors.tick();
  assert.equal(f.store.read().approvals[0].connectorContinuation, 'stopped');
  assert.equal(f.store.read().runs.length, 1);
  assert.equal(f.remote.calls.length, 0);
});

test('revoking an app during a dispatched action records uncertainty and never replays the write', async (t) => {
  const f = await fixture(t);
  let release;
  f.remote.setHold(
    new Promise((r) => {
      release = r;
    }),
  );
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Once', body: 'In flight.' }),
    { ...f.context, operationId: 'revoke' },
  );
  f.store.mutate((s) => command(s, 'approval.decide', { id: review.id, decision: 'approve' }));
  const worker = new BackgroundWorker(f.store, { connectors: f.connectors });
  const pending = worker.execute(review.id, new AbortController().signal);
  try {
    for (let i = 0; !f.remote.calls.length && i < 100; i++) await delay(10);
    assert.equal(f.remote.calls.length, 1);
    f.connectors.remove(f.connection.id);
    await pending;
    assert.equal(f.store.read().approvals[0].status, 'outcome_unknown');
    release();
    await worker.execute(review.id, new AbortController().signal);
    f.connectors.tick();
    assert.equal(f.remote.notes.length, 1);
    assert.equal(f.store.read().runs.length, 1);
  } finally {
    release();
    await worker.stop();
  }
});

test('app error results remain inspectable and do not claim success or trigger a continuation', async (t) => {
  const f = await fixture(t);
  f.remote.setError(true);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Error', body: 'Inspect result.' }),
    { ...f.context, operationId: 'error' },
  );
  f.store.mutate((s) => command(s, 'approval.decide', { id: review.id, decision: 'approve' }));
  const worker = new BackgroundWorker(f.store, { connectors: f.connectors });
  await worker.execute(review.id, new AbortController().signal);
  await worker.stop();
  const a = f.store.read().approvals[0];
  assert.equal(a.status, 'failed');
  assert.equal(a.connectorResult.isError, true);
  assert.match(a.error, /reported an error/);
  f.connectors.tick();
  assert.equal(f.store.read().runs.length, 1);
});

test('connection mutations require an owner session and same-origin requests; state, export and SSE omit credentials', async (t) => {
  const f = await fixture(t);
  const services = {
    connectors: f.connectors,
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
    mode: 'live',
  };
  const key = 'fictional-owner-access-key-long-enough';
  const app = createApp(f.store, services, { host: '127.0.0.1', port: 0, accessKey: key });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/api/connectors')).status, 401);
  assert.equal(
    (
      await fetch(url + '/api/connectors/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.connection.id }),
      })
    ).status,
    401,
  );
  const login = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (
      await fetch(url + '/api/connectors/remove', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://other.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: f.connection.id }),
      })
    ).status,
    403,
  );
  for (const path of ['/api/connectors', '/api/state', '/api/export']) {
    const r = await fetch(url + path, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert(!(await r.text()).includes(f.remote.token));
  }
  const stream = await fetch(url + '/api/events', { headers: { Cookie: cookie } });
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert(!new TextDecoder().decode(first.value).includes(f.remote.token));
  await reader.cancel();
  assert.equal(f.connectors.publicState().connections.length, 1);
});

test('a reviewed continuation freezes its assistant, model and request even after profile edits', async (t) => {
  const f = await fixture(t);
  f.store.mutate((s) => {
    s.runs[0].assistant = { id: 'relay', name: 'Original name', description: 'Original role' };
    s.runs[0].modelConnection = { id: 'original-model', revision: 4 };
    s.runs[0].questionContext = {
      origin: {
        request: 'The exact original question',
        fileIds: [],
        assistant: s.runs[0].assistant,
        connectionGeneration: null,
      },
      answers: [{ question: 'Which day?', answer: 'Sunday' }],
    };
  });
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Frozen', body: 'Original.' }),
    { ...f.context, operationId: 'frozen' },
  );
  f.store.mutate((s) => {
    command(s, 'approval.decide', { id: review.id, decision: 'approve' });
    s.approvals[0].status = 'executing';
    s.profile.assistantName = 'Different name';
  });
  const result = await f.connectors.executeApproval(f.store.read().approvals[0]);
  f.store.mutate((s) => {
    s.runs[0].status = 'completed';
    s.approvals[0].connectorResult = result;
    completeApproval(s, review.id, { connectorResult: result });
  });
  f.connectors.tick();
  const continuation = f.store.read().runs[1];
  assert.equal(continuation.assistant.name, 'Original name');
  assert.deepEqual(continuation.modelConnection, { id: 'original-model', revision: 4 });
  assert.equal(continuation.questionContext.origin.request, 'The exact original question');
  assert.equal(continuation.questionContext.answers[0].answer, 'Sunday');
});

test('specialist handoffs wait for app review and return only after the frozen app continuation finishes', async (t) => {
  const f = await fixture(t);
  const h = f.store.mutate((s) => {
    const role = command(s, 'assistant.create', {
      name: 'Mochi',
      description: 'Keep my notebook.',
      tone: 'Gentle',
      avatarColor: '#a0c5ac',
    });
    const group = command(s, 'group.create', {
      participantIds: ['relay', role.id],
      title: 'Our little team',
    });
    const origin = command(s, 'chat.send', {
      threadId: group.id,
      text: 'Ask Mochi to save the plan.',
      recipientIds: ['relay'],
    });
    origin.modelConnection = { id: 'original-model', revision: 1 };
    const h = startHandoff(
      s,
      origin.id,
      { assistantId: role.id, title: 'Save the plan', request: 'Save our calm Sunday.' },
      'app-handoff',
    );
    origin.status = 'completed';
    return h;
  });
  const child = f.store.read().runs.find((r) => r.id === h.childRunId);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Team Sunday', body: 'A calm plan.' }),
    {
      ...f.context,
      runId: child.id,
      threadId: child.threadId,
      assistantId: child.assistant.id,
      operationId: 'handoff-review',
    },
  );
  f.store.mutate((s) => {
    s.runs.find((r) => r.id === child.id).status = 'completed';
    appendAssistant(
      s,
      child.threadId,
      { text: 'Ready for review.', cards: [{ kind: 'review', id: review.id }] },
      { replyTo: child.messageId },
      child,
    );
  });
  reconcileHandoffs(f.store, {});
  assert.equal(f.store.read().handoffs[0].status, 'needs_input');
  assert(!f.store.read().handoffs[0].continuationId);
  f.store.mutate((s) => command(s, 'approval.decide', { id: review.id, decision: 'approve' }));
  const worker = new BackgroundWorker(f.store, { connectors: f.connectors });
  await worker.execute(review.id, new AbortController().signal);
  await worker.stop();
  f.connectors.tick();
  reconcileHandoffs(f.store, {});
  assert.equal(f.store.read().handoffs[0].status, 'working');
  const continuation = f.store.read().runs.find((r) => r.connectorContext?.reviewId === review.id);
  assert.equal(continuation.threadId, h.threadId);
  assert.equal(continuation.handoffRootId, child.handoffRootId);
  assert.deepEqual(continuation.groupMembers, child.groupMembers);
  f.store.mutate((s) => {
    s.runs.find((r) => r.id === continuation.id).status = 'completed';
    appendAssistant(
      s,
      continuation.threadId,
      { text: 'The plan is saved.', cards: [] },
      { replyTo: continuation.messageId },
      continuation,
    );
  });
  reconcileHandoffs(f.store, {});
  const done = f.store.read().handoffs[0];
  assert.equal(done.status, 'completed');
  assert.equal(
    f.store.read().runs.find((r) => r.id === done.continuationId).handoffContext.result.text,
    'The plan is saved.',
  );
  assert.equal(f.remote.notes.length, 1);
});

test('cancelling a specialist after it prepared an app review prevents the external action', async (t) => {
  const f = await fixture(t);
  const h = f.store.mutate((s) => {
    const a = command(s, 'assistant.create', {
      name: 'Pip',
      description: 'Keep notes.',
      tone: 'Warm',
      avatarColor: '#a0c5ac',
    });
    return startHandoff(
      s,
      f.run.id,
      { assistantId: a.id, title: 'Save plan', request: 'Save Sunday.' },
      'cancel-app-handoff',
    );
  });
  const child = f.store.read().runs.find((r) => r.id === h.childRunId);
  const { review } = await f.connectors.invoke(
    f.payload('save_note', { title: 'Stopped', body: 'Do not send.' }),
    {
      ...f.context,
      runId: child.id,
      threadId: child.threadId,
      assistantId: child.assistant.id,
      operationId: 'cancel-specialist-review',
    },
  );
  f.store.mutate((s) => {
    s.runs.find((r) => r.id === child.id).status = 'completed';
    cancelHandoff(s, h.id);
  });
  const saved = f.store.read().approvals.find((a) => a.id === review.id);
  assert.equal(saved.status, 'rejected');
  const worker = new BackgroundWorker(f.store, { connectors: f.connectors });
  await worker.execute(review.id, new AbortController().signal);
  await worker.stop();
  f.connectors.tick();
  assert.equal(f.remote.notes.length, 0);
  assert(!f.store.read().runs.some((r) => r.connectorContext));
});
