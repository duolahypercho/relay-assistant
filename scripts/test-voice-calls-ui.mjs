// SPDX-License-Identifier: MIT
// Real Web Audio capture/segmentation/playback; controlled HTTP speech and chat responses.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { ModelProvider } from '../server/model.mjs';
import { VoiceConnections } from '../server/voice-connections.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { BackgroundWorker } from '../server/worker.mjs';
import { createApp } from '../server/app.mjs';
import { audioFixture } from './audio-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-voice-call-')),
  evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const requests = { recordings: [], models: [], speech: [] },
  endpoint = express();
let failTranscript = false,
  holdTranscript = false,
  releaseTranscript = null,
  holdNextSpeech = false,
  failNextSpeech = false,
  failNextModel = false,
  releaseSpeech = null,
  cancelledSpeech = 0,
  holdNextModel = false,
  releaseModel = null,
  cancelledModels = 0,
  releasePage = null;
endpoint.post(
  '/v1/audio/transcriptions',
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    requests.recordings.push(req.body);
    if (holdTranscript)
      await new Promise((r) => {
        releaseTranscript = r;
      });
    if (failTranscript) return res.status(503).json({ error: 'Controlled failure' });
    res.json({ text: `Voice request ${requests.recordings.length}: tell me something useful.` });
  },
);
endpoint.use(express.json());
endpoint.post('/v1/audio/speech', async (req, res) => {
  requests.speech.push(req.body);
  if (holdNextSpeech) {
    holdNextSpeech = false;
    await new Promise((resolve) => {
      const cancelled = () => {
        cancelledSpeech++;
        releaseSpeech = null;
        resolve();
      };
      res.once('close', cancelled);
      releaseSpeech = () => {
        res.off('close', cancelled);
        releaseSpeech = null;
        resolve();
      };
    });
    if (res.destroyed) return;
  }
  if (failNextSpeech) {
    failNextSpeech = false;
    return res.status(503).json({ error: 'Controlled speech failure' });
  }
  res.type('audio/wav').send(audioFixture(3));
});
endpoint.post('/v1/chat/completions', async (req, res) => {
  requests.models.push(req.body);
  if (holdNextModel) {
    holdNextModel = false;
    await new Promise((resolve) => {
      const cancelled = () => {
        cancelledModels++;
        releaseModel = null;
        resolve();
      };
      res.once('close', cancelled);
      releaseModel = () => {
        res.off('close', cancelled);
        releaseModel = null;
        resolve();
      };
    });
    if (res.destroyed) return;
  }
  if (failNextModel) {
    failNextModel = false;
    return res.status(400).json({ error: 'Controlled chat failure' });
  }
  res.json({
    choices: [
      {
        message: {
          role: 'assistant',
          content: `Here is your spoken reply ${requests.models.length}. Your conversation stays saved.`,
        },
        finish_reason: 'stop',
      },
    ],
  });
});
const providerServer = endpoint.listen(0, '127.0.0.1');
await once(providerServer, 'listening');
const baseUrl = `http://127.0.0.1:${providerServer.address().port}/v1`,
  store = new Store(join(directory, 'state.sqlite'), { sample: false });
const voiceConnections = new VoiceConnections(store, { key: modelVaultKey(directory) });
const systemVoice = process.env.RELAY_VOICE_CALL_SYSTEM === 'true';
for (const kind of ['transcription', 'speech'])
  voiceConnections.update(kind, {
    revision: 0,
    action: 'save',
    baseUrl,
    model: `controlled-${kind}`,
    voice: 'calm',
    apiKey: '',
  });
if (systemVoice)
  voiceConnections.update('speech', { action: 'select', revision: 1, mode: 'system' });
const services = {
  mode: 'live',
  provider: new ModelProvider({ baseUrl, protocol: 'chat', model: 'controlled-chat' }),
  voiceConnections,
  transcription: voiceConnections.transcription,
  speech: voiceConnections.speech,
  google: { configured: false },
  browser: { enabled: false },
  terminal: { enabled: false },
};
const worker = new BackgroundWorker(store, services, { pollMs: 100 });
services.worker = worker;
const app = createApp(store, services, { host: '127.0.0.1', port: 0, accessKey: '' });
const server = createServer(app);
const development = process.env.RELAY_VOICE_CALL_DEV === 'true';
const vite = development
  ? await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: { server } } })
  : null;
if (vite) app.use(vite.middlewares);
else {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
}
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
worker.start();
const native = process.env.RELAY_VOICE_CALL_NATIVE === 'true',
  nativeData = native ? join(directory, 'native') : null;
