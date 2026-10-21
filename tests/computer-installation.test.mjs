// SPDX-License-Identifier: MIT
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
import { ComputerInstallation } from '../server/computer-installation.mjs';
import { downloadEngineArtifact } from '../server/computer-engine-release.mjs';
const bytes = Buffer.from('Relay independent engine fixture');
const release = {
  version: 'test',
  artifacts: ['bin/colima', 'bin/limactl', 'bin/docker', 'cli-plugins/docker-buildx'].map(
    (target, i) => ({
      name: 'fixture-' + i,
      target,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'https://github.com/relay-test/releases/' + i,
    }),
  ),
};
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const bad = () => ({ stdout: '', stderr: 'private diagnostic', exitCode: 1 });
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await delay(5);
  }
  throw Error('deadline');
}
async function fixture(options = {}) {
  const directory = await mkdtemp('/tmp/rcinstall-');
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { deployment: directory, docker: '/missing-docker' });
  const calls = [];
  let mode = 'ready',
    vm = '',
    built = '',
    opens = 0,
    downloads = 0;
  const runner = async (binary, args, config = {}) => {
    calls.push({ binary, args, config });
    config.signal?.throwIfAborted();
    if (binary === '/missing-docker') throw Object.assign(Error('missing'), { code: 'ENOENT' });
    if (binary.endsWith('/colima')) {
      if (args[0] === 'list')
        return ok(vm ? JSON.stringify({ name: 'relay', runtime: 'docker', status: vm }) : '');
      if (args[0] === 'start') {
        if (mode === 'vm-fail') return bad();
        vm = 'Running';
        if (mode === 'vm-hold')
          await new Promise((_, reject) =>
            config.signal.addEventListener('abort', () => reject(config.signal.reason), {
              once: true,
            }),
          );
        return ok();
      }
      if (args[0] === 'stop') {
        if (mode === 'stop-fail') return bad();
        vm = 'Stopped';
        return ok();
      }
    }
    if (args.includes('--version')) return ok('Docker');
    if (args.includes('info')) return vm === 'Running' ? ok('linux') : bad();
    if (args.includes('build')) {
      built = args[args.indexOf('--label') + 1].split('=')[1];
      return ok();
    }
    if (args.includes('inspect') && built)
      return ok(
        JSON.stringify([
          {
            Config: {
              Labels: { 'org.relay.computer.source': built },
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
  computer.start = async () => {
    opens++;
    return { state: 'running' };
  };
  const setup = new ComputerSetup(computer, {
    root: resolve('.'),
    home: join(directory, 'other-home'),
    environment: options.environment || {},
    runner,
  });
  const config = {
    root: join(directory, 'vm'),
    platform: 'darwin',
    arch: 'arm64',
    systemRelease: '23',
    memory: () => 16 * 1024 ** 3,
    disk: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
    releaseOptions: {
      release,
      fetcher: async (_url, init) => {
        downloads++;
        if (mode === 'hold')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 3));
                init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {
                  once: true,
                });
              },
            }),
          );
        if (mode === 'offline') throw Error('secret diagnostic');
        return new Response(mode === 'corrupt' ? Buffer.alloc(bytes.length, 1) : bytes);
      },
    },
    ...options,
  };
  const make = () => new ComputerInstallation(setup, config);
  const manager = (setup.installation = make());
  return {
    store,
    computer,
    setup,
    manager,
    make,
    directory,
    calls,
    config,
    get downloads() {
      return downloads;
    },
    get vm() {
      return vm;
    },
    get opens() {
      return opens;
    },
    mode(value) {
      mode = value;
    },
    async close() {
      await setup.installation.close();
      await setup.engineControl.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('explicit private setup installs verified tools, creates only its VM, builds bundled files and opens once', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.store.read());
    assert.equal((await f.manager.status()).available, true);
    assert.equal(f.downloads, 0);
    assert.equal((await readdir(f.directory)).length, 0);
    const id = randomUUID();
    f.manager.start({ id });
    assert.equal(f.manager.start({ id }).busy, true);
    assert.throws(() => f.manager.start({ id: randomUUID() }), /already running/);
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
    assert.equal(f.opens, 1);
    assert.equal(f.downloads, 4);
    const start = f.calls.find((c) => c.args[0] === 'start');
    for (const flag of [
      '--mount',
      'none',
      '--activate=false',
      '--ssh-config=false',
      '--template=false',
      '--ssh-agent=false',
      '--port-forwarder=none',
    ])
      assert(start.args.includes(flag));
    assert(!start.config.env.PATH.includes('homebrew'));
    assert.equal(start.config.env.HOME, join(f.manager.root, 'home'));
    const override = JSON.parse(
      await readFile(join(f.manager.root, 'colima/_lima/_config/override.yaml')),
    );
    assert.deepEqual(override.portForwards[0].guestPortRange, [1, 65535]);
    assert.equal(override.portForwards[0].ignore, true);
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.computer.dockerHost, f.manager.host);
    const build = f.calls.find((c) => c.args.includes('build'));
    assert.equal(build.config.env.DOCKER_CONFIG, join(f.manager.root, 'docker-config'));
    const count = f.calls.length;
    const restored = f.make();
    f.setup.installation = restored;
    await restored.restore();
    assert.equal(restored.selected, true);
    assert.equal(f.calls.length, count);
  } finally {
    await f.close();
  }
});
test('integrity failure never unpacks or executes and a fresh request retries', async () => {
  const f = await fixture();
  try {
    f.mode('corrupt');
    f.manager.start();
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'error');
    assert.equal(
      f.calls.some((c) => c.args[0] === 'start'),
      false,
    );
    assert(!JSON.stringify(f.manager.state).includes('diagnostic'));
    f.mode('ready');
    f.manager.start();
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
  } finally {
    await f.close();
  }
});
test('cancelling a download removes staging, deduplicates retry IDs and preserves history', async () => {
  const f = await fixture();
  try {
    f.mode('hold');
    const id = randomUUID();
    f.manager.start({ id });
    await waitFor(() => f.manager.state.completed > 0);
    await assert.rejects(f.manager.cancel({ id: randomUUID() }), /no longer current/);
    await f.manager.cancel({ id });
    assert.equal(f.manager.state.phase, 'cancelled');
    assert.equal(
      f.calls.some((c) => c.args[0] === 'start'),
      false,
    );
    assert(!(await readdir(f.manager.root)).some((n) => n.startsWith('.install-')));
    f.manager.start({ id });
    assert.equal(f.manager.state.phase, 'cancelled');
    f.mode('ready');
    f.manager.start();
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
  } finally {
    await f.close();
  }
});
test('cancelling VM creation stops only the owned profile, preserves tools and retries without downloading', async () => {
  const f = await fixture();
  try {
    f.mode('vm-hold');
    f.manager.start();
    await waitFor(() => f.vm === 'Running');
    assert.throws(() => f.setup.start(), /already running/);
    assert.throws(() => f.setup.engineControl.start(), /already running/);
    await f.manager.cancel();
    assert.equal(f.vm, 'Stopped');
    assert.equal(f.manager.state.phase, 'cancelled');
    assert.equal(await f.manager.release.installed(), true);
    const stops = f.calls.filter((c) => c.args[0] === 'stop');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].binary, f.manager.colima);
    assert.equal(stops[0].config.env.COLIMA_HOME, join(f.manager.root, 'colima'));
    f.mode('ready');
    f.manager.start();
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
    assert.equal(f.downloads, 4);
  } finally {
    await f.close();
  }
});
test('managed recovery finds and wakes only its own stopped profile with its private environment', async () => {
  const f = await fixture();
  try {
    f.manager.start();
    await f.manager.pending;
    await f.setup.runner(f.manager.colima, ['stop', '--profile', 'relay']);
    f.setup.engineControl.checkedAt = 0;
    const status = await f.setup.engineControl.status();
    assert.equal(status.managed, true);
    assert.equal(status.canStart, true);
    f.setup.engineControl.start();
    await f.setup.engineControl.pending;
    assert.equal(f.vm, 'Running');
    assert.equal(f.opens, 2);
    const wake = f.calls.filter((c) => c.args[0] === 'start').at(-1);
    assert(wake.args.includes('--save-config=false'));
    assert.equal(wake.config.env.DOCKER_CONFIG, f.manager.env.DOCKER_CONFIG);
  } finally {
    await f.close();
  }
});
test('interrupted installation never resumes itself and keeps an explicit recovery request', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    f.store.secret('computer-installation', JSON.stringify({ id, phase: 'running' }));
    const restored = f.make();
    f.setup.installation = restored;
    await restored.restore();
    assert.equal(restored.state.phase, 'interrupted');
    assert.equal(f.downloads, 0);
    assert.equal(f.calls.length, 0);
    restored.start();
    await restored.pending;
    assert.equal(restored.state.phase, 'ready');
  } finally {
    await f.close();
  }
});
test('owner-disabled, selected external engines and unsupported servers cannot install', async () => {
  for (const options of [
    { environment: { RELAY_DESKTOP_ENABLED: 'false' } },
    { environment: { RELAY_DESKTOP_ENABLED: 'true' } },
    { environment: { DOCKER_HOST: 'unix:///external.sock' } },
    { environment: { DOCKER_CONTEXT: 'other' } },
    { platform: 'linux' },
    { arch: 'x64' },
    { systemRelease: '22' },
  ]) {
    const f = await fixture(options);
    try {
      assert.equal((await f.manager.status()).available, false);
      assert.throws(() => f.manager.start(), /unavailable/);
      assert.equal(f.downloads, 0);
    } finally {
      await f.close();
    }
  }
});
test('a runtime appearing after the offer cannot be replaced by a private VM', async () => {
  const f = await fixture();
  try {
    f.setup.engineControl.inspect = async () => ({ running: true });
    f.manager.start();
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'error');
    assert.match(f.manager.state.error, /existing computer runtime/);
    assert.equal(f.downloads, 0);
    assert.equal((await readdir(f.directory)).length, 0);
  } finally {
    await f.close();
  }
});
test('insufficient memory or disk is explained before downloading any executable', async () => {
  for (const options of [
    { memory: () => 4 * 1024 ** 3 },
    { disk: async () => ({ bavail: 10, bsize: 1 }) },
  ]) {
    const f = await fixture(options);
    try {
      f.manager.start();
      await f.manager.pending;
      assert.equal(f.manager.state.phase, 'error');
      assert.match(f.manager.state.error, /memory|Free at least/);
      assert.equal(f.downloads, 0);
    } finally {
      await f.close();
    }
  }
});
test('unrelated folders and existing release destinations are kept unchanged', async () => {
  const f = await fixture();
  try {
    await mkdir(f.manager.root);
    await writeFile(join(f.manager.root, 'keep'), 'owner data');
    f.manager.start();
    await f.manager.pending;
    assert.match(f.manager.state.error, /already exists/);
    assert.equal(await readFile(join(f.manager.root, 'keep'), 'utf8'), 'owner data');
    assert.equal(f.downloads, 0);
  } finally {
    await f.close();
  }
  const g = await fixture();
  try {
    await g.manager.createHome();
    await mkdir(g.manager.release.destination);
    await writeFile(join(g.manager.release.destination, 'keep'), 'owner tools');
    g.manager.start();
    await g.manager.pending;
    assert.equal(g.manager.state.phase, 'error');
    assert.equal(
      await readFile(join(g.manager.release.destination, 'keep'), 'utf8'),
      'owner tools',
    );
    assert.equal(g.downloads, 0);
  } finally {
    await g.close();
  }
});
test('runtime executable symlinks are rejected and cannot become a restored engine', async () => {
  const f = await fixture();
  try {
    f.manager.start();
    await f.manager.pending;
    const path = join(f.manager.release.destination, 'bin/docker');
    await rm(path);
    await symlink('/usr/bin/true', path);
    assert.equal(await f.manager.release.installed(), false);
    const restored = f.make();
    f.setup.installation = restored;
    await restored.restore();
    assert.equal(!!restored.selected, false);
  } finally {
    await f.close();
  }
});
test('release redirects stay HTTPS on GitHub assets; Docker origin cannot redirect', async () => {
  const artifact = release.artifacts[0];
  for (const location of [
    'https://evil.invalid/file',
    'http://release-assets.githubusercontent.com/file',
    'https://user@release-assets.githubusercontent.com/file',
  ])
    await assert.rejects(
      downloadEngineArtifact(
        async () => new Response(null, { status: 302, headers: { location } }),
        artifact,
        new AbortController().signal,
      ),
      /Unexpected/,
    );
  await assert.rejects(
    downloadEngineArtifact(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/file' },
        }),
      { ...artifact, url: 'https://download.docker.com/file' },
      new AbortController().signal,
    ),
    /Unexpected/,
  );
  let calls = 0;
  const response = await downloadEngineArtifact(
    async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://release-assets.githubusercontent.com/file' },
          })
        : new Response(bytes),
    artifact,
    new AbortController().signal,
  );
  assert.equal(await response.text(), bytes.toString());
});
test('installer HTTP actions require owner and same-origin access and ignore arbitrary program input', async () => {
  const f = await fixture();
  const app = createApp(
    f.store,
    {
      mode: 'live',
      computer: f.computer,
      computerSetup: f.setup,
      provider: { publicState: () => ({}) },
      google: {},
      browser: {},
      terminal: {},
    },
    { host: '127.0.0.1', port: 0, accessKey: 'computer-owner-test' },
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
    assert.equal((await post('computer/installation/start', {})).status, 401);
    const cookie = (await post('login', { key: 'computer-owner-test' })).headers
      .get('set-cookie')
      .split(';')[0];
    assert.equal(
      (await post('computer/installation/start', {}, cookie, 'https://other.invalid')).status,
      403,
    );
    assert.equal((await post('computer/installation/execute', {}, cookie)).status, 404);
    assert.equal(f.downloads, 0);
    assert.equal(
      (await post('computer/installation/start', { id: '../elsewhere' }, cookie)).status,
      400,
    );
    const response = await post(
      'computer/installation/start',
      { command: 'arbitrary', url: 'https://other.invalid', profile: 'owner' },
      cookie,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await f.manager.pending;
    assert.equal(f.manager.state.phase, 'ready');
    assert(f.calls.every((c) => !c.args.includes('arbitrary') && !c.args.includes('owner')));
    const state = await fetch(origin + '/api/computer/installation', {
      headers: { Cookie: cookie },
    }).then((r) => r.json());
    assert.equal(state.installation.phase, 'ready');
    assert.equal(f.store.read().messages.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await f.close();
  }
});

test('a failed private-VM cancellation is visible instead of claiming the VM stopped', async () => {
  const f = await fixture();
  try {
    f.mode('vm-hold');
    f.manager.start();
    await waitFor(() => f.vm === 'Running');
    f.mode('stop-fail');
    await f.manager.cancel();
    assert.equal(f.vm, 'Running');
    assert.equal(f.manager.state.phase, 'cancelled');
    assert.match(f.manager.state.error, /could not be stopped/);
  } finally {
    await f.close();
  }
});
test('the temporary OpenSSH control socket path is checked before offering installation', async () => {
  const f = await fixture({ root: '/tmp/' + 'x'.repeat(47) });
  try {
    assert.equal(f.manager.supported, false);
    assert.equal((await f.manager.status()).available, false);
    assert.throws(() => f.manager.start(), /unavailable/);
    assert.equal(f.downloads, 0);
  } finally {
    await f.close();
  }
});
