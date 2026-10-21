// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { ComputerEngine } from '../server/computer-engine.mjs';
import { ComputerMaintenance } from '../server/computer-maintenance.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { createApp } from '../server/app.mjs';
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
function fixture() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true, deployment: 'sleep-test' });
  const calls = [];
  let vm = 'Running',
    failure = '',
    gate;
  const setup = new ComputerSetup(computer, {
    environment: {},
    root: '.',
    runner: async (binary, args, options) => {
      calls.push({ binary, args, env: options.env });
      if (args[0] === 'list')
        return ok(JSON.stringify({ name: 'relay', runtime: 'docker', status: vm }));
      assert.deepEqual(args, ['stop', '--profile', 'relay']);
      if (gate) await gate;
      if (failure === 'command')
        return { ...ok(), exitCode: 1, stderr: 'secret internal diagnostic' };
      if (failure !== 'unconfirmed') vm = 'Stopped';
      return ok();
    },
  });
  setup.installation = {
    selected: true,
    policyAllows: true,
    root: '/private/relay',
    host: 'unix:///private/relay/colima/relay/docker.sock',
    profile: 'relay',
    colima: '/private/relay/tools/bin/colima',
    env: { HOME: '/private/relay/home', COLIMA_HOME: '/private/relay/colima' },
    owned: async () => true,
    release: { installed: async () => true },
  };
  const steps = [];
  computer.stop = async () => {
    steps.push('workspace');
    return computer.status();
  };
  const engine = setup.engineControl;
  return {
    store,
    computer,
    setup,
    engine,
    calls,
    steps,
    vm: (s) => (vm = s),
    fail: (s) => (failure = s),
    hold: () => {
      let release;
      gate = new Promise((r) => (release = r));
      return release;
    },
    async close() {
      await engine.close();
      store.close();
    },
  };
}

test('owner Stop drains work and browser before sleeping only the private VM; duplicates do not repeat it', async () => {
  const f = fixture();
  const release = f.hold();
  try {
    const before = structuredClone(f.store.read().messages);
    const result = await f.engine.stop({ beforeSleep: async () => f.steps.push('browser') });
    assert.equal(result.state, 'stopping');
    assert.equal(result.controller, 'owner');
    assert.equal(result.managedEngine, true);
    assert.equal(f.engine.view().cancellable, false);
    assert.throws(() => f.engine.start(), /finish stopping/);
    await assert.rejects(f.computer.start('agent'), /finish stopping/);
    await assert.rejects(f.computer.takeControl(), /finish stopping/);
    assert.throws(
      () => new ComputerMaintenance(f.computer, f.setup).prepare('recover'),
      /finish stopping/,
    );
    await f.engine.stop();
    await f.engine.cancel();
    release();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'asleep');
    assert.equal(f.computer.engineStopping, false);
    assert.deepEqual(f.steps, ['workspace', 'browser']);
    const stops = f.calls.filter((c) => c.args[0] === 'stop');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].binary, f.setup.installation.colima);
    assert.deepEqual(stops[0].env, f.setup.installation.env);
    assert.equal(f.store.secret('computer-engine-stop'), undefined);
    assert.deepEqual(f.store.read().messages, before);
  } finally {
    release();
    await f.close();
  }
});

