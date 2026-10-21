// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { ModelConnections } from '../server/model-connections.mjs';
import { LocalModelSetup } from '../server/local-model-setup.mjs';
import { localModelSuggestion } from '../server/local-model-downloads.mjs';
import { createApp } from '../server/app.mjs';

function fixture() {
  const store = new Store(':memory:', { sample: false });
  const provider = new ModelConnections(store, { key: Buffer.alloc(32, 7) });
  const flags = { installed: false, running: false, model: false, hold: '', fail: '', calls: [] };
  const makeJob = (step, done) => ({
    state: null,
    pending: null,
    status() {
      return step === 'installing'
        ? { supported: true, bytes: 100, installation: this.state }
        : { download: this.state };
    },
    start({ id }) {
      flags.calls.push(step);
      this.state = { id, phase: 'running', completed: 10, total: 100, stage: step };
      this.controller = new AbortController();
      this.pending = (async () => {
        while (flags.hold === step && !this.controller.signal.aborted) await delay(2);
        this.state.phase = this.controller.signal.aborted
          ? 'cancelled'
          : flags.fail === step
            ? 'error'
            : 'ready';
        if (this.state.phase === 'ready') done();
      })().finally(() => {
        this.pending = null;
      });
    },
    async cancel({ id }) {
      assert.equal(id, this.state.id);
      this.controller.abort();
      await this.pending;
    },
  });
  const installation = makeJob('installing', () => {
    flags.installed = true;
  });
  const downloads = makeJob('downloading', () => {
    flags.model = true;
  });
  const runtime = {
    pending: null,
    async status() {
      return { running: flags.running, installed: flags.installed, revision: 0 };
    },
    async start(input, signal) {
      assert.equal(input.revision, 0);
      flags.calls.push('starting');
      while (flags.hold === 'starting' && !signal.aborted) await delay(2);
      signal.throwIfAborted();
      if (flags.fail === 'starting') throw Error('Do not leak /private/runtime/token');
      flags.running = true;
    },
  };
  provider.discoverLocal = async () => {
    flags.calls.push('catalog');
    return {
      services: [
        { preset: 'ollama', models: flags.model ? [{ id: localModelSuggestion.model }] : [] },
      ],
    };
  };
  const options = { installation, runtime, downloads, provider };
  const setup = new LocalModelSetup(store, options);
  const input = () => ({
    id: randomUUID(),
    model: localModelSuggestion.model,
    selection: setup.selection(),
    install: true,
    startWithRelay: true,
  });
  return {
    store,
    provider,
    flags,
    setup,
    options,
    input,
    async close() {
      await setup.close();
      store.close();
    },
  };
}
async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await delay(2);
  }
  throw Error('Wait expired');
}
const saved = (provider, model = 'prior:1b') =>
  provider.save({ preset: 'ollama', model, protocol: 'chat', apiKey: '', activate: true });

test('one explicit action installs, starts, downloads and activates without changing history; repeat delivery is idempotent', async () => {
  const f = fixture();
  try {
    const before = f.store.read(),
      input = f.input();
    assert.equal(f.setup.status().job, null);
    assert.deepEqual(f.flags.calls, []);
    f.setup.start(input);
    f.setup.start(input);
    await f.setup.pending;
    assert.equal(f.setup.status().job.connected, true);
    assert.deepEqual(f.flags.calls, [
      'installing',
      'starting',
      'catalog',
      'downloading',
      'catalog',
    ]);
    assert.equal(f.provider.model, localModelSuggestion.model);
    assert.equal(f.provider.publicState().connections.length, 1);
    f.setup.start(input);
    assert.equal(f.provider.publicState().connections.length, 1);
    assert.deepEqual(f.store.read(), before);
    assert.equal(JSON.stringify(f.setup.status()).includes('installId'), false);
  } finally {
    await f.close();
  }
});
test('reuse running service, downloaded model and saved connection without extra install, launch or pull', async () => {
  const f = fixture();
  try {
    Object.assign(f.flags, { running: true, model: true });
    const connection = saved(f.provider, localModelSuggestion.model);
    f.provider.select(null);
    f.setup.start(f.input());
    await f.setup.pending;
    assert.deepEqual(f.flags.calls, ['catalog']);
    assert.equal(f.provider.current.id, connection.id);
    assert.equal(f.provider.publicState().connections.length, 1);
    f.provider.save({
      id: connection.id,
      preset: 'ollama',
      model: 'changed:1b',
      protocol: 'chat',
      apiKey: '',
      activate: true,
    });
    assert.equal(
      f.setup.status().job.connected,
      false,
      'Editing the connection cannot leave a stale success badge.',
    );
  } finally {
    await f.close();
  }
});
for (const step of ['installing', 'starting', 'downloading'])
  test(`cancel during ${step} prevents activation and can resume`, async () => {
    const f = fixture();
    try {
      const prior = saved(f.provider);
      f.flags.hold = step;
      f.setup.start(f.input());
      await until(() => f.flags.calls.includes(step));
      await assert.rejects(f.setup.cancel({ id: randomUUID() }), /changed/);
      assert.throws(() => f.setup.start(f.input()), /running/);
      await f.setup.cancel({ id: f.setup.state.id });
      assert.equal(f.setup.status().job.phase, 'cancelled');
      assert.equal(f.provider.current.id, prior.id);
      f.flags.hold = '';
      f.setup.start(f.input());
      await f.setup.pending;
      assert.equal(f.setup.status().job.connected, true);
    } finally {
      await f.close();
    }
  });
