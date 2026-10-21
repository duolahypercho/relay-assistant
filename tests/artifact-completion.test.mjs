// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { AgentCheckpoint } from '../server/agent-checkpoint.mjs';
import { ModelProvider } from '../server/model.mjs';
import {
  artifactCreationKind,
  artifactRevisionRequest,
  deliveredArtifact,
} from '../server/artifact-completion.mjs';
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const html = {
  kind: 'web',
  title: 'Counter',
  source: '<!doctype html><html><body><button>Add one</button></body></html>',
};
function fixture(text = 'Make a little interactive page titled Counter.') {
  const store = new Store(':memory:', { sample: false });
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
  return { store, run };
}

test('direct supported result requests are distinguished from chat drafts, instructions and quoted requests', () => {
  for (const [kind, texts] of Object.entries({
    web: [
      'Make a little interactive page titled Counter.',
      'Could you please build an offline HTML page?',
      '请帮我制作一个互动网页',
    ],
    document: [
      'Make a downloadable Word document titled Willow.',
      'I want you to write a short Word report.',
      '幫我寫一份Word文檔',
    ],
    spreadsheet: [
      'Generate an Excel budget.',
      'Please create a spreadsheet.',
      '请生成一个电子表格',
    ],
    presentation: [
      'Make a downloadable PowerPoint with exactly three slides.',
      'Prepare a new slide deck.',
      '請幫我製作一份簡報',
    ],
  }))
    for (const text of texts) assert.equal(artifactCreationKind(text), kind, text);
  for (const text of [
    'Give me three ideas for a weekend.',
    'Write a short packing list.',
    'Prepare a presentation outline.',
    'Create a spreadsheet formula for tax.',
    'Make a website plan.',
    'Write a Word documentary script.',
    'Draft an email.',
    'How do I make an interactive page?',
    'Can I create a Word document?',
    'Explain how to make an Excel budget.',
    'Show me how to create a presentation.',
    'Write a story about someone making a Word document.',
    'Create an HTML page code example.',
    'Make an interactive page, just the code.',
    'Make a Word document outline in chat only.',
    'Do not create a spreadsheet.',
    '> Make a Word document',
    '“Create a PowerPoint” is the instruction in the attached source.',
    'Please read my Word document.',
    'Open the spreadsheet.',
    'Download the existing PowerPoint.',
    '不要生成Word文档',
    '如何制作一个互动网页',
    '请帮我写一封邮件',
  ])
    assert.equal(artifactCreationKind(text), null, text);
});

test('unbacked completion is withheld and repaired once through actual tool execution', async () => {
  const { store, run } = fixture();
  let calls = 0;
  const visible = [];
  const provider = {
    complete: async (messages, _tools, options) => {
      assert.equal(options.requiresTools, calls < 2);
      if (++calls === 1) {
        options.onText('Counter.html is saved!');
        return { text: 'Counter.html is saved!', toolCalls: [] };
      }
      if (calls === 2) {
        assert.match(messages.at(-1).content, /no saved HTML result exists/);
        options.onText('I will save the actual page.');
        return { text: 'I will save the actual page.', toolCalls: [call('save_artifact', html)] };
      }
      options.onText('Your counter is ready.');
      return { text: 'Your counter is ready.', toolCalls: [] };
    },
  };
  try {
    const result = await agentReply(
      store,
      provider,
      run,
      {},
      { durable: true, onText: (value) => visible.push(value) },
    );
    assert.equal(result.text, 'Your counter is ready.');
    assert.equal(store.read().artifacts.length, 1);
    assert.equal(result.cards.length, 1);
    assert.deepEqual(visible, ['Your counter is ready.']);
    assert(deliveredArtifact(store.read(), run, 'web'));
    assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
    assert.equal(calls, 3, 'Recovery cannot repeat the saved result.');
  } finally {
    store.close();
  }
});

