// SPDX-License-Identifier: MIT
// Native WebKit/export boundary tests on a disposable iPhone Simulator.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const backups = process.argv.includes('--backups');
const connection = process.argv.includes('--connection');
const suite = connection ? 'ConnectionCopyTests' : backups ? 'BackupFileTests' : 'ResultsTests';
const tests = connection ? 3 : backups ? 2 : 7;
const prefix = connection
  ? 'connection-language-native-unit'
  : backups
    ? 'backup-controls-native-unit'
    : 'mobile-results-native-unit';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device;
try {
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Result Boundary Tests',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  const bundle = resolve(`../../work/mobile-results-unit-${Date.now()}.xcresult`);
  const log = bundle.replace('.xcresult', '.log');
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'App',
      `-only-testing:RelayNativeTests/${suite}`,
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
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
  assert.equal(code, 0, `Native boundary tests failed: ${log}`);
  const contents = await readFile(log, 'utf8');
  assert(contents.includes(`Executed ${tests} tests, with 0 failures`));
  await writeFile(
    join(evidence, `${prefix}.json`),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        log,
        tests,
        scope: connection
          ? 'Production Swift locale resolution, bundled connection copy and browser-blocked port validation. Separate UI acceptance verifies actual native controls and offline relaunch.'
          : backups
            ? 'Production Swift encrypted backup file staging, exact 12 MiB bytes, bounds, order, invalid headers and cancellation cleanup. Separate UI acceptance verifies the actual picker.'
            : 'Production WebKit preview isolation, real script interaction/network denial, stop/restart, connection-link parsing, export bytes/bounds/staging and exact cold-start cleanup boundaries. Separate native UI acceptance verifies the actual picker.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`PASS ${tests} native ${suite} tests`);
} finally {
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
}
