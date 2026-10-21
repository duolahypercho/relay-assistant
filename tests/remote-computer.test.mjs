// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createComputerCertificates } from '../scripts/remote-computer-certificates.mjs';
import {
  validateRemoteComputer,
  readRemoteComputer,
  remoteComputerFromEnvironment,
} from '../server/remote-computer.mjs';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-remote-computer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = await createComputerCertificates(join(directory, 'certificates'), '127.0.0.1');
  const config = {
    kind: 'relay-computer',
    version: 1,
    workspaceId: 'a'.repeat(32),
    endpoint: 'tcp://127.0.0.1:2376',
    image: 'sha256:' + 'b'.repeat(64),
    ...keys,
  };
  const path = join(directory, 'connection.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return {
    directory,
    path,
    config,
    environment: { RELAY_DESKTOP_ENABLED: 'true', RELAY_REMOTE_COMPUTER_FILE: path },
  };
}

test('remote computer validates pinned client identity, endpoint, expiry and immutable image', async (t) => {
  const { config, directory } = await fixture(t);
  assert.equal(validateRemoteComputer(config).endpoint, config.endpoint);
  const changed = [
    { endpoint: 'http://host:2376' },
    { endpoint: 'tcp://host:2376/path' },
    { endpoint: 'tcp://user:password@host:2376' },
    { endpoint: 'tcp://host:2376?tls=false' },
    { endpoint: 'tcp://host:0' },
    { endpoint: 'tcp://host' },
    { endpoint: 'tcp://host\n:2376' },
    { image: 'relay-desktop:latest' },
    { workspaceId: '../workspace' },
    { extra: true },
    { certificate: config.ca },
    { privateKey: 'invalid key' },
    { certificate: config.certificate + config.certificate },
    { privateKey: await readFile(join(directory, 'certificates/server-key.pem'), 'utf8') },
  ];
  for (const patch of changed)
    assert.throws(
      () => validateRemoteComputer({ ...config, ...patch }),
      /connection file is invalid/,
    );
  assert.throws(
    () => validateRemoteComputer(config, { now: Date.now() + 400 * 86400000 }),
    /invalid/,
  );
  assert.throws(() => validateRemoteComputer(config, { now: Date.now() - 86400000 }), /invalid/);
  const unrelated = await createComputerCertificates(join(directory, 'unrelated'), '127.0.0.1');
  assert.throws(() => validateRemoteComputer({ ...config, ca: unrelated.ca }), /invalid/);
});

test('connection files are bounded regular private files and ambiguous engines fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal(readRemoteComputer(f.path).image, f.config.image);
  await chmod(f.path, 0o644);
  assert.throws(() => readRemoteComputer(f.path), /invalid/);
  await chmod(f.path, 0o600);
  const fifo = join(f.directory, 'fifo');
  execFileSync('mkfifo', [fifo]);
  assert.throws(() => readRemoteComputer(fifo), /invalid/);
  assert.throws(() => readRemoteComputer('relative.json'), /invalid/);
  for (const patch of [
    { RELAY_DESKTOP_ENABLED: 'false' },
    { DOCKER_HOST: 'unix:///docker.sock' },
    { DOCKER_CONTEXT: 'default' },
    { RELAY_DESKTOP_IMAGE: 'other' },
    { RELAY_COMPUTER_ENABLED: 'true' },
  ])
    await assert.rejects(
      remoteComputerFromEnvironment({ ...f.environment, ...patch }),
      /Remote computer setup requires/,
    );
  await writeFile(f.path, 'x'.repeat(64001));
  assert.throws(() => readRemoteComputer(f.path), /invalid/);
  assert.equal(await remoteComputerFromEnvironment({}), null);
});

test('only private ephemeral certificate paths enter child environment and are removed on close', async (t) => {
  const f = await fixture(t),
    remote = await remoteComputerFromEnvironment(f.environment);
  const path = remote.environment.DOCKER_CERT_PATH;
  try {
    assert.equal(remote.environment.DOCKER_TLS_VERIFY, '1');
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(path, 'key.pem'))).mode & 0o777, 0o400);
    assert.equal(await readFile(join(path, 'key.pem'), 'utf8'), f.config.privateKey);
    assert.ok(!JSON.stringify(remote).includes('BEGIN'));
    const store = new Store(':memory:', { sample: false });
    try {
      const calls = [];
      const computer = new PrivateComputer(store, {
        enabled: true,
        deployment: remote.deployment,
        dockerHost: remote.endpoint,
        image: remote.image,
        remoteEngine: remote,
        runner: async (...args) => {
          calls.push(args);
          return { exitCode: 0, stdout: 'ok' };
        },
      });
      await computer.dockerRun(['version']);
      assert.deepEqual(calls[0][1], ['--host', remote.endpoint, 'version']);
      assert.equal(calls[0][2].env.DOCKER_TLS_VERIFY, '1');
      assert.equal(calls[0][2].env.DOCKER_HOST, '');
      assert.equal(calls[0][2].env.DOCKER_CONTEXT, '');
    } finally {
      store.close();
    }
  } finally {
    await remote.close();
  }
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('a remote connection can claim unused hosted computer state but preserves existing computer history', () => {
  for (const used of [false, true]) {
    const store = new Store(':memory:', { sample: false });
    try {
      const local = new PrivateComputer(store, { enabled: false, deployment: '/app/data' });
      if (used) store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
      const before = local.volume;
      const connect = () =>
        new PrivateComputer(store, {
          enabled: true,
          deployment: 'remote:test',
          remoteEngine: { environment: {} },
        });
      if (used) {
        assert.throws(connect, /already has computer history/);
        assert.equal(
          store.db.prepare('SELECT volume FROM computer_workspace WHERE id=1').get().volume,
          before,
        );
      } else {
        const remote = connect();
        assert.notEqual(remote.volume, before);
        assert.equal(connect().volume, remote.volume);
      }
    } finally {
      store.close();
    }
  }
});
