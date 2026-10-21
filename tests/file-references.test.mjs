// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { executeTool } from '../server/agent.mjs';
import { command } from '../shared/domain.mjs';

const add = (store, name, text) =>
  store.mutate((s) =>
    command(s, 'file.add', {
      name,
      mime: 'text/plain',
      base64: Buffer.from(text).toString('base64'),
    }),
  );

test('an exact unique filename reads existing bytes and returns its canonical identity without a write', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const file = add(store, '春天的计划.txt', 'Tea at 4, then a walk.');
    const before = store.read();
    const byName = await executeTool(store, 'read_file', { name: file.name });
    const byId = await executeTool(store, 'read_file', { id: file.id });
    assert.deepEqual(byName, byId);
    assert.equal(byName.result.text, 'Tea at 4, then a walk.');
    assert.equal(byName.result.fileId, file.id);
    assert.equal(byName.card.id, file.id);
    assert.deepEqual(store.read(), before);
  } finally {
    store.close();
  }
});

test('duplicate names require an exact id rather than selecting the first file', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const first = add(store, 'plan.txt', 'First version');
    const second = add(store, 'plan.txt', 'Different version');
    assert.notEqual(first.id, second.id);
    await assert.rejects(
      executeTool(store, 'read_file', { name: 'plan.txt' }),
      /More than one file/,
    );
    assert.equal(
      (await executeTool(store, 'read_file', { id: second.id })).result.text,
      'Different version',
    );
  } finally {
    store.close();
  }
});

test('file references never repair ids, normalize names, match substrings or fall back between selectors', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const file = add(store, 'Plan.txt', 'Private fixture content');
    for (const input of [
      { name: 'plan.txt' },
      { name: 'Plan' },
      { name: 'Plan.txt ' },
      { name: '../Plan.txt' },
      { id: file.id + 'x' },
      { id: 'Plan.txt' },
    ])
      await assert.rejects(executeTool(store, 'read_file', input), /File not found/);
    for (const input of [{}, { id: file.id, name: file.name }, { id: 'wrong', name: file.name }])
      await assert.rejects(
        executeTool(store, 'read_file', input),
        /either the exact file name or its id/,
      );
    for (const input of [
      { name: '' },
      { name: 12 },
      { name: null },
      { id: null },
      { name: 'x'.repeat(1025) },
    ])
      await assert.rejects(
        executeTool(store, 'read_file', input),
        /nonempty exact file name or id/,
      );
  } finally {
    store.close();
  }
});

test('filename resolution uses current workspace state and preserves binary-reader restrictions', async () => {
  const store = new Store(':memory:', { sample: false });
  try {
    const file = add(store, 'current.txt', 'Current data');
    store.mutate((s) => {
      s.files.find((f) => f.id === file.id).name = 'renamed.txt';
    });
    await assert.rejects(
      executeTool(store, 'read_file', { name: 'current.txt' }),
      /File not found/,
    );
    assert.equal(
      (await executeTool(store, 'read_file', { name: 'renamed.txt' })).result.fileId,
      file.id,
    );
    store.mutate((s) =>
      command(s, 'file.add', {
        name: 'archive.zip',
        mime: 'application/zip',
        base64: Buffer.from([0x50, 0x4b, 0, 0xff]).toString('base64'),
      }),
    );
    await assert.rejects(
      executeTool(store, 'read_file', { name: 'archive.zip' }),
      /not readable as text/,
    );
    store.mutate((s) => {
      s.files = [];
    });
    await assert.rejects(executeTool(store, 'read_file', { id: file.id }), /File not found/);
  } finally {
    store.close();
  }
});