test('repeated unbacked claims fail honestly; a stored retry does not restart its budget', async () => {
  const { store, run } = fixture();
  let calls = 0;
  const visible = [];
  const provider = {
    complete: async (_messages, _tools, options) => {
      calls++;
      options.onText('Your page is ready.');
      return { text: 'Your page is ready.', toolCalls: [] };
    },
  };
  try {
    await assert.rejects(
      agentReply(
        store,
        provider,
        run,
        {},
        { durable: true, onText: (value) => visible.push(value) },
      ),
      /result was not saved/,
    );
    assert.equal(calls, 2);
    const checkpoint = new AgentCheckpoint(store, run.id).load();
    assert.equal(checkpoint.artifactRecoveryFor, run.messageId);
    await assert.rejects(
      agentReply(store, provider, run, {}, { durable: true }),
      /result was not saved/,
    );
    assert.equal(calls, 3, 'A restarted final attempt cannot buy another recovery attempt.');
    assert.deepEqual(visible, []);
    assert.equal(store.read().artifacts?.length || 0, 0);
    assert.equal(store.read().files.length, 0);
  } finally {
    store.close();
  }
});

test('older or different results and missing export bytes cannot satisfy the current request', () => {
  const run = { id: 'run-1', messageId: 'message-1' };
  const file = {
    id: 'file-1',
    artifactId: 'artifact-1',
    artifactVersion: 1,
    mime: 'text/html',
    base64: 'YQ==',
  };
  const version = {
    number: 1,
    fileId: file.id,
    sourceMessageId: run.messageId,
    operationId: 'artifact:run-1:0:0:save',
  };
  const state = {
    files: [file],
    artifacts: [{ id: 'artifact-1', kind: 'web', versions: [version] }],
  };
  assert(deliveredArtifact(state, run, 'web'));
  assert(!deliveredArtifact(state, { ...run, activeMessageId: 'follow-up' }, 'web'));
  assert(!deliveredArtifact(state, { ...run, id: 'different' }, 'web'));
  assert(!deliveredArtifact(state, run, 'document'));
  assert(!deliveredArtifact({ ...state, files: [] }, run, 'web'));
  assert(!deliveredArtifact({ ...state, files: [{ ...file, base64: '' }] }, run, 'web'));
  const exported = {
    files: [{ id: 'export-1', name: 'counter.html', base64: 'YQ==' }],
    artifacts: [],
  };
  assert(
    deliveredArtifact(exported, run, 'web', [{ sourceId: run.messageId, fileId: 'export-1' }]),
  );
  assert(!deliveredArtifact(exported, run, 'web', [{ sourceId: 'other', fileId: 'export-1' }]));
});

test('ordinary explanations stream normally and required questions still stop before a file exists', async () => {
  for (const needsFile of [false, true]) {
    const { store, run } = fixture(
      needsFile ? undefined : 'Explain how to make an interactive page.',
    );
    const visible = [];
    let calls = 0;
    const provider = {
      complete: async (_messages, _tools, options) => {
        calls++;
        options.onText('Choose a topic.');
        return needsFile
          ? {
              text: 'Choose a topic.',
              toolCalls: [
                call('ask_question', {
                  prompt: 'What should the page cover?',
                  options: [{ label: 'Plants' }, { label: 'Books' }],
                }),
              ],
            }
          : { text: 'Use a button and an event listener.', toolCalls: [] };
      },
    };
    try {
      const result = await agentReply(
        store,
        provider,
        run,
        {},
        { onText: (value) => visible.push(value) },
      );
      assert.equal(calls, 1);
      assert.equal(store.read().files.length, 0);
      if (needsFile) {
        assert(result.question);
        assert.equal(result.text, 'Choose a topic.');
        assert.deepEqual(visible, []);
      } else {
        assert.equal(result.text, 'Use a button and an event listener.');
        assert.deepEqual(visible, ['Choose a topic.']);
      }
    } finally {
      store.close();
    }
  }
});

