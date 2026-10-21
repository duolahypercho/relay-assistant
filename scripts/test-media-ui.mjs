// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { mediaFixture } from './media-fixture.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-media-'));
    const f = await mediaFixture(directory);
    let app, context, page;
    try {
      if (native) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByLabel('Message Relay', { exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('What does my recording say?');
      await page.locator('.composer input[type=file]').setInputFiles([
        { name: 'Lunch.wav', mimeType: 'audio/wav', buffer: f.audio },
        { name: 'Garden.mp4', mimeType: 'video/mp4', buffer: f.video },
      ]);
      const draft = page.locator('.composer .draft-attachments');
      await expect(
        draft.getByRole('button', { name: 'Open Lunch.wav', exact: true }),
      ).toBeVisible();
      expect(f.requests).toHaveLength(0);
      expect(f.transcriptions).toHaveLength(0);
      await draft.getByRole('button', { name: 'Open Garden.mp4', exact: true }).click();
      const dialog = page.getByRole('region', { name: 'File preview', exact: true });
      await expect
        .poll(() =>
          dialog
            .locator('video')
            .evaluate((x) => ({ ready: x.readyState, width: x.videoWidth, duration: x.duration })),
        )
        .toMatchObject({ width: 320, duration: 12 });
      expect(await dialog.locator('video').evaluate((x) => x.paused)).toBe(true);
      await dialog.getByRole('button', { name: 'Play Garden.mp4', exact: true }).click();
      await expect
        .poll(() => dialog.locator('video').evaluate((x) => x.currentTime))
        .toBeGreaterThan(0.2);
      await dialog.getByRole('button', { name: 'Pause Garden.mp4', exact: true }).click();
      const seek = dialog.getByRole('slider', { name: 'Garden.mp4 position', exact: true });
      await seek.focus();
      await seek.press('Home');
      await seek.press('ArrowRight');
      await expect
        .poll(() => dialog.locator('video').evaluate((x) => x.currentTime))
        .toBeGreaterThan(0);
      await dialog.getByRole('button', { name: 'Mute Garden.mp4', exact: true }).click();
      expect(await dialog.locator('video').evaluate((x) => x.muted)).toBe(true);
      const oldUrl = await dialog.locator('video').getAttribute('src');
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      expect(
        await page.evaluate(async (url) => {
          try {
            await fetch(url);
            return true;
          } catch {
            return false;
          }
        }, oldUrl),
      ).toBe(false);
      await expect(composer).toHaveValue('What does my recording say?');
      expect(f.store.read().messages).toHaveLength(0);
      await page.reload();
      await expect(
        draft.getByRole('button', { name: 'Open Garden.mp4', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('Your recording says: a quiet lunch at noon, followed by a walk.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(f.transcriptions).toHaveLength(1);
      expect(f.transcriptions[0].equals(f.audio)).toBe(true);
      expect(JSON.stringify(f.requests)).toContain('untrusted source data');
      const sent = page.locator('.message.user .attachment-media'),
        source = page
          .locator('.message.assistant')
          .getByRole('group', { name: 'Sources', exact: true });
      await expect(sent.locator('video')).toHaveCount(1);
      await expect(sent.locator('audio')).toHaveCount(1);
      await expect(page.locator('.message.assistant .attachment-media')).toHaveCount(0);
      await source.getByRole('button', { name: 'Lunch.wav', exact: true }).click();
      await expect(dialog.locator('audio')).toHaveCount(1);
      await expect.poll(() => dialog.locator('audio').evaluate((x) => x.duration)).toBe(12);
      expect(await dialog.locator('audio').evaluate((x) => x.paused)).toBe(true);
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await composer.fill('Keep my next thought');
      const messageCount = f.store.read().messages.length,
        requestCount = f.requests.length;
      await sent.getByRole('button', { name: 'Play Garden.mp4', exact: true }).click();
      await expect
        .poll(() => sent.locator('video').evaluate((x) => x.currentTime))
        .toBeGreaterThan(0.2);
      await sent.getByRole('button', { name: 'Play Lunch.wav', exact: true }).click();
      await expect
        .poll(() => sent.locator('audio').evaluate((x) => x.currentTime))
        .toBeGreaterThan(0.2);
      expect(await sent.locator('video').evaluate((x) => x.paused)).toBe(true);
      await sent.getByRole('button', { name: 'Open Lunch.wav', exact: true }).click();
      await expect.poll(() => sent.locator('audio').evaluate((x) => x.paused)).toBe(true);
      await dialog.getByRole('button', { name: 'Play Lunch.wav', exact: true }).click();
      await expect
        .poll(() => dialog.locator('audio').evaluate((x) => x.currentTime))
        .toBeGreaterThan(0.2);
      let path;
      if (app) {
        path = join(directory, 'download.wav');
        await app.evaluate(({ app, BrowserWindow }, path) => {
          app.mediaDownload = '';
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => {
              item.setSavePath(path);
              item.once('done', (_e, state) => (app.mediaDownload = state));
            },
          );
        }, path);
        await dialog.getByRole('link', { name: 'Download', exact: true }).click();
        await expect.poll(() => app.evaluate(({ app }) => app.mediaDownload)).toBe('completed');
      } else {
        const event = page.waitForEvent('download');
        await dialog.getByRole('link', { name: 'Download', exact: true }).click();
        path = await (await event).path();
      }
      expect((await readFile(path)).equals(f.audio)).toBe(true);
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await sent.getByRole('button', { name: 'Play Lunch.wav', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Workspace shortcuts' })
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await expect.poll(() => sent.locator('audio').evaluate((x) => x.paused)).toBe(true);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought');
      await sent.getByRole('button', { name: 'Play Garden.mp4', exact: true }).click();
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(await sent.locator('video').evaluate((x) => x.paused)).toBe(true);
      await page.evaluate(() => {
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(f.store.read().messages).toHaveLength(messageCount);
      expect(f.requests).toHaveLength(requestCount);
      await page.screenshot({ path: join(evidence, `media-chat-${surface}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Damaged.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('Not a movie at all'),
      });
      await draft.getByRole('button', { name: 'Open Damaged.mp4', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('cannot play');
      await expect(dialog.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Try playback again', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought');
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'real WAV/MP4 upload, metadata decode and draft reload',
          'inline sent media playback, pause, seek and mute; compact assistant source opens the original audio',
          'exclusive playback, file-modal/navigation/background stop and object URL release',
          'exact bytes downloaded',
          'configured HTTP transcription reaches model as untrusted source',
          'damaged playback fallback/retry and preserved original',
          'draft/history unchanged by viewing',
          'accessibility and viewport fit',
        ],
      });
      console.log(
        `PASS ${surface}: media playback, cleanup, download, audio model read and preserved drafts`,
      );
    } catch (e) {
      if (page) await page.screenshot({ path: join(evidence, `media-failure-${surface}.png`) });
      throw e;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `media-${native ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Real synthetic WAV and locally generated H.264 MP4; isolated real Relay server and independent deterministic transcription/model HTTP endpoints. No microphone or paid-provider quality claim.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
