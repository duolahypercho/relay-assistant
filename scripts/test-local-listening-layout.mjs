// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localListeningFixture } from './local-listening-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-listening-layout-'));
const fixture = await localListeningFixture(directory);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 675 },
    { width: 1365, height: 900 },
  ]) {
    const context = await browser.newContext({
      viewport,
      reducedMotion: 'reduce',
      isMobile: viewport.width < 500,
      hasTouch: viewport.width < 500,
    });
    const page = await context.newPage();
    await page.goto(fixture.url + '/#settings?section=voice');
    const button = page.getByRole('button', { name: 'Set up voice', exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox(),
      dock = await page.getByRole('navigation', { name: 'Workspace shortcuts' }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height).toBeLessThanOrEqual(dock?.y || viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]);
    await page.screenshot({
      path: resolve(`../relay-evidence/voice-quick-layout-${viewport.width}.png`),
    });
    checks.push({ viewport, primaryAction: box, violations });
    await context.close();
  }
  await writeFile(
    resolve('../relay-evidence/voice-quick-layout-acceptance.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks }, null, 2),
  );
  console.log(
    'PASS: 320px, 390px and desktop setup; 44px primary action, no overflow, zero AXE violations',
  );
} finally {
  await browser.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
