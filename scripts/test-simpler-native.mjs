// SPDX-License-Identifier: MIT
// Real bundled WebKit UI on an isolated iPhone Simulator. No accounts or permissions.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const evidence = resolve('../relay-evidence');
const direct = process.argv.includes('--direct');
const touch = process.argv.includes('--touch');
await mkdir(evidence, { recursive: true });
let device;
try {
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      touch
        ? 'Relay Phone Touch Acceptance'
        : direct
          ? 'Relay Direct Navigation Acceptance'
          : 'Relay Simpler UI Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  const bundle = resolve(
    `../../work/${touch ? 'chat-touch' : direct ? 'direct-navigation' : 'simpler'}-native-${Date.now()}.xcresult`,
  );
  const log = bundle.replace('.xcresult', '.log');
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
      `-only-testing:RelayShareUITests/ConnectionUITests/${touch ? 'testPhoneTouchTargets' : direct ? 'testDirectPageRequests' : 'testFocusedSettingsAndSearch'}`,
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
  assert.equal(code, 0, `Inspect native acceptance log: ${log}`);
  await writeFile(
    join(
      evidence,
      touch
        ? 'chat-touch-native-ios.json'
        : direct
          ? 'direct-navigation-native-ios-acceptance.json'
          : 'simpler-native-ios-acceptance.json',
    ),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        log,
        checks: touch
          ? [
              'Native primary chat buttons have at least 44-point frames',
              'Outer-edge taps open the intended search, chats and voice controls',
              'Separate chat drafts survive navigation and relaunch',
              'Message action edge tap, reaction, inline reply and outside dismissal work without a dialog',
              'Message-action draft and reaction survive a full relaunch',
            ]
          : direct
            ? [
                'Native iPhone keyboard exposes a direct page preview with an explicit assistant alternative',
                'One tap opens Files and the exact Appearance settings page without chat messages',
                'Return keeps side-chat identity and clears only the navigation request',
                'Specific requests remain messages and survive full relaunch',
                'Separate Main draft remains intact',
              ]
            : [
                'Native search scope changes preserve query and exclude other pages from this-chat results',
                'Native one-tap search opens exact appearance category',
                'Unfinished settings forms survive category changes',
                'Hidden forms stay out of navigation',
                'Voice controls accessible from category',
                'Native chat draft survives navigation and relaunch',
              ],
        limits:
          'iPhone Simulator with bundled sample. Android and physical devices remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log(
    touch
      ? 'PASS: native phone touch targets and retained drafts'
      : direct
        ? 'PASS: native direct page requests and retained drafts'
        : 'PASS: native search, focused settings and retained drafts',
  );
} finally {
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
}