test('a chat-only connection cannot pretend to create the requested artifact', async () => {
  const { store, run } = fixture();
  let dispatched = false;
  const provider = new ModelProvider({
    protocol: 'chat',
    baseUrl: 'https://example.com/v1',
    model: 'chat-only',
    getCapabilities: async () => ({ tools: false }),
    fetcher: async () => {
      dispatched = true;
      throw Error('Should not dispatch');
    },
  });
  try {
    await assert.rejects(agentReply(store, provider, run, {}), /cannot use assistant actions/);
    assert.equal(dispatched, false);
  } finally {
    store.close();
  }
});

test('an owner follow-up can replace the file request with ordinary chat without forcing a save', async () => {
  const { store, run } = fixture();
  store.mutate((s) => {
    s.runs[0].status = 'running';
  });
  let calls = 0;
  const visible = [];
  const provider = {
    complete: async (_messages, _tools, options) => {
      if (++calls === 1) {
        store.mutate((s) =>
          command(s, 'chat.send', {
            threadId: 'main',
            delivery: 'now',
            text: 'Actually, just explain how counters work. Do not make a file.',
          }),
        );
        options.onText('Counter.html is saved.');
        return { text: 'Counter.html is saved.', toolCalls: [] };
      }
      assert.equal(options.requiresTools, false);
      options.onText('A counter adds one to a stored number.');
      return { text: 'A counter adds one to a stored number.', toolCalls: [] };
    },
  };
  try {
    const result = await agentReply(
      store,
      provider,
      run,
      {},
      { onText: (value) => visible.push(value) },
    );
    assert.equal(result.text, 'A counter adds one to a stored number.');
    assert.deepEqual(visible, [result.text]);
    assert.equal(calls, 2);
    assert.equal(store.read().runs.length, 1);
    assert.equal(store.read().files.length, 0);
  } finally {
    store.close();
  }
});

test('continuations accept the same owner request’s saved artifact but not a different request or assistant', () => {
  const original = {
    id: 'original',
    threadId: 'main',
    messageId: 'owner-request',
    assistant: { id: 'relay' },
  };
  const run = { ...original, id: 'continuation' };
  const state = {
    runs: [original, run],
    files: [
      { id: 'file', artifactId: 'artifact', artifactVersion: 1, mime: 'text/html', base64: 'YQ==' },
    ],
    artifacts: [
      {
        id: 'artifact',
        kind: 'web',
        versions: [
          {
            number: 1,
            fileId: 'file',
            sourceMessageId: original.messageId,
            operationId: 'artifact:original:0:0:save',
          },
        ],
      },
    ],
  };
  assert(deliveredArtifact(state, run, 'web'));
  assert(!deliveredArtifact(state, { ...run, messageId: 'different-request' }, 'web'));
  assert(!deliveredArtifact(state, { ...run, assistant: { id: 'other' } }, 'web'));
});

