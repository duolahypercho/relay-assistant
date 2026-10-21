// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalModelInstallation, downloadOllama } from '../server/local-model-installation.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
const bytes = Buffer.from('Independent installation fixture bytes');
const artifact = {
  version: 'test',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  url: 'https://github.com/ollama/ollama/releases/download/test/fixture.tgz',
  details: 'https://github.com/ollama/ollama',
};
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-installer-'));
  const store = new Store(':memory:', { sample: false });
  const calls = [];
  let mode = 'ready';
  const config = {
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '23.0',
    artifact,
    fetcher: async (url, init) => {
      calls.push({ url, ...init });
      if (mode === 'fail') throw Error('Private path/token must not leak');
      if (mode === 'hold')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 4));
              init.signal.addEventListener(
                'abort',
                () => {
                  try {
                    controller.error(init.signal.reason);
                  } catch {}
                },
                { once: true },
              );
            },
          }),
        );
      return new Response(
        mode === 'corrupt'
          ? Buffer.alloc(bytes.length, 1)
          : mode === 'big'
            ? Buffer.concat([bytes, bytes])
            : bytes,
      );
    },
    unpack: async (_archive, destination, signal) => {
      signal.throwIfAborted();
      calls.push('unpack');
      await writeFile(join(destination, 'ollama'), 'never executed fixture', { mode: 0o700 });
    },
    ...options,
  };
  const make = () => new LocalModelInstallation(store, directory, config);
  const manager = make();
  return {
    directory,
    store,
    calls,
    config,
    manager,
    make,
    setMode: (value) => {
      mode = value;
    },
    async close() {
      await manager.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await delay(5);
  }
  throw Error('Deadline');
}

test('explicit install pins bytes, stays private, deduplicates, survives restart and never touches chats or models', async () => {
  const f = await fixture();
  try {
    const before = f.store.read();
    assert.equal(f.manager.status().installation, null);
    assert.equal(await f.manager.executable(), null);
    assert.equal(f.calls.length, 0);
    const id = randomUUID();
    f.manager.start({
      id,
      url: 'http://outside.test/private',
      command: 'bad',
      directory: '/tmp/wrong',
    });
    assert.equal(f.manager.start({ id }).installation.id, id);
    assert.throws(() => f.manager.start({ id: randomUUID() }), /current installation/);
    await f.manager.pending;
    assert.equal(f.manager.status().installation.phase, 'ready');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].url, artifact.url);
    assert.equal(f.calls[0].redirect, 'manual');
    assert.equal(f.calls[0].headers, undefined);
    assert.deepEqual(await readdir(f.manager.root), ['vtest']);
    assert.equal(await readFile(await f.manager.executable(), 'utf8'), 'never executed fixture');
    assert.deepEqual(f.store.read(), before);
    const restored = f.make();
    assert.equal(restored.status().installation.phase, 'ready');
    assert.equal(await restored.executable(), await f.manager.executable());
    restored.start({ id: randomUUID() });
    await restored.pending;
    assert.equal(f.calls.length, 2, 'A verified copy is reused without downloading.');
    await restored.close();
    assert(!JSON.stringify(f.manager.status()).includes(f.directory));
  } finally {
    await f.close();
  }
});
for (const mode of ['corrupt', 'big', 'fail'])
  test(`failed ${mode} download installs nothing and can retry`, async () => {
    const f = await fixture();
    try {
      f.setMode(mode);
      f.manager.start({});
      await f.manager.pending;
      assert.equal(f.manager.status().installation.phase, 'error');
      assert.equal(await f.manager.executable(), null);
      assert.deepEqual(await readdir(f.manager.root), []);
      assert(!f.calls.includes('unpack'));
      assert(!JSON.stringify(f.manager.status()).includes('Private path'));
      f.setMode('ready');
      f.manager.start({});
      await f.manager.pending;
      assert.equal(f.manager.status().installation.phase, 'ready');
    } finally {
      await f.close();
    }
  });
