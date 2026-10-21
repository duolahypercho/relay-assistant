// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { ModelProvider } from '../server/model.mjs';
import {
  ModelCapabilities,
  abilitySettings,
  capabilityMessages,
  thinkingMetadata,
  quickReasoningEffort,
} from '../server/model-capabilities.mjs';
import { createApp } from '../server/app.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { command } from '../shared/domain.mjs';
const local = {
  preset: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  protocol: 'chat',
  model: 'small:1b',
  apiKey: '',
};
const response = (content = 'Four.', tools) =>
  Response.json({
    choices: [
      {
        message: { content, ...(tools ? { tool_calls: tools } : {}) },
        finish_reason: tools ? 'tool_calls' : 'stop',
      },
    ],
  });

test('thinking metadata accepts bounded advertised values, and quick replies never guess model support or destinations', async () => {
  const thinking = { values: [false, true], default: true };
  assert.deepEqual(thinkingMetadata(thinking), thinking);
  for (const value of [
    null,
    {},
    { values: [], default: false },
    { values: [true], default: false },
    { values: [42], default: 42 },
    { values: ['x'.repeat(25)], default: 'x'.repeat(25) },
    { values: Array(13).fill(true), default: true },
  ])
    assert.equal(thinkingMetadata(value), null);
  const caps = new ModelCapabilities(async () =>
    Response.json({ capabilities: ['completion', 'thinking'], thinking }),
  );
  const detected = await caps.resolve(local);
  assert.deepEqual(detected.thinking, thinking);
  assert.equal(quickReasoningEffort({ ...local, replyMode: 'quick' }, detected), 'none');
  for (const record of [
    local,
    { ...local, replyMode: 'default' },
    { ...local, replyMode: 'quick', baseUrl: 'https://other.example/v1' },
    { ...local, replyMode: 'quick', protocol: 'responses' },
  ])
    assert.equal(quickReasoningEffort(record, detected), undefined);
  for (const value of [
    {},
    { source: 'unknown', thinking },
    { source: 'ollama', thinking: { values: ['low', 'high'], default: 'high' } },
  ])
    assert.equal(quickReasoningEffort({ ...local, replyMode: 'quick' }, value), undefined);
});

test('local reply style persists with the connection, preserves legacy defaults and is reset when changing destination', () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const manager = new ModelConnections(store, { key: Buffer.alloc(32, 6) });
    const saved = manager.save(local);
    assert.equal(manager.current.replyMode, 'quick');
    const binding = manager.binding();
    manager.save({ ...local, id: saved.id, replyMode: 'default' });
    assert.equal(manager.current.replyMode, 'default');
    assert.throws(() => manager.records(binding), /changed|available/);
    const state = manager.read();
    delete state.connections[0].replyMode;
    manager.write(state);
    manager.save({ ...local, id: saved.id });
    assert.equal(
      manager.current.replyMode,
      'default',
      'Legacy settings retain the provider default.',
    );
    manager.save({ ...local, id: saved.id, model: 'new-model' });
    assert.equal(manager.current.replyMode, 'quick');
    manager.save({ ...local, id: saved.id, baseUrl: 'http://127.0.0.1:1234/v1' });
    assert.equal(manager.current.replyMode, undefined);
    assert.throws(() => manager.save({ ...local, replyMode: 'always' }), /Quick replies/);
    assert.throws(
      () => manager.save({ ...local, replyMode: 'quick', baseUrl: 'https://other.example/v1' }),
      /Quick replies/,
    );
  } finally {
    store.close();
  }
});

test('quick replies reach only the advertised local chat wire and do not alter tools, answer limits or default mode', async () => {
  const requests = [];
  const make = (replyMode, capabilities) =>
    new ModelProvider({
      ...local,
      replyMode,
      getCapabilities: async () => capabilities,
      fetcher: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return response();
      },
    });
  const capabilities = {
    source: 'ollama',
    tools: true,
    thinking: { values: [false, true], default: true },
  };
  const messages = [{ role: 'user', content: 'What is 2 + 2?' }];
  const tools = [
    { name: 'lookup', description: 'Read', parameters: { type: 'object', properties: {} } },
  ];
  await make('quick', capabilities).complete(messages, tools);
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.equal(requests[0].max_tokens, 5000);
  assert.equal(requests[0].tools[0].function.name, 'lookup');
  await make('default', capabilities).complete(messages);
  await make('quick', { source: 'unknown' }).complete(messages);
  assert(requests.slice(1).every((r) => r.reasoning_effort === undefined));
});

