// SPDX-License-Identifier: MIT
// Native WebKit -> HTTPS application VM -> mutually authenticated computer VM.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { remoteComputerFixture } from './remote-computer-fixture.mjs';
const exec = promisify(execFile),
  evidence = resolve('../relay-evidence');
let f,
  device,
  control,
  identity,
  verified = false;
const report = { startedAt: new Date().toISOString(), checks: [] };
try {
  f = await remoteComputerFixture();
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Remote Computer Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  console.log('Test-owned Simulator', device);
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', f.caPath]);
  const file = () => f.d('guest', ['exec', f.computerName, 'cat', '/workspace/iphone-proof.txt']);
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/credential') return res.end(f.key);
      if (req.url === '/file') {
        await f.until(
          async () => (await file()) === 'Made on the remote iPhone computer',
          'Native guest command',
        );
        identity = JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0].Id;
      } else if (req.url === '/restart') await f.restart();
      else if (req.url === '/verify') {
        assert.equal(await file(), 'Made on the remote iPhone computer');
        assert.equal(JSON.parse(await f.d('guest', ['inspect', f.computerName]))[0].Id, identity);
        const state = await f.json('/api/state');
        assert.equal(state.threads[0].draft, 'Keep my remote iPhone draft.');
        assert.equal(state.messages.length, 0);
        assert.equal((await f.json('/api/computer')).controller, 'owner');
        verified = true;
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error.message);
      res.writeHead(500).end('Acceptance failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    log = resolve(`../../work/remote-computer-native-${stamp}.log`),
    bundle = resolve(`../../work/remote-computer-native-${stamp}.xcresult`);
  report.log = log;
  report.bundle = bundle;
  report.device = device;
  console.log(JSON.stringify({ log, bundle }));
  const out = createWriteStream(log),
    child = spawn(
      'xcodebuild',
      [
        'test',
        '-project',
        'native/mobile/ios/App/App.xcodeproj',
        '-scheme',
        'ConnectionAcceptance',
        '-only-testing:RelayShareUITests/ConnectionUITests/testHostedRemoteComputer',
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
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const [code] = await once(child, 'exit');
  out.end();
  assert.equal(code, 0, `Native remote computer failed: ${log}`);
  assert.equal(verified, true);
  report.checks.push(
    'Native iPhone starts the real remote desktop, takes control and writes actual guest file bytes through the command UI',
    'Actual Linux app-container replacement and native relaunch retain the session, unsent draft and owner control',
    'Native stop/start retains the same guest container and exact file bytes; navigation and control add no chat messages',
  );
  report.passed = true;
  console.log('PASS native iPhone remote computer');
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(evidence, 'remote-computer-native-ios-acceptance.json'),
    JSON.stringify(report, null, 2),
  );
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await f?.close();
}
