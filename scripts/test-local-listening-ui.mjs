// SPDX-License-Identifier: MIT
// Real whisper.cpp inference; synthetic spoken input; controlled chat response.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { localListeningFixture } from './local-listening-fixture.mjs';
import { listeningMicrophoneScript } from './listening-microphone-fixture.mjs';
const native = process.argv.includes('--mac'),
  live = process.argv.includes('--live');
const bytes = await readFile(resolve('../../work/local-listening-research/probe.wav'));
const script = listeningMicrophoneScript(bytes.toString('base64'));
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'own-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-local-listening-acceptance-'));
    const f = await localListeningFixture(directory, { live });
    let app,
      context,
      page,
      port = '0';
    const errors = [];
    async function launch() {
      app = await electron.launch({
        executablePath: resolve(
          'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
        ),
        args: [`--relay-test-data=${join(directory, 'native')}`, `--relay-local-port=${port}`],
        env: {
          ...process.env,
          RELAY_DESKTOP_ENV: '',
          RELAY_MODE: 'live',
          RELAY_ACCESS_KEY: '',
          RELAY_MODEL_BASE_URL: '',
          RELAY_MODEL_ID: '',
          RELAY_MODEL_API_KEY: '',
          RELAY_TRANSCRIPTION_BASE_URL: '',
          RELAY_TRANSCRIPTION_MODEL: '',
          RELAY_TRANSCRIPTION_API_KEY: '',
          RELAY_SPEECH_BASE_URL: '',
          RELAY_SPEECH_MODEL: '',
          RELAY_SPEECH_API_KEY: '',
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
          RELAY_DESKTOP_ENABLED: 'false',
          RELAY_BROWSER_ENABLED: 'false',
          RELAY_COMPUTER_ENABLED: 'false',
        },
      });
      page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => window.hide()),
      );
      await expect(page.getByRole('textbox', { name: 'Message Relay', exact: true })).toBeVisible({
        timeout: 30000,
      });
      port = new URL(page.url()).port;
      page.setDefaultTimeout(20000);
      page.on('pageerror', (e) => errors.push(e.message));
    }
    const api = (path, body) =>
      page.evaluate(
        async ({ path, body }) => {
          const response = await fetch(
            '/api/' + path,
            body
              ? {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                }
              : {},
          );
          if (!response.ok) throw Error(path + ': ' + response.status);
          return response.json();
        },
        { path, body },
      );
    const nav = (hash) =>
      page.evaluate((hash) => {
        location.hash = hash;
      }, hash);
    try {
      if (native) {
        await launch();
        await api('models/save', {
          preset: 'custom',
          protocol: 'chat',
          baseUrl: f.baseUrl,
          model: 'controlled-chat',
          name: 'Test chat',
          apiKey: '',
        });
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(f.url);
      }
      const composer = () => page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer().fill('Keep my listening draft.');
      await nav('#settings?section=voice');
      const panel = () => page.getByRole('article', { name: 'Voice settings', exact: true });
      await panel().getByText('Voice options', { exact: true }).click();
      await expect(
        panel().getByRole('button', { name: 'Set up local listening', exact: true }),
      ).toBeVisible();
      expect((await api('voice-connections')).transcription.mode).toBe('off');
      if (!native) {
        f.listeningControls.hold = true;
        await panel().getByRole('button', { name: 'Set up local listening', exact: true }).click();
        await expect(panel().getByRole('button', { name: 'Cancel listening setup' })).toBeVisible();
        await page.reload();
        await panel().getByText('Voice options', { exact: true }).click();
        await panel().getByRole('button', { name: 'Cancel listening setup' }).click();
        await expect(
          panel().getByRole('button', { name: 'Continue listening setup' }),
        ).toBeVisible();
        expect((await api('voice-connections')).transcription.mode).toBe('off');
        f.listeningControls.hold = false;
      }
      const started = Date.now();
      await panel()
        .getByRole('button', {
          name: native ? 'Set up local listening' : 'Continue listening setup',
          exact: true,
        })
        .click();
      await nav('#chat');
      await expect(composer()).toHaveValue('Keep my listening draft.');
      await expect
        .poll(async () => (await api('voice-connections/local')).installed, {
          timeout: 240000,
          intervals: [1000],
        })
        .toBe(true);
      await expect
        .poll(async () => (await api('voice-connections')).transcription.mode)
        .toBe('local');
      const installMs = Date.now() - started;
      expect((await api('state')).messages).toHaveLength(0);
      await nav('#settings?section=voice');
      await expect(panel().getByLabel('Listening connection', { exact: true })).toHaveValue(
        'local',
      );
      await panel().getByRole('button', { name: 'Use Mac voice', exact: true }).click();
      await expect(panel().getByText('Voice is ready.', { exact: true })).toBeVisible();
      const options = panel().locator('details.voice-options');
      if ((await options.count()) && (await options.getAttribute('open')) === null)
        await options.locator('summary').click();
      await expect(panel().getByLabel('Speaking connection', { exact: true })).toHaveValue(
        'system',
      );
      await page.screenshot({
        path: resolve(`../relay-evidence/local-listening-${label}-setup.png`),
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await panel().getByLabel('Listening connection', { exact: true }).selectOption('off');
      await page.reload();
      expect((await api('state')).connections.runtime.transcription.configured).toBe(false);
      await panel().getByRole('button', { name: 'Use local listening', exact: true }).click();
      await nav('#chat');
      await expect(composer()).toHaveValue('Keep my listening draft.');
      await page.evaluate(script);
      await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
      const input = page.getByRole('region', { name: 'Voice input', exact: true });
      await expect(input.getByRole('status')).toHaveText('Listening…');
      await page.evaluate(() => window.__listeningQA.pulse());
      const heardAt = Date.now();
      await input.getByRole('button', { name: 'Done recording', exact: true }).click();
      await expect(composer()).toHaveValue(
        /Keep my listening draft\. .*water the plants tomorrow morning/i,
        { timeout: 75000 },
      );
      const transcript = await composer().inputValue(),
        recognitionMs = Date.now() - heardAt;
      expect((await api('state')).messages).toHaveLength(0);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__listeningQA.streams.every((s) =>
              s.getTracks().every((t) => t.readyState === 'ended'),
            ),
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: resolve(`../relay-evidence/local-listening-${label}-dictation.png`),
      });
      // Cancellation leaves the typed draft; silence reports no speech and remains retryable.
      await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
      await expect(input.getByRole('status')).toHaveText('Listening…');
      await input.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
      await expect(composer()).toHaveValue(transcript);
      await composer().fill('');
      await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
      const call = page.getByRole('region', { name: 'Voice chat', exact: true });
      await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 15000 });
      await composer().fill('Keep my voice chat draft.');
      await page.evaluate(() => window.__listeningQA.pulse());
      await expect(call.getByRole('status')).toHaveText('Relay is speaking', { timeout: 75000 });
      await expect(page.locator('.message.user .message-content').last()).toContainText(
        /water the plants tomorrow morning/i,
      );
      await expect(page.locator('.message.assistant .message-content').last()).toContainText(
        'Take a short walk',
      );
      await expect(call.getByRole('status')).toHaveText('Listening', { timeout: 30000 });
      await call.getByRole('button', { name: 'End call', exact: true }).click();
      await expect(composer()).toHaveValue('Keep my voice chat draft.');
      const state = await api('state');
      expect(state.voiceCalls.at(-1).turns).toHaveLength(1);
      expect(state.voiceCalls.at(-1).status).toBe('ended');
      expect(f.requests.filter((r) => r.kind !== 'chat')).toHaveLength(0);
      if (native) {
        await app.close();
        app = null;
        await launch();
        expect((await api('voice-connections')).transcription.mode).toBe('local');
        await expect(composer()).toHaveValue('Keep my voice chat draft.');
        const replay = await page.evaluate(async (data) => {
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const response = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: bytes,
          });
          return { status: response.status, ...(await response.json()) };
        }, bytes.toString('base64'));
        expect(replay.status).toBe(200);
        expect(replay.text).toMatch(/water the plants tomorrow morning/i);
      } else {
        await page.reload();
        await expect(composer()).toHaveValue('Keep my voice chat draft.');
        expect(
          (await readdir(directory)).filter((p) => p.startsWith('relay-local-audio-')),
        ).toHaveLength(0);
      }
      expect(errors).toEqual([]);
      checks.push({
        label,
        installMs,
        recognitionMs,
        transcript,
        oneSpokenTurn: true,
        historyPreserved: true,
        originalDraftPreserved: true,
        errors,
        realRecognizer: true,
        officialDownload: native || live,
      });
      console.log('PASS', label, { installMs, recognitionMs });
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    resolve(
      `../relay-evidence/local-listening-${native ? 'own-mac' : live ? 'live-ui' : 'ui'}-acceptance.json`,
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Synthetic spoken microphone input; real whisper.cpp recognition and Mac speech. Chat response controlled. No hardware-microphone, ambient-noise, Bluetooth or physical-device quality claim.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
