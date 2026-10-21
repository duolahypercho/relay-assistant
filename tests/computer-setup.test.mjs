// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup, setupProcess, localDockerHost } from '../server/computer-setup.mjs';
import { createApp } from '../server/app.mjs';
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const bad = () => ({ stdout: '', stderr: 'engine failure', exitCode: 1 });
function fixture(environment = {}) {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store);
  const calls = [];
  let fingerprint = '',
    built = false;
  const runner = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === '--version') return ok('Docker');
    if (args[0] === 'context')
      return ok(
        JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]),
      );
    if (args.includes('info')) return ok('linux');
    if (args.includes('build')) {
      fingerprint = args[args.indexOf('--label') + 1].split('=')[1];
      built = true;
      assert.deepEqual(await readdir(options.cwd), ['docker']);
      const sources = await readdir(resolve(options.cwd, 'docker'));
      assert.equal(sources.length, 9);
      assert(sources.includes('accessibility.py'));
      assert.equal((await stat(options.cwd)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(resolve(options.cwd, 'docker/desktop-start.sh'))).mode & 0o777,
        0o644,
      );
      return ok();
    }
    if (args.includes('inspect') && built)
      return ok(
        JSON.stringify([
          {
            Config: {
              Labels: { 'org.relay.computer.source': fingerprint },
              User: '1000:1000',
              WorkingDir: '/workspace',
              Entrypoint: ['/usr/bin/tini', '--', '/bin/sh', '/opt/relay/desktop-start.sh'],
            },
          },
        ]),
      );
    if (args.includes('run') || args.includes('rm')) return ok();
    return bad();
  };
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    environment,
    runner,
    home: '/test',
  });
  return { store, computer, setup, calls, runner };
}
test('one setup builds only bundled computer files, serializes repeats, cleans up and survives restart', async () => {
  const f = fixture();
  try {
    const messages = structuredClone(f.store.read().messages);
    assert.equal(f.setup.start().busy, true);
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.setup.status().phase, 'ready');
    assert.equal(f.calls.filter((c) => c.args.includes('build')).length, 1);
    assert.match(f.computer.image, /^relay-desktop:setup-[a-f0-9]{16}$/);
    assert.equal(f.computer.dockerHost, 'unix:///test/.colima/relay/docker.sock');
    await assert.rejects(stat(f.calls.find((c) => c.args.includes('build')).options.cwd), {
      code: 'ENOENT',
    });
    const restored = new PrivateComputer(f.store);
    new ComputerSetup(restored, { environment: {} });
    assert.equal(restored.enabled, true);
    assert.equal(restored.image, f.computer.image);
    assert.equal(restored.dockerHost, f.computer.dockerHost);
    assert.deepEqual(f.store.read().messages, messages);
  } finally {
    f.store.close();
  }
});
test('explicit disable wins over saved setup, and changed remote engine is not silently ignored', async () => {
  const f = fixture();
  try {
    f.setup.start();
    await f.setup.pending;
    const disabled = new PrivateComputer(f.store);
    const setup = new ComputerSetup(disabled, { environment: { RELAY_DESKTOP_ENABLED: 'false' } });
    assert.equal(disabled.enabled, false);
    assert.equal(setup.status().available, false);
    assert.throws(() => setup.start(), /disabled/);
    const changed = new PrivateComputer(f.store);
    const remote = new ComputerSetup(changed, {
      environment: { DOCKER_HOST: 'ssh://somewhere' },
      runner: f.runner,
    });
    assert.equal(changed.enabled, false);
    remote.start();
    await remote.pending;
    assert.equal(remote.status().code, 'remote');
    assert.equal(changed.enabled, false);
  } finally {
    f.store.close();
  }
});
test('missing engine and build failure stay disabled and are retryable', async () => {
  const f = fixture();
  try {
    f.setup.runner = async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.setup.status().code, 'install');
    f.setup.runner = (binary, args, options) =>
      args.includes('build') ? bad() : f.runner(binary, args, options);
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.setup.status().code, 'build');
    assert.equal(f.computer.enabled, false);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM computer_setup_config').get().n, 0);
    f.setup.runner = f.runner;
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.computer.enabled, true);
  } finally {
    f.store.close();
  }
});
test('cancelling an in-flight build cannot enable the computer or leave its build context', async () => {
  const f = fixture();
  let entered, directory;
  const building = new Promise((r) => {
    entered = r;
  });
  f.setup.runner = async (binary, args, options) => {
    if (!args.includes('build')) return f.runner(binary, args, options);
    directory = options.cwd;
    entered();
    await new Promise((_, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
    );
  };
  try {
    f.setup.start();
    await building;
    await f.setup.cancel();
    assert.equal(f.setup.status().phase, 'cancelled');
    assert.equal(f.setup.status().busy, false);
    assert.equal(f.computer.enabled, false);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally {
    f.store.close();
  }
});
test('an invalid image never enables the computer and retry rebuilds it', async () => {
  const f = fixture();
  try {
    f.setup.runner = async (binary, args, options) => {
      const result = await f.runner(binary, args, options);
      if (args.includes('image') && !result.exitCode) {
        const image = JSON.parse(result.stdout);
        image[0].Config.User = 'root';
        return ok(JSON.stringify(image));
      }
      return result;
    };
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.setup.status().code, 'image');
    assert.equal(f.computer.enabled, false);
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.calls.filter((c) => c.args.includes('build')).length, 2);
  } finally {
    f.store.close();
  }
});
test('setup endpoints require an owner session and reject cross-origin writes', async () => {
  const f = fixture();
  const key = 'setup-owner-key-that-is-long-enough';
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
    assert.equal((await fetch(url + '/api/computer/setup')).status, 401);
    assert.equal((await fetch(url + '/api/computer/setup/start', { method: 'POST' })).status, 401);
    const login = await fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    assert.equal(
      (
        await fetch(url + '/api/computer/setup/start', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.com' },
          body: '{}',
        })
      ).status,
      403,
    );
    const response = await fetch(url + '/api/computer/setup/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: 'untrusted', command: 'ignored', host: 'ssh://untrusted' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await f.setup.pending;
    assert.equal(f.setup.status().phase, 'ready');
    assert.ok(!JSON.stringify(f.calls).includes('untrusted'));
  } finally {
    await f.setup.cancel();
    server.close();
    server.closeAllConnections();
    f.store.close();
  }
});
test('managed computer uses the saved explicit local socket even when a Docker context is inherited', async () => {
  const f = fixture();
  try {
    let command;
    f.computer.dockerHost = 'unix:///own/engine.sock';
    f.computer.runner = async (...args) => {
      command = args;
      return ok();
    };
    await f.computer.dockerRun(['info']);
    assert.deepEqual(command[1], ['--host', 'unix:///own/engine.sock', 'info']);
    assert.deepEqual(command[2].env, { DOCKER_CONTEXT: '', DOCKER_HOST: '' });
    assert.equal(localDockerHost('tcp://remote'), false);
    assert.equal(localDockerHost('unix:///sock\n--flag'), false);
  } finally {
    f.store.close();
  }
});
test('setup subprocess handles timeout and cancellation without inheriting model credentials', async () => {
  const result = await setupProcess(process.execPath, [
    '-e',
    'console.log(process.env.RELAY_MODEL_API_KEY || "absent")',
  ]);
  assert.equal(result.stdout.trim(), 'absent');
  const timeout = await setupProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 30,
  });
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const pending = setupProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});

