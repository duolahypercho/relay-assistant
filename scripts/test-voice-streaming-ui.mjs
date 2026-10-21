// SPDX-License-Identifier: MIT
// Actual renderer audio scheduling; synthetic microphone and controlled chat.
// --real uses the installed Mac voice. Otherwise the PCM producer is gated.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeVoiceFixture } from './native-voice-fixture.mjs';
import { SystemSpeechService } from '../server/system-speech.mjs';
import { systemPcmLayout } from '../server/system-speech-stream.mjs';
import { audioFixture } from './audio-fixture.mjs';
const native = process.argv.includes('--mac'),
  real = process.argv.includes('--real');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/voice-streaming');
await mkdir(evidence, { recursive: true });
const checks = [],
  timings = [];
let browser, application;
try {
  if (!native) browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-stream-ui-'));
    let release,
      held = false,
      cancelled = 0,
      failAfterAudio = false;
    const bytes = audioFixture(2);
    bytes.writeUInt32LE(22050, 24);
    bytes.writeUInt32LE(44100, 28);
    const system = new SystemSpeechService(
      real
        ? { temporaryRoot: directory }
        : {
            platform: 'darwin',
            exists: () => true,
            temporaryRoot: directory,
            runner: async ({ file, signal }) => {
              const initial = Buffer.from(bytes.subarray(0, 24044));
              initial.writeUInt32LE(36, 4);
              initial.writeUInt32LE(0, 40);
              await writeFile(file, initial);
              held = true;
              await new Promise((resolve) => {
                const abort = () => {
                  cancelled++;
                  resolve();
                };
                signal.addEventListener('abort', abort, { once: true });
                release = () => {
                  signal.removeEventListener('abort', abort);
                  resolve();
                };
              });
              held = false;
              signal.throwIfAborted();
              if (failAfterAudio) {
                failAfterAudio = false;
                throw Error('Controlled interrupted synthesis');
              }
              await writeFile(file, bytes);
            },
          },
    );
    const original = system.synthesize.bind(system);
    system.synthesize = async (text, signal, onAudio) => {
      const start = performance.now(),
        parts = [],
        timing = { surface: label, text };
      timings.push(timing);
      try {
        const result = await original(text, signal, async (part) => {
          timing.firstAudioMs ??= Math.round(performance.now() - start);
          parts.push(part.audio);
          await onAudio(part);
        });
        timing.completeMs = Math.round(performance.now() - start);
        const layout = systemPcmLayout(result, true);
        assert.deepEqual(
          Buffer.concat(parts),
          result.subarray(layout.offset, layout.offset + layout.size),
        );
        timing.exactSamples = true;
        timing.sha256 = createHash('sha256').update(result).digest('hex');
        await writeFile(join(evidence, `${label}-${timings.length}.wav`), result);
        return result;
      } catch (error) {
        timing.error = error.message;
        throw error;
      }
    };
    const f = await nativeVoiceFixture(directory, {
      systemSpeech: system,
      voiceReplyText:
        'Your meeting brief is ready. It includes the time, location, what to bring, and the total cost. You can open the attachment when you are ready, or tell me what you would like to change.',
    });
    let context, page;
    const errors = [];
    try {
      if (native) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        application = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await application.firstWindow();
        context = page.context();
        await page.setViewportSize({ width: 1280, height: 900 });
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        });
        page = await context.newPage();
      }
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(f.url + '/#chat');
      const composer = page.locator('.composer textarea');
      await expect(composer).toBeVisible();
      await expect.poll(() => f.report.syntheticInstalled).toBe(true);
      await composer.fill('Keep my draft while we talk.');
      const call = page.getByRole('region', { name: 'Voice chat', exact: true });
      await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
      await expect(call.getByRole('status')).toHaveText('Listening');
      f.pulse();
      await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 75000 });
      await expect.poll(() => f.report.playbackActive).toBeGreaterThan(0);
      if (!real) {
        assert(held, 'Playback must start while synthesis is still held');
        assert.equal(f.store.exportVoiceMemos().length, 0);
        release();
      }
      await page.screenshot({ path: join(evidence, `${label}-early-playback.png`) });
      await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 75000 });
      assert.equal(f.store.exportVoiceMemos().length, 1);
      assert.equal(f.store.read().runs.length, 1);
      if (real) {
        const timing = timings.at(-1);
        assert(
          timing.firstAudioMs + 250 < timing.completeMs,
          'Real PCM should arrive before complete synthesis',
        );
      }
      checks.push(`${label}: playback starts before synthesis finishes; one exact saved recording`);
      if (!real) {
        // A failed tail stops already queued audio, then retry reuses the completed
        // model answer instead of rerunning the user's work.
        failAfterAudio = true;
        f.pulse();
        await expect(call.getByRole('status')).toHaveText('Relay is speaking');
        release();
        await expect(call.getByRole('alert')).toContainText('could not create');
        await expect.poll(() => f.report.playbackActive).toBe(0);
        assert.equal(f.store.exportVoiceMemos().length, 1);
        const runs = f.store.read().runs.length;
        await call.getByRole('button', { name: 'Keep talking', exact: true }).click();
        await expect(call.getByRole('status')).toHaveText('Relay is speaking');
        release();
        await expect(call.getByRole('status')).toHaveText('Listening');
        assert.equal(f.store.read().runs.length, runs);
        assert.equal(f.store.exportVoiceMemos().length, 2);
        checks.push(
          `${label}: failed audio tail stops playback; retry saves once without rerunning work`,
        );
        f.pulse();
        await expect(call.getByRole('status')).toHaveText('Relay is speaking');
        assert(held);
        await call.getByRole('button', { name: 'End call', exact: true }).click();
        await expect.poll(() => cancelled).toBe(1);
        await expect.poll(() => f.report.playbackActive).toBe(0);
        await expect
          .poll(() => f.report.tracks.every((track) => track.state === 'ended'))
          .toBe(true);
        assert.equal(f.store.exportVoiceMemos().length, 2);
        checks.push(`${label}: End cancels synthesis and all queued playback; no partial memo`);
      } else await call.getByRole('button', { name: 'End call', exact: true }).click();
      await expect(call).toHaveCount(0);
      await expect(composer).toHaveValue('Keep my draft while we talk.');
      await expect(page.locator('.voice-memo-inline').first()).toBeVisible();
      await page.screenshot({ path: join(evidence, `${label}-saved-reply.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS ${label}: ${real ? 'actual Mac speech' : 'gated PCM lifecycle'}`);
    } finally {
      release?.();
      await application?.close();
      application = null;
      if (!native) await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        scope: `${real ? 'Actual Mac speech' : 'Controlled PCM generation'}, real renderer playback; synthetic microphone and controlled chat. No physical acoustic or model-latency claim.`,
        checks,
        timings,
      },
      null,
      2,
    ),
  );
} finally {
  await application?.close();
  await browser?.close();
}
