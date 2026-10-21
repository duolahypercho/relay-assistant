// SPDX-License-Identifier: MIT
// Actual isolated command runtime plus host-owned browser: no owner workspace/accounts.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { BrowserContainer } from '../server/browser-container.mjs';
import { pinnedBrowserRequest } from '../server/browser-requests.mjs';
import { executeTool } from '../server/agent.mjs';
import { trustedBrowserFixture } from './trusted-browser-fixture.mjs';
import { command } from '../shared/domain.mjs';
const exec = promisify(execFile),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const site = await trustedBrowserFixture();
const store = new Store(join(site.directory, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: site.directory });
const containerMode = process.argv.includes('--container');
const browserRuntime = containerMode ? new BrowserContainer(computer) : null;
const browser = new TrustedBrowser(store, {
  ...(browserRuntime ? { runtime: browserRuntime } : {}),
  enabled: true,
  key: randomBytes(32),
  channel: 'chrome',
  control: computer,
  resolver: site.resolver,
  transport: (input, options) => pinnedBrowserRequest(input, { ...options, ca: site.cert }),
});
const services = { computer, privateBrowser: browser };
const run = store.mutate((s) =>
  command(s, 'chat.send', { threadId: 'main', text: 'Work in my private notebook.' }),
);
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw Error('Expected isolation state was not reached');
}
const guest = async (command, actor = 'agent') => {
  const r = await computer.perform({ kind: 'exec', command, operationId: randomUUID() }, { actor });
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout;
};
const read = async (path) => Buffer.from((await computer.read(path)).base64, 'base64').toString();
async function ownerAction(input) {
  const r = await browser.begin({ ...input, operationId: randomUUID() }, 'owner');
  const done = await browser.waitForAction(r.id);
  assert.equal(done.phase, 'completed');
}
const target = (observation, name, role) => {
  const n = observation.content.find((n) => n.name === name && (!role || n.role === role));
  assert(n?.target, `Missing ${name}`);
  return n.target;
};
async function approveUntil(promise) {
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  for (let i = 0; !done && i < 300; i++) {
    for (const r of browser.requests.list().filter((r) => r.phase === 'pending'))
      await browser.decide(r.id, r.fingerprint, true);
    await delay(50);
  }
  return result;
}
const agentAction = (input, id = randomUUID()) =>
  executeTool(store, 'private_browser_action', input, {
    ...services,
    runId: run.id,
    threadId: run.threadId,
    operationId: id,
  });
