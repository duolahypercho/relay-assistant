// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ModelProvider } from '../server/model.mjs';
import { boundedToolOutput, executeTool } from '../server/agent.mjs';

test('starting the computer returns the current desktop as vision input without putting image bytes in text', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.start = async () => ({ state: 'running' });
  computer.screenshot = async () => ({
    state: 'running',
    screenshot: 'aGVsbG8=',
    width: 1280,
    height: 800,
  });
  try {
    const result = await executeTool(store, 'computer_start', {}, { computer });
    assert.equal(result.image, 'data:image/jpeg;base64,aGVsbG8=');
    assert.equal(result.result.screenshot, undefined);
    assert.equal(result.result.state, 'running');
    assert.equal(result.card.page, 'computer');
  } finally {
    store.close();
  }
});
test('owner takeover discards a startup screenshot even after desktop startup succeeds', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.start = async () => ({ state: 'running' });
  computer.screenshot = async () => {
    computer.epoch++;
    store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
    return { state: 'running', screenshot: 'aGVsbG8=' };
  };
  try {
    await assert.rejects(executeTool(store, 'computer_start', {}, { computer }), /control|owner/);
  } finally {
    store.close();
  }
});

test('large computer outputs remain valid JSON and retain failure metadata', () => {
  const encoded = boundedToolOutput({
    sourceData: true,
    result: {
      stdout: '"'.repeat(100000),
      exitCode: 124,
      timedOut: true,
      truncated: true,
      operationId: 'saved',
    },
  });
  assert.ok(encoded.length <= 45000);
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.result.exitCode, 124);
  assert.equal(parsed.result.operationId, 'saved');
  assert.equal(parsed.truncated, true);
});

