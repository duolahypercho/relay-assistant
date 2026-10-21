// Real WebKit HTTPS, local-model selection, UIKit entry and immediate-close recovery.
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
import { localModelInstallFixture } from './local-model-install-fixture.mjs';
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
      'Relay Local Installation Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await localModelInstallFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    modelsDirectory: process.env.RELAY_LOCAL_MODEL_TEST_MODELS,
    isolatedPort: 41334,
    enableDownloads: true,
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/before') {
        assert.equal(f.delivery.requests, 0);
        assert.equal(f.provider.configured, false);
      } else if (req.url === '/cancelled') {
        assert.equal(f.installation.state.phase, 'cancelled');
        assert.equal(await f.installation.executable(), null);
        assert.equal(f.controls.starts, 0);
        f.delivery.mode = 'ready';
      } else if (req.url === '/installed') {
        assert.equal(f.installation.state.phase, 'ready');
        assert((await f.installation.executable()).startsWith(directory + '/runtimes/ollama/'));
        assert.equal(f.provider.configured, false);
        assert.equal(f.controls.starts, 0);
        assert.equal(f.store.read().messages.length, 0);
      } else if (req.url === '/connected') {
        assert.equal(f.provider.configured, true);
        assert.equal(f.store.read().messages.length, 0);
      } else if (req.url === '/answer') {
        const deadline = Date.now() + 150000;
        while (
          !f.store.read().runs.some((run) => ['completed', 'failed'].includes(run.status)) &&
          Date.now() < deadline
        )
          await delay(100);
        assert(f.store.read().runs.some((run) => run.status === 'completed'));
        const answer = f.store
          .read()
          .messages.find((message) => message.role === 'assistant')?.text;
        assert(answer?.trim().length > 0, 'Actual local inference must return text.');
        return res.end(answer);
      } else if (req.url === '/verify') {
        const deadline = Date.now() + 10000;
        while (
          f.store.read().threads.find((t) => t.id === 'main').draft !==
            'Keep my installed native draft' &&
          Date.now() < deadline
        )
          await delay(50);
        assert.equal(f.provider.publicState().connections.length, 1);
        assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
        assert(
          f.store
            .read()
            .messages.filter((m) => m.role === 'assistant')
            .some((m) => (m.content || m.text || '').trim().length > 0),
        );
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep my installed native draft',
        );
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'local-install-native-ios.png'),
        ]);
        verified = true;
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
    bundle = resolve(`../../work/local-install-native-${stamp}.xcresult`),
    log = resolve(`../../work/local-install-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testLocalModelInstallation',
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
  assert.equal(code, 0, `Inspect native model sign-in log: ${log}`);
  assert.equal(verified, true);
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, `local-install-native-${stamp}-attachments`),
  ]);
  await writeFile(
    join(evidence, 'local-install-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'Native iPhone WebKit loads the real protected HTTPS workspace',
          'Native install, progress restored after full app relaunch, explicit cancellation and retry',
          'Actual pinned Ollama archive extracted into private data, installed runtime started explicitly; no automatic activation or setup messages',
          'Real Qwen local inference, direct return to native draft, retained final draft after relaunch',
        ],
        limits:
          'iPhone Simulator with actual local runtime/inference and cached official archive delivery. Physical devices and Android runtime remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native local installation, cancellation, recovery and real inference');
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
