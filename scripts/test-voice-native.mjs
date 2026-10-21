// Real iPhone WebKit voice journey with synthetic input and independent HTTP providers.
// Creates/deletes its own Simulator, or uses an explicitly supplied diagnostic
// device whose cleanup stays with its caller. No host trust store is modified.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { nativeVoiceFixture } from './native-voice-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'relay-https-native-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const providedDevice = process.env.RELAY_VOICE_TEST_DEVICE;
const streamAudio = process.env.RELAY_NATIVE_VOICE_STREAMING === 'true';
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
  if (providedDevice) {
    const inventory = JSON.parse(
      (await exec('xcrun', ['simctl', 'list', 'devices', '--json'])).stdout,
    );
    const selected = Object.values(inventory.devices)
      .flat()
      .find((d) => d.udid === providedDevice);
    assert(
      selected?.state === 'Booted' && /^Relay Voice Diagnosis \d+$/.test(selected.name),
      'Only an explicitly supplied, booted Relay Voice Diagnosis device may be reused.',
    );
    device = providedDevice;
    console.log(`Using caller-owned diagnostic Simulator ${device}; caller retains cleanup.`);
  } else {
    device = (
      await exec('xcrun', [
        'simctl',
        'create',
        'Relay Voice Call Acceptance',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      ])
    ).stdout.trim();
    console.log(`Booting isolated iPhone Simulator ${device}`);
    await exec('xcrun', ['simctl', 'boot', device]);
    // First boot migration has its own deadline, separate from app acceptance.
    await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 600000 });
  }
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', join(directory, 'ca.pem')]);

  let verified = false;
  f = await nativeVoiceFixture(directory, {
    streamAudio,
    accessKey: 'native-fixture-owner-key-24-characters',
    tls: {
      key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.pem')),
    },
  });
  let mutedPulse = 0,
    mutedRecordings = 0,
    recovery,
    memoBefore,
    navigation;
  async function until(check, label, timeout = 10000) {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw Error(`${label}: ${JSON.stringify(f.report)}`);
      await delay(50);
    }
  }
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/deny') {
        await until(() => f.report.at, 'Synthetic microphone fixture did not load');
        assert.equal(
          f.report.syntheticInstalled,
          true,
          'Synthetic microphone must be installed before starting',
        );
        f.deny(true);
      } else if (req.url === '/allow') {
        f.deny(false);
        assert.equal(f.store.read().voiceCalls?.length || 0, 0);
      } else if (req.url === '/listening') {
        await until(
          () => f.report.tracks?.some((t) => t.state === 'live'),
          'Native capture did not start',
        );
        assert.equal(f.recordings.length, 0);
        assert.equal(f.store.read().voiceCalls.filter((c) => c.status === 'active').length, 1);
      } else if (req.url === '/pulse') f.pulse();
      else if (req.url === '/muted-pulse') {
        mutedRecordings = f.recordings.length;
        mutedPulse = f.pulse();
      } else if (req.url === '/muted-check') {
        await until(() => f.report.completedPulse === mutedPulse, 'Muted sample was not delivered');
        await delay(1200);
        assert.equal(f.recordings.length, mutedRecordings);
        assert(f.report.tracks.filter((t) => t.state === 'live').every((t) => !t.enabled));
      } else if (req.url === '/fail-pulse') {
        f.fail(true);
        f.pulse();
      } else if (req.url === '/retry') f.fail(false);
      else if (req.url === '/ended') {
        await until(
          () =>
            f.report.tracks?.every((t) => t.state === 'ended') &&
            f.report.contexts?.every((c) => c === 'closed'),
          'Capture did not close',
        );
        assert.equal(f.store.read().voiceCalls[0].status, 'ended');
        assert.equal(f.store.read().voiceCalls[0].turns.length, 3);
        assert.equal(f.requests.length, 3);
        assert.equal(f.speaking.length, 3);
        assert.equal(f.recordings.length, 4);
        assert(f.recordings[2].equals(f.recordings[3]), 'Retry must use the same captured PCM');
        assert(f.store.read().voiceCalls[0].epoch >= 2);
      } else if (req.url === '/background') {
        await until(
          () => f.store.read().voiceCalls.every((c) => c.status === 'ended'),
          'Backgrounding did not end the call',
          7000,
        );
      } else if (['/noise-start', '/speech-failure-start'].includes(req.url)) {
        recovery = {
          recordings: f.recordings.length,
          requests: f.requests.length,
          speaking: f.speaking.length,
          playback: f.report.playbackStarts,
          cancellations: f.speechCancellations,
        };
        if (req.url === '/noise-start') f.holdSpeech();
        else f.failSpeech();
        f.pulse();
      } else if (req.url === '/short-noise') {
        await until(() => f.speechHeld, 'Speech was not held', 30000);
        f.pulse(180);
        await until(
          () => f.speechCancellations === recovery.cancellations + 1,
          'Short noise did not cancel the held speech request',
        );
      } else if (req.url === '/recovered') {
        await until(
          () =>
            streamAudio
              ? f.report.playbackStarts > recovery.playback
              : f.report.playbackStarts === recovery.playback + 1,
          'Recovered reply did not start playback',
        );
        assert.equal(f.recordings.length, recovery.recordings + 1);
        assert.equal(f.requests.length, recovery.requests + 1);
        assert.equal(f.speaking.length, recovery.speaking + 2);
        const reply = f.store.read().messages.findLast((m) => m.role === 'assistant' && m.replyTo);
        assert.equal(reply.cards.filter((card) => card.kind === 'voice').length, 1);
      } else if (req.url === '/recovery-ended') {
        await until(
          () => f.report.tracks.every((t) => t.state === 'ended') && f.report.playbackActive === 0,
          'Recovered call did not release capture and playback',
        );
      } else if (req.url === '/memo-ready') {
        await until(() => f.report.memos?.length === 3, 'Saved voice controls did not return');
        assert(f.report.memos.every((m) => m.compact && !m.transcript && m.height <= 56));
        memoBefore = f.requests.length;
      } else if (req.url === '/memo-playing') {
        await until(
          () => f.report.memos?.some((m) => m.playing && m.time > 0.2),
          'Saved recording did not play in native WebKit',
        );
        assert.equal(f.requests.length, memoBefore);
      } else if (req.url === '/memo-stopped') {
        await until(
          () => f.report.memos?.every((m) => !m.playing),
          'Saved recording did not pause',
        );
        assert.equal(f.requests.length, memoBefore);
        assert.equal(f.store.read().threads[0].draft, 'Keep my native voice draft');
      } else if (req.url === '/navigation-start') {
        f.holdWorkspacePage();
        f.holdModel();
        f.pulse();
        await until(() => f.modelHeld, 'Navigation model was not held', 30000);
        const call = f.store.read().voiceCalls.find((c) => c.status === 'active');
        navigation = { callId: call.id, runId: call.turns.at(-1).runId, speech: f.speaking.length };
      } else if (req.url === '/navigation-ended') {
        await until(() => f.workspacePageHeld, 'Destination module was not held');
        await until(
          () =>
            f.store.read().voiceCalls.find((c) => c.id === navigation.callId)?.status === 'ended' &&
            f.store.read().runs.find((r) => r.id === navigation.runId)?.status === 'cancelled',
          'Leaving chat did not end the pending call',
        );
        await until(
          () =>
            f.report.tracks.every((t) => t.state === 'ended') &&
            f.report.contexts.every((c) => c === 'closed'),
          'Navigation retained capture',
        );
        f.releaseModel();
        await until(() => !f.modelHeld, 'Cancelled model fixture did not release');
        assert.equal(f.speaking.length, navigation.speech);
        assert.equal(
          f.store.read().messages.filter((m) => m.id === `voice-summary-${navigation.callId}`)
            .length,
          1,
        );
      } else if (req.url === '/navigation-returned') {
        assert(f.workspacePageHeld, 'Back must work before the destination is released');
        assert.equal(f.store.read().threads[0].draft, 'Keep my native voice draft');
        assert(f.store.read().voiceCalls.every((c) => c.status === 'ended'));
        assert(f.report.tracks.every((t) => t.state === 'ended'));
        f.releaseWorkspacePage();
      } else if (req.url === '/verify') {
        const state = f.store.read();
        assert.equal(state.threads[0].draft, 'Keep my native voice draft');
        assert.equal(state.voiceCalls.length, 5);
        assert(state.voiceCalls.every((c) => c.status === 'ended'));
        assert.equal(state.messages.filter((m) => m.role === 'user').length, 6);
        assert.equal(f.requests.length, 6);
        assert.deepEqual(f.errors, []);
        assert(f.speaking.every((r) => r.input.includes('Native spoken reply')));
        verified = true;
      } else throw Error('Unknown voice control');
      res.end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end('Voice acceptance failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    bundle = resolve(`../../work/voice-native-${stamp}.xcresult`),
    log = resolve(`../../work/voice-native-${stamp}.log`);
  console.log(JSON.stringify({ device, bundle, log }));
  const child = spawn(
    'xcodebuild',
    [
      'test',
      '-project',
      'native/mobile/ios/App/App.xcodeproj',
      '-scheme',
      'ConnectionAcceptance',
      '-only-testing:RelayShareUITests/ConnectionUITests/testNativeVoiceCall',
      '-destination',
      `platform=iOS Simulator,id=${device}`,
      '-parallel-testing-enabled',
      'NO',
      ...(process.env.RELAY_VOICE_DERIVED_DATA
        ? ['-derivedDataPath', resolve(process.env.RELAY_VOICE_DERIVED_DATA)]
        : []),
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
  if (code)
    console.error('Voice fixture diagnostic', {
      report: f.report,
      recordings: f.recordings.length,
      errors: f.errors,
    });
  assert.equal(code, 0, `Inspect native voice acceptance log: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    join(evidence, 'voice-native-ios-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        streamedPcm: streamAudio,
        device,
        resultBundle: bundle,
        log,
        audioRates: { capture: f.report.captureRates, microphone: f.report.microphoneRate },
        checks: [
          'real iPhone WebKit HTTPS sign-in and production voice UI',
          'synthetic microphone denial and recovery without requesting hardware access',
          'real Web Audio segmentation and captured 16 kHz PCM to HTTP transcription',
          'selected chat model, generated memo bytes and actual AudioBufferSource playback',
          'spoken interruption, button interruption and muted sample exclusion',
          'failed transcription retried with identical PCM and one committed turn',
          'End closes tracks and audio contexts; background ends the active call',
          'full relaunch preserves draft and history without reopening capture',
          'rejected short noise during synthesis resumes one completed reply without an extra transcription/model call',
          'failed synthesis retries with Keep talking, one voice card and no repeated assistant work',
          'compact saved audio plays and pauses after relaunch without repeating its transcript or requesting the model',
          'Back to chat remains usable before a held page loads; capture ends, pending work cancels and the draft returns without restarting the call',
        ],
        limits:
          'Synthetic microphone and controlled model/transcription/speech responses in an iOS Simulator. Does not certify hardware permissions, acoustic echo, physical devices, Bluetooth, Android or live-provider quality.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: native voice turns, playback, interruption, mute, retry, background and relaunch',
  );
} catch (error) {
  await writeFile(
    join(evidence, 'voice-native-ios-failure.json'),
    JSON.stringify(
      {
        passed: false,
        checkedAt: new Date().toISOString(),
        device,
        error: error.stack,
        report: f?.report,
        recordings: f?.recordings.length,
        modelRequests: f?.requests.length,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  await f?.close();
  if (device && !providedDevice) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await rm(directory, { recursive: true, force: true });
}
