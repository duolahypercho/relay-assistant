// SPDX-License-Identifier: MIT
// Actual freezer/PID boundaries, detached processes and a responsive owner app.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
const dir = await mkdtemp(join(tmpdir(), 'relay-runtime-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let store = new Store(join(dir, 'state.sqlite'), { sample: false });
let computer = new PrivateComputer(store, { enabled: true, deployment: dir });
let number = 0;
const run = (command, actor = 'agent') =>
  computer.perform({ kind: 'exec', command, operationId: `runtime-${++number}` }, { actor });
const read = async (path) => Buffer.from((await computer.read(path)).base64, 'base64').toString();
const checks = [];
function check(label) {
  checks.push(label);
  console.log('PASS', label);
}
try {
  await computer.start();
  const desktop = await computer.inspect();
  const runtime = await computer.runtime.inspect();
  assert.notEqual(runtime.Id, desktop.Id);
  assert.equal(runtime.HostConfig.PidMode, '');
  assert.equal(desktop.HostConfig.NetworkMode, 'none');
  assert.equal(runtime.HostConfig.NetworkMode, `container:${desktop.Id}`);
  assert.equal(runtime.HostConfig.Privileged, false);
  assert.deepEqual(runtime.HostConfig.CapDrop, ['ALL']);
  assert.equal(runtime.Mounts.find((m) => m.Destination === '/tmp/.X11-unix').RW, false);
  check(
    'Command processes have a separate PID/freezer container with no direct network or host mounts',
  );
  const probe = `import os, time, signal
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open('/workspace/ticks.txt','ab',buffering=0) as f:
    while True:
        f.write(b'tick\\n')
        time.sleep(.04)
`;
  await computer.perform({
    kind: 'files',
    action: 'write',
    path: 'detached.py',
    base64: Buffer.from(probe).toString('base64'),
    operationId: 'probe-source',
  });
  const launch = await run('python3 /workspace/detached.py >/tmp/probe.log 2>&1');
  assert.equal(launch.exitCode, 0, launch.stderr);
  await delay(180);
  assert.ok((await read('ticks.txt')).length > 0);
  const processes = await run(`python3 - <<'PY'
from pathlib import Path
lines=[]
for p in Path('/proc').glob('[0-9]*/comm'):
 try: lines.append(p.read_bytes().decode(errors='replace'))
 except OSError: pass
assert not any(s.strip() in ('chromium', 'Xvfb') for s in lines)
print('desktop processes absent')
PY`);
  assert.equal(processes.exitCode, 0, processes.stderr);
  check('Detached double-forked work runs, but cannot see desktop processes through /proc');
  await computer.takeControl();
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  const frozen = await read('ticks.txt');
  await delay(450);
  assert.equal(await read('ticks.txt'), frozen);
  check('Takeover freezes a detached process even after setsid, double fork and ignored SIGTERM');
  const editor = await run(
    'mousepad /workspace/owner-note.txt >/tmp/owner-editor.log 2>&1 &',
    'owner',
  );
  assert.equal(editor.exitCode, 0, editor.stderr);
  await delay(800);
  await computer.perform(
    { kind: 'desktop', action: 'type', text: 'The owner can still edit.', operationId: 'type' },
    { actor: 'owner' },
  );
  await computer.perform(
    { kind: 'desktop', action: 'key', key: 'ctrl+s', operationId: 'save' },
    { actor: 'owner' },
  );
  await delay(250);
  assert.match(await read('owner-note.txt'), /owner can still edit/);
  assert.equal(await read('ticks.txt'), frozen);
  const shot = await computer.screenshot();
  await writeFile(
    join(evidence, 'runtime-owner-desktop.jpg'),
    Buffer.from(shot.screenshot, 'base64'),
  );
  check(
    'Owner typing, keyboard shortcuts, file transfer and screenshots work while agent processes are frozen',
  );
  store.close();
  // Emulate an external unpause during service downtime. Recovery must reconcile
  // the actual kernel state before showing the owner an interactive desktop.
  await computer.checked(['unpause', computer.runtime.name]);
  store = new Store(join(dir, 'state.sqlite'), { sample: false });
  computer = new PrivateComputer(store, { enabled: true, deployment: dir });
  assert.equal((await computer.status()).controller, 'owner');
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  const recovered = await read('ticks.txt');
  await delay(200);
  assert.equal(await read('ticks.txt'), recovered);
  check('SQLite/server recovery re-freezes the actual runtime before owner interaction');
  await computer.release();
  assert.equal((await computer.runtime.inspect()).State.Paused, false);
  await delay(160);
  assert.ok((await read('ticks.txt')).length > recovered.length);
  check('Handback resumes the same detached process without relaunching its command');
  await computer.takeControl();
  const stopped = await read('ticks.txt');
  await computer.stop();
  assert.equal(await computer.runtime.inspect(), null);
  await computer.start('owner');
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  assert.equal(await read('ticks.txt'), stopped);
  await delay(160);
  assert.equal(await read('ticks.txt'), stopped);
  check(
    'Stopping a frozen runtime kills it without briefly resuming work; files and owner control survive restart',
  );
  await computer.release();
  const next = await run("printf 'new work' > after-restart.txt");
  assert.equal(next.exitCode, 0, next.stderr);
  assert.equal(await read('after-restart.txt'), 'new work');
  check('Fresh agent work runs after restart and handback');
  await writeFile(
    join(evidence, 'computer-runtime-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Real Docker freezer/PID isolation and graphical desktop',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} command-runtime checks passed.`);
} finally {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  store.close();
  await rm(dir, { recursive: true, force: true });
}
