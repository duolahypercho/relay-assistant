// Real WebKit HTTPS, persistent cookie, UIKit entry, expiry and server recovery.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { request, Agent } from 'node:https';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control, agent;
try {
  await writeFile(
    join(directory, 'ca.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Relay Isolated Acceptance Root\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
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
      'Relay HTTPS Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);
  const key = 'native-fixture-owner-key-24-characters';
  let offline = false,
    verified = false,
    independentCookie = '';
  f = await assistantsFixture(directory, {
    accessKey: key,
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    middleware(req, res, next) {
      if (offline && req.path.startsWith('/api/'))
        res.status(503).json({ error: 'Acceptance outage' });
      else next();
    },
  });
  const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Our weekend' }));
  agent = new Agent({ ca: await readFile(join(directory, 'ca.pem')), rejectUnauthorized: true });
  const post = (path, body) =>
    new Promise((resolve, reject) => {
      const r = request(
        f.url + path,
        {
          method: 'POST',
          agent,
          headers: {
            'Content-Type': 'application/json',
            ...(independentCookie ? { Cookie: independentCookie } : {}),
          },
        },
        (response) => {
          let data = '';
          response.on('data', (b) => (data += b));
          response.on('end', () => {
            if (response.statusCode !== 200) reject(Error(data));
            else resolve({ body: JSON.parse(data), cookie: response.headers['set-cookie']?.[0] });
          });
        },
      );
      r.on('error', reject);
      r.end(JSON.stringify(body));
    });
  // Independent desktop session validates the TLS chain rather than bypassing it.
  const signed = await post('/api/login', { key });
  assert.match(signed.cookie, /Secure/);
  assert.match(signed.cookie, /HttpOnly/);
  independentCookie = signed.cookie.split(';')[0];
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/offline') {
        offline = true;
        f.server.closeAllConnections();
      } else if (req.url === '/online') offline = false;
      else if (req.url === '/wait-draft') {
        for (
          let i = 0;
          i < 100 &&
          f.store.read().threads.find((t) => t.id === side.id).draft !==
            'Keep this native draft while disconnected';
          i++
        )
          await delay(100);
        assert.equal(
          f.store.read().threads.find((t) => t.id === side.id).draft,
          'Keep this native draft while disconnected',
        );
      } else if (req.url === '/expire') {
        f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
        f.store.mutate(() => {});
      } else if (req.url === '/other-device') {
        independentCookie = (await post('/api/login', { key })).cookie.split(';')[0];
        await post('/api/command', {
          action: 'chat.send',
          payload: { threadId: side.id, text: 'A note from the desktop' },
        });
      } else if (req.url === '/verify') {
        assert.equal(
          f.store.read().threads.find((t) => t.id === side.id).draft,
          'Keep this native draft while disconnected',
        );
        const users = f.store.read().messages.filter((m) => m.role === 'user');
        assert.equal(users.length, 1);
        assert.equal(users[0].text, 'A note from the desktop');
        verified = true;
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end('ok');
    } catch (error) {
      console.error(error.message);
      res.writeHead(500).end('Acceptance check failed.');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(`../../work/reconnect-native-${stamp}.xcresult`),
    log = resolve(`../../work/reconnect-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests',
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
    child.on('error', reject);
    child.on('exit', resolve);
  });
  output.end();
  assert.equal(code, 0, `Inspect native HTTPS acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'session-recovery-ios-native-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'actual WebKit HTTPS with isolated trusted test root',
          'Secure HttpOnly server session',
          'persistent native server selection',
          'offline draft automatically saved on recovery',
          'expired session returns to same chat and draft',
          'independently authenticated TLS client update appears in native chat',
          'application restart retains cookie and saved draft',
          'no incidental user messages',
        ],
        limits:
          'Isolated iOS Simulator and controlled server/model. Physical devices, public deployment, Android and release signing remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS native iOS HTTPS, sign-in, outage, session expiry, second device and restart');
} finally {
  agent?.destroy();
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
