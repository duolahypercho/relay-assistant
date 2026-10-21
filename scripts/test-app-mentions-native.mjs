// SPDX-License-Identifier: MIT
// Actual iPhone WebKit app selection and reviewed MCP actions through isolated HTTPS fixtures.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { appMentionsFixture } from './app-mentions-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-app-mentions-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay App Selections Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay App Selections Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await appMentionsFixture(directory, {
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      const state = f.store.read();
      const main = state.threads.find((t) => t.id === 'main');
      if (req.url === '/before') {
        assert.equal(state.messages.length, 0);
        assert.equal(f.remote.calls.length, 0);
        assert.equal(f.requests.length, 0);
        assert.equal(main.draft, 'Read and save my Sunday plan.');
        assert.equal(main.draftApps[0].id, f.selected.id);
      } else {
        assert.equal(req.url, '/verify');
        assert.equal(f.requests.length, 5);
        assert.deepEqual(f.errors, []);
        assert.deepEqual(
          f.remote.calls.map((c) => c.name),
          ['find_note', 'save_note'],
        );
        assert.equal(f.remote.notes.length, 1);
        assert.equal(main.draft, 'Keep my next app draft');
        assert.equal(main.draftApps[0].id, f.other.id);
        assert.equal(state.messages.find((m) => m.role === 'user').appContext[0].id, f.selected.id);
        assert.equal(state.runs.filter((r) => r.connectorContext).length, 1);
        assert.equal(state.runs.find((r) => r.connectorContext).appContext[0].id, f.selected.id);
        verified = true;
      }
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/app-mentions-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testAppSelectionsAndReviewedAction',
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
  assert.equal(code, 0, `See ${log}`);
  assert.ok(verified);
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, 'app-mentions-native-attachments'),
  ]);
  await writeFile(
    join(evidence, 'app-mentions-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        bundle,
        log,
        checks: [
          'Native keyboard and app picker select a connected app without changing the written draft.',
          'Five actual HTTP model requests perform a scoped MCP read, reviewed write and one continuation.',
          'Exactly one MCP write; unselected apps are absent from the request.',
          'Selected apps and drafts persist across navigation and two native relaunches; the next draft does not change a pending review.',
        ],
        limits: [
          'iPhone Simulator on iOS 26.5, not physical phones or Android.',
          'Connected apps are configured by the isolated fixture. Picker/input/review are actual native WebKit interactions; controlled providers, not live model judgment.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native iPhone app selection, scoped MCP tools, exact review and retained drafts',
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
