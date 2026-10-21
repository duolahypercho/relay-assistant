// Real Mac speech on protected HTTPS, native iPhone playback and full relaunch.
// Creates and deletes its own Simulator; no host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { voiceConnectionsFixture } from './voice-connections-fixture.mjs';
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
      'Relay System Voice Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  console.log(`Booting isolated iPhone Simulator ${device}`);
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await voiceConnectionsFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/before') {
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.voiceConnections.speech.configured, false);
      } else if (req.url === '/preview') {
        assert.equal(f.voiceConnections.publicState().speech.mode, 'system');
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(f.store.exportVoiceMemos().length, 0);
        assert.equal(f.voiceConnections.systemSpeech.running, 0);
      } else if (req.url === '/audio' || req.url === '/verify') {
        const deadline = Date.now() + 10000;
        if (req.url === '/verify') {
          while (
            f.store.read().threads.find((t) => t.id === 'main').draft !==
              'Keep my final native voice draft' &&
            Date.now() < deadline
          )
            await delay(50);
          assert.equal(
            f.store.read().threads.find((t) => t.id === 'main').draft,
            'Keep my final native voice draft',
          );
        }
        assert.equal(f.voiceConnections.publicState().speech.mode, 'system');
        assert.equal(f.voiceConnections.transcription.configured, false);
        assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
        assert.equal(f.store.exportVoiceMemos().length, 1);
        const card = f.store
          .read()
          .messages.flatMap((m) => m.cards || [])
          .find((c) => c.kind === 'voice');
        assert.equal(card.transcript, 'Take a short walk and enjoy a quiet afternoon.');
        const memo = f.store.voiceMemo(card.id);
        const audio = Buffer.from(memo.audio);
        assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
        assert(audio.length > 22050);
        assert.equal(
          f.requests.filter((r) => r.kind === 'speech' || r.kind === 'transcription').length,
          0,
        );
        await writeFile(join(evidence, 'system-voice-native-iphone.wav'), audio);
        if (req.url === '/verify') verified = true;
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
    bundle = resolve(`../../work/system-voice-native-${stamp}.xcresult`),
    log = resolve(`../../work/system-voice-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testMacSystemVoiceAndSavedReply',
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
  assert.equal(code, 0, `Inspect native system-voice log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'system-voice-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        checks: [
          'Native iPhone WebKit on a protected HTTPS Relay server',
          'One-button explicit Mac voice selection, real native WAV preview and no setup messages',
          'Real synthesized reply saved with exact transcript and played in WKWebView',
          'Full app relaunch preserves voice selection, playable recording and native typed draft',
          'No speech-service account, audio-provider request or microphone access',
        ],
        limits:
          'Real macOS system speech and iPhone Simulator playback; chat response controlled. Microphones, physical devices and Android runtime remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native system voice, real speech playback and relaunch');
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
