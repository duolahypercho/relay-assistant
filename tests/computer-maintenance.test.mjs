// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { ComputerMaintenance } from '../server/computer-maintenance.mjs';
const oldImage = 'relay-desktop:setup-1111111111111111';
const newImage = 'relay-desktop:setup-2222222222222222';
function fixture() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, {
    enabled: true,
    image: oldImage,
    dockerHost: 'unix:///test/docker.sock',
  });
  const setup = new ComputerSetup(computer, { environment: {} });
  store.db
    .prepare('INSERT INTO computer_setup_config VALUES (1,?,?)')
    .run(oldImage, computer.dockerHost);
  let container = { State: { Running: true }, Image: oldImage };
  const calls = [];
  computer.inspect = async () => container;
  computer.checked = async (args) => {
    calls.push(args);
    if (args[0] === 'rm') container = null;
    return '[]';
  };
  computer.runtime.inspect = async () => null;
  computer.runtime.stop = async () => {
    calls.push(['runtime-stop']);
  };
  computer.startUnlocked = async () => {
    calls.push(['start', computer.image]);
    container = { State: { Running: true }, Image: computer.image };
  };
  computer.status = async () => ({
    state: container?.State.Running ? 'running' : 'stopped',
    controller: computer.controller,
  });
  setup.prepare = async () => ({ image: newImage, host: computer.dockerHost });
  const service = new ComputerMaintenance(computer, setup);
  return { store, computer, setup, service, calls };
}
test('update preparation preserves the running computer; only a matching review applies once', async () => {
  const f = fixture();
  try {
    const messages = f.store.read().messages;
    f.service.prepare('update');
    await f.service.pending;
    assert.equal(f.service.status().phase, 'review');
    assert.equal(f.computer.image, oldImage);
    assert.equal(f.computer.controller, 'agent');
    assert.deepEqual(f.calls, []);
    assert.throws(() => f.service.apply('stale'), /Review/);
    const id = f.service.status().review.id;
    f.service.apply(id);
    await f.service.pending;
    assert.equal(f.service.status().phase, 'done');
    assert.equal(f.computer.image, newImage);
    assert.equal(f.computer.controller, 'owner');
    assert.equal(
      f.store.db.prepare('SELECT image FROM computer_setup_config').get().image,
      newImage,
    );
    assert.throws(() => f.service.apply(id), /Review/);
    assert.deepEqual(f.store.read().messages, messages);
    assert.ok(f.calls.some((a) => a[0] === 'rm' && a[1] === f.computer.name));
    assert.ok(!f.calls.some((a) => a.includes('volume')));
  } finally {
    f.store.close();
  }
});
test('Not now discards the prepared review without touching the computer', async () => {
  const f = fixture();
  try {
    f.service.prepare('update');
    await f.service.pending;
    const id = f.service.status().review.id;
    await f.service.cancel();
    assert.throws(() => f.service.apply(id), /Review/);
    assert.equal(f.computer.image, oldImage);
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});
test('same-version check reports current without a restart review', async () => {
  const f = fixture();
  f.setup.prepare = async () => ({ image: oldImage, host: f.computer.dockerHost });
  try {
    f.service.prepare('update');
    await f.service.pending;
    assert.equal(f.service.status().phase, 'current');
    assert.equal(f.service.status().review, null);
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});
test('preparation can be cancelled and shutdown drains an applying restart', async () => {
  const f = fixture();
  try {
    f.setup.prepare = async (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    f.service.prepare('update');
    assert.throws(() => f.service.prepare('recover'), /in progress/);
    await f.service.cancel();
    assert.equal(f.service.status().phase, 'idle');
    assert.equal(f.computer.image, oldImage);
    f.service.prepare('recover');
    await f.service.pending;
    let finish;
    f.computer.startUnlocked = async () =>
      new Promise((r) => {
        finish = r;
      });
    f.service.apply(f.service.status().review.id);
    await new Promise((r) => setImmediate(r));
    await assert.rejects(f.service.cancel(), /finish restarting/);
    const closing = f.service.close();
    finish();
    await closing;
    assert.equal(f.service.status().phase, 'done');
  } finally {
    f.store.close();
  }
});
test('failed update restores the prior durable image and leaves Relay paused', async () => {
  const f = fixture();
  const start = f.computer.startUnlocked;
  f.computer.startUnlocked = async () => {
    if (f.computer.image === newImage) throw new Error('bad desktop');
    await start();
  };
  try {
    f.service.prepare('update');
    await f.service.pending;
    f.service.apply(f.service.status().review.id);
    await f.service.pending;
    assert.equal(f.service.status().phase, 'error');
    assert.match(f.service.status().error, /previous computer software is restored/);
    assert.equal(f.computer.image, oldImage);
    assert.equal(
      f.store.db.prepare('SELECT image FROM computer_setup_config').get().image,
      oldImage,
    );
    assert.equal(f.computer.controller, 'owner');
    assert.ok(f.calls.some((c) => c[0] === 'start' && c[1] === oldImage));
  } finally {
    f.store.close();
  }
});
test('a changed container boundary refuses recovery before removing any container', async () => {
  const f = fixture();
  f.computer.runtime.inspect = async () => {
    throw new Error('isolation changed');
  };
  try {
    f.service.prepare('recover');
    await f.service.pending;
    f.service.apply(f.service.status().review.id);
    await f.service.pending;
    assert.equal(f.service.status().phase, 'error');
    assert.match(f.service.status().error, /isolation changed/);
    assert.ok(!f.calls.some((c) => ['stop', 'rm', 'runtime-stop'].includes(c[0])));
    assert.equal(f.computer.image, oldImage);
  } finally {
    f.store.close();
  }
});
test('maintenance invalidates old observations and blocks start, stop, handback and owner input', async () => {
  const f = fixture();
  let finish;
  f.computer.startUnlocked = async () =>
    new Promise((r) => {
      finish = r;
    });
  try {
    const epoch = f.computer.epoch;
    const rebuilding = f.computer.rebuild(oldImage);
    await new Promise((r) => setImmediate(r));
    assert.ok(f.computer.epoch > epoch);
    assert.throws(() => f.computer.assertControl('owner', epoch), /refreshed/);
    await assert.rejects(f.computer.start('owner'), /refreshed/);
    await assert.rejects(f.computer.stop(), /refreshed/);
    await assert.rejects(f.computer.release(), /refreshed/);
    await assert.rejects(f.computer.takeControl(), /refreshed/);
    finish();
    await rebuilding;
    assert.equal(f.computer.maintenance, false);
  } finally {
    f.store.close();
  }
});
test('manual operator images permit recovery but cannot be silently replaced by managed updates', async () => {
  const f = fixture();
  f.setup.explicit = 'true';
  try {
    assert.equal(f.service.status().canUpdate, false);
    assert.throws(() => f.service.prepare('update'), /server settings/);
    f.service.prepare('recover');
    await f.service.pending;
    f.service.apply(f.service.status().review.id);
    await f.service.pending;
    assert.equal(f.service.status().phase, 'done');
    assert.equal(f.computer.image, oldImage);
  } finally {
    f.store.close();
  }
});
test('a computer reconfigured after review rejects the stale plan', async () => {
  const f = fixture();
  try {
    f.service.prepare('update');
    await f.service.pending;
    f.computer.image = 'operator:changed';
    assert.throws(() => f.service.apply(f.service.status().review.id), /computer changed/);
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});

test('maintenance is owner-authenticated, same-origin and cannot accept an arbitrary image or stale review', async () => {
  const { createApp } = await import('../server/app.mjs');
  const { once } = await import('node:events');
  const f = fixture();
  const key = 'maintenance-owner-key-long-enough';
  const app = createApp(
    f.store,
    {
      mode: 'sample',
      computer: f.computer,
      computerMaintenance: f.service,
      provider: { configured: false },
      google: { configured: false },
      browser: { enabled: false },
      terminal: { enabled: false },
    },
    { host: '127.0.0.1', port: 0, accessKey: key },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + '/api/computer/maintenance')).status, 401);
    assert.equal(
      (await fetch(url + '/api/computer/maintenance/apply', { method: 'POST' })).status,
      401,
    );
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const headers = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      'Content-Type': 'application/json',
    };
    assert.equal(
      (
        await fetch(url + '/api/computer/maintenance/prepare', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://elsewhere.test' },
          body: JSON.stringify({ kind: 'recover' }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + '/api/computer/maintenance/apply', {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: 'fake', image: 'untrusted:latest' }),
        })
      ).status,
      409,
    );
    const review = await fetch(url + '/api/computer/maintenance/prepare', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'recover', image: 'untrusted:latest' }),
    });
    assert.equal(review.status, 200);
    assert.equal(review.headers.get('cache-control'), 'no-store');
    await f.service.pending;
    assert.equal(f.service.review.image, oldImage);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.service.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});
