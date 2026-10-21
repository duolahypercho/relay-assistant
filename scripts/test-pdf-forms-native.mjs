// SPDX-License-Identifier: MIT
// Native WebKit PDF completion through chat with the real agent and file tools.
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { pdfFormsFixture } from './pdf-forms-fixture.mjs';
import { PDFDocument } from 'pdf-lib';
import { pdfFieldValue } from '../shared/pdf.mjs';
import { pdfFormValues } from './pdf-form-document.mjs';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-pdf-forms-'));
const evidence = resolve('../relay-evidence');
let device, f, control;
const checks = [];
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Form Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Form Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await pdfFormsFixture(directory, {
    accessKey: 'form-native-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/credential') return res.end('form-native-owner-key-24-characters');
      if (req.url === '/prompt')
        return res.end(
          'Fill the attached Saturday form for Jamie Example, contact 555-0100. Travel by Train, bring a packed lunch, choose Apple for snack and Book and Water for supplies. Put these notes on two lines: Meet by the river. Then: Leave the afternoon open. Keep the existing reference. Save a filled copy here.',
        );
      if (req.url === '/ready') {
        const state = f.store.read();
        assert.equal(state.runs[0].status, 'completed');
        assert.equal(state.files.length, 2);
        assert.equal(state.tasks.length, 0);
        assert.equal(state.approvals.length, 0);
        assert.deepEqual(f.errors, []);
        assert.equal(
          state.files.find((file) => file.id === f.file.id).base64,
          f.bytes.toString('base64'),
        );
        const filled = state.files.find((file) => file.id !== f.file.id);
        const bytes = Buffer.from(filled.base64, 'base64');
        const pdf = await PDFDocument.load(bytes);
        for (const field of pdfFormValues)
          assert.deepEqual(
            pdfFieldValue(pdf.getForm().getField(field.name)),
            Array.isArray(field.value) || field.name !== 'snack' ? field.value : [field.value],
          );
        assert.equal(pdf.getForm().getTextField('reference').getText(), 'SOURCE-KEEP-42');
        await writeFile(join(evidence, 'pdf-forms-native.pdf'), bytes);
        checks.push(
          'Native chat fills all field types, preserves source and unmentioned fields, without another task or form',
        );
      } else if (req.url === '/capture1' || req.url === '/capture2') {
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, `pdf-forms-native-${req.url.slice(-1)}.png`),
        ]);
      } else if (req.url === '/verify') {
        const state = f.store.read();
        assert.equal(state.messages.length, 2);
        assert.equal(state.files.length, 2);
        assert.equal(state.threads[0].draft, 'Keep my next thought');
        checks.push(
          'Both PDF pages render in native WebKit; separate-page navigation and full relaunch preserve draft and history',
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
  const bundle = resolve(`../../work/pdf-forms-native-${Date.now()}.xcresult`);
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testPdfFormCompletion',
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
    join(evidence, 'pdf-forms-native.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        resultBundle: bundle,
        log,
        checks,
        scope:
          'Native iPhone Simulator WebKit chat, PDF page controls, relaunch and separate-page navigation. Controlled HTTP model; real agent, PDF worker and SQLite. Physical devices and Android remain unverified.',
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
