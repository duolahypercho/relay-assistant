import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvider, sseFrames } from '../server/model.mjs';
import {
  GoogleConnection,
  encrypt,
  decrypt,
  parseGoogleMessage,
  parseGoogleEvent,
  emailMime,
  UncertainActionError,
} from '../server/google.mjs';
import { Store } from '../server/store.mjs';
import { WebSearch } from '../server/search.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool, toolDefinitions } from '../server/agent.mjs';
import { publicAddress, resolveDestination, readableHtml } from '../server/network.mjs';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stream = (frames) =>
  new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
const key = Buffer.alloc(32, 7);
function connected(fetcher) {
  const store = new Store(':memory:', { sample: false });
  store.mutate((s) => {
    s.connections.google = {
      connected: true,
      generation: 1,
      email: 'owner@example.com',
      write: true,
    };
  });
  const google = new GoogleConnection(
    store,
    {
      clientId: 'client',
      clientSecret: 'secret',
      encryptionKey: key.toString('base64'),
      redirectUri: 'http://localhost:5173/api/google/callback',
    },
    fetcher,
  );
  google.saveTokens({
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expiresAt: Date.now() + 3600000,
  });
  return { store, google };
}

test('Responses streaming retains complete tool calls and encrypted reasoning for the next request', async () => {
  const bodies = [];
  const item = {
    type: 'function_call',
    id: 'fc1',
    call_id: 'call1',
    name: 'summarize_finance',
    arguments: '{}',
  };
  const reason = {
    type: 'reasoning',
    id: 'r1',
    summary: [],
    encrypted_content: 'opaque-test-value',
  };
  const provider = new ModelProvider({
    baseUrl: 'https://model.example/v1',
    model: 'test-model',
    apiKey: 'key',
    fetcher: async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      if (bodies.length === 1)
        return stream([
          { type: 'response.output_item.added', item: { ...item, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{}' },
          { type: 'response.output_item.done', item },
          { type: 'response.completed', response: { output: [reason, item] } },
        ]);
      return stream([{ type: 'response.output_text.delta', delta: 'A useful result.' }]);
    },
  });
  const first = await provider.complete([{ role: 'user', content: 'Review' }], toolDefinitions);
  assert.equal(first.toolCalls[0].id, 'call1');
  assert.equal(first.toolCalls[0].function.arguments, '{}');
  assert.deepEqual(first.outputItems, [reason, item]);
  await provider.complete([
    { role: 'user', content: 'Review' },
    { role: 'assistant', tool_calls: first.toolCalls, responseOutput: first.outputItems },
    { role: 'tool', tool_call_id: 'call1', content: '{"result":10}' },
  ]);
  assert.equal(bodies[1].store, false);
  assert.deepEqual(bodies[1].input[1], reason);
  assert.deepEqual(bodies[1].input[2], item);
  assert.equal(bodies[1].input[3].call_id, 'call1');
  assert.equal(bodies[0].tools[0].type, 'function');
});
test('Chat Completions streaming combines argument fragments and streams text to the UI', async () => {
  const updates = [];
  let request;
  const provider = new ModelProvider({
    baseUrl: 'https://model.example/v1',
    model: 'test',
    protocol: 'chat',
    fetcher: async (url, options) => {
      assert.ok(url.endsWith('/chat/completions'));
      request = JSON.parse(options.body);
      return stream([
        {
          choices: [
            {
              delta: {
                content: 'Hello ',
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'remember', arguments: '{"text":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: 'world',
                tool_calls: [{ index: 0, function: { arguments: '"Friday free"}' } }],
              },
            },
          ],
        },
      ]);
    },
  });
  const result = await provider.complete([{ role: 'user', content: 'Hi' }], toolDefinitions, {
    onText: (t) => updates.push(t),
  });
  assert.equal(result.text, 'Hello world');
  assert.deepEqual(updates, ['Hello ', 'Hello world']);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { text: 'Friday free' });
  assert.ok(
    request.tools.some((tool) => tool.type === 'function' && tool.function.name === 'search_mail'),
  );
});
test('SSE handles arbitrary UTF-8 chunk boundaries and provider errors are explicit', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"你好 🌿"}\r\n\r\n');
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += 2) yield bytes.slice(i, i + 2);
  }
  const frames = [];
  for await (const f of sseFrames(chunks())) frames.push(f);
  assert.equal(frames[0].text, '你好 🌿');
  const p = new ModelProvider({
    baseUrl: 'https://model.example',
    model: 'test',
    fetcher: async () => json({}, 401),
  });
  await assert.rejects(() => p.complete([]), /HTTP 401/);
  const q = new ModelProvider({
    baseUrl: 'https://model.example',
    model: 'test',
    fetcher: async () => stream([{ type: 'response.failed' }]),
  });
  await assert.rejects(() => q.complete([]), /could not complete/);
});
test('tool loop writes reviewed actions only and includes earlier queued replies in follow-up context', async () => {
  const store = new Store(':memory:');
  const first = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: 'First' }));
  const next = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: 'Next' }));
  store.mutate((s) => {
    s.messages.push({
      id: 'answer',
      threadId: 'main',
      role: 'assistant',
      text: 'Previous answer',
      replyTo: first.messageId,
    });
  });
  const calls = [];
  const provider = {
    complete: async (messages) => {
      calls.push(structuredClone(messages));
      return calls.length === 1
        ? {
            text: 'Preparing.',
            toolCalls: [
              {
                id: 't1',
                function: {
                  name: 'prepare_email',
                  arguments: JSON.stringify({
                    to: 'sample@example.invalid',
                    subject: 'Reviewed',
                    body: 'Hello',
                  }),
                },
              },
            ],
          }
        : { text: 'Ready for your review.', toolCalls: [] };
    },
  };
  const reply = await agentReply(
    store,
    provider,
    next,
    {},
    { signal: new AbortController().signal },
  );
  assert.equal(reply.cards[0].kind, 'review');
  assert.equal(store.read().approvals[0].status, 'pending');
  assert.equal(store.read().mail.filter((m) => m.folder === 'sent').length, 0);
  assert.deepEqual(
    calls[0].slice(1).map((m) => m.content),
    [
      `[Relay timestamp: ${store.read().messages.find((m) => m.id === first.messageId).createdAt}]\nFirst`,
      'Previous answer',
      `[Relay timestamp: ${store.read().messages.find((m) => m.id === next.messageId).createdAt}]\nNext`,
    ],
  );
  assert.equal(calls[1].at(-1).role, 'tool');
  store.close();
});
test('tool loop rejects malformed arguments and unsupported tools without mutating state', async () => {
  const store = new Store(':memory:');
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text: 'Try' }));
  let round = 0;
  const provider = {
    complete: async () =>
      ++round === 1
        ? {
            text: '',
            toolCalls: [
              { id: 'a', function: { name: 'remember', arguments: '[]' } },
              { id: 'b', function: { name: 'approve_everything', arguments: '{}' } },
            ],
          }
        : { text: 'Handled.', toolCalls: [] },
  };
  await agentReply(store, provider, run, {}, { signal: new AbortController().signal });
  assert.equal(store.read().memories.length, 0);
  assert.equal(store.read().approvals.length, 0);
  store.close();
});
test('public-page policy rejects loopback, numeric variants, DNS rebinding, private and reserved addresses', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '198.18.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('93.184.216.34'), true);
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal(
    (await resolveDestination('https://example.com', publicDns)).address,
    '93.184.216.34',
  );
  await assert.rejects(
    () =>
      resolveDestination('https://example.com', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    /Private/,
  );
  for (const value of [
    'file:///etc/passwd',
    'http://localhost',
    'http://2130706433',
    'http://example.com:5000',
    'https://a:b@example.com',
  ])
    await assert.rejects(() =>
      resolveDestination(value, async (host) => [
        { address: host === '127.0.0.1' ? '127.0.0.1' : '93.184.216.34', family: 4 },
      ]),
    );
  assert.deepEqual(
    readableHtml(
      '<title>A &amp; B</title><script>bad()</script><style>.bad{}</style><p>Hello &lt;world&gt;</p>',
    ),
    { title: 'A & B', text: 'A & B Hello <world>' },
  );
});
test('Google token encryption authenticates ciphertext; OAuth uses PKCE, state and bounded scopes', () => {
  const secret = encrypt({ access_token: 'private' }, key);
  assert.ok(!secret.includes('private'));
  assert.deepEqual(decrypt(secret, key), { access_token: 'private' });
  assert.throws(() => decrypt(secret, Buffer.alloc(32, 8)));
  const { store, google } = connected(async () => json({}));
  const read = google.authorization(false);
  const u = new URL(read.url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), read.state);
  assert.ok(!u.searchParams.get('scope').includes('gmail.send'));
  assert.ok(
    new URL(google.authorization(true).url).searchParams.get('scope').includes('gmail.send'),
  );
  assert.ok(store.secret(`oauth-${read.state}`));
  store.close();
});
test('Google MIME parser preserves threads, read state and attachment metadata while stripping HTML execution', () => {
  const m = parseGoogleMessage({
    id: 'm1',
    threadId: 't1',
    labelIds: ['UNREAD'],
    internalDate: '1700000000000',
    payload: {
      headers: [
        { name: 'From', value: 'A Person <a@example.com>' },
        { name: 'Subject', value: 'Hello' },
      ],
      parts: [
        {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<script>bad()</script><p>A real message</p>').toString('base64url'),
          },
        },
        {
          mimeType: 'application/pdf',
          filename: 'form.pdf',
          body: { attachmentId: 'att1', size: 12 },
        },
      ],
    },
  });
  assert.equal(m.from, 'A Person');
  assert.equal(m.email, 'a@example.com');
  assert.equal(m.threadId, 't1');
  assert.equal(m.read, false);
  assert.equal(m.body, 'A real message');
  assert.equal(m.attachments[0].attachmentId, 'att1');
  const e = parseGoogleEvent({
    id: 'e1',
    summary: 'All day',
    start: { date: '2026-10-01' },
    end: { date: '2026-10-02' },
    etag: 'etag',
  });
  assert.equal(e.allDay, true);
  assert.equal(e.end, '2026-10-02');
  assert.equal(e.providerId, 'e1');
});
test('reviewed email sends exact snapshots with UTF-8 headers and reply thread metadata', async () => {
  let sent;
  const { store, google } = connected(async (url, options) => {
    assert.ok(url.endsWith('/messages/send'));
    sent = JSON.parse(options.body);
    return json({ id: 'new' });
  });
  store.mutate((s) => {
    s.mail.push({ id: 'original', threadId: 'thread', messageHeaderId: '<old@example.com>' });
  });
  const a = store.mutate((s) => {
    const f = command(s, 'file.add', {
      name: 'résumé.txt',
      mime: 'text/plain',
      text: 'Original attachment',
    });
    return command(s, 'mail.prepare', {
      to: 'recipient@example.com',
      subject: '你好',
      body: 'Hello',
      replyTo: 'original',
      attachmentIds: [f.id],
    });
  });
  store.mutate((s) => command(s, 'file.edit', { id: a.attachments[0].id, text: 'Changed' }));
  const result = await google.execute(a);
  assert.equal(result.messageId, 'google-mail-new');
  assert.equal(sent.threadId, 'thread');
  const mime = Buffer.from(sent.raw, 'base64url').toString();
  assert.ok(mime.includes('In-Reply-To: <old@example.com>'));
  assert.ok(mime.includes(Buffer.from('Original attachment').toString('base64')));
  assert.ok(!mime.includes(Buffer.from('Changed').toString('base64')));
  assert.ok(mime.includes('Subject: =?UTF-8?B?'));
  await assert.rejects(
    () =>
      emailMime(
        { to: 'a@example.com\nBcc: z@example.com', subject: 'Bad', body: 'x' },
        [],
        'owner@example.com',
      ),
    /header/,
  );
  store.close();
});
test('Google calendar uses provider IDs, calendar IDs, exclusive all-day dates and ETag preconditions', async () => {
  let target, request;
  const { store, google } = connected(async (url, options) => {
    target = url;
    request = options;
    return json({
      id: 'e1',
      summary: 'Updated',
      start: { date: '2026-10-01' },
      end: { date: '2026-10-02' },
      etag: 'next',
    });
  });
  const e = parseGoogleEvent(
    {
      id: 'e1',
      summary: 'Original',
      start: { date: '2026-10-01' },
      end: { date: '2026-10-02' },
      etag: 'old',
    },
    'calendar@example.com',
  );
  store.mutate((s) => s.events.push(e));
  const a = store.mutate((s) =>
    command(s, 'calendar.prepare', {
      id: e.id,
      operation: 'update',
      title: 'Updated',
      start: '2026-10-01',
      end: '2026-10-02',
      allDay: true,
    }),
  );
  const r = await google.execute(a);
  assert.ok(target.endsWith('/calendar%40example.com/events/e1'));
  assert.equal(request.headers['If-Match'], 'old');
  assert.deepEqual(JSON.parse(request.body).end, { date: '2026-10-02' });
  assert.equal(r.event.providerId, 'e1');
  store.close();
});
test('uncertain external writes are never automatically retried', async () => {
  let requests = 0;
  const { store, google } = connected(async () => {
    requests++;
    throw new Error('Socket lost');
  });
  await assert.rejects(
    () => google.request('https://gmail.googleapis.com/write', { method: 'POST' }, true),
    UncertainActionError,
  );
  assert.equal(requests, 1);
  store.close();
});
test('Google sync preserves independent views and rejects stale-account results', async () => {
  const { store, google } = connected(async (url) => {
    if (url.includes('/messages?'))
      return json({ messages: [{ id: 'm1' }], nextPageToken: 'more' });
    if (url.includes('/messages/m1'))
      return json({ id: 'm1', threadId: 't1', payload: { headers: [] } });
    throw new Error(`Unexpected calendar fetch: ${url}`);
  });
  store.mutate((s) => s.events.push({ id: 'keep', title: 'Keep my calendar' }));
  const r = await google.sync({ includeCalendar: false });
  assert.equal(r.messages, 1);
  assert.equal(r.partial, true);
  assert.equal(store.read().events[0].id, 'keep');
  await assert.rejects(
    () => google.sync({ timeMin: '2026-10-02', timeMax: '2026-10-01' }),
    /range/,
  );
  store.close();
});
test('optional web search maps sourced results, strips snippets, and reports missing configuration', async () => {
  await assert.rejects(() => new WebSearch().search('query'), /BRAVE_SEARCH_API_KEY/);
  let auth;
  const search = new WebSearch({
    apiKey: 'server-secret',
    fetcher: async (url, options) => {
      assert.equal(new URL(url).searchParams.get('q'), 'public question');
      auth = options.headers['X-Subscription-Token'];
      return json({
        web: {
          results: [
            {
              title: 'Source',
              url: 'https://example.com/article',
              description: '<b>Public</b> text',
            },
            { title: 'Private', url: 'http://127.0.0.1', description: 'No' },
          ],
        },
      });
    },
  });
  const r = await search.search('public question');
  assert.equal(auth, 'server-secret');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].excerpt, 'Public text');
  assert.equal(r.provider, 'Brave Search');
});
