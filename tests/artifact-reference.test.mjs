// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { agentReply, executeTool, toolDefinitions } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';
import { artifactRevisionTools, currentArtifactReference } from '../server/artifact-completion.mjs';
const call = (name, args) => ({
  id: name,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const original = {
  kind: 'document',
  title: 'Packing',
  source: '# Packing\n\nReference 01234\n\n- Charging cable\n- Notebook',
};
async function fixture(t, { input = original, noun = 'Word document', path = ':memory:' } = {}) {
  let store = new Store(path, { sample: false });
  t.after(() => store.close());
  const saved = await executeTool(store, 'save_artifact', input, {
    threadId: 'main',
    operationId: 'original',
  });
  store.mutate((s) => {
    s.profile.memoryLearning = false;
    s.messages.push({
      id: 'prior-result',
      threadId: 'main',
      role: 'assistant',
      text: 'Saved.',
      cards: [saved.card],
    });
  });
  const run = store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: `Update that same ${noun}: replace Charging cable with USB-C charger. Keep everything else exactly.`,
    }),
  );
  const context = { runId: run.id, threadId: 'main', sourceMessageId: run.messageId };
  return {
    get store() {
      return store;
    },
    run,
    context,
    saved: saved.result,
    reopen() {
      store.close();
      store = new Store(path);
    },
  };
}
const edits = [{ find: 'Charging cable', replace: 'USB-C charger' }];

test('current reference reads and revises the exact preceding result with a real version check', async (t) => {
  const f = await fixture(t);
  const read = (await executeTool(f.store, 'read_artifact', { id: 'current' }, f.context)).result;
  assert.equal(read.id, f.saved.id);
  assert.equal(read.source, original.source);
  assert.deepEqual(read.revisionTarget, {
    id: 'current',
    expectedVersion: 1,
    kind: 'document',
    title: 'Packing',
  });
  const input = { ...read.revisionTarget, edits };
  const saved = await executeTool(f.store, 'save_artifact', input, {
    ...f.context,
    operationId: 'exact-revision',
  });
  assert.equal(saved.result.id, f.saved.id);
  assert.equal(saved.result.version, 2);
  assert.equal(f.store.read().artifacts.length, 1);
  assert.equal(
    f.store.read().artifacts[0].versions[1].source,
    original.source.replace('Charging cable', 'USB-C charger'),
  );
  const retry = await executeTool(f.store, 'save_artifact', input, {
    ...f.context,
    operationId: 'exact-revision',
  });
  assert.equal(retry.card.id, saved.card.id);
  assert.equal(f.store.read().artifacts[0].versions.length, 2);
});

test('a shortened opaque ID fails with a usable reference hint and never changes files', async (t) => {
  const f = await fixture(t),
    before = f.store.read();
  const shortened = f.saved.id.replace(/^artifact-/, '');
  for (const name of ['read_artifact', 'save_artifact'])
    await assert.rejects(
      executeTool(f.store, name, { ...original, id: shortened, expectedVersion: 1 }, f.context),
      /read_artifact id "current"/,
    );
  assert.deepEqual(f.store.read(), before);
  await assert.rejects(
    executeTool(
      f.store,
      'save_artifact',
      { ...original, source: undefined, edits, expectedVersion: 1 },
      f.context,
    ),
    /save_artifact id "current"/,
  );
  assert.deepEqual(f.store.read(), before);
  const canonical = await executeTool(f.store, 'read_artifact', { id: f.saved.fileId }, f.context);
  assert.equal(canonical.result.revisionTarget.id, f.saved.id);
});

test('current references require the actual run, owner source and conversation', async (t) => {
  const f = await fixture(t);
  for (const context of [
    {},
    { ...f.context, runId: 'missing' },
    { ...f.context, sourceMessageId: 'other' },
    { ...f.context, threadId: 'other' },
  ])
    await assert.rejects(
      executeTool(f.store, 'read_artifact', { id: 'current' }, context),
      /No single current result/,
    );
  const run = { ...f.run, appContext: [{ connectionId: 'selected', revision: 1 }] };
  assert.equal(currentArtifactReference(f.store.read(), run, f.run.messageId), null);
  const missingSource = { ...f.run, activeMessageId: 'other' };
  assert.equal(currentArtifactReference(f.store.read(), missingSource, f.run.messageId), null);
});

