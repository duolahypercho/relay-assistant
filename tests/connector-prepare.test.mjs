// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { Connectors } from '../server/connectors.mjs';
import { connectorFixture } from '../scripts/connectors-fixture.mjs';

async function setup(t, options = {}, serviceOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-prepare-'));
  const store = new Store(join(dir, 'state.sqlite'), { sample: false });
  const remote = await connectorFixture(options);
  const connectors = new Connectors(store, {
    key: randomBytes(32),
    timeoutMs: 3000,
    ...serviceOptions,
  });
  t.after(async () => {
    connectors.close();
    store.close();
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, remote, connectors };
}

test('address-only setup discovers without auth, actions or saved connections, then saves a reviewed name', async (t) => {
  const { store, remote, connectors } = await setup(t, { authenticate: () => true });
  const before = store.read();
  const result = await connectors.prepare({ endpoint: remote.endpoint });
  assert.equal(result.connection.name, 'Local app');
  assert.equal(result.connection.tools.length, 3);
  assert(result.connection.tools.every((t) => t.mode === 'ask'));
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(connectors.read(), []);
  assert.deepEqual(store.read(), before);
  const permissions = Object.fromEntries(result.connection.tools.map((t) => [t.name, t.mode]));
  assert.throws(
    () => connectors.save({ discoveryId: result.discoveryId, permissions, name: '' }),
    /valid app name/,
  );
  const saved = connectors.save({
    discoveryId: result.discoveryId,
    permissions,
    name: 'My notebook',
  });
  assert.equal(saved.connections[0].name, 'My notebook');
  assert(saved.connections[0].tools.every((t) => t.mode === 'ask'));
  assert.equal(remote.calls.length, 0);
});

test('only an auth rejection offers sign-in; a token can finish the same flow', async (t) => {
  const { remote, connectors } = await setup(t);
  assert.deepEqual(await connectors.prepare({ endpoint: remote.endpoint }), {
    signInRequired: true,
    name: 'Local app',
  });
  assert.deepEqual(connectors.read(), []);
  assert.equal(connectors.discoveries.size, 0);
  const result = await connectors.prepare({ endpoint: remote.endpoint, token: remote.token });
  assert.equal(result.connection.tools.length, 3);
  assert(!JSON.stringify(result).includes(remote.token));
  assert.equal(remote.calls.length, 0);
});

test('bad addresses, network failures and cancellation do not pretend to require sign-in', async (t) => {
  const { remote, connectors } = await setup(
    t,
    {},
    {
      fetcher: async () => {
        throw Error('offline');
      },
    },
  );
  await assert.rejects(connectors.prepare({ endpoint: 'file:///tmp/app' }), /HTTPS/);
  await assert.rejects(
    connectors.prepare({ endpoint: 'https://app.example/mcp?token=private' }),
    /parameters/,
  );
  await assert.rejects(connectors.prepare({ endpoint: remote.endpoint }), {
    name: 'ConnectorError',
  });
  await assert.rejects(connectors.prepare({ endpoint: remote.endpoint }, AbortSignal.abort()), {
    name: 'AbortError',
  });
  assert.equal(connectors.discoveries.size, 0);
});

test('derived app names use only the endpoint host, and still enforce revisions', async (t) => {
  const { remote, connectors } = await setup(
    t,
    { authenticate: () => true },
    {
      fetcher: (_url, init) => fetch(remote.endpoint, init),
    },
  );
  const result = await connectors.prepare({ endpoint: 'https://notes.example/mcp' });
  assert.equal(result.connection.name, 'notes.example');
  const saved = connectors.save({ discoveryId: result.discoveryId, permissions: {} })
    .connections[0];
  await assert.rejects(
    connectors.prepare({ id: saved.id, revision: 0, endpoint: saved.endpoint }),
    /changed/,
  );
  assert.equal(remote.calls.length, 0);
});
