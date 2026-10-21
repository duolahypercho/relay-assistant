// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSnapshots } from '../server/computer-snapshots.mjs';
function fixture(store = new Store(':memory:', { sample: false })) {
  const computer = new PrivateComputer(store, { enabled: true });
  const volumes = new Set(),
    calls = [];
  let container = null,
    offline = false,
    failStart = false;
  computer.inspect = async () => container;
  computer.checked = async (args) => {
    calls.push(args);
    if (offline) throw Error('Engine unavailable');
    if (args[0] === 'volume') {
      if (args[1] === 'ls')
        return [...volumes].filter((v) => args.includes(`name=^${v}$`)).join('\n');
      if (args[1] === 'inspect') {
        assert(volumes.has(args[2]), 'Missing fixture volume');
        return JSON.stringify([
          {
            Name: args[2],
            Driver: 'local',
            Scope: 'local',
            Labels: { 'org.relay.owner': computer.owner },
          },
        ]);
      }
      if (args[1] === 'create') {
        volumes.add(args.at(-1));
        return args.at(-1);
      }
      if (args[1] === 'rm') {
        volumes.delete(args[2]);
        return '';
      }
    }
    if (args[0] === 'image') return 'image-fixture';
    if (args[0] === 'run') {
      if (failStart) throw Error('Fixture startup failed');
      container = {
        Id: 'fixture-desktop',
        State: { Running: true, StartedAt: 'now' },
        Mounts: [{}, {}],
      };
    }
    if (args[0] === 'rm') container = null;
    if (args[0] === 'stop' && container) container.State.Running = false;
    return '';
  };
  computer.rpc = async () => ({ ready: true, apps: [] });
  computer.runtime.ensure = async () => {};
  computer.runtime.inspect = async () => null;
  computer.runtime.pause = async () => {};
  computer.runtime.stop = async () => {};
  const service = new ComputerSnapshots(computer);
  return {
    store,
    computer,
    service,
    volumes,
    calls,
    clear: () => {
      container = null;
    },
    offline: (v) => {
      offline = v;
    },
    failStart: (v) => {
      failStart = v;
    },
  };
}
async function lose(f) {
  await f.computer.start('owner');
  f.clear();
  f.volumes.delete(f.computer.volume);
  f.calls.length = 0;
}
test('first startup records verified storage; subsequent loss blocks owner and agent startup without creating empty volumes', async () => {
  const f = fixture();
  try {
    assert.equal(f.computer.workspaceInitialized, false);
    assert.equal((await f.computer.status()).state, 'stopped');
    await lose(f);
    assert.equal(f.computer.workspaceInitialized, true);
    const state = await f.computer.status();
    assert.equal(state.state, 'missing');
    assert.equal(state.workspaceMissing, true);
    await assert.rejects(f.computer.start('owner'), /saved computer workspace/);
    await assert.rejects(f.computer.start('agent'), /saved computer workspace/);
    assert(!f.calls.some((c) => c[0] === 'run' || (c[0] === 'volume' && c[1] === 'create')));
    const restarted = new PrivateComputer(f.store, { enabled: true });
    assert.equal(restarted.workspaceInitialized, true);
  } finally {
    f.store.close();
  }
});
test('unreachable engines are not treated as lost files and never trigger volume creation', async () => {
  const f = fixture();
  try {
    await lose(f);
    f.offline(true);
    const state = await f.computer.status();
    assert.equal(state.state, 'unavailable');
    assert.equal(state.workspaceMissing, undefined);
    await assert.rejects(f.computer.start('owner'), /Engine unavailable/);
    await assert.rejects(f.service.prepare('fresh'), /Engine unavailable/);
    assert(!f.calls.some((c) => c[1] === 'create'));
  } finally {
    f.store.close();
  }
});
test('storage disappearing during startup checks is not silently recreated', async () => {
  const f = fixture();
  try {
    await f.computer.start('owner');
    f.clear();
    f.calls.length = 0;
    const checked = f.computer.checked;
    f.computer.checked = async (args) => {
      if (args[0] === 'image') f.volumes.delete(f.computer.volume);
      return checked(args);
    };
    await assert.rejects(f.computer.start('owner'), /saved computer workspace/);
    assert(!f.calls.some((c) => c[0] === 'run' || c[1] === 'create'));
  } finally {
    f.store.close();
  }
});
test('fresh recovery refuses an attached command runtime after a review', async () => {
  const f = fixture();
  try {
    await lose(f);
    const review = await f.service.prepare('fresh');
    f.computer.runtime.inspect = async () => ({ State: { Running: false } });
    f.service.apply(review.review.id);
    await f.service.pending;
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /attached processes/);
    assert(!f.calls.some((c) => c[1] === 'create'));
    await assert.rejects(f.service.prepare('fresh'), /attached processes/);
  } finally {
    f.store.close();
  }
});
test('legacy presence migration uses completed work, while failed setup remains eligible for first startup', async () => {
  for (const completed of [false, true]) {
    const f = fixture();
    try {
      f.store.db.exec('ALTER TABLE computer_workspace DROP COLUMN initialized');
      f.store.db
        .prepare('INSERT INTO computer_operations VALUES (?,?,?,?,?,?,?)')
        .run(
          'legacy',
          'hash',
          'Old work',
          'agent',
          completed ? 'completed' : 'failed',
          '{}',
          new Date().toISOString(),
        );
      const upgraded = new PrivateComputer(f.store, { enabled: true });
      assert.equal(upgraded.workspaceInitialized, completed);
    } finally {
      f.store.close();
    }
  }
});
test('verified pre-existing storage establishes presence and prevents silent remote-engine reassignment', async () => {
  const f = fixture();
  try {
    f.volumes.add(f.computer.volume);
    await f.computer.verifyVolume();
    assert.equal(f.computer.workspaceInitialized, true);
    assert.throws(
      () =>
        new PrivateComputer(f.store, {
          enabled: true,
          deployment: 'other-engine',
          remoteEngine: { environment: {} },
        }),
      /computer history/,
    );
  } finally {
    f.store.close();
  }
});
test('fresh recovery requires review, creates an independent empty volume, preserves chats and records the old location', async () => {
  const f = fixture();
  try {
    await lose(f);
    const previous = f.computer.volume,
      messages = f.store.read().messages;
    const review = await f.service.prepare('fresh');
    assert.equal(review.review.kind, 'fresh');
    assert.equal(f.volumes.size, 1); // only the disposable display socket volume
    assert.throws(() => f.service.apply('wrong-token'), /Review/);
    f.service.apply(review.review.id);
    await f.service.pending;
    assert.equal(f.service.phase, 'done', f.service.error);
    assert.notEqual(f.computer.volume, previous);
    assert.equal(f.computer.controller, 'owner');
    assert.equal((await f.computer.status()).state, 'running');
    assert.equal(f.volumes.has(previous), false);
    assert.equal(f.volumes.has(f.computer.volume), true);
    assert.deepEqual(f.store.read().messages, messages);
    assert.deepEqual(f.service.points(), []);
    assert.equal(
      f.store.db
        .prepare('SELECT previous FROM computer_workspace_losses WHERE replacement=?')
        .get(f.computer.volume).previous,
      previous,
    );
    assert.equal(f.service.storedOperation(), null);
    assert.throws(() => f.service.apply(review.review.id), /Review/);
  } finally {
    f.store.close();
  }
});
test('cancelled reviews and reappearing saved storage never create a replacement', async () => {
  const f = fixture();
  try {
    await lose(f);
    const previous = f.computer.volume;
    const first = await f.service.prepare('fresh');
    f.service.cancel();
    assert.throws(() => f.service.apply(first.review.id), /Review/);
    const second = await f.service.prepare('fresh');
    f.volumes.add(previous);
    f.service.apply(second.review.id);
    await f.service.pending;
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /available/);
    assert.equal(f.computer.volume, previous);
    assert(!f.calls.some((c) => c[1] === 'create'));
    await assert.rejects(f.service.prepare('fresh'), /available/);
  } finally {
    f.store.close();
  }
});
test('failed fresh startup returns the old missing reference and cleans only the unused new volume', async () => {
  const f = fixture();
  try {
    await lose(f);
    const previous = f.computer.volume;
    f.failStart(true);
    const review = await f.service.prepare('fresh');
    f.service.apply(review.review.id);
    await f.service.pending;
    assert.equal(f.service.phase, 'error');
    assert.match(f.service.error, /new computer could not start/);
    assert.equal(f.computer.volume, previous);
    assert.equal(f.volumes.size, 1);
    assert.equal(
      f.store.db.prepare('SELECT count(*) AS n FROM computer_workspace_losses').get().n,
      0,
    );
    assert.equal(f.service.storedOperation(), null);
    assert.equal(f.computer.controller, 'owner');
  } finally {
    f.store.close();
  }
});
test('interrupted fresh recovery keeps a committed active volume and finishes its recovery record', async () => {
  const f = fixture();
  try {
    await lose(f);
    const previous = f.computer.volume,
      target = `${f.computer.name}-restore-${'b'.repeat(32)}`;
    f.volumes.add(target);
    f.service.switchVolume(target, null);
    f.service.journal({ ...f.service.operation('fresh', previous, target), created: true });
    const restarted = new ComputerSnapshots(f.computer);
    assert.equal(f.computer.snapshotBlocked, true);
    await restarted.reconcile();
    assert.equal(f.computer.snapshotBlocked, false);
    assert.equal(f.computer.volume, target);
    assert(f.volumes.has(target));
    assert.equal(
      f.store.db
        .prepare('SELECT previous FROM computer_workspace_losses WHERE replacement=?')
        .get(target).previous,
      previous,
    );
    assert.equal(restarted.storedOperation(), null);
  } finally {
    f.store.close();
  }
});
