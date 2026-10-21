// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { Connectors } from '../server/connectors.mjs';
import { stdioFixture } from './stdio-fixture.mjs';
const dir = await mkdtemp(join(tmpdir(), 'relay-local-tools-'));
const store = new Store(join(dir, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: dir });
const connectors = new Connectors(store, { key: randomBytes(32), computer, timeoutMs: 15000 });
const checks = [];
let crashChild;
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const read = async (path) => Buffer.from((await computer.read(path)).base64, 'base64').toString();
process.env.RELAY_ACCEPTANCE_HOST_SECRET = 'must-not-reach-local-tool';
try {
  await computer.start();
  await computer.perform({
    kind: 'files',
    action: 'write',
    path: 'local-tools.py',
    base64: Buffer.from(stdioFixture).toString('base64'),
    operationId: 'local-fixture',
  });
  const input = {
    transport: 'stdio',
    name: 'Local notebook',
    launchApproved: true,
    launch: {
      command: 'python3',
      args: ['/workspace/local-tools.py'],
      env: { LOCAL_KEY: 'fictional-local-secret' },
    },
  };
  await assert.rejects(
    connectors.prepare({ ...input, launchApproved: false }),
    /Review the program/,
  );
  const found = await connectors.prepare(input);
  assert(found.connection.tools.every((t) => t.mode === 'ask'));
  assert.deepEqual(found.connection.launch.envKeys, ['LOCAL_KEY']);
  assert(!JSON.stringify(found).includes('fictional-local-secret'));
  assert.equal(computer.stdio.rows().length, 0);
  const saved = connectors.save({
    discoveryId: found.discoveryId,
    permissions: Object.fromEntries(
      found.connection.tools.map((t) => [t.name, t.readOnly ? 'auto' : 'ask']),
    ),
  }).connections[0];
  assert(!store.secret('app-connectors').includes('fictional-local-secret'));
  const payload = (toolName, args = {}) => ({
    connectionId: saved.id,
    revision: saved.revision,
    toolName,
    fingerprint: saved.tools.find((t) => t.name === toolName).fingerprint,
    arguments: args,
  });
  const inspected = await connectors.call(payload('inspect_runtime'), 'relay', 'inspect-local');
  const info = JSON.parse(inspected.content[0].text);
  assert.equal(info.uid, 1000);
  assert.equal(info.cwd, '/workspace');
  assert(info.hasExpectedSecret);
  assert(!info.hostSecretPresent);
  assert(!info.directNetwork);
  assert.equal(info.secretEcho, '[redacted]');
  check(
    'real stdio discovery, explicit launch review, encrypted environment, guest UID/cwd, no host secrets or direct network',
  );
  const write = payload('save_note', { text: '原創 local note 🌱' });
  await assert.rejects(connectors.call(write, 'relay', 'unreviewed-write'), /exact owner review/);
  await connectors.call(write, 'relay', 'reviewed-write', { reviewed: true });
  assert.equal(await read('local-note.txt'), '原創 local note 🌱');
  await connectors.call(write, 'relay', 'reviewed-write', { reviewed: true });
  assert.equal(computer.stdio.rows().length, 0);
  check('exact reviewed write and durable receipt without repeat dispatch');
  const pending = connectors
    .call(payload('slow_write'), 'relay', 'takeover-write', { reviewed: true })
    .then(
      () => null,
      (e) => e,
    );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await read('local-started.txt')) === 'started') break;
    } catch {}
    await delay(100);
    if (i === 99) throw Error('Local write did not start');
  }
  await computer.takeControl();
  const error = await pending;
  assert.equal(error?.name, 'UncertainActionError');
  const ticks = await read('local-ticks.txt');
  await delay(350);
  assert.equal(await read('local-ticks.txt'), ticks);
  assert.equal(computer.stdio.rows().length, 0);
  await assert.rejects(connectors.prepare(input), /owner has taken control/);
  await assert.rejects(
    connectors.call(payload('slow_write'), 'relay', 'takeover-write', { reviewed: true }),
    { name: 'UncertainActionError' },
  );
  check('takeover stops even double-forked tool descendants; uncertain writes cannot replay');
  await computer.release();
  await assert.rejects(
    connectors.call(payload('crash_write'), 'relay', 'crash-write', { reviewed: true }),
    { name: 'UncertainActionError' },
  );
  assert.equal(computer.stdio.rows().length, 0);
  const result = await connectors.call(payload('read_note'), 'relay', 'read-after-crash');
  assert.equal(result.content[0].text, '原創 local note 🌱');
  check('crashed sessions are reaped and a new explicit operation reconnects');
  await computer.perform({
    kind: 'exec',
    command: ': > /workspace/local-started.txt',
    operationId: 'reset-crash-marker',
  });
  crashChild = fork(new URL('./local-tools-crash-helper.mjs', import.meta.url), [dir], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const [ready] = await once(crashChild, 'message', { signal: AbortSignal.timeout(30000) });
  assert(ready.ready);
  for (let i = 0; i < 100; i++) {
    if ((await read('local-started.txt')) === 'started') break;
    await delay(100);
    if (i === 99) throw Error('Crash fixture did not start');
  }
  const exited = once(crashChild, 'exit');
  crashChild.kill('SIGKILL');
  await exited;
  assert.equal(computer.stdio.rows().length, 1);
  await computer.stdio.recover();
  const recovered = await read('local-ticks.txt');
  await delay(300);
  assert.equal(await read('local-ticks.txt'), recovered);
  assert.equal(computer.stdio.rows().length, 0);
  check(
    'real server-process SIGKILL leaves a durable session journal; recovery stops orphaned descendants',
  );
  await mkdir(resolve('../relay-evidence'), { recursive: true });
  await writeFile(
    resolve('../relay-evidence/local-tools-runtime.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks }, null, 2) + '\n',
  );
} finally {
  crashChild?.kill('SIGKILL');
  connectors.close();
  await computer.stop().catch((e) => console.error('Cleanup', e.message));
  await computer.checked(['rm', '-f', computer.name]).catch(() => {});
  for (const volume of [computer.volume, computer.displayVolume])
    await computer.checked(['volume', 'rm', volume]).catch(() => {});
  store.close();
  await rm(dir, { recursive: true, force: true });
}
