// Native photo paste, tools-free vision, follow-up and relaunch acceptance.
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
import { modelCapabilitiesFixture } from './model-capabilities-fixture.mjs';
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
      'Relay Direct Photos Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false,
    pastedImage;
  f = await modelCapabilitiesFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    singlePhoto: true,
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/paste-fixture') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        pastedImage = Buffer.concat(chunks);
        assert(pastedImage.length < 100000);
      } else if (req.url === '/before' || req.url === '/detected') {
        assert.equal(f.provider.configured, false);
        assert.equal(f.requests.length, 0);
      } else if (req.url === '/draft') {
        const deadline = Date.now() + 10000;
        while (
          !f.store.read().threads.find((t) => t.id === 'main').draftFileIds?.length &&
          Date.now() < deadline
        )
          await delay(50);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.store.read().threads.find((t) => t.id === 'main').draftFileIds.length, 1);
        assert.equal(f.store.read().files[0].base64, pastedImage.toString('base64'));
      } else if (req.url === '/followup') {
        const deadline = Date.now() + 20000;
        while (
          (f.requests.length !== 2 || f.store.read().runs.at(-1)?.status !== 'completed') &&
          Date.now() < deadline
        )
          await delay(50);
        assert.equal(f.requests.length, 2);
        assert.equal(f.store.read().runs.at(-1).status, 'completed');
      } else if (req.url === '/verify') {
        const deadline = Date.now() + 10000;
        while (
          f.store.read().threads.find((t) => t.id === 'main').draft !==
            'Keep my final native photo draft' &&
          Date.now() < deadline
        )
          await delay(50);
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep my final native photo draft',
        );
        assert.equal(f.provider.current.model, 'photo-chat');
        assert.equal(f.requests.length, 2);
        for (const r of f.requests) {
          assert.equal(r.tools, undefined);
          const images = r.messages
            .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
            .filter((p) => p.type === 'image_url');
          assert.equal(images.length, 1);
          assert.equal(
            images[0].image_url.url,
            'data:image/png;base64,' + pastedImage.toString('base64'),
          );
        }
        assert.equal(f.store.read().files.length, 1);
        assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 2);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'direct-photo-native-ios-chat.png'),
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
    bundle = resolve(`../../work/direct-photo-native-${stamp}.xcresult`),
    log = resolve(`../../work/direct-photo-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testDirectPhotoConversation',
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
    join(evidence, 'direct-photo-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'Native protected HTTPS workspace',
          'Automatic Chat & photos label before activation',
          'Real system Paste and exact PNG transport through the worker without tools',
          'Photo draft, follow-up image and native keyboard draft survive relaunch',
        ],
        limits:
          'iPhone Simulator with independent HTTP model fixture. Physical devices, Android and general model quality remain open.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native direct photo chat and follow-up');
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
