// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerRuntime } from '../server/computer-runtime.mjs';

function setup() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.inspect = async () => ({ State: { Running: true }, Id: 'desktop' });
  computer.requireRunning = async () => {};
  computer.runtime.ensure = async () => {};
  computer.runtime.pause = async () => {};
  computer.runtime.resume = async () => {};
  computer.runtime.stop = async () => {};
  return { store, computer };
}

test('agent commands enter the separate runtime while owner input stays on the available desktop', async () => {
  const { store, computer } = setup();
  const targets = [];
  computer.rpc = async (p, target) => {
    targets.push([p.kind, target]);
    return {};
  };
  try {
    await computer.perform({ kind: 'exec', command: 'printf agent', operationId: 'agent' });
    await computer.takeControl();
    await computer.perform(
      { kind: 'exec', command: 'printf owner', operationId: 'owner' },
      { actor: 'owner' },
    );
    await computer.perform(
      { kind: 'desktop', action: 'key', key: 'Return', operationId: 'key' },
      { actor: 'owner' },
    );
    assert.deepEqual(targets, [
      ['exec', computer.runtime.name],
      ['exec', computer.name],
      ['desktop', computer.name],
    ]);
  } finally {
    store.close();
  }
});

test('a failed kernel pause keeps the assistant paused and prevents owner actions', async () => {
  const { store, computer } = setup();
  let calls = 0;
  computer.runtime.pause = async () => {
    throw new Error('Kernel freeze failed');
  };
  computer.rpc = async () => {
    calls++;
    return {};
  };
  try {
    await assert.rejects(computer.takeControl(), /Kernel freeze failed/);
    assert.equal(computer.controller, 'owner');
    await assert.rejects(
      computer.perform(
        { kind: 'desktop', action: 'click', operationId: 'owner' },
        { actor: 'owner' },
      ),
      /Kernel freeze failed/,
    );
    await assert.rejects(
      computer.perform({ kind: 'exec', command: 'pwd', operationId: 'agent' }),
      /owner has taken control/,
    );
    const state = await computer.status();
    assert.equal(state.state, 'unavailable');
    assert.match(state.error, /Kernel freeze failed/);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('failed local tool cleanup blocks owner input until status reconciliation succeeds', async () => {
  const { store, computer } = setup();
  let pending = true;
  let cleanupFails = true;
  let calls = 0;
  computer.stdioService = {
    active: new Map(),
    rows: () => (pending ? [{ name: 'unfinished-local-tool' }] : []),
    stopAll: async () => {
      if (cleanupFails) throw new Error('Local tool cleanup failed');
      pending = false;
    },
  };
  computer.isReady = async () => true;
  computer.rpc = async () => {
    calls++;
    return {};
  };
  const input = () =>
    computer.perform(
      { kind: 'desktop', action: 'key', key: 'Return', operationId: 'owner-after-cleanup' },
      { actor: 'owner' },
    );
  try {
    await assert.rejects(computer.takeControl(), /Local tool cleanup failed/);
    await assert.rejects(input(), /Local app tools are still stopping/);
    const failed = await computer.status();
    assert.equal(failed.state, 'unavailable');
    assert.match(failed.error, /Local tool cleanup failed/);
    assert.equal(calls, 0);
    cleanupFails = false;
    assert.equal((await computer.status()).state, 'running');
    await input();
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('taking control during handback wins and re-freezes before any agent work resumes', async () => {
  const { store, computer } = setup();
  let finishResume, didResume;
  const resumed = new Promise((r) => {
    didResume = r;
  });
  let freezes = 0;
  computer.runtime.pause = async () => {
    freezes++;
  };
  computer.runtime.resume = () =>
    new Promise((resolve) => {
      finishResume = resolve;
      didResume();
    });
  try {
    await computer.takeControl();
    const release = computer.release();
    await resumed;
    const take = computer.takeControl();
    assert.equal((await computer.status()).state, 'switching');
    finishResume();
    await Promise.all([release, take]);
    assert.equal(computer.controller, 'owner');
    assert.equal(computer.transitioning, 0);
    assert.equal(freezes, 3);
  } finally {
    store.close();
  }
});

test('handback is not acknowledged when the runtime cannot resume', async () => {
  const { store, computer } = setup();
  try {
    await computer.takeControl();
    computer.runtime.resume = async () => {
      throw new Error('Runtime unavailable');
    };
    await assert.rejects(computer.release(), /Runtime unavailable/);
    assert.equal(computer.controller, 'owner');
    assert.equal(computer.transitioning, 0);
  } finally {
    store.close();
  }
});

test('a legacy running computer requires a file-preserving restart before takeover', async () => {
  const { store, computer } = setup();
  computer.inspect = async () => ({
    State: { Running: true },
    Mounts: [{ Destination: '/workspace' }],
  });
  computer.requireRunning = PrivateComputer.prototype.requireRunning.bind(computer);
  let input = 0;
  computer.rpc = async () => {
    input++;
    return {};
  };
  try {
    const state = await computer.status();
    assert.equal(state.needsUpdate, true);
    assert.equal(state.state, 'unavailable');
    await assert.rejects(computer.takeControl(), /Stop and start/);
    await assert.rejects(
      computer.perform(
        { kind: 'desktop', action: 'type', text: 'private', operationId: 'old-guest' },
        { actor: 'owner' },
      ),
      /Stop and start/,
    );
    assert.equal(input, 0);
  } finally {
    store.close();
  }
});

test('failed shutdown signalling leaves frozen work intact instead of thawing it for removal', async () => {
  const calls = [];
  const runtime = new ComputerRuntime({
    name: 'private-test',
    checked: async (args) => {
      calls.push(args);
      if (args[0] === 'run') throw new Error('Shutdown helper unavailable');
    },
  });
  await assert.rejects(
    runtime.remove({
      Id: 'a'.repeat(64),
      Image: 'sha256:' + 'b'.repeat(64),
      State: { Running: true, Paused: true },
    }),
    /Shutdown helper unavailable/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--pid') + 1], `container:${'a'.repeat(64)}`);
  assert.equal(calls[0][calls[0].indexOf('--user') + 1], '1000:1000');
  assert.equal(calls[0].includes('--mount'), false);
  assert.equal(calls[0].includes('--privileged'), false);
});

test('a delayed status poll cannot freeze command execution after successful handback', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  let finishInspect, inspecting, finishResume, resuming;
  const inspected = new Promise((resolve) => {
    inspecting = resolve;
  });
  const resumed = new Promise((resolve) => {
    resuming = resolve;
  });
  let paused = true;
  computer.db.prepare("UPDATE computer_meta SET controller='owner' WHERE id=1").run();
  computer.inspect = async () => {
    inspecting();
    await new Promise((resolve) => {
      finishInspect = resolve;
    });
    return { Id: 'desktop', State: { Running: true }, Mounts: [{}, {}] };
  };
  computer.isReady = async () => true;
  computer.runtime.setPaused = async (value) => {
    if (!value) {
      resuming();
      await new Promise((resolve) => {
        finishResume = resolve;
      });
    }
    paused = value;
  };
  try {
    const status = computer.status();
    await inspected;
    const handback = computer.release();
    await resumed;
    finishInspect();
    // Let the already-started status request enqueue behind the in-flight resume.
    await new Promise((resolve) => setImmediate(resolve));
    finishResume();
    await Promise.all([status, handback]);
    assert.equal(computer.controller, 'agent');
    assert.equal(paused, false);
  } finally {
    store.close();
  }
});
