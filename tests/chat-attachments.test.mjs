import { isMemoryReview, emptyMemoryWireReply } from '../scripts/memory-review-fixture.mjs';
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { prepareChatAttachments } from '../server/chat-attachments.mjs';
import { ModelProvider } from '../server/model.mjs';
import { ModelFailover } from '../server/model-failover.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { Store } from '../server/store.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { command } from '../shared/domain.mjs';
import { renderArtifact } from '../server/artifacts.mjs';
import { officeMime } from '../shared/office-files.mjs';
import { pdfReaderDocument } from '../scripts/pdf-reader-document.mjs';
const caps = { tools: false, vision: false, text: true };
const file = {
  id: 'notes',
  name: 'Notes.txt',
  mime: 'text/plain',
  text: 'Café meeting at 9. Secret code: river-7462. 🌱',
};
const history = [{ role: 'user', content: 'Read this', attachmentIds: ['notes'] }];
const prepare = (
  files = [file],
  messages = history,
  abilities = caps,
  options = { requiredIds: ['notes'] },
) => prepareChatAttachments(messages, () => ({ files }), abilities, options);
const config = {
  preset: 'ollama',
  protocol: 'chat',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'text',
};
const reply = () =>
  Response.json({ choices: [{ message: { content: 'river-7462' }, finish_reason: 'stop' }] });
async function pdfText(long = false) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (long ? 9 : 1); i++) {
    const page = pdf.addPage();
    for (let line = 0; line < (long ? 35 : 1); line++)
      page.drawText(`Page ${i + 1} line ${line + 1}: The passcode is river-7462.`, {
        x: 30,
        y: 780 - line * 18,
        size: 10,
        font,
      });
  }
  return {
    id: 'notes',
    name: 'Meeting.pdf',
    mime: 'application/pdf',
    base64: Buffer.from(await pdf.save()).toString('base64'),
  };
}

test('direct documents use all four protocols, no tools, no durable source mutation and only explicit files', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    let body;
    const provider = new ModelProvider({
      ...config,
      protocol,
      getCapabilities: async () => caps,
      fetcher: async (_url, init) => {
        if (init?.body && isMemoryReview(JSON.parse(init.body)))
          return Response.json(emptyMemoryWireReply());
        body = JSON.parse(init.body);
        if (protocol === 'responses')
          return Response.json({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'river-7462' }] }],
          });
        if (protocol === 'anthropic')
          return Response.json({
            content: [{ type: 'text', text: 'river-7462' }],
            stop_reason: 'end_turn',
          });
        if (protocol === 'gemini')
          return Response.json({
            candidates: [{ content: { parts: [{ text: 'river-7462' }] }, finishReason: 'STOP' }],
          });
        return reply();
      },
    });
    await provider.complete(history, [{ name: 'read_file' }], {
      prepareMessages: (m, c, signal) =>
        prepare([file, { ...file, id: 'other', text: 'UNRELATED_PRIVATE' }], m, c, {
          requiredIds: ['notes'],
          signal,
        }),
    });
    const encoded = JSON.stringify(body);
    assert(encoded.includes(file.text), protocol);
    assert(!encoded.includes('UNRELATED_PRIVATE'));
    assert(!encoded.includes('attachmentIds'));
    assert(!body.tools);
  }
  assert(!JSON.stringify(history).includes(file.text));
});

test('UTF-8 comes from original bytes, not a truncated preview; edited text and empty files remain readable', async () => {
  const all = 'x'.repeat(13000) + '末尾 🌱';
  const result = await prepare([
    {
      ...file,
      text: 'truncated preview',
      textTruncated: true,
      base64: Buffer.from(all).toString('base64'),
    },
  ]);
  assert(result.messages.at(-1).content.includes(all));
  assert(!result.messages.at(-1).content.includes('truncated preview'));
  assert(
    (await prepare([{ ...file, text: 'edited', base64: '' }])).messages
      .at(-1)
      .content.includes('edited'),
  );
  assert((await prepare([{ ...file, text: '' }])).messages.length === 2);
  await assert.rejects(
    prepare([{ ...file, base64: Buffer.from([0xff, 0xfe]).toString('base64') }]),
    /UTF-8/,
  );
  await assert.rejects(prepare([{ ...file, text: 'abc\0binary' }]), /binary/);
});

