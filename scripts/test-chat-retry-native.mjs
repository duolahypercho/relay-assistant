// SPDX-License-Identifier: MIT
// Native WebKit retry test with controlled model transport and real saved tools.
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chatRetryFixture } from './chat-retry-fixture.mjs';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-chat-retry-'));
const evidence = resolve('../relay-evidence');
let device, f, control;
const checks = [];
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Retry Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Retry Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await chatRetryFixture(directory, {
    accessKey: 'retry-native-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/credential') return res.end('retry-native-owner-key-24-characters');
      if (req.url === '/ready') {
        const state = f.store.read();
        assert.equal(state.runs[0].status, 'failed');
        assert.equal(state.runs[0].retryable, true);
        assert.equal(state.files.length, 1);
        f.controls.fail = false;
        f.controls.hold = true;
        checks.push('Original failed request and saved file survive native relaunch');
      } else if (req.url === '/release') {
        assert.equal(f.store.read().runs[0].retryCount, 1);
        assert.equal(f.requests.length, 3);
        assert(f.controls.release);
        f.controls.release();
      } else if (req.url === '/capture') {
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'chat-retry-native.png'),
        ]);
      } else if (req.url === '/verify') {
        const state = f.store.read();
        assert.equal(state.runs[0].status, 'completed');
        assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
        assert.equal(state.files.length, 1);
        assert.equal(state.threads[0].draft, 'Keep my next thought');
        assert.equal(f.requests.length, 3);
        checks.push(
          'One native retry tap resumes after the saved tool; draft retained, no duplicated request or file',
        );
      }
      res.end('ok');
    } catch (e) {
      res.statusCode = 500;
      res.end(e.message);
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/chat-retry-native-${Date.now()}.xcresult`);
  const log = bundle.replace('.xcresult', '.log');
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testChatRetry',
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
  assert.equal(code, 0, `Native test failed: ${log}`);
  assert.equal(checks.length, 2);
  await writeFile(
    join(evidence, 'chat-retry-native.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        resultBundle: bundle,
        log,
        checks,
        scope:
          'Native iPhone Simulator WebKit tap, relaunch and separate-page navigation. Controlled HTTP failure; real agent, note tool and SQLite. Physical devices and Android remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
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
