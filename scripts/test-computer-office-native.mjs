// SPDX-License-Identifier: MIT
// Native iPhone file/app controls and keyboard against the real isolated desktop.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { officeComputer } from './computer-office-fixture.mjs';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-office-ios-'));
const evidence = resolve('../relay-evidence/computer-office');
await mkdir(evidence, { recursive: true });
let device, f, office, control;
const checks = [],
  check = (s) => {
    checks.push(s);
    console.log('PASS', s);
  };
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error('Guest verification timed out');
}
const capture = (label) =>
  exec('xcrun', ['simctl', 'io', device, 'screenshot', join(evidence, `ios-${label}.png`)]);
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Office Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Office Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await assistantsFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    async configure(store, services) {
      office = await officeComputer(store, directory);
      services.computer = office.computer;
      services.computerSetup = office.setup;
    },
  });
  const { computer, owner } = office;
  const before = structuredClone(f.store.read().messages);
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/opened') {
        await until(async () => /Welcome.*Writer/.test((await computer.screenshot()).title));
        await owner({ kind: 'desktop', action: 'key', key: 'ctrl+End' });
        assert.equal((await computer.runtime.inspect()).State.Paused, true);
        check('Native Open launches the actual DOCX in Writer while agent commands remain frozen');
      } else if (req.url === '/typed') {
        await capture('before-copy');
        await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
        const copied = await computer.copyClipboard('copy');
        assert.match(copied.text, /Made on my iPhone\./);
        assert.match(copied.text, /Relay office acceptance document/);
        await owner({ kind: 'desktop', action: 'key', key: 'Right' });
        await capture('typed');
        check('Native soft keyboard edits the real office document without a separate Send step');
      } else if (req.url === '/slides') {
        await until(async () => /Impress/.test((await computer.screenshot()).title));
        await capture('slides');
        check('Native Slides opens a blank presentation directly without a template chooser');
      } else if (req.url === '/files') {
        await capture('files');
      } else if (req.url === '/verify') {
        assert.deepEqual(f.store.read().messages, before);
        assert.equal(f.requests.length, 0);
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep my office draft',
        );
        await capture('chat');
        check(
          'Native navigation and full app relaunch preserve the draft and add no chat messages',
        );
      } else throw Error('Unknown test check');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  }).listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/computer-office-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testOfficeComputerControls',
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
    child.once('error', reject);
    child.once('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, log);
  assert.equal(checks.length, 4);
  await writeFile(
    join(evidence, 'ios-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        resultBundle: bundle,
        log,
        checks,
        limits:
          'iPhone Simulator and actual isolated LibreOffice. Synthetic files, no real account or model calls; no physical-device or Android runtime acceptance.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (device) await capture('failure').catch(() => {});
  throw error;
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  if (office) {
    const c = office.computer;
    await c.stop().catch(() => {});
    await c.dockerRun(['rm', '-f', c.name, c.runtime.name]).catch(() => {});
    await c.dockerRun(['volume', 'rm', c.volume, c.displayVolume]).catch(() => {});
  }
  await f?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