try {
  await computer.start();
  const desktop = await computer.inspect(),
    runtime = await computer.runtime.inspect();
  assert.equal(desktop.HostConfig.NetworkMode, 'none');
  assert.equal(runtime.HostConfig.NetworkMode, `container:${desktop.Id}`);
  assert.equal(runtime.HostConfig.PidMode, '');
  for (const c of [desktop, runtime]) {
    assert.equal(c.HostConfig.Privileged, false);
    assert.equal(Object.values(c.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
    assert(
      c.Mounts.every(
        (m) => m.Type === 'volume' && [computer.volume, computer.displayVolume].includes(m.Name),
      ),
    );
  }
  const probe = `import os,time,signal
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open('/workspace/ticks.txt','ab',buffering=0) as f:
 while True:
  f.write(b'tick\\n');time.sleep(.04)
`;
  await computer.perform({
    kind: 'files',
    action: 'write',
    path: 'probe.py',
    base64: Buffer.from(probe).toString('base64'),
    operationId: randomUUID(),
  });
  await guest('python3 /workspace/probe.py >/tmp/probe.log 2>&1');
  await until(async () => (await read('ticks.txt')).length > 0);
  check(
    'Real Docker containers use isolated network/PID namespaces and only their two named volumes',
  );
  const pending = agentAction({ action: 'open', url: `${site.origin}/signin` }, 'pending-takeover');
  pending.catch(() => {});
  await until(() => browser.requests.list().some((r) => r.phase === 'pending'));
  if (browserRuntime) {
    const isolated = await browserRuntime.inspect();
    assert.equal(isolated.HostConfig.NetworkMode, 'none');
    assert.equal(isolated.Mounts.length, 0);
    assert.equal(isolated.HostConfig.ReadonlyRootfs, true);
    assert.equal(isolated.HostConfig.Memory, 1073741824);
    assert.equal(isolated.HostConfig.PidsLimit, 128);
    assert.equal(isolated.HostConfig.NanoCpus, 2000000000);
    assert.notEqual(isolated.Id, desktop.Id);
    assert.notEqual(isolated.Id, runtime.Id);
    const namespaces = await Promise.all(
      [isolated.Id, desktop.Id, runtime.Id].map((id) =>
        computer.checked([
          'exec',
          id,
          'readlink',
          '/proc/self/ns/pid',
          '/proc/self/ns/net',
          '/proc/self/ns/mnt',
        ]),
      ),
    );
    const privateNamespaces = namespaces[0].trim().split('\n');
    for (const peer of namespaces.slice(1))
      peer
        .trim()
        .split('\n')
        .forEach((value, index) => assert.notEqual(value, privateNamespaces[index]));

    check(
      'Private Chromium uses a separate read-only, mount-free, network-none container with explicit CPU, memory and process limits',
    );
  }
  const before = site.calls.length;
  await computer.takeControl();
  browser.syncControl();
  await assert.rejects(pending, /control|owner/i);
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  const frozen = await read('ticks.txt');
  await delay(200);
  assert.equal(await read('ticks.txt'), frozen);
  assert.equal(site.calls.length, before);
  await assert.rejects(executeTool(store, 'private_browser_look', {}, services), /control|owner/i);
  assert.equal(store.read().runs.find((r) => r.id === run.id).privateBrowserAction, undefined);
  check(
    'Real takeover freezes detached commands, cancels the pending browser request and rejects agent observations',
  );
  await ownerAction({ action: 'open', url: `${site.origin}/signin` });
  let page = await browser.observe('owner');
  await ownerAction({ action: 'type', target: target(page, 'Username'), text: 'fixture-owner' });
  page = await browser.observe('owner');
  await ownerAction({ action: 'type', target: target(page, 'Password'), text: site.password });
  page = await browser.observe('owner');
  await ownerAction({ action: 'click', target: target(page, 'Sign in', 'button') });
  assert(site.calls.find((r) => r.url === '/workspace').cookie.includes(site.session));
  assert.equal(await read('ticks.txt'), frozen);
  assert.equal((await computer.runtime.inspect()).State.Paused, true);
  const windows = await guest(
    'xdotool search --name "Private notebook" 2>/dev/null || true',
    'owner',
  );
  assert.equal(windows.trim(), '');
  const children = (await exec('pgrep', ['-P', String(process.pid)])).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const args = (await exec('ps', ['-p', children.join(','), '-o', 'command='])).stdout;
  assert(args.includes(containerMode ? 'pipe.mjs' : '--remote-debugging-pipe'));
  assert(!args.includes('--remote-debugging-port'));
  check(
    `Owner signs in through the ${containerMode ? 'separate container' : 'host'} browser while commands remain frozen; browser is absent from guest X and exposes no CDP TCP port`,
  );
  await computer.release();
  browser.syncControl();
  assert.equal((await computer.runtime.inspect()).State.Paused, false);
  await until(async () => (await read('ticks.txt')).length > frozen.length);
  const audit = await guest(`python3 - <<'PY'
from pathlib import Path
import socket
assert not Path(${JSON.stringify(site.directory)}).exists()
assert not Path('/Users').exists()
rows=Path('/proc/net/route').read_text().strip().splitlines()
assert len(rows)==1, rows
names=[]
for p in Path('/proc').glob('[0-9]*/comm'):
 try:names.append(p.read_text().strip())
 except OSError:pass
assert not any('chrome' in n.lower() or n=='Xvfb' for n in names)
for host in ['192.168.5.2','1.1.1.1']:
 try:
  s=socket.create_connection((host,443),timeout=.3)
 except OSError:pass
 else:
  s.close();raise AssertionError('Unexpected outbound path')
print('Guest has no host browser files, host processes or external route')
PY`);
  assert(audit.includes('no host browser files'));
  check(
    'Handback resumes the same command; guest probes cannot see the host browser/profile or reach external/VM-host TCP destinations',
  );
  const result = await approveUntil(
    agentAction({ action: 'open', url: `${site.origin}/workspace` }, 'open-signed-in'),
  );
  assert.equal(result.result.receipt.phase, 'completed');
  assert(!JSON.stringify(result).includes(site.password));
  assert(!JSON.stringify(result).includes(site.session));
  assert(!JSON.stringify(result).includes('server_supplied_private_value'));
  assert.equal(
    result.result.page.content.find((n) => n.name === 'Private field').target,
    undefined,
  );
  assert(
    site.calls.filter((r) => r.url === '/workspace').every((r) => r.cookie.includes(site.session)),
  );
  const value = await agentAction(
    {
      action: 'type',
      target: target(result.result.page, 'Note'),
      text: 'A note from the isolated runtime',
    },
    'type-note',
  );
  const input = { action: 'click', target: target(value.result.page, 'Save note', 'button') };
  const write = await approveUntil(agentAction(input, 'save-note'));
  assert.equal(write.result.receipt.phase, 'completed');
  await agentAction(input, 'save-note');
  assert.equal(site.calls.filter((r) => r.url === '/save').length, 1);
  check(
    'Reviewed assistant tools reuse the private sign-in through masked observations and save exactly once, including a repeated operation ID',
  );
  assert(!JSON.stringify(store.read()).includes(site.password));
  assert(!store.secret('trusted-browser-vault').includes(site.password));
  await computer.takeControl();
  await browser.clear();
  assert.equal(browser.vault.storage(), undefined);
  check(
    'Workspace exports omit browser secrets and explicit clear removes the saved private session',
  );

  if (browserRuntime) {
    const isolated = await browserRuntime.inspect();
    const proof = await computer.checked([
      'exec',
      isolated.Id,
      '/usr/bin/python3',
      '-c',
      `
from pathlib import Path
import socket,errno,os
assert not Path('/tmp/.X11-unix/X0').exists()
assert not Path('/workspace/ticks.txt').exists()
assert not Path(${JSON.stringify(site.directory)}).exists()
assert not Path('/var/run/docker.sock').exists()
assert len(Path('/proc/net/route').read_text().strip().splitlines())==1
assert not any(line.split()[1] != '0000000000000000:0000' and line.split()[3]=='0A' for line in Path('/proc/net/tcp').read_text().splitlines()[1:])
for host in ['192.168.5.2','1.1.1.1','169.254.169.254']:
 for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
  connection=socket.socket(socket.AF_INET,kind);connection.settimeout(.3)
  try:
   connection.connect((host,443));connection.send(b'isolated-test')
  except OSError:pass
  else:raise AssertionError('Unexpected direct network route')
  finally:connection.close()
try:Path('/opt/relay/private-browser-escape').write_text('test')
except OSError as e:assert e.errno==errno.EROFS
else:raise AssertionError('Writable root')
written=0
try:
 with open('/tmp/quota-probe','wb',buffering=0) as f:
  while written<=268435456:written+=f.write(b'x'*1048576)
except OSError as e:assert e.errno==errno.ENOSPC
else:raise AssertionError('Unbounded writable storage')
finally:Path('/tmp/quota-probe').unlink(missing_ok=True)
assert written < 268435456
print('Browser guest: no host/workspace/display/socket, no TCP/UDP route, read-only root, bounded tmpfs')
`,
    ]);
    assert(proof.includes('bounded tmpfs'));
    check(
      'Actual private-browser process cannot reach public, VM-host or metadata addresses over TCP/UDP and cannot see agent files/display or host files/socket',
    );
    check('Read-only root and tmpfs capacity are enforced by the real kernel');
    await browser.close();
    const gone = await computer.dockerRun(['inspect', isolated.Id]);
    assert.notEqual(gone.exitCode, 0);
    assert.equal((await computer.inspect()).Id, desktop.Id);
    assert((await read('ticks.txt')).length > 0);
    check(
      'Closing the private browser removes only its container and preserves the desktop and agent files',
    );
  }
  await writeFile(
    join(
      evidence,
      containerMode
        ? 'browser-container-runtime-acceptance.json'
        : 'private-browser-real-runtime-acceptance.json',
    ),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        checks,
        passed: true,
        scope: containerMode
          ? 'Actual separate Chromium container, Docker/Colima freezer, PID/network/mount/resource boundaries and production assistant tools; independent local HTTPS service'
          : 'Actual Docker/Colima command freezer, PID/network/mount boundaries composed with host Chromium and production assistant tools; independent local HTTPS service',
        desktopImage: desktop.Image,
        limitations: [
          containerMode
            ? 'Bounded containment checks, not a proof against arbitrary browser/kernel/runtime exploits; Chromium nested sandbox is disabled inside the restricted container'
            : 'Not an OS-level proof of host Chromium egress or resistance to arbitrary browser/host exploits',
          'Known-value masking is not general taint or secret detection',
          'Fixture account and locally authorized exact requests; no hosted provider/account acceptance',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
  await computer
    .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
    .catch(() => {});
  store.close();
  await site.close();
}
