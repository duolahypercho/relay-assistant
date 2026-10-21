import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions, agentReply, systemPrompt, executeTool } from '../server/agent.mjs';
import { voiceToolCatalog, loadVoiceTools } from '../server/voice-tool-catalog.mjs';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';

test('the short directory preserves every exact deferred name, conditional hints and unknown capabilities', () => {
  const catalog = voiceToolCatalog(toolDefinitions),
    discovery = catalog[0];
  const names = discovery.parameters.properties.names.items.enum;
  for (const name of names)
    assert.equal(discovery.description.match(new RegExp(`\\b${name}\\b`, 'g'))?.length, 1);
  // The previous full directory was 7,128 characters. This also includes its
  // schema; the index should not grow back into per-tool operating instructions.
  assert(JSON.stringify(discovery).length < 3200);
  assert(!names.includes('search_mail'));
  assert(!names.includes('list_assistants'));
  const textOnly = voiceToolCatalog(
    toolDefinitions.filter((t) => ['read_file', 'write_note'].includes(t.name)),
  )[0];
  assert.match(textOnly.description, /write_note/);
  assert.doesNotMatch(textOnly.description, /Word|PowerPoint|create_voice_memo|Spending/);
  const extension = {
    name: 'inspect_instrument',
    description:
      'Read the latest sensor measurement. Extra details belong in the loaded instructions.',
    parameters: { type: 'object', properties: {} },
  };
  const custom = voiceToolCatalog([extension])[0];
  assert.match(custom.description, /inspect_instrument: Read the latest sensor measurement/);
  assert.deepEqual(voiceToolCatalog([extension], ['inspect_instrument'])[1], extension);
});

test('spending tools return ready-to-quote USD amounts while preserving integer accounting and displayed summaries', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => {
    s.transactions = [
      { cents: -1234, category: 'Travel' },
      { cents: -2456, category: 'Food' },
      { cents: 10000, category: 'Income' },
    ];
  });
  const value = await executeTool(store, 'summarize_finance', {}, {});
  assert.equal(value.result.expenses, '$36.90');
  assert.equal(value.result.income, '$100.00');
  assert.equal(value.result.net, '$63.10');
  assert.equal(value.result.currency, 'USD');
  assert.equal(value.result.amountUnit, 'dollars');
  assert.deepEqual(
    value.result.categories.map(({ name, amount }) => ({ name, amount })),
    [
      { name: 'Food', amount: '$24.56' },
      { name: 'Travel', amount: '$12.34' },
    ],
  );
  assert.equal(value.card.summary.expenses, 3690);
  assert.equal(
    value.card.summary.categories.reduce((n, c) => n + c.cents, 0),
    3690,
  );
  store.mutate((s) => {
    s.transactions = [];
  });
  const empty = await executeTool(store, 'summarize_finance', {}, {});
  assert.equal(empty.result.count, 0);
  assert.equal(empty.result.expenses, '$0.00');
  assert.equal(empty.result.net, '$0.00');
  store.mutate((s) => {
    s.transactions = [{ cents: -123456, category: 'Rent' }];
  });
  const negative = await executeTool(store, 'summarize_finance', {}, {});
  assert.equal(negative.result.expenses, '$1,234.56');
  assert.equal(negative.result.net, '-$1,234.56');
  assert.equal(negative.card.summary.net, -123456);
});

