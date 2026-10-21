// Real WebKit HTTPS, private-VM sleep/wake, UIKit entry and relaunch recovery.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { setupProcess } from '../server/computer-setup.mjs';
import { computerInstallFixture } from './computer-install-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Isolated Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Computer Sleep Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  console.log(JSON.stringify({ step: 'simulator-boot', device }));
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 600000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await computerInstallFixture({
    accessKey: 'native-fixture-owner-key-24-characters',
    live: false,
    artifacts: resolve('../../work/engine-install-research/artifacts'),
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  f.delivery('ready');
  f.manager.start({});
  console.log('Provisioning native sleep acceptance VM');
  await f.manager.pending;
  assert.equal(f.manager.state.phase, 'ready', JSON.stringify(f.manager.state));
  console.log('Native acceptance VM ready');
  const vmState = async () =>
    JSON.parse(
      (await setupProcess(f.manager.colima, ['list', '--json'], { env: f.manager.env })).stdout,
    ).status;
  let asleepChecks = 0;
  control = createServer(async (req, res) => {
    try {
      assert.equal(f.store.read().messages.length, 0);
      assert.equal(
        f.store.read().threads.find((t) => t.id === 'main').draft,
        'Keep my native sleep draft',
      );
      if (req.url === '/asleep') {
        assert.equal(await vmState(), 'Stopped');
        assert.equal(f.setup.engineControl.phase, 'asleep');
        assert.equal(f.computer.controller, 'owner');
        asleepChecks++;
      } else if (req.url === '/before' || req.url === '/awake') {
        assert.equal(await vmState(), 'Running');
        assert.equal(f.computer.controller, 'owner');
        assert.equal(
          (
            await f.computer.checked([
              'exec',
              f.computer.name,
              'cat',
              '/workspace/native-sleep.txt',
            ])
          ).trim(),
          'Native private computer sleep works',
        );
        if (req.url === '/awake') {
          assert.equal(asleepChecks, 2);
          await exec('xcrun', [
            'simctl',
            'io',
            device,
            'screenshot',
            join(evidence, 'computer-sleep-native-ios.png'),
          ]);
          verified = true;
        }
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Acceptance check failed.');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(`../../work/computer-sleep-native-${stamp}.xcresult`),
    log = resolve(`../../work/computer-sleep-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testPrivateComputerSleep',
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
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, `Inspect native computer installation log: ${log}`);
  assert.equal(verified, true);
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, `computer-sleep-native-${stamp}-attachments`),
  ]);
  await writeFile(
    join(evidence, 'computer-sleep-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'Real native iPhone WebKit on protected HTTPS with owner authentication',
          'One Stop computer action reaches actual private VM Stopped and keeps owner control',
          'Native full relaunch leaves the real VM asleep until explicit Start computer',
          'Native keyboard-created file survives sleep/wake, with exact bytes, retained draft and unchanged history',
        ],
        limits:
          'iPhone Simulator controlling an Apple silicon Mac server; physical devices and Android runtime remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native private computer sleep/wake, guest file, native relaunch and recovery');
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
