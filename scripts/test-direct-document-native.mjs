// Native WebKit HTTPS, direct text/PDF/Word chat without tools.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { modelCapabilitiesFixture } from './model-capabilities-fixture.mjs';
import { directDocumentFiles, documentFixtureReply } from './direct-document-fixtures.mjs';
import { command } from '../shared/domain.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device, f, control;
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
      'Relay Document Chat Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 180000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await modelCapabilitiesFixture(directory, {
    singleText: true,
    respond: documentFixtureReply,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  f.provider.save({
    preset: 'ollama',
    protocol: 'chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'text-chat',
    activate: true,
  });
  const originals = await directDocumentFiles();
  const files = originals.map((file) =>
    f.store.mutate((s) =>
      command(s, 'file.add', {
        name: file.name,
        mime: file.mimeType,
        base64: file.buffer.toString('base64'),
      }),
    ),
  );
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/previewed') {
        const until = Date.now() + 10000;
        while ((f.store.read().threads[0].draftFileIds || []).length !== 3 && Date.now() < until)
          await delay(50);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.requests.length, 0);
        assert.deepEqual(
          new Set(f.store.read().threads[0].draftFileIds),
          new Set(files.map((f) => f.id)),
        );
      } else if (req.url === '/verify') {
        const until = Date.now() + 20000;
        while (
          (f.requests.length !== 2 || f.store.read().runs.at(-1)?.status !== 'completed') &&
          Date.now() < until
        )
          await delay(50);
        assert.equal(f.requests.length, 2);
        assert.equal(f.store.read().runs.at(-1)?.status, 'completed');
        assert.equal(f.store.read().messages.length, 4);
        for (const body of f.requests) {
          assert.equal(body.tools, undefined);
          const source = JSON.stringify(body);
          for (const fact of ['Meeting code: 7462.', 'Willow library.', 'green notebook.'])
            assert(source.includes(fact));
          assert.equal((source.match(/<attached_document>/g) || []).length, 3);
        }
        for (const file of originals)
          assert.equal(
            f.store.read().files.find((f) => f.name === file.name).base64,
            file.buffer.toString('base64'),
          );
        assert.equal(f.store.read().files.length, 3);
        assert.equal(f.store.read().memories.length, 0);
        await exec('xcrun', [
          'simctl',
          'io',
          device,
          'screenshot',
          join(evidence, 'direct-document-native-ios.png'),
        ]);
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
    bundle = resolve(`../../work/direct-document-native-${stamp}.xcresult`),
    log = resolve(`../../work/direct-document-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testDirectDocumentConversation',
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
  assert.equal(code, 0, `Inspect native document chat acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'direct-document-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'real native WebKit HTTPS text, PDF and Word previews and Ask about this',
          'three selected documents preserve the draft before explicit Send',
          'full app relaunch recovery before Send and before a follow-up',
          'full document text sent without tools, follow-up after relaunch, originals preserved',
        ],
        limits:
          'iOS Simulator with original text, PDF and Word fixtures and an independent deterministic HTTP model. Physical devices, Android, native source-file picking and live model quality remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native direct document chat and follow-up');
} finally {
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