test('an unfinished reasoning response gives a supported remedy without retrying or executing truncated tools', async () => {
  let calls = 0;
  const provider = new ModelProvider({
    ...local,
    getCapabilities: async () => ({
      source: 'ollama',
      thinking: { values: [false, true], default: true },
    }),
    fetcher: async () => {
      calls++;
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 'Still considering.',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'incomplete',
                      function: { name: 'write_note', arguments: '{' },
                    },
                  ],
                },
                finish_reason: 'length',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  await assert.rejects(
    provider.complete([{ role: 'user', content: 'A request' }]),
    /Quick replies in AI models/,
  );
  assert.equal(calls, 1);
  provider.replyMode = 'quick';
  await assert.rejects(
    provider.complete([{ role: 'user', content: 'A request' }]),
    /Try a shorter request or choose another model/,
  );
  assert.equal(calls, 2);
  provider.replyMode = 'default';
  provider.fetcher = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  };
  await assert.rejects(
    provider.complete([{ role: 'user', content: 'A request' }]),
    /Quick replies in AI models/,
  );
  assert.equal(calls, 3);
});
test('Ollama abilities are bounded metadata only, destination/key/model scoped and cached without inference', async () => {
  const calls = [];
  const caps = new ModelCapabilities(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ capabilities: ['completion'] });
  });
  assert.equal((await caps.resolve(local)).tools, false);
  assert.equal((await caps.resolve(local)).vision, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/show');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'small:1b', verbose: false });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  await caps.resolve({ ...local, model: 'other:1b' });
  await caps.resolve({ ...local, apiKey: 'scoped-key' });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.headers.Authorization, 'Bearer scoped-key');
  assert.equal(
    (await caps.resolve({ ...local, baseUrl: 'https://other.example/v1' })).source,
    'unknown',
  );
  assert.equal(calls.length, 3);
  assert.equal(
    (await caps.resolve({ ...local, abilities: { tools: 'supported', vision: 'unsupported' } }))
      .tools,
    true,
  );
});
test('malformed/unavailable metadata remains unknown, cancellation is honored and owner overrides are validated', async () => {
  for (const data of [{}, { capabilities: [] }, { capabilities: [3] }]) {
    const result = await new ModelCapabilities(async () => Response.json(data)).resolve(local);
    assert.equal(result.tools, null);
    assert.equal(result.vision, null);
  }
  assert.equal(
    (
      await new ModelCapabilities(async () => {
        throw Error('private provider text');
      }).resolve(local)
    ).source,
    'unknown',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new ModelCapabilities(async () => {
      throw Error();
    }).resolve(local, controller.signal),
    { name: 'AbortError' },
  );
  assert.throws(() => abilitySettings({ tools: true }));
  assert.deepEqual(abilitySettings({}, { tools: 'unsupported' }), {
    tools: 'unsupported',
    vision: 'auto',
  });
});
test('chat-only completion omits tools and uses the compact prompt; unexpected tool calls are never returned to the agent', async () => {
  const calls = [];
  let malicious = false;
  const provider = new ModelProvider({
    ...local,
    getCapabilities: async () => ({ tools: false, vision: false, text: true }),
    fetcher: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return malicious
        ? response('', [
            {
              id: 'bad',
              type: 'function',
              function: { name: 'remember', arguments: '{"text":"unwanted"}' },
            },
          ])
        : response();
    },
  });
  const messages = [
    {
      role: 'system',
      content: 'Use many tools',
      chatOnlyContent: 'Answer directly. You have no tools.',
    },
    { role: 'user', content: 'What is 2 + 2?' },
  ];
  assert.equal((await provider.complete(messages, [{ name: 'remember' }])).text, 'Four.');
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].messages[0].content, messages[0].chatOnlyContent);
  assert.equal(calls[0].messages[0].chatOnlyContent, undefined);
  malicious = true;
  await assert.rejects(
    provider.complete(messages, [{ name: 'remember' }]),
    /No action was performed/,
  );
});
test('known unsupported images, attached files and non-chat models fail clearly before inference, without silent stripping or fallback', async () => {
  let requests = 0;
  const provider = new ModelProvider({
    ...local,
    getCapabilities: async () => ({ tools: false, vision: false }),
    fetcher: async () => {
      requests++;
      return response();
    },
  });
  await assert.rejects(
    provider.complete([{ role: 'user', content: 'Read it', visual: 'data:image/png;base64,AAAA' }]),
    /cannot read images/,
  );
  await assert.rejects(
    provider.complete([{ role: 'user', content: 'Read the attachment' }], [], {
      requiresTools: true,
    }),
    /cannot use assistant actions/,
  );
  assert.equal(requests, 0);
  assert.throws(() => capabilityMessages([], { text: false }), /does not support chat/);
});
test('control/cancellation is rechecked after metadata and before forwarding any conversation', async () => {
  let release,
    dispatched = 0,
    checked = 0;
  const provider = new ModelProvider({
    ...local,
    getCapabilities: () =>
      new Promise((r) => {
        release = r;
      }),
    fetcher: async () => {
      dispatched++;
      return response();
    },
  });
  const result = provider.complete([{ role: 'user', content: 'Private conversation' }], [], {
    beforeAttempt: async () => {
      checked++;
      throw new DOMException('Owner took control', 'AbortError');
    },
  });
  release({ tools: true });
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(checked, 1);
  assert.equal(dispatched, 0);
});
test('a chat-only backup retains prior tool results as untrusted text, dropping unsupported roles and opaque provider reasoning', () => {
  const original = [
    { role: 'system', content: 'Use tools', chatOnlyContent: 'Chat only' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'a', function: { name: 'write_note' } }],
      responseOutput: [{ opaque: 'secret' }],
      providerOutput: { opaque: 'secret' },
      modelOrigin: 'other',
    },
    { role: 'tool', tool_call_id: 'a', content: '{"saved":"note.txt"}' },
  ];
  const result = capabilityMessages(original, { tools: false });
  assert.equal(result[2].role, 'user');
  assert.match(result[2].content, /untrusted/);
  assert.match(result[2].content, /note.txt/);
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(result[1].tool_calls, undefined);
  assert.equal(original[2].role, 'tool');
  assert.equal(capabilityMessages(original, {})[0].chatOnlyContent, undefined);
});
test('explicit chat-only mode works across all four wire formats without leaking internal prompt alternatives', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    let body;
    const provider = new ModelProvider({
      baseUrl: 'https://provider.example/v1',
      model: 'text',
      protocol,
      getCapabilities: async () => ({ tools: false }),
      fetcher: async (_url, init) => {
        body = JSON.parse(init.body);
        if (protocol === 'responses')
          return Response.json({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello.' }] }],
          });
        if (protocol === 'anthropic')
          return Response.json({
            content: [{ type: 'text', text: 'Hello.' }],
            stop_reason: 'end_turn',
          });
        if (protocol === 'gemini')
          return Response.json({
            candidates: [{ content: { parts: [{ text: 'Hello.' }] }, finishReason: 'STOP' }],
          });
        return response('Hello.');
      },
    });
    const result = await provider.complete(
      [
        { role: 'system', content: 'Tools', chatOnlyContent: 'Chat only.' },
        { role: 'user', content: 'Hi' },
      ],
      [
        {
          name: 'remember',
          description: 'Remember',
          parameters: { type: 'object', properties: {} },
        },
      ],
    );
    assert.equal(result.text, 'Hello.');
    assert(!body.tools?.length);
    assert(!JSON.stringify(body).includes('chatOnlyContent'));
    assert(JSON.stringify(body).includes('Chat only.'));
  }
});
test('ability settings persist, are pinned with the connection revision and reset when the destination/model changes', () => {
  const store = new Store(':memory:', { sample: false }),
    key = Buffer.alloc(32, 5);
  try {
    const manager = new ModelConnections(store, { key });
    const { id } = manager.save({
      ...local,
      abilities: { tools: 'unsupported', vision: 'unsupported' },
      activate: true,
    });
    const binding = manager.binding();
    assert.equal(manager.records(binding)[0].abilities.tools, 'unsupported');
    assert.equal(new ModelConnections(store, { key }).current.abilities.tools, 'unsupported');
    manager.save({ ...local, id, model: 'changed:1b' });
    assert.equal(manager.current.abilities.tools, 'auto');
    assert.throws(() => manager.records(binding), /changed/);
  } finally {
    store.close();
  }
});
test('actual worker completes a text-only conversation without any action dispatch or workspace changes', async () => {
  const store = new Store(':memory:', { sample: false }),
    calls = [];
  const provider = new ModelConnections(store, {
    key: Buffer.alloc(32, 6),
    fetcher: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return url.endsWith('/api/show')
        ? Response.json({ capabilities: ['completion'] })
        : response('Two plus two is four.');
    },
  });
  provider.save({ ...local, activate: true });
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const worker = new BackgroundWorker(store, services, { pollMs: 20 });
  try {
    store.mutate((s) =>
      command(s, 'chat.send', { threadId: 'main', text: 'What is two plus two?' }),
    );
    worker.start();
    const deadline = Date.now() + 5000;
    while (!store.read().messages.some((m) => m.role === 'assistant') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    const state = store.read();
    assert.equal(state.messages.at(-1).text, 'Two plus two is four.');
    assert.equal(state.runs.at(-1).status, 'completed');
    assert.equal(state.memories.length, 0);
    assert.equal(state.files.length, 0);
    const chat = calls.find((c) => c.url.endsWith('/chat/completions')).body;
    assert.equal(chat.tools, undefined);
    assert.match(chat.messages[0].content, /no action tools/);
    assert(!chat.messages[0].content.includes('Use write_note'));
  } finally {
    await worker.stop();
    store.close();
  }
});
test('capability inspection requires owner authentication/same-origin, does not activate a model or send prompts', async () => {
  const store = new Store(':memory:', { sample: false }),
    calls = [];
  const provider = new ModelConnections(store, {
    key: Buffer.alloc(32, 7),
    fetcher: async (url) => {
      calls.push(url);
      return Response.json({ capabilities: ['completion', 'tools', 'vision'] });
    },
  });
  const server = createApp(
    store,
    { mode: 'live', provider, google: {}, browser: {}, terminal: {} },
    { host: '127.0.0.1', port: 0, accessKey: 'owner' },
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, cookie = '', source = origin) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await post('models/capabilities', local)).status, 401);
    const cookie = (await post('login', { key: 'owner' })).headers.get('set-cookie').split(';')[0];
    assert.equal(
      (await post('models/capabilities', local, cookie, 'https://evil.test')).status,
      403,
    );
    assert.equal(calls.length, 0);
    const result = await post('models/capabilities', local, cookie);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await result.json()).vision, true);
    assert.equal(provider.configured, false);
    assert.equal(store.read().messages.length, 0);
    assert.deepEqual(calls, ['http://127.0.0.1:11434/api/show']);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('read-only local structured selection is scoped to detected Ollama and preserves ordinary reply style', async () => {
  const requests = [];
  const schema = {
    name: 'selection',
    schema: {
      type: 'object',
      properties: { forget: { type: 'array', items: { type: 'string' } } },
      required: ['forget'],
      additionalProperties: false,
    },
  };
  const messages = [
    {
      role: 'system',
      content: 'Use the selection tool.',
      chatOnlyContent: 'Return slots.',
      jsonOnlyContent: 'Return exact note text.',
    },
    { role: 'user', content: 'Forget a note.' },
  ];
  const caps = {
    source: 'ollama',
    tools: true,
    thinking: { values: [false, true], default: true },
  };
  const make = (record = local, capabilities = caps) =>
    new ModelProvider({
      ...record,
      replyMode: 'quick',
      getCapabilities: async () => capabilities,
      fetcher: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return response('{"forget":[]}');
      },
    });
  const provider = make();
  const result = await provider.complete(messages, [{ name: 'select' }], {
    localStructuredOutput: schema,
    maxOutputTokens: 2400,
  });
  assert.equal(result.structuredOutput, true);
  const selected = requests.at(-1);
  assert.deepEqual(selected.response_format.json_schema, {
    name: schema.name,
    strict: true,
    schema: schema.schema,
  });
  assert.equal(selected.messages[0].content, messages[0].jsonOnlyContent);
  assert.equal(selected.tools, undefined);
  assert.equal(selected.reasoning_effort, 'none');
  assert.equal(selected.temperature, 0);
  assert.equal(selected.max_tokens, 2400);
  assert(!JSON.stringify(selected).includes('jsonOnlyContent'));
  await assert.rejects(
    provider.complete(messages, [], { localStructuredOutput: schema, requiresTools: true }),
    /cannot execute/,
  );
  provider.replyMode = 'quick';
  await provider.complete(messages, [], { localStructuredOutput: schema });
  assert.equal(requests.at(-1).reasoning_effort, 'none');
  assert.equal(requests.at(-1).temperature, 0);
  provider.replyMode = 'default';
  const defaultResult = await provider.complete(messages, [{ name: 'select' }], {
    localStructuredOutput: schema,
  });
  assert.equal(defaultResult.structuredOutput, undefined);
  assert.equal(requests.at(-1).reasoning_effort, undefined);
  assert.equal(requests.at(-1).temperature, undefined);
  assert.equal(requests.at(-1).response_format, undefined);
  assert.equal(requests.at(-1).messages[0].content, messages[0].content);
  assert.equal(requests.at(-1).tools.length, 1);
  for (const [record, capabilities] of [
    [{ ...local, baseUrl: 'https://model.example/v1' }, caps],
    [local, { source: 'unknown', tools: false }],
  ]) {
    const result = await make(record, capabilities).complete(messages, [], {
      localStructuredOutput: schema,
    });
    assert.equal(result.structuredOutput, undefined);
    assert.equal(requests.at(-1).response_format, undefined);
    assert.equal(requests.at(-1).reasoning_effort, undefined);
    assert(!JSON.stringify(requests.at(-1)).includes('jsonOnlyContent'));
  }
  await make(local, { source: 'ollama', tools: false }).complete(messages, [], {
    localStructuredOutput: schema,
  });
  assert.equal(
    requests.at(-1).reasoning_effort,
    undefined,
    'Do not guess missing thinking support.',
  );
});
