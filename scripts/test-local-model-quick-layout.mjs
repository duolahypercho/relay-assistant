// SPDX-License-Identifier: MIT
// Actual UI and fixed production suggestion; no installer or model is launched.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelInstallFixture } from './local-model-install-fixture.mjs';
import { localModelSuggestion } from '../server/local-model-downloads.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-quick-layout-'));
const f = await localModelInstallFixture(directory, {
  modelsDirectory: process.env.RELAY_LOCAL_MODEL_TEST_MODELS,
  isolatedPort: 42334,
  enableDownloads: true,
  setupSuggestion: localModelSuggestion,
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const [width, height] of [
    [390, 675],
    [320, 568],
    [1365, 900],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(f.url);
    await page.getByRole('button', { name: 'Connect AI', exact: true }).click();
    await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Local model setup' });
    const start = setup.getByRole('button', { name: 'Set up & use', exact: true });
    await expect(start).toBeVisible();
    const box = await start.boundingBox();
    const dock = await page.getByRole('button', { name: 'More', exact: true }).boundingBox();
    assert(box.height >= 44);
    assert(
      box.y >= 0 && box.y + box.height <= (dock?.y || height),
      JSON.stringify({ width, box, dock }),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
    await page.screenshot({ path: resolve(`../relay-evidence/local-quick-layout-${width}.png`) });
    await setup.getByRole('button', { name: 'Choose another model', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enter connection details', exact: true }),
    ).toBeVisible();
    assert.equal(f.delivery.requests, 0);
    assert.equal(f.controls.starts, 0);
    assert.equal(f.store.read().messages.length, 0);
    assert.deepEqual(errors, []);
    checks.push({
      width,
      height,
      passed: true,
      primaryAboveFold: true,
      primary: box,
      noDownloads: true,
      manualOptionsAccessible: true,
    });
    await context.close();
  }
  await writeFile(
    resolve('../relay-evidence/local-quick-layout-acceptance.json'),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks }, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
