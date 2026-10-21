import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { videoReaderFixture, videoQuestion, videoAnswer } from './video-reader-fixture.mjs';
const mac = process.argv.includes('--mac');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const desktopLabel = process.env.RELAY_DESKTOP_TEST_LABEL || 'native-mac';
if (!/^[a-z0-9-]{1,40}$/.test(desktopLabel)) throw Error('Use a simple desktop test label.');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? desktopLabel : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-video-reader-'));
    const f = await videoReaderFixture(directory);
    let app, context, page;
    try {
      if (mac) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            process.env.RELAY_DESKTOP_EXECUTABLE ||
              'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
          chromiumSandbox: true,
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
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill(videoQuestion);
      await page
        .getByRole('navigation', { name: 'Workspace shortcuts' })
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await page
        .locator('.file-tile')
        .filter({ has: page.getByText('Color study.mp4', { exact: true }) })
        .click();
      await expect(page.getByRole('region', { name: 'File preview', exact: true })).toBeVisible();
      await expect
        .poll(() => page.locator('video').evaluate((el) => el.readyState))
        .toBeGreaterThan(0);
      expect(await page.locator('video').evaluate((el) => el.paused)).toBe(true);
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(composer).toHaveValue(videoQuestion);
      await page.reload();
      await expect(composer).toHaveValue(videoQuestion);
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('Color study.mp4');
      expect(f.requests).toHaveLength(0);
      expect(f.transcriptions).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.locator('.messages').getByText(videoAnswer, { exact: true })).toBeVisible({
        timeout: 40000,
      });
      expect(f.errors).toEqual([]);
      expect(f.frames).toHaveLength(3);
      expect(f.transcriptions).toHaveLength(1);
      const state = f.store.read();
      expect(state.messages).toHaveLength(2);
      expect(state.messages.at(-1).cards.filter((c) => c.kind === 'file')).toHaveLength(1);
      expect(state.files).toHaveLength(1);
      expect(state.files[0].base64).toBe(f.bytes.toString('base64'));
      await page.screenshot({
        path: join(evidence, `video-reader-answer-${surface}.png`),
        animations: 'disabled',
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        frames: f.frames.length,
        audioSegments: f.transcriptions.length,
        checks: [
          'preview does not decode for model or transcribe',
          'Ask about this and draft reload',
          'actual timestamped pixels and decoded audio reach independent services',
          'unchanged source and one file card',
          'accessibility and viewport fit',
        ],
      });
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `video-reader-${mac ? desktopLabel : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Controlled HTTP model and transcription service verify real decoded bytes and transport, not live visual/speech accuracy.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser?.close();
}
