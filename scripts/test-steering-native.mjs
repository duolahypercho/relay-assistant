// Native iPhone follow-up journey with an independent HTTP model.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { steeringFixture, correction, correctedReply, queuedReply } from './steering-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { setTimeout as delay } from 'node:timers/promises';
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
      'Relay Follow-up Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await steeringFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  const file = f.store.mutate((state) =>
    command(state, 'file.add', {
      name: 'garden-notes.txt',
      mime: 'text/plain',
      text: 'Meet at the garden at 10. Bring water.',
    }),
  );
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await delay(50);
    }
    throw Error('Expected follow-up state was not reached');
  }
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/waiting') await until(() => f.firstWaiting);
      else if (req.url === '/steered') {
        await until(() => f.correctedWaiting);
        const state = f.store.read();
        assert.equal(state.runs.length, 1);
        assert.equal(state.runs[0].steeringApplied, 1);
        assert.deepEqual(state.messages.find((m) => m.text === correction).fileIds, [file.id]);
      } else if (req.url === '/queued') {
        assert.equal(f.store.read().runs.filter((r) => r.status === 'queued').length, 1);
        f.release();
      } else if (req.url === '/verify') {
        const state = f.store.read();
        assert.equal(state.threads[0].draft, 'Keep my native follow-up draft');
        assert.equal(state.runs.length, 2);
        assert(state.runs.every((r) => r.status === 'completed'));
        assert.equal(state.messages.length, 5);
        assert.equal(state.memories.length, 0);
        assert(state.messages.some((m) => m.text === correctedReply));
        assert(state.messages.some((m) => m.text === queuedReply));
        assert.equal(f.requests.length, 4);
        verified = true;
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Follow-up acceptance failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(`../../work/steering-native-${stamp}.xcresult`),
    log = resolve(`../../work/steering-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testRedirectCurrentRequest',
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
  assert.equal(code, 0, `Inspect native follow-up acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'steering-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'real iPhone WKWebView HTTPS sign-in and native keyboard',
          'follow-up sent during a pending HTTP model response',
          'saved file added to the existing draft and consumed by the model tool',
          'one active run; obsolete response and tool plan discarded',
          'explicit Queue follow-up runs afterward',
          'draft and five-message history survive navigation and full relaunch',
        ],
        limits:
          'Controlled HTTP model behavior. Does not certify live reasoning quality, physical devices or Android.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native follow-up, attachment, queue, navigation and relaunch');
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
