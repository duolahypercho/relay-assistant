// SPDX-License-Identifier: MIT
// Actual iPhone alerts and bundled offline recovery on one disposable Simulator.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device;
try {
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Connection Languages',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  const bundle = resolve(`../../work/native-connection-language-${Date.now()}.xcresult`),
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
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      '-only-testing:RelayShareUITests/ConnectionUITests/testConnectionLanguageAndInlineValidation',
      '-resultBundlePath',
      bundle,
      'CODE_SIGN_IDENTITY=-',
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
  await new Promise((r) => output.end(r));
  assert.equal(code, 0, `Inspect native connection log: ${log}`);
  await writeFile(
    join(evidence, 'native-connection-language-ios.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        log,
        checks: [
          'Simplified Chinese, Traditional Chinese and English actual native connection controls',
          'Invalid address and browser-blocked port retain input and disable Connect in the same form',
          'Exact synthetic connection link accepted without navigating externally',
          'Actual offline page, address preservation and full relaunch in each device language',
          'Change server and cancel preserve recovery state',
        ],
        limits:
          'iPhone Simulator, local unreachable test origin. No Android runtime, physical device or full native-shell translation claim.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS native multilingual connection, inline validation and offline recovery');
} finally {
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
}
