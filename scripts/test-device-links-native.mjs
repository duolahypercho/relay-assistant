// SPDX-License-Identifier: MIT
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { request, Agent } from 'node:https';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { deviceLinksFixture } from './device-links-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-device-links-native-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  agent,
  verified = false;
const grants = [];
try {
  f = await deviceLinksFixture(directory);
  agent = new Agent({ ca: await readFile(f.caPath) });
  async function call(path, body, cookie = '') {
    return await new Promise((resolve, reject) => {
      const req = request(
        f.url + path,
        {
          agent,
          method: body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            Origin: f.url,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            try {
              assert.equal(res.statusCode, 200, text);
              resolve({
                body: JSON.parse(text),
                cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const owner = (await call('/api/login', { key: f.key })).cookie;
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/link') {
        const link = (await call('/api/device-links', {}, owner)).body;
        grants.push(link);
        res.end(link.url);
        return;
      }
      if (req.url === '/revoke') {
        const devices = (await call('/api/device-links', null, owner)).body.devices;
        assert.equal(devices.length, 1);
        await call(`/api/devices/${devices[0].id}/disconnect`, {}, owner);
        res.end('ok');
        return;
      }
      for (
        let i = 0;
        i < 40 &&
        f.store.read().threads.find((t) => t.id === 'main').draft !==
          'Keep my native connected thought';
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
      const state = f.store.read();
      assert.equal(state.messages.length, 2);
      assert.equal(f.requests.length, 1);
      assert(state.messages.some((m) => m.text === 'Hello from my linked iPhone'));
      assert.equal(
        state.threads.find((t) => t.id === 'main').draft,
        'Keep my native connected thought',
      );
      const devices = (await call('/api/device-links', null, owner)).body.devices;
      assert.equal(devices.length, 1);
      assert.equal(devices[0].name, 'My iPhone');
      if (req.url === '/verify') verified = true;
      else assert.equal(req.url, '/saved');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Device Links Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 240000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', f.caPath]);
  const bundle = resolve(`../../work/device-links-native-${Date.now()}.xcresult`),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testDeviceConnectionLink',
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
  assert(verified);
  const container = (
    await exec('xcrun', ['simctl', 'get_app_container', device, 'org.relay.assistant', 'data'])
  ).stdout.trim();
  const prefs = JSON.parse(
    (
      await exec('plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        join(container, 'Library/Preferences/org.relay.assistant.plist'),
      ])
    ).stdout,
  );
  assert.equal(prefs['relay-server'], f.url + '/');
  for (const grant of grants)
    assert(!JSON.stringify(prefs).includes(grant.url.split('#connect=')[1]));
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, 'device-links-native-attachments'),
  ]);
  const parserBundle = bundle.replace('.xcresult', '-parser.xcresult');
  try {
    const result = await exec(
      'xcodebuild',
      [
        'test',
        '-project',
        'native/mobile/ios/App/App.xcodeproj',
        '-scheme',
        'App',
        '-only-testing:RelayNativeTests/ResultsTests/testDeviceConnectionLinksKeepOnlyCanonicalServerPreferences',
        '-destination',
        `platform=iOS Simulator,id=${device}`,
        '-parallel-testing-enabled',
        'NO',
        '-resultBundlePath',
        parserBundle,
        'CODE_SIGN_IDENTITY=-',
      ],
      { timeout: 240000, maxBuffer: 32 * 1024 * 1024 },
    );
    await writeFile(parserBundle.replace('.xcresult', '.log'), result.stdout + result.stderr);
  } catch (error) {
    await writeFile(
      parserBundle.replace('.xcresult', '.log'),
      (error.stdout || '') + (error.stderr || ''),
    );
    throw error;
  }
  await writeFile(
    join(evidence, 'device-links-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        bundle,
        parserBundle,
        checks: [
          'Paste a full link into native server dialog; explicitly review and connect without owner key',
          'Real HTTPS WebKit session, actual controlled model reply and native keyboard draft',
          'Full app relaunch retains session and draft; native preferences save only server origin',
          'Owner revocation returns native app to sign-in; new link restores pending text',
          'Native Swift parser accepts canonical links and rejects malformed or insecure destinations',
        ],
        limits:
          'iPhone Simulator only; trusted root installed only in disposable Simulator. No physical device, Android runtime, public hosting or live provider claim.',
      },
      null,
      2,
    ),
  );
  console.log('PASS native device link, conversation, relaunch and revocation recovery');
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  agent?.destroy();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
