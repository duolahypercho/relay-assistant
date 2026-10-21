// SPDX-License-Identifier: MIT
// Bundled WKWebView with the real iOS conversation controls, on a disposable Simulator.
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
      'Relay Chat Organization Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  const bundle = resolve(`../../work/chat-list-native-${Date.now()}.xcresult`),
    log = bundle.replace('.xcresult', '.log');
  console.log(`Native chat-list test: ${device}\n${log}`);
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testChatOrganization',
      '-resultBundlePath',
      bundle,
      'CODE_SIGN_IDENTITY=-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = createWriteStream(log);
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, `Inspect native chat-list log: ${log}`);
  await writeFile(
    join(evidence, 'chat-list-native-ios-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        log,
        checks: [
          'Native chat menu pins and marks conversations unread',
          'Pins and unread reminders survive full app relaunch',
          'Separate Main and side drafts survive organization actions and relaunch',
        ],
        limits:
          'Bundled sample in iPhone Simulator. Android, physical devices and full product parity remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native chat organization, separate drafts and relaunch');
} finally {
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
}
