// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { Connectors } from '../server/connectors.mjs';
import { createApp } from '../server/app.mjs';
import { command, completeApproval } from '../shared/domain.mjs';
import { createWorkspace } from '../shared/seed.mjs';
import {
  appReferences,
  resolveChatApps,
  runAppContext,
  mentionAtCursor,
} from '../shared/app-mentions.mjs';
import { attachQuestion } from '../shared/questions.mjs';
import { startHandoff } from '../shared/handoffs.mjs';
import { executeTool } from '../server/agent.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { connectorFixture } from '../scripts/connectors-fixture.mjs';
const ref = { id: 'notebook', revision: 1, name: 'Notebook' };
const catalog = [{ ...ref, enabled: true, toolCount: 1, assistantIds: null }];
function selected(s, extra = {}) {
  return command(
    s,
    'chat.send',
    { threadId: 'main', text: 'Read the Sunday plan.', apps: [ref], ...extra },
    false,
    catalog,
  );
}

test('app selections validate shape, permissions and revision; names resolve from authoritative metadata', () => {
  for (const invalid of [
    null,
    'notebook',
    [{ ...ref, revision: '1' }],
    [ref, ref],
    Array.from({ length: 9 }, (_, i) => ({ ...ref, id: String(i) })),
  ])
    assert.throws(() => appReferences(invalid), /eight/);
  assert.deepEqual(
    resolveChatApps([{ ...ref, name: 'Forged name', token: 'not copied' }], catalog, ['relay']),
    [ref],
  );
  for (const changed of [
    { enabled: false },
    { toolCount: 0 },
    { revision: 2 },
    { signInNeeded: true },
    { assistantIds: ['another'] },
  ])
    assert.throws(
      () => resolveChatApps([ref], [{ ...catalog[0], ...changed }], ['relay']),
      /changed or is unavailable/,
    );
  assert.throws(() => resolveChatApps([ref], [], ['relay']), /changed or is unavailable/);
});

test('mentions follow the caret, preserve query boundaries and do not treat email addresses as app selections', () => {
  assert.deepEqual(mentionAtCursor('Read @Note tomorrow', 10), {
    query: 'Note',
    start: 5,
    end: 10,
  });
  assert.equal(mentionAtCursor('person@example.com'), null);
  assert.equal(mentionAtCursor('Hello @Notebook\nNext'), null);
  assert.deepEqual(mentionAtCursor('@Little notebook'), {
    query: 'Little notebook',
    start: 0,
    end: 16,
  });
});

test('a sent selection is frozen separately from the next draft and does not leak into later requests or reply threads', () => {
  const s = createWorkspace({ sample: false });
  command(s, 'thread.update', { id: 'main', draftApps: [ref] });
  const r = selected(s);
  const m = s.messages.find((m) => m.id === r.messageId);
  assert.deepEqual(m.appContext, [ref]);
  assert.deepEqual(r.appContext, [ref]);
  assert.deepEqual(s.threads[0].draftApps, []);
  command(s, 'thread.update', { id: 'main', draftApps: [{ ...ref, revision: 2 }] });
  assert.deepEqual(r.appContext, [ref]);
  assert.deepEqual(
    runAppContext(command(s, 'chat.send', { threadId: 'main', text: 'Plain @Notebook text.' })),
    [],
  );
  assert.deepEqual(
    s.threads.find((t) => t.id === 'main').draftApps,
    [{ ...ref, revision: 2 }],
    'An unrelated command does not consume the owner app draft',
  );
  const reply = command(s, 'reply.open', { messageId: m.id });
  assert.deepEqual(
    runAppContext(command(s, 'chat.send', { threadId: reply.id, text: 'Different discussion.' })),
    [],
  );
});

