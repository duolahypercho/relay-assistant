// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { BrowserContainer, validateBrowserContainer } from '../server/browser-container.mjs';
const image = 'sha256:' + 'a'.repeat(64),
  id = 'b'.repeat(64),
  owner = 'c'.repeat(16);
function inspected(runtime) {
  return {
    Name: '/' + runtime.name,
    Id: id,
    Image: image,
    Mounts: [],
    NetworkSettings: { Networks: {} },
    Config: {
      Image: image,
      Labels: { 'org.relay.owner': owner, 'org.relay.role': 'private-browser' },
      User: '1000:1000',
      WorkingDir: '/tmp',
      Entrypoint: ['/usr/bin/tini'],
      Cmd: ['--', '/usr/bin/node', '--input-type=module', '-e', runtime.source],
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      Env: ['PATH=/usr/bin', 'HOME=/tmp', 'LANG=C.UTF-8', 'DISPLAY='],
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 128,
      Memory: 1073741824,
      MemorySwap: 1073741824,
      NanoCpus: 2000000000,
      ShmSize: 134217728,
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      AutoRemove: true,
      RestartPolicy: { Name: 'no' },
      Binds: [],
      Devices: [],
      DeviceRequests: [],
      PortBindings: {},
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=268435456,mode=1777' },
    },
  };
}
function fixture({ mutate, launchError, beforeCreate } = {}) {
  const calls = [],
    launches = [];
  let runtime;
  const computer = {
    owner,
    image: 'relay-desktop:local',
    docker: '/fixed/docker',
    dockerHost: 'unix:///test/engine.sock',
    runner: async (binary, args, options) => {
      assert.equal(binary, '/fixed/docker');
      assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///test/engine.sock']);
      args = args.slice(2);
      calls.push(args);
      if (args[0] === 'image')
        return { exitCode: 0, stdout: JSON.stringify([{ Id: image, Config: {} }]) };
      if (args[0] === 'create') {
        await beforeCreate?.();
        return { exitCode: 0, stdout: id + '\n' };
      }
      if (args[0] === 'inspect') {
        const c = inspected(runtime);
        mutate?.(c, launches.length);
        return { exitCode: 0, stdout: JSON.stringify([c]) };
      }
      if (args[0] === 'rm') return { exitCode: 0, stdout: id };
      throw Error('Unexpected command');
    },
  };
  runtime = new BrowserContainer(computer, {
    launch: async (options) => {
      launches.push(options);
      if (launchError) throw Error('secret raw transport details');
      const b = new EventEmitter();
      b.connected = true;
      b.isConnected = () => b.connected;
      b.close = async () => {
        b.connected = false;
        b.emit('disconnected');
      };
      return b;
    },
  });
  return { runtime, computer, calls, launches };
}
test('private browser container enforces independent networking, namespaces, mounts and resource limits', () => {
  const runtime = { name: 'relay-browser-test', source: 'fixed source' };
  const context = { ...runtime, owner, image };
  const good = inspected(runtime);
  assert.equal(validateBrowserContainer(good, context), good);
  const mutations = [
    (c) => (c.Config.Labels['org.relay.owner'] = 'other'),
    (c) => (c.Image = 'sha256:' + 'd'.repeat(64)),
    (c) => (c.Config.User = '0'),
    (c) => (c.HostConfig.NetworkMode = 'host'),
    (c) => (c.NetworkSettings.Networks = { bridge: {} }),
    (c) => (c.HostConfig.Privileged = true),
    (c) => (c.HostConfig.CapAdd = ['SYS_ADMIN']),
    (c) => (c.HostConfig.SecurityOpt = ['seccomp=unconfined']),
    (c) => (c.HostConfig.PidMode = 'host'),
    (c) => (c.HostConfig.IpcMode = 'host'),
    (c) => (c.HostConfig.UsernsMode = 'host'),
    (c) => (c.HostConfig.ReadonlyRootfs = false),
    (c) => (c.HostConfig.Memory = 0),
    (c) => (c.HostConfig.MemorySwap = -1),
    (c) => (c.HostConfig.NanoCpus = 0),
    (c) => (c.HostConfig.PidsLimit = -1),
    (c) => (c.HostConfig.ShmSize = 1073741824),
    (c) => (c.HostConfig.Binds = ['/:/host']),
    (c) => (c.Mounts = [{ Type: 'volume', Destination: '/workspace' }]),
    (c) => (c.HostConfig.Devices = [{}]),
    (c) => (c.HostConfig.DeviceRequests = [{}]),
    (c) => (c.HostConfig.PortBindings = { '9222/tcp': [{}] }),
    (c) => (c.HostConfig.ExtraHosts = ['host:1.1.1.1']),
    (c) => (c.HostConfig.VolumesFrom = ['owner']),
    (c) => (c.HostConfig.Tmpfs['/tmp'] = 'rw,size=8g'),
    (c) => (c.HostConfig.Tmpfs['/workspace'] = 'rw'),
    (c) => c.Config.Env.push('MODEL_API_KEY=secret'),
    (c) => (c.Config.Env = c.Config.Env.filter((e) => e !== 'DISPLAY=')),
    (c) => c.Config.Cmd.push('--remote-debugging-port=9222'),
    (c) => (c.Config.Entrypoint = ['/bin/sh']),
    (c) => (c.HostConfig.RestartPolicy = { Name: 'always' }),
    (c) => (c.HostConfig.AutoRemove = false),
  ];
  for (const mutate of mutations) {
    const value = structuredClone(good);
    mutate(value);
    assert.throws(() => validateBrowserContainer(value, context), /isolation settings changed/);
  }
});
test('launch pins the installed image, validates before attachment and uses private pipes with a minimal host environment', async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.runtime.launch(), f.runtime.launch()]);
    assert.equal(a, b);
    assert.equal(f.launches.length, 1);
    const create = f.calls.find((a) => a[0] === 'create');
    assert(create.includes(image));
    assert(!create.includes('relay-desktop:local'));
    assert(!create.includes('--privileged'));
    assert(!create.includes('--publish'));
    const options = f.launches[0];
    assert.equal(options.ignoreDefaultArgs, true);
    assert.equal(options.timeout, 20000);
    assert.deepEqual(Object.keys(options.env).sort(), ['ELECTRON_RUN_AS_NODE', 'HOME', 'PATH']);
    assert.equal(options.args[1], '/fixed/docker');
    assert.equal(options.args[2], 'unix:///test/engine.sock');
    assert.equal(options.args[3], id);
    const path = options.args[0];
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert((await readFile(path, 'utf8')).includes('fd: 3'));
    await f.runtime.close();
    await assert.rejects(stat(path), /ENOENT/);
    assert(f.calls.some((a) => a[0] === 'rm' && a[2] === id));
  } finally {
    await f.runtime.close();
  }
});
test('weakened inspection before or after attachment fails closed and startup errors are redacted', async () => {
  for (const after of [0, 1]) {
    const f = fixture({
      mutate: (c, n) => {
        if (n === after) c.HostConfig.NetworkMode = 'host';
      },
    });
    try {
      await assert.rejects(f.runtime.launch(), /isolation settings changed/);
      assert.equal(f.launches.length, after);
      assert.equal(f.runtime.id, null);
      assert.equal(f.runtime.directory, null);
    } finally {
      await f.runtime.close();
    }
  }
  const f = fixture({ launchError: true });
  await assert.rejects(
    f.runtime.launch(),
    (e) => !e.message.includes('secret') && /could not start/.test(e.message),
  );
  assert.equal(f.runtime.id, null);
  assert.equal(f.runtime.directory, null);
  await f.runtime.close();
});
test('closing during creation prevents browser attachment and removes the owned container', async () => {
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  const f = fixture({
    beforeCreate: async () => {
      entered();
      await gate;
    },
  });
  const starting = f.runtime.launch();
  await ready;
  const closing = f.runtime.close();
  release();
  await assert.rejects(starting, /cancelled/);
  await closing;
  assert.equal(f.launches.length, 0);
  assert(f.calls.some((a) => a[0] === 'rm'));
  await assert.rejects(f.runtime.launch(), /closed/);
});
test('a disconnected browser is removed before retry and remote engines are rejected', async () => {
  const f = fixture();
  try {
    const first = await f.runtime.launch();
    await first.close();
    const next = await f.runtime.launch();
    assert.notEqual(first, next);
    assert.equal(f.launches.length, 2);
    assert(f.calls.some((a) => a[0] === 'rm'));
  } finally {
    await f.runtime.close();
  }
  const remote = fixture();
  remote.computer.dockerHost = 'tcp://remote:2375';
  await assert.rejects(remote.runtime.launch(), /local Docker/);
  assert.equal(remote.calls.length, 0);
  await remote.runtime.close();
});

test('a lost create acknowledgement removes only the fully validated container for this launch', async () => {
  const f = fixture({
    beforeCreate: () => {
      throw Error('Lost create acknowledgement');
    },
  });
  await assert.rejects(f.runtime.launch(), /could not start/);
  assert(f.calls.some((args) => args[0] === 'inspect' && args[1] === f.runtime.name));
  assert(f.calls.some((args) => args[0] === 'rm' && args[2] === id));
  assert.equal(f.launches.length, 0);
  await f.runtime.close();
});