test('full paginated PDF and Office text is supplied, with extraction limits and unchanged original bytes', async () => {
  const pdf = await pdfText(true);
  const pdfResult = await prepare([pdf]);
  assert(pdfResult.messages.at(-1).content.includes('Page 9 line 35'));
  assert(pdfResult.messages.at(-1).content.includes('extracted text only'));
  for (const [kind, extension, source] of [
    ['document', 'docx', '# Plan\n\n' + 'Read this paragraph. '.repeat(750) + 'END_WORD'],
    [
      'spreadsheet',
      'xlsx',
      JSON.stringify({
        sheets: [
          {
            name: 'Plan',
            rows: [
              ['Item', 'Value'],
              ['Code', 'river-7462'],
            ],
          },
        ],
      }),
    ],
    [
      'presentation',
      'pptx',
      JSON.stringify({ slides: [{ title: 'Plan', bullets: ['river-7462'] }] }),
    ],
  ]) {
    const artifact = await renderArtifact({ kind, title: 'Plan', source });
    const original = {
      ...file,
      name: `Plan.${extension}`,
      mime: officeMime(`Plan.${extension}`),
      text: undefined,
      base64: Buffer.from(artifact.bytes).toString('base64'),
    };
    const before = JSON.stringify(original),
      result = await prepare([original]);
    assert.match(result.messages.at(-1).content, kind === 'document' ? /END_WORD/ : /river-7462/);
    assert.match(result.messages.at(-1).content, /untrusted source/);
    assert.equal(JSON.stringify(original), before);
  }
});

test('PDF scans require vision and include actual page images; mixed text and photos share the image budget', async () => {
  const pdf = {
    ...file,
    text: undefined,
    name: 'Scan.pdf',
    mime: 'application/pdf',
    base64: (await pdfReaderDocument()).toString('base64'),
  };
  await assert.rejects(prepare([pdf]), /without readable text/);
  const visual = await prepare([pdf], history, { ...caps, vision: true });
  assert.equal(visual.messages.filter((m) => m.visual).length, 3);
  assert(visual.messages.find((m) => m.visual).visual.startsWith('data:image/jpeg;base64,'));
  assert(visual.messages.some((m) => /Images of every page/.test(m.content)));
  const crowded = [
    ...history,
    ...Array.from({ length: 6 }, () => ({
      role: 'user',
      content: 'prior view',
      visual: 'data:image/png;base64,AAAA',
    })),
  ];
  await assert.rejects(prepare([pdf], crowded, { ...caps, vision: true }), /image limit/);
});

test('too-long, too-many, malformed, missing and unsupported current documents fail; historical omissions are explicit', async () => {
  await assert.rejects(prepare([{ ...file, text: 'x'.repeat(60001) }]), /too long/);
  await assert.rejects(prepare([{ ...file, textTruncated: true }]), /incomplete/);
  await assert.rejects(prepare([]), /no longer available/);
  await assert.rejects(
    prepare([{ ...file, text: undefined, name: 'Audio.wav', mime: 'audio/wav', base64: 'AAAA' }]),
    /supported format/,
  );
  await assert.rejects(
    prepare([
      { ...file, text: undefined, name: 'Broken.pdf', mime: 'application/pdf', base64: 'AAAA' },
    ]),
    /readable PDF/,
  );
  const nine = Array.from({ length: 9 }, (_, i) => ({ ...file, id: `d${i}` }));
  const messages = nine.map((f) => ({ role: 'user', content: 'Read', attachmentIds: [f.id] }));
  await assert.rejects(
    prepare(nine, messages, caps, { requiredIds: nine.map((f) => f.id) }),
    /up to 8 documents/,
  );
  const limited = await prepare(nine, messages, caps, { requiredIds: ['d8'] });
  assert.match(limited.messages[0].content, /not included/);
  assert.equal(limited.messages.filter((m) => m.content.includes('<attached_document>')).length, 8);
  const omitted = await prepare([], history, caps, { requiredIds: [] });
  assert.match(omitted.messages[0].content, /not included/);
});