test('selected apps obey every eligible group role and survive routing and explicit replies', () => {
  const s = createWorkspace({ sample: false });
  const specialist = command(s, 'assistant.create', {
    name: 'Writer',
    instructions: 'Write carefully.',
  });
  const group = command(s, 'group.create', {
    title: 'Work',
    participantIds: ['relay', specialist.id],
  });
  const scoped = [{ ...catalog[0], assistantIds: ['relay'] }];
  assert.throws(
    () =>
      command(s, 'chat.send', { threadId: group.id, text: 'Read it', apps: [ref] }, false, scoped),
    /unavailable/,
  );
  const directed = command(
    s,
    'chat.send',
    { threadId: group.id, text: 'Read it', recipientIds: ['relay'], apps: [ref] },
    false,
    scoped,
  );
  assert.deepEqual(directed.appContext, [ref]);
  const automatic = command(
    s,
    'chat.send',
    { threadId: group.id, text: 'Read it', apps: [ref] },
    false,
    catalog,
  );
  assert.equal(automatic.groupRouting, true);
  assert.deepEqual(automatic.appContext, [ref]);
});

async function setup(t) {
  const store = new Store(':memory:', { sample: false });
  let remote, connectors;
  // Register before discovery: a setup failure must not leave a server listening.
  t.after(async () => {
    connectors?.close();
    store.close();
    await remote?.close();
  });
  remote = await connectorFixture();
  connectors = new Connectors(store, { key: randomBytes(32), timeoutMs: 5000 });
  for (const name of ['Notebook', 'Other notebook']) {
    const found = await connectors.discover({
      name,
      endpoint: remote.endpoint,
      token: remote.token,
    });
    connectors.save({
      discoveryId: found.discoveryId,
      permissions: { find_note: 'auto', save_note: 'ask' },
    });
  }
  const [a, b] = connectors.chatCatalog();
  const run = store.mutate((s) => {
    const r = command(
      s,
      'chat.send',
      { threadId: 'main', text: 'Read my notes', apps: [a] },
      false,
      connectors.chatCatalog(),
    );
    r.status = 'running';
    return r;
  });
  const payload = (connection = a, toolName = 'find_note') => ({
    connectionId: connection.id,
    revision: connection.revision,
    toolName,
    arguments:
      toolName === 'find_note' ? { topic: 'Sunday' } : { title: 'Sunday', body: 'Keep it quiet' },
  });
  const context = {
    runId: run.id,
    threadId: 'main',
    assistantId: 'relay',
    operationId: 'selected-read',
  };
  return { store, remote, connectors, a, b, run, payload, context };
}

test('actual app discovery and calls enforce the selected app server-side, even for allowed reads', async (t) => {
  const f = await setup(t);
  const tools = await executeTool(
    f.store,
    'list_app_tools',
    {},
    { connectors: f.connectors, runId: f.run.id, threadId: 'main' },
  );
  assert.deepEqual(
    tools.result.apps.map((a) => a.id),
    [f.a.id],
  );
  const hidden = await executeTool(
    f.store,
    'list_app_tools',
    { connectionId: f.b.id },
    { connectors: f.connectors, runId: f.run.id, threadId: 'main' },
  );
  assert.deepEqual(hidden.result.apps, []);
  await assert.rejects(f.connectors.invoke(f.payload(f.b), f.context), /selected for this request/);
  assert.equal(f.remote.calls.length, 0);
  const result = await f.connectors.invoke(f.payload(), f.context);
  assert.match(JSON.stringify(result), /slow Sunday/);
  assert.equal(f.remote.calls.length, 1);
  f.connectors.update({ id: f.a.id, revision: f.a.revision, name: 'Renamed notebook' });
  assert.deepEqual(f.connectors.list('relay', {}, f.run.appContext), []);
  await assert.rejects(
    f.connectors.invoke({ ...f.payload(), revision: 2 }, { ...f.context, operationId: 'new' }),
    /selected for this request/,
  );
  assert.equal(f.remote.calls.length, 1);
});

