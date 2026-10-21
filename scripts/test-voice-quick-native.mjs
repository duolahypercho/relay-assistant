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
import { localListeningFixture } from './local-listening-fixture.mjs';
import { listeningMicrophoneScript } from './listening-microphone-fixture.mjs';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidencePrefix = process.env.RELAY_VOICE_EVIDENCE_PREFIX || 'voice-quick';
if (!/^[a-z0-9-]+$/.test(evidencePrefix)) throw Error('Choose a simple voice evidence prefix.');
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
      'Relay Quick Voice Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  console.log(`Booting isolated iPhone Simulator ${device}`);
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false,
    pulse = 0,
    report = {},
    recognition = [];
  const speech = await readFile(resolve('../../work/local-listening-research/probe.wav'));
  const instrument =
    listeningMicrophoneScript(speech.toString('base64')) +
    `
    let lastPulse = null;
    async function listeningReport() {
      try {
        const mode = await (await fetch('/__listening/state')).json();
        const qa = window.__listeningQA;
        if (lastPulse === null) lastPulse = mode.pulse;
        else if (mode.pulse > lastPulse && qa.pulse) { lastPulse = mode.pulse; void qa.pulse(); }
        await fetch('/__listening/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pulse: lastPulse, done: qa.done, playing: qa.playing, streams: qa.streams.map(s => s.getTracks().map(t => t.readyState)), contexts: qa.contexts.map(c => c.state), at: Date.now() }) });
      } catch {}
      setTimeout(listeningReport, 100);
    }
    listeningReport();
  `;
  const html = (await readFile(resolve('dist/index.html'), 'utf8')).replace(
    '<head>',
    '<head><script>' + instrument + '</script>',
  );
  f = await localListeningFixture(directory, {
    accessKey: 'native-fixture-owner-key-24-characters',
    html,
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
    configureApp(app) {
      app.get('/__listening/state', (_req, res) => res.json({ pulse }));
      app.post('/__listening/report', (req, res) => {
        report = req.body;
        res.json({ ok: true });
      });
    },
  });
  const transcribe = f.transcription.transcribe.bind(f.transcription);
  f.transcription.transcribe = async (bytes, mime, signal) => {
    const started = Date.now(),
      result = await transcribe(bytes, mime, signal);
    recognition.push({
      text: result.text,
      mime,
      bytes: bytes.length,
      pcm: bytes.toString('ascii', 0, 4),
      durationMs: Date.now() - started,
    });
    return result;
  };
  async function until(check, label) {
    const end = Date.now() + 30000;
    while (!check()) {
      if (Date.now() > end) throw Error(label + ': ' + JSON.stringify(report));
      await delay(50);
    }
  }
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/before-setup') {
        await until(() => report.at, 'Native audio report not ready');
        assert.equal(report.streams.length, 0);
        assert.equal(report.contexts.length, 0);
        assert.equal((f.store.read().voiceCalls || []).length, 0);
        assert.equal(f.requests.length, 0);
      } else if (req.url === '/installed') {
        assert.equal(f.installation.ready(), true);
        assert.equal(f.voiceConnections.publicState().transcription.mode, 'local');
        assert.equal(f.voiceConnections.publicState().speech.mode, 'system');
        assert.equal(f.store.read().messages.length, 0);
      } else if (req.url === '/pulse') {
        await until(
          () => report.streams?.some((s) => s.includes('live')),
          'Native synthetic microphone not started',
        );
        const prior = report.done;
        pulse++;
        await until(
          () => report.pulse === pulse && report.done > prior && !report.playing,
          'Spoken audio not delivered',
        );
      } else if (req.url === '/dictated') {
        await until(
          () => /water the plants tomorrow morning/i.test(f.store.read().threads[0].draft),
          'Draft not saved',
        );
        assert.match(f.store.read().threads[0].draft, /^Keep my native listening draft\./);
        assert.equal(f.store.read().messages.length, 0);
        assert.equal(recognition.length, 1);
        assert.equal(recognition[0].mime, 'audio/wav');
      } else if (req.url === '/verify') {
        await until(() => f.store.read().voiceCalls?.at(-1)?.status === 'ended', 'Call not ended');
        assert.equal(f.store.read().threads[0].draft, 'Keep my final native listening draft.');
        assert.equal(f.store.read().voiceCalls.at(-1).turns.length, 1);
        assert.equal(recognition.length, 2);
        assert(
          recognition.every(
            (r) => /water the plants tomorrow morning/i.test(r.text) && r.pcm === 'RIFF',
          ),
        );
        assert.equal(f.requests.filter((r) => r.kind !== 'chat').length, 0);
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
    bundle = resolve(`../../work/${evidencePrefix}-native-${stamp}.xcresult`),
    log = resolve(`../../work/${evidencePrefix}-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testLocalVoiceQuickSetup',
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
    join(evidence, `${evidencePrefix}-native-ios-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        device,
        resultBundle: bundle,
        log,
        recognition,
        checks: [
          'Microphone opens Voice setup directly; no capture/call before explicit configured gesture, including full relaunch',
          'Protected native iPhone WebKit setup and local activation without chat messages',
          'Actual AAC/MP4 capture decoded to WAV in WebKit and recognized on the Relay Mac',
          'Dictation appends to the draft without sending and persists through full relaunch',
          'Actual local recognition, controlled chat reply and Mac system speech played in native voice chat',
          'One spoken turn, ended capture and preserved final draft after relaunch',
        ],
        limits:
          'Synthetic original speech input, real recognizer and Mac voice; controlled chat response. iPhone Simulator only. Physical microphones, ambient noise, Bluetooth and Android remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log('PASS: native local listening, dictation, voice chat and relaunch');
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