if (nativeData) {
  await mkdir(nativeData);
  await writeFile(join(nativeData, 'desktop.json'), JSON.stringify({ server: url }));
}
const application = native
  ? await electron.launch({
      executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
      args: [`--relay-test-data=${nativeData}`],
    })
  : null;
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
async function syntheticMicrophone(page) {
  await page.evaluate(() => {
    window.__voiceTest = { streams: [], played: 0, deny: false, contexts: [] };
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__voiceTest.played++;
      return original.apply(this, args);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      if (window.__voiceTest.deny) throw new DOMException('Denied', 'NotAllowedError');
      if (window.__voiceTest.holdMicrophone)
        await new Promise((resolve) => {
          window.__voiceTest.releaseMicrophone = resolve;
        });
      const context = new AudioContext(),
        tone = context.createOscillator(),
        gain = context.createGain(),
        destination = context.createMediaStreamDestination();
      tone.frequency.value = 320;
      gain.gain.value = 0;
      tone.connect(gain);
      gain.connect(destination);
      tone.start();
      await context.resume();
      window.__voiceTest.gain = gain;
      window.__voiceTest.streams.push(destination.stream);
      window.__voiceTest.contexts.push(context);
      return destination.stream;
    };
  });
}
async function utterance(page) {
  await page.evaluate(() => {
    window.__voiceTest.gain.gain.value = 0.15;
  });
  await expect(
    page.getByRole('region', { name: 'Voice chat', exact: true }).getByRole('status'),
  ).toHaveText('I’m listening…', { timeout: 10000 });
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    window.__voiceTest.gain.gain.value = 0;
  });
}
try {
  for (const mobile of native || development ? [false] : [false, true]) {
    const surface = native
      ? 'native-mac'
      : development
        ? 'development'
        : mobile
          ? 'mobile'
          : 'desktop';
    const label = systemVoice ? `system-${surface}` : surface;
    const page = application
      ? await application.firstWindow()
      : await (
          await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
            isMobile: mobile,
            hasTouch: mobile,
            reducedMotion: 'reduce',
          })
        ).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Electron firstWindow resolves on creation, before its initial loadURL settles.
    // Wait for the app instead of aborting that first navigation with page.goto.
    if (application)
      await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible({
        timeout: 20000,
      });
    else await page.goto(url);
    await syntheticMicrophone(page);
    const input = page.getByRole('textbox', { name: 'Message Relay', exact: true }),
      call = page.getByRole('region', { name: 'Voice chat', exact: true });
    await input.fill('');
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 15000 });
    const callBox = await call.boundingBox(),
      messagesBox = await page.locator('.messages').boundingBox();
    expect(callBox.height).toBeLessThan(102);
    expect(callBox.y + callBox.height).toBeLessThanOrEqual(messagesBox.y);
    const muteBox = await call
      .getByRole('button', { name: 'Mute microphone', exact: true })
      .boundingBox();
    expect(muteBox.width).toBeGreaterThanOrEqual(44);
    expect(muteBox.height).toBeGreaterThanOrEqual(44);
    await input.fill(`Keep my ${label} draft`);
    await input.press('Control+d');
    const initial = requests.recordings.length;
    await page.waitForTimeout(1200);
    expect(requests.recordings.length).toBe(initial);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: join(evidence, `voice-call-listening-${label}.png`) });
    expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual([]);
    await utterance(page);
    await expect(call.getByRole('status')).toHaveText('Relay is speaking', {
      timeout: systemVoice ? 75000 : 15000,
    });
    expect(requests.recordings.length).toBe(initial + 1);
    const recorded = requests.recordings.at(-1);
    expect(recorded.indexOf(Buffer.from('RIFF'))).toBeGreaterThan(0);
    expect(recorded.length).toBeGreaterThan(32000);
    expect(requests.models.at(-1).messages[0].content).toContain('live voice conversation');
    expect(
      requests.models.at(-1).tools?.some((t) => t.function.name === 'create_voice_memo'),
    ).toBeFalsy();
    if (systemVoice) expect(requests.speech).toHaveLength(0);
    else expect(requests.speech.at(-1).input).toContain('Here is your spoken reply');
    const currentReply = store.read().messages.findLast((m) => m.role === 'assistant' && m.replyTo);
    await expect(
      page
        .locator(`#message-${currentReply.id}`)
        .getByRole('group', { name: 'Voice memo', exact: true }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => window.__voiceTest.played)).toBeGreaterThan(0);
    await page.screenshot({ path: join(evidence, `voice-call-speaking-${label}.png`) });
    if (systemVoice)
      await expect
        .poll(
          () =>
            store
              .read()
              .messages.find((m) => m.id === currentReply.id)
              ?.cards?.some((c) => c.kind === 'voice'),
          { timeout: 75000 },
        )
        .toBe(true);
    const beforeBarge = store.read().voiceCalls.find((c) => c.status === 'active');
    await utterance(page);
    await expect(call.getByRole('status')).toHaveText('Relay is speaking', {
      timeout: systemVoice ? 75000 : 15000,
    });
    expect(services.voiceCalls.get(beforeBarge.id).epoch).toBeGreaterThan(beforeBarge.epoch);
    await call.getByRole('button', { name: 'Interrupt', exact: true }).click();
    await expect(call.getByRole('status')).toHaveText('Listening');
    await call.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await page.evaluate(() => {
      window.__voiceTest.gain.gain.value = 0.15;
    });
    await page.waitForTimeout(1400);
    expect(requests.recordings.length).toBe(initial + 2);
    await page.evaluate(() => {
      window.__voiceTest.gain.gain.value = 0;
    });
    await call.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    failTranscript = true;
    await utterance(page);
    await expect(call.getByRole('alert')).toContainText('HTTP 503', { timeout: 15000 });
    failTranscript = false;
    await call.getByRole('button', { name: 'Retry this turn', exact: true }).click();
    await expect(call.getByRole('status')).toHaveText('Relay is speaking', {
      timeout: systemVoice ? 75000 : 15000,
    });
    await expect(input).toHaveValue(`Keep my ${label} draft`);
    const currentCall = store.read().voiceCalls.find((c) => c.status === 'active');
    expect(currentCall.turns.length).toBe(3);
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(call).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Voice input', exact: true })).toHaveCount(0);
    await expect.poll(() => services.voiceCalls.get(currentCall.id).status).toBe('ended');
    await expect(
      page
        .locator(`#message-${currentReply.id}`)
        .getByRole('group', { name: 'Voice memo', exact: true }),
    ).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        window.__voiceTest.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === 'ended'),
        ),
      ),
    ).toBe(true);
    expect(
      store.read().messages.filter((m) => m.id === `voice-summary-${currentCall.id}`),
    ).toHaveLength(1);
    const summary = page
      .locator('.message')
      .filter({ has: page.getByRole('group', { name: 'Voice chat ended', exact: true }) })
      .last();
    await expect(summary).toBeVisible();
    await expect(
      summary.getByRole('button', { name: 'Create voice memo', exact: true }),
    ).toHaveCount(0);
    await expect(summary.getByRole('button', { name: 'Save as skill', exact: true })).toHaveCount(
      0,
    );
    expect(store.read().threads[0].draft).toBe(`Keep my ${label} draft`);
    await page.reload();
    await expect(input).toHaveValue(`Keep my ${label} draft`);
    await expect(call).toHaveCount(0);
    await input.fill('');
    await syntheticMicrophone(page);
    await expect(input).toHaveValue('');
    if (!systemVoice) {
      // A detected onset shorter than the segmenter's minimum utterance must
      // resume the completed reply, without transcribing noise or rerunning work.
      for (const recovery of ['short-noise', 'speech-retry', 'model-failure']) {
        await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
        await expect(call.getByRole('status')).toHaveText('Listening');
        const before = {
          models: requests.models.length,
          recordings: requests.recordings.length,
          speech: requests.speech.length,
          played: await page.evaluate(() => window.__voiceTest.played),
          cancelled: cancelledSpeech,
        };
        holdNextSpeech = recovery === 'short-noise';
        failNextSpeech = recovery === 'speech-retry';
        failNextModel = recovery === 'model-failure';
        await utterance(page);
        if (recovery === 'short-noise') {
          await expect.poll(() => !!releaseSpeech).toBe(true);
          // Schedule on the audio clock; a slow test runner must not turn this
          // deliberately rejected 180 ms onset into a valid spoken turn.
          await page.evaluate(() => {
            const gain = window.__voiceTest.gain;
            const now = gain.context.currentTime;
            gain.gain.setValueAtTime(0.15, now + 0.05);
            gain.gain.setValueAtTime(0, now + 0.23);
          });
          await expect.poll(() => cancelledSpeech).toBe(before.cancelled + 1);
        } else if (recovery === 'speech-retry') {
          await expect(call.getByRole('alert')).toContainText('HTTP 503');
          await call.getByRole('button', { name: 'Keep talking', exact: true }).click();
        } else {
          await expect(call.getByRole('status')).toHaveText('Voice chat paused');
          await expect(call.getByRole('alert')).toBeVisible();
          await call.getByRole('button', { name: 'Keep talking', exact: true }).click();
          await expect(call.getByRole('status')).toHaveText('Listening');
          expect(requests.models.length).toBe(before.models + 1);
          expect(requests.speech.length).toBe(before.speech);
          await utterance(page);
        }
        await expect(call.getByRole('status')).toHaveText('Relay is speaking', {
          timeout: 10000,
        });
        const turns = recovery === 'model-failure' ? 2 : 1;
        expect(requests.models.length).toBe(before.models + turns);
        expect(requests.recordings.length).toBe(before.recordings + turns);
        expect(requests.speech.length).toBe(before.speech + (turns === 2 ? 1 : 2));
        expect(await page.evaluate(() => window.__voiceTest.played)).toBe(before.played + 1);
        const recovered = store
          .read()
          .messages.findLast((m) => m.role === 'assistant' && m.replyTo);
        expect(recovered.cards.filter((c) => c.kind === 'voice')).toHaveLength(1);
        await page.screenshot({ path: join(evidence, `voice-call-${recovery}-${label}.png`) });
        await expect(call.getByRole('status')).toHaveText('Listening');
        await call.getByRole('button', { name: 'End call', exact: true }).click();
        await expect(call).toHaveCount(0);
        checks.push({
          surface: label,
          passed: true,
          check: {
            'short-noise':
              'Rejected short noise during synthesis resumes one completed reply, with no extra transcript or model request.',
            'speech-retry':
              'Speech failure retries the completed reply once, with no repeated assistant work.',
            'model-failure':
              'Keep talking after a failed model response returns to listening and accepts one new spoken request without rerunning the failure.',
          }[recovery],
        });
        console.log(`PASS ${label}: ${recovery} recovery`);
      }
    }
    if (native) {
      await page.screenshot({ path: join(evidence, 'voice-call-native-restart.png') });
      console.log(
        'Native restart state:',
        JSON.stringify({
          runs: store.read().runs.map((r) => ({ status: r.status, voice: !!r.voiceCallId })),
          calls: store.read().voiceCalls.map((c) => c.status),
          controls: await page.getByRole('button').allTextContents(),
        }),
      );
    }
    await page.evaluate(() => {
      window.__voiceTest.deny = true;
    });
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await expect(call.getByRole('alert')).toContainText('Microphone access was not allowed');
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    expect(store.read().voiceCalls.filter((c) => c.status === 'active')).toHaveLength(0);
    await page.evaluate(() => {
      window.__voiceTest.deny = false;
    });
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await expect(call.getByRole('status')).toHaveText('Listening');
    holdTranscript = true;
    await utterance(page);
    await expect.poll(() => !!releaseTranscript).toBe(true);
    const beforeLate = store.read().runs.length;
    await call.getByRole('button', { name: 'End call', exact: true }).click();
    holdTranscript = false;
    releaseTranscript();
    releaseTranscript = null;
    await page.waitForTimeout(350);
    expect(store.read().runs.length).toBe(beforeLate);
    await input.fill(`Keep my ${label} draft`);
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await expect(call.getByRole('status')).toHaveText('Listening');
    const beforeNavigation = store.read().messages.filter((m) => m.role === 'user').length;
    await page.getByRole('button', { name: 'Play voice memo', exact: true }).last().click();
    await expect(call.getByRole('status')).toHaveText('Voice chat paused');
    await call.getByRole('button', { name: 'Keep talking', exact: true }).click();
    await expect(call.getByRole('status')).toHaveText('Listening');
    await expect(page.getByRole('button', { name: 'Pause voice memo', exact: true })).toHaveCount(
      0,
    );
    const pageGate = new Promise((resolve) => {
      releasePage = resolve;
    });
    let pageHeld = false;
    await page.route(
      /\/(?:assets\/WorkspacePage-[^/]+\.js|src\/components\/WorkspacePage\.tsx)(?:\?.*)?$/,
      async (route) => {
        pageHeld = true;
        await pageGate;
        await route.continue().catch(() => {});
      },
    );
    holdNextModel = true;
    await utterance(page);
    await expect.poll(() => !!releaseModel).toBe(true);
    const navigatingCall = store.read().voiceCalls.find((c) => c.status === 'active');
    const navigatingRun = navigatingCall.turns.at(-1).runId;
    const beforeCancel = cancelledModels;
    const speechBeforeNavigation = requests.speech.length;
    const capturesBeforeNavigation = await page.evaluate(() => window.__voiceTest.streams.length);
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect.poll(() => pageHeld).toBe(true);
    await expect(call).toHaveCount(0);
    await expect
      .poll(() => store.read().voiceCalls.filter((c) => c.status === 'active').length)
      .toBe(0);
    await expect
      .poll(() => store.read().runs.find((r) => r.id === navigatingRun)?.status)
      .toBe('cancelled');
    await expect.poll(() => cancelledModels).toBe(beforeCancel + 1);
    expect(
      await page.evaluate(() =>
        window.__voiceTest.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === 'ended'),
        ),
      ),
    ).toBe(true);
    expect(requests.speech.length).toBe(speechBeforeNavigation);
    await expect(page.getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, `voice-call-page-loading-${label}.png`) });
    // Return before the destination chunk is released. A cancelled page load
    // must not resurrect the old call or microphone.
    if (mobile || native)
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    else await page.goBack();
    await expect(input).toBeVisible();
    await expect(call).toHaveCount(0);
    expect(await page.evaluate(() => window.__voiceTest.streams.length)).toBe(
      capturesBeforeNavigation,
    );
    releasePage();
    releasePage = null;
    await expect(input).toHaveValue(`Keep my ${label} draft`);
    expect(store.read().messages.filter((m) => m.role === 'user').length).toBe(
      beforeNavigation + 1,
    );
    expect(
      store.read().messages.filter((m) => m.id === `voice-summary-${navigatingCall.id}`),
    ).toHaveLength(1);
    checks.push({
      surface: label,
      passed: true,
      check:
        'Navigating while a model reply is pending ends capture, cancels the model and saves one summary before a delayed page can load; Back does not reopen the call.',
    });
    console.log(`PASS ${label}: delayed navigation ends the call before the destination loads`);
    const callsBeforePermission = store.read().voiceCalls.length;
    const streamsBeforePermission = await page.evaluate(() => window.__voiceTest.streams.length);
    await page.evaluate(() => {
      window.__voiceTest.holdMicrophone = true;
    });
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => typeof window.__voiceTest.releaseMicrophone))
      .toBe('function');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(call).toHaveCount(0);
    await page.evaluate(() => {
      window.__voiceTest.holdMicrophone = false;
      window.__voiceTest.releaseMicrophone();
      window.__voiceTest.releaseMicrophone = null;
    });
    await expect
      .poll(() => page.evaluate(() => window.__voiceTest.streams.length))
      .toBe(streamsBeforePermission + 1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__voiceTest.streams
            .at(-1)
            .getTracks()
            .every((t) => t.readyState === 'ended'),
        ),
      )
      .toBe(true);
    expect(store.read().voiceCalls.length).toBe(callsBeforePermission);
    await page.goBack();
    await expect(input).toHaveValue(`Keep my ${label} draft`);
    await expect(call).toHaveCount(0);
    checks.push({
      surface: label,
      passed: true,
      check:
        'A microphone permission result arriving after navigation is stopped immediately and creates no call; returning preserves the draft without recording.',
    });
    console.log(`PASS ${label}: late microphone access is stopped after navigation`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    checks.push({
      surface: label,
      passed: true,
      speech: systemVoice
        ? 'Real installed macOS voice; zero speech-provider requests'
        : 'Controlled speech service',
      check:
        'Real Web Audio segmentation, HTTP transcript/model/speech loop, playback, mute, interrupt, failure/retry, draft/reload, microphone denial, late cancellation and cleanup',
    });
    console.log(`PASS ${label}: live voice turns, playback, interruption and cancellation`);
    if (!application) await page.context().close();
  }
  await writeFile(
    join(
      evidence,
      systemVoice
        ? 'system-voice-call-acceptance.json'
        : native
          ? 'voice-call-native-mac.json'
          : development
            ? 'voice-call-development.json'
            : 'voice-call-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope: systemVoice
          ? 'Real macOS speech and browser playback. Synthetic microphone, controlled transcription/chat. No hardware microphone, physical-device or speech-quality claim.'
          : 'Synthetic Web Audio microphone and tone; real browser audio pipeline and worker, controlled HTTP providers. No real speech quality or OS microphone permission claim.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  releaseTranscript?.();
  releaseSpeech?.();
  releaseModel?.();
  releasePage?.();
  if (application) await application.close();
  if (browser) await browser.close();
  await worker.stop();
  await vite?.close();
  for (const listener of [server, providerServer]) {
    listener.closeAllConnections();
    await new Promise((r) => listener.close(r));
  }
  store.close();
  await rm(directory, { recursive: true, force: true });
}