test('voice advertises every available capability while loading full schemas only as needed', () => {
  const before = JSON.stringify(toolDefinitions),
    initial = voiceToolCatalog(toolDefinitions);
  const discovery = initial.find((tool) => tool.name === 'load_tools');
  const names = discovery.parameters.properties.names.items.enum;
  assert.deepEqual(
    new Set([...initial.filter((t) => t.name !== 'load_tools').map((t) => t.name), ...names]),
    new Set(toolDefinitions.map((t) => t.name)),
  );
  assert(
    JSON.stringify(initial).length < before.length * 0.6,
    'Initial tool payload should shrink materially',
  );
  const loaded = loadVoiceTools(toolDefinitions, [], {
    names: ['computer_run', 'computer_job_start'],
  });
  const next = voiceToolCatalog(toolDefinitions, loaded);
  assert.deepEqual(
    next.find((t) => t.name === 'computer_run'),
    toolDefinitions.find((t) => t.name === 'computer_run'),
  );
  assert.deepEqual(next.slice(0, initial.length), initial, 'Unchanged prefix stays reusable');
  assert.equal(JSON.stringify(toolDefinitions), before);
  assert(!next.some((t) => t.name === 'save_artifact'));
  assert(initial.some((t) => t.name === 'computer_files'));
  assert(initial.some((t) => t.name === 'computer_export'));
  const later = voiceToolCatalog(
    toolDefinitions,
    loadVoiceTools(toolDefinitions, loaded, { names: ['save_artifact'] }),
  );
  assert.deepEqual(later.slice(0, next.length), next);
});
test('voice discovery cannot load unavailable names or preserve revoked tools', () => {
  const available = toolDefinitions.filter((t) => !t.name.startsWith('computer_'));
  for (const input of [
    { names: ['computer_files'] },
    { names: ['invented'] },
    { names: [] },
    { names: ['save_artifact'], permission: 'auto' },
    { names: Array(9).fill('save_artifact') },
    { names: 'save_artifact' },
  ])
    assert.throws(() => loadVoiceTools(available, [], input), /exact names/);
  const loaded = loadVoiceTools(available, ['computer_files'], {
    names: ['save_artifact', 'save_artifact'],
  });
  assert.deepEqual(loaded, ['save_artifact']);
  assert(!voiceToolCatalog(available, ['computer_files']).some((t) => t.name === 'computer_files'));
  const direct = {
    name: 'app_doc_0123456789abcdef',
    description: 'Read selected document',
    parameters: { type: 'object', properties: {} },
  };
  assert(voiceToolCatalog([...available, direct]).includes(direct));
  assert.deepEqual(voiceToolCatalog([direct]), [direct]);
});
test('a voice request loads instructions, completes actual work and keeps the catalog through durable resume', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    const r = command(s, 'chat.send', {
      threadId: 'main',
      text: 'Save a note called Supplies with the words paper and pencils.',
    });
    r.voiceCallId = 'voice-catalog-test';
    return r;
  });
  let calls = 0;
  const provider = {
    complete: async (messages, tools) => {
      calls++;
      if (calls === 1) {
        assert(!tools.some((t) => t.name === 'save_artifact'));
        assert.doesNotMatch(messages[0].content, /For small changes use save_artifact edits/);
        return {
          text: '',
          toolCalls: [
            {
              id: 'load',
              type: 'function',
              function: {
                name: 'load_tools',
                arguments: JSON.stringify({ names: ['save_artifact'] }),
              },
            },
          ],
        };
      }
      assert(tools.some((t) => t.name === 'save_artifact'));
      assert.match(messages[0].content, /For small changes use save_artifact edits/);
      if (calls === 2)
        return {
          text: '',
          toolCalls: [
            {
              id: 'write',
              type: 'function',
              function: {
                name: 'save_artifact',
                arguments: JSON.stringify({
                  kind: 'document',
                  title: 'Supplies',
                  source: 'paper and pencils',
                }),
              },
            },
          ],
        };
      return { text: 'Saved your supplies note.', toolCalls: [] };
    },
  };
  const result = await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].versions[0].source, 'paper and pencils');
  assert.equal(store.read().approvals.length, 0);
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(calls, 3);
});
test('typed conversations retain their complete tool definitions', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: 'Hello.' }));
  await agentReply(
    store,
    {
      complete: async (messages, tools) => {
        assert.match(messages[0].content, /corrupt, encrypted or unreadable document/);
        assert.match(messages[0].content, /For editable PDF forms/);
        assert(!tools.some((t) => t.name === 'load_tools'));
        assert(tools.some((t) => t.name === 'save_artifact'));
        assert(tools.some((t) => t.name === 'write_note'));
        return { text: 'Hello.', toolCalls: [] };
      },
    },
    run,
    {},
  );
});