function fixture() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.runtime = {
    name: computer.name + '-commands',
    ensure: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
  };
  computer.inspect = async () => null;
  computer.requireRunning = async () => {};
  computer.status = async () => ({ state: 'running', controller: computer.controller });
  return { store, computer };
}
test('service shutdown preserves an idle desktop, revokes networking and rejects new actions', async () => {
  const { store, computer } = fixture();
  let stops = 0,
    revoked = 0,
    cancelled = 0;
  computer.runtime.stop = async () => {
    stops++;
  };
  computer.network = {
    stop() {
      revoked++;
    },
  };
  computer.cancel = async () => {
    cancelled++;
  };
  try {
    const closing = computer.shutdown();
    assert.equal(computer.shutdown(), closing);
    assert.deepEqual(await closing, { detached: true });
    assert.equal(stops, 0);
    assert.equal(revoked, 1);
    assert.equal(cancelled, 1);
    assert.equal(computer.controller, 'agent');
    await assert.rejects(
      computer.perform({ kind: 'desktop', action: 'click', x: 1, y: 1, operationId: 'late' }),
      /restarting/,
    );
  } finally {
    store.close();
  }
});
test('shutdown preserves owner control and verifies the command freeze without unpausing or stopping apps', async () => {
  const { store, computer } = fixture();
  let paused = 0,
    resumed = 0,
    stopped = 0;
  store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
  computer.runtime.pause = async () => {
    paused++;
  };
  computer.runtime.resume = async () => {
    resumed++;
  };
  computer.runtime.stop = async () => {
    stopped++;
  };
  try {
    await computer.shutdown();
    assert.equal(computer.controller, 'owner');
    assert.equal(paused, 1);
    assert.equal(resumed, 0);
    assert.equal(stopped, 0);
    await computer.stop();
    assert.equal(stopped, 1, 'explicit Stop still closes the command runtime');
  } finally {
    store.close();
  }
});
test('shutdown does not claim a verified owner freeze when the runtime rejects it', async () => {
  const { store, computer } = fixture();
  store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
  computer.runtime.pause = async () => {
    throw Error('freeze unavailable');
  };
  try {
    await assert.rejects(computer.shutdown(), /freeze unavailable/);
    assert.throws(() => computer.assertControl('owner'), /restarting/);
    assert.equal(computer.controller, 'owner');
  } finally {
    store.close();
  }
});
test('computer ownership survives a service restart and blocks queued agent input', async () => {
  const { store, computer } = fixture();
  let finish;
  computer.rpc = async (p) => {
    if (p.kind === 'cancel') {
      finish({ stdout: '', exitCode: -9 });
      return {};
    }
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const current = computer.perform({ kind: 'exec', command: 'sleep 20', operationId: 'first' });
  const currentRejected = assert.rejects(current, /stopped/);
  await new Promise((r) => setTimeout(r, 10));
  const queued = computer.perform({
    kind: 'desktop',
    action: 'click',
    x: 1,
    y: 1,
    operationId: 'second',
  });
  const queuedRejected = assert.rejects(queued, /control changed/);
  await computer.takeControl();
  await currentRejected;
  await queuedRejected;
  assert.equal(computer.controller, 'owner');
  const restarted = new PrivateComputer(store, { enabled: true });
  assert.equal(restarted.controller, 'owner');
  await assert.rejects(
    restarted.perform({ kind: 'exec', command: 'pwd', operationId: 'third' }),
    /owner has taken control/,
  );
  await computer.release();
  assert.equal(computer.controller, 'agent');
  store.close();
});
test('computer operations are idempotent, reject changed retries and do not repeat uncertain work', async () => {
  const { store, computer } = fixture();
  let calls = 0;
  computer.rpc = async () => {
    calls++;
    return { stdout: 'saved', exitCode: 0 };
  };
  const p = { kind: 'exec', command: 'create file', operationId: 'save' };
  await computer.perform(p);
  await computer.perform(p);
  assert.equal(calls, 1);
  await assert.rejects(computer.perform({ ...p, command: 'delete file' }), /different action/);
  computer.rpc = async () => {
    throw new Error('Lost connection');
  };
  await assert.rejects(computer.perform({ ...p, operationId: 'failed' }), /Lost connection/);
  await assert.rejects(computer.perform({ ...p, operationId: 'failed' }), /interrupted/);
  assert.equal(computer.receipts().length, 2);
  store.close();
});
test('document controls require owner takeover, freeze commands and never replay a lost launch', async () => {
  const { store, computer } = fixture();
  let launches = 0,
    pauses = 0;
  computer.runtime.pause = async () => {
    pauses++;
  };
  computer.rpc = async (p, target) => {
    assert.equal(target, computer.name);
    launches++;
    return { launched: true, app: p.app };
  };
  const p = { kind: 'app', action: 'new', app: 'writer', operationId: 'document' };
  try {
    await assert.rejects(computer.perform(p), /owner-only/);
    await assert.rejects(computer.perform(p, { actor: 'owner' }), /Take control/);
    store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
    assert.equal((await computer.perform(p, { actor: 'owner' })).launched, true);
    assert.equal((await computer.perform(p, { actor: 'owner' })).repeated, true);
    assert.equal(launches, 1);
    assert.equal(pauses, 1);
    await assert.rejects(
      computer.perform({ ...p, app: 'calc' }, { actor: 'owner' }),
      /different action/,
    );
    computer.rpc = async () => {
      throw Error('Acknowledgement lost');
    };
    await assert.rejects(
      computer.perform({ ...p, operationId: 'lost' }, { actor: 'owner' }),
      /Acknowledgement lost/,
    );
    await assert.rejects(
      computer.perform({ ...p, operationId: 'lost' }, { actor: 'owner' }),
      /interrupted/,
    );
  } finally {
    store.close();
  }
});
test('computer capabilities follow the current guest boot and hide apps on an older image', async () => {
  const { store, computer } = fixture();
  let apps = [{ id: 'writer', label: 'Document', extensions: ['docx'] }],
    calls = 0;
  computer.rpc = async () => {
    calls++;
    return { ready: true, apps };
  };
  try {
    const boot = { Id: 'one', State: { StartedAt: 'first' } };
    assert.equal(await computer.isReady(boot), true);
    assert.deepEqual(computer.desktopApps, apps);
    await computer.isReady(boot);
    assert.equal(calls, 1);
    apps = undefined;
    await computer.isReady({ Id: 'two', State: { StartedAt: 'second' } });
    assert.deepEqual(computer.desktopApps, []);
  } finally {
    store.close();
  }
});
test('computer command receipts survive SQLite reopen without replaying in-flight work', () => {
  const { store, computer } = fixture();
  computer.db
    .prepare('INSERT INTO computer_operations VALUES (?,?,?,?,?,?,?)')
    .run('op', 'hash', 'one command', 'agent', 'running', null, new Date().toISOString());
  const reopened = new PrivateComputer(store);
  assert.equal(reopened.receipts()[0].status, 'interrupted');
  assert.match(reopened.receipts()[0].result.error, /restarted/);
  store.close();
});
test('disabled computer never executes a host fallback', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const computer = new PrivateComputer(store, {
    runner: async () => {
      calls++;
    },
  });
  await assert.rejects(computer.start(), /not enabled/);
  assert.equal((await computer.status()).state, 'disabled');
  assert.equal(calls, 0);
  store.close();
});
test('computer readiness waits for its desktop and resets after a container restart', async () => {
  const store = new Store(':memory:');
  const computer = new PrivateComputer(store, { enabled: true });
  computer.runtime = {
    name: computer.name + '-commands',
    ensure: async () => {},
    pause: async () => {},
    resume: async () => {},
    stop: async () => {},
  };
  let ready = false;
  let started = 'first-boot';
  computer.inspect = async () => ({ Id: 'guest', State: { Running: true, StartedAt: started } });
  computer.rpc = async () => ({ ready });
  assert.equal((await computer.status()).state, 'starting');
  await assert.rejects(computer.requireRunning(), /still starting/);
  ready = true;
  assert.equal((await computer.status()).state, 'running');
  await computer.requireRunning();
  ready = false;
  started = 'second-boot';
  assert.equal((await computer.status()).state, 'starting');
  store.close();
});
test('a computer image update replaces only a stopped container and preserves its volume', async () => {
  const { store, computer } = fixture();
  const calls = [];
  computer.inspect = async () => ({ Image: 'old-image', State: { Running: true } });
  computer.checked = async (args) => {
    calls.push(args);
    return args[0] === 'image' ? 'new-image' : '';
  };
  await assert.rejects(computer.start(), /Stop the computer/);
  assert.ok(!calls.some((args) => args[0] === 'rm'));
  computer.inspect = async () => ({ Image: 'old-image', State: { Running: false } });
  computer.verifyVolume = async () => {};
  computer.dockerRun = async () => ({ exitCode: 0 });
  computer.rpc = async () => ({ ready: true });
  await computer.start();
  assert.deepEqual(
    calls.find((args) => args[0] === 'rm'),
    ['rm', computer.name],
  );
  assert.ok(
    calls
      .find((args) => args[0] === 'run')
      .includes(`type=volume,source=${computer.volume},target=/workspace`),
  );
  store.close();
});
for (const protocol of ['responses', 'chat'])
  test(`computer screenshots reach the ${protocol} vision model without serializing base64 as text`, async () => {
    let body;
    const provider = new ModelProvider({
      baseUrl: 'http://fixture',
      model: 'vision',
      protocol,
      fetcher: async (_url, opts) => {
        body = JSON.parse(opts.body);
        return new Response(
          JSON.stringify(
            protocol === 'responses'
              ? { output: [] }
              : { choices: [{ message: { content: 'seen' } }] },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const messages = [
      { role: 'user', content: 'Current screen', visual: 'data:image/jpeg;base64,aGVsbG8=' },
    ];
    await provider.complete(messages);
    const parts = (body.input || body.messages)[0].content;
    assert.equal(parts[1].type, protocol === 'responses' ? 'input_image' : 'image_url');
    assert.equal(messages[0].visual, 'data:image/jpeg;base64,aGVsbG8=');
    assert.equal(parts[0].text, 'Current screen');
  });
