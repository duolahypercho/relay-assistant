// SPDX-License-Identifier: MIT
// Native iPhone restore-point lifecycle against a real isolated Docker desktop.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-computer-snapshots-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Computer Restore Points Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Computer Restore Points Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await maintenanceFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  let originalId, originalVolume, restoredId, restoredVolume;
  const readSaved = async (path = 'native-restore.txt') =>
    Buffer.from((await f.computer.read(path)).base64, 'base64').toString();
  const draft = 'Keep my iPhone restore draft';
  const checks = [];
  control = createServer(async (req, res) => {
    try {
      const state = f.store.read();
      assert.equal(state.messages.length, 0);
      assert.equal(state.threads.find((t) => t.id === 'main').draft, draft);
      const points = f.snapshots.points();
      if (req.url === '/verify') {
        assert.equal(f.computer.controller, 'agent');
        assert.equal((await f.computer.runtime.inspect()).State.Paused, false);
        assert.equal(await readSaved(), 'iPhone later');
        assert.equal(points.length, 2);
        verified = true;
        checks.push(
          'Explicit native handback unfreezes command execution and returns to the unchanged main-chat draft with no new messages.',
        );
      } else {
        assert.equal(f.computer.controller, 'owner');
        assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
        assert.equal((await f.computer.inspect()).State.Paused, false);
        if (req.url === '/saved') {
          assert.equal(points.length, 1);
          assert.equal(f.snapshots.phase, 'done');
          assert.equal(await readSaved(), 'iPhone before');
          originalId = (await f.computer.inspect()).Id;
          originalVolume = f.computer.volume;
          checks.push(
            'Native keyboard command creates a real file and Save restore point captures it while preserving the available desktop under owner control.',
          );
        } else if (['/reviewed', '/dismissed', '/review-reopened'].includes(req.url)) {
          assert.equal((await f.computer.inspect()).Id, originalId);
          assert.equal(f.computer.volume, originalVolume);
          assert.equal(await readSaved(), 'iPhone later');
          assert.equal(await readSaved('later.txt'), 'later file');
          assert.equal(f.snapshots.phase, req.url === '/dismissed' ? 'idle' : 'review');
          assert.equal(points.length, 1);
          if (req.url === '/review-reopened')
            checks.push(
              'Native inline review, Not now, and full app relaunch preserve the original workspace and draft until the explicit restore action.',
            );
        } else if (['/restored', '/reopened'].includes(req.url)) {
          assert.equal(await readSaved(), 'iPhone before');
          await f.computer.checked([
            'exec',
            f.computer.name,
            'test',
            '!',
            '-e',
            '/workspace/later.txt',
          ]);
          assert.equal(points.length, 2);
          assert.notEqual(f.computer.volume, originalVolume);
          const before = f.store.db
            .prepare("SELECT * FROM computer_snapshots WHERE label='Before restore'")
            .get();
          assert.equal(before.volume, originalVolume);
          assert.equal(
            f.store.db.prepare('SELECT volume FROM computer_workspace').get().volume,
            f.computer.volume,
          );
          if (req.url === '/restored') {
            restoredVolume = f.computer.volume;
            restoredId = (await f.computer.inspect()).Id;
            assert.notEqual(restoredId, originalId);
            checks.push(
              'Native restore selects a new real volume/container, restores exact earlier bytes, removes later files, and retains the original workspace as an automatic before-restore point.',
            );
          } else {
            assert.equal(f.computer.volume, restoredVolume);
            assert.equal((await f.computer.inspect()).Id, restoredId);
            checks.push(
              'A second complete native relaunch retains the restored computer identity, saved points, file bytes, owner freeze and draft.',
            );
          }
        } else {
          assert.ok(['/undo', '/removal-dismissed', '/removed'].includes(req.url));
          assert.equal(await readSaved(), 'iPhone later');
          assert.equal(await readSaved('later.txt'), 'later file');
          assert.notEqual(f.computer.volume, restoredVolume);
          assert.equal(points.length, req.url === '/removed' ? 2 : 3);
          if (req.url === '/undo')
            checks.push(
              'Selecting the automatic before-restore point in native WebKit returns the exact later file bytes and later-only file.',
            );
          if (req.url === '/removed')
            checks.push(
              'Native removal review can be cancelled or explicitly applied; only the selected saved copy is removed.',
            );
        }
      }
      res.end('ok');
    } catch (error) {
      console.error(req.url, error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/computer-snapshots-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testComputerRestorePoints',
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
    join(evidence, 'computer-snapshots-native-attachments'),
  ]);
  await writeFile(
    join(evidence, 'computer-snapshots-native-ios-acceptance.json'),
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
          'Real Docker/Colima runtime was already installed and running; restore points use actual isolated workspace copies, containers and volume selection.',
          'The native client connects to an isolated HTTPS backend; this does not verify a live model, cloud hosting, lost-disk recovery, OS/VM repair or website sign-ins.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native iPhone restore points, review, relaunch, undo, removal and preserved draft',
  );
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