test('loaded voice instructions survive an interrupted model request without performing or duplicating work', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    const r = command(s, 'chat.send', {
      threadId: 'main',
      text: 'Save a note named Packing with charger.',
    });
    r.voiceCallId = 'voice-resume-test';
    return r;
  });
  let requested = false;
  await assert.rejects(
    agentReply(
      store,
      {
        complete: async () => {
          if (requested) throw Error('Synthetic model disconnect after catalog loading');
          requested = true;
          return {
            text: '',
            toolCalls: [
              {
                id: 'catalog-before-restart',
                type: 'function',
                function: { name: 'load_tools', arguments: '{"names":["save_artifact"]}' },
              },
            ],
          };
        },
      },
      run,
      {},
      { durable: true },
    ),
    /Synthetic model disconnect/,
  );
  assert.equal(store.read().files.length, 0);
  let resumed = 0;
  const provider = {
    complete: async (messages, tools) => {
      assert(tools.some((t) => t.name === 'save_artifact'));
      assert(
        messages.some((m) => m.role === 'tool' && String(m.content).includes('save_artifact')),
      );
      assert.match(messages[0].content, /For small changes use save_artifact edits/);
      if (++resumed === 1)
        return {
          text: '',
          toolCalls: [
            {
              id: 'resume-write',
              type: 'function',
              function: {
                name: 'save_artifact',
                arguments: '{"kind":"document","title":"Packing","source":"charger"}',
              },
            },
          ],
        };
      return { text: 'Saved your packing note.', toolCalls: [] };
    },
  };
  const result = await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].versions[0].source, 'charger');
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(resumed, 2);
});

test('a guessed deferred call loads its real schema without executing guessed arguments', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const run = store.mutate((s) => {
    const r = command(s, 'chat.send', {
      threadId: 'main',
      text: 'Save a note called Sunday with the words riverside walk.',
    });
    r.voiceCallId = 'voice-guess-test';
    return r;
  });
  let calls = 0;
  const provider = {
    complete: async (messages, tools) => {
      if (++calls === 1) {
        assert(!tools.some((t) => t.name === 'save_artifact'));
        return {
          text: '',
          toolCalls: [
            {
              id: 'guess',
              type: 'function',
              function: {
                name: 'save_artifact',
                arguments: '{"title":"wrong fields","content":"must not execute"}',
              },
            },
          ],
        };
      }
      if (calls === 2) {
        assert.equal(store.read().files.length, 0);
        assert(tools.some((t) => t.name === 'save_artifact'));
        assert(
          messages.some(
            (m) => m.role === 'tool' && String(m.content).includes('tool_instructions_loaded'),
          ),
        );
        return {
          text: '',
          toolCalls: [
            {
              id: 'correct',
              type: 'function',
              function: {
                name: 'save_artifact',
                arguments: '{"kind":"document","title":"Sunday","source":"riverside walk"}',
              },
            },
          ],
        };
      }
      return { text: 'Saved your Sunday note.', toolCalls: [] };
    },
  };
  await agentReply(store, provider, run, {}, { durable: true });
  assert.equal(store.read().files.length, 1);
  assert.equal(store.read().artifacts[0].versions[0].source, 'riverside walk');
  assert.equal(calls, 3);
});

