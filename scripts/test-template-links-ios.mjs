// SPDX-License-Identifier: MIT
// Disposable iPhone Simulator with a fixture-only trusted root and actual OS URL dispatch.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { deviceLinksFixture } from './device-links-fixture.mjs';
import { assistantsFixture } from './assistants-fixture.mjs';
import { publishAcceptanceTemplate } from './template-links-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-template-ios-'));
const evidence = resolve('../relay-evidence/template-links');
await mkdir(evidence, { recursive: true });
let device,
  recipient,
  publisher,
  control,
  verified = false,
  pendingId;
const checks = [];
try {
  recipient = await deviceLinksFixture(directory);
  publisher = await assistantsFixture(join(directory, 'publisher'), {
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  const first = publishAcceptanceTemplate(publisher),
    second = publishAcceptanceTemplate(publisher, 'Aster second kit');
  async function preferences() {
    const container = (
      await exec('xcrun', ['simctl', 'get_app_container', device, 'org.relay.assistant', 'data'])
    ).stdout.trim();
    return JSON.parse(
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
  }
  async function eventually(check) {
    for (let i = 0; ; i++) {
      try {
        return await check();
      } catch (error) {
        if (i >= 80) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  control = createServer(async (req, res) => {
    try {
      if (['/open', '/second', '/revoked'].includes(req.url)) {
        if (req.url === '/revoked')
          second.manager.revoke(second.record.token, second.record.revision);
        checks.push(req.url);
        res.end(req.url === '/open' ? first.link : second.link);
        return;
      } else if (req.url === '/saved') {
        await eventually(() =>
          assert.equal(
            recipient.store.read().threads.find((t) => t.id === 'main').draft,
            'Keep my template thought',
          ),
        );
      } else if (req.url === '/pending') {
        assert.equal((recipient.store.read().assistants || []).length, 0);
      } else if (['/added', '/dismissed', '/verify'].includes(req.url)) {
        const s = recipient.store.read();
        assert.equal(s.assistants.length, 1);
        assert.match(s.templateImports[0].id, /^[A-Za-z0-9_-]{16,100}$/);
        if (pendingId) assert.equal(s.templateImports[0].id, pendingId);
        else pendingId = s.templateImports[0].id;
        assert.equal(s.routines.length, 1);
        assert.equal(s.routines[0].paused, true);
        assert.equal(s.messages.length, 0);
        assert.equal(s.runs.length, 0);
        assert.equal(recipient.requests.length, 0);
        if (req.url === '/verify') {
          assert.equal((await preferences())['relay-server'], recipient.url + '/');
          assert.equal(s.threads.find((t) => t.id === 'main').draft, 'Keep my template thought');
          verified = true;
        }
      } else throw Error('Unexpected fixture control request');
      checks.push(req.url);
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
      'Relay Template Links Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 240000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', recipient.caPath]);
  const bundle = resolve(`../../work/template-links-ios-${Date.now()}.xcresult`),
    log = bundle.replace('.xcresult', '.log');
  console.log(JSON.stringify({ device, bundle, log }));
  async function xcode(args, path, filename) {
    const output = createWriteStream(filename);
    const child = spawn(
      'xcodebuild',
      [
        'test',
        '-project',
        'native/mobile/ios/App/App.xcodeproj',
        ...args,
        '-destination',
        `platform=iOS Simulator,id=${device}`,
        '-parallel-testing-enabled',
        'NO',
        '-resultBundlePath',
        path,
        'CODE_SIGN_IDENTITY=-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.pipe(output);
    child.stderr.pipe(output);
    const code = await new Promise((r, j) => {
      child.once('error', j);
      child.once('exit', r);
    });
    output.end();
    assert.equal(code, 0, `See ${filename}`);
  }
  const parserBundle = bundle.replace('.xcresult', '-parser.xcresult');
  await xcode(
    [
      '-scheme',
      'App',
      '-only-testing:RelayNativeTests/ResultsTests/testTemplateLinksAreScopedAndRejectMalformedSources',
    ],
    parserBundle,
    parserBundle.replace('.xcresult', '.log'),
  );
  await xcode(
    [
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testAssistantTemplateLinks',
      `RELAY_CONNECTION_TEST_SERVER=${recipient.url}`,
      `RELAY_CONNECTION_TEST_CONTROL=http://127.0.0.1:${control.address().port}`,
    ],
    bundle,
    log,
  );
  assert(verified);
  await exec('xcrun', [
    'xcresulttool',
    'export',
    'attachments',
    '--path',
    bundle,
    '--output-path',
    join(evidence, 'ios-attachments'),
  ]);
  await writeFile(
    join(evidence, 'ios.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        bundle,
        parserBundle,
        checks,
        limits:
          'Disposable iPhone Simulator. No physical devices or native Android runtime tested.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await publisher?.close();
  await recipient?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
