// SPDX-License-Identifier: MIT
// Native WebKit capture/encoding -> real Linux CPU recognizer, on trusted HTTPS.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { linuxListeningFixture } from './linux-listening-fixture.mjs';
const exec = promisify(execFile),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
let device,
  f,
  control,
  beforeRestartTransport,
  verified = false;
try {
  f = await linuxListeningFixture();
  device = (
    await exec('xcrun', [
      'simctl',
      'create',
      'Relay Linux Listening Acceptance',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    ])
  ).stdout.trim();
  console.log('Test-owned Simulator', device);
  await exec('xcrun', ['simctl', 'boot', device]);
  await exec('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 360000 });
  await exec('xcrun', ['simctl', 'keychain', device, 'add-root-cert', f.caPath]);
  control = createServer(async (req, res) => {
    try {
      if (req.url === '/credential') return res.end(f.key);
      if (req.url === '/installed') {
        assert.equal((await f.json('/api/voice-connections/local')).installed, true);
        assert.equal((await f.json('/api/voice-connections')).transcription.mode, 'local');
        assert.equal((await f.state()).messages.length, 0);
      } else if (req.url === '/pulse') await f.pulse();
      else if (req.url === '/dictated') {
        await f.until(
          async () => /water the plants tomorrow morning/i.test((await f.state()).threads[0].draft),
          'Native dictation missing',
        );
        const state = await f.state();
        assert.match(state.threads[0].draft, /^Keep my Linux iPhone draft\./);
        assert.equal(state.messages.length, 0);
      } else if (req.url === '/restart') {
        beforeRestartTransport = await f.json('/__linux/state');
        await f.restart();
      } else if (req.url === '/verify') {
        const state = await f.state();
        assert.equal(state.threads[0].draft, 'Keep my final Linux voice draft.');
        assert.equal(state.voiceCalls.at(-1).status, 'ended');
        assert.equal(state.voiceCalls.at(-1).turns.length, 1);
        assert.equal(
          state.messages.filter(
            (m) => m.role === 'user' && /water the plants tomorrow morning/i.test(m.text),
          ).length,
          2,
        );
        assert.equal((await f.json('/api/voice-connections/local')).installed, true);
        assert.equal((await f.json('/api/voice-connections')).transcription.mode, 'local');
        const transport = await f.json('/__linux/state');
        assert.equal(transport.transcriptions, 0);
        assert.equal(beforeRestartTransport.spoken, 1);
        assert.equal(beforeRestartTransport.transcriptions, 0);
        verified = true;
      } else throw Error('Unknown control');
      res.end('ok');
    } catch (error) {
      console.error(error.message);
      res.writeHead(500).end('Acceptance failed');
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const stamp = Date.now(),
    log = resolve(`../../work/linux-listening-native-${stamp}.log`),
    bundle = resolve(`../../work/linux-listening-native-${stamp}.xcresult`);
  console.log(JSON.stringify({ log, bundle }));
  const out = createWriteStream(log),
    child = spawn(
      'xcodebuild',
      [
        'test',
        '-project',
        'native/mobile/ios/App/App.xcodeproj',
        '-scheme',
        'ConnectionAcceptance',
        '-only-testing:RelayShareUITests/ConnectionUITests/testHostedLinuxListening',
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
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const [code] = await once(child, 'exit');
  out.end();
  assert.equal(code, 0, `Native Linux listening failed: ${log}`);
  assert.equal(verified, true);
  await writeFile(
    resolve(evidence, 'linux-listening-native-ios-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        device,
        log,
        bundle,
        checks: [
          'Native iPhone WebKit explicitly downloads the real listening model onto the Linux server',
          'Actual AAC/MP4 capture decoded to WAV in WebKit and recognized by Linux CPU Whisper',
          'Editable dictation and draft survive relaunch without sending',
          'One voice turn with real recognition and controlled chat/speech output',
          'Server container replacement and full native relaunch retain the model, selected listening, session and unsent draft',
        ],
        limits:
          'Synthetic original speech; real recognizer. Test-only microphone instrumentation in HTML, unchanged app assets and Linux engine. iPhone Simulator only; physical devices, microphones, noise, Android and AMD64 runtime remain open.',
      },
      null,
      2,
    ),
  );
  console.log('PASS native iPhone listening on Linux');
} finally {
  if (control) {
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
  }
  if (device) {
    await exec('xcrun', ['simctl', 'shutdown', device]).catch(() => {});
    await exec('xcrun', ['simctl', 'delete', device]);
  }
  await f?.close();
}
