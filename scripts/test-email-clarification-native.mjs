// SPDX-License-Identifier: MIT
// Native iPhone keyboard and process lifecycle against an isolated HTTPS workspace.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { emailClarificationFixture } from './email-clarification-fixture.mjs';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-email-native-'));
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/native-email-clarification/ios',
);
await mkdir(evidence, { recursive: true });
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  surface: 'iPhone Simulator, native WebKit HTTPS',
  scope:
    'Controlled HTTP model; native keyboard, navigation and process termination. No physical device or actual-model reliability claim.',
  checkpoints: [],
};
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
      'Relay Email Clarification Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  report.device = device;
  f = await emailClarificationFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/start') f.start();
      else if (req.url === '/pending') f.pending();
      else if (req.url === '/verify') report.result = f.verify();
      else throw Error('Unknown checkpoint');
      report.checkpoints.push(req.url);
      res.end('ok');
    } catch (error) {
      report.checkpointError = error.stack;
      res.writeHead(500).end(error.message);
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now();
  report.resultBundle = resolve(`../../work/email-clarification-native-${stamp}.xcresult`);
  report.log = resolve(`../../work/email-clarification-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle: report.resultBundle, log: report.log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testEmailClarificationRecovery',
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      '-resultBundlePath',
      report.resultBundle,
      'CODE_SIGN_IDENTITY=-',
      `RELAY_CONNECTION_TEST_SERVER=${f.url}`,
      `RELAY_CONNECTION_TEST_CONTROL=http://127.0.0.1:${control.address().port}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = createWriteStream(report.log);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const code = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', done);
  });
  output.end();
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    report.resultBundle,
    '--output-path',
    join(evidence, 'attachments'),
  ]);
  assert.equal(code, 0, `Inspect ${report.log}`);
  assert.deepEqual(report.checkpoints, ['/start', '/pending', '/pending', '/verify', '/verify']);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.cleanupErrors = [];
  for (const [name, close] of [
    [
      'control',
      async () => {
        if (control) {
          control.closeAllConnections();
          await new Promise((r) => control.close(r));
        }
      },
    ],
    ['fixture', () => f?.close()],
    [
      'simulator',
      async () => {
        if (device) {
          await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
          await exec('xcrun', ['simctl', 'delete', device]);
        }
      },
    ],
    ['scratch', () => rm(directory, { recursive: true, force: true })],
  ]) {
    try {
      await close();
    } catch (error) {
      report.cleanupErrors.push({ name, error: error.message });
    }
  }
  report.cleanedUp = report.cleanupErrors.length === 0;
  if (!report.cleanedUp) {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence,
      error: report.error,
      cleanedUp: report.cleanedUp,
    }),
  );
}
