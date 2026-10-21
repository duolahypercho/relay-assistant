// SPDX-License-Identifier: MIT
// Deterministic local image provider; this does not establish live vendor quality or billing.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { avatarFixture } from '../tests/fixtures/avatar.mjs';
import { assistantProfile } from '../shared/assistant-scope.mjs';
import { ImageConnections } from '../server/image-connections.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';

const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-generated-avatar-'));
    let mode = 'success',
      cancelled = 0;
    const calls = [],
      endpoint = express();
    endpoint.use(express.json());
    endpoint.post('/v1/images/generations', (req, res) => {
      calls.push({ body: req.body, key: req.headers.authorization });
      if (mode === 'wait') {
        res.on('close', () => {
          if (!res.writableEnded) cancelled++;
        });
      } else if (mode === 'failure') res.status(401).json({ error: 'private provider detail' });
      else res.json({ data: [{ b64_json: avatarFixture().toString('base64') }] });
    });
    const imageServer = endpoint.listen(0, '127.0.0.1');
    await once(imageServer, 'listening');
    const imageUrl = `http://127.0.0.1:${imageServer.address().port}/v1`;
    const f = await assistantsFixture(directory, {
      configure(store, services) {
        services.imageConnections = new ImageConnections(store, { key: modelVaultKey(directory) });
      },
    });
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    context.setDefaultTimeout(15000);
    let app, page;
    try {
      if (native) {
        const data = join(directory, 'native');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
          timeout: 25000,
        });
        app.context().setDefaultTimeout(15000);
        page = await app.firstWindow();
      } else {
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.getByLabel('Message Relay', { exact: true }).fill('Keep my unfinished thought');
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await page.getByRole('button', { name: 'Personalize', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Assistant profile', exact: true });
      const appearance = page.getByRole('region', { name: 'Assistant appearance', exact: true });
      const generator = page.getByRole('region', { name: 'Create a character', exact: true });
      await appearance.getByRole('button', { name: 'Create with AI', exact: true }).click();
      await generator.getByLabel('Image provider', { exact: true }).selectOption('custom');
      await generator.getByLabel('Image endpoint', { exact: true }).fill(imageUrl);
      await generator.getByLabel('Image model', { exact: true }).fill('avatar-test');
      await generator.getByLabel('Image API key', { exact: true }).fill('fictional-image-key');
      await generator.getByLabel('Image model', { exact: true }).press('Enter');
      await expect(editor).toBeVisible();
      expect(calls).toHaveLength(0);
      await generator.getByRole('button', { name: 'Save image service', exact: true }).click();
      await expect(generator.getByLabel('Describe your character', { exact: true })).toBeVisible();
      const setup = await page.evaluate(() => fetch('/api/image-connection').then((r) => r.json()));
      expect(JSON.stringify(setup)).not.toContain('fictional-image-key');
      expect(setup.saved.hasKey).toBe(true);
      const before = assistantProfile(f.store.read()).appearance;
      await generator
        .getByLabel('Describe your character', { exact: true })
        .fill('A shy moon rabbit with a leaf scarf');
      await generator.getByRole('button', { name: 'Anime', exact: true }).click();
      await generator.getByRole('button', { name: 'Generate character', exact: true }).click();
      await expect(
        generator.getByAltText('Generated character preview', { exact: true }),
      ).toBeVisible();
      expect(assistantProfile(f.store.read()).appearance).toEqual(before);
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe('Bearer fictional-image-key');
      expect(calls[0].body.prompt).toContain('A shy moon rabbit with a leaf scarf');
      expect(JSON.stringify(calls)).not.toContain('Keep my unfinished thought');
      expect(calls[0].body.n).toBe(1);
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(
        generator.getByRole('button', { name: 'Use this picture', exact: true }),
      ).toBeFocused();
      await page.screenshot({ path: join(evidence, `avatar-generation-${label}.png`) });
      await generator.getByRole('button', { name: 'Use this picture', exact: true }).click();
      await expect(generator).toHaveCount(0);
      await expect(appearance.locator('.appearance-preview img')).toBeVisible();
      const picture = await appearance.locator('.appearance-preview img').getAttribute('src');
      expect(
        Buffer.from(picture.split(',')[1], 'base64').includes(
          Buffer.from('private camera metadata'),
        ),
      ).toBe(false);
      expect(assistantProfile(f.store.read()).appearance).toEqual(before);
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect.poll(() => assistantProfile(f.store.read()).appearance?.data).toBe(picture);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my unfinished thought',
      );
      await expect(page.locator('.companion-character img')).toHaveAttribute('src', picture);
      await page.reload();
      await expect(page.locator('.companion-character img')).toHaveAttribute('src', picture);
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await page.getByRole('button', { name: 'Personalize', exact: true }).click();
      await appearance.getByRole('button', { name: 'Create with AI', exact: true }).click();
      await generator
        .getByLabel('Describe your character', { exact: true })
        .fill('Keep the current picture on failure');
      mode = 'failure';
      await generator.getByRole('button', { name: 'Generate character', exact: true }).click();
      await expect(generator.getByRole('alert')).toContainText('HTTP 401');
      expect(calls).toHaveLength(2);
      await expect(appearance.locator('.appearance-preview img')).toHaveAttribute('src', picture);
      mode = 'wait';
      await generator.getByRole('button', { name: 'Generate character', exact: true }).click();
      await expect.poll(() => calls.length).toBe(3);
      await generator.getByRole('button', { name: 'Stop generation', exact: true }).click();
      await expect(generator.getByRole('status')).toContainText('Stopped.');
      await expect(page.locator('.storage-warning')).toHaveCount(0);
      await expect.poll(() => cancelled).toBe(1);
      await expect.poll(() => f.services.imageConnections.pending).toBe(false);
      await generator.getByRole('button', { name: 'Generate character', exact: true }).click();
      await expect.poll(() => calls.length).toBe(4);
      await generator
        .getByRole('button', { name: 'Close character generator', exact: true })
        .click();
      await expect.poll(() => cancelled).toBe(2);
      await expect(page.locator('.storage-warning')).toHaveCount(0);
      await expect.poll(() => f.services.imageConnections.pending).toBe(false);
      await appearance.getByRole('button', { name: 'Create with AI', exact: true }).click();
      mode = 'success';
      await generator.getByLabel('Describe your character', { exact: true }).fill('A tiny cloud');
      await generator.getByRole('button', { name: 'Soft toy', exact: true }).click();
      await generator.getByRole('button', { name: 'Generate character', exact: true }).click();
      await expect(
        generator.getByAltText('Generated character preview', { exact: true }),
      ).toBeVisible();
      expect(calls).toHaveLength(5);
      await generator.getByRole('button', { name: 'Discard picture', exact: true }).click();
      await expect(
        generator.getByAltText('Generated character preview', { exact: true }),
      ).toHaveCount(0);
      f.services.imageConnections.update({
        revision: f.services.imageConnections.publicState().revision,
        action: 'select',
        mode: 'saved',
      });
      await generator.getByRole('button', { name: 'Generate character', exact: true }).click();
      await expect(generator.getByRole('alert')).toContainText('another window');
      expect(calls).toHaveLength(5);
      await generator.getByRole('button', { name: 'Reload image settings', exact: true }).click();
      await expect(generator.getByLabel('Describe your character', { exact: true })).toHaveValue(
        'A tiny cloud',
      );
      await generator.getByText('Image service', { exact: true }).click();
      await generator.getByRole('button', { name: 'Turn off', exact: true }).click();
      await expect(
        generator.getByRole('button', { name: 'Use saved image service', exact: true }),
      ).toBeVisible();
      await page.reload();
      await appearance.getByRole('button', { name: 'Create with AI', exact: true }).click();
      await generator.getByRole('button', { name: 'Use saved image service', exact: true }).click();
      await generator.getByText('Image service', { exact: true }).click();
      await generator.getByRole('button', { name: 'Change image service', exact: true }).click();
      await expect(generator.getByLabel('Image API key', { exact: true })).toHaveValue('');
      await generator
        .getByRole('button', { name: 'Forget saved image service', exact: true })
        .click();
      await expect.poll(() => f.services.imageConnections.publicState().saved).toBe(null);
      await page.goto(f.url + '/#settings?section=personal');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await page.getByRole('button', { name: 'Personalize', exact: true }).click();
      await appearance.getByRole('button', { name: 'Create with AI', exact: true }).click();
      await expect(generator.getByLabel('Image provider', { exact: true })).toBeVisible();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.screenshot({ path: join(evidence, `avatar-generation-dark-${label}.png`) });
      expect(assistantProfile(f.store.read()).appearance.data).toBe(picture);
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.store.read().runs).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        calls: calls.length,
        cancellations: cancelled,
        checks: [
          'inline setup',
          'no accidental profile submit',
          'credential redaction',
          'explicit preview/use/save',
          'normalized metadata-free image',
          'persistent identity and chat draft',
          'provider 401 stays inline',
          'stop/unmount cancels without retry',
          'cancel does not mark workspace offline',
          'stale settings reject without dispatch and retain description on reload',
          'retry/discard',
          'off/reuse/remove persistence',
          'no chat/model history',
          'light/dark accessibility and viewport fit',
        ],
        liveProvider: false,
      });
      console.log(
        `PASS ${label}: generated-avatar preview, settings, persistence, failure and cancellation`,
      );
    } catch (error) {
      if (page && !page.isClosed())
        await page
          .screenshot({
            path: join(evidence, `avatar-generation-failure-${label}.png`),
            timeout: 5000,
          })
          .catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      await context.close();
      await f.close();
      imageServer.closeAllConnections();
      await new Promise((r) => imageServer.close(r));
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  join(evidence, `avatar-generation${native ? '-native-mac' : ''}-acceptance.json`),
  JSON.stringify({ date: new Date().toISOString(), passed: true, checks }, null, 2) + '\n',
);
