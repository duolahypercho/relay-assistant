// SPDX-License-Identifier: MIT
// Runs only inside the synthetic acceptance container, with no external network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'Run the desktop as an ordinary user.');
const executable = '/usr/bin/relay-assistant';
const sandbox = await stat('/opt/relay-assistant/chrome-sandbox');
assert.equal(sandbox.uid, 0);
assert.equal(sandbox.mode & 0o7777, 0o4755);
assert.match(
  await readFile('/usr/share/applications/org.relay.assistant.desktop', 'utf8'),
  /Exec=\/usr\/bin\/relay-assistant/,
);
const env = {
  ...process.env,
  RELAY_EVIDENCE_DIR: '/evidence',
  RELAY_DESKTOP_EXECUTABLE: executable,
  RELAY_DESKTOP_TEST_LABEL: `linux-${process.arch}`,
};
const tests = (await readdir('tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join('tests', name));
const testLog = await open('/evidence/backend-tests.log', 'w');
let testCode;
try {
  testCode = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
      env,
      stdio: ['ignore', testLog.fd, testLog.fd],
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => accept(code ?? signal));
  });
} finally {
  await testLog.close();
}
const results = await readFile('/evidence/backend-tests.log', 'utf8');
const backend = {
  passed: testCode === 0,
  tests: Number(results.match(/^# tests (\d+)$/m)?.[1]),
  failures: Number(results.match(/^# fail (\d+)$/m)?.[1]),
};
await writeFile('/evidence/backend-tests.json', JSON.stringify(backend, null, 2));
assert.equal(testCode, 0, 'Linux backend tests failed; inspect backend-tests.log.');
for (const script of [
  'test-desktop.mjs',
  'test-device-links-mac.mjs',
  'test-video-reader-ui.mjs',
]) {
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [join('scripts', script), ...(script === 'test-video-reader-ui.mjs' ? ['--mac'] : [])],
      { env, stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? accept() : reject(Error(`${script} exited with ${code ?? signal}`)),
    );
  });
}
await writeFile(
  '/evidence/linux-runtime.json',
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      uid: process.getuid(),
      osRelease: await readFile('/etc/os-release', 'utf8'),
      scopes: [
        'Packaged Electron, real SQLite, native menu dispatch, scheduled reminder after window close, full restart',
        'One-use HTTPS device link, persisted Secure HttpOnly session, chat, draft and revocation',
      ],
      limits:
        'Debian container with Xvfb, not a physical desktop. Sample assistant and controlled model; no live-provider, microphone, notification, GPU, Wayland, installer, or other-distribution acceptance.',
    },
    null,
    2,
  ),
);
