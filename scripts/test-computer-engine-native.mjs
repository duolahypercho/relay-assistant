// SPDX-License-Identifier: MIT
// Native iPhone stopped-runtime recovery against real Colima and an isolated Docker desktop.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { engineFixture } from './computer-engine-fixture.mjs';
import { setupProcess } from '../server/computer-setup.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-computer-engine-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const profile = process.env.RELAY_ENGINE_TEST_PROFILE;
assert(profile && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile));
const host = `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`;
const configFile = join(homedir(), '.colima', profile, 'colima.yaml');
const config = await readFile(configFile);
const initialContext = (await setupProcess('docker', ['context', 'show'])).stdout.trim();
async function profileStatus() {
  const result = await setupProcess('colima', ['list', '--json']);
  assert.equal(result.exitCode, 0);
  return result.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.name === profile)?.status;
}
assert.equal(await profileStatus(), 'Stopped');

let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Computer Engine Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  await writeFile(
    join(directory, 'leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n',
  );
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '2',
    '-config',
    join(directory, 'ca.conf'),
    '-keyout',
    join(directory, 'ca.key'),
    '-out',
    join(directory, 'ca.pem'),
  ]);
  await exec('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(directory, 'server.key'),
    '-out',
    join(directory, 'server.csr'),
  ]);
  await exec('openssl', [
    'x509',
    '-req',
    '-in',
    join(directory, 'server.csr'),
    '-CA',
    join(directory, 'ca.pem'),
    '-CAkey',
    join(directory, 'ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    join(directory, 'leaf.ext'),
    '-out',
    join(directory, 'server.pem'),
  ]);
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Computer Engine Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await engineFixture(directory, {
    host,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  let originalId;
  const draft = 'Keep my iPhone runtime draft';
  const checks = [];
  control = createServer(async (req, res) => {
    try {
      // Allow the normal draft debounce to reach the server.
      for (
        let i = 0;
        i < 30 && f.store.read().threads.find((t) => t.id === 'main').draft !== draft;
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
      const state = f.store.read();
      assert.equal(state.messages.length, 0);
      assert.equal(state.threads.find((t) => t.id === 'main').draft, draft);
      assert.equal(f.computer.controller, 'owner');
      assert.equal(f.setup.engineControl.phase, 'ready');
      assert.equal(await profileStatus(), 'Running');
      assert.equal(
        Buffer.from((await f.computer.read('native-runtime.txt')).base64, 'base64').toString(),
        'My iPhone woke this computer',
      );
      assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
      const id = (await f.computer.inspect()).Id;
      if (req.url === '/saved') {
        originalId = id;
        checks.push(
          'Native start wakes actual stopped Colima and opens the private computer while preserving owner control',
        );
        checks.push('Native keyboard command creates independently verified exact file bytes');
      } else {
        assert.equal(req.url, '/verify');
        assert.equal(id, originalId);
        assert.deepEqual(await readFile(configFile), config);
        assert.equal(
          (await setupProcess('docker', ['context', 'show'])).stdout.trim(),
          initialContext,
        );
        verified = true;
        checks.push(
          'Full native app relaunch keeps desktop identity, owner freeze, file bytes, draft and empty chat history',
        );
        checks.push('Colima configuration and active Docker context unchanged');
      }
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/computer-engine-native-${Date.now()}.xcresult`),
    log = bundle.replace('.xcresult', '.log');
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testComputerRuntimeWake',
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      '-resultBundlePath',
      bundle,
      'CODE_SIGN_IDENTITY=-',
      `RELAY_CONNECTION_TEST_SERVER=${f.url}`,
      `RELAY_CONNECTION_TEST_CONTROL=http://127.0.0.1:${control.address().port}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = createWriteStream(log);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const code = await new Promise((r, j) => {
    child.once('error', j);
    child.once('exit', r);
  });
  output.end();
  assert.equal(code, 0, `See ${log}`);
  assert.ok(verified);
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, 'computer-engine-native-attachments'),
  ]);
  await writeFile(
    join(evidence, 'computer-engine-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        bundle,
        log,
        checks,
        limits: [
          'iPhone Simulator on iOS 26.5; not physical phones or Android.',
          'An existing installed Colima profile starts stopped. Native UI starts the actual runtime and desktop. No runtime installation or profile creation is covered.',
          'The native client connects to an isolated HTTPS backend; this does not verify a live model, cloud hosting, snapshots, OS/VM repair or website sign-ins.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native iPhone runtime wake, actual computer, owner control, file and draft preserved across relaunch',
  );
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  if ((await profileStatus()) === 'Running')
    assert.equal(
      (await setupProcess('colima', ['stop', '--profile', profile], { timeout: 120000 })).exitCode,
      0,
    );
  assert.equal(await profileStatus(), 'Stopped');
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
