// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool, toolDefinitions } from '../server/agent.mjs';
import { voiceToolCatalog, loadVoiceTools } from '../server/voice-tool-catalog.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';

const lookups = [
  'list_skills',
  'list_assistants',
  'list_groups',
  'list_routines',
  'list_files',
  'summarize_finance',
  'search_mail',
  'read_mail',
  'list_calendar',
];
const call = (name, args = {}, id = name) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const response = (...toolCalls) => ({ text: '', toolCalls });
const done = (text = 'Paper kite 42') => ({ text, toolCalls: [] });
function fixture(t, path = ':memory:') {
  const f = { store: new Store(path, { sample: false }) };
  t.after(() => f.store.close());
  f.run = f.store.mutate((s) => {
    s.profile.memoryLearning = false;
    command(s, 'skill.create', {
      title: 'Paper kite 42',
      slug: 'paper-kite',
      instructions: 'Review the week.',
    });
    s.mail = [
      {
        id: 'trip',
        from: 'Travel desk',
        email: 'desk@example.invalid',
        subject: 'November receipt',
        body: 'Pickup word: AZURE. Meet at the north gate.',
        date: '2026-10-21',
      },
      {
        id: 'other',
        from: 'Travel club',
        email: 'club@example.invalid',
        subject: 'Travel ideas',
        body: 'Receipt advice: take the north route to the garden gate.',
        date: '2026-10-20',
      },
      {
        id: 'chinese',
        from: '旅行服务',
        subject: '行程收据',
        body: '取件码：蓝鹭。',
        date: '2026-10-19',
      },
    ];
    return command(s, 'chat.send', {
      threadId: 'main',
      text: 'What methods have I saved? Give their names.',
    });
  });
  return f;
}

test('common lookups expose complete schemas while writes, disabled tools and deferred instructions retain their boundaries', () => {
  const catalog = voiceToolCatalog(toolDefinitions);
  for (const name of lookups) {
    assert.deepEqual(
      catalog.find((t) => t.name === name),
      toolDefinitions.find((t) => t.name === name),
    );
    assert(!catalog[0].parameters.properties.names.items.enum.includes(name));
  }
  for (const name of [
    'save_skill',
    'manage_skill',
    'prepare_email',
    'prepare_calendar',
    'create_routine',
  ])
    assert(!catalog.some((t) => t.name === name));
  const limited = toolDefinitions.filter(
    (t) => !['list_assistants', 'search_mail'].includes(t.name),
  );
  assert(
    !voiceToolCatalog(limited, ['list_assistants', 'search_mail']).some((t) =>
      ['list_assistants', 'search_mail'].includes(t.name),
    ),
  );
  assert.throws(() => loadVoiceTools(limited, [], { names: ['search_mail'] }), /exact names/);
  assert.throws(
    () => loadVoiceTools(toolDefinitions, [], { names: ['computer_files'] }),
    /exact names/,
  );
  assert.deepEqual(loadVoiceTools(limited, ['search_mail'], { names: ['list_skills'] }), [
    'list_skills',
  ]);
});

for (const voice of [false, true])
  test(`${voice ? 'voice' : 'local Quick typed'} lookup reads actual saved data on the first model turn without discovery`, async (t) => {
    const f = fixture(t);
    if (voice) f.run.voiceCallId = 'direct-lookups';
    const before = f.store.read();
    let count = 0;
    const result = await agentReply(
      f.store,
      {
        compactTools: !voice,
        complete: async (messages, tools) => {
          for (const name of lookups) assert(tools.some((t) => t.name === name));
          if (++count === 1) {
            assert.deepEqual(f.store.read(), before, 'Advertising a read must not perform work');
            return response(call('list_skills'));
          }
          const value = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
          assert.equal(value.result[0].title, 'Paper kite 42');
          assert.equal(value.result[0].slug, 'paper-kite');
          return done(value.result[0].title);
        },
      },
      f.run,
      {},
      { durable: true },
    );
    assert.equal(count, 2);
    assert.equal(result.text, 'Paper kite 42');
    assert.deepEqual(f.store.read(), before);
    assert.deepEqual(
      await agentReply(
        f.store,
        { complete: () => assert.fail('Repeated completed lookup') },
        f.run,
        {},
        { durable: true },
      ),
      result,
    );
  });

test('a saved pre-upgrade load request resumes through SQLite reopen without executing or duplicating the lookup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-lookup-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(t, join(directory, 'state.sqlite'));
  await assert.rejects(
    agentReply(
      f.store,
      {
        compactTools: true,
        complete: async () => {
          throw Error('Synthetic connection loss');
        },
      },
      f.run,
      {},
      { durable: true },
    ),
    /Synthetic/,
  );
  const journal = new AgentCheckpoint(f.store, f.run.id),
    saved = journal.load();
  const oldCall = call('load_tools', { names: ['list_skills'] }, 'old-discovery');
  saved.response = response(oldCall);
  saved.messages.push({ role: 'assistant', content: null, tool_calls: [oldCall] });
  journal.save('ready', saved);
  f.store.close();
  f.store = new Store(join(directory, 'state.sqlite'), { sample: false });
  f.run = f.store.read().runs.find((r) => r.id === f.run.id);
  let count = 0;
  const result = await agentReply(
    f.store,
    {
      complete: async (messages, tools) => {
        assert(tools.some((t) => t.name === 'list_skills'));
        const value = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
        if (++count === 1) {
          assert.deepEqual(value.result.loaded, ['list_skills']);
          assert.match(value.result.note, /No action was executed/);
          return response(call('list_skills'));
        }
        assert.equal(value.result[0].title, 'Paper kite 42');
        return done();
      },
    },
    f.run,
    {},
    { durable: true },
  );
  assert.equal(count, 2);
  assert.equal(result.text, 'Paper kite 42');
  assert.equal(f.store.read().skills.length, 1);
});

test('stored mail search combines keywords across fields, supports quoted phrases and keeps source messages unchanged', async (t) => {
  const f = fixture(t),
    before = f.store.read();
  for (const [query, expected] of [
    ['travel receipt pickup', ['trip']],
    ['  PICKUP\nReCeIpT  ', ['trip']],
    ['desk@example.invalid azure', ['trip']],
    ['travel "north gate"', ['trip']],
    ['north gate', ['trip', 'other']],
    ['receipt nonexistent', []],
    ['收据 蓝鹭', ['chinese']],
    ['', ['trip', 'other', 'chinese']],
  ]) {
    const result = await executeTool(f.store, 'search_mail', { query });
    assert.deepEqual(
      result.result.map((m) => m.id),
      expected,
      query,
    );
    assert(result.result.every((m) => !Object.hasOwn(m, 'body')));
  }
  const read = await executeTool(f.store, 'read_mail', { id: 'trip' });
  assert.match(read.result.body, /AZURE/);
  assert.deepEqual(f.store.read(), before);
});

test('connected mail passes Google query syntax through and returns only that sync result', async (t) => {
  const f = fixture(t);
  f.store.mutate((s) => {
    s.connections.google.connected = true;
  });
  let synced = 0;
  const result = await executeTool(
    f.store,
    'search_mail',
    {
      query: 'from:Desk@Example.invalid after:2026/10/01 "November receipt"',
    },
    {
      google: {
        sync: async (request) => {
          synced++;
          assert.deepEqual(request, {
            query: 'from:desk@example.invalid after:2026/10/01 "november receipt"',
            includeCalendar: false,
          });
          return { mailIds: ['trip'] };
        },
      },
    },
  );
  assert.equal(synced, 1);
  assert.deepEqual(
    result.result.map((m) => m.id),
    ['trip'],
  );
});
