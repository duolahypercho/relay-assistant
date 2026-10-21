// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { modelsFixture } from './models-fixture.mjs';
import { connectionText } from '../shared/native-connection-language.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-connection-language-'));
const fixture = await modelsFixture(directory),
  browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  const baseline = fixture.store.read();
  for (const [language, locale] of [
    ['zh-Hans', 'zh-CN'],
    ['zh-Hant-HK', 'zh-TW'],
    ['en-US', 'en'],
  ]) {
    const context = await browser.newContext({
      locale: language,
      viewport: { width: 390, height: 675 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/native-connection.html');
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(
      page.getByRole('heading', { name: connectionText(locale, 'Let’s reconnect.') }),
    ).toBeVisible();
    await expect(page).toHaveTitle(connectionText(locale, 'Reconnect to Relay'));
    await page
      .getByRole('button', { name: connectionText(locale, 'Change server'), exact: true })
      .click();
    await expect(page.getByRole('alert')).toHaveText(
      connectionText(locale, 'Open the Relay mobile app to choose your server.'),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(evidence, `connection-recovery-${locale}.png`) });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page
      .getByRole('button', { name: connectionText(locale, 'Try again'), exact: true })
      .click();
    await expect(page.locator('.composer textarea')).toBeVisible();
    assert.deepEqual(fixture.store.read().messages, baseline.messages);
    checks.push({ language, locale, passed: true });
    await context.close();
  }
  await writeFile(
    join(evidence, 'connection-recovery-language-browser.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Production bundled recovery page in phone Chromium; no native bridge is emulated. Real native alert/relaunch is a separate Simulator test.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS three-language phone recovery, accessibility and unchanged messages');
} finally {
  await browser.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
