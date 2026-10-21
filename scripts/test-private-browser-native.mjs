// SPDX-License-Identifier: MIT
// Actual iPhone/WebKit, real Docker authority/runtime and host Chromium on isolated fixtures.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { trustedBrowserFixture } from './trusted-browser-fixture.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { BrowserContainer } from '../server/browser-container.mjs';
const containerMode = process.env.RELAY_BROWSER_CONTAINER_TEST === 'true';
import { PrivateComputer } from '../server/computer.mjs';
import { pinnedBrowserRequest } from '../server/browser-requests.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-browser-ios-')),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control, browser, computer, site;
let verified = false,
  frozen = '';
const tool = (name, args, id) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const ticks = async () =>
  Buffer.from((await computer.read('ticks.txt')).base64, 'base64').toString();
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Private Browser Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay Private Browser Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  site = await trustedBrowserFixture({ pageResources: true });
  f = await assistantsFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    async configure(store, services) {
      computer = new PrivateComputer(store, { enabled: true, deployment: directory });
      await computer.start();
      const probe = `import os,time\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\nwith open('/workspace/ticks.txt','ab',buffering=0) as f:\n while True:\n  f.write(b'tick\\n');time.sleep(.05)\n`;
      await computer.perform({
        kind: 'files',
        action: 'write',
        path: 'probe.py',
        base64: Buffer.from(probe).toString('base64'),
        operationId: 'native-probe',
      });
      const started = await computer.perform({
        kind: 'exec',
        command: 'python3 /workspace/probe.py >/tmp/probe.log 2>&1',
        operationId: 'native-probe-start',
      });
      assert.equal(started.exitCode, 0, started.stderr);
      await delay(150);
      browser = new TrustedBrowser(store, {
        ...(containerMode ? { runtime: new BrowserContainer(computer) } : {}),
        key: randomBytes(32),
        enabled: true,
        channel: 'chrome',
        control: computer,
        resolver: site.resolver,
        transport: (input, options) => pinnedBrowserRequest(input, { ...options, ca: site.cert }),
      });
      services.computer = computer;
      services.privateBrowser = browser;
    },
    respond({ messages, tools }) {
      assert(tools.some((t) => t.function.name === 'private_browser_action'));
      const outputs = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
      assert(!JSON.stringify(messages).includes(site.password));
      assert(!JSON.stringify(messages).includes(site.session));
      if (outputs.some((o) => o.error))
        return { role: 'assistant', content: 'The website action stopped. I did not repeat it.' };
      const result = outputs.at(-1)?.result;
      if (result?.receipt?.phase && result.receipt.phase !== 'completed')
        return { role: 'assistant', content: 'The website action stopped. I did not repeat it.' };
      if (!outputs.length)
        return tool(
          'private_browser_action',
          { action: 'open', url: `${site.origin}/workspace` },
          'open',
        );
      if (outputs.length === 1) {
        const field = result.page.content.find((n) => n.name === 'Note' && n.role === 'textbox');
        assert(field?.target);
        return tool(
          'private_browser_action',
          { action: 'type', target: field.target, text: 'A quiet native afternoon' },
          'type',
        );
      }
      if (outputs.length === 2) {
        const button = result.page.content.find(
          (n) => n.name === 'Save note' && n.role === 'button',
        );
        return tool('private_browser_action', { action: 'click', target: button.target }, 'save');
      }
      assert(result.page.content.some((n) => n.name === 'Note saved'));
      return { role: 'assistant', content: 'Your native browser note is saved.' };
    },
  });
  const before = structuredClone(f.store.read().messages);
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/address') return res.end(`${site.origin}/signin`);
      if (req.url === '/password') return res.end(site.password);
      if (req.url === '/owner-start') {
        assert.equal(computer.controller, 'owner');
        assert.equal((await computer.runtime.inspect()).State.Paused, true);
        frozen = await ticks();
      } else if (req.url === '/signed-in') {
        for (let i = 0; i < 100 && !site.calls.some((c) => c.url === '/workspace'); i++)
          await delay(100);
        assert.equal(
          site.calls.filter((c) => c.url === '/signin' && c.method === 'POST').length,
          1,
        );
        assert(site.calls.find((c) => c.url === '/workspace').cookie.includes(site.session));
        assert.equal(await ticks(), frozen);
        assert.equal((await computer.runtime.inspect()).State.Paused, true);
        assert.deepEqual(f.store.read().messages, before);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(
            evidence,
            `${containerMode ? 'browser-container' : 'private-browser'}-native-ios-signed-in.png`,
          ),
        ]);
      } else if (req.url === '/phase') {
        if (f.store.read().runs.at(-1)?.status === 'completed') return res.end('completed');
        const pending = browser.requests.list().filter((r) => r.phase === 'pending');
        return res.end(
          pending.some((r) => r.method === 'POST')
            ? 'form'
            : pending.length
              ? 'request'
              : 'working',
        );
      } else if (req.url === '/before-form') {
        assert.equal(site.calls.filter((c) => c.url === '/save').length, 0);
        const assets = browser.requests
          .list()
          .filter((r) => r.actor === 'agent' && r.url.includes('/page-assets/'));
        assert(assets.length >= 4);
        assert(assets.every((r) => r.authorization === 'page-load' && r.phase === 'completed'));
        assert.equal(browser.requests.pageLoads.size, 0);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(
            evidence,
            `${containerMode ? 'browser-container' : 'private-browser'}-native-ios-review.png`,
          ),
        ]);
      } else if (req.url === '/saved') {
        assert.equal(site.calls.filter((c) => c.url === '/save').length, 1);
        assert.equal(
          site.calls.find((c) => c.url === '/save').body,
          'note=A+quiet+native+afternoon',
        );
        assert.equal(f.store.read().runs.at(-1)?.status, 'completed');
        assert((await ticks()).length > frozen.length);
        assert.equal((await computer.runtime.inspect()).State.Paused, false);
        assert(!JSON.stringify(f.requests).includes(site.password));
        assert(!JSON.stringify(f.store.read()).includes(site.password));
      } else if (req.url === '/retained') assert(browser.vault.storage().cookies.length > 0);
      else if (req.url === '/verify') {
        for (let i = 0; i < 100 && browser.vault.storage(); i++) await delay(100);
        assert.equal(browser.vault.storage(), undefined);
        assert.equal(f.store.read().messages.length, before.length + 2);
        assert.equal(f.store.read().messages.at(-1).text, 'Your native browser note is saved.');
        assert.equal(site.calls.filter((c) => c.url === '/save').length, 1);
        verified = true;
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(
            evidence,
            `${containerMode ? 'browser-container' : 'private-browser'}-native-ios-cleared.png`,
          ),
        ]);
      } else throw Error('Unknown fixture check');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Fixture check failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const bundle = resolve(
      `../../work/${containerMode ? 'browser-container' : 'private-browser'}-native-${Date.now()}.xcresult`,
    ),
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
      '-only-testing:RelayShareUITests/ConnectionUITests/testPrivateBrowserSignInReviewAndTakeover',
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
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, `Inspect native private-browser log: ${log}`);
  assert(verified);
  await writeFile(
    join(
      evidence,
      `${containerMode ? 'browser-container' : 'private-browser'}-native-ios-acceptance.json`,
    ),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        passed: true,
        containerBrowser: containerMode,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'Actual WebKit HTTPS and isolated Simulator trust',
          'Native keyboard username/password sign-in and blur-before-submit',
          'Real Docker command freezer remains paused throughout owner sign-in',
          'Pending request survives complete app restart',
          'One native approval loads the page script, style, image and declared icon; permission ends before form review',
          'Exact form reviewed on iPhone and sent once',
          'Handback resumes the same guest command',
          'Main draft and navigation history preserved',
          'Inline cancel/clear of private sign-ins',
        ],
        limitations: [
          'iPhone Simulator, controlled model and test account',
          'No physical-device, Android or public-server release certification',
          'No comprehensive browser/kernel escape or general taint protection proof',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS real iPhone Simulator private browser with Docker takeover');
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.worker.stop();
  await browser?.close();
  if (computer) {
    await computer.stop().catch(() => {});
    await computer.dockerRun(['rm', '-f', computer.runtime.name, computer.name]).catch(() => {});
    await computer
      .dockerRun(['volume', 'rm', computer.volume, computer.displayVolume])
      .catch(() => {});
  }
  await f?.close();
  await site?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
