// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSnapshots } from '../server/computer-snapshots.mjs';
function fixture() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  const calls = [],
    volumes = new Map([[computer.volume, 'before']]);
  let container = { Id: 'original', State: { Running: true, Paused: false } };
  computer.inspect = async () => container;
  computer.verifyVolume = async (name) => {
    if (!volumes.has(name || computer.volume)) throw new Error('wrong volume');
  };
  computer.checked = async (args) => {
    calls.push(args);
    if (args[0] === 'pause') container.State.Paused = true;
    if (args[0] === 'unpause') container.State.Paused = false;
    if (args[0] === 'stop') container.State.Running = false;
    if (args[0] === 'rm') container = null;
    if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args[2]);
    return '';
  };
  computer.runtime.inspect = async () => null;
  computer.runtime.pause = async () => calls.push(['runtime-pause']);
  computer.runtime.stop = async () => calls.push(['runtime-stop']);
  computer.startUnlocked = async () => {
    container = { Id: 'replacement', State: { Running: true, Paused: false } };
    calls.push(['start', computer.volume]);
  };
  const service = new ComputerSnapshots(computer);
  service.copy = async (op) => {
    op.created = true;
    service.journal(op);
    volumes.set(op.target, volumes.get(op.source));
    return { bytes: 6, files: 1 };
  };
  service.cleanHelper = async () => {};
  service.volumeExists = async (volume) => volumes.has(volume);
  return { store, computer, service, volumes, calls, close: () => store.close() };
}
async function save(f) {
  f.service.save();
  await f.service.pending;
  assert.equal(f.service.phase, 'done', f.service.error);
  return f.service.points()[0];
}
async function restore(f, point) {
  f.service.prepare('restore', point.id);
  const token = f.service.review.id;
  f.service.apply(token);
  await f.service.pending;
  return token;
}
test('save freezes writers, keeps desktop processes, persists only point metadata and leaves owner in control', async () => {
  const f = fixture();
  try {
    const messages = f.store.read().messages,
      point = await save(f);
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ['runtime-pause', 'pause', 'unpause'],
    );
    assert.equal(f.computer.controller, 'owner');
    assert.equal((await f.computer.inspect()).Id, 'original');
    assert.equal(f.service.points()[0].id, point.id);
    assert.equal(f.service.storedOperation(), null);
    assert.deepEqual(f.store.read().messages, messages);
    assert.ok(!JSON.stringify(f.service.status()).includes(f.computer.volume));
  } finally {
    f.close();
  }
});
test('review cancel, unknown points and stale/replayed tokens never change current files', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      before = f.computer.volume;
    assert.throws(() => f.service.prepare('restore', 'unknown'), /no longer/);
    f.service.prepare('restore', point.id);
    const stale = f.service.review.id;
    f.service.cancel();
    assert.throws(() => f.service.apply(stale), /Review/);
    assert.equal(f.computer.volume, before);
    const token = await restore(f, point);
    assert.equal(f.service.phase, 'done', f.service.error);
    assert.throws(() => f.service.apply(token), /Review/);
  } finally {
    f.close();
  }
});