test('a failing runtime probe cleans up its container and never commits setup', async () => {
  const f = fixture();
  const cleanup = [];
  f.setup.runner = async (binary, args, options) => {
    if (args.includes('run')) return bad();
    if (args.includes('rm')) cleanup.push(args);
    return f.runner(binary, args, options);
  };
  try {
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.setup.status().code, 'image');
    assert.equal(f.computer.enabled, false);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM computer_setup_config').get().n, 0);
    assert.equal(cleanup.length, 1);
    assert.match(cleanup[0].at(-1), /^relay-setup-check-[a-f0-9]{24}$/);
  } finally {
    f.store.close();
  }
});
test('cancelling a runtime probe cleans up outside its aborted signal and remains retryable', async () => {
  const f = fixture();
  let entered,
    cleaned = false;
  const checking = new Promise((r) => {
    entered = r;
  });
  f.setup.runner = async (binary, args, options) => {
    if (args.includes('run')) {
      entered();
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      );
    }
    if (args.includes('rm')) {
      assert.equal(options.signal, undefined);
      cleaned = true;
    }
    return f.runner(binary, args, options);
  };
  try {
    f.setup.start();
    await checking;
    await f.setup.cancel();
    assert.equal(cleaned, true);
    assert.equal(f.setup.status().phase, 'cancelled');
    assert.equal(f.computer.enabled, false);
    f.setup.runner = f.runner;
    f.setup.start();
    await f.setup.pending;
    assert.equal(f.setup.status().phase, 'ready');
  } finally {
    f.store.close();
  }
});