test('cancel requires the current request, drains in-flight bytes and removes staging before retry', async () => {
  const f = await fixture();
  try {
    f.setMode('hold');
    const { installation: job } = f.manager.start({});
    await waitFor(() => f.manager.state.completed > 0);
    await assert.rejects(f.manager.cancel({ id: randomUUID() }), /changed/);
    assert.equal(f.manager.state.phase, 'running');
    await f.manager.cancel({ id: job.id });
    assert.equal(f.manager.state.phase, 'cancelled');
    assert.deepEqual(await readdir(f.manager.root), []);
    assert.equal(await f.manager.executable(), null);
    f.setMode('ready');
    f.manager.start({});
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
  } finally {
    await f.close();
  }
});
test('shutdown and crash recovery never restart downloads; only the saved staging directory is removed on explicit retry', async () => {
  const f = await fixture();
  try {
    f.setMode('hold');
    f.manager.start({});
    await waitFor(() => f.manager.state.completed > 0);
    await f.manager.close();
    assert.equal(f.manager.state.phase, 'interrupted');
    const saved = JSON.parse(f.store.secret('local-model-installation'));
    saved.phase = 'running';
    f.store.secret('local-model-installation', JSON.stringify(saved));
    const orphan = join(f.manager.root, '.install-' + saved.id);
    await mkdir(orphan);
    await writeFile(join(orphan, 'release.tgz'), 'partial');
    await mkdir(join(f.manager.root, 'unrelated'));
    await writeFile(join(f.manager.root, 'unrelated', 'keep'), 'keep');
    const recovered = f.make(),
      requests = f.calls.length;
    assert.equal(recovered.state.phase, 'interrupted');
    assert.equal(f.calls.length, requests);
    f.setMode('ready');
    recovered.start({});
    await recovered.pending;
    assert.equal(recovered.state.phase, 'ready');
    assert.deepEqual((await readdir(recovered.root)).sort(), ['unrelated', 'vtest']);
    await recovered.close();
  } finally {
    await f.close();
  }
});
test('stalled transfers stop without installing or retaining archive parts', async () => {
  const f = await fixture({ stall: 25 });
  try {
    f.setMode('hold');
    f.manager.start({});
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'error');
    assert.equal(await f.manager.executable(), null);
    assert.deepEqual(await readdir(f.manager.root), []);
  } finally {
    await f.close();
  }
});
test('unsupported operating systems and malformed IDs never fetch', async () => {
  for (const options of [{ platform: 'linux' }, { osRelease: '22.6' }, { arch: 'other' }]) {
    const f = await fixture(options);
    try {
      assert.throws(() => f.manager.start({}), /macOS 14/);
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  }
  const f = await fixture();
  try {
    assert.throws(() => f.manager.start({ id: '../outside' }), /new installation/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
test('existing directories and symlink executables are never accepted or replaced', async () => {
  const f = await fixture();
  try {
    await mkdir(f.manager.destination, { recursive: true });
    await writeFile(join(f.manager.destination, 'keep'), 'untouched');
    f.manager.start({});
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'error');
    assert.equal(await readFile(join(f.manager.destination, 'keep'), 'utf8'), 'untouched');
    await writeFile(join(f.manager.destination, 'relay-install.json'), JSON.stringify(artifact));
    await symlink('/bin/sh', join(f.manager.destination, 'ollama'));
    assert.equal(await f.manager.executable(), null);
  } finally {
    await f.close();
  }
});
test('release redirects accept only HTTPS GitHub release assets and enforce byte length', async () => {
  for (const target of [
    'http://release-assets.githubusercontent.com/file',
    'https://evil.test/file',
    'https://user:pass@release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com:444/file',
  ]) {
    let calls = 0;
    await assert.rejects(
      downloadOllama(
        async () => {
          calls++;
          return new Response(null, { status: 302, headers: { location: target } });
        },
        artifact,
        new AbortController().signal,
      ),
      /redirect/,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const response = await downloadOllama(
    async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return calls++ === 0
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/allowed' },
          })
        : new Response(bytes);
    },
    artifact,
    new AbortController().signal,
  );
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), bytes.toString());
  await assert.rejects(
    downloadOllama(
      async () => new Response(bytes, { headers: { 'content-length': '999' } }),
      artifact,
    ),
    /changed/,
  );
});
test('installation API requires owner and same-origin authorization and exposes no arbitrary execution', async () => {
  const f = await fixture();
  const app = createApp(
    f.store,
    {
      mode: 'live',
      provider: { publicState: () => ({}) },
      localModelInstallation: f.manager,
      google: {},
      browser: {},
      terminal: {},
    },
    { host: '127.0.0.1', port: 0, accessKey: 'install-owner-key' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', source = origin) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('models/local/installation/start', {})).status, 401);
    const cookie = (await post('login', { key: 'install-owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('models/local/installation/start', {}, cookie, 'https://outside.test')).status,
      403,
    );
    assert.equal((await post('models/local/installation/execute', {}, cookie)).status, 400);
    assert.equal(f.calls.length, 0);
    const reply = await post(
      'models/local/installation/start',
      { url: 'https://outside.test/file' },
      cookie,
    );
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
    const status = await fetch(origin + '/api/models/local/installation', {
      headers: { Cookie: cookie },
    });
    assert.equal((await status.json()).installation.phase, 'ready');
    assert.equal(f.store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await f.close();
  }
});
