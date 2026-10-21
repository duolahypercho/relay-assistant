// SPDX-License-Identifier: MIT
// Actual Android WebView audio processing with an explicitly synthetic microphone
// and controlled HTTP services. This does not access or certify hardware audio.
import { _android as android, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeVoiceFixture } from './native-voice-fixture.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const sdk = process.env.ANDROID_HOME,
  serial = process.env.RELAY_ANDROID_TEST_SERIAL;
assert(sdk && /^emulator-\d+$/.test(serial || ''), 'Use a dedicated Relay-QA emulator');
const run = promisify(execFile),
  adbPath = join(sdk, 'platform-tools/adb');
const adb = async (...args) =>
  (await run(adbPath, ['-s', serial, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }))
    .stdout;
const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim();
assert.match(avd, /^Relay-QA-\d+$/);
assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
const apk = resolve('native/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
const apkSha256 = createHash('sha256')
  .update(await readFile(apk))
  .digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'relay-android-voice-'));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence'),
  stamp = Date.now();
await mkdir(evidence, { recursive: true });
const streamAudio = process.env.RELAY_NATIVE_VOICE_STREAMING === 'true';
const f = await nativeVoiceFixture(directory, { streamAudio });
const port = new URL(f.url).port;
let device, page, releasePage;
// This Playwright protocol omits selector timeouts on the Android wire.
// Poll read-only native observations, then issue each tap/fill exactly once.
async function waitNative(selector, { timeout = 15000 } = {}) {
  await expect
    .poll(
      async () => {
        try {
          await device.info(selector);
          return true;
        } catch {
          return false;
        }
      },
      { timeout, intervals: [100, 200, 500] },
    )
    .toBe(true);
}
async function tapNative(selector) {
  await waitNative(selector);
  await device.tap(selector);
}
async function fillNative(selector, value) {
  await waitNative(selector);
  await device.fill(selector, value);
}

const checks = [],
  screenshots = [],
  pixelEvidence = [],
  errors = [];
