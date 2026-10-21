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
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';

import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'relay-backup-native-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/backup-controls');
let device, f, control;
const checks = [];
let expected;
let verified = false;
await mkdir(evidence, { recursive: true });
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Backup Controls Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Backup Controls Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await maintenanceFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  await f.computer.start('owner');
  await f.computer.takeControl();
  const command = (command) =>
    f.computer.perform(
      { kind: 'exec', command, operationId: crypto.randomUUID() },
      { actor: 'owner' },
    );
  await command(
    "printf 'native backup original' > native-backup.txt; dd if=/dev/zero of=large-backup.bin bs=1048576 count=10 status=none",
  );
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
      ),
      found = [];
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(join(path, entry.name));
        else if (entry.isFile() && entry.name === 'Relay-computer.relaybackup')
          found.push(join(path, entry.name));
      }
    }
    await walk(root);
    return found;
  }
  control = createServer(async (req, res) => {
    try {
      assert.equal(f.store.read().messages.length, 0);
      if (req.url === '/picker') {
        assert.equal((await staged()).length, 1);
        const entry = [...f.snapshots.downloads.entries.values()].find(
          (entry) => entry.phase === 'ready',
        );
        assert(entry);
        expected = await readFile(entry.file);
        assert.ok(expected.length > 10 * 1024 * 1024);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'backup-controls-native-picker.png'),
        ]);
      } else if (req.url === '/cancelled') {
        assert.equal((await staged()).length, 0);
        assert.equal((await savedFiles()).length, 0);
        checks.push('Native Files picker cancellation leaves no exported file or native staging.');
      } else if (req.url === '/saved') {
        const paths = await savedFiles();
        assert.equal(paths.length, 1);
        assert.deepEqual(await readFile(paths[0]), expected);
        assert.equal((await staged()).length, 0);
        checks.push({
          nativeSavedBytes: expected.length,
          sha256: createHash('sha256').update(expected).digest('hex'),
        });
        await command("printf 'native later work' > native-backup.txt");
      } else if (req.url === '/review') {
        assert.equal(f.snapshots.points().length, 2);
        assert.equal(
          Buffer.from((await f.computer.read('native-backup.txt')).base64, 'base64').toString(),
          'native later work',
        );
        checks.push(
          'System file picker imports the saved backup and opens inline review before replacing current files.',
        );
      } else if (req.url === '/restored' || req.url === '/verify') {
        assert.equal(
          Buffer.from((await f.computer.read('native-backup.txt')).base64, 'base64').toString(),
          'native backup original',
        );
        assert.equal(f.snapshots.points().length, 3);
        assert.equal(f.computer.controller, 'owner');
        assert.equal((await f.computer.runtime.inspect()).State.Paused, true);
        if (req.url === '/verify') {
          assert.equal(
            f.store.read().threads.find((t) => t.id === 'main').draft,
            'Keep my native backup draft',
          );
          verified = true;
          checks.push(
            'Restored bytes, owner freeze and chat draft survive a full native app relaunch.',
          );
        }
      } else throw Error('Unknown backup acceptance step');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end(error.message);
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/backup-controls-native-${Date.now()}.xcresult`);
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testComputerBackupControls',
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
    join(evidence, `backup-controls-native-${Date.now()}-attachments`),
  ]);
  assert.equal(code, 0, `Native backup controls test failed: ${log}`);
  assert(verified);
  await writeFile(
    join(evidence, 'backup-controls-native-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        log,
        checks,
        scope:
          'Actual iPhone Simulator native save and import pickers, encrypted file larger than 10 MB, exact bytes, real Docker restore and relaunch. No physical-device or Android runtime claim.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS native backup save, cancellation, file import, reviewed restore and relaunch');
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
