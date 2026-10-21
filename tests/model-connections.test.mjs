import { isMemoryReview, emptyMemoryWireReply } from '../scripts/memory-review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ModelConnections, modelEndpoint, modelVaultKey } from '../server/model-connections.mjs';
import { ModelProvider } from '../server/model.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { command } from '../shared/domain.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const stream = (frames) =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
const draft = (more = {}) => ({
  preset: 'custom',
  name: 'My local model',
  baseUrl: 'http://127.0.0.1:1234/v1',
  protocol: 'chat',
  model: 'test-model',
  apiKey: 'private-test-key',
  ...more,
});
const tool = {
  name: 'lookup',
  description: 'Look something up',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

test('connections persist encrypted, keep keys out of public state, and unlock only with their vault key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-model-vault-'));
  let store;
  try {
    const key = modelVaultKey(dir);
    assert.equal((await stat(join(dir, 'model-vault.key'))).mode & 0o777, 0o600);
    store = new Store(join(dir, 'state.sqlite'), { sample: false });
    const manager = new ModelConnections(store, { key });
    const saved = manager.save(draft());
    assert.equal(manager.model, 'test-model');
    for (const output of [
      JSON.stringify(saved),
      JSON.stringify(store.read()),
      store.secret('model-connections'),
    ])
      assert.ok(!output.includes('private-test-key'));
    assert.equal(saved.connections[0].hasKey, true);
    assert.throws(
      () => new ModelConnections(store, { key: Buffer.alloc(32) }),
      /could not be unlocked/,
    );
    store.close();
    store = new Store(join(dir, 'state.sqlite'));
    const reopened = new ModelConnections(store, { key: modelVaultKey(dir) });
    assert.equal(reopened.current.apiKey, 'private-test-key');
    assert.equal(reopened.publicState().active, saved.id);
    reopened.remove(saved.id);
    assert.equal(reopened.configured, false);
    assert.deepEqual(reopened.publicState().connections, []);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('endpoint validation and editing cannot forward an old key to a changed destination or protocol', () => {
  for (const value of [
    'http://api.example/v1',
    'https://user:key@example.com/v1',
    'https://example.com/v1?key=secret',
    'https://example.com/#token',
    'file:///tmp/api',
    'http://169.254.169.254/v1',
  ])
    assert.throws(() => modelEndpoint(value));
  assert.equal(modelEndpoint('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(modelEndpoint('http://[::1]:11434/v1'), 'http://[::1]:11434/v1');
  const store = new Store(':memory:', { sample: false });
  try {
    const m = new ModelConnections(store, { key: Buffer.alloc(32, 4) });
    const a = m.save(draft());
    const { apiKey, ...edit } = draft({ id: a.id });
    m.save({ ...edit, model: 'next-model' });
    assert.equal(m.current.apiKey, 'private-test-key');
    m.save({ ...edit, baseUrl: 'https://different.example/v1' });
    assert.equal(m.current.apiKey, '');
    m.save({ ...edit, apiKey: 'new-key' });
    m.save({ ...edit, protocol: 'anthropic' });
    assert.equal(m.current.apiKey, '');
    assert.throws(() => m.save(draft({ preset: 'openai', apiKey: '' })), /API key/);
    assert.throws(() => m.save(draft({ apiKey: 'key\nheader' })), /valid API key/);
    assert.throws(() => m.save(draft({ protocol: 'invented' })), /supported API/);
  } finally {
    store.close();
  }
});

test('new work switches models while existing runs stay pinned across reopening; active credentials cannot be edited away', async () => {
  const store = new Store(':memory:', { sample: false });
  const requests = [];
  const fetcher = async (_url, req) => {
    requests.push(JSON.parse(req.body).model);
    return json({ choices: [{ message: { content: 'Hello' } }] });
  };
  try {
    const m = new ModelConnections(store, { key: Buffer.alloc(32, 2), fetcher });
    const a = m.save(draft({ model: 'model-a' }));
    const run = { id: 'r1', status: 'running' };
    store.mutate((s) => s.runs.push(run));
    const pinned = m.forRun(run);
    const b = m.save(draft({ model: 'model-b', activate: true }));
    await pinned.complete([{ role: 'user', content: 'Continue' }]);
    await m.complete([{ role: 'user', content: 'New request' }]);
    const reopened = new ModelConnections(store, { key: Buffer.alloc(32, 2), fetcher });
    await reopened.forRun(store.read().runs[0]).complete([{ role: 'user', content: 'Resume' }]);
    assert.deepEqual(requests, ['model-a', 'model-b', 'model-a']);
    assert.throws(() => m.remove(a.id), /answering/);
    assert.throws(() => m.save(draft({ id: a.id })), /answering/);
    store.mutate((s) => {
      s.runs[0].status = 'done';
    });
    m.remove(a.id);
    assert.throws(() => m.forRun(store.read().runs[0]), /connection.*changed/);
    assert.equal(m.publicState().active, b.id);
    m.select(null);
    assert.equal(m.configured, false);
  } finally {
    store.close();
  }
});

test('model discovery and test messages use the right auth, do not save, and do not send workspace data', async () => {
  const store = new Store(':memory:', { sample: false });
  const calls = [];
  const m = new ModelConnections(store, {
    key: Buffer.alloc(32, 9),
    fetcher: async (url, req) => {
      calls.push({ url, req });
      if (url.endsWith('/models'))
        return json({
          models: [
            {
              name: 'models/gemini-test',
              displayName: 'Test',
              supportedGenerationMethods: ['generateContent'],
            },
            { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
          ],
        });
      return json({
        candidates: [{ content: { parts: [{ text: 'Connected' }] }, finishReason: 'STOP' }],
      });
    },
  });
  try {
    const input = draft({
      preset: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      protocol: 'gemini',
      model: 'gemini-test',
    });
    assert.deepEqual((await m.discover(input)).models, [{ id: 'gemini-test', name: 'Test' }]);
    assert.equal((await m.test(input)).ok, true);
    assert.equal(calls[0].req.headers['x-goog-api-key'], 'private-test-key');
    assert.ok(!calls[0].url.includes('private-test-key'));
    assert.equal(calls[1].req.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[1].req.body).contents, [
      { role: 'user', parts: [{ text: 'Reply with the word Connected.' }] },
    ]);
    assert.equal(m.publicState().connections.length, 0);
    assert.equal(store.read().messages.length, 0);
  } finally {
    store.close();
  }
});

test('Anthropic streaming round trip preserves signed thinking, parallel tools, system text and images', async () => {
  const calls = [];
  const provider = new ModelProvider({
    ...draft({ protocol: 'anthropic' }),
    fetcher: async (url, req) => {
      calls.push({ url, req, body: JSON.parse(req.body) });
      if (calls.length > 1)
        return json({ content: [{ type: 'text', text: 'Finished.' }], stop_reason: 'end_turn' });
      return stream([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'private reasoning' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'opaque-signature' },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'a', name: 'lookup', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"query":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"one"}' },
        },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'b', name: 'lookup', input: { query: 'two' } },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]);
    },
  });
  const input = [
    { role: 'system', content: 'Host instructions' },
    { role: 'user', content: 'Look at this', visual: 'data:image/png;base64,YQ==' },
  ];
  const result = await provider.complete(input, [tool]);
  assert.equal(result.text, '');
  assert.equal(result.toolCalls.length, 2);
  const final = await provider.complete(
    [
      ...input,
      { role: 'assistant', tool_calls: result.toolCalls, providerOutput: result.providerOutput },
      { role: 'tool', tool_call_id: 'a', content: '{"value":1}' },
      { role: 'tool', tool_call_id: 'b', content: '{"value":2}' },
    ],
    [tool],
  );
  assert.equal(final.text, 'Finished.');
  assert.equal(calls[0].req.headers['x-api-key'], 'private-test-key');
  assert.equal(calls[0].req.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.system, 'Host instructions');
  assert.deepEqual(calls[0].body.tools[0].input_schema, tool.parameters);
  assert.equal(calls[0].body.messages[0].content[1].source.data, 'YQ==');
  assert.equal(calls[1].body.messages[1].content[0].signature, 'opaque-signature');
  assert.equal(calls[1].body.messages[2].content.length, 2);
  assert.equal(calls[1].body.messages[2].content[1].tool_use_id, 'b');
});

