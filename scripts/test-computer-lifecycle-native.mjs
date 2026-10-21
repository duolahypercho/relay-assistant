// SPDX-License-Identifier: MIT
// Native iPhone computer setup, update and recovery against a real isolated Docker desktop.
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
import { setupProcess } from '../server/computer-setup.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-computer-lifecycle-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Computer Lifecycle Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Computer Lifecycle Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await maintenanceFixture(directory, {
    fresh: true,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  f.setup.runner = async (_binary, _args, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  let originalId, oldImage, updatedId;
  const readSaved = async () =>
    Buffer.from((await f.computer.read('native-lifecycle.txt')).base64, 'base64').toString();
  const draft = 'Keep my iPhone computer lifecycle draft';
  const checks = [];
  control = createServer(async (req, res) => {
    try {
      const state = f.store.read();
      assert.equal(state.messages.length, 0);
      assert.equal(state.threads.find((t) => t.id === 'main').draft, draft);
      if (req.url === '/cancelled') {
        assert.equal(f.setup.status().phase, 'cancelled');
        assert.equal(f.computer.enabled, false);
        f.setup.runner = setupProcess;
        checks.push(
          'Native setup can run while leaving/reopening the page and can be cancelled without changing chat history or draft',
        );
      } else if (req.url === '/saved') {
        assert.equal(f.setup.status().phase, 'ready');
        assert.equal(f.computer.controller, 'owner');
        assert.equal(await readSaved(), 'Native lifecycle kept me');
        originalId = (await f.computer.inspect()).Id;
        oldImage = f.computer.image;
        // Simulate installing a Relay version with newer bundled workspace sources.
        f.setup.root = resolve('.');
        checks.push(
          'Actual native setup, desktop start, owner takeover and command-created file work against a real Docker engine',
        );
      } else if (req.url === '/reviewed') {
        assert.equal((await f.computer.inspect()).Id, originalId);
        assert.equal(f.computer.image, oldImage);
        assert.equal(f.computer.controller, 'agent');
        assert.equal(f.maintenance.status().phase, 'review');
        checks.push('Update preparation and review preserve the running original desktop');
      } else if (req.url === '/dismissed') {
        assert.equal((await f.computer.inspect()).Id, originalId);
        assert.equal(f.maintenance.status().phase, 'idle');
      } else if (req.url === '/updated' || req.url === '/reopened') {
        assert.equal(f.computer.controller, 'owner');
        assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
        assert.equal(await readSaved(), 'Native lifecycle kept me');
        assert.notEqual(f.computer.image, oldImage);
        const id = (await f.computer.inspect()).Id;
        assert.notEqual(id, originalId);
        if (req.url === '/updated') {
          updatedId = id;
          checks.push(
            'Native inline review applies a new image, preserves file bytes, and leaves command execution frozen for the owner',
          );
        } else {
          assert.equal(id, updatedId);
          checks.push(
            'Full native app relaunch preserves updated computer identity, file, owner freeze and chat draft',
          );
        }
      } else if (req.url === '/break-display') {
        await f.computer.checked([
          'exec',
          f.computer.name,
          'python3',
          '-c',
          'import pathlib,os,signal; [os.kill(int(p.name),signal.SIGSTOP) for p in pathlib.Path("/proc").iterdir() if p.name.isdigit() and (p/"comm").exists() and (p/"comm").read_text().strip()=="Xvfb"]',
        ]);
      } else if (req.url === '/recovered') {
        assert.equal(f.computer.controller, 'owner');
        assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
        assert.notEqual((await f.computer.inspect()).Id, updatedId);
        assert.equal(await readSaved(), 'Native lifecycle kept me');
        assert.equal(f.maintenance.status().phase, 'done');
        checks.push(
          'Native error-state recovery replaces an actually frozen guest display while preserving file bytes and paused owner control',
        );
      } else {
        assert.equal(req.url, '/verify');
        assert.equal(f.computer.controller, 'agent');
        assert.equal((await f.computer.runtime.inspect()).State.Paused, false);
        assert.equal(await readSaved(), 'Native lifecycle kept me');
        verified = true;
        checks.push(
          'Explicit native handback and return to chat preserve the draft and create no messages',
        );
      }
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/computer-lifecycle-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testComputerSetupUpdateAndRecovery',
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
    join(evidence, 'computer-lifecycle-native-attachments'),
  ]);
  await writeFile(
    join(evidence, 'computer-lifecycle-native-ios-acceptance.json'),
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
          'Real Docker/Colima runtime was already installed and running. The first cancellation uses a controlled wait; successful setup/update/recovery run actual container operations.',
          'The native client connects to an isolated HTTPS backend; this does not verify a live model, cloud hosting, snapshots, OS/VM repair or website sign-ins.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native iPhone computer setup, reviewed update, relaunch, frozen-display recovery and preserved draft',
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
