// SPDX-License-Identifier: MIT
// Native iPhone touch/keyboard input against a real, isolated Docker desktop.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { computerInputFixture } from './computer-input-fixture.mjs';
const exec = promisify(execFile);
const clipboard = process.argv.includes('--clipboard');
const tablet = process.argv.includes('--ipad');
const liveKeyboard = process.argv.includes('--keyboard');
const feature = clipboard ? 'clipboard' : liveKeyboard ? 'keyboard' : 'direct';
const platform = tablet ? 'ipad' : 'ios';
const deviceLabel = tablet ? 'iPad' : 'iPhone';
const directory = await mkdtemp(join(tmpdir(), `relay-direct-${platform}-`));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control, computer, beforeDrag, afterDrag, pasteFixture;
const checks = [];
const check = (label) => {
  const description = label.replaceAll('iPhone', deviceLabel);
  checks.push(description);
  console.log('PASS', description);
};
const observe = async () =>
  JSON.parse(Buffer.from((await computer.read('input-state.json')).base64, 'base64').toString());
async function until(fn, message) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error(message);
}
const capture = (label) =>
  exec('xcrun', [
    'simctl',
    'io',
    device,
    'screenshot',
    join(evidence, `computer-${feature}-${platform}-${label}.png`),
  ]);
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Direct Computer Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      `Relay ${deviceLabel} Computer Acceptance`,
      tablet
        ? 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4'
        : 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  f = await assistantsFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    async configure(store, services) {
      computer = new PrivateComputer(store, { enabled: true, deployment: directory });
      await computer.start('owner');
      await computer.takeControl();
      const owner = (p) =>
        computer.perform({ operationId: randomUUID(), ...p }, { actor: 'owner' });
      await owner({
        kind: 'files',
        action: 'write',
        path: 'input-test.py',
        base64: Buffer.from(computerInputFixture).toString('base64'),
      });
      await owner({
        kind: 'exec',
        command: 'python3 /workspace/input-test.py >/workspace/input-test.log 2>&1 </dev/null &',
      });
      await until(async () => {
        try {
          return (await observe()).text === '';
        } catch {
          return false;
        }
      }, 'Guest editor not ready');
      await computer.release();
      services.computer = computer;
    },
  });
  const before = structuredClone(f.store.read().messages);
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/window') return res.end(JSON.stringify(await observe()));
      if (clipboard && req.url === '/prepare-copy') {
        assert.equal(computer.controller, 'owner');
        const owner = (p) =>
          computer.perform({ operationId: randomUUID(), ...p }, { actor: 'owner' });
        const state = await observe();
        await owner({ kind: 'desktop', action: 'click', x: state.x + 30, y: state.y + 25 });
        await owner({ kind: 'desktop', action: 'type', text: 'Hello 你好 café 🌱' });
        await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
        return res.end('ok');
      }
      if (clipboard && req.url === '/verify-copy') {
        await until(
          () =>
            f.store.read().threads.find((t) => t.id === 'main').draft ===
            'Keep this draft: Hello 你好 café 🌱',
          'Native clipboard paste lost text or draft',
        );
        assert.deepEqual(f.store.read().messages, before);
        assert.equal(f.requests.length, 0);
        assert.ok(!JSON.stringify(computer.receipts()).includes('Hello 你好'));
        await capture('pasted');
        check(
          'Native Copy transfers Unicode from the real Docker desktop; OS Paste appends to the saved draft without sending',
        );
        return res.end('ok');
      }

      if (req.url === '/prepare-paste') {
        f.store.mutate((s) => {
          s.threads.find((t) => t.id === 'main').draft = '';
        });
      } else if (req.url === '/paste-fixture' && req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          assert.ok(size <= 1_000_000);
          chunks.push(chunk);
        }
        pasteFixture = Buffer.concat(chunks);
      } else if (req.url === '/photo-draft') {
        await capture('photo-draft');
      } else if (req.url === '/pasted' || req.url === '/paste-reopened') {
        await until(
          () => f.store.read().threads.find((t) => t.id === 'main').draftFileIds?.length === 1,
          'Native pasted attachment was not saved',
        );
        const s = f.store.read();
        const main = s.threads.find((t) => t.id === 'main');
        const file = s.files.find((file) => file.id === main.draftFileIds[0]);
        assert.equal(file.mime, 'image/png');
        assert.ok(Buffer.from(file.base64, 'base64').equals(pasteFixture));
        assert.equal(main.draft, 'Keep my pasted image draft');
        assert.deepEqual(s.messages, before);
        assert.equal(f.requests.length, 0);
        await capture(req.url === '/pasted' ? 'pasted' : 'paste-reopened');
        if (req.url === '/paste-reopened')
          check(
            'Native iPhone image paste keeps exact PNG bytes beside the draft across full relaunch, without sending',
          );
      } else if (req.url === '/owner') {
        assert.equal(computer.controller, 'owner');
        assert.equal((await computer.runtime.inspect()).State.Paused, true);
        check('Native Take control freezes the actual command runtime');
      } else if (req.url === '/typed') {
        await until(
          async () => (await observe()).text === 'hello from my iPhone.\nSecond line',
          'Native keyboard text was not delivered exactly',
        );
        assert.deepEqual(f.store.read().messages, before);
        await capture('typed');
        check(
          'Native iPhone direct keyboard sends exact text, Backspace and Return once to the Linux editor without a Send step or chat history',
        );
      } else if (req.url === '/before-drag') {
        beforeDrag = await observe();
        await capture('before-drag');
      } else if (req.url === '/after-drag') {
        await until(
          async () => (await observe()).x > beforeDrag.x + 80,
          'Native drag did not move the guest window',
        );
        afterDrag = await observe();
        assert.equal(afterDrag.pressed, false);
        assert.equal(afterDrag.text, 'hello from my iPhone.\nSecond line');
        await capture('dragged');
        check('Native touch drag moves the real guest window and releases the mouse');
      } else if (req.url === '/zoomed') {
        await capture('zoomed');
      } else if (req.url === '/reopened') {
        const state = await observe();
        assert.equal(state.x, afterDrag.x);
        assert.equal(state.y, afterDrag.y);
        assert.equal(state.text, afterDrag.text);
        assert.equal(computer.controller, 'owner');
        assert.equal((await computer.runtime.inspect()).State.Paused, true);
        await capture('reopened');
        check('Complete iPhone app relaunch retains the same owner desktop and unsaved text');
      } else if (req.url === '/verify') {
        assert.equal(computer.controller, 'agent');
        assert.equal((await computer.runtime.inspect()).State.Paused, false);
        assert.deepEqual(f.store.read().messages, before);
        assert.equal(f.requests.length, 0);
        await capture('chat');
        check(
          'One-tap handback from native chat restores agent control and preserves the Main draft with no model calls or synthetic messages',
        );
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
      `../../work/computer-${feature}-native-${platform}-${Date.now()}.xcresult`,
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
      ...(clipboard
        ? ['-only-testing:RelayShareUITests/ConnectionUITests/testComputerClipboardRoundTrip']
        : [
            '-only-testing:RelayShareUITests/ConnectionUITests/testDirectComputerInputAndRelaunch',
            ...(liveKeyboard
              ? []
              : [
                  '-only-testing:RelayShareUITests/ConnectionUITests/testFocusedSettingsAndSearch',
                  '-only-testing:RelayShareUITests/ConnectionUITests/testPastedImageStaysInDraft',
                ]),
          ]),
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
  assert.equal(code, 0, `Inspect native input log: ${log}`);
  assert.equal(checks.length, clipboard ? 1 : liveKeyboard ? 5 : 6);
  if (!clipboard && !liveKeyboard)
    check(
      'Refreshed bundled iPhone interface passes search, focused Settings, draft preservation and full relaunch',
    );
  await writeFile(
    join(evidence, `computer-${feature}-native-${platform}-acceptance.json`),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        device,
        formFactor: deviceLabel,
        orientations: tablet ? ['landscape', 'portrait'] : ['portrait'],
        resultBundle: bundle,
        log,
        checks,
        limits: [
          `Actual ${deviceLabel} Simulator, not physical devices or iPad window multitasking`,
          'Local fictional editor and controlled server; no live model or account',
          'Native keyboard text and touch gestures; not all OS input methods',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  if (device) await capture('failure').catch(() => {});
  throw error;
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  if (computer) {
    await computer.stop().catch(() => {});
    await computer.dockerRun(['rm', '-f', computer.name, computer.runtime.name]).catch(() => {});
    await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
    await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  }
  await f?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
