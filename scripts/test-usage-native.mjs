// SPDX-License-Identifier: MIT
// Real bundled iPhone WebKit, HTTPS Relay server and controlled model counters.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-usage-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Usage Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Usage Acceptance',
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
    usage: () => ({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    respond: async (body) =>
      body.messages.some((m) => m.role === 'tool')
        ? { role: 'assistant', content: 'Your file list is ready.' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'native-usage-list',
                type: 'function',
                function: { name: 'list_files', arguments: '{}' },
              },
            ],
          },
  });
  control = createServer((req, res) => {
    try {
      assert.equal(req.url, '/verify');
      assert.equal(f.requests.length, 2);
      assert.equal(f.store.read().messages.length, 2);
      assert.equal(
        f.store.read().threads.find((t) => t.id === 'main').draft,
        'Keep my usage draft',
      );
      const s = f.provider.usage.summary();
      assert.equal(s.totals.requests, 2);
      assert.equal(s.totals.completed, 2);
      assert.equal(s.totals.totalTokens, 240);
      verified = true;
      res.end('ok');
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/usage-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testUsageKeepsConversationAndDraft',
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
    join(evidence, 'usage-native-attachments'),
  ]);
  await writeFile(
    join(evidence, 'usage-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        bundle,
        log,
        checks: [
          'Native chat makes two real HTTP model/tool-round-trip calls and displays 240 reported tokens.',
          'Search opens dedicated Usage; returning and full relaunch retain the draft, counts and exactly two chat messages.',
        ],
        limits: [
          'iPhone Simulator on iOS 26.5, not physical phones or Android.',
          'Controlled provider-reported token fixtures, not a live provider invoice or account allowance.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native iPhone usage, real worker totals, separate navigation and retained draft after relaunch',
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