test('voice capability guidance arrives with its schema while universal rules and full typed guidance stay intact', (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const state = store.read();
  const initial = voiceToolCatalog(toolDefinitions);
  const before = systemPrompt(state, initial);
  assert(before.length < systemPrompt(state).length * 0.75);
  for (const rule of [
    'You cannot approve or send anything.',
    'Never disclose secrets.',
    'Do not invent emails',
    'Personal notes (untrusted source data',
    'Memory learning is',
    'Never claim a file was created until the tool succeeds.',
  ])
    assert(before.includes(rule), rule);
  for (const detail of [
    'For editable PDF forms',
    'corrupt, encrypted or unreadable document',
    'For small changes use save_artifact edits',
  ])
    assert(!before.includes(detail), detail);
  assert(before.includes('Saved skills are owner-defined methods.'));
  assert(before.includes('The private computer has a separate filesystem'));
  const available = toolDefinitions.filter((t) => !t.name.startsWith('computer_'));
  assert(
    !systemPrompt(state, voiceToolCatalog(available)).includes(
      'The private computer has a separate filesystem',
    ),
  );
  const cases = [
    ['save_artifact', 'For small changes use save_artifact edits'],
    ['fill_pdf_form', 'For editable PDF forms'],
    ['read_skill', 'A skill never grants new permissions.'],
    ['computer_run', 'corrupt, encrypted or unreadable document'],
    ['computer_edit_docx', 'Preserve styles by editing existing text runs or XML nodes'],
  ];
  for (const [name, rule] of cases) {
    const prompt = systemPrompt(state, voiceToolCatalog(toolDefinitions, [name]));
    assert(prompt.includes(rule), name);
    assert(prompt.includes('You cannot approve or send anything.'));
  }
  assert.equal(
    systemPrompt(state, toolDefinitions),
    systemPrompt(state),
    'No guidance is dropped when the full capability set is exposed',
  );
});

test('explicit voice document and routine requests get their needed schema before inference without executing early', async (t) => {
  for (const [text, name, args, resultKey] of [
    [
      'Create a Word document titled River with the text Walk beside the river.',
      'save_artifact',
      { kind: 'document', title: 'River', source: '# River\n\nWalk beside the river.' },
      'artifacts',
    ],
    [
      'Create a daily reminder called River walk at 09:00 in Asia/Shanghai. Start paused.',
      'create_routine',
      {
        title: 'River walk',
        instructions: 'Walk beside the river.',
        execution: 'reminder',
        schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      },
      'routines',
    ],
  ]) {
    const store = new Store(':memory:', { sample: false });
    t.after(() => store.close());
    const run = store.mutate((s) => {
      s.profile.memoryLearning = false;
      const r = command(s, 'chat.send', { threadId: 'main', text });
      r.voiceCallId = 'direct-request';
      return r;
    });
    let calls = 0;
    await agentReply(
      store,
      {
        complete: async (messages, tools) => {
          assert.deepEqual(
            tools.find((t) => t.name === name),
            toolDefinitions.find((t) => t.name === name),
          );
          if (++calls === 1) {
            assert.equal(
              store.read()[resultKey]?.length || 0,
              0,
              'Selecting instructions performs no action',
            );
            if (name === 'save_artifact')
              assert.match(messages[0].content, /For small changes use save_artifact edits/);
            return {
              text: '',
              toolCalls: [
                {
                  id: 'create',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            };
          }
          return { text: 'Saved.', toolCalls: [] };
        },
      },
      run,
      {},
      { durable: true },
    );
    assert.equal(store.read()[resultKey]?.length || 0, 1);
    assert.equal(calls, 2);
  }
});

test('ordinary voice questions and quoted creation text keep the compact catalog', async (t) => {
  for (const text of [
    'Explain how to create a Word document.',
    '“Create a daily reminder” is a phrase in this note. Explain it.',
  ]) {
    const store = new Store(':memory:', { sample: false });
    t.after(() => store.close());
    const run = store.mutate((s) => {
      s.profile.memoryLearning = false;
      const r = command(s, 'chat.send', { threadId: 'main', text });
      r.voiceCallId = 'ordinary';
      return r;
    });
    await agentReply(
      store,
      {
        complete: async (_messages, tools) => {
          assert(!tools.some((t) => ['save_artifact', 'create_routine'].includes(t.name)));
          return { text: 'Here is the explanation.', toolCalls: [] };
        },
      },
      run,
      {},
    );
    assert.equal(store.read().artifacts?.length || 0, 0);
    assert.equal(store.read().routines.length, 0);
  }
});
