// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { Connectors } from '../server/connectors.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';
import {
  selectedSources,
  selectedSourceTool,
  readSelectedSources,
} from '../server/selected-source-reads.mjs';
import { command } from '../shared/domain.mjs';
import { appContentFixture } from '../scripts/app-content-fixture.mjs';

async function fixture(t, { remote = true } = {}) {
  const store = new Store(':memory:', { sample: false });
  const app = remote ? await appContentFixture() : null;
  const connectors = app ? new Connectors(store, { key: randomBytes(32), timeoutMs: 5000 }) : null;
  t.after(async () => {
    connectors?.close();
    store.close();
    await app?.close();
  });
  let saved;
  if (connectors) {
    const found = await connectors.discover({
      name: 'Little library',
      endpoint: app.endpoint,
      token: app.token,
    });
    saved = connectors.save({
      discoveryId: found.discoveryId,
      permissions: Object.fromEntries(
        found.connection.tools.map((tool) => [tool.name, tool.ownerChoice ? 'ask' : 'auto']),
      ),
    }).connections[0];
  }
  const run = store.mutate((s) => {
    s.files.push(
      {
        id: 'attached-note',
        name: 'Meeting room.txt',
        mime: 'text/plain',
        text: 'Meet in Cedar 412.',
      },
      {
        id: 'other-note',
        name: 'Not selected.txt',
        mime: 'text/plain',
        text: 'Unselected content.',
      },
      { id: 'second-note', name: 'Packing.txt', mime: 'text/plain', text: 'Bring pencils.' },
      { id: 'photo', name: 'Photo.png', mime: 'image/png', base64: 'not-an-image' },
    );
    const result = command(s, 'chat.send', {
      threadId: 'main',
      text: 'Read the selected plan, budget and attached note.',
    });
    const message = s.messages.find((m) => m.id === result.messageId);
    message.fileIds = remote ? ['attached-note', 'photo'] : ['attached-note', 'second-note'];
    result.voiceCallId = 'source-read-call';
    if (saved) result.appContext = [{ id: saved.id, revision: saved.revision, name: saved.name }];
    return result;
  });
  const services = {
    connectors,
    threadId: 'main',
    runId: run.id,
    operationId: 'selected-source-test',
  };
  return {
    store,
    app,
    connectors,
    saved,
    run,
    services,
    catalog: () =>
      selectedSources(
        store.read(),
        store.read().runs.find((r) => r.id === run.id),
        connectors,
      ),
  };
}

test('selected read catalog exposes explicit text sources without reading; it excludes unselected files, photos and reviewed/template actions', async (t) => {
  const f = await fixture(t);
  const sources = f.catalog();
  assert.equal(sources.length, 3);
  assert.equal(sources.filter((s) => s.id.startsWith('app_doc_')).length, 2);
  assert(sources.some((s) => s.id === 'file:attached-note'));
  assert(!JSON.stringify(sources).includes('Unselected content'));
  assert(!sources.some((s) => /photo|other-note/.test(s.id)));
  assert.equal(f.app.calls.length, 0);
  const tool = selectedSourceTool(f.store.read(), f.run, f.connectors);
  assert.deepEqual(
    tool.parameters.properties.sources.items.enum,
    sources.map((s) => s.id),
  );
  assert.equal(
    selectedSourceTool(f.store.read(), { ...f.run, threadId: 'different' }, f.connectors),
    null,
  );
  const changed = f.connectors.update({
    id: f.saved.id,
    revision: f.saved.revision,
    permissions: Object.fromEntries(f.saved.tools.map((tool) => [tool.name, 'ask'])),
  }).connections[0];
  f.store.mutate((s) => {
    s.runs[0].appContext = [{ id: changed.id, revision: changed.revision, name: changed.name }];
  });
  assert.equal(f.catalog().length, 1);
  assert.equal(selectedSourceTool(f.store.read(), f.store.read().runs[0], f.connectors), null);
  assert.equal(f.app.calls.length, 0);
});