test('ambiguous, quoted, removed and unrelated results do not acquire a current reference', async (t) => {
  const f = await fixture(t),
    state = f.store.read();
  for (const transform of [
    (s) => {
      s.messages.find((m) => m.id === f.run.messageId).text = '"Update that same Word document"';
    },
    (s) => {
      s.messages.find((m) => m.id === f.run.messageId).text =
        'Explain how to edit a Word document.';
    },
    (s) => {
      s.messages.find((m) => m.id === 'prior-result').threadId = 'other';
    },
    (s) => {
      s.files = [];
    },
    (s) => {
      s.artifacts = [];
    },
    (s) => {
      const a = structuredClone(s.artifacts[0]),
        file = structuredClone(s.files.find((v) => v.id === f.saved.fileId));
      a.id = 'second';
      file.id = 'second-file';
      file.artifactId = a.id;
      a.versions[0].fileId = file.id;
      s.artifacts.push(a);
      s.files.push(file);
      s.messages.find((m) => m.id === 'prior-result').cards.push({ kind: 'file', id: file.id });
    },
  ]) {
    const s = structuredClone(state);
    transform(s);
    assert.equal(currentArtifactReference(s, f.run, f.run.messageId), null);
  }
});

test('the alias retains pagination and pinned older reads while rejecting stale saves', async (t) => {
  const input = {
    kind: 'web',
    title: 'Long page',
    source: '<main>' + 'a'.repeat(13000) + 'Charging cable</main>',
  };
  const f = await fixture(t, { input, noun: 'interactive page' });
  const first = (await executeTool(f.store, 'read_artifact', { id: 'current' }, f.context)).result;
  assert.equal(first.nextOffset, 12000);
  await executeTool(
    f.store,
    'save_artifact',
    {
      ...input,
      id: f.saved.id,
      expectedVersion: 1,
      source: input.source.replace('Charging cable', 'Owner note'),
    },
    { operationId: 'owner-edit' },
  );
  const rest = (
    await executeTool(
      f.store,
      'read_artifact',
      { id: 'current', version: first.version, offset: first.nextOffset },
      f.context,
    )
  ).result;
  assert.equal(first.source + rest.source, input.source);
  assert.equal(rest.nextOffset, null);
  await assert.rejects(
    executeTool(
      f.store,
      'save_artifact',
      { ...first.revisionTarget, edits },
      { ...f.context, operationId: 'stale-edit' },
    ),
    /newer version/,
  );
  assert.equal(f.store.read().artifacts[0].versions.length, 2);
  const current = (await executeTool(f.store, 'read_artifact', { id: 'current' }, f.context))
    .result;
  assert.equal(current.version, 2);
});

test('a request changed during export cannot commit through the old current reference', async (t) => {
  const f = await fixture(t),
    read = (await executeTool(f.store, 'read_artifact', { id: 'current' }, f.context)).result;
  let checks = 0;
  await assert.rejects(
    executeTool(
      f.store,
      'save_artifact',
      { ...read.revisionTarget, edits },
      {
        ...f.context,
        operationId: 'redirected',
        guard() {
          if (++checks === 2)
            f.store.mutate((s) => {
              s.runs[0].activeMessageId = 'later';
            });
        },
      },
    ),
    /reference changed/,
  );
  assert.equal(f.store.read().artifacts[0].versions.length, 1);
});

