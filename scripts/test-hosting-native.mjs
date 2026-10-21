// SPDX-License-Identifier: MIT
// Continues test-hosting.mjs with RELAY_HOSTING_KEEP=true. Uses its actual Linux
// server and Caddy CA, a new Simulator, and the production native app.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { request, Agent } from 'node:https';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile),
  privateState = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { project, override, url, caPath, cookie, key } = privateState;
assert.match(project, /^relay-hosting-[a-f0-9]{8}$/);
assert.match(url, /^https:\/\/127\.0\.0\.1:\d+$/);
const docker = process.env.RELAY_TEST_DOCKER || 'docker';
const agent = new Agent({ ca: await readFile(caPath) });
const state = () =>
  new Promise((resolve, reject) => {
    const r = request(url + '/api/state', { agent, headers: { Cookie: cookie } }, (res) => {
      const bytes = [];
      res.on('data', (b) => bytes.push(b));
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200);
          resolve(JSON.parse(Buffer.concat(bytes)));
        } catch (e) {
          reject(e);
        }
      });
    });
    r.on('error', reject);
    r.end();
  });
async function until(check, label) {
  const end = Date.now() + 45000;
  while (!(await check())) {
    if (Date.now() > end) throw Error(label);
    await delay(200);
  }
}
let device,
  control,
  verified = false;
try {
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Linux Hosting Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  console.log('Test-owned Simulator', device);
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', caPath]);
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/credential') return res.end(key);
      if (req.url === '/sent')
        await until(
          async () =>
            (await state()).messages.some(
              (m) => m.role === 'assistant' && m.text.includes('Your hosted Relay'),
            ) &&
            (await state()).messages.some(
              (m) => m.text === 'Hello from the native iPhone on Linux.',
            ),
          'Native message missing',
        );
      else if (req.url === '/draft')
        await until(
          async () =>
            (await state()).threads.find((t) => t.id === 'main').draft ===
            'Keep my hosted iPhone draft.',
          'Native draft missing',
        );
      else if (req.url === '/restart')
        await exec(
          docker,
          [
            'compose',
            '-p',
            project,
            '-f',
            'deploy/compose.yaml',
            '-f',
            override,
            'up',
            '-d',
            '--force-recreate',
            '--no-deps',
            '--wait',
            'app',
          ],
          { env: { ...process.env, RELAY_DOMAIN: '127.0.0.1' }, timeout: 120000 },
        );
      else if (req.url === '/verify') {
        const s = await state();
        assert.equal(
          s.messages.filter(
            (m) => m.role === 'user' && m.text === 'Hello from the native iPhone on Linux.',
          ).length,
          1,
        );
        assert.equal(s.threads.find((t) => t.id === 'main').draft, 'Keep my hosted iPhone draft.');
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
    log = resolve(`../../work/hosting-native-${stamp}.log`),
    bundle = resolve(`../../work/hosting-native-${stamp}.xcresult`);
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
        '-only-testing:RelayShareUITests/ConnectionUITests/testHostedLinuxWorkspace',
        '-destination',
        `platform=iOS Simulator,id=${device}`,
        '-parallel-testing-enabled',
        'NO',
        '-resultBundlePath',
        bundle,
        'CODE_SIGN_IDENTITY=-',
        `RELAY_CONNECTION_TEST_SERVER=${url}`,
        `RELAY_CONNECTION_TEST_CONTROL=http://127.0.0.1:${control.address().port}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const [code] = await once(child, 'exit');
  out.end();
  assert.equal(code, 0, `Native Linux hosting acceptance failed: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    resolve('../relay-evidence/hosting-native-ios-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        log,
        bundle,
        checks: [
          'Native iPhone WebKit trusts the Linux Caddy certificate in its test-only keychain',
          'Real HTTPS sign-in and native keyboard send, one persisted message',
          'Secure session and unsent draft survive full app relaunch',
          'Same session and draft survive actual Linux app container replacement',
        ],
        limits:
          'Controlled model response. iPhone Simulator only; public DNS/ACME and physical devices remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS native iPhone on Linux HTTPS');
} finally {
  agent.destroy();
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
}
