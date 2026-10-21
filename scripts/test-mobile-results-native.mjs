// SPDX-License-Identifier: MIT
// Real iPhone Files picker, exact saved bytes and offline interactive result preview.
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { artifactsFixture, artifactExamples } from './artifacts-fixture.mjs';
import { saveArtifact } from '../server/artifacts.mjs';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-mobile-results-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
let device, f, control;
const checks = [];
const exports = [];
let verified = false;
await mkdir(evidence, { recursive: true });
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Results Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Results Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await artifactsFixture(directory, 0, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  const titles = {
    document: 'Relay Native Document',
    spreadsheet: 'Relay Native Sheet',
    presentation: 'Relay Native Slides',
    web: 'Relay Native Page',
  };
  for (const [kind, example] of Object.entries(artifactExamples)) {
    const saved = await saveArtifact(f.store, {
      ...example,
      title: titles[kind],
      operationId: `native-result-${kind}`,
    });
    const file = f.store.read().files.find((file) => file.id === saved.fileId);
    exports.push({ kind, file, bytes: Buffer.from(file.base64, 'base64') });
  }
  f.store.mutate((s) => {
    s.messages = [
      {
        id: 'native-results',
        role: 'assistant',
        threadId: 'main',
        text: 'Your results are ready to open and keep.',
        createdAt: new Date().toISOString(),
        fileIds: [],
        cards: exports.map(({ file }) => ({ kind: 'file', id: file.id })),
      },
    ];
  });
  const baseline = structuredClone(f.store.read().messages);
  async function staged() {
    const root = (
      await exec('xcrun', ['simctl', 'get_app_container', device, 'org.relay.assistant', 'data'])
    ).stdout.trim();
    return (await readdir(join(root, 'tmp'))).filter((name) => name.startsWith('relay-export-'));
  }
  async function savedFiles() {
    const root = join(
      homedir(),
      'Library/Developer/CoreSimulator/Devices',
      device,
      'data/Containers/Shared/AppGroup',
    );
    const found = [];
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(join(path, entry.name));
        else if (entry.isFile() && exports.some((item) => item.file.name === entry.name))
          found.push(join(path, entry.name));
      }
    }
    await walk(root);
    return found;
  }
  control = createServer(async (req, res) => {
    try {
      assert.deepEqual(
        f.store.read().messages,
        baseline,
        'Saving and navigating must not post chat messages',
      );
      if (req.url === '/picker') {
        assert.equal((await staged()).length, 1);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'mobile-results-native-picker.png'),
        ]);
      } else if (req.url === '/cancelled') {
        assert.equal((await staged()).length, 0);
        assert.equal((await savedFiles()).length, 0);
        checks.push(
          'Native picker cancellation creates no file, success message or leftover staging',
        );
      } else if (req.url?.startsWith('/saved/')) {
        const kind = req.url.slice('/saved/'.length);
        const item = exports.find((item) => item.kind === kind);
        assert(item);
        assert.equal((await staged()).length, 0);
        const matches = (await savedFiles()).filter((path) => path.endsWith('/' + item.file.name));
        assert.equal(matches.length, 1, 'Exactly one exported native file');
        const bytes = await readFile(matches[0]);
        assert.deepEqual(bytes, item.bytes);
        checks.push({
          kind,
          name: item.file.name,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          exactNativeSave: true,
        });
      } else if (req.url === '/interrupted') {
        assert.equal((await staged()).length, 1);
      } else if (req.url === '/reopened') {
        assert.equal(
          (await staged()).length,
          0,
          'An abandoned picker must not leave temporary exports after app relaunch',
        );
        checks.push('Cold relaunch cleans abandoned export staging');
      } else if (req.url === '/verify') {
        assert.equal((await savedFiles()).length, 4);
        assert.equal((await staged()).length, 0);
        assert.equal(
          f.store.read().threads.find((t) => t.id === 'main').draft,
          'Keep my native result draft.',
        );
        assert.equal(f.store.read().files.length, 4);
        assert.equal(f.probes.length, 0);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'mobile-results-native-chat.png'),
        ]);
        checks.push(
          'Interactive preview tap, stop/restart and Back; original result and chat draft survive navigation and full relaunch',
        );
        verified = true;
      } else throw Error('Unknown acceptance check');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end(error.message);
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/mobile-results-native-${Date.now()}.xcresult`);
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testNativeResultFiles',
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
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  output.end();
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, `mobile-results-native-${Date.now()}-attachments`),
  ]);
  assert.equal(code, 0, `Native results test failed: ${log}`);
  assert(verified);
  await writeFile(
    join(evidence, 'mobile-results-native-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        log,
        checks,
        scope:
          'Actual iPhone Simulator Files picker, production save/preview plugin, exact generated Office/HTML bytes in native file-provider storage. Synthetic original artifacts; no physical-device, Android or live-model claim.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS native result exports and interactive preview');
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
