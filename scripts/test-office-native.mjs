// SPDX-License-Identifier: MIT
// Real iPhone WebKit and isolated HTTPS Office source/revision fixtures.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { officeFixture } from './office-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { readOffice } from '../server/office-files.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-office-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Office Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Office Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await officeFixture(directory, 0, {
    key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.pem')),
  });
  const originals = {};
  for (const [kind, source] of Object.entries(f.sources))
    originals[kind] = f.store.mutate((s) =>
      command(s, 'file.add', {
        name: source.name,
        mime: source.mimeType,
        base64: source.buffer.toString('base64'),
      }),
    );
  control = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/stage/')) {
        const kind = req.url.slice(7);
        assert.ok(originals[kind]);
        f.store.mutate((s) =>
          command(s, 'thread.update', { id: 'main', draftFileIds: [originals[kind].id] }),
        );
      } else {
        assert.equal(req.url, '/verify');
        assert.equal(f.requests.length, 9);
        assert.equal(f.readResults.length, 3);
        assert.deepEqual(f.errors, []);
        const state = f.store.read();
        assert.equal(state.messages.length, 6);
        assert.equal(state.threads.find((t) => t.id === 'main').draft, 'Keep my Office draft');
        for (const [kind, original] of Object.entries(originals)) {
          assert.equal(state.files.find((x) => x.id === original.id).base64, original.base64);
          const revised = state.files.find(
            (x) => x.artifactId && x.name.startsWith('Revised ' + kind),
          );
          assert.ok(revised);
          const content = await readOffice(revised);
          assert.match(content.text, /9/);
          if (kind === 'spreadsheet') assert.match(content.text, /saved result: 34/);
        }
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
  const bundle = resolve(`../../work/office-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testOfficePreviewsAndRevisions',
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
    join(evidence, 'office-native-attachments'),
  ]);
  await writeFile(
    join(evidence, 'office-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        bundle,
        log,
        checks: [
          'Native text previews for staged DOCX/XLSX/PPTX attachments open inside their existing file dialog.',
          'Nine actual HTTP model requests read original content, save revised Office files and produce three replies.',
          'Original bytes remain unchanged; revised workbook formula cache is 34.',
          'Separate result pages, chat draft and conversation survive native relaunch.',
        ],
        limits: [
          'iPhone Simulator on iOS 26.5, not physical phones or Android.',
          'Sources are staged by the isolated fixture, not selected through an OS file picker. Controlled HTTP provider, not live model judgment.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native iPhone Office previews, real read/revise tool loop and preserved originals/draft',
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
