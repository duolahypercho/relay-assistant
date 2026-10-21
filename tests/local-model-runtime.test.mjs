// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  LocalModelRuntime,
  ollamaProbe,
  supervisedOllama,
} from '../server/local-model-runtime.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

function fixture(store = new Store(':memory:', { sample: false })) {
  const calls = [];
  const state = {
    running: false,
    occupied: false,
    hold: false,
    exits: false,
    installed: true,
    closes: 0,
  };
  const make = () =>
    new LocalModelRuntime(store, {
      platform: 'darwin',
      locate: async () => (state.installed ? '/installed/ollama' : null),
      environment: {
        HOME: '/actual/home',
        PATH: '/usr/bin',
        OLLAMA_MODELS: '/installed/models',
        OLLAMA_HOST: '0.0.0.0:9',
        OLLAMA_ORIGINS: '*',
        RELAY_MODEL_API_KEY: 'private-key',
        HTTPS_PROXY: 'private-proxy',
      },
      probe: async (signal) => {
        signal?.throwIfAborted();
        return { running: state.running, occupied: state.occupied };
      },
      timeout: 1000,
      launch: (binary, environment) => {
        calls.push({ binary, environment });
        let finish;
        const child = {
          ended: state.exits,
          done: new Promise((resolve) => {
            finish = resolve;
          }),
          close: async () => {
            state.closes++;
            child.ended = true;
            state.running = false;
            state.occupied = false;
            finish();
          },
        };
        if (!state.hold && !state.exits) state.running = state.occupied = true;
        return child;
      },
    });
  return { store, calls, state, make, runtime: make() };
}

test('installed local startup is explicit, fixed, isolated from secrets, persistent and never selects a model or adds messages', async () => {
  const f = fixture(),
    before = f.store.read();
  try {
    const initial = await f.runtime.status();
    assert.equal(initial.canStart, true);
    assert.equal(initial.startWithRelay, false);
    assert.equal(f.calls.length, 0);
    const result = await f.runtime.start({
      revision: 0,
      startWithRelay: true,
      executable: '/must/not/run',
      command: 'curl private',
      host: '0.0.0.0',
    });
    assert.equal(result.running, true);
    assert.equal(result.managed, true);
    assert.deepEqual(f.calls, [
      {
        binary: '/installed/ollama',
        environment: {
          HOME: '/actual/home',
          PATH: '/usr/bin',
          OLLAMA_MODELS: '/installed/models',
          OLLAMA_HOST: '127.0.0.1:11434',
          OLLAMA_NO_CLOUD: '1',
          OLLAMA_NOPRUNE: '1',
        },
      },
    ]);
    assert(!JSON.stringify(result).includes('/installed'));
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.store.secret('model-connections'), undefined);
    await f.runtime.close();
    assert.equal(f.state.closes, 1);
    const reopened = f.make();
    await reopened.restore();
    assert.equal(f.calls.length, 2);
    assert.equal((await reopened.status()).managed, true);
    await reopened.update({ revision: 1, startWithRelay: false });
    assert.equal(
      f.state.closes,
      1,
      'Changing future startup must not interrupt current inference.',
    );
    await reopened.close();
    const disabled = f.make();
    await disabled.restore();
    assert.equal(f.calls.length, 2);
    await disabled.close();
  } finally {
    await f.runtime.close();
    f.store.close();
  }
});

test('existing Ollama and occupied ports are never replaced, managed or stopped; missing and unsupported installations fail inline', async () => {
  const f = fixture();
  try {
    f.state.running = f.state.occupied = true;
    const result = await f.runtime.start({ revision: 0, startWithRelay: true });
    assert.equal(result.running, true);
    assert.equal(result.managed, false);
    assert.equal(result.startWithRelay, false);
    await f.runtime.close();
    assert.equal(f.state.closes, 0);
    assert.equal(f.state.running, true);
    f.state.running = false;
    const occupied = f.make();
    await assert.rejects(occupied.start({ revision: 0, startWithRelay: true }), /Another service/);
    assert.equal(f.calls.length, 0);
    f.state.occupied = false;
    f.state.installed = false;
    await assert.rejects(occupied.start({ revision: 0, startWithRelay: true }), /Install Ollama/);
    assert.equal((await occupied.status()).canStart, false);
    await occupied.close();
    const unsupported = new LocalModelRuntime(f.store, {
      platform: 'win32',
      probe: async () => ({ running: false, occupied: false }),
    });
    await assert.rejects(
      unsupported.start({ revision: 0, startWithRelay: true }),
      /computer running Relay/,
    );
    assert.equal((await unsupported.status()).available, false);
    await unsupported.close();
  } finally {
    await f.runtime.close();
    f.store.close();
  }
});

test('cancellation, deadline and early process exit release the owned process without saving startup preferences', async () => {
  const f = fixture();
  try {
    f.state.hold = true;
    const controller = new AbortController();
    const result = f.runtime.start({ revision: 0, startWithRelay: true }, controller.signal);
    while (!f.calls.length) await delay(5);
    await assert.rejects(
      f.runtime.start({ revision: 0, startWithRelay: true }),
      /already starting/,
    );
    await assert.rejects(f.runtime.update({ revision: 0, startWithRelay: false }), /Wait/);
    controller.abort(new Error('Owner cancelled startup'));
    await assert.rejects(result, /Owner cancelled startup/);
    assert.equal(f.state.closes, 1);
    assert.equal(f.runtime.preference().revision, 0);
    await assert.rejects(f.runtime.start({ revision: 0, startWithRelay: true }), /took too long/);
    assert.equal(f.state.closes, 2);
    assert.equal(f.runtime.preference().revision, 0);
    f.state.exits = true;
    await assert.rejects(f.runtime.start({ revision: 0, startWithRelay: true }), /stopped before/);
    assert.equal(f.state.closes, 3);
    f.state.exits = false;
    f.state.hold = false;
    assert.equal((await f.runtime.start({ revision: 0, startWithRelay: false })).running, true);
    // A lost health endpoint is not authority to start another owned process.
    f.state.running = f.state.occupied = false;
    assert.equal((await f.runtime.status()).canStart, false);
    await assert.rejects(f.runtime.start({ revision: 1, startWithRelay: true }), /still running/);
  } finally {
    await f.runtime.close();
    f.store.close();
  }
});