test('Gemini streaming keeps thought signatures and function IDs for the next tool round', async () => {
  const bodies = [];
  const signed = {
    functionCall: { id: 'native-call-1', name: 'lookup', args: { query: 'one' } },
    thoughtSignature: 'opaque-signature',
  };
  const provider = new ModelProvider({
    ...draft({ protocol: 'gemini' }),
    fetcher: async (_url, req) => {
      bodies.push(JSON.parse(req.body));
      return stream(
        bodies.length === 1
          ? [
              {
                candidates: [
                  {
                    content: { parts: [{ text: 'hidden', thought: true }, signed] },
                    finishReason: 'STOP',
                  },
                ],
              },
            ]
          : [{ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }],
      );
    },
  });
  const input = [
    { role: 'system', content: 'Host instructions' },
    { role: 'user', content: 'Look', visual: 'data:image/png;base64,YQ==' },
  ];
  const result = await provider.complete(input, [tool]);
  assert.equal(result.text, '');
  assert.equal(result.toolCalls[0].id, 'native-call-1');
  await provider.complete(
    [
      ...input,
      { role: 'assistant', tool_calls: result.toolCalls, providerOutput: result.providerOutput },
      { role: 'tool', tool_call_id: 'native-call-1', content: '{"value":1}' },
    ],
    [tool],
  );
  assert.deepEqual(
    bodies[0].tools[0].functionDeclarations[0].parametersJsonSchema,
    tool.parameters,
  );
  assert.equal(bodies[0].contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.deepEqual(bodies[1].contents[1].parts[1], signed);
  assert.equal(bodies[1].contents[2].parts[0].functionResponse.id, 'native-call-1');
  assert.equal(bodies[1].contents[2].parts[0].functionResponse.name, 'lookup');
});

test('chat reasoning aliases survive streamed and JSON tool rounds without becoming visible answers', async () => {
  for (const streaming of [false, true]) {
    const bodies = [],
      visible = [];
    const provider = new ModelProvider({
      ...draft(),
      fetcher: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        if (bodies.length > 1) return json({ choices: [{ message: { content: 'Done.' } }] });
        const call = {
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        };
        return streaming
          ? stream([
              { choices: [{ delta: { reasoning: 'private ', reasoning_content: 'separate ' } }] },
              { choices: [{ delta: { reasoning: 'state', reasoning_content: 'context' } }] },
              {
                choices: [
                  {
                    delta: { content: 'Checking.', tool_calls: [{ index: 0, ...call }] },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
            ])
          : json({
              choices: [
                {
                  message: {
                    content: 'Checking.',
                    reasoning: 'private state',
                    reasoning_content: 'separate context',
                    tool_calls: [call],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            });
      },
    });
    const response = await provider.complete([{ role: 'user', content: 'Look it up.' }], [tool], {
      onText: (text) => visible.push(text),
    });
    assert.equal(response.text, 'Checking.');
    assert.deepEqual(visible, ['Checking.']);
    await provider.complete(
      [
        {
          role: 'assistant',
          content: response.text,
          tool_calls: response.toolCalls,
          providerOutput: response.providerOutput,
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'found' },
      ],
      [tool],
    );
    assert.equal(bodies[1].messages[0].reasoning, 'private state');
    assert.equal(bodies[1].messages[0].reasoning_content, 'separate context');
    assert.ok(!('providerOutput' in bodies[1].messages[0]));
  }
});

test('reasoning-only responses stay hidden and both chat reasoning aliases are bounded', async () => {
  for (const streaming of [false, true]) {
    for (const field of ['reasoning', 'reasoning_content']) {
      for (const value of ['private state', 'x'.repeat(50001), { secret: 'private state' }]) {
        const visible = [];
        const provider = new ModelProvider({
          ...draft(),
          fetcher: async () =>
            streaming
              ? stream([{ choices: [{ delta: { [field]: value }, finish_reason: 'stop' }] }])
              : json({ choices: [{ message: { [field]: value }, finish_reason: 'stop' }] }),
        });
        const pending = provider.complete([], [], { onText: (text) => visible.push(text) });
        if (typeof value !== 'string') await assert.rejects(pending, /invalid reasoning response/);
        else if (value.length > 50000) await assert.rejects(pending, /output exceeded the limit/);
        else {
          const response = await pending;
          assert.equal(response.text, '');
          assert.deepEqual(response.toolCalls, []);
          assert.equal(response.providerOutput.content[field], value);
        }
        assert(visible.every((text) => text === ''));
      }
    }
  }
});

test('compatible chat adapters replay provider reasoning only to the model, while native errors stay bounded and private', async () => {
  const bodies = [];
  const p = new ModelProvider({
    ...draft(),
    fetcher: async (_url, req) => {
      bodies.push(JSON.parse(req.body));
      return json({
        choices: [
          {
            message: {
              content: 'Checking.',
              reasoning_content: 'opaque context',
              tool_calls: [
                { id: 'c', type: 'function', function: { name: 'lookup', arguments: '{}' } },
              ],
            },
          },
        ],
      });
    },
  });
  const r = await p.complete([{ role: 'user', content: 'Hello' }]);
  await p.complete([
    {
      role: 'assistant',
      content: r.text,
      tool_calls: r.toolCalls,
      providerOutput: r.providerOutput,
    },
  ]);
  assert.equal(r.text, 'Checking.');
  assert.equal(bodies[1].messages[0].reasoning_content, 'opaque context');
  assert.ok(!('providerOutput' in bodies[1].messages[0]));
  for (const protocol of ['responses', 'chat', 'anthropic', 'gemini']) {
    const broken = new ModelProvider({
      ...draft({ protocol }),
      fetcher: async () => new Response('private-test-key is not JSON'),
    });
    await assert.rejects(
      () => broken.complete([{ role: 'user', content: 'Hi' }]),
      (e) => !e.message.includes('private-test-key') && /invalid response/.test(e.message),
    );
    const rejected = new ModelProvider({
      ...draft({ protocol }),
      fetcher: async () => json({ secret: 'private-test-key' }, 401),
    });
    await assert.rejects(() => rejected.complete([]), /HTTP 401/);
  }
  for (const protocol of ['responses', 'chat', 'anthropic', 'gemini']) {
    const partial = new ModelProvider({ ...draft({ protocol }), fetcher: async () => stream([]) });
    await assert.rejects(() => partial.complete([]), /ended before/);
  }
});

test('model APIs require the owner session and same-origin writes; exports never contain credentials', async () => {
  const store = new Store(':memory:', { sample: false });
  const provider = new ModelConnections(store, {
    key: Buffer.alloc(32, 1),
    fetcher: async () => json({ secret: 'private-test-key' }, 401),
  });
  const services = {
    mode: 'live',
    provider,
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  };
  const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: 'owner-key' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = (path, body, origin = url) =>
    fetch(url + path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(url + '/api/models')).status, 401);
    assert.equal((await post('/api/models/save', draft())).status, 401);
    cookie = (await post('/api/login', { key: 'owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal((await post('/api/models/save', draft(), 'https://evil.example')).status, 403);
    const saved = await post('/api/models/save', draft());
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes('private-test-key'));
    const rejected = await post('/api/models/test', draft());
    assert.equal(rejected.status, 400);
    const failure = await rejected.json();
    assert.match(failure.error, /HTTP 401/);
    assert.ok(!failure.error.includes('private-test-key'));
    assert.equal((await fetch(url + '/api/models', { headers: { Cookie: cookie } })).status, 200);
    for (const path of ['/api/state', '/api/export', '/api/models']) {
      const data = await (await fetch(url + path, { headers: { Cookie: cookie } })).text();
      assert.ok(!data.includes('private-test-key'));
      assert.ok(!data.includes('apiKey'));
    }
    assert.equal(store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('real worker uses the selected native adapter and completes a local tool call', async () => {
  const store = new Store(':memory:', { sample: false });
  let calls = 0;
  const provider = new ModelConnections(store, {
    key: Buffer.alloc(32, 3),
    fetcher: async (_url, req) => {
      if (isMemoryReview(JSON.parse(req.body))) return Response.json(emptyMemoryWireReply());
      calls++;
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'test-model');
      if (calls === 1)
        return json({
          content: [
            {
              type: 'tool_use',
              id: 'remember',
              name: 'learn_memory',
              input: {
                key: 'preference.coffee',
                text: 'Prefers iced coffee.',
                evidence: 'I prefer iced coffee',
              },
            },
          ],
          stop_reason: 'tool_use',
        });
      assert.equal(body.messages.at(-1).content[0].tool_use_id, 'remember');
      assert.equal(JSON.parse(body.messages.at(-1).content[0].content).result.status, 'saved');
      return json({
        content: [{ type: 'text', text: 'I’ll remember your coffee preference.' }],
        stop_reason: 'end_turn',
      });
    },
  });
  provider.save(draft({ protocol: 'anthropic' }));
  const services = { provider, mode: 'live' };
  const worker = new BackgroundWorker(store, services);
  try {
    store.mutate((s) =>
      command(s, 'chat.send', {
        threadId: s.threads[0].id,
        text: 'I prefer iced coffee. Any ideas for tomorrow?',
      }),
    );
    await worker.reply(store.read().runs[0].id, new AbortController().signal);
    const state = store.read();
    assert.equal(state.memories[0].text, 'Prefers iced coffee.');
    assert.match(state.messages.at(-1).text, /remember your coffee/);
    assert.equal(calls, 2);
    assert.ok(state.runs[0].modelConnection.id);
    assert.ok(!JSON.stringify(state).includes('private-test-key'));
  } finally {
    await worker.stop();
    store.close();
  }
});
