// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import { uniqueFileCards } from '../shared/message-cards.mjs';

test('a delivered file remains prominent through later reads; repeated sources and results keep one link', () => {
  const source = { kind: 'file', id: 'brief', purpose: 'source' };
  const output = { kind: 'file', id: 'brief' };
  const review = { kind: 'review', id: 'approval' };
  for (const sequence of [
    [source, output, source],
    [output, source, output],
  ]) {
    const input = structuredClone([review, ...sequence]);
    assert.deepEqual(uniqueFileCards(input), [review, output]);
    assert.deepEqual(input, [review, ...sequence]);
  }
  assert.deepEqual(uniqueFileCards([source, source]), [source]);
  // Existing records have no provenance: never retroactively label them as sources.
  assert.deepEqual(uniqueFileCards([output]), [output]);
});

test('source provenance survives a durable run, while writing then inspecting a file keeps its result card', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
  const file = store.mutate((s) =>
    command(s, 'file.add', {
      name: 'Room.txt',
      mime: 'text/plain',
      text: 'Cedar 358',
    }),
  );
  const run = store.mutate((s) =>
    command(s, 'chat.send', {
      threadId: 'main',
      text: 'Read Room.txt and write a text brief, then check it.',
    }),
  );
  let serial = 0;
  const call = (name, args) => ({
    id: name + ++serial,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  let calls = 0;
  const provider = {
    complete: async () => {
      calls++;
      if (calls === 1)
        return {
          text: '',
          toolCalls: [call('read_file', { id: file.id }), call('read_file', { id: file.id })],
        };
      if (calls === 2)
        return {
          text: '',
          toolCalls: [call('write_note', { name: 'Brief.txt', text: 'Cedar 358' })],
        };
      if (calls === 3) return { text: '', toolCalls: [call('read_file', { name: 'Brief.txt' })] };
      return { text: 'Your checked brief is attached.', toolCalls: [] };
    },
  };
  const reply = await agentReply(store, provider, run, {}, { durable: true });
  const brief = store.read().files.find((f) => f.name === 'Brief.txt');
  assert.deepEqual(reply.cards, [
    { kind: 'file', id: file.id, purpose: 'source' },
    { kind: 'file', id: brief.id },
  ]);
  assert.equal(brief.text, 'Cedar 358');
  assert.deepEqual(await agentReply(store, provider, run, {}, { durable: true }), reply);
  assert.equal(calls, 4);
  assert.equal(store.read().files.length, 2);
});

test('all returned app documents are sources, while files made by app tools remain results', async (t) => {
  const store = new Store(':memory:', { sample: false });
  t.after(() => store.close());
  const files = ['Budget.csv', 'Notes.txt'].map((name) =>
    store.mutate((s) => command(s, 'file.add', { name, mime: 'text/plain', text: 'Data' })),
  );
  for (const contentKind of ['resource', 'resource-template', undefined]) {
    const connectors = { invoke: async () => ({ contentKind, fileIds: files.map((f) => f.id) }) };
    const result = await executeTool(store, 'use_app_tool', {}, { connectors, threadId: 'main' });
    const cards = [result.card, ...result.cards];
    assert.deepEqual(
      cards.map((c) => c.id),
      files.map((f) => f.id),
    );
    assert(cards.every((c) => c.purpose === (contentKind ? 'source' : undefined)));
  }
});
