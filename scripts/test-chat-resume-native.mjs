// SPDX-License-Identifier: MIT
// Native iPhone stopped-runtime recovery against real Colima and an isolated Docker desktop.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chatResumeFixture } from './chat-resume-fixture.mjs';
import { setupProcess } from '../server/computer-setup.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-native-computer-engine-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const profile = process.env.RELAY_ENGINE_TEST_PROFILE;
const asleep = process.argv.includes('--asleep');
const receiptName = asleep ? 'asleep-chat' : 'chat-resume';
assert(profile && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile));
const host = `unix://${join(homedir(), '.colima', profile, 'docker.sock')}`;
const configFile = join(homedir(), '.colima', profile, 'colima.yaml');
const config = await readFile(configFile);
const initialContext = (await setupProcess('docker', ['context', 'show'])).stdout.trim();
async function profileStatus() {
  const result = await setupProcess('colima', ['list', '--json']);
  assert.equal(result.exitCode, 0);
  return result.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.name === profile)?.status;
}
assert.equal(await profileStatus(), 'Stopped');

let device,
  f,
  control,
  verified = false;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Chat Resume Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Chat Resume Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await chatResumeFixture(directory, {
    host,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  const draft = 'Keep my iPhone resume draft',
    checks = [];
  f.controls.mode = 'hold';
  if (asleep) {
    const inspect = f.setup.engineControl.inspect.bind(f.setup.engineControl);
    f.setup.engineControl.inspect = async (signal) => {
      const target = await inspect(signal);
      if (
        f.setup.engineControl.pending &&
        f.setup.engineControl.intent === 'chat' &&
        f.controls.mode === 'hold'
      )
        await new Promise((_, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      return target;
    };
  }
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/waiting') {
        assert.equal(f.computer.controller, 'owner');
        assert.equal(f.requests.length, 0);
        assert.equal(f.store.read().messages.length, 1);
        assert.equal(f.setup.engineControl.intent, asleep ? 'chat' : 'resume');
        assert.equal(f.setup.engineControl.phase, asleep ? 'checking' : 'waking');
      } else if (req.url === '/cancelled') {
        assert.equal(f.computer.controller, 'owner');
        assert.equal(f.requests.length, 0);
        assert.equal(f.setup.engineControl.phase, 'cancelled');
        assert.equal(await profileStatus(), 'Stopped');
        f.controls.mode = 'real';
      } else if (req.url === '/verify') {
        const until = Date.now() + 10000;
        while (f.store.read().threads[0].draft !== draft && Date.now() < until)
          await new Promise((r) => setTimeout(r, 50));
        assert.equal(f.computer.controller, 'agent');
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].controller, 'agent');
        assert.equal(f.store.read().messages.length, 2);
        assert.equal(f.store.read().threads[0].draft, draft);
        assert.equal((await f.computer.status()).state, asleep ? 'unavailable' : 'running');
        assert.equal(await profileStatus(), asleep ? 'Stopped' : 'Running');
        if (asleep) assert.equal(f.controls.starts, 0);
        assert.deepEqual(await readFile(configFile), config);
        assert.equal(
          (await setupProcess('docker', ['context', 'show'])).stdout.trim(),
          initialContext,
        );
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, `${receiptName}-native-ios.png`),
        ]);
        verified = true;
        checks.push(
          asleep
            ? 'Native protected HTTPS chat; one Send begins verified handback and queues one reply while the real VM remains stopped'
            : 'Native protected HTTPS chat, queued message, runtime wake and one handback',
          'Relaunch while waiting preserves progress and draft',
          asleep
            ? 'Cancellation leaves owner control; retry confirms the real stopped VM without any start or thaw'
            : 'Cancellation leaves owner control and stopped VM; retry starts real Colima',
          'Exactly one controlled model reply after acknowledged handback',
          'Chat draft and two-message history survive full relaunch',
        );
      } else throw Error('Unknown check');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(`../../work/${receiptName}-native-${Date.now()}.xcresult`),
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
      `-only-testing:RelayShareUITests/ConnectionUITests/${asleep ? 'testChatWhileComputerAsleep' : 'testChatComputerResume'}`,
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
    join(evidence, `${basename(bundle, '.xcresult')}-attachments`),
  ]);
  await writeFile(
    join(evidence, `${receiptName}-native-ios-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        bundle,
        log,
        checks,
        limits: [
          'iPhone Simulator on iOS 26.5; not physical phones or Android.',
          asleep
            ? 'An existing installed Colima profile stays stopped throughout. No runtime installation, startup or profile creation is covered.'
            : 'An existing installed Colima profile starts stopped. Native UI starts the actual runtime and desktop. No runtime installation or profile creation is covered.',
          'The native client connects to an isolated HTTPS backend; this does not verify a live model, cloud hosting, snapshots, OS/VM repair or website sign-ins.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`PASS native iPhone ${receiptName} with real Colima and queued reply`);
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  if ((await profileStatus()) === 'Running')
    assert.equal(
      (await setupProcess('colima', ['stop', '--profile', profile], { timeout: 120000 })).exitCode,
      0,
    );
  assert.equal(await profileStatus(), 'Stopped');
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