test('one selected read retrieves actual independent app documents and attachment, retaining all source cards and idempotent app receipts', async (t) => {
  const f = await fixture(t),
    ids = f.catalog().map((s) => s.id);
  const result = await executeTool(f.store, 'read_selected_sources', { sources: ids }, f.services);
  assert.deepEqual(
    result.result.sources.map((s) => s.id),
    ids,
  );
  assert.match(JSON.stringify(result.result.sources), /Meet at noon/);
  assert.match(JSON.stringify(result.result.sources), /Cedar 412/);
  assert.match(JSON.stringify(result.result.sources), /25/);
  // The app's inline text resource retains its URI in the result; only its
  // binary Budget file and the attached note have saved workspace file cards.
  assert.match(JSON.stringify(result.result.sources[0]), /notebook:\/\/saved\/weekend/);
  assert.equal(result.cards.length, 2);
  assert(result.cards.every((c) => c.kind === 'file' && c.purpose === 'source'));
  assert.equal(new Set(result.cards.map((c) => c.id)).size, 2);
  assert(result.cards.some((c) => c.id === 'attached-note'));
  assert(
    result.cards.some(
      (c) => f.store.read().files.find((file) => file.id === c.id)?.name === 'Budget.csv',
    ),
  );
  assert.equal(f.app.calls.length, 2);
  assert.equal(f.store.read().approvals.length, 0);
  assert.deepEqual(
    await executeTool(f.store, 'read_selected_sources', { sources: ids }, f.services),
    result,
  );
  assert.equal(f.app.calls.length, 2, 'Receipt recovery must not repeat the app reads');
});

test('invalid, duplicate, unselected and revoked source selections perform no partial reads', async (t) => {
  const f = await fixture(t),
    ids = f.catalog().map((s) => s.id);
  for (const input of [
    null,
    {},
    { sources: [] },
    { sources: ids, approve: true },
    { sources: [ids[0], 'file:other-note'] },
    { sources: [ids[0], ids[0]] },
    { sources: Array(9).fill(ids[0]) },
    { sources: [12] },
  ]) {
    await assert.rejects(
      executeTool(f.store, 'read_selected_sources', input, f.services),
      /No source was read/,
    );
  }
  f.connectors.update({ id: f.saved.id, revision: f.saved.revision, enabled: false });
  await assert.rejects(
    executeTool(f.store, 'read_selected_sources', { sources: ids }, f.services),
    /No source was read/,
  );
  assert.equal(f.app.calls.length, 0);
});

test('read plan executes independently, preserves order, bounds each result and explains individual failures', async (t) => {
  const f = await fixture(t, { remote: false }),
    ids = f.catalog().map((s) => s.id);
  let started = 0;
  const ready = Promise.withResolvers();
  const result = await readSelectedSources(
    f.store,
    { sources: ids },
    f.services,
    async (name, input) => {
      assert.equal(name, 'read_file');
      if (++started === 2) ready.resolve();
      await ready.promise;
      if (input.id === 'attached-note')
        return {
          result: { text: 'a'.repeat(12000) },
          card: { kind: 'file', id: input.id, purpose: 'source' },
        };
      throw Object.assign(Error('This source cannot be read now.'), {
        name: 'DocumentUnavailableError',
      });
    },
  );
  assert.deepEqual(
    result.result.sources.map((s) => s.id),
    ids,
  );
  const first = result.result.sources[0];
  assert(first.result.truncated);
  assert.deepEqual(first.result.readWith, {
    name: 'read_file',
    arguments: { id: 'attached-note' },
  });
  assert(first.result.excerpt.length <= 3500);
  assert.equal(result.result.sources[1].code, 'document_unavailable');
  assert.equal(result.cards.length, 1);
});

test('changed attachment content is discarded after an asynchronous read', async (t) => {
  const f = await fixture(t, { remote: false });
  const result = await readSelectedSources(
    f.store,
    { sources: ['file:attached-note'] },
    f.services,
    async () => {
      f.store.mutate((s) => {
        s.files.find((file) => file.id === 'attached-note').text = 'Replacement content.';
      });
      return { result: { text: 'Stale text' }, card: { kind: 'file', id: 'attached-note' } };
    },
  );
  assert.match(result.result.sources[0].error, /changed/);
  assert(!JSON.stringify(result).includes('Stale text'));
  assert.equal(result.cards.length, 0);
});