test('restore-point copying never begins when local tool writers could not be stopped', async () => {
  const f = fixture();
  let copied = false;
  f.service.copy = async () => {
    copied = true;
    return { bytes: 0, files: 0 };
  };
  f.computer.stdio.stopAll = async () => {
    throw Error('Local tool still running');
  };
  try {
    f.service.save();
    await f.service.pending;
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /Local tool still running/);
    assert.equal(copied, false);
    assert.equal(f.service.points().length, 0);
  } finally {
    f.close();
  }
});
test('restore switches a cloned volume atomically, saves the previous workspace and reloads its durable identity', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      original = f.computer.volume;
    f.volumes.set(original, 'after');
    await restore(f, point);
    assert.equal(f.service.phase, 'done', f.service.error);
    assert.notEqual(f.computer.volume, original);
    assert.equal(f.volumes.get(f.computer.volume), 'before');
    const previous = f.store.db
      .prepare("SELECT * FROM computer_snapshots WHERE label='Before restore'")
      .get();
    assert.equal(previous.volume, original);
    assert.equal(f.volumes.get(previous.volume), 'after');
    const restarted = new PrivateComputer(f.store, { enabled: true });
    assert.equal(restarted.volume, f.computer.volume);
    await restore(f, previous);
    assert.equal(f.volumes.get(f.computer.volume), 'after');
  } finally {
    f.close();
  }
});
test('failed replacement startup restores the original files and durable volume pointer', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      original = f.computer.volume,
      start = f.computer.startUnlocked;
    f.volumes.set(original, 'new changes');
    f.computer.startUnlocked = async () => {
      if (f.computer.volume !== original) throw new Error('startup failed');
      await start();
    };
    await restore(f, point);
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /previous workspace is back/);
    assert.equal(f.computer.volume, original);
    assert.equal(f.volumes.get(original), 'new changes');
    assert.equal(f.service.points().length, 1);
    assert.equal(f.service.storedOperation(), null);
    assert.equal(f.computer.controller, 'owner');
  } finally {
    f.close();
  }
});
test('unexpected boundaries fail before stopping or replacing anything', async () => {
  const f = fixture();
  try {
    const point = await save(f);
    f.calls.length = 0;
    f.computer.runtime.inspect = async () => {
      throw new Error('isolation changed');
    };
    await restore(f, point);
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /isolation/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.service.points().length, 1);
  } finally {
    f.close();
  }
});
test('capture blocks concurrent owner/agent actions and shutdown drains it', async () => {
  const f = fixture();
  let release;
  try {
    const copy = f.service.copy;
    f.service.copy = async (op) => {
      await new Promise((r) => {
        release = r;
      });
      return copy(op);
    };
    f.service.save();
    await new Promise((r) => setImmediate(r));
    assert.throws(() => f.service.save(), /refreshed/);
    await assert.rejects(f.computer.release(), /refreshed/);
    assert.throws(() => f.computer.assertControl('agent'), /refreshed/);
    await assert.rejects(f.computer.stop(), /refreshed/);
    let closed = false;
    const closing = f.service.close().then(() => (closed = true));
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(f.service.phase, 'done');
    assert.equal(f.computer.maintenance, false);
  } finally {
    f.close();
  }
});
test('interrupted capture cleanup thaws only its original desktop and retains already saved points', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      row = f.store.db.prepare('SELECT * FROM computer_snapshots WHERE id=?').get(point.id);
    (await f.computer.inspect()).State.Paused = true;
    f.service.journal({
      kind: 'save',
      source: f.computer.volume,
      target: row.volume,
      created: true,
      paused: true,
      desktop: 'original',
    });
    await f.service.reconcile();
    assert.equal((await f.computer.inspect()).State.Paused, false);
    assert.equal(f.service.points().length, 1);
    assert.equal(f.service.storedOperation(), null);
    assert.equal(f.computer.snapshotBlocked, false);
  } finally {
    f.close();
  }
});
test('failed interrupted-operation cleanup blocks the computer until explicit retry succeeds', async () => {
  const f = fixture();
  try {
    const target = f.computer.name + '-snapshot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    f.volumes.set(target, 'partial');
    f.service.journal({
      kind: 'save',
      source: f.computer.volume,
      target,
      created: true,
      paused: true,
      desktop: 'other',
    });
    await f.service.reconcile();
    assert.equal(f.computer.snapshotBlocked, true);
    assert.equal(f.service.status().canRetry, true);
    await assert.rejects(f.computer.release(), /interrupted/);
    assert.ok(f.service.storedOperation());
    f.service.journal({ ...f.service.storedOperation(), desktop: 'original' });
    await f.service.reconcile();
    assert.equal(f.computer.snapshotBlocked, false);
    assert.ok(!f.volumes.has(target));
  } finally {
    f.close();
  }
});
test('interrupted restore retains the committed current volume and automatic before-restore point', async () => {
  const f = fixture();
  try {
    const point = await save(f);
    await restore(f, point);
    const active = f.computer.volume,
      count = f.service.points().length;
    f.service.journal({ kind: 'restore', source: 'saved', target: active, created: true });
    await f.service.reconcile();
    assert.equal(f.computer.volume, active);
    assert.ok(f.volumes.has(active));
    assert.equal(f.service.points().length, count);
  } finally {
    f.close();
  }
});
test('removal requires review and cannot remove the current workspace or change its controller', async () => {
  const f = fixture();
  try {
    const point = await save(f);
    f.store.db.prepare("UPDATE computer_meta SET controller='agent'").run();
    f.service.prepare('remove', point.id);
    f.service.apply(f.service.review.id);
    await f.service.pending;
    assert.equal(f.service.phase, 'done');
    assert.equal(f.service.points().length, 0);
    assert.equal(f.computer.controller, 'agent');
    await assert.rejects(f.service.removeVolume(f.computer.volume), /current workspace/);
  } finally {
    f.close();
  }
});
test('snapshot routes require owner auth and same origin and accept only opaque reviewed point identities', async () => {
  const { createApp } = await import('../server/app.mjs');
  const { once } = await import('node:events');
  const f = fixture(),
    key = 'snapshot-owner-key-long-enough';
  let server;
  try {
    const app = createApp(
      f.store,
      { computer: f.computer, computerSnapshots: f.service },
      { host: '127.0.0.1', port: 0, accessKey: key },
    );
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url + '/api/computer/snapshots')).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ key }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join(';');
    const post = (body, origin = url) =>
      fetch(url + '/api/computer/snapshots/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post({ kind: 'restore', pointId: 'evil' }, 'https://elsewhere.example')).status,
      403,
    );
    assert.equal((await post({ kind: 'restore', pointId: '/workspace' })).status, 404);
    assert.equal((await post({ kind: 'execute', pointId: 'x' })).status, 400);
    const point = await save(f);
    assert.equal((await post({ kind: 'restore', pointId: point.id })).status, 200);
    assert.equal(f.computer.volume, f.computer.name + '-files');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    f.close();
  }
});

