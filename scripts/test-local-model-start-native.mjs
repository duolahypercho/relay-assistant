// Real installed Ollama startup, native iPhone inference and immediate-close recovery.
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
import { localModelStartFixture } from './local-model-start-fixture.mjs';
const modelsDirectory = process.env.RELAY_LOCAL_MODEL_TEST_MODELS;
const isolatedPort = process.env.RELAY_LOCAL_MODEL_TEST_PORT
  ? Number(process.env.RELAY_LOCAL_MODEL_TEST_PORT)
  : undefined;
assert(modelsDirectory, 'Set RELAY_LOCAL_MODEL_TEST_MODELS to the isolated qwen3.5:4b cache.');
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
      'Relay Local Model Startup Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await localModelStartFixture(directory, {
    modelsDirectory,
    isolatedPort,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/before') {
        assert.equal(f.provider.configured, false);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal((await f.runtime.status()).running, false);
      } else if (req.url === '/started') {
        const status = await f.runtime.status();
        assert.equal(status.managed, true);
        assert.equal(status.startWithRelay, true);
        assert.equal(f.provider.configured, false);
        assert.equal(f.store.read().messages.length, 0);
      } else if (req.url === '/verify') {
        const deadline = Date.now() + 10000;
        while (
          f.store.read().threads.find((t) => t.id === 'main').draft !==
            'Keep my final native startup draft' &&
          Date.now() < deadline
        )
          await delay(50);
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep my final native startup draft',
        );
        assert.equal(f.provider.current.model, 'qwen3.5:4b');
        assert.equal(f.provider.current.baseUrl, 'http://127.0.0.1:11434/v1');
        assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
        assert.match(
          f.store.read().messages.findLast((m) => m.role === 'assistant').text,
          /Ready for today/,
        );
        assert.equal((await f.runtime.status()).managed, true);
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
    bundle = resolve(`../../work/local-model-start-native-${stamp}.xcresult`),
    log = resolve(`../../work/local-model-start-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testLocalModelStartupAndConversation',
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
  await writeFile(
    join(evidence, 'local-model-start-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        isolatedModelPort: isolatedPort ?? null,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'Native iPhone WebKit loads the real protected HTTPS workspace',
          'Explicit installed Ollama startup from the phone, without shell commands or account/key entry',
          'No model selection or setup chat messages until explicit activation',
          'Real qwen3.5:4b local inference through the assistant worker',
          'Native keyboard draft and conversation survive full app relaunch',
        ],
        limits:
          'iPhone Simulator with real installed Ollama and qwen3.5:4b on its Relay Mac. When isolatedModelPort is set, only test transport destinations and the test process listen address are relocated from 11434. Physical devices and Android runtime remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native Ollama startup, real model conversation and relaunch');
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
