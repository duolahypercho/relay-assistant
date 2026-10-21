// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clarification as values,
  emailClarificationFixture,
} from './email-clarification-fixture.mjs';
import { androidReminderClient } from './android-reminder-client.mjs';

const native = process.argv.includes('--android');
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR ||
    `../relay-evidence/native-email-clarification/${native ? 'android' : 'browser'}`,
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'relay-email-clarification-'));
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  surface: native ? 'Android APK' : 'mobile-width Chromium',
  scope:
    'Controlled HTTP model, real worker and UI. No physical device or actual-model reliability claim.',
};
let f, browser, client, page;
const errors = [];
try {
  f = await emailClarificationFixture(directory);
  if (native) {
    client = await androidReminderClient();
    report.native = {
      avd: client.avd,
      apkSha256: client.apkSha256,
      webView: client.webView,
      fingerprint: client.fingerprint,
      relaunches: client.relaunches,
    };
    page = await client.connect(f.url);
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    page = await context.newPage();
    await page.goto(f.url);
  }
  function observe() {
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => errors.push(e.message));
  }
  observe();
  const composer = () => page.getByLabel('Message Relay', { exact: true });
  const answer = () => page.getByLabel('Your own answer', { exact: true });
  async function type(input, text) {
    if (client) await client.type(input, text);
    else {
      await input.click();
      await input.press('End');
      await input.pressSequentially(text);
    }
  }
  async function capture(name, locator) {
    await client?.hideKeyboard(page);
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
    await (client || page).screenshot({ path: join(evidence, name + '.png') });
  }
  f.start();
  await expect(answer()).toBeVisible();
  f.pending();
  await type(composer(), values.draft);
  await type(answer(), values.partial);
  await expect(answer()).toHaveValue(values.partial);
  await capture('unfinished-answer', answer());
  // A separate page must not add messages; returning must retain both editors.
  await page.getByRole('button', { name: 'More', exact: true }).click({ noWaitAfter: native });
  await page.getByRole('button', { name: 'Files', exact: true }).click({ noWaitAfter: native });
  await page
    .getByRole('button', { name: 'Back to chat', exact: true })
    .click({ noWaitAfter: native });
  await expect(answer()).toHaveValue(values.partial);
  f.pending();
  if (client) {
    page = await client.relaunch(f.url);
    observe();
  } else await page.reload();
  await expect(answer()).toHaveValue(values.partial);
  await expect(composer()).toHaveValue(values.draft);
  f.pending();
  await capture('recovered-answer', answer());
  await type(answer(), 'example.test');
  await expect(answer()).toHaveValue(values.recipient);
  await client?.hideKeyboard(page);
  await page
    .getByRole('button', { name: 'Send answer', exact: true })
    .click({ noWaitAfter: native });
  await expect.poll(() => f.store.read().approvals.length, { timeout: 30000 }).toBe(1);
  await expect.poll(() => f.store.read().runs.at(-1).status, { timeout: 30000 }).toBe('completed');
  report.result = f.verify();
  await expect(page.locator('.chat-review')).toContainText(values.recipient);
  await expect(page.locator('.chat-review')).toContainText(values.subject);
  await capture('exact-review', page.locator('.chat-review'));
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations, []);
  for (let i = 0; i < (native ? 5 : 1); i++) {
    await page.reload();
    await expect(composer()).toHaveValue(values.draft);
    await expect(page.locator('.chat-review')).toContainText(values.recipient);
    f.verify();
  }
  if (client) {
    page = await client.relaunch(f.url);
    observe();
  } else await page.reload();
  await expect(composer()).toHaveValue(values.draft);
  await expect(page.locator('.question-receipt')).toContainText(values.recipient);
  assert.equal(
    await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith('relay-question-answer:')).length,
    ),
    0,
  );
  f.verify();
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  if (f) report.diagnostics = { state: f.store.read(), requests: f.requests };
  process.exitCode = 1;
  await (client || page)?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
} finally {
  report.cleanupErrors = [];
  for (const [name, close] of [
    ['native', () => client?.close()],
    ['browser', () => browser?.close()],
    ['fixture', () => f?.close()],
    ['scratch', () => rm(directory, { recursive: true, force: true })],
  ]) {
    try {
      await close();
    } catch (error) {
      report.cleanupErrors.push({ name, error: error.message });
    }
  }
  if (client) {
    const diagnostics = await client.diagnostics();
    await writeFile(join(evidence, 'native-crash.log'), diagnostics.crashLog);
    report.native.crashes = diagnostics.crashes;
    if (diagnostics.crashes.length) {
      report.passed = false;
      process.exitCode = 1;
    }
  }
  report.cleanedUp = report.cleanupErrors.length === 0;
  if (!report.cleanedUp) {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence,
      error: report.error,
      cleanedUp: report.cleanedUp,
    }),
  );
}
