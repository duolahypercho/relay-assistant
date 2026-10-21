// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerNetwork, website } from '../server/computer-network.mjs';
import { command } from '../shared/domain.mjs';
import { agentReply, executeTool } from '../server/agent.mjs';

const resolver = async (value) => ({ url: new URL(value), address: '93.184.215.14' });
test('owner takeover blocks model screen/file reads and discards an in-flight screenshot', async () => {
  const { store, computer } = fixture();
  let deliver;
  computer.screenshot = () =>
    new Promise((resolve) => {
      deliver = resolve;
    });
  const pending = executeTool(store, 'computer_look', {}, { computer });
  const rejected = assert.rejects(pending, /control changed/);
  await computer.takeControl();
  deliver({ screenshot: 'private pixels', width: 1280, height: 800 });
  await rejected;
  computer.status = async () => ({
    state: 'running',
    active: 'private command',
    web: { sites: [{ url: 'private-url' }] },
  });
  computer.receipts = () => [{ result: { stdout: 'private output' } }];
  const status = await executeTool(store, 'computer_status', {}, { computer });
  assert.equal(status.result.controller, 'owner');
  assert.equal(status.result.receipts, undefined);
  assert.equal(status.result.active, undefined);
  assert.equal(status.result.web, undefined);
  for (const [name, p] of [
    ['computer_look', {}],
    ['computer_files', { action: 'read', path: 'secret' }],
    ['computer_export', { path: 'secret' }],
  ])
    await assert.rejects(executeTool(store, name, p, { computer }), /owner has taken control/);
  store.close();
});
test('taking control during an export prevents private bytes entering the file library', async () => {
  const { store, computer } = fixture();
  let deliver;
  computer.read = () =>
    new Promise((resolve) => {
      deliver = resolve;
    });
  const before = store.read().files.length;
  const pending = executeTool(store, 'computer_export', { path: 'private.txt' }, { computer });
  const rejected = assert.rejects(pending, /control changed/);
  await computer.takeControl();
  deliver({ name: 'private.txt', base64: Buffer.from('private contents').toString('base64') });
  await rejected;
  assert.equal(store.read().files.length, before);
  store.close();
});
function fixture() {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, {
    enabled: true,
    web: true,
    networkOptions: { resolver },
  });
  computer.inspect = async () => null;
  computer.runtime.pause = async () => {};
  return { store, computer, network: computer.network };
}
test('website decision revisions advance across revoke, expiry and service recovery', async () => {
  const { store, computer, network } = fixture();
  let now = 1000;
  network.now = () => now;
  try {
    await network.request('https://example.com');
    const pending = network.status();
    const allowed = await network.decide('example.com', 'allow');
    assert.ok(allowed.revision > pending.revision);
    const revoked = await network.decide('example.com', 'revoke');
    assert.ok(revoked.revision > allowed.revision);
    assert.equal(revoked.sites[0].status, 'revoked');
    assert.equal(network.status().revision, revoked.revision);
    const again = await network.decide('example.com', 'allow');
    now += 3600001;
    const expired = network.status();
    assert.ok(expired.revision > again.revision);
    assert.equal(expired.sites[0].status, 'expired');
    const renewed = await network.decide('example.com', 'allow');
    const restarted = new ComputerNetwork(computer, { resolver, now: () => now });
    assert.ok(restarted.status().revision > renewed.revision);
    assert.equal(restarted.status().sites[0].status, 'expired');
  } finally {
    store.close();
  }
});
test('website targets reject credentials, nonweb protocols, custom ports and malformed hosts', () => {
  for (const url of [
    'file:///etc/passwd',
    'https://user:secret@example.com',
    'https://example.com:3000',
    'https://[::1]/',
    'https://a..com/',
  ])
    assert.throws(() => website(url));
  assert.deepEqual(website('https://EXAMPLE.com./path#fragment'), {
    host: 'example.com',
    url: 'https://example.com/path',
  });
});
test('website grants are owner decisions, exact-host and expiring; denied sites do not re-prompt from traffic', async () => {
  const { store, network } = fixture();
  let now = 0;
  network.now = () => now;
  await assert.rejects(network.decide('example.com', 'allow'), /Request this website/);
  await network.request('https://example.com/');
  assert.equal(network.allowed('example.com'), false);
  await network.decide('example.com', 'allow');
  assert.equal(network.allowed('example.com'), true);
  assert.equal(network.allowed('sub.example.com'), false);
  now = 3600001;
  network.expire();
  assert.equal(network.allowed('example.com'), false);
  await network.decide('example.com', 'deny');
  await network.request('https://example.com/');
  assert.equal(network.sites()[0].status, 'denied');
  store.close();
});
test('private DNS is rechecked before every broker connection and never passed to the socket', async () => {
  const { store, network } = fixture();
  const frames = [];
  network.send = (x) => frames.push(x);
  await network.request('https://example.com/');
  await network.decide('example.com', 'allow');
  network.resolve = async () => {
    throw new Error('Private network destination');
  };
  let called = false;
  network.connect = () => {
    called = true;
  };
  await network.frame({ type: 'open', id: 'a'.repeat(32), host: 'example.com', port: 443 });
  assert.equal(called, false);
  assert.equal(frames.at(-1).type, 'denied');
  store.close();
});
test('background traffic cannot create approval cards or crowd out deliberate requests', async () => {
  const { store, computer, network } = fixture();
  const frames = [];
  let dnsQueries = 0;
  network.resolve = async (value) => {
    dnsQueries++;
    return resolver(value);
  };
  network.send = (frame) => frames.push(frame);
  network.connect = () => {
    throw new Error('Unapproved traffic must never connect');
  };
  await network.frame({
    type: 'open',
    id: 'c'.repeat(32),
    host: 'background.example.com',
    port: 443,
  });
  assert.equal(frames.at(-1).type, 'denied');
  assert.equal(dnsQueries, 0);
  assert.deepEqual(network.sites(), []);
  await network.request('https://deliberate.example.com', 'An actual task');
  store.db
    .prepare("INSERT INTO computer_websites VALUES (?,?,'pending',0,0,?)")
    .run(
      'background.example.com',
      'https://background.example.com/',
      'Requested by the computer’s browser or an app.',
    );
  const restarted = new ComputerNetwork(computer, { resolver });
  assert.deepEqual(
    restarted.sites().map((s) => s.host),
    ['deliberate.example.com'],
  );
  store.close();
});
test('revoking and expiring access close existing sockets; oversized data cannot grow buffers', async () => {
  const { store, network } = fixture();
  network.send = () => {};
  await network.request('https://example.com/');
  await network.decide('example.com', 'allow');
  let socket;
  network.connect = () => {
    socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => {
      socket.destroyed = true;
    };
    socket.setTimeout = () => {};
    socket.write = () => {};
    socket.writableLength = 0;
    return socket;
  };
  const id = 'b'.repeat(32);
  await network.frame({ type: 'open', id, host: 'example.com', port: 443 });
  await network.decide('example.com', 'revoke');
  assert.equal(socket.destroyed, true);
  assert.equal(network.sockets.size, 0);
  await network.decide('example.com', 'allow');
  await network.frame({ type: 'open', id, host: 'example.com', port: 443 });
  await network.frame({ type: 'data', id, data: 'A'.repeat(70000) });
  assert.equal(socket.destroyed, true);
  store.close();
});
test('server restart expires grants and guest requests are bounded without granting access', async () => {
  const { store, computer, network } = fixture();
  await network.request('https://example.com/');
  await network.decide('example.com', 'allow');
  const next = new ComputerNetwork(computer, { resolver });
  assert.equal(next.allowed('example.com'), false);
  for (let i = 0; i < 20; i++) await next.request(`https://site${i}.example/`);
  await assert.rejects(next.request('https://extra.example/'), /Review the pending/);
  store.close();
});
test('Allow and continue queues the frozen request once without adding messages or changing the draft', async () => {
  const { store, computer, network } = fixture();
  const original = store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Read this website and summarize it.' }),
  );
  store.mutate((s) => {
    s.threads[0].draft = 'Keep my draft';
    s.runs.find((r) => r.id === original.id).status = 'completed';
  });
  await network.request('https://example.com/article');
  network.waitForOwner(original.id, 'example.com', 'https://example.com/article');
  const before = store.read().messages.length;
  const result = await computer.decideWebsite('example.com', 'allow', original.id);
  const repeated = await computer.decideWebsite('example.com', 'allow', original.id);
  assert.equal(result.resumed, repeated.resumed);
  assert.equal(repeated.repeated, true);
  const s = store.read();
  assert.equal(s.messages.length, before);
  assert.equal(s.threads[0].draft, 'Keep my draft');
  const continued = s.runs.find((r) => r.id === result.resumed);
  assert.equal(continued.questionContext.origin.request, 'Read this website and summarize it.');
  assert.equal(continued.websiteContext.url, 'https://example.com/article');
  assert.equal(continued.status, 'queued');
  await assert.rejects(
    computer.decideWebsite('example.com', 'allow', 'invented'),
    /no saved conversation/,
  );
  store.close();
});
test('the model stops at website permission and has no tool to approve its own request', async () => {
  const { store, computer } = fixture();
  const run = store.mutate((s) =>
    command(s, 'chat.send', { threadId: 'main', text: 'Open example.com.' }),
  );
  let calls = 0;
  const provider = {
    complete: async (messages, tools) => {
      calls++;
      assert.ok(!tools.some((t) => /approve|decide_website/.test(t.name)));
      return {
        text: '',
        toolCalls: [
          {
            id: 'one',
            function: {
              name: 'computer_open_website',
              arguments: JSON.stringify({
                url: 'https://example.com',
                reason: 'Read the requested page',
                operationId: 'one',
              }),
            },
          },
        ],
      };
    },
  };
  const result = await agentReply(
    store,
    provider,
    run,
    { computer },
    { signal: new AbortController().signal },
  );
  assert.equal(calls, 1);
  assert.equal(result.cards[0].kind, 'computer-access');
  assert.equal(result.cards[0].runId, run.id);
  assert.equal(computer.network.allowed('example.com'), false);
  store.close();
});
test('web bridge uses its selected private engine, never the inherited host context', async () => {
  const store = new Store(':memory:', { sample: false });
  let call;
  const computer = new PrivateComputer(store, {
    docker: '/private/tools/docker',
    dockerHost: 'unix:///private/engine.sock',
  });
  computer.dockerEnvironment = {
    HOME: '/private/home',
    PATH: '/private/tools:/usr/bin:/bin',
    DOCKER_CONFIG: '/private/docker-config',
  };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  const network = new ComputerNetwork(computer, {
    spawner: (...args) => {
      call = args;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')));
      return child;
    },
  });
  try {
    await network.start();
    assert.equal(call[0], '/private/tools/docker');
    assert.deepEqual(call[1].slice(0, 3), ['--host', 'unix:///private/engine.sock', 'exec']);
    assert.equal(call[2].env.DOCKER_CONTEXT, '');
    assert.equal(call[2].env.DOCKER_CONFIG, '/private/docker-config');
    assert.equal(call[2].env.HOME, '/private/home');
  } finally {
    child.kill();
    store.close();
  }
});