test('startup preferences reject stale/nonboolean writes and reopen durably without workspace export changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-runtime-settings-'));
  const store = new Store(join(directory, 'state.sqlite'), { sample: false });
  const f = fixture(store);
  try {
    await assert.rejects(
      f.runtime.start({ revision: 0, startWithRelay: 'yes' }),
      /settings changed/,
    );
    await assert.rejects(f.runtime.start(undefined), /settings changed/);
    await assert.rejects(f.runtime.update(null), /settings changed/);
    await f.runtime.update({ revision: 0, startWithRelay: true });
    await assert.rejects(
      f.runtime.update({ revision: 0, startWithRelay: false }),
      /settings changed/,
    );
    await assert.rejects(
      f.runtime.update({ revision: 1, startWithRelay: 'false' }),
      /Choose whether/,
    );
    const reopened = new Store(join(directory, 'state.sqlite'));
    assert.deepEqual(new LocalModelRuntime(reopened).preference(), {
      revision: 1,
      startWithRelay: true,
    });
    assert(!JSON.stringify(reopened.read()).includes('startWithRelay'));
    reopened.close();
    store.secret('local-model-runtime', '{broken');
    assert.throws(() => f.runtime.preference(), /could not be read/);
  } finally {
    await f.runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('health probing stays on fixed loopback, refuses redirects and bounds untrusted responses', async () => {
  const responses = [
    Response.json({ version: '0.40.3' }),
    new Response('x'.repeat(5000)),
    Response.json({ version: {} }),
    new Response('redirect', { status: 302 }),
  ];
  const connect = (options) => {
    assert.deepEqual(options, { host: '127.0.0.1', port: 11434 });
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  const fetcher = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/version');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers, undefined);
    return responses.shift();
  };
  assert.deepEqual(await ollamaProbe(undefined, { connect, fetcher }), {
    running: true,
    occupied: true,
  });
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await ollamaProbe(undefined, { connect, fetcher }), {
      running: false,
      occupied: true,
    });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ollamaProbe(controller.signal, { connect, fetcher }), {
    name: 'AbortError',
  });
});

test('runtime API is owner-only, same-origin, bounded to named operations and ignores caller launch arguments', async () => {
  const f = fixture();
  const app = createApp(
    f.store,
    {
      mode: 'live',
      provider: { publicState: () => ({}) },
      localModelRuntime: f.runtime,
      google: {},
      browser: {},
      terminal: {},
    },
    { host: '127.0.0.1', port: 0, accessKey: 'runtime-owner-key' },
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
    assert.equal((await post('models/local/start', {})).status, 401);
    const cookie = (await post('login', { key: 'runtime-owner-key' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('models/local/start', {}, cookie, 'https://outside.example')).status,
      403,
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await post('models/local/execute', {}, cookie)).status, 400);
    const result = await post(
      'models/local/start',
      { revision: 0, startWithRelay: false, executable: '/bin/sh', args: ['-c', 'bad'] },
      cookie,
    );
    assert.equal(result.status, 200);
    assert.equal((await result.json()).managed, true);
    assert.equal(f.calls[0].binary, '/installed/ollama');
    assert.equal(f.store.read().messages.length, 0);
  } finally {
    await f.runtime.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    f.store.close();
  }
});

test(
  'supervisor drains real descendants on normal close and parent SIGKILL without a host listener',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-supervisor-'));
    const executable = join(directory, 'ollama'),
      marker = join(directory, 'pids.json');
    const module = pathToFileURL(join(process.cwd(), 'server/local-model-runtime.mjs')).href;
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');if(process.argv[2]!=='serve')process.exit(2);const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])));process.on('SIGTERM',()=>{if(process.env.RELAY_TEST_LEADER_EXIT)process.exit(0)});setInterval(()=>{},1000);\n`,
    );
    await chmod(executable, 0o700);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const wait = async (fn) => {
      for (let i = 0; i < 200; i++) {
        if (await fn()) return;
        await delay(30);
      }
      throw Error('Process lifecycle deadline');
    };
    let direct, parent;
    try {
      direct = supervisedOllama(executable, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RELAY_TEST_LEADER_EXIT: '1',
      });
      await wait(async () => {
        try {
          return (await readFile(marker)).length;
        } catch {
          return false;
        }
      });
      const first = JSON.parse(await readFile(marker));
      await direct.close();
      await wait(() => first.every((pid) => !alive(pid)));
      await rm(marker);
      const helper = join(directory, 'parent.mjs');
      await writeFile(
        helper,
        `import { supervisedOllama } from ${JSON.stringify(module)};supervisedOllama(${JSON.stringify(executable)},{PATH:process.env.PATH,HOME:process.env.HOME});setInterval(()=>{},1000);`,
      );
      parent = fork(helper, [], { stdio: 'ignore' });
      await wait(async () => {
        try {
          return (await readFile(marker)).length;
        } catch {
          return false;
        }
      });
      const second = JSON.parse(await readFile(marker));
      const exited = once(parent, 'exit');
      parent.kill('SIGKILL');
      await exited;
      await wait(() => second.every((pid) => !alive(pid)));
    } finally {
      await direct?.close();
      if (parent && parent.exitCode === null) parent.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  },
);
