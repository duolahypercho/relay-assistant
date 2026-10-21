// Native iPhone teaching from chat with real Docker and a controlled HTTP vision model.
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
import { teachingFixture } from './teaching-fixture.mjs';
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
      'Relay Teaching Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await teachingFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  f.setLabel('native-ios');
  await f.prepare();
  console.log(
    JSON.stringify({ fixtureComputer: f.computer.name, fixtureVolume: f.computer.volume }),
  );
  let sideId, pendingFileId;
  async function until(check, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > deadline) throw Error('Teaching test did not complete');
      await delay(100);
    }
  }
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/stage') {
        await until(() =>
          f.store
            .read()
            .threads.some((t) => t.id !== 'main' && t.draft === 'Keep my native teaching draft'),
        );
        f.store.mutate((state) => {
          sideId = state.threads.find(
            (t) => t.id !== 'main' && t.draft === 'Keep my native teaching draft',
          ).id;
          const file = command(state, 'file.add', {
            name: 'Unsent-native.txt',
            mime: 'text/plain',
            text: 'Private unfinished attachment.',
            base64: '',
          });
          pendingFileId = file.id;
          command(state, 'thread.update', { id: sideId, draftFileIds: [file.id] });
        });
      } else if (req.url === '/entry') {
        assert.equal(f.services.teaching.all().length, 0);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.store.read().runs.length, 0);
        assert.equal(f.modelRequests.length, 0);
      } else if (req.url === '/completed') {
        await until(() => f.store.read().runs.some((r) => r.status === 'completed'));
        const state = f.store.read(),
          session = f.services.teaching.all()[0];
        const run = state.runs.find((r) => r.id === session.testRunId);
        assert.equal(session.threadId, sideId);
        assert.equal(run.threadId, sideId);
        assert.equal(state.runs.length, 1);
        assert.equal(state.messages.filter((m) => m.threadId === 'main').length, 0);
        assert.deepEqual(state.messages.find((m) => m.id === run.messageId).fileIds, []);
        assert.deepEqual(state.threads.find((t) => t.id === sideId).draftFileIds, [pendingFileId]);
        const output = state.files.find((f) => f.name === 'test-native-ios.txt');
        assert.equal(Buffer.from(output.base64, 'base64').toString(), 'Note: Test native-ios\n');
      } else if (req.url === '/verify') {
        const state = f.store.read();
        assert.equal(
          state.threads.find((t) => t.id === sideId).draft,
          'Keep my native teaching draft',
        );
        assert.equal(state.threads.find((t) => t.id === 'main').draft, 'Keep my Main native draft');
        assert.equal(state.runs.length, 1);
        verified = true;
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Teaching acceptance failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(`../../work/teaching-entry-native-${stamp}.xcresult`),
    log = resolve(`../../work/teaching-entry-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testTeachTaskFromChat',
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
  assert.equal(code, 0, `Inspect native teaching acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'teaching-entry-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'real iPhone WKWebView HTTPS sign-in, keyboard and two-item composer menu',
          'teaching opens separately without recording, messages, runs or model calls',
          'real Docker demonstration, explicit screenshot capture and review',
          'controlled HTTP vision draft, save and real computer test output with exact bytes',
          'test returns to original side chat; both drafts and pending attachment remain',
          'navigation and relaunch preserve Main draft; no Main history pollution',
        ],
        limits:
          'Controlled HTTP model behavior. Does not certify live reasoning quality, physical devices or Android.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: native teaching entry, real Docker recording and replay, side-chat scope, drafts and relaunch',
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