test('changed selection, including away and back, requires review instead of late automatic activation', async () => {
  const f = fixture();
  try {
    const prior = saved(f.provider);
    f.flags.hold = 'downloading';
    f.setup.start(f.input());
    await until(() => f.flags.calls.includes('downloading'));
    f.provider.select(null);
    f.provider.select(prior.id);
    f.flags.hold = '';
    await f.setup.pending;
    assert.equal(f.setup.state.phase, 'review');
    assert.equal(f.provider.current.id, prior.id);
    assert.equal(f.flags.model, true);
    f.setup.start(f.input());
    await f.setup.pending;
    assert.equal(f.setup.status().job.connected, true);
  } finally {
    await f.close();
  }
});
test('reject stale consent, changed model, invalid request and conflicting jobs before any work', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { id: 'bad' },
      { model: 'other:4b' },
      { install: undefined },
      { startWithRelay: 'yes' },
    ])
      assert.throws(() => f.setup.start({ ...f.input(), ...patch }), /Review/);
    const stale = f.input();
    saved(f.provider);
    assert.throws(() => f.setup.start(stale), /changed/);
    f.options.downloads.pending = Promise.resolve();
    assert.throws(() => f.setup.start(f.input()), /current installation/);
    f.options.downloads.pending = null;
    assert.deepEqual(f.flags.calls, []);
    f.setup.start({ ...f.input(), install: false });
    await f.setup.pending;
    assert.equal(f.setup.state.phase, 'error');
    assert.deepEqual(f.flags.calls, []);
  } finally {
    await f.close();
  }
});
for (const step of ['installing', 'starting', 'downloading'])
  test(`failed ${step} stays recoverable and preserves previous model`, async () => {
    const f = fixture();
    try {
      const prior = saved(f.provider);
      f.flags.fail = step;
      f.setup.start(f.input());
      await f.setup.pending;
      assert.equal(f.setup.state.phase, 'error');
      assert.equal(f.provider.current.id, prior.id);
      assert(!JSON.stringify(f.setup.status()).includes('/private/'));
      f.flags.fail = '';
      f.setup.start(f.input());
      await f.setup.pending;
      assert.equal(f.setup.status().job.connected, true);
    } finally {
      await f.close();
    }
  });
test('server shutdown and crash recovery keep progress durable without silently resuming', async () => {
  const f = fixture();
  try {
    f.flags.hold = 'downloading';
    f.setup.start(f.input());
    await until(() => f.flags.calls.includes('downloading'));
    await f.setup.close();
    assert.equal(f.setup.state.phase, 'interrupted');
    f.store.secret('local-model-setup', JSON.stringify({ ...f.setup.state, phase: 'running' }));
    const before = f.flags.calls.length;
    const recovered = new LocalModelSetup(f.store, f.options);
    assert.equal(recovered.status().job.phase, 'interrupted');
    assert.equal(f.flags.calls.length, before);
    assert.equal(f.provider.configured, false);
    await recovered.close();
  } finally {
    await f.close();
  }
});
test('owner API denies anonymous/cross-origin setup and locks individual controls while combined setup runs', async () => {
  const f = fixture();
  const services = {
    mode: 'live',
    provider: f.provider,
    localModelSetup: f.setup,
    localModelInstallation: f.options.installation,
    localModelRuntime: f.options.runtime,
    localModelDownloads: f.options.downloads,
    google: {},
    browser: {},
    terminal: {},
  };
  const server = createApp(f.store, services, {
    host: '127.0.0.1',
    port: 0,
    accessKey: 'setup-owner-key',
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', source = origin) =>
    fetch(origin + '/api/' + path, {
      method: 'POST',
      headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post('models/local/setup/start', f.input())).status, 401);
    const cookie = (await post('login', { key: 'setup-owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('models/local/setup/start', f.input(), cookie, 'https://outside.test')).status,
      403,
    );
    assert.equal((await post('models/local/setup/execute', {}, cookie)).status, 400);
    f.flags.hold = 'installing';
    const result = await post('models/local/setup/start', f.input(), cookie);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    await until(() => f.flags.calls.includes('installing'));
    for (const path of [
      'installation/start',
      'installation/cancel',
      'download/start',
      'download/cancel',
      'start',
      'preference',
    ])
      assert.equal((await post('models/local/' + path, {}, cookie)).status, 409);
    assert.equal(
      (await post('models/local/setup/cancel', { id: f.setup.state.id }, cookie)).status,
      200,
    );
    assert.equal(f.provider.configured, false);
    assert.equal(f.store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await f.close();
  }
});
