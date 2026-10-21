// SPDX-License-Identifier: MIT
// Production UI on an isolated server; synthetic microphone, verified cached local runtime.
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localListeningFixture } from './local-listening-fixture.mjs';
import { listeningMicrophoneScript } from './listening-microphone-fixture.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const native = process.argv.includes('--mac');
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const script =
  listeningMicrophoneScript(
    (await readFile(resolve('../../work/local-listening-research/probe.wav'))).toString('base64'),
  ) +
  `
  window.__entryAudioContexts = 0;
  window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
    window.__entryAudioContexts++;
    return Reflect.construct(target, args);
  } });
`;
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-chat-voice-entry-'));
    const f = await localListeningFixture(directory);
    f.services.provider.select(null);
    let context, app, page;
    const errors = [];
    try {
      if (native) {
        const nativeDir = join(directory, 'native');
        await mkdir(nativeDir);
        await writeFile(join(nativeDir, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${nativeDir}`],
        });
        page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Keep the main draft.');
      const response = await page.request.post(f.url + '/api/command', {
        data: { action: 'thread.create', payload: { title: 'Voice side thought' } },
      });
      const { result: side } = await response.json();
      await page.goto(f.url + '/#chat/' + side.id);
      await page.evaluate(script);
      await composer.fill('Keep my side draft.');
      await page.locator('.chat-pane input[type="file"]').setInputFiles({
        name: 'voice-note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Original setup attachment.'),
      });
      await expect(
        page.getByRole('button', { name: 'Remove attachment', exact: true }),
      ).toBeVisible();
      const noCapture = async () => {
        expect(await page.evaluate(() => window.__listeningQA.streams.length)).toBe(0);
        expect(await page.evaluate(() => window.__listeningQA.contexts.length)).toBe(0);
        expect(await page.evaluate(() => window.__entryAudioContexts)).toBe(0);
        expect(f.store.read().voiceCalls || []).toHaveLength(0);
        expect(f.requests).toHaveLength(0);
      };
      const back = () => page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
      await expect(page).toHaveURL(/#settings\?section=voice$/);
      await expect(page.getByRole('button', { name: 'Set up voice', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Voice input', exact: true })).toHaveCount(0);
      await noCapture();
      expect(f.listeningControls.requests).toBe(0);
      await back();
      await expect(composer).toHaveValue('Keep my side draft.');
      await composer.press('Control+d');
      await expect(page).toHaveURL(/section=voice/);
      await noCapture();
      await page.reload();
      await back();
      await expect(page).toHaveURL(new RegExp('#chat/' + side.id + '$'));
      await expect(composer).toHaveValue('Keep my side draft.');
      await expect(
        page.getByRole('button', { name: 'Remove attachment', exact: true }),
      ).toBeVisible();
      await page.evaluate(script);
      await page.getByRole('button', { name: 'Remove attachment', exact: true }).click();
      await composer.fill('');
      // Calling with both prerequisites missing opens Voice directly, without allocating audio.
      await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
      await expect(page).toHaveURL(/section=voice/);
      await noCapture();
      await page.getByRole('button', { name: 'Set up voice', exact: true }).click();
      await expect(page.getByText('Voice is ready.', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Dictation is ready. Connect an AI model for voice chats.'),
      ).toBeVisible();
      await noCapture();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(`../relay-evidence/chat-voice-entry-${label}-ready.png`),
      });
      await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
      await expect(page).toHaveURL(new RegExp('section=models&fromChat=' + side.id + '$'));
      const connection = f.services.provider.publicState().connections[0];
      await page.getByLabel('Active connection', { exact: true }).selectOption(connection.id);
      await expect(page).toHaveURL(new RegExp('#chat/' + side.id + '$'));
      await noCapture();
      expect(f.store.read().threads.find((t) => t.id === 'main').draft).toBe(
        'Keep the main draft.',
      );
      expect(f.store.read().messages).toHaveLength(0);
      // A fresh gesture starts recording; setup completion alone never starts it.
      await composer.fill('Keep my configured draft.');
      await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
      const input = page.getByRole('region', { name: 'Voice input', exact: true });
      await expect(input.getByRole('status')).toHaveText('Listening…');
      await input.getByRole('button', { name: 'Cancel voice input', exact: true }).click();
      await expect(composer).toHaveValue('Keep my configured draft.');
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__listeningQA.streams.every((s) =>
              s.getTracks().every((t) => t.readyState === 'ended'),
            ),
          ),
        )
        .toBe(true);
      await composer.fill('');
      await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
      const call = page.getByRole('region', { name: 'Voice chat', exact: true });
      await expect(call.getByRole('status')).toHaveText('Listening');
      await call.getByRole('button', { name: 'End call', exact: true }).click();
      await expect.poll(() => f.store.read().voiceCalls.at(-1)?.status).toBe('ended');
      const captures = await page.evaluate(() => window.__listeningQA.streams.length);
      const audioContexts = await page.evaluate(() => window.__entryAudioContexts);
      // With audio configured, only the missing AI connection is requested.
      f.services.provider.select(null);
      await expect(page.getByRole('button', { name: 'Connect AI', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
      await expect(page).toHaveURL(new RegExp('section=models&fromChat=' + side.id + '$'));
      expect(await page.evaluate(() => window.__listeningQA.streams.length)).toBe(captures);
      expect(await page.evaluate(() => window.__entryAudioContexts)).toBe(audioContexts);
      expect(f.store.read().voiceCalls).toHaveLength(1);
      await back();
      // Losing either audio capability routes to Voice, without a dead call panel.
      for (const kind of ['speech', 'transcription']) {
        const voice = f.voiceConnections.publicState();
        f.voiceConnections.update(kind, {
          action: 'select',
          revision: voice[kind].revision,
          mode: 'off',
        });
        await page.reload();
        await page.evaluate(script);
        await page.getByRole('button', { name: 'Start voice chat', exact: true }).click();
        await expect(page).toHaveURL(/section=voice/);
        expect(await page.evaluate(() => window.__listeningQA.streams.length)).toBe(0);
        await expect(page.getByRole('region', { name: 'Voice chat', exact: true })).toHaveCount(0);
        await back();
        f.voiceConnections.update(kind, {
          action: 'select',
          revision: f.voiceConnections.publicState()[kind].revision,
          mode: kind === 'speech' ? 'system' : 'local',
        });
      }
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      expect(errors).toEqual([]);
      checks.push({
        label,
        directDictationSetup: true,
        shortcutMatches: true,
        draftAndAttachmentPreserved: true,
        sideChatReturnsAfterModelSetup: true,
        noAutomaticCaptureOrCall: true,
        missingCapabilityRouting: true,
        configuredCaptureAndEnd: true,
        noExtraMessages: true,
        errors,
      });
      console.log('PASS', label);
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    resolve(`../relay-evidence/chat-voice-entry-${native ? 'mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Synthetic microphone on isolated local server. Entry/setup routing and capture lifecycle; recognition and real speech output have separate acceptance.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
