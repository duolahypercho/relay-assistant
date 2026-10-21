// SPDX-License-Identifier: MIT
// Real public HTTPS + real Docker. No credentials, account login or external writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
const dir = await mkdtemp(join(tmpdir(), 'relay-computer-web-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(dir, 'state.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, web: true, deployment: dir });
const checks = [];
const check = (label) => {
  checks.push(label);
  console.log(`PASS ${label}`);
};
let id = 0;
const run = (command) =>
  computer.perform({ kind: 'exec', command, operationId: `web-${++id}`, seconds: 25 });
const fetchExample = `python3 - <<'PY'
import urllib.request
r=urllib.request.urlopen('https://example.com',timeout=15)
b=r.read()
assert b'Example Domain' in b
open('/workspace/public-example.html','wb').write(b)
print(r.status, len(b))
PY`;
try {
  await computer.start();
  assert.equal((await computer.status()).web.connected, true);
  check('Real guest loopback proxy connects through Docker stdin without a network interface');
  assert.equal((await computer.inspect()).HostConfig.NetworkMode, 'none');
  const direct = await run(
    `python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1',443))"`,
  );
  assert.notEqual(direct.exitCode, 0);
  check('Guest cannot bypass the broker with a direct internet socket');
  const blocked = await run(fetchExample);
  assert.notEqual(blocked.exitCode, 0);
  assert.equal(computer.network.sites().length, 0);
  await computer.requestWebsite('https://example.com', 'Read the requested public example.');
  assert.equal(computer.network.sites().find((s) => s.host === 'example.com').status, 'pending');
  check(
    'Unapproved traffic stays blocked quietly; an explicit website request creates its decision',
  );
  for (const url of [
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://10.0.0.1/',
    'http://localhost/',
  ])
    await assert.rejects(computer.requestWebsite(url), /Private|reserved/);
  check('Loopback, private LAN and metadata destinations cannot be approved');
  await computer.decideWebsite('example.com', 'allow');
  const fetched = await run(fetchExample);
  assert.equal(fetched.exitCode, 0, fetched.stderr);
  assert.match(fetched.stdout, /200/);
  assert.ok((await computer.read('public-example.html')).size > 500);
  check('Approved public HTTPS validates its certificate and downloads real page bytes');
  await computer.openWebsite('https://example.com');
  let shot;
  for (let n = 0; n < 30; n++) {
    shot = await computer.screenshot();
    if (shot.title.includes('Example Domain')) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.match(shot.title, /Example Domain/);
  await writeFile(join(evidence, 'computer-web-guest.jpg'), Buffer.from(shot.screenshot, 'base64'));
  check('Real desktop Chromium displays the public HTTPS website');
  await computer.decideWebsite('example.com', 'revoke');
  assert.equal(computer.network.allowed('example.com'), false);
  const revoked = await run(fetchExample);
  assert.notEqual(revoked.exitCode, 0);
  assert.equal(computer.network.sites().find((s) => s.host === 'example.com').status, 'revoked');
  check('Revocation blocks future requests and cannot be undone by the guest');
  await computer.decideWebsite('example.com', 'allow');
  await computer.stop();
  assert.equal(computer.network.allowed('example.com'), false);
  await computer.start();
  const afterRestart = await run(fetchExample);
  assert.notEqual(afterRestart.exitCode, 0);
  assert.ok((await computer.read('public-example.html')).size > 500);
  check('Stopping expires web permission while retaining downloaded files');
  await writeFile(
    join(evidence, 'computer-web-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime: 'Real Docker guest and real public example.com HTTPS',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} real web-computer checks passed.`);
} finally {
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.name]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  store.close();
  await rm(dir, { recursive: true, force: true });
}