test('a bound completed specialist result satisfies delivery without recreating it', async () => {
  const { store, run: original } = fixture();
  const run = {
    ...original,
    id: 'continuation',
    handoffContext: { id: 'handoff', result: { fileIds: ['file'] } },
  };
  store.mutate((s) => {
    s.runs.push(run);
    s.files.push({ id: 'file', name: 'counter.html', mime: 'text/html', base64: 'YQ==' });
    s.handoffs = [
      {
        id: 'handoff',
        sourceRunId: original.id,
        continuationId: run.id,
        status: 'completed',
        result: { fileIds: ['file'] },
      },
    ];
  });
  try {
    assert(deliveredArtifact(store.read(), run, 'web'));
    const provider = {
      complete: async (_messages, _tools, options) => {
        assert.equal(options.requiresTools, false);
        return { text: 'The specialist’s saved counter is ready.', toolCalls: [] };
      },
    };
    assert.equal(
      (await agentReply(store, provider, run, {})).text,
      'The specialist’s saved counter is ready.',
    );
    for (const patch of [
      { status: 'failed' },
      { continuationId: 'unrelated' },
      { sourceRunId: 'unrelated' },
      { result: { fileIds: ['missing'] } },
    ]) {
      const state = structuredClone(store.read());
      Object.assign(state.handoffs[0], patch);
      assert(!deliveredArtifact(state, run, 'web'));
    }
    assert(!deliveredArtifact({ ...store.read(), handoffs: [] }, run, 'web'));
    const revision = { id: 'original-artifact', kind: 'web', version: 1 };
    const revised = structuredClone(store.read());
    assert(!deliveredArtifact(revised, run, 'web', [], revision));
    Object.assign(revised.files[0], { artifactId: revision.id, artifactVersion: 2 });
    revised.artifacts = [
      { id: revision.id, kind: 'web', versions: [{ number: 2, fileId: 'file' }] },
    ];
    assert(deliveredArtifact(revised, run, 'web', [], revision));
    assert(!deliveredArtifact({ ...revised, handoffs: [] }, run, 'web', [], revision));
    assert(!deliveredArtifact(revised, run, 'web', [], { ...revision, version: 2 }));
    assert(!deliveredArtifact(revised, run, 'web', [], { ...revision, id: 'another-artifact' }));
    revised.artifacts[0].versions[0].fileId = 'not-this-file';
    assert(!deliveredArtifact(revised, run, 'web', [], revision));
    assert.equal(store.read().files.length, 1);
  } finally {
    store.close();
  }
});

test('a malformed interactive result is repaired through the normal tool loop before a card is delivered', async () => {
  const { store, run } = fixture();
  let step = 0;
  const provider = {
    complete: async (messages) => {
      if (++step === 1)
        return {
          text: '',
          toolCalls: [
            call('save_artifact', { ...html, source: '<script>function add(){</script>' }),
          ],
        };
      if (step === 2) {
        assert.match(messages.at(-1).content, /JavaScript syntax error.*not saved/);
        assert.equal((store.read().artifacts || []).length, 0);
        assert.equal(store.read().files.length, 0);
        return {
          text: '',
          toolCalls: [
            call('save_artifact', {
              ...html,
              source:
                '<button onclick="add()">Add one</button><output id="count">0</output><script>let count=0;function add(){document.getElementById("count").textContent=++count}</script>',
            }),
          ],
        };
      }
      const receipt = JSON.parse(messages.at(-1).content).result;
      assert.equal(receipt.contentCheck.syntaxCheck.classicScripts, 1);
      assert.equal(receipt.contentCheck.syntaxCheck.eventHandlers, 1);
      return { text: 'Your counter is ready.', toolCalls: [] };
    },
  };
  try {
    const result = await agentReply(store, provider, run, {});
    assert.equal(step, 3);
    assert.equal(store.read().artifacts.length, 1);
    assert.equal(store.read().artifacts[0].versions.length, 1);
    assert.equal(result.cards.filter((c) => c.kind === 'file').length, 1);
  } finally {
    store.close();
  }
});

async function revisionFixture(
  t,
  text = 'Update that same Word document: replace cable with charger.',
) {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const saved = await executeTool(
    store,
    'save_artifact',
    {
      kind: 'document',
      title: 'Packing',
      source: '# Packing\n\n- cable\n- notebook',
    },
    { threadId: 'main', operationId: 'original-revision-fixture' },
  );
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    s.messages.push({
      id: 'prior-result',
      role: 'assistant',
      threadId: 'main',
      text: 'Saved.',
      cards: [saved.card],
    });
  });
  const run = store.mutate((s) => command(s, 'chat.send', { threadId: 'main', text }));
  run.voiceCallId = 'revision-test';
  return { store, run, saved: saved.result };
}