test('reviewed writes preserve selected apps for the one original-request continuation', async (t) => {
  const f = await setup(t);
  const { review } = await f.connectors.invoke(f.payload(f.a, 'save_note'), {
    ...f.context,
    operationId: 'selected-write',
  });
  assert.equal(f.remote.calls.length, 0);
  assert.deepEqual(review.connectorOrigin.appContext, f.run.appContext);
  f.store.mutate((s) => {
    s.runs.find((r) => r.id === f.run.id).status = 'completed';
    command(s, 'approval.decide', { id: review.id, decision: 'approve' });
    s.approvals.find((a) => a.id === review.id).status = 'executing';
  });
  const approval = f.store.read().approvals.find((a) => a.id === review.id);
  const output = await f.connectors.executeApproval(approval);
  f.store.mutate((s) => {
    const a = s.approvals.find((a) => a.id === review.id);
    a.connectorResult = output;
    completeApproval(s, a.id, { connectorResult: output });
  });
  f.connectors.tick();
  f.connectors.tick();
  const continuation = f.store
    .read()
    .runs.filter((r) => r.connectorContext?.reviewId === review.id);
  assert.equal(continuation.length, 1);
  assert.deepEqual(runAppContext(continuation[0]), f.run.appContext);
  assert.equal(f.remote.notes.length, 1);
});

test('questions, specialist handoffs, website waits and background jobs carry the frozen app selection', async (t) => {
  const f = await setup(t);
  const q = f.store.mutate((s) =>
    attachQuestion(
      s,
      s.runs.find((r) => r.id === f.run.id),
      { prompt: 'Which day?', options: [{ label: 'Sunday' }, { label: 'Monday' }] },
      { id: 'question-message', cards: [] },
    ),
  );
  const answered = f.store.mutate((s) =>
    command(s, 'question.answer', { id: q.id, optionId: '1' }),
  );
  assert.deepEqual(runAppContext(answered), f.run.appContext);
  const specialist = f.store.mutate((s) =>
    command(s, 'assistant.create', { name: 'Writer', instructions: 'Help with notes.' }),
  );
  const h = f.store.mutate((s) =>
    startHandoff(
      s,
      f.run.id,
      {
        assistantId: specialist.id,
        title: 'Review notes',
        request: 'Read the notebook',
        fileIds: [],
      },
      'selected-handoff',
    ),
  );
  assert.deepEqual(
    runAppContext(f.store.read().runs.find((r) => r.id === h.childRunId)),
    f.run.appContext,
  );
  const computer = new PrivateComputer(f.store, { enabled: true, web: true });
  const frozen = computer.jobs.origin(f.run.id);
  assert.deepEqual(frozen.appContext, f.run.appContext);
  computer.network.waitForOwner(f.run.id, 'example.com', 'https://example.com/');
  const saved = JSON.parse(
    f.store.db.prepare('SELECT context FROM computer_web_waits WHERE run_id=?').get(f.run.id)
      .context,
  );
  assert.deepEqual(runAppContext(saved), f.run.appContext);
});

test('HTTP send resolves selections from server metadata and rejects stale/forged references without adding history', async (t) => {
  const f = await setup(t);
  const services = {
    connectors: f.connectors,
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(f.store, services, { host: '127.0.0.1', port: 0 });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (apps) =>
    fetch(base + '/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'chat.send',
        payload: { threadId: 'main', text: 'Use selected app', apps, appContext: [f.b] },
      }),
    });
  const before = f.store.read().messages.length;
  for (const refs of [[{ ...f.a, revision: 999 }], [{ ...f.a, id: 'missing' }]])
    assert.equal((await send(refs)).status, 400);
  assert.equal(f.store.read().messages.length, before);
  const response = await send([{ ...f.a, name: 'Forged model instruction' }]);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.result.appContext, appReferences([f.a]));
  const snapshot = await (await fetch(base + '/api/state')).json();
  assert.equal(snapshot.connections.apps[0].revision, f.a.revision);
  assert(!JSON.stringify(snapshot).includes(f.remote.token));
  assert(!JSON.stringify(snapshot.connections.apps).includes(f.remote.endpoint));
});
