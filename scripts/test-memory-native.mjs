// SPDX-License-Identifier: MIT
// Native WebKit memory control acceptance with focused model proposals and real SQLite.
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { memoryFixture } from './memory-fixture.mjs';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-memory-native-'));
const evidence = resolve('../relay-evidence');
const logs = join(evidence, 'memory-native-runs');
await mkdir(logs, { recursive: true });
let device, f, control;
const checks = [];
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Memory Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Memory Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 300000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await memoryFixture(directory, 0, {
    accessKey: 'memory-native-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  let originalId;
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/credential') return res.end('memory-native-owner-key-24-characters');
      const state = f.store.read(),
        note = state.memories[0];
      if (req.url === '/learned') {
        assert.equal(note.text, 'Prefers quiet hotels.');
        assert.equal(note.origin, 'learned');
        assert.equal(note.evidence, 'I prefer quiet hotels');
        originalId = note.id;
        assert.equal(f.reviews.length, 1);
        checks.push(
          'Native composer learns through the focused proposal pass with exact source evidence',
        );
      } else if (req.url === '/proposal') {
        assert.equal(note.id, originalId);
        assert.equal(note.text, 'Quiet hotels with gardens.');
        assert.equal(note.origin, 'manual');
        assert.equal(note.proposal.text, 'Prefers lively hotels.');
        checks.push(
          'Native source inspection and editing retain the draft; owner wording stays active during a proposed correction',
        );
      } else if (req.url === '/kept') {
        assert.equal(note.text, 'Quiet hotels with gardens.');
        assert.equal(note.proposal, undefined);
        checks.push('Keep mine discards the proposal without overwriting owner wording');
      } else if (req.url === '/accepted') {
        assert.equal(note.id, originalId);
        assert.equal(note.text, 'Prefers mountain hotels.');
        assert.equal(note.origin, 'manual');
        assert.equal(note.proposal, undefined);
        checks.push('A later Use update applies the exact newer candidate to the original note');
      } else if (req.url === '/off') {
        assert.equal(state.profile.memoryLearning, false);
        assert.equal(state.memories.length, 0);
        assert.equal(f.reviews.length, 3);
        checks.push(
          'Learning-off and forgetting survive full native relaunch; a fresh preference makes no inference or memory write',
        );
      } else if (req.url === '/manual') {
        assert.equal(note.text, 'Keep Fridays free.');
        assert.equal(note.origin, 'manual');
        assert.equal(state.profile.memoryLearning, false);
        checks.push(
          'A manual note remains available while learning is off and survives another full app relaunch',
        );
      } else if (req.url === '/verify') {
        assert.equal(state.memories.length, 0);
        assert.equal(state.messages.filter((m) => m.role === 'user').length, 4);
        assert.equal(state.threads[0].draft, 'Keep my trip draft');
        assert.equal(f.reviews.length, 3);
        checks.push(
          'Final forget leaves no note; draft retained, four deliberate user messages, no navigation history',
        );
      } else if (req.url === '/explicit') {
        assert.equal(state.memories.length, 1);
        assert.equal(note.text, 'Prefers quiet hotels.');
        assert.equal(note.origin, 'manual');
        assert.equal(note.evidence, 'I prefer quiet hotels');
        assert.equal(note.sourceMessageId, state.messages.findLast((m) => m.role === 'user').id);
        assert.equal(state.profile.memoryLearning, false);
        assert.equal(state.threads[0].draft, 'Keep my trip draft');
        assert.equal(f.reviews.length, 4);
        checks.push(
          'A direct remember request saves a source-linked manual note while learning stays off; note and draft survive native relaunch',
        );
      } else if (req.url === '/forgotten') {
        assert.equal(state.memories.length, 1);
        assert.equal(note.text, 'Keep Fridays free.');
        assert.equal(state.profile.memoryLearning, false);
        assert.equal(state.threads[0].draft, 'Keep my trip draft');
        assert.equal(f.reviews.length, 4);
        assert.equal(f.forgetReviews.length, 1);
        assert.equal(state.runs.at(-1).memoryForgetReceipt.status, 'forgotten');
        assert.equal(state.runs.at(-1).memoryForgetReceipt.ids.length, 1);
        assert.equal(state.messages.filter((m) => m.role === 'user').length, 6);
        checks.push(
          'A direct forget request removes the selected note in chat, preserves an unrelated note and learning-off state, and survives a fourth native relaunch with its draft',
        );
      } else if (req.url.startsWith('/capture-')) {
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, `memory-native-${req.url.slice(9)}.png`),
        ]);
      } else throw Error('Unknown test checkpoint');
      res.end('ok');
    } catch (e) {
      res.statusCode = 500;
      res.end(e.message);
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = join(logs, `memory-lifecycle-native-${Date.now()}.xcresult`);
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testMemoryLifecycle',
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
  assert.equal(checks.length, 9);
  await writeFile(
    join(evidence, 'memory-lifecycle-native.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        resultBundle: bundle,
        log,
        checks,
        scope:
          'Native iPhone Simulator WebKit with keyboard, source inspection, edited-note protection, both correction choices, manual notes, forgetting, explicit saving with learning off, direct forgetting from chat and four full relaunches. Controlled model; real agent, focused proposal pass and SQLite. Physical devices and Android remain unverified.',
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