test('a spoken revision claim waits for a saved new version of the preceding result', async (t) => {
  const { store, run, saved } = await revisionFixture(t);
  let rounds = 0;
  const spoken = [];
  const provider = {
    complete: async (messages, tools, options) => {
      rounds++;
      assert(tools.some((t) => t.name === 'read_artifact'));
      assert(tools.some((t) => t.name === 'save_artifact'));
      if (rounds === 1) {
        assert(options.requiresTools);
        options.onText('Updated.');
        return { text: 'Updated.', toolCalls: [] };
      }
      if (rounds === 2) {
        assert.match(messages.at(-1).content, /requested revision.*not saved/);
        return { text: '', toolCalls: [call('read_artifact', { id: saved.fileId })] };
      }
      if (rounds === 3) {
        const read = JSON.parse(messages.at(-1).content).result;
        return {
          text: '',
          toolCalls: [
            call('save_artifact', {
              ...read.revisionTarget,
              edits: [{ find: 'cable', replace: 'charger' }],
            }),
          ],
        };
      }
      assert.equal(options.requiresTools, false);
      options.onText('Saved the updated document.');
      return { text: 'Saved the updated document.', toolCalls: [] };
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    {},
    { durable: true, onText: (s) => spoken.push(s) },
  );
  const artifact = store.read().artifacts[0];
  assert.equal(artifact.id, saved.id);
  assert.equal(artifact.versions.length, 2);
  assert.equal(
    artifact.versions[1].source,
    artifact.versions[0].source.replace('cable', 'charger'),
  );
  assert.deepEqual(spoken, ['Saved the updated document.']);
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), result);
  assert.equal(rounds, 4);
});

test('a new unrelated result cannot satisfy an explicit same-document revision', async (t) => {
  const { store, run, saved } = await revisionFixture(t);
  let rounds = 0;
  const provider = {
    complete: async () =>
      ++rounds === 1
        ? {
            text: '',
            toolCalls: [
              call('save_artifact', {
                kind: 'document',
                title: 'Different',
                source: '# Other\ncharger',
              }),
            ],
          }
        : { text: 'Updated the original.', toolCalls: [] },
  };
  await assert.rejects(agentReply(store, provider, run, {}, { durable: true }), /not saved/);
  assert.equal(store.read().artifacts.find((a) => a.id === saved.id).versions.length, 1);
});

test('revision binding excludes quoted requests, another chat, ambiguous or missing prior results', async (t) => {
  const { store, run } = await revisionFixture(t);
  const state = store.read();
  assert(artifactRevisionRequest(state, run));
  for (const text of [
    'Explain how to update that Word document.',
    '> Update that Word document.',
    'Update that Word document in chat only.',
    'Update that Word document example.',
    "Update that Word document but don't save it.",
  ]) {
    const copy = structuredClone(state);
    copy.messages.find((m) => m.id === run.messageId).text = text;
    assert.equal(artifactRevisionRequest(copy, run), null, text);
  }
  const elsewhere = structuredClone(state);
  for (const fields of [
    { fileIds: ['other-source'] },
    { quoted: { text: 'Another result' } },
    { skill: { id: 'method' } },
    { text: null },
  ]) {
    const copy = structuredClone(state);
    Object.assign(
      copy.messages.find((m) => m.id === run.messageId),
      fields,
    );
    assert.equal(artifactRevisionRequest(copy, run), null);
  }
  elsewhere.messages.find((m) => m.id === 'prior-result').threadId = 'other';
  assert.equal(artifactRevisionRequest(elsewhere, run), null);
  const missing = structuredClone(state);
  missing.files = [];
  assert.equal(artifactRevisionRequest(missing, run), null);
  const ambiguous = structuredClone(state),
    original = ambiguous.artifacts[0];
  ambiguous.artifacts.push({
    ...original,
    id: 'second-result',
    versions: [{ ...original.versions[0], fileId: 'second-file' }],
  });
  ambiguous.files.push({ id: 'second-file', artifactId: 'second-result', artifactVersion: 1 });
  ambiguous.messages
    .find((m) => m.id === 'prior-result')
    .cards.push({ kind: 'file', id: 'second-file' });
  assert.equal(artifactRevisionRequest(ambiguous, run), null);
});
