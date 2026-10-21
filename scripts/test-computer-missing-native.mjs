// SPDX-License-Identifier: MIT
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { deviceLinksFixture } from './device-links-fixture.mjs';
import { recoveryComputer } from './computer-recovery-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-computer-recovery-ios-'));
const evidence = resolve('../relay-evidence/computer-missing-workspace');
await mkdir(evidence, { recursive: true });
let f,
  r,
  device,
  control,
  verified = false;
const checks = [];
try {
  f = await deviceLinksFixture(directory, {
    configure: async (store, services) => {
      r = await recoveryComputer(store, services, directory);
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/lose') {
        await r.loseWorkspace();
      } else if (req.url === '/cancelled') {
        assert.equal((await r.computer.status()).state, 'missing');
        assert.equal(r.snapshots.review, null);
      } else if (req.url === '/restored') {
        const saved = await r.owner({ kind: 'files', action: 'read', path: 'recovery.txt' });
        assert.equal(Buffer.from(saved.base64, 'base64').toString(), 'My original saved work.');
      } else if (req.url === '/fresh') {
        const files = await r.owner({ kind: 'files', action: 'list', path: '.' });
        assert(!files.entries.some((e) => e.name === 'recovery.txt'));
        assert.equal(r.snapshots.points().length, 1);
      } else if (req.url === '/verify') {
        assert.equal(r.computer.controller, 'owner');
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.requests.length, 0);
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep my computer recovery thought',
        );
      } else if (req.url === '/chat') {
        assert.equal(r.computer.controller, 'agent');
        assert.equal((await r.computer.status()).state, 'missing');
        assert.equal(await r.snapshots.volumeExists(r.computer.volume), false);
        assert.equal(f.store.read().messages.length, 2);
        assert.equal(f.requests.length, 1);
        verified = true;
      } else throw Error('Unexpected fixture request');
      checks.push(req.url);
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture assertion failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Missing Computer Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 240000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', f.caPath]);
  const bundle = resolve(`../../work/computer-missing-ios-${Date.now()}.xcresult`),
    log = bundle.replace('.xcresult', '.log');
  console.log(JSON.stringify({ device, bundle, log }));
  const output = createWriteStream(log),
    child = spawn(
      'xcodebuild',
      [
        'test',
        '-project',
        'native/mobile/ios/App/App.xcodeproj',
        '-scheme',
        'ConnectionAcceptance',
        '-only-testing:RelayShareUITests/ConnectionUITests/testMissingComputerRecovery',
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
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, `See ${log}`);
  assert(verified);
  const attachments = join(evidence, `ios-attachments-${Date.now()}`);
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    attachments,
  ]);
  await writeFile(
    join(evidence, 'ios.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        attachments,
        checks,
        limits:
          'iPhone Simulator with a dedicated real Docker guest; no physical phones or native Android.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((resolve) => control.close(resolve));
  }
  await r?.close();
  await f?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