test('shared engines retain their existing stop behavior and never dispatch a VM command', async () => {
  const f = fixture();
  try {
    f.setup.installation.selected = false;
    f.computer.stop = async () => {
      f.steps.push('workspace');
      return { state: 'stopped' };
    };
    assert.equal((await f.engine.stop()).state, 'stopped');
    assert.deepEqual(f.steps, ['workspace']);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test('missing ownership, changed binding, unsupported runtime and unverified tools keep VM and files untouched', async () => {
  for (const kind of ['owner', 'tools', 'status', 'binding']) {
    const f = fixture();
    try {
      if (kind === 'owner') f.setup.installation.owned = async () => false;
      if (kind === 'tools') f.setup.installation.release.installed = async () => false;
      if (kind === 'status') f.vm('Unknown');
      if (kind === 'binding')
        f.setup.installation.owned = async () => {
          f.setup.installation = { ...f.setup.installation };
          return true;
        };
      await f.engine.stop();
      await f.engine.pending;
      assert.equal(f.engine.phase, 'error');
      assert.deepEqual(f.steps, []);
      assert.equal(f.calls.filter((c) => c.args[0] === 'stop').length, 0);
      assert(!f.store.secret('computer-engine-stop')?.includes('diagnostic'));
    } finally {
      await f.close();
    }
  }
});

test('failed or unconfirmed sleep stays visible and retries without forcing or deleting disks', async () => {
  for (const kind of ['command', 'unconfirmed']) {
    const f = fixture();
    try {
      f.fail(kind);
      await f.engine.stop();
      await f.engine.pending;
      assert.equal(f.engine.phase, 'error');
      assert.match(f.engine.error, /may still be running/);
      assert(!f.engine.error.includes('diagnostic'));
      assert.equal(f.computer.controller, 'owner');
      assert(f.store.secret('computer-engine-stop'));
      f.fail('');
      await f.engine.stop();
      await f.engine.pending;
      assert.equal(f.engine.phase, 'asleep');
      assert(!f.calls.some((c) => c.args.includes('--force') || c.args.includes('delete')));
    } finally {
      await f.close();
    }
  }
});

test('already-sleeping private VM is idempotent; interrupted restart waits for explicit retry', async () => {
  const f = fixture();
  try {
    f.store.secret('computer-engine-stop', 'pending');
    const restored = new ComputerEngine(f.setup);
    assert.equal(restored.phase, 'error');
    assert.equal(restored.intent, 'stop');
    assert.equal(restored.pending, null);
    assert.deepEqual(f.calls, []);
    f.setup.installation.selected = false;
    assert.equal(restored.view().error, '');
    f.setup.installation.selected = true;
    f.vm('Stopped');
    await restored.stop();
    await restored.pending;
    assert.equal(restored.phase, 'asleep');
    assert.deepEqual(f.steps, []);
    assert(!f.calls.some((c) => c.args[0] === 'stop'));
    await restored.close();
  } finally {
    await f.close();
  }
});

test('maintenance, startup and setup prevent overlapping private shutdown; service close drains an admitted stop', async () => {
  const f = fixture();
  try {
    f.setup.pending = Promise.resolve();
    assert.throws(() => f.engine.stop(), /maintenance/);
    f.setup.pending = null;
    f.setup.maintenance = { pending: Promise.resolve() };
    assert.throws(() => f.engine.stop(), /maintenance/);
    f.setup.maintenance = null;
    f.engine.pending = Promise.resolve();
    f.engine.intent = 'open';
    assert.throws(() => f.engine.stop(), /startup/);
    f.engine.pending = null;
    const release = f.hold();
    await f.engine.stop();
    let closed = false;
    const closing = f.engine.close().then(() => (closed = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(f.engine.phase, 'asleep');
  } finally {
    await f.close();
  }
});

test('private browser sleep drains its context and runtime but allows a later launch; unrelated sleep is rejected', async () => {
  const f = fixture();
  const steps = [];
  const browser = new TrustedBrowser(f.store, {
    enabled: true,
    key: Buffer.alloc(32, 7),
    control: f.computer,
    runtime: {
      dispose: async () => steps.push('dispose'),
      close: async () => steps.push('close'),
    },
  });
  try {
    await assert.rejects(browser.sleep(), /Stop the private computer/);
    f.computer.engineStopping = true;
    browser.browser = { close: async () => steps.push('browser') };
    await browser.sleep();
    assert.deepEqual(steps, ['browser', 'dispose']);
    assert.equal(browser.browser, null);
    assert(!browser.closed);
    f.computer.engineStopping = false;
  } finally {
    await browser.close();
    await f.close();
  }
  assert(steps.includes('close'));
});

test('Stop API requires owner and same-origin; client JSON cannot override private profile or executable', async () => {
  const f = fixture();
  const app = createApp(
    f.store,
    {
      computer: f.computer,
      computerSetup: f.setup,
      mode: 'sample',
      browser: { enabled: false },
      terminal: { enabled: false },
      provider: { configured: false },
      google: { configured: false },
    },
    { host: '127.0.0.1', port: 0, accessKey: 'private-sleep-owner-key-for-test' },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/api/computer/stop', { method: 'POST' })).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'private-sleep-owner-key-for-test' }),
    });
    const headers = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      'Content-Type': 'application/json',
    };
    assert.equal(
      (
        await fetch(url + '/api/computer/stop', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://elsewhere.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    const response = await fetch(url + '/api/computer/stop', {
      method: 'POST',
      headers,
      body: JSON.stringify({ profile: 'owner', executable: '/bin/evil', force: true }),
    });
    assert.equal(response.status, 200);
    await f.engine.pending;
    assert.deepEqual(f.calls.find((c) => c.args[0] === 'stop').args, [
      'stop',
      '--profile',
      'relay',
    ]);
    assert.equal(f.engine.phase, 'asleep');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await f.close();
  }
});

test('a failed recovery-marker write never admits shutdown or leaves the computer locked', async () => {
  const f = fixture();
  const secret = f.store.secret.bind(f.store);
  try {
    f.store.secret = (name, value) => {
      if (name === 'computer-engine-stop' && value !== undefined)
        throw Error('Storage unavailable');
      return secret(name, value);
    };
    assert.throws(() => f.engine.stop(), /Storage unavailable/);
    assert.equal(f.engine.pending, null);
    assert(!f.computer.engineStopping);
    assert.equal(f.computer.controller, 'agent');
    assert.deepEqual(f.calls, []);
    f.computer.assertAvailable();
  } finally {
    f.store.secret = secret;
    await f.close();
  }
});
