// SPDX-License-Identifier: MIT
// Saved audio through actual HTTP storage/playback. Synthetic tones, no microphone.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';
import { audioFixture } from './audio-fixture.mjs';

const native = process.argv.includes('--mac');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/voice-memo');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const report = {
  passed: false,
  checks: [],
  surfaces: [],
  scope:
    'Stored synthetic WAV audio, real playback/download and original chat UI; no provider or physical-audio claim.',
};
try {
  for (const width of native ? [1280] : [1365, 390]) {
    const surface = native ? 'native-mac' : width === 390 ? 'phone-browser' : 'desktop-browser';
    const directory = await mkdtemp(join(tmpdir(), 'relay-voice-memo-'));
    const f = await modelsFixture(directory);
    const wav = audioFixture(12);
    let app, context, page, releasePage;
    const errors = [];
    const compactText = 'The train leaves at 9:20. Your packing list is saved in our chat.';
    const separateText = 'Bring your ticket, a water bottle and a light jacket.';
    f.store.mutate((s) => {
      s.messages = [];
      for (const [id, text, transcript] of [
        ['compact', compactText, compactText],
        ['separate', 'I made a recording of your packing list.', separateText],
        [
          'unavailable',
          'Your conversation stays here even when audio is unavailable.',
          'Your conversation stays here even when audio is unavailable.',
        ],
      ]) {
        s.messages.push({
          id,
          threadId: 'main',
          role: 'assistant',
          text,
          createdAt: new Date().toISOString(),
          cards: [{ kind: 'voice', id, transcript }],
        });
        if (id !== 'unavailable')
          f.store.putVoiceMemo({
            id,
            sourceKey: id,
            transcript,
            audio: wav,
            createdAt: new Date().toISOString(),
          });
      }
    });
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
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.hide()),
        );
      } else {
        context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 1000 },
          acceptDownloads: true,
        });
        page = await context.newPage();
      }
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(f.url + '/#chat');
      const message = (id) => page.locator(`#message-${id}`);
      const memo = (id) => message(id).getByRole('group', { name: 'Voice memo', exact: true });
      const input = page.getByLabel('Message Relay', { exact: true });
      await expect(input).toBeVisible();
      await input.fill('Keep this unfinished travel question');
      await expect(memo('compact')).toHaveClass(/voice-memo-inline/);
      await expect(memo('compact').locator('details')).toHaveCount(0);
      await expect(message('compact').getByText(compactText, { exact: true })).toHaveCount(1);
      await expect(memo('separate')).not.toHaveClass(/voice-memo-inline/);
      await memo('separate').locator('summary').click();
      await expect(memo('separate').getByText(separateText, { exact: true })).toBeVisible();
      await memo('separate').locator('summary').click();
      const compactBox = await memo('compact').boundingBox();
      const fullBox = await memo('separate').boundingBox();
      assert(compactBox.height <= 60 && compactBox.height < fullBox.height / 2);
      for (const selector of ['.voice-memo-play', '.icon-button'])
        assert((await memo('compact').locator(selector).boundingBox()).height >= 44);
      report.surfaces.push({
        surface,
        compactHeight: compactBox.height,
        standaloneHeight: fullBox.height,
      });
      report.checks.push({
        surface,
        passed: true,
        check:
          'Matching replies show one transcript and a compact 44px-control row; different transcripts retain their full recording card.',
      });

      const play = memo('compact').getByRole('button', { name: 'Play voice memo', exact: true });
      await play.focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(() =>
          memo('compact')
            .locator('audio')
            .evaluate((a) => a.currentTime),
        )
        .toBeGreaterThan(0);
      await memo('compact').getByRole('button', { name: 'Pause voice memo', exact: true }).click();
      const position = memo('compact').getByRole('slider', { name: 'Voice memo position' });
      await position.focus();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await expect
        .poll(() =>
          memo('compact')
            .locator('audio')
            .evaluate((a) => a.currentTime),
        )
        .toBeGreaterThan(10);
      await page.keyboard.press('Home');
      await play.click();
      await memo('separate').getByRole('button', { name: 'Play voice memo', exact: true }).click();
      await expect
        .poll(() =>
          memo('compact')
            .locator('audio')
            .evaluate((a) => a.paused),
        )
        .toBe(true);
      await memo('separate').getByRole('button', { name: 'Pause voice memo', exact: true }).click();
      const downloaded = join(directory, 'download.wav');
      if (app) {
        await app.evaluate(({ app, BrowserWindow }, path) => {
          app.memoDownload = '';
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => {
              item.setSavePath(path);
              item.once('done', (_event, state) => {
                app.memoDownload = state;
              });
            },
          );
        }, downloaded);
        await memo('compact')
          .getByRole('link', { name: 'Download voice memo', exact: true })
          .click();
        await expect.poll(() => app.evaluate(({ app }) => app.memoDownload)).toBe('completed');
      } else {
        const downloadPromise = page.waitForEvent('download');
        await memo('compact')
          .getByRole('link', { name: 'Download voice memo', exact: true })
          .click();
        await (await downloadPromise).saveAs(downloaded);
      }
      assert.deepEqual(await readFile(downloaded), wav);
      report.checks.push({
        surface,
        passed: true,
        check:
          'Keyboard playback and seeking work, another recording pauses the first, and Download returns the exact saved WAV.',
      });

      await expect(memo('unavailable').getByRole('alert')).toContainText(
        'reply is still saved above',
      );
      await expect(
        message('unavailable').getByText(
          'Your conversation stays here even when audio is unavailable.',
          { exact: true },
        ),
      ).toBeVisible();
      f.store.mutate(() =>
        f.store.putVoiceMemo({
          id: 'unavailable',
          sourceKey: 'unavailable',
          transcript: 'Your conversation stays here even when audio is unavailable.',
          audio: wav,
          createdAt: new Date().toISOString(),
        }),
      );
      await memo('unavailable').getByRole('button', { name: 'Reload audio', exact: true }).click();
      await expect
        .poll(() =>
          memo('unavailable')
            .locator('audio')
            .evaluate((a) => a.readyState),
        )
        .toBeGreaterThan(0);
      await expect(memo('unavailable').getByRole('alert')).toHaveCount(0);
      const pageGate = new Promise((resolve) => {
        releasePage = resolve;
      });
      let heldPage = false;
      await page.route(/\/assets\/WorkspacePage-[^/]+\.js$/, async (route) => {
        heldPage = true;
        await pageGate;
        await route.continue().catch(() => {});
      });
      await play.click();
      await page.evaluate(() => {
        location.hash = '#files';
      });
      await expect(input).toBeHidden();
      await expect.poll(() => heldPage).toBe(true);
      await expect
        .poll(() =>
          page
            .locator('audio')
            .evaluateAll((all) => all.length === 3 && all.every((a) => a.paused)),
        )
        .toBe(true);
      releasePage();
      await expect(
        page.getByRole('heading', { name: 'A home for your work', exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        location.hash = '#chat';
      });
      await expect(input).toHaveValue('Keep this unfinished travel question');
      await expect
        .poll(() => page.locator('audio').evaluateAll((all) => all.every((a) => a.paused)))
        .toBe(true);
      await page.reload();
      await expect(input).toHaveValue('Keep this unfinished travel question');
      await expect(memo('compact')).toHaveClass(/voice-memo-inline/);
      assert.equal(f.store.read().messages.length, 3);
      assert.equal(f.requests.length, 0);
      report.checks.push({
        surface,
        passed: true,
        check:
          'Unavailable audio recovers inline; navigation and reload stop playback, retain the draft and leave chat/model history unchanged.',
      });

      for (const theme of ['light', 'dark']) {
        f.store.mutate((s) => {
          s.profile.theme = theme;
        });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await memo('compact').scrollIntoViewIfNeeded();
        const audit = await new AxeBuilder({ page }).setLegacyMode(native).analyze();
        assert.deepEqual(audit.violations, []);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(evidence, `${surface}-${theme}.png`) });
      }
      if (!native && width === 390) {
        await page.setViewportSize({ width: 320, height: 740 });
        await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
        await memo('compact').scrollIntoViewIfNeeded();
        const row = await memo('compact').boundingBox();
        assert(row.x >= 0 && row.x + row.width <= 320);
        const downloadBox = await memo('compact')
          .getByRole('link', { name: 'Download voice memo', exact: true })
          .boundingBox();
        assert(downloadBox.x + downloadBox.width <= 320);
        await expect(
          memo('compact').getByRole('button', { name: 'Play voice memo', exact: true }),
        ).toBeInViewport();
        await play.click();
        await memo('compact')
          .getByRole('button', { name: 'Pause voice memo', exact: true })
          .click();
        await memo('compact').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, 'phone-large-text.png') });
      }
      assert.deepEqual(errors, []);
      report.checks.push({
        surface,
        passed: true,
        check:
          'Light and dark accessibility checks pass; visible controls fit the viewport, including 320px with 200% text in browser acceptance.',
      });
      console.log(
        `PASS ${surface}: compact audio, playback, seeking, exact download, recovery, navigation and accessibility`,
      );
    } finally {
      releasePage?.();
      await app?.close();
      if (!native) await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  report.passed = true;
} finally {
  await browser?.close();
  report.checkedAt = new Date().toISOString();
  await writeFile(
    join(evidence, native ? 'native-mac.json' : 'browser.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
