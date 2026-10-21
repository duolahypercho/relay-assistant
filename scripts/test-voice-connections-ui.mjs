// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { voiceConnectionsFixture } from './voice-connections-fixture.mjs';
import { audioFixture } from './audio-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const native = process.env.RELAY_VOICE_SETUP_NATIVE === 'true';
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-voice-setup-ui-'));
    const f = await voiceConnectionsFixture(directory);
    const nativeDir = join(directory, 'native');
    let application, context;
    try {
      if (native) {
        await mkdir(nativeDir);
        await writeFile(join(nativeDir, 'desktop.json'), JSON.stringify({ server: f.url }));
        application = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${nativeDir}`],
        });
      } else
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
      const page = application ? await application.firstWindow() : await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      if (application) await expect(composer).toBeVisible({ timeout: 20000 });
      else await page.goto(f.url);
      await composer.fill('Keep my draft while I set up voice');
      await page.goto(f.url + '/#settings?section=voice');
      const panel = page.getByRole('article', { name: 'Voice settings', exact: true });
      await panel.getByRole('button', { name: 'Set up listening', exact: true }).click();
      await panel.getByLabel('Audio endpoint', { exact: true }).fill(f.baseUrl);
      await panel.getByLabel('Audio model', { exact: true }).fill('local-transcriber');
      await panel.getByLabel('Audio API key (optional)', { exact: true }).fill('rejected-key');
      await panel.locator('summary').click();
      await panel
        .getByLabel('Audio test file', { exact: true })
        .setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: audioFixture(0.3) });
      await panel.getByRole('button', { name: 'Test recording', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('HTTP 401');
      await expect(panel.getByRole('alert')).not.toContainText('rejected-key');
      await expect(panel.getByLabel('Audio model', { exact: true })).toHaveValue(
        'local-transcriber',
      );
      await panel.getByLabel('Audio API key (optional)', { exact: true }).fill('private-setup-key');
      await panel.getByRole('button', { name: 'Test recording', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('Heard: Plan a quiet afternoon.');
      await panel.getByRole('button', { name: 'Save listening', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('Listening settings saved.');
      await panel.getByRole('button', { name: 'Set up speaking', exact: true }).click();
      await panel.getByLabel('Audio endpoint', { exact: true }).fill(f.baseUrl);
      await panel.getByLabel('Audio model', { exact: true }).fill('local-speech');
      await panel.getByLabel('Voice ID', { exact: true }).fill('calm');
      await panel.getByLabel('Audio API key (optional)', { exact: true }).fill('private-setup-key');
      await panel.locator('summary').click();
      await panel.getByRole('button', { name: 'Preview voice', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('preview is ready');
      const audio = panel.locator('audio');
      await expect.poll(() => audio.evaluate((el) => el.readyState)).toBeGreaterThan(1);
      await audio.evaluate((el) => el.play());
      await expect.poll(() => audio.evaluate((el) => el.ended)).toBe(true);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `voice-setup-preview-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await panel.getByRole('button', { name: 'Save speaking', exact: true }).click();
      await page.reload();
      await expect(panel.getByLabel('Listening connection', { exact: true })).toHaveValue('saved');
      await expect(panel.getByLabel('Speaking connection', { exact: true })).toHaveValue('saved');
      await panel.getByRole('button', { name: 'Edit speaking', exact: true }).click();
      await expect(panel.getByLabel('Audio API key (optional)', { exact: true })).toHaveValue('');
      await expect(
        panel.getByText('A key is saved. Leave blank to keep it, or enter a replacement.', {
          exact: true,
        }),
      ).toBeVisible();
      await panel.locator('summary').click();
      f.controls.hold = true;
      await panel.getByRole('button', { name: 'Preview voice', exact: true }).click();
      await expect.poll(() => !!f.controls.release).toBe(true);
      await panel.getByRole('button', { name: 'Cancel test', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Test cancelled');
      await expect.poll(() => f.voiceConnections.pending.speech).toBe(0);
      await expect.poll(() => f.controls.aborted).toBe(1);
      f.controls.hold = false;
      f.controls.release();
      await panel.getByRole('button', { name: 'Preview voice', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('preview is ready');
      expect(f.requests.at(-1).key).toBe('Bearer private-setup-key');
      await panel.getByLabel('Audio endpoint', { exact: true }).fill(f.baseUrl + '/new');
      await expect(
        panel.getByText('A key is saved. Leave blank to keep it, or enter a replacement.', {
          exact: true,
        }),
      ).toHaveCount(0);
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await panel.getByLabel('Speaking connection', { exact: true }).selectOption('off');
      await page.reload();
      await expect(panel.getByLabel('Speaking connection', { exact: true })).toHaveValue('off');
      expect(f.services.speech.configured).toBe(false);
      await panel.getByLabel('Speaking connection', { exact: true }).selectOption('saved');
      await expect.poll(() => f.services.speech.configured).toBe(true);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `voice-setup-connected-${label}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name: 'Voice', exact: true })
        .click();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `voice-setup-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.goto(f.url + '/#chat');
      await expect(composer).toHaveValue('Keep my draft while I set up voice');
      expect(f.store.read().messages).toHaveLength(0);
      expect(JSON.stringify(f.store.read())).not.toContain('private-setup-key');
      await page.goto(f.url + '/#settings?section=voice');
      await panel.getByRole('button', { name: 'Edit speaking', exact: true }).click();
      await panel.getByRole('button', { name: 'Forget connection', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('Speaking connection forgotten.');
      expect(f.services.speech.configured).toBe(false);
      expect(f.voiceConnections.publicState().speech.saved).toBe(null);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        scope:
          'Inline setup, transcription upload, WAV preview playback, failure retry, encrypted key retention, abort reaching provider, reload, off/on, removal, unchanged chat history and draft, light/dark accessibility and overflow; controlled HTTP services.',
      });
      console.log(
        `PASS ${label}: voice setup, actual audio HTTP and playback, errors/cancellation, persistence and privacy`,
      );
    } finally {
      await application?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, native ? 'voice-setup-native-mac.json' : 'voice-setup-ui-acceptance.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2),
  );
} finally {
  await browser?.close();
}
