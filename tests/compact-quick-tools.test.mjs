// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { compactToolCatalogRequested } from '../shared/model-catalog.mjs';
import { ModelProvider } from '../server/model.mjs';
import { ModelFailover, ModelUnavailableError } from '../server/model-failover.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { agentReply, toolDefinitions } from '../server/agent.mjs';
import { textFileToolRequested } from '../server/text-file-completion.mjs';

const local = {
  id: 'local',
  model: 'test',
  protocol: 'chat',
  baseUrl: 'http://127.0.0.1:11434/v1',
  replyMode: 'quick',
};
const call = (name, args) => ({
  text: '',
  toolCalls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const done = { text: 'Done.', toolCalls: [] };
function fixture(t, text = 'Hello.') {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    s.profile.memoryLearning = false;
    return command(s, 'chat.send', { threadId: 'main', text });
  });
  return { store, run };
}

test('compact discovery follows explicit local Quick settings and survives backup selection', (t) => {
  assert.equal(compactToolCatalogRequested(local), true);
  assert.equal(new ModelProvider(local).compactTools, true);
  for (const record of [
    undefined,
    { ...local, replyMode: 'default' },
    { ...local, replyMode: undefined },
    { ...local, baseUrl: 'https://model.example/v1' },
    { ...local, baseUrl: 'http://127.0.0.1:1234/v1' },
    { ...local, protocol: 'responses' },
  ])
    assert.equal(compactToolCatalogRequested(record), false);
  const cloud = {
    ...local,
    id: 'backup',
    replyMode: 'default',
    baseUrl: 'https://backup.example/v1',
  };
  assert.equal(
    new ModelFailover([local, cloud], { selected: 'backup', provider: () => {} }).compactTools,
    true,
  );
  assert.equal(
    new ModelFailover([cloud, local], { selected: 'local', provider: () => {} }).compactTools,
    false,
  );
  const { store, run } = fixture(t);
  const manager = new ModelConnections(store, { key: Buffer.alloc(32, 3) });
  manager.save({ ...local, id: undefined, preset: 'ollama', activate: true, apiKey: '' });
  assert.equal(manager.forRun(run).compactTools, true);
  assert.equal(manager.configured, true);
});

test('Quick typed chat retains the complete capability inventory with a smaller initial prompt', async (t) => {
  const { store, run } = fixture(t);
  let full, compact;
  await agentReply(
    store,
    {
      complete: async (messages, tools) => {
        full = { messages: structuredClone(messages), tools };
        return done;
      },
    },
    run,
    {},
  );
  await agentReply(
    store,
    {
      compactTools: true,
      complete: async (messages, tools) => {
        compact = { messages: structuredClone(messages), tools };
        return done;
      },
    },
    run,
    {},
  );
  const index = compact.tools.find((t) => t.name === 'load_tools');
  assert(index);
  assert.deepEqual(
    new Set([
      ...compact.tools.filter((t) => t.name !== 'load_tools').map((t) => t.name),
      ...index.parameters.properties.names.items.enum,
    ]),
    new Set(full.tools.map((t) => t.name)),
  );
  assert(JSON.stringify(compact.tools).length < JSON.stringify(full.tools).length * 0.6);
  assert(compact.messages[0].content.length < full.messages[0].content.length);
  assert.match(compact.messages[0].content, /You cannot approve or send anything/);
  assert.match(compact.messages[0].content, /capabilities remain available/);
  assert.doesNotMatch(compact.messages[0].content, /owner is in a live voice conversation/);
  assert(!compact.tools.some((t) => t.name.startsWith('computer_')));
  assert.equal(store.read().files.length, 0);
  assert.equal(store.read().approvals.length, 0);
});