test('a freshly configured computer explains how to create its first workspace', async () => {
  const f = fixture();
  try {
    f.volumes.clear();
    f.service.save();
    await f.service.pending;
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /Start the computer once/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.service.storedOperation(), null);
  } finally {
    f.close();
  }
});

test('a missing original workspace can recover from a point without inventing a Before restore copy', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      original = f.computer.volume;
    f.volumes.delete(original);
    f.computer.inspect = async () => null;
    await restore(f, point);
    assert.equal(f.service.phase, 'done', f.service.error);
    assert.equal(f.volumes.get(f.computer.volume), 'before');
    assert.equal(f.service.points().length, 1);
    assert.notEqual(f.computer.volume, original);
  } finally {
    f.close();
  }
});
test('failed startup after volume loss keeps the imported point and does not claim a restored old workspace', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      original = f.computer.volume;
    f.volumes.delete(original);
    f.computer.inspect = async () => null;
    f.computer.startUnlocked = async () => {
      throw Error('cannot boot');
    };
    await restore(f, point);
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /backup is kept/);
    assert.equal(f.computer.volume, original);
    assert.equal(f.volumes.has(original), false);
    assert.equal(f.service.points().length, 1);
    assert.equal(f.service.storedOperation(), null);
    assert.equal(f.volumes.size, 1);
  } finally {
    f.close();
  }
});
test('missing workspace with a surviving attached desktop refuses recovery', async () => {
  const f = fixture();
  try {
    const point = await save(f),
      original = f.computer.volume;
    f.volumes.delete(original);
    await restore(f, point);
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /attached processes/);
    assert.equal(f.computer.volume, original);
    assert.equal(f.service.points().length, 1);
  } finally {
    f.close();
  }
});

test('interrupted backup cleanup verifies helper isolation and exact volume before removal', async () => {
  const f = fixture();
  try {
    const op = f.service.operation('backup-import', undefined, 'owned-test-destination');
    const c = {
      Name: '/' + op.helper,
      Config: {
        User: '1000:1000',
        Labels: { 'org.relay.owner': f.computer.owner, 'org.relay.role': 'snapshot-backup' },
      },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
      Mounts: [{ Type: 'volume', Name: op.target, Destination: '/workspace', RW: true }],
    };
    let inspect = c,
      removed = 0;
    f.computer.checked = async (args) => {
      if (args[0] === 'container') return op.helper;
      if (args[0] === 'inspect') return JSON.stringify([inspect]);
      if (args[0] === 'rm') removed++;
      return '';
    };
    const clean = () => ComputerSnapshots.prototype.cleanHelper.call(f.service, op);
    for (const modify of [
      (v) => (v.HostConfig.NetworkMode = 'host'),
      (v) => (v.HostConfig.Privileged = true),
      (v) => (v.HostConfig.Binds = ['/host:/workspace']),
      (v) => (v.HostConfig.CapDrop = []),
      (v) => (v.Config.Labels['org.relay.owner'] = 'someone-else'),
      (v) => (v.Mounts[0].Name = f.computer.volume),
    ]) {
      inspect = structuredClone(c);
      modify(inspect);
      await assert.rejects(clean(), /helper changed/);
      assert.equal(removed, 0);
    }
    inspect = c;
    await clean();
    assert.equal(removed, 1);
  } finally {
    f.close();
  }
});
