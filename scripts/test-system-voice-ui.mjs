// SPDX-License-Identifier: MIT
// Real installed macOS speech, real playback/storage; controlled chat response only.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { voiceConnectionsFixture } from './voice-connections-fixture.mjs';
if (process.platform !== 'darwin') throw Error('Run on a Mac with its installed system voice.');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const native = process.argv.includes('--mac');
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-system-voice-acceptance-'));
    const f = await voiceConnectionsFixture(directory);
    let application,
      context,
      page,
      localPort = '0';
    const errors = [];
    const launch = async () => {
      application = await electron.launch({
        executablePath: resolve(
          'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
        ),
        args: [`--relay-test-data=${join(directory, 'native')}`, `--relay-local-port=${localPort}`],
        env: {
          ...process.env,
          RELAY_DESKTOP_ENV: '',
          RELAY_MODE: 'live',
          RELAY_ACCESS_KEY: '',
          RELAY_MODEL_BASE_URL: '',
          RELAY_MODEL_ID: '',
          RELAY_MODEL_API_KEY: '',
          RELAY_SPEECH_BASE_URL: '',
          RELAY_SPEECH_MODEL: '',
          RELAY_TRANSCRIPTION_BASE_URL: '',
          RELAY_TRANSCRIPTION_MODEL: '',
          GOOGLE_CLIENT_ID: '',
          GOOGLE_CLIENT_SECRET: '',
          RELAY_DESKTOP_ENABLED: 'false',
          RELAY_BROWSER_ENABLED: 'false',
          RELAY_COMPUTER_ENABLED: 'false',
        },
      });
      const window = await application.firstWindow({ timeout: 30000 });
      window.setDefaultTimeout(20000);
      window.on('pageerror', (e) => errors.push(e.message));
      await expect(
        window.getByRole('textbox', { name: 'Message Relay', exact: true }),
      ).toBeVisible();
      localPort = new URL(window.url()).port;
      return window;
    };
    const api = (path, body) =>
      page.evaluate(
        async ({ path, body }) => {
          const res = await fetch(
            '/api/' + path,
            body
              ? {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                }
              : {},
          );
          if (!res.ok) throw Error('API failed: ' + path + ' ' + res.status);
          return res.json();
        },
        { path, body },
      );
    const navigate = (hash) =>
      page.evaluate((hash) => {
        location.hash = hash;
      }, hash);
    try {
      if (native) {
        page = await launch();
        await api('models/save', {
          preset: 'custom',
          protocol: 'chat',
          baseUrl: f.baseUrl,
          model: 'controlled-chat',
          name: 'Acceptance model',
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
      await composer().fill('Keep my draft while I choose a voice');
      await navigate('#settings?section=voice');
      let panel = page.getByRole('article', { name: 'Voice settings', exact: true });
      const initial = await api('state');
      expect((await api('voice-connections')).speech.mode).toBe('off');
      if (native) await panel.getByText('Voice options', { exact: true }).click();
      await panel.getByRole('button', { name: 'Use Mac voice', exact: true }).click();
      await expect(panel.getByLabel('Speaking connection', { exact: true })).toHaveValue('system');
      expect((await api('state')).messages).toEqual(initial.messages);
      expect((await api('voice-connections')).transcription.configured).toBe(false);
      const started = Date.now();
      await panel.getByRole('button', { name: 'Preview Mac voice', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('Your Mac voice preview is ready.', {
        timeout: 75000,
      });
      const previewMs = Date.now() - started;
      const audio = panel.getByLabel('Voice preview', { exact: true });
      await expect.poll(() => audio.evaluate((el) => el.readyState)).toBeGreaterThan(1);
      const decoded = await audio.evaluate(async (el) => {
        const buffer = await (await fetch(el.src)).arrayBuffer();
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(buffer.slice(0));
          const samples = decoded.getChannelData(0);
          let power = 0;
          for (const value of samples) power += value * value;
          return {
            bytes: buffer.byteLength,
            duration: decoded.duration,
            sampleRate: decoded.sampleRate,
            rms: Math.sqrt(power / samples.length),
          };
        } finally {
          await context.close();
        }
      });
      expect(decoded.duration).toBeGreaterThan(1);
      expect(decoded.rms).toBeGreaterThan(0.001);
      await audio.evaluate((el) => el.play());
      await expect.poll(() => audio.evaluate((el) => el.ended), { timeout: 20000 }).toBe(true);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `system-voice-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      // Cancel an actual process through the UI. The subsequent reply proves recovery.
      await panel.getByRole('button', { name: 'Preview Mac voice', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Cancel test', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Cancel test', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Test cancelled');
      if (!native) await expect.poll(() => f.voiceConnections.systemSpeech.running).toBe(0);
      await panel.getByLabel('Speaking connection', { exact: true }).selectOption('off');
      await page.reload();
      expect((await api('voice-connections')).speech.mode).toBe('off');
      if (native) await panel.getByText('Voice options', { exact: true }).click();
      await panel.getByRole('button', { name: 'Use Mac voice', exact: true }).click();
      await expect(panel.getByLabel('Speaking connection', { exact: true })).toHaveValue('system');
      await navigate('#chat');
      await expect(composer()).toHaveValue('Keep my draft while I choose a voice');
      await composer().fill('Plan a quiet afternoon.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('Take a short walk and enjoy a quiet afternoon.', { exact: true }),
      ).toBeVisible();
      await page
        .locator('.message.assistant')
        .last()
        .getByRole('button', { name: 'Message actions', exact: true })
        .click();
      await page.getByRole('button', { name: 'Create voice memo', exact: true }).click();
      const memo = () => page.getByRole('group', { name: 'Voice memo', exact: true });
      await expect(memo()).toBeVisible({ timeout: 75000 });
      await memo().getByRole('button', { name: 'Play voice memo', exact: true }).click();
      await expect(
        memo().getByRole('button', { name: 'Pause voice memo', exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          () =>
            memo()
              .locator('audio')
              .evaluate((el) => el.ended),
          { timeout: 20000 },
        )
        .toBe(true);
      await expect(memo()).toHaveClass(/voice-memo-inline/);
      await expect(memo().locator('summary')).toHaveCount(0);
      await expect(
        page.getByText('Take a short walk and enjoy a quiet afternoon.', { exact: true }),
      ).toHaveCount(1);
      const saved = await memo()
        .locator('audio')
        .evaluate(async (el) => {
          const res = await fetch(el.src);
          return {
            url: new URL(el.src).pathname,
            mime: res.headers.get('content-type'),
            bytes: [...new Uint8Array(await res.arrayBuffer())],
          };
        });
      expect(saved.mime).toContain('audio/wav');
      await writeFile(join(evidence, `system-voice-reply-${label}.wav`), Buffer.from(saved.bytes));
      await composer().fill('Keep my final voice draft');
      if (native) {
        await application.close();
        application = null;
        page = await launch();
      } else await page.reload();
      await expect(composer()).toHaveValue('Keep my final voice draft');
      expect((await api('voice-connections')).speech.mode).toBe('system');
      const bytesAfter = await page.evaluate(
        async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
        saved.url,
      );
      expect(bytesAfter).toEqual(saved.bytes);
      await expect(memo()).toBeVisible();
      await page.screenshot({ path: join(evidence, `system-voice-reply-${label}.png`) });
      await navigate('#settings?section=personal');
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await navigate('#settings?section=voice');
      panel = page.getByRole('article', { name: 'Voice settings', exact: true });
      await expect(panel.getByLabel('Speaking connection', { exact: true })).toHaveValue('system');
      await panel.scrollIntoViewIfNeeded();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.screenshot({ path: join(evidence, `system-voice-dark-${label}.png`) });
      expect(
        f.requests.filter((r) => r.kind === 'speech' || r.kind === 'transcription'),
      ).toHaveLength(0);
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        previewMs,
        decoded,
        storedBytes: saved.bytes.length,
        scope:
          'Real macOS system voice, no audio provider, preview playback, cancellation, opt-in/Off, no setup history, draft retention, actual memo playback, byte-exact saved audio, restart/reload, light/dark accessibility and overflow.',
        backend: native
          ? 'Packaged Mac app local backend, full quit/relaunch'
          : 'Real Relay test server',
        limits:
          'Chat response controlled. No microphone or transcription test; no audio quality judgment.',
      });
      console.log(
        `PASS ${label}: real system speech, playback and persistence (${previewMs} ms preview)`,
      );
    } finally {
      await application?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, native ? 'system-voice-native-mac.json' : 'system-voice-ui-acceptance.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2),
  );
} finally {
  await browser?.close();
}