test('current reference schemas are request-local and retain all ordinary tool capabilities', () => {
  const snapshot = JSON.stringify(toolDefinitions);
  assert.equal(artifactRevisionTools(toolDefinitions, null), toolDefinitions);
  const tools = artifactRevisionTools(toolDefinitions, {
    id: 'bound',
    kind: 'document',
    version: 1,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    toolDefinitions.map((t) => t.name),
  );
  for (const name of ['read_artifact', 'save_artifact']) {
    const definition = tools.find((t) => t.name === name);
    assert.match(definition.description, /use id "current"/);
    assert.match(definition.parameters.properties.id.description, /"current"/);
    assert.deepEqual(
      definition.parameters.required,
      toolDefinitions.find((t) => t.name === name).parameters.required,
    );
  }
  assert.equal(JSON.stringify(toolDefinitions), snapshot);
});

test('voice and typed revisions use the reference through the real agent and preserve exact source', async (t) => {
  for (const voice of [false, true]) {
    const f = await fixture(t);
    if (voice) f.run.voiceCallId = 'synthetic-voice';
    let calls = 0;
    const provider = {
      async complete(messages, tools, options) {
        assert.match(tools.find((t) => t.name === 'read_artifact').description, /id "current"/);
        if (++calls === 1)
          return { text: '', toolCalls: [call('read_artifact', { id: 'current' })] };
        if (calls === 2)
          return {
            text: '',
            toolCalls: [
              call('save_artifact', {
                ...JSON.parse(messages.at(-1).content).result.revisionTarget,
                edits,
              }),
            ],
          };
        assert.equal(options.requiresTools, false);
        return { text: 'Updated the same document.', toolCalls: [] };
      },
    };
    const result = await agentReply(f.store, provider, f.run, {}, { durable: true });
    assert.equal(
      f.store.read().artifacts[0].versions[1].source,
      original.source.replace('Charging cable', 'USB-C charger'),
    );
    assert.equal(result.cards.length, 1);
    assert.deepEqual(await agentReply(f.store, provider, f.run, {}, { durable: true }), result);
    assert.equal(calls, 3);
  }
});

test('current reference survives a SQLite checkpoint reopen without a second save', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-artifact-reference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, { path: join(directory, 'state.sqlite') });
  let calls = 0;
  await assert.rejects(
    agentReply(
      f.store,
      {
        async complete(messages) {
          if (++calls === 1)
            return { text: '', toolCalls: [call('read_artifact', { id: 'current' })] };
          if (calls === 2)
            return {
              text: '',
              toolCalls: [
                call('save_artifact', {
                  ...JSON.parse(messages.at(-1).content).result.revisionTarget,
                  edits,
                }),
              ],
            };
          throw Error('Model disconnected');
        },
      },
      f.run,
      {},
      { durable: true },
    ),
    /Model disconnected/,
  );
  f.reopen();
  const result = await agentReply(
    f.store,
    {
      async complete(_m, _t, options) {
        assert.equal(options.requiresTools, false);
        return { text: 'Your revision is saved.', toolCalls: [] };
      },
    },
    f.store.read().runs[0],
    {},
    { durable: true },
  );
  assert.equal(result.cards.length, 1);
  assert.equal(f.store.read().artifacts[0].versions.length, 2);
});

test('the same reference protocol retains spreadsheet and presentation result identities', async (t) => {
  for (const [kind, noun, content] of [
    [
      'spreadsheet',
      'spreadsheet',
      {
        sheets: [
          {
            name: 'Packing',
            rows: [
              ['Item', 'Count'],
              ['Charging cable', 1],
              ['Notebook', 2],
            ],
          },
        ],
      },
    ],
    [
      'presentation',
      'PowerPoint',
      {
        slides: [
          { title: 'Packing', bullets: ['Charging cable', 'Notebook'], notes: 'Keep this note.' },
        ],
      },
    ],
  ]) {
    const input = { kind, title: 'Packing', source: JSON.stringify(content) };
    const f = await fixture(t, { input, noun });
    const read = (await executeTool(f.store, 'read_artifact', { id: 'current' }, f.context)).result;
    const saved = await executeTool(
      f.store,
      'save_artifact',
      { ...read.revisionTarget, edits },
      { ...f.context, operationId: 'revise-' + kind },
    );
    assert.equal(saved.result.id, f.saved.id);
    assert.equal(saved.result.version, 2);
    assert.equal(
      f.store.read().artifacts[0].versions[1].source,
      read.source.replace('Charging cable', 'USB-C charger'),
    );
  }
});