test('Quick text-file requests use the real schema immediately and save exactly once', async (t) => {
  const { store, run } = fixture(t, 'Create a plain text file named Map.txt containing Route ✓.');
  let count = 0;
  const result = await agentReply(
    store,
    {
      compactTools: true,
      complete: async (messages, tools) => {
        assert.deepEqual(
          tools.find((t) => t.name === 'write_note'),
          toolDefinitions.find((t) => t.name === 'write_note'),
        );
        assert.match(messages[0].content, /Use write_note with a \.txt name/);
        if (++count === 1) return call('write_note', { name: 'Map.txt', text: 'Route ✓' });
        return done;
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(count, 2);
  assert.equal(store.read().files.length, 1);
  assert.equal(Buffer.from(store.read().files[0].base64, 'base64').toString(), 'Route ✓');
  assert.equal(result.cards[0].kind, 'file');
});

test('typed discovery and loaded instructions survive restart even when the resumed provider is not Quick', async (t) => {
  const { store, run } = fixture(t, 'Save an editable packing checklist with charger.');
  let first = true;
  await assert.rejects(
    agentReply(
      store,
      {
        compactTools: true,
        complete: async (_messages, tools) => {
          if (first) {
            first = false;
            assert(!tools.some((t) => t.name === 'save_artifact'));
            return call('load_tools', { names: ['save_artifact'] });
          }
          throw Error('Synthetic disconnect after discovery');
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Synthetic disconnect/,
  );
  assert.equal(store.read().files.length, 0);
  let count = 0;
  const provider = {
    complete: async (messages, tools) => {
      assert(tools.some((t) => t.name === 'load_tools'));
      assert(tools.some((t) => t.name === 'save_artifact'));
      assert.match(messages[0].content, /For small changes use save_artifact edits/);
      return ++count === 1
        ? call('save_artifact', { kind: 'document', title: 'Packing', source: 'charger' })
        : done;
    },
  };
  const result = await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].versions[0].source, 'charger');
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(count, 2);
});

test('Quick discovery cannot load disabled computer tools or turn guessed arguments into work', async (t) => {
  const { store, run } = fixture(t, 'Save an editable checklist named Kit with paper.');
  let count = 0;
  await agentReply(
    store,
    {
      compactTools: true,
      complete: async (messages, tools) => {
        count++;
        if (count === 1) return call('load_tools', { names: ['computer_run'] });
        assert(!tools.some((t) => t.name === 'computer_run'));
        if (count === 2) {
          assert(
            messages.some((m) => m.role === 'tool' && String(m.content).includes('exact names')),
          );
          return call('save_artifact', { title: 'Guessed', content: 'Do not execute' });
        }
        if (count === 3) {
          assert.equal(store.read().files.length, 0);
          assert(tools.some((t) => t.name === 'save_artifact'));
          assert(
            messages.some(
              (m) => m.role === 'tool' && String(m.content).includes('tool_instructions_loaded'),
            ),
          );
          return call('save_artifact', { kind: 'document', title: 'Kit', source: 'paper' });
        }
        return done;
      },
    },
    run,
    {},
  );
  assert.equal(count, 4);
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].versions[0].source, 'paper');
  assert.equal(store.read().approvals.length, 0);
});

test('legacy typed checkpoints keep full schemas when resumed with a Quick connection', async (t) => {
  const { store, run } = fixture(t, 'Save a note called Kit with paper.');
  let first = true;
  await assert.rejects(
    agentReply(
      store,
      {
        complete: async () => {
          if (first) {
            first = false;
            return call('list_files', {});
          }
          throw Error('Synthetic disconnect');
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Synthetic disconnect/,
  );
  const row = store.db.prepare('SELECT body FROM agent_checkpoints WHERE run_id=?').get(run.id);
  const body = JSON.parse(row.body);
  delete body.compactTools;
  store.db
    .prepare('UPDATE agent_checkpoints SET body=? WHERE run_id=?')
    .run(JSON.stringify(body), run.id);
  let count = 0;
  await agentReply(
    store,
    {
      compactTools: true,
      complete: async (messages, tools) => {
        assert(!tools.some((t) => t.name === 'load_tools'));
        assert(tools.some((t) => t.name === 'save_artifact'));
        assert.match(messages[0].content, /For editable PDF forms/);
        return ++count === 1 ? call('write_note', { name: 'Kit', text: 'paper' }) : done;
      },
    },
    run,
    {},
    { durable: true },
  );
  assert.equal(count, 2);
  assert.equal(store.read().files.length, 1);
});

test('a real fallback boundary retains compact discovery and completes one saved result', async (t) => {
  const { store, run } = fixture(t, 'Save an editable checklist named Kit with paper.');
  const cloud = {
    ...local,
    id: 'backup',
    replyMode: 'default',
    baseUrl: 'https://backup.example/v1',
  };
  let primaryCalls = 0,
    backupCalls = 0,
    switches = 0;
  const provider = new ModelFailover([local, cloud], {
    switchTo: () => switches++,
    provider: (record) => ({
      complete: async (messages, tools) => {
        assert(tools.some((t) => t.name === 'load_tools'));
        if (record.id === local.id) {
          primaryCalls++;
          throw new ModelUnavailableError('Synthetic service outage', 'unavailable');
        }
        backupCalls++;
        assert.doesNotMatch(messages[0].content, /owner is in a live voice conversation/);
        if (backupCalls === 1) return call('load_tools', { names: ['save_artifact'] });
        assert(tools.some((t) => t.name === 'save_artifact'));
        assert.match(messages[0].content, /For small changes use save_artifact edits/);
        if (backupCalls === 2)
          return call('save_artifact', { kind: 'document', title: 'Kit', source: 'paper' });
        return done;
      },
    }),
  });
  await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 3);
  assert.equal(switches, 1);
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].versions[0].source, 'paper');
});

test('text-file hints select explicit outputs without turning email, advice or examples into files', () => {
  for (const text of [
    'Create a downloadable plain text file containing hello.',
    'Save a note called Kit.',
    'Please write a text file named hello.txt.',
    '请帮我创建一个纯文本文件。',
    '請幫我儲存一份筆記。',
  ])
    assert.equal(textFileToolRequested(text), true, text);
  for (const text of [
    'Draft an email for review. Body: "Create a text file".',
    'Write a note to Alex saying hello.',
    'Explain how to create a text file.',
    '“Create a text file” is an example.',
    'Create a text file example in chat only.',
    'Do not save a note.',
    'Save my newsletter attachment.',
    'Create a Word document.',
  ])
    assert.equal(textFileToolRequested(text), false, text);
});

test('a bound plain-file answer preloads writing while an email review keeps it in discovery', async (t) => {
  for (const [request, ready] of [
    ['Create a downloadable plain text file. Ask me for its name first.', true],
    ['Draft an email for review. Ask me for the recipient.', false],
  ]) {
    const { store, run } = fixture(t, 'Meeting Notes');
    run.questionContext = {
      origin: { request, assistant: run.assistant, fileIds: [], appContext: [], steering: [] },
      answers: [{ prompt: 'Missing detail?', answer: 'Meeting Notes' }],
    };
    await assert.rejects(
      agentReply(
        store,
        {
          compactTools: true,
          complete: async (_messages, tools) => {
            assert.equal(
              tools.some((tool) => tool.name === 'write_note'),
              ready,
            );
            assert(
              tools
                .find((tool) => tool.name === 'load_tools')
                .parameters.properties.names.items.enum.includes('write_note'),
            );
            throw Error('Inspected instructions before work');
          },
        },
        run,
        {},
      ),
      /Inspected instructions before work/,
    );
    assert.equal(store.read().files.length, 0);
  }
});

test('legacy unfinished saves keep their completed file or method without another write or version', async (t) => {
  for (const kind of ['text', 'skill']) {
    const { store, run } = fixture(
      t,
      kind === 'text'
        ? 'Create a text file named Legacy.txt.'
        : 'Save a reusable skill titled Legacy.',
    );
    let calls = 0;
    await assert.rejects(
      agentReply(
        store,
        {
          async complete() {
            if (++calls === 1)
              return kind === 'text'
                ? call('write_note', { name: 'Legacy.txt', text: 'Already saved' })
                : call('save_skill', {
                    title: 'Legacy',
                    slug: 'legacy',
                    instructions: 'Already saved',
                  });
            throw Error('Disconnect after saved result');
          },
        },
        run,
        {},
        { durable: true },
      ),
      /Disconnect/,
    );
    store.mutate((s) => {
      if (kind === 'text') delete s.files[0].creation;
      else delete s.skills[0].savedBy;
    });
    const row = store.db.prepare('SELECT body FROM agent_checkpoints WHERE run_id=?').get(run.id);
    const body = JSON.parse(row.body);
    delete body.verifiedSaves;
    delete body.compactTools;
    for (const m of body.messages)
      if (m.role === 'tool') {
        const data = JSON.parse(m.content);
        if (data.result) delete data.result.savedBy;
        m.content = JSON.stringify(data);
      }
    store.db
      .prepare('UPDATE agent_checkpoints SET body=? WHERE run_id=?')
      .run(JSON.stringify(body), run.id);
    let resumed = 0;
    const result = await agentReply(
      store,
      {
        compactTools: true,
        async complete(_messages, tools, options) {
          resumed++;
          assert(!tools.some((t) => t.name === 'load_tools'));
          assert.equal(options.requiresTools, false);
          return done;
        },
      },
      run,
      {},
      { durable: true },
    );
    assert.equal(resumed, 1);
    assert.equal(result.cards.length, 1);
    assert.equal(kind === 'text' ? store.read().files.length : store.read().skills.length, 1);
    if (kind === 'skill') assert.equal(store.read().skills[0].version, 1);
  }
});
