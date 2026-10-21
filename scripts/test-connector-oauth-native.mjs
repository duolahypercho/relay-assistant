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
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { oauthConnectorFixture } from './connector-oauth-fixture.mjs';
import { appDirectory } from '../server/app-directory.mjs';
const directoryMode =
  process.env.RELAY_APP_DIRECTORY === 'true' || process.argv.includes('--directory');
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control, remote;
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
      'Relay App Sign-in Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  remote = await oauthConnectorFixture();
  f = await assistantsFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    configure(store, services) {
      services.connectors = new Connectors(store, {
        key: modelVaultKey(directory),
        ...(directoryMode
          ? {
              directory: [
                ...appDirectory,
                {
                  id: 'notebook',
                  name: 'Notebook',
                  description: 'An independent notebook for acceptance.',
                  keywords: 'journal notes',
                  endpoint: remote.endpoint,
                  guide: `${new URL(remote.endpoint).origin}/guide`,
                },
              ],
            }
          : {}),
      });
    },
  });
  const before = f.store.read().messages;
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/endpoint') return res.end(remote.endpoint);
      if (req.url === '/unconnected') {
        assert.equal(f.services.connectors.read().length, 0);
        assert.equal(remote.calls.length, 0);
      } else if (req.url === '/verify') {
        const record = f.services.connectors.read()[0];
        assert.equal(record.name, directoryMode ? 'Notebook' : 'Local app');
        assert(record.oauth);
        assert.equal(
          record.tools.every((t) => t.mode === 'ask'),
          true,
        );
        assert.deepEqual(f.store.read().messages, before);
        assert.equal(remote.calls.length, 0);
        assert.equal(remote.exchanges.length, 1);
        assert.equal(remote.exchanges[0].grant_type, 'authorization_code');
        assert(!JSON.stringify(f.services.connectors.publicState()).includes(record.token));
        verified = true;
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Acceptance check failed.');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(
      `../../work/${directoryMode ? 'app-directory' : 'oauth'}-native-${stamp}.xcresult`,
    ),
    log = resolve(`../../work/${directoryMode ? 'app-directory' : 'oauth'}-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      `-only-testing:RelayShareUITests/ConnectionUITests/${directoryMode ? 'testAppDirectorySignInAndToolReview' : 'testAppBrowserSignInAndToolReview'}`,
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
  assert.equal(code, 0, `Inspect native sign-in acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, `${directoryMode ? 'app-directory' : 'app-sign-in'}-native-ios-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          ...(directoryMode
            ? ['search by purpose and select an app without typing its address']
            : []),
          'real WebKit HTTPS with isolated trusted test root',
          'native bridge opens Safari',
          'browser-bound callback without sharing owner cookie',
          'real PKCE code exchange',
          'explicit tool review before connection',
          'unchanged conversation and retained draft',
          'credentials excluded from public state',
        ],
        limits:
          'Independent OAuth provider on iOS Simulator. Physical devices, real vendor accounts and Android remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native Safari app sign-in and tool review');
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  await remote?.close();
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