test('saved email body and headers are readable without treating enclosed files as inspected', async () => {
  const email = {
    ...file,
    text: undefined,
    name: 'Meeting.eml',
    mime: 'message/rfc822',
    base64: Buffer.from(
      'From: sender@example.invalid\r\nSubject: Meeting\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCode river-7462',
    ).toString('base64'),
  };
  const result = await prepare([email]);
  assert.match(result.messages.at(-1).content, /Meeting/);
  assert.match(result.messages.at(-1).content, /river-7462/);
  assert.match(
    result.messages.at(-1).content,
    /Enclosed files, links and scripts have not been opened/,
  );
});

test('cancellation and changed/deleted files after async preparation prevent inference', async () => {
  for (const action of ['cancel', 'edit', 'delete']) {
    const abort = new AbortController();
    let calls = 0,
      files = [file],
      ready = false;
    const provider = new ModelProvider({
      ...config,
      getCapabilities: async () => caps,
      fetcher: async () => {
        calls++;
        return reply();
      },
    });
    await assert.rejects(
      provider.complete(history, [], {
        signal: abort.signal,
        prepareMessages: async (m, c, signal) => {
          const result = await prepareChatAttachments(m, () => ({ files }), c, {
            requiredIds: ['notes'],
            signal,
          });
          ready = true;
          return result;
        },
        beforeAttempt: () => {
          if (ready) {
            if (action === 'cancel') abort.abort();
            else files = action === 'delete' ? [] : [{ ...file, text: 'changed' }];
          }
        },
      }),
      action === 'cancel' ? { name: 'AbortError' } : /changed or was removed/,
    );
    assert.equal(calls, 0);
  }
});

test('handback during preparation rebuilds current history and strips other-provider opaque state on approved fallback', async () => {
  const messages = [...history, { role: 'user', content: 'old screen', visual: 'STALE_SCREEN' }];
  let prepared = 0,
    handbacks = 0;
  const requests = [];
  const fallback = new ModelFailover(
    [
      { id: 'primary', revision: 1 },
      { id: 'backup', revision: 1 },
    ],
    {
      provider: (record) =>
        new ModelProvider({
          ...config,
          getCapabilities: async () => caps,
          fetcher: async (_url, init) => {
            if (init?.body && isMemoryReview(JSON.parse(init.body)))
              return Response.json(emptyMemoryWireReply());
            requests.push(JSON.parse(init.body));
            return record.id === 'primary' ? new Response('{}', { status: 503 }) : reply();
          },
        }),
    },
  );
  await fallback.complete(messages, [], {
    prepareMessages: async (m, c) => {
      const result = await prepare([file], m, c);
      prepared++;
      return result;
    },
    beforeAttempt: () => {
      if (prepared && !handbacks++) {
        delete messages[1].visual;
        messages.push({
          role: 'user',
          content: 'Fresh observation required',
          responseOutput: [{ type: 'SECRET_PRIMARY_STATE' }],
          modelOrigin: 'primary:1',
        });
        return true;
      }
    },
  });
  assert.equal(requests.length, 2);
  assert(!JSON.stringify(requests).includes('STALE_SCREEN'));
  assert(JSON.stringify(requests[1]).includes('Fresh observation required'));
  assert(!JSON.stringify(requests[1]).includes('SECRET_PRIMARY_STATE'));
});