test('a completed source is revalidated after the other reads settle', async (t) => {
  const f = await fixture(t, { remote: false });
  const result = await readSelectedSources(
    f.store,
    { sources: ['file:attached-note', 'file:second-note'] },
    f.services,
    async (_name, input) => {
      if (input.id === 'second-note') {
        await new Promise((resolve) => setImmediate(resolve));
        f.store.mutate((s) => {
          s.files.find((file) => file.id === 'attached-note').text = 'Replacement content.';
        });
      }
      return {
        result: { text: input.id === 'attached-note' ? 'Stale text' : 'Bring pencils.' },
        card: { kind: 'file', id: input.id, purpose: 'source' },
      };
    },
  );
  assert.match(result.result.sources[0].error, /changed/);
  assert(!JSON.stringify(result).includes('Stale text'));
  assert.equal(result.result.sources[1].result.text, 'Bring pencils.');
  assert.deepEqual(
    result.cards.map((c) => c.id),
    ['second-note'],
  );
});

test('revoking an app while its reads are pending discards app content and preserves independent attachments', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  f.app.hold(gate.promise);
  t.after(() => gate.resolve());
  const pending = executeTool(
    f.store,
    'read_selected_sources',
    { sources: f.catalog().map((s) => s.id) },
    f.services,
  );
  const deadline = Date.now() + 3000;
  while (f.app.calls.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.app.calls.length, 2);
  f.connectors.update({ id: f.saved.id, revision: f.saved.revision, enabled: false });
  gate.resolve();
  const result = await pending;
  assert(result.result.sources.filter((s) => s.id.startsWith('app_doc_')).every((s) => s.error));
  assert(!JSON.stringify(result).includes('Meet at noon'));
  assert.deepEqual(
    result.cards.map((c) => c.id),
    ['attached-note'],
  );
});

test(
  'cancellation reaches every active read and rejects their late results',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t, { remote: false }),
      controller = new AbortController();
    const started = Promise.withResolvers();
    let active = 0,
      cancelled = 0;
    const pending = readSelectedSources(
      f.store,
      { sources: f.catalog().map((s) => s.id) },
      { ...f.services, signal: controller.signal },
      async (_name, _input, services) => {
        if (++active === 2) started.resolve();
        await new Promise((resolve) =>
          services.signal.addEventListener(
            'abort',
            () => {
              cancelled++;
              resolve();
            },
            { once: true },
          ),
        );
        return { result: { text: 'Late response' } };
      },
    );
    const rejected = assert.rejects(pending, /aborted/);
    await started.promise;
    controller.abort();
    await rejected;
    assert.equal(cancelled, 2);
  },
);

for (const voice of [true, false])
  test(`${voice ? 'spoken' : 'typed'} request gathers selected sources in one step and carries source cards through a durable completed reply`, async (t) => {
    const f = await fixture(t);
    if (!voice) {
      delete f.run.voiceCallId;
      f.store.mutate((s) => {
        delete s.runs.find((r) => r.id === f.run.id).voiceCallId;
      });
    }
    let calls = 0;
    const result = await agentReply(
      f.store,
      {
        complete: async (messages, tools) => {
          const batch = tools.find((tool) => tool.name === 'read_selected_sources');
          assert(batch);
          assert.match(messages[0].content, /prefer read_selected_sources/);
          if (++calls === 1)
            return {
              text: '',
              toolCalls: [
                {
                  id: 'read-context',
                  type: 'function',
                  function: {
                    name: batch.name,
                    arguments: JSON.stringify({
                      sources: batch.parameters.properties.sources.items.enum,
                    }),
                  },
                },
              ],
            };
          const output = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
          assert.equal(output.result.sources.length, 3);
          assert(output.sourceData);
          return {
            text: 'Meet at noon in Cedar 412. Bring a book; the total is 33.',
            toolCalls: [],
          };
        },
      },
      f.run,
      f.services,
      { durable: true },
    );
    assert.equal(calls, 2);
    assert.equal(result.cards.length, 2);
    assert(result.cards.every((card) => card.purpose === 'source'));
    assert.equal(f.app.calls.length, 2);
  });
