// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { ComputerEngine } from '../server/computer-engine.mjs';
import { createApp } from '../server/app.mjs';
const host = 'unix:///test/.colima/relay/docker.sock';
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const bad = () => ({ stdout: '', stderr: 'private subprocess diagnostic', exitCode: 1 });
function fixture({ enabled = true, environment = {}, selected = host, rows } = {}) {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, {
    enabled,
    dockerHost: enabled ? selected : undefined,
  });
  const calls = [];
  let running = false;
  let opened = 0;
  const runner = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (binary === 'colima-test') {
      if (args[0] === 'list')
        return ok(
          rows ??
            JSON.stringify({
              name: 'relay',
              status: running ? 'Running' : 'Stopped',
              runtime: 'docker',
            }),
        );
      if (args[0] === 'start') {
        running = true;
        return ok();
      }
      throw Error('Unexpected Colima command');
    }
    if (args[0] === '--version') return ok('Docker');
    if (args[0] === 'context')
      return ok(JSON.stringify([{ Endpoints: { docker: { Host: selected } } }]));
    if (args.includes('info')) return running && args.includes(host) ? ok('linux') : bad();
    return bad();
  };
  const setup = new ComputerSetup(computer, { root: '.', home: '/test', runner, environment });
  const engine = (setup.engineControl = new ComputerEngine(setup, {
    platform: 'darwin',
    colima: 'colima-test',
  }));
  computer.start = async (actor) => {
    assert.equal(actor, 'owner');
    opened++;
  };
  return {
    store,
    computer,
    setup,
    engine,
    calls,
    runner,
    opened: () => opened,
    running: (value) => {
      running = value;
    },
  };
}
test('only an existing selected profile wakes with fixed flags and continues owner startup once', async () => {
  const f = fixture();
  try {
    const before = structuredClone(f.store.read());
    assert.equal((await f.engine.status()).canStart, true);
    assert.equal(
      f.calls.some((c) => c.args[0] === 'start'),
      false,
    );
    f.engine.start();
    f.engine.start();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'ready');
    assert.equal(f.opened(), 1);
    assert.deepEqual(
      f.calls.filter((c) => c.binary === 'colima-test' && c.args[0] === 'start').map((c) => c.args),
      [
        [
          'start',
          '--profile',
          'relay',
          '--activate=false',
          '--save-config=false',
          '--ssh-config=false',
        ],
      ],
    );
    assert.deepEqual(f.store.read(), before);
    assert.equal((await f.engine.status()).canStart, false);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
test('disabled, remote, malformed, absent and non-Docker profiles never dispatch a runtime start', async () => {
  for (const options of [
    { environment: { RELAY_DESKTOP_ENABLED: 'false' } },
    { selected: 'ssh://remote/engine' },
    { selected: 'unix:///different/docker.sock' },
    { selected: 'unix:///test/.colima/../docker.sock' },
    { rows: '{invalid' },
    { rows: JSON.stringify({ name: 'another', status: 'Stopped', runtime: 'docker' }) },
    { rows: JSON.stringify({ name: 'relay', status: 'Stopped', runtime: 'containerd' }) },
    { rows: JSON.stringify({ name: 'relay', status: 'Broken', runtime: 'docker' }) },
  ]) {
    const f = fixture(options);
    try {
      assert.equal((await f.engine.status()).canStart, false);
      if (!f.setup.allowed) assert.throws(() => f.engine.start(), /disabled/);
      else {
        f.engine.start();
        await f.engine.pending;
        assert.equal(f.engine.phase, 'error');
      }
      assert.equal(
        f.calls.some((c) => c.binary === 'colima-test' && c.args[0] === 'start'),
        false,
      );
      assert.equal(f.opened(), 0);
    } finally {
      await f.engine.close();
      f.store.close();
    }
  }
});
test('a changed profile is rechecked at dispatch and errors do not expose process output', async () => {
  const f = fixture();
  try {
    assert.equal((await f.engine.status()).canStart, true);
    f.setup.runner = (binary, args, options) =>
      binary === 'colima-test' && args[0] === 'list' ? ok('') : f.runner(binary, args, options);
    f.engine.start();
    await f.engine.pending;
    assert.equal(f.opened(), 0);
    assert.equal(
      f.calls.some((c) => c.args[0] === 'start'),
      false,
    );
    f.setup.runner = (binary, args, options) =>
      binary === 'colima-test' && args[0] === 'start' ? bad() : f.runner(binary, args, options);
    f.engine.start();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'error');
    assert(!JSON.stringify(f.engine.view()).includes('private subprocess diagnostic'));
    f.setup.runner = f.runner;
    f.engine.start();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'ready');
    assert.equal(f.opened(), 1);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
test('cancel and service close stop the pending command, never open the desktop or stop a shared VM', async () => {
  for (const action of ['cancel', 'close']) {
    const f = fixture();
    let entered;
    const started = new Promise((r) => {
      entered = r;
    });
    f.setup.runner = async (binary, args, options) => {
      if (binary !== 'colima-test' || args[0] !== 'start') return f.runner(binary, args, options);
      entered();
      await new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      );
    };
    try {
      f.engine.start();
      await started;
      assert.equal(f.engine.view().cancellable, true);
      await f.engine[action]();
      assert.equal(f.engine.phase, 'cancelled');
      assert.equal(f.opened(), 0);
      assert.equal(
        f.calls.some((c) => c.args[0] === 'stop'),
        false,
      );
    } finally {
      await f.engine.close();
      f.store.close();
    }
  }
});
test('opening is non-cancellable and respects existing computer lifecycle gates', async () => {
  const f = fixture();
  let release, entered;
  const opening = new Promise((r) => {
    entered = r;
  });
  f.computer.start = async () => {
    entered();
    await new Promise((r) => {
      release = r;
    });
  };
  try {
    f.computer.snapshotBlocked = true;
    assert.throws(() => f.engine.start(), /restore-point/);
    f.computer.snapshotBlocked = false;
    f.computer.maintenance = true;
    assert.throws(() => f.engine.start(), /refreshed/);
    f.computer.maintenance = false;
    f.engine.start();
    await opening;
    assert.equal(f.engine.view().cancellable, false);
    assert.equal((await f.engine.cancel()).phase, 'opening');
    release();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'ready');
  } finally {
    release?.();
    await f.engine.close();
    f.store.close();
  }
});
test('a fresh workspace continues the existing image setup without opening a desktop early', async () => {
  const f = fixture({ enabled: false, environment: { DOCKER_HOST: host } });
  let prepared = 0;
  f.setup.start = () => {
    prepared++;
    f.setup.pending = Promise.resolve().then(() => {
      f.computer.enabled = true;
    });
  };
  try {
    f.engine.start();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'ready');
    assert.equal(prepared, 1);
    assert.equal(f.opened(), 0);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});
test('configured workspaces remain pinned while fresh setup honors explicit context and host', async () => {
  const f = fixture({ environment: { DOCKER_HOST: 'ssh://different' } });
  try {
    assert.deepEqual(await f.setup.engineHosts(new AbortController().signal), [host]);
  } finally {
    await f.engine.close();
    f.store.close();
  }
  for (const environment of [{ DOCKER_HOST: 'ssh://different' }, { DOCKER_CONTEXT: 'remote' }]) {
    const f = fixture({ enabled: false, selected: 'ssh://different', environment });
    try {
      assert.equal((await f.engine.status()).canStart, false);
    } finally {
      await f.engine.close();
      f.store.close();
    }
  }
});
test('runtime endpoints require the owner session and same-origin writes; request bodies cannot select commands', async () => {
  const f = fixture();
  const key = 'computer-engine-owner-test-key';
  const services = {
    computer: f.computer,
    computerSetup: f.setup,
    mode: 'sample',
    browser: { enabled: false },
    terminal: { enabled: false },
    provider: { configured: false },
    google: { configured: false },
  };
  const app = createApp(f.store, services, { host: '127.0.0.1', port: 0, accessKey: key });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/api/computer/engine')).status, 401);
    for (const action of ['start', 'resume', 'continueChat'])
      assert.equal(
        (await fetch(url + '/api/computer/engine/' + action, { method: 'POST' })).status,
        401,
      );
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    assert.equal(
      (
        await fetch(url + '/api/computer/engine/start', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://elsewhere.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + '/api/computer/engine/resume', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://elsewhere.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url + '/api/computer/engine', { headers })).status, 200);
    assert.equal(
      (
        await fetch(url + '/api/computer/engine/continueChat', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://elsewhere.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    assert.equal(
      (
        await fetch(url + '/api/computer/engine/continueChat', {
          method: 'POST',
          headers,
          body: JSON.stringify({ profile: 'malicious', command: 'anything' }),
        })
      ).status,
      200,
    );
    await f.engine.pending;
    assert.equal(f.computer.controller, 'agent');
    assert.equal(
      (
        await fetch(url + '/api/computer/engine/start', {
          method: 'POST',
          headers,
          body: JSON.stringify({ profile: 'malicious', command: 'anything' }),
        })
      ).status,
      200,
    );
    await f.engine.pending;
    assert.equal(f.engine.phase, 'ready');
    assert(!JSON.stringify(f.calls).includes('malicious'));
  } finally {
    await f.engine.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});

test('explicit chat resume wakes and opens once, then hands back only after readiness', async () => {
  const f = fixture();
  f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  const order = [];
  f.computer.start = async () => {
    order.push('open');
    assert.equal(f.computer.controller, 'owner');
    return { state: 'running' };
  };
  f.computer.runtime.resume = async () => {
    order.push('release');
  };
  try {
    const before = f.store.read();
    assert.equal((await f.engine.status()).canStart, true);
    assert.deepEqual(order, []);
    const result = f.engine.resume();
    assert.equal(result.intent, 'resume');
    f.engine.resume();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'ready');
    assert.equal(f.computer.controller, 'agent');
    assert.deepEqual(order, ['open', 'release']);
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.calls.filter((c) => c.args[0] === 'start').length, 1);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});

test('resume never hands back if startup is cancelled, control changes, or the desktop is unhealthy', async () => {
  for (const action of ['cancel', 'takeover', 'stop', 'unhealthy']) {
    const f = fixture();
    let entered,
      finish,
      released = 0;
    const opening = new Promise((r) => {
      entered = r;
    });
    f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    f.computer.runtime.resume = async () => {
      released++;
    };
    f.computer.start = async () => {
      entered();
      await new Promise((r) => {
        finish = r;
      });
      return { state: action === 'unhealthy' ? 'unavailable' : 'running' };
    };
    try {
      f.engine.resume();
      await opening;
      assert.equal(f.engine.view().cancellable, true);
      if (action === 'cancel') {
        const view = await f.engine.cancel();
        assert.equal(view.phase, 'cancelling');
      } else if (action !== 'unhealthy') f.computer.epoch++;
      finish();
      await f.engine.pending;
      assert.equal(released, 0);
      assert.equal(f.computer.controller, 'owner');
      assert.equal(f.engine.phase, action === 'cancel' ? 'cancelled' : 'error');
      assert(!f.calls.some((c) => c.binary === 'colima-test' && c.args[0] === 'stop'));
    } finally {
      finish?.();
      await f.engine.close();
      f.store.close();
    }
  }
});

test('resume cancel during runtime wake stops before opening and restart cannot inherit intent', async () => {
  const f = fixture();
  let entered,
    opened = 0;
  const starting = new Promise((r) => {
    entered = r;
  });
  f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  f.computer.start = async () => {
    opened++;
    return { state: 'running' };
  };
  f.setup.runner = async (binary, args, options) => {
    if (binary !== 'colima-test' || args[0] !== 'start') return f.runner(binary, args, options);
    entered();
    await new Promise((_, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
    );
  };
  try {
    f.engine.resume();
    await starting;
    await f.engine.cancel();
    assert.equal(f.engine.phase, 'cancelled');
    assert.equal(opened, 0);
    assert.equal(f.computer.controller, 'owner');
    const fresh = new ComputerEngine(f.setup, { platform: 'darwin', colima: 'colima-test' });
    assert.equal(fresh.view().intent, 'open');
    assert.equal(fresh.pending, null);
    await fresh.status();
    assert.equal(opened, 0);
    assert.equal(f.computer.controller, 'owner');
    await fresh.close();
  } finally {
    await f.engine.close();
    f.store.close();
  }
});

test('existing plain startup cannot be silently upgraded to resume and stale epochs cannot release', async () => {
  const f = fixture();
  let finish, entered;
  f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  const opening = new Promise((r) => {
    entered = r;
  });
  f.computer.start = async () => {
    entered();
    await new Promise((r) => {
      finish = r;
    });
    return { state: 'running' };
  };
  try {
    f.engine.start();
    await opening;
    assert.throws(() => f.engine.resume(), /already opening/);
    finish();
    await f.engine.pending;
    assert.equal(f.computer.controller, 'owner');
    let releases = 0;
    f.computer.runtime.resume = async () => {
      releases++;
    };
    await assert.rejects(f.computer.release('owner', f.computer.epoch - 1), /control changed/);
    assert.equal(releases, 0);
    f.computer.db.prepare("UPDATE computer_meta SET controller='agent' WHERE id=1").run();
    assert.throws(() => f.engine.resume(), /Take control/);
  } finally {
    finish?.();
    await f.engine.close();
    f.store.close();
  }
});

test('explicit continue chatting hands back a freshly confirmed sleeping VM without any wake or thaw', async () => {
  const f = fixture();
  f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  const before = structuredClone(f.store.read());
  const epoch = f.computer.epoch;
  f.computer.runtime.resume = async () => assert.fail('Must not thaw workloads');
  try {
    assert.equal((await f.engine.status()).canContinueChat, true);
    assert.equal(f.computer.controller, 'owner');
    const probes = f.calls.length;
    const result = f.engine.continueChat();
    assert.equal(result.busy, true);
    await f.engine.pending;
    assert.equal(f.computer.controller, 'agent');
    assert.equal(f.engine.view().busy, false);
    assert(f.calls.length > probes, 'Cached UI status is not the release proof');
    assert.equal(f.computer.epoch, epoch + 1);
    assert.equal(f.opened(), 0);
    assert(!f.calls.some((c) => ['start', 'stop', 'unpause', 'exec'].includes(c.args[0])));
    assert.deepEqual(f.store.read(), before);
  } finally {
    await f.engine.close();
    f.store.close();
  }
});

test('continue chatting rejects unknown, changed, running, remote and disabled engines', async () => {
  for (const options of [
    { rows: '{invalid' },
    { rows: JSON.stringify({ name: 'relay', runtime: 'docker', status: 'Running' }) },
    { rows: JSON.stringify({ name: 'other', runtime: 'docker', status: 'Stopped' }) },
    { selected: 'ssh://remote/engine' },
    { selected: 'unix:///different/docker.sock' },
    { environment: { RELAY_DESKTOP_ENABLED: 'false' } },
    { enabled: false },
  ]) {
    const f = fixture(options);
    f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    try {
      assert.equal((await f.engine.status()).canContinueChat, false);
      if (!f.setup.allowed || !f.computer.enabled) assert.throws(() => f.engine.continueChat());
      else {
        f.engine.continueChat();
        await f.engine.pending;
        assert.equal(f.engine.phase, 'error');
      }
      assert.equal(f.computer.controller, 'owner');
      assert.equal(f.opened(), 0);
    } finally {
      await f.engine.close();
      f.store.close();
    }
  }
  const f = fixture();
  f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  try {
    assert.equal((await f.engine.status()).canContinueChat, true);
    f.running(true);
    f.engine.continueChat();
    await f.engine.pending;
    assert.equal(f.engine.phase, 'error');
    assert.equal(f.computer.controller, 'owner');
  } finally {
    await f.engine.close();
    f.store.close();
  }
});

test('manual local DOCKER_HOST is an explicit selection; a default or named context is not', async () => {
  for (const environment of [
    { DOCKER_HOST: host },
    {},
    { DOCKER_HOST: host, DOCKER_CONTEXT: 'selected' },
  ]) {
    const f = fixture({ environment });
    f.computer.dockerHost = undefined;
    f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    const eligible = !!environment.DOCKER_HOST && !environment.DOCKER_CONTEXT;
    try {
      assert.equal((await f.engine.status()).canContinueChat, eligible);
      f.engine.continueChat();
      await f.engine.pending;
      assert.equal(f.computer.controller, eligible ? 'agent' : 'owner');
      assert.equal(f.opened(), 0);
      assert(!f.calls.some((c) => c.args[0] === 'start'));
    } finally {
      await f.engine.close();
      f.store.close();
    }
  }
});

test('asleep handback rechecks the epoch and lifecycle after inspection; cancellation stays paused', async () => {
  for (const change of ['epoch', 'host', 'maintenance', 'snapshot', 'closing', 'cancel']) {
    const f = fixture();
    let enter, finish;
    const entered = new Promise((r) => {
      enter = r;
    });
    const original = f.engine.inspect.bind(f.engine);
    f.engine.inspect = async (signal) => {
      const target = await original(signal);
      enter();
      await new Promise((r) => {
        finish = r;
      });
      return target;
    };
    f.computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
    f.engine.continueChat();
    const operation = f.engine.pending;
    try {
      await entered;
      assert.equal(f.engine.view().canContinueChat, false);
      assert.equal(f.engine.start().intent, 'chat');
      if (change === 'epoch') f.computer.epoch++;
      if (change === 'host') f.computer.dockerHost = 'unix:///test/.colima/other/docker.sock';
      if (change === 'maintenance') f.computer.maintenance = true;
      if (change === 'snapshot') f.computer.snapshotBlocked = true;
      if (change === 'closing') f.computer.closing = true;
      const cancellation = change === 'cancel' ? f.engine.cancel() : null;
      finish();
      await operation;
      await cancellation;
      assert.equal(f.computer.controller, 'owner');
      assert.equal(f.computer.transitioning, 0);
      assert.equal(f.opened(), 0);
    } finally {
      finish?.();
      await f.engine.close();
      f.store.close();
    }
  }
});
