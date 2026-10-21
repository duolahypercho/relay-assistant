// SPDX-License-Identifier: MIT
// Tests the browser/native contract with a controlled bridge, not an OS picker.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { artifactsFixture, artifactExamples } from './artifacts-fixture.mjs';
import { saveArtifact } from '../server/artifacts.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const platform of ['ios', 'android']) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-mobile-results-'));
    const fixture = await artifactsFixture(directory);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    try {
      await context.addInitScript((name) => {
        window.CapacitorCustomPlatform = { name };
        window.calls = [];
        window.saveOutcome = 'saved';
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'RelayResults',
              methods: [
                { name: 'preview', rtype: 'promise' },
                { name: 'save', rtype: 'promise' },
              ],
            },
          ],
          nativePromise: async (plugin, method, options) => {
            window.calls.push({ plugin, method, options });
            if (method === 'save') {
              if (window.saveOutcome === 'error') throw new Error('Test destination unavailable.');
              if (window.saveOutcome === 'pending')
                return new Promise((resolve) => {
                  window.finishSave = resolve;
                });
              return { status: window.saveOutcome };
            }
          },
        };
      }, platform);
      const saved = await saveArtifact(fixture.store, {
        ...artifactExamples.web,
        operationId: 'mobile-web',
      });
      const file = fixture.store.read().files.find((f) => f.id === saved.fileId);
      const baseline = fixture.store.read().messages.length;
      const page = await context.newPage();
      await page.goto(fixture.url + `/#files/${saved.id}/1`);
      await page.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.calls.filter((c) => c.method === 'preview').length))
        .toBe(1);
      assert.deepEqual(await page.evaluate(() => window.calls[0].options), {
        title: artifactExamples.web.title,
        source: artifactExamples.web.source,
      });
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
      await page.evaluate(() => {
        window.saveOutcome = 'pending';
      });
      await page.getByRole('button', { name: 'Save file', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
      const payload = await page.evaluate(
        () => window.calls.find((c) => c.method === 'save').options,
      );
      assert.equal(payload.name, file.name);
      assert.equal(payload.mime, file.mime);
      assert.deepEqual(Buffer.from(payload.base64, 'base64'), Buffer.from(file.base64, 'base64'));
      await page.evaluate(() => window.finishSave({ status: 'saved' }));
      await expect(page.getByText('File saved.', { exact: true })).toBeVisible();
      await page.evaluate(() => {
        window.saveOutcome = 'cancelled';
      });
      await page.getByRole('button', { name: 'Save file', exact: true }).click();
      await expect(page.getByText('File saved.', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeEnabled();
      await page.evaluate(() => {
        window.saveOutcome = 'error';
      });
      await page.getByRole('button', { name: 'Save file', exact: true }).click();
      await expect(page.getByText('Test destination unavailable.', { exact: true })).toBeVisible();
      await page.evaluate(() => {
        window.saveOutcome = 'saved';
      });
      await page.getByRole('button', { name: 'Save file', exact: true }).click();
      await expect(page.getByText('File saved.', { exact: true })).toBeVisible();
      assert.equal(fixture.store.read().messages.length, baseline);
      await page.screenshot({
        path: join(evidence, `mobile-results-${platform}-contract.png`),
        fullPage: true,
      });
      checks.push({
        surface: `simulated-${platform}`,
        check:
          'Exact preview source, static host frame, exact download bytes, busy guard, saved/cancel/error handling, unchanged chat',
        passed: true,
      });
    } finally {
      await context.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  await writeFile(
    join(evidence, 'mobile-results-ui.json'),
    JSON.stringify({ testedAt: new Date().toISOString(), checks }, null, 2),
  );
}
console.log(`${checks.length} mobile bridge contract checks passed.`);