test('actual worker keeps document follow-ups through SQLite restart and scopes side/reply chats without actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-document-worker-')),
    calls = [];
  let store, provider, worker;
  const open = () => {
    store = new Store(join(directory, 'relay.sqlite'), { sample: false });
    provider = new ModelConnections(store, {
      key: Buffer.alloc(32, 5),
      fetcher: async (url, init) => {
        if (init?.body && isMemoryReview(JSON.parse(init.body)))
          return Response.json(emptyMemoryWireReply());
        if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion'] });
        calls.push(JSON.parse(init.body));
        return reply();
      },
    });
    worker = new BackgroundWorker(
      store,
      {
        mode: 'live',
        provider,
        google: { configured: false },
        browser: { enabled: false },
        terminal: { enabled: false },
      },
      { pollMs: 10 },
    );
  };
  const send = async (threadId, fileIds) => {
    store.mutate((s) => command(s, 'chat.send', { threadId, text: 'What is the code?', fileIds }));
    const until = Date.now() + 7000;
    while (
      store.read().runs.some((r) => ['queued', 'running'].includes(r.status)) &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 15));
    assert.equal(store.read().runs.at(-1).status, 'completed');
  };
  try {
    open();
    provider.save({ ...config, activate: true });
    const added = store.mutate((s) => command(s, 'file.add', file));
    worker.start();
    await send('main', [added.id]);
    assert(JSON.stringify(calls.at(-1)).includes(file.text));
    const original = store.read().messages.find((m) => m.role === 'user');
    await worker.stop();
    store.close();
    open();
    worker.start();
    await send('main');
    assert(JSON.stringify(calls.at(-1)).includes(file.text));
    const side = store.mutate((s) => command(s, 'thread.create', { title: 'Separate' }));
    await send(side.id);
    assert(!JSON.stringify(calls.at(-1)).includes(file.text));
    const thread = store.mutate((s) => command(s, 'reply.open', { messageId: original.id }));
    await send(thread.id);
    assert(JSON.stringify(calls.at(-1)).includes(file.text));
    assert(calls.every((c) => !c.tools));
    assert.equal(store.read().files.length, 1);
    assert.equal(store.read().memories.length, 0);
    assert(
      store.db
        .prepare('SELECT body FROM agent_checkpoints')
        .all()
        .every((r) => !r.body.includes(file.text)),
    );
  } finally {
    await worker?.stop();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('request guard is rechecked after attachment parsing before any provider dispatch', async () => {
  let valid = true,
    requests = 0;
  const fallback = new ModelFailover([{ id: 'primary', revision: 1 }], {
    guard: () => {
      if (!valid) throw new DOMException('Worker lease ended', 'AbortError');
    },
    provider: () =>
      new ModelProvider({
        ...config,
        getCapabilities: async () => caps,
        fetcher: async () => {
          requests++;
          return reply();
        },
      }),
  });
  await assert.rejects(
    fallback.complete(history, [], {
      prepareMessages: async (m, c) => {
        const result = await prepare([file], m, c);
        valid = false;
        return result;
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(requests, 0);
});

test('current photos take priority over historical PDF images in the combined attachment budget', async () => {
  const { avatarFixture } = await import('./fixtures/avatar.mjs');
  const pdf = {
    id: 'old',
    name: 'Old scan.pdf',
    mime: 'application/pdf',
    base64: (await pdfReaderDocument()).toString('base64'),
  };
  const photos = Array.from({ length: 6 }, (_, i) => ({
    id: `photo${i}`,
    name: `${i}.png`,
    mime: 'image/png',
    base64: avatarFixture({ width: 40 + i, metadata: false }).toString('base64'),
  }));
  const messages = [
    { role: 'user', content: 'Earlier PDF', attachmentIds: ['old'] },
    { role: 'user', content: 'These photos now', attachmentIds: photos.map((f) => f.id) },
  ];
  const result = await prepare(
    [pdf, ...photos],
    messages,
    { ...caps, vision: true },
    { requiredIds: photos.map((f) => f.id) },
  );
  assert.equal(result.messages.filter((m) => m.visual).length, 6);
  assert.match(result.messages[0].content, /not included/);
  assert(
    result.messages.filter((m) => m.visual).every((m) => m.visual.startsWith('data:image/png;')),
  );
});
