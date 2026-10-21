import { isMemoryReview, emptyMemoryReply } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
function setup(t) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const computer = {
    enabled: true,
    controller: 'agent',
    epoch: 0,
    assertControl(actor, epoch) {
      if (actor !== this.controller || (epoch !== undefined && epoch !== this.epoch))
        throw Error('Control changed');
    },
    async waitForAgent() {},
  };
  const run = store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Open my website.' }),
  );
  return { store, computer, run };
}
test('private browser tools are hidden unless enabled and cannot be called around owner control', async (t) => {
  const { store, computer, run } = setup(t);
  let seen;
  const provider = {
    async complete(_messages, tools) {
      if (isMemoryReview(_messages)) return emptyMemoryReply();
      seen = tools.map((t) => t.name);
      return { text: 'Ready.', toolCalls: [] };
    },
  };
  await agentReply(store, provider, run, { computer });
  assert(!seen.some((t) => t.startsWith('private_browser_')));
  const privateBrowser = {
    enabled: true,
    observe() {
      throw Error('Must not observe');
    },
  };
  await agentReply(store, provider, run, { computer, privateBrowser });
  assert(seen.includes('private_browser_action') && seen.includes('private_browser_look'));
  await assert.rejects(executeTool(store, 'private_browser_look', {}, { computer }), /not enabled/);
  computer.controller = 'owner';
  computer.epoch++;
  await assert.rejects(
    executeTool(store, 'private_browser_look', {}, { computer, privateBrowser }),
    /Control/,
  );
});
test('agent actions use trusted durable identities, publish only a navigation marker and clear it afterward', async (t) => {
  const { store, computer, run } = setup(t);
  let count = 0;
  const privateBrowser = {
    enabled: true,
    async begin(input, actor) {
      count++;
      assert.equal(input.operationId, 'trusted:run:call');
      assert.equal(actor, 'agent');
      return { id: input.operationId, phase: 'running' };
    },
    async waitForAction(id, { guard }) {
      guard();
      assert.equal(store.read().runs[0].privateBrowserAction, id);
      return { id, phase: 'completed' };
    },
    async observe(actor) {
      assert.equal(actor, 'agent');
      return { untrusted: true, content: [{ name: 'Saved' }] };
    },
  };
  const output = await executeTool(
    store,
    'private_browser_action',
    { action: 'open', url: 'https://example.com', operationId: 'model-controlled' },
    {
      computer,
      privateBrowser,
      runId: run.id,
      threadId: run.threadId,
      operationId: 'trusted:run:call',
    },
  );
  assert.equal(count, 1);
  assert.equal(output.result.receipt.phase, 'completed');
  assert.deepEqual(output.card, { kind: 'navigation', page: 'computer', title: 'Open browser' });
  assert.equal(store.read().runs[0].privateBrowserAction, undefined);
});
test('taking control during a tool discards its observation and removes the waiting marker', async (t) => {
  const { store, computer, run } = setup(t);
  let observed = false;
  const privateBrowser = {
    enabled: true,
    async begin() {
      return { id: 'handoff', phase: 'running' };
    },
    async waitForAction(_id, { guard }) {
      computer.controller = 'owner';
      computer.epoch++;
      guard();
    },
    async observe() {
      observed = true;
    },
  };
  await assert.rejects(
    executeTool(
      store,
      'private_browser_action',
      { action: 'open' },
      { computer, privateBrowser, runId: run.id, threadId: run.threadId, operationId: 'handoff' },
    ),
    /Control/,
  );
  assert.equal(observed, false);
  assert.equal(store.read().runs[0].privateBrowserAction, undefined);
});
test('stopping a run cancels its pending browser action without affecting an unrelated receipt', async (t) => {
  const { store, computer } = setup(t);
  const browser = new TrustedBrowser(store, {
    key: randomBytes(32),
    control: computer,
    enabled: true,
  });
  try {
    for (const id of ['stopped', 'other'])
      store.db
        .prepare('INSERT INTO trusted_browser_actions VALUES (?,?,?,?,?,?)')
        .run(id, 'digest', 'agent', id === 'stopped' ? 'running' : 'completed', '', 'now');
    browser.active = { id: 'stopped' };
    const abort = new AbortController();
    const waiting = browser.waitForAction('stopped', { signal: abort.signal });
    await delay(10);
    abort.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(browser.action('stopped').phase, 'interrupted');
    assert.equal(browser.action('other').phase, 'completed');
    assert.equal(browser.active, null);
  } finally {
    await browser.close();
  }
});
test('durable agent recovery reads an interrupted browser receipt without replaying or claiming success', async (t) => {
  const { store, computer, run } = setup(t);
  const call = {
    id: 'open',
    type: 'function',
    function: {
      name: 'private_browser_action',
      arguments: JSON.stringify({ action: 'open', url: 'https://example.com' }),
    },
  };
  const journal = new AgentCheckpoint(store, run.id);
  journal.save('acting', {
    messages: [
      { role: 'system', content: 'old' },
      { role: 'assistant', content: null, tool_calls: [call] },
    ],
    cards: [],
    prefix: '',
    round: 0,
    nextTool: 0,
    response: { text: '', toolCalls: [call] },
  });
  let checks = 0;
  const privateBrowser = {
    enabled: true,
    async begin(input) {
      assert.equal(input.operationId, `artifact:${run.id}:0:0:open`);
      checks++;
      return { id: input.operationId, phase: 'interrupted', repeated: true };
    },
    async waitForAction(id) {
      return { id, phase: 'interrupted' };
    },
    async observe() {
      throw Error('Interrupted actions must not be treated as completed');
    },
  };
  const provider = {
    async complete(messages) {
      if (isMemoryReview(messages)) return emptyMemoryReply();
      const output = JSON.parse(messages.findLast((m) => m.role === 'tool').content).result;
      assert.equal(output.receipt.phase, 'interrupted');
      assert.match(output.instruction, /do not repeat/);
      return { text: 'I stopped without repeating the action.', toolCalls: [] };
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    { computer, privateBrowser },
    { durable: true },
  );
  assert.equal(checks, 1);
  assert.match(result.text, /without repeating/);
  assert.equal(journal.load().phase, 'final');
});
test('pending navigation reviews stay visible without waiting for a page screenshot', async (t) => {
  const { store, computer } = setup(t);
  const browser = new TrustedBrowser(store, {
    key: randomBytes(32),
    control: computer,
    enabled: true,
  });
  try {
    store.db
      .prepare('INSERT INTO trusted_browser_actions VALUES (?,?,?,?,?,?)')
      .run('loading', 'digest', 'agent', 'running', '', 'now');
    browser.active = { id: 'loading' };
    browser.ownerScreen = async () => {
      throw Error('A screenshot would block navigation');
    };
    const view = await browser.ownerView();
    assert.equal(view.action.id, 'loading');
    assert.deepEqual(view.requests, []);
  } finally {
    await browser.close();
  }
});

test('a new action or takeover wakes an already waiting preview without exposing a late screenshot', async (t) => {
  const { store, computer } = setup(t);
  const browser = new TrustedBrowser(store, {
    key: randomBytes(32),
    control: computer,
    enabled: true,
  });
  let finishScreen, finishRun;
  const session = {
    actor: 'agent',
    controlEpoch: computer.epoch,
    controller: new AbortController(),
    context: {
      async storageState() {
        return { cookies: [], origins: [] };
      },
      async close() {},
    },
  };
  browser.session = session;
  browser.ensure = async () => session;
  browser.ownerScreen = () =>
    new Promise((resolve) => {
      finishScreen = resolve;
    });
  browser.run = () =>
    new Promise((resolve) => {
      finishRun = resolve;
    });
  const promptly = (promise) =>
    Promise.race([
      promise,
      delay(500).then(() => {
        throw Error('Preview blocked the review');
      }),
    ]);
  try {
    const waiting = browser.ownerView();
    assert.equal(browser.viewWaiters.size, 1);
    await browser.begin({ operationId: 'race', action: 'open', url: 'https://account.example' });
    const active = browser.active;
    const view = await promptly(waiting);
    assert.equal(view.action.id, 'race');
    assert.equal(view.screenshot, undefined);
    assert.equal(browser.viewWaiters.size, 0);
    finishScreen({ screenshot: 'late-private-pixels' });
    finishRun();
    await active.done;
    const takeoverView = browser.ownerView();
    computer.controller = 'owner';
    computer.epoch++;
    browser.syncControl();
    const afterTakeover = await promptly(takeoverView);
    assert.equal(afterTakeover.controller, 'owner');
    assert.equal(afterTakeover.screenshot, undefined);
    finishScreen({ screenshot: 'old-actor-pixels' });
    assert.equal(browser.viewWaiters.size, 0);
  } finally {
    finishScreen?.({});
    finishRun?.();
    await browser.close();
  }
});