async function capture(name) {
  const path = join(evidence, `android-voice-${name}-${stamp}.png`);
  await device.screenshot({ path });
  screenshots.push(path);
  // DOM assertions alone can pass while the native display stays blank.
  // Ignore system bars and require actual drawn content in the app's viewport.
  const image = await loadImage(await readFile(path));
  const canvas = createCanvas(image.width, image.height),
    context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(
    0,
    Math.floor(image.height * 0.12),
    image.width,
    Math.floor(image.height * 0.75),
  ).data;
  let drawn = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i] < 210 && pixels[i + 1] < 210 && pixels[i + 2] < 210 && pixels[i + 3] > 0) drawn++;
  pixelEvidence.push({ name, drawnPixels: drawn, sampledPixels: pixels.length / 4 });
  if (drawn < 500) {
    await page?.screenshot({ path: path.replace('.png', '-webview.png') }).catch(() => {});
    throw Error(`Native Android display is blank at ${name}; DOM-only checks are insufficient.`);
  }
}
async function workspace(origin) {
  let last,
    observed = [];
  let pid;
  await expect
    .poll(
      async () => {
        pid = Number((await adb('shell', 'pidof', 'org.relay.assistant').catch(() => '')).trim());
        return Number.isInteger(pid) && pid > 0;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      // Android discovery can retain the terminated process for a short time.
      // Never satisfy relaunch checks using that process's cached DOM.
      const view = device
        .webViews()
        .find((v) => v.pkg() === 'org.relay.assistant' && v.pid() === pid);
      if (!view) {
        await delay(200);
        continue;
      }
      const attached = await view.page();
      const pages = attached
        .context()
        .pages()
        .filter((p) => !p.isClosed());
      observed = pages.map((p) => p.url());
      for (const p of pages) {
        if (origin && !p.url().startsWith(origin)) continue;
        await expect(p.locator('.composer textarea')).toBeVisible({ timeout: 2500 });
        p.setDefaultTimeout(15000);
        return p;
      }
    } catch (error) {
      last = error;
    }
    await delay(200);
  }
  throw Error(
    `Android voice workspace unavailable: ${last?.message || 'waiting for the recreated page'}; observed ${JSON.stringify(observed)}`,
  );
}
const launch = () => adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
try {
  await adb('install', '-r', apk);
  assert.match(await adb('shell', 'pm', 'clear', 'org.relay.assistant'), /Success/);
  await adb('shell', 'cmd', 'locale', 'set-app-locales', 'org.relay.assistant', '--locales', 'en');
  await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  device = (await android.devices()).find((d) => d.serial() === serial);
  assert(device);
  device.setDefaultTimeout(15000);
  await launch();
  page = await workspace();
  // The first native query installs and starts Playwright's instrumentation.
  // Keep that setup outside the short deadlines for owner-facing controls.
  device.setDefaultTimeout(120000);
  try {
    await device.info({ pkg: 'org.relay.assistant' });
  } finally {
    device.setDefaultTimeout(15000);
  }
  await page.evaluate(async () => {
    await window.Capacitor.Plugins.RelayConnection.show({ locale: 'en' });
  });
  await fillNative({ desc: 'Relay server address' }, f.url);
  // The native driver does not preserve case-insensitive regex flags.
  // Use the exact visible action in this locale-pinned fixture.
  await tapNative({ text: 'CONNECT' });
  page = await workspace(f.url);
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => f.report.syntheticInstalled).toBe(true);
  const input = page.locator('.composer textarea');
  const call = page.getByRole('region', { name: 'Voice chat', exact: true });
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
  await expect(call.getByRole('status')).toHaveText('Listening');
  await input.fill('Keep my Android voice draft');
  await page.locator('.composer textarea').blur();
  await adb('shell', 'input', 'keyevent', '111');
  await delay(1200);
  assert.equal(f.recordings.length, 0);
  await capture('listening');
  f.pulse();
  await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 30000 });
  await expect.poll(() => f.report.playbackActive).toBeGreaterThan(0);
  assert.equal(f.recordings.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.speaking.length, 1);
  await capture('speaking');
  checks.push(
    'Synthetic microphone traverses actual Android Web Audio capture, 16 kHz WAV segmentation, HTTP transcription/model/synthesis, saved transcript and native WebView playback; silence sends nothing',
  );
  const epoch = f.store.read().voiceCalls.find((c) => c.status === 'active').epoch;
  f.pulse();
  await expect.poll(() => f.recordings.length, { timeout: 30000 }).toBe(2);
  await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 30000 });
  assert(f.store.read().voiceCalls.find((c) => c.status === 'active').epoch > epoch);
  await call.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect(call.getByRole('status')).toHaveText('Listening');
  await expect.poll(() => f.report.playbackActive).toBe(0);
  await call.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  const pulse = f.pulse();
  await expect.poll(() => f.report.completedPulse).toBe(pulse);
  await delay(1200);
  assert.equal(f.recordings.length, 2);
  await call.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  checks.push(
    'Speaking over the reply advances its cancellation epoch; Interrupt stops playback; Mute suppresses another utterance',
  );
  f.fail(true);
  f.pulse();
  await expect(call.getByRole('alert')).toContainText('503', { timeout: 30000 });
  const failed = f.recordings.at(-1);
  assert.equal(f.recordings.length, 3);
  await capture('retry');
  f.fail(false);
  await call.getByRole('button', { name: 'Retry this turn', exact: true }).click();
  await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 30000 });
  assert.equal(f.recordings.length, 4);
  assert.deepEqual(f.recordings.at(-1), failed);
  assert.equal(f.store.read().voiceCalls.find((c) => c.status === 'active').turns.length, 3);
  const stopsBeforeEnd = f.report.playbackStops;
  await call.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(call).toHaveCount(0);
  await expect.poll(() => f.report.tracks.every((t) => t.state === 'ended')).toBe(true);
  await expect.poll(() => f.report.playbackActive).toBe(0);
  await expect.poll(() => f.report.playbackStops).toBeGreaterThan(stopsBeforeEnd);
  await expect.poll(() => f.report.contexts.every((state) => state === 'closed')).toBe(true);
  await expect(input).toHaveValue('Keep my Android voice draft');
  assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 3);
  checks.push(
    'Inline retry resends identical audio once without a duplicate turn; End stops capture/playback and retains the typed draft',
  );
  await adb('shell', 'am', 'force-stop', 'org.relay.assistant');
  await launch();
  page = await workspace(f.url);
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my Android voice draft');
  await expect(page.getByRole('region', { name: 'Voice chat', exact: true })).toHaveCount(0);
  await expect.poll(() => f.report.tracks.length).toBe(0);
  assert.equal(f.recordings.length, 4);
  assert.equal(f.requests.length, 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(errors, []);
  await capture('relaunch');
  checks.push(
    'Full Android app relaunch restores the draft and transcripts without reopening the microphone or starting another model request',
  );
  const replay = page.getByRole('group', { name: 'Voice memo', exact: true }).last();
  await expect(replay).toHaveClass(/voice-memo-inline/);
  await expect(replay.locator('details')).toHaveCount(0);
  assert((await replay.boundingBox()).height <= 60);
  await replay.getByRole('button', { name: 'Play voice memo', exact: true }).click();
  await expect
    .poll(() => replay.locator('audio').evaluate((audio) => audio.currentTime))
    .toBeGreaterThan(0);
  await replay.getByRole('button', { name: 'Pause voice memo', exact: true }).click();
  await expect.poll(() => replay.locator('audio').evaluate((audio) => audio.paused)).toBe(true);
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my Android voice draft');
  assert.equal(f.requests.length, 3);
  await capture('compact-replay');
  checks.push(
    'Completed spoken replies use compact playback without repeating their transcript; native WebView replay/pause preserves the draft and sends no model request',
  );
  // A second call redirects an in-flight request rather than cancelling its
  // work. Only the old model response is held by the independent HTTP fixture.
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
  const steeringCall = page.getByRole('region', { name: 'Voice chat', exact: true });
  await expect(steeringCall.getByRole('status')).toHaveText('Listening');
  f.holdModel();
  f.pulse();
  await expect.poll(() => f.modelHeld, { timeout: 30000 }).toBe(true);
  const active = f.store.read().voiceCalls.find((c) => c.status === 'active');
  const original = active.turns[0];
  f.pulse();
  await expect
    .poll(() => f.store.read().voiceCalls.find((c) => c.id === active.id).listening, {
      timeout: 10000,
      intervals: [50],
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        f.store
          .read()
          .voiceCalls.find((c) => c.id === active.id)
          .turns.filter((t) => t.runId).length,
      { timeout: 30000 },
    )
    .toBe(2);
  f.releaseModel();
  await expect(steeringCall.getByRole('status')).toHaveText('Relay is speaking', {
    timeout: 30000,
  });
  const updated = f.store.read().voiceCalls.find((c) => c.id === active.id).turns[1];
  assert.equal(updated.runId, original.runId);
  assert.notEqual(updated.messageId, original.messageId);
  assert.equal(f.store.read().runs.find((r) => r.id === original.runId).steeringApplied, 1);
  assert(
    f.store.read().messages.some((m) => m.replyTo === updated.messageId && m.role === 'assistant'),
  );
  assert(
    !f.store
      .read()
      .messages.some((m) => m.replyTo === original.messageId && m.role === 'assistant'),
  );
  await capture('steered-during-work');
  await steeringCall.getByRole('button', { name: 'End call', exact: true }).click();
  await expect.poll(() => f.report.tracks.every((t) => t.state === 'ended')).toBe(true);
  await expect.poll(() => f.report.playbackActive).toBe(0);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(errors, []);
  checks.push(
    'Speaking during an in-flight model request pauses work, redirects the same request, speaks only its corrected reply and preserves the completed-call lifecycle',
  );
  for (const recovery of ['short-noise', 'speech-retry']) {
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await expect(steeringCall.getByRole('status')).toHaveText('Listening');
    const before = {
      recordings: f.recordings.length,
      requests: f.requests.length,
      speaking: f.speaking.length,
      playback: f.report.playbackStarts,
      cancelled: f.speechCancellations,
    };
    if (recovery === 'short-noise') f.holdSpeech();
    else f.failSpeech();
    f.pulse();
    if (recovery === 'short-noise') {
      await expect.poll(() => f.speechHeld, { timeout: 30000 }).toBe(true);
      const pulse = f.pulse(180);
      await expect.poll(() => f.report.completedPulse).toBe(pulse);
      await expect.poll(() => f.speechCancellations).toBe(before.cancelled + 1);
    } else {
      await expect(steeringCall.getByRole('alert')).toContainText('503', { timeout: 30000 });
      await steeringCall.getByRole('button', { name: 'Keep talking', exact: true }).click();
    }
    await expect(steeringCall.getByRole('status')).toHaveText('Relay is speaking', {
      timeout: 30000,
    });
    await expect.poll(() => f.report.playbackStarts).toBeGreaterThan(before.playback);
    if (!streamAudio) assert.equal(f.report.playbackStarts, before.playback + 1);
    assert.equal(f.recordings.length, before.recordings + 1);
    assert.equal(f.requests.length, before.requests + 1);
    assert.equal(f.speaking.length, before.speaking + 2);
    const reply = f.store.read().messages.findLast((m) => m.role === 'assistant' && m.replyTo);
    assert.equal(reply.cards.filter((card) => card.kind === 'voice').length, 1);
    await capture(recovery);
    await steeringCall.getByRole('button', { name: 'End call', exact: true }).click();
    await expect.poll(() => f.report.tracks.every((track) => track.state === 'ended')).toBe(true);
    await expect.poll(() => f.report.playbackActive).toBe(0);
    await expect(page.locator('.composer textarea')).toHaveValue('Keep my Android voice draft');
    checks.push(
      recovery === 'short-noise'
        ? 'A rejected 180 ms audio onset during synthesis resumes the saved reply once, without another transcript or model request'
        : 'Keep talking retries failed speech once, without another transcript, model request or duplicate voice card',
    );
  }
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  let pageHeld = false;
  await page.route(/\/assets\/WorkspacePage-[^/]+\.js$/, async (route) => {
    pageHeld = true;
    await pageGate;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
  await expect(steeringCall.getByRole('status')).toHaveText('Listening');
  f.holdModel();
  f.pulse();
  await expect.poll(() => f.modelHeld, { timeout: 30000 }).toBe(true);
  const leavingCall = f.store.read().voiceCalls.find((call) => call.status === 'active');
  const leavingRun = leavingCall.turns.at(-1).runId;
  const spokenBeforeLeaving = f.speaking.length;
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect.poll(() => pageHeld).toBe(true);
  await expect(steeringCall).toHaveCount(0);
  await expect
    .poll(() => f.store.read().voiceCalls.find((call) => call.id === leavingCall.id).status)
    .toBe('ended');
  await expect
    .poll(() => f.store.read().runs.find((run) => run.id === leavingRun).status)
    .toBe('cancelled');
  await expect.poll(() => f.report.tracks.every((track) => track.state === 'ended')).toBe(true);
  await expect.poll(() => f.report.contexts.every((state) => state === 'closed')).toBe(true);
  f.releaseModel();
  await expect.poll(() => f.modelHeld).toBe(false);
  assert.equal(f.speaking.length, spokenBeforeLeaving);
  await expect(page.getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
  await capture('delayed-page-call-ended');
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my Android voice draft');
  await expect(steeringCall).toHaveCount(0);
  releasePage();
  releasePage = null;
  assert.equal(
    f.store.read().messages.filter((message) => message.id === `voice-summary-${leavingCall.id}`)
      .length,
    1,
  );
  await capture('returned-after-navigation');
  checks.push(
    'A held destination page cannot keep a hidden voice call active: capture closes, pending model work cancels, one summary is saved and Back restores the draft without reopening the call',
  );
  assert.deepEqual(f.errors, []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, `android-voice-${stamp}.json`),
    JSON.stringify(
      {
        passed: true,
        streamedPcm: streamAudio,
        checkedAt: new Date().toISOString(),
        serial,
        avd,
        apk,
        apkSha256,
        checks,
        screenshots,
        pixelEvidence,
        recordings: f.recordings.length,
        modelRequests: f.requests.length,
        spokenReplies: f.speaking.length,
        limits:
          'Dedicated emulator, synthetic microphone and controlled HTTP services. Actual WebView audio processing and UI; no physical microphone, acoustic echo/noise, real speech recognition/model intelligence, Bluetooth, background calling or release-signing claim.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS actual Android voice lifecycle with synthetic audio and controlled services');
} catch (error) {
  if (device) await capture('failure').catch(() => {});
  await writeFile(
    join(evidence, `android-voice-${stamp}.json`),
    JSON.stringify(
      {
        passed: false,
        checkedAt: new Date().toISOString(),
        serial,
        avd,
        apkSha256,
        checks,
        screenshots,
        pixelEvidence,
        error: error.stack,
        fixtureErrors: f.errors,
        lastAudioReport: f.report,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  releasePage?.();
  for (const [index, wav] of f.recordings.entries())
    await writeFile(join(evidence, `android-voice-recording-${stamp}-${index + 1}.wav`), wav);
  await adb('logcat', '-d', '-t', '1500')
    .then((log) => writeFile(join(evidence, `android-voice-logcat-${stamp}.txt`), log))
    .catch(() => {});
  await adb('reverse', '--remove', `tcp:${port}`).catch(() => {});
  await adb('shell', 'am', 'force-stop', 'org.relay.assistant').catch(() => {});
  // End the owned instrumentation transport before disconnecting; current
  // Playwright otherwise leaves its Android driver socket open after success.
  await adb('shell', 'am', 'force-stop', 'com.microsoft.playwright.androiddriver').catch(() => {});
  await device?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
