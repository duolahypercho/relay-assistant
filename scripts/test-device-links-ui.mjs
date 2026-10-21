// SPDX-License-Identifier: MIT
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deviceLinksFixture } from './device-links-fixture.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-device-links-ui-'));
    const f = await deviceLinksFixture(directory);
    const settings = {
      ignoreHTTPSErrors: true,
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    };
    const ownerContext = await browser.newContext(settings),
      targetContext = await browser.newContext(settings);
    const owner = await ownerContext.newPage(),
      target = await targetContext.newPage();
    const errors = [];
    owner.on('pageerror', (e) => errors.push(e.message));
    target.on('pageerror', (e) => errors.push(e.message));
    try {
      await owner.goto(f.url);
      await owner.getByLabel('Server access key').fill(f.key);
      await owner.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await owner
        .getByLabel('Message Relay', { exact: true })
        .fill('Keep my connected-device draft');
      await owner.getByRole('button', { name: 'More', exact: true }).click();
      await owner.getByRole('button', { name: 'Settings', exact: true }).click();
      await owner.getByRole('button', { name: 'Data & devices', exact: true }).click();
      const card = owner.getByRole('article', { name: 'Connected devices' });
      const create = card.getByRole('button', { name: 'Create connection link', exact: true });
      await create.click();
      const cancelled = await card.getByLabel('Connection link').inputValue();
      await card.getByRole('button', { name: 'Cancel link', exact: true }).click();
      await target.goto(cancelled);
      await expect(target).toHaveURL(f.url + '/#chat');
      await expect(target.getByLabel('Server access key')).toHaveCount(0);
      await target.getByRole('button', { name: 'Connect this device', exact: true }).click();
      await expect(target.getByRole('alert')).toContainText('cancelled');
      await create.click();
      const expired = await card.getByLabel('Connection link').inputValue();
      f.store.db
        .prepare('UPDATE device_links SET expires=? WHERE session_digest IS NULL')
        .run(Date.now() - 1);
      await target.goto(expired);
      await target.getByRole('button', { name: 'Connect this device', exact: true }).click();
      await expect(target.getByRole('alert')).toContainText('expired');
      await expect(create).toBeVisible();
      await create.click();
      const link = await card.getByLabel('Connection link').inputValue(),
        token = link.split('#connect=')[1];
      await card.getByRole('button', { name: 'Copy connection link', exact: true }).click();
      await expect(card.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      expect(
        (
          await new AxeBuilder({ page: owner })
            .include('[aria-label="Connected devices"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      await owner.screenshot({
        path: join(evidence, `device-link-create-${mobile ? 'phone' : 'desktop'}.png`),
      });
      await target.goto(link);
      await target.getByLabel('Device name').fill(mobile ? 'My phone' : 'My second browser');
      expect((await new AxeBuilder({ page: target }).analyze()).violations).toEqual([]);
      await target.screenshot({
        path: join(evidence, `device-link-review-${mobile ? 'phone' : 'desktop'}.png`),
      });
      await target.getByRole('button', { name: 'Connect this device', exact: true }).click();
      const input = target.getByLabel('Message Relay', { exact: true });
      await expect(input).toBeVisible();
      const cookies = await targetContext.cookies(f.url),
        session = cookies.find((c) => c.name === 'relay_session');
      assert(session?.secure && session.httpOnly);
      expect(
        await target.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        ),
      ).not.toContain(token);
      assert.doesNotMatch(JSON.stringify(f.store.read()), new RegExp(token));
      await input.fill('Hello from my connected device');
      await target.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        target.getByText('Your devices are sharing this conversation.', { exact: true }),
      ).toBeVisible();
      await input.fill('Keep my phone thought');
      await target.reload();
      await expect(input).toHaveValue('Keep my phone thought');
      await owner.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(owner.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my connected-device draft',
      );
      await expect(
        owner.getByText('Your devices are sharing this conversation.', { exact: true }),
      ).toBeVisible();
      assert.equal(f.store.read().messages.length, 2);
      assert.equal(f.requests.length, 1);
      await owner.getByRole('button', { name: 'More', exact: true }).click();
      await owner.getByRole('button', { name: 'Settings', exact: true }).click();
      await owner.getByRole('button', { name: 'Data & devices', exact: true }).click();
      // Creation can be disabled later without hiding existing device revocation.
      // Only this read response is projected; Disconnect still calls the real API.
      await owner.route('**/api/device-links', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), available: false } });
      });
      await expect(card).toContainText('needs a public HTTPS address');
      await owner
        .getByRole('button', {
          name: `Disconnect ${mobile ? 'My phone' : 'My second browser'}`,
          exact: true,
        })
        .click();
      await expect(target.getByLabel('Server access key')).toBeVisible();
      await target.goto(link);
      await target.getByRole('button', { name: 'Connect this device', exact: true }).click();
      await expect(target.getByRole('alert')).toContainText('already used');
      expect(errors).toEqual([]);
      expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      checks.push({
        surface: mobile ? 'phone' : 'desktop',
        passed: true,
        checks: [
          'Owner creates/cancels/replaces link without adding chat history',
          'Explicit receiver review, expired/cancelled/used rejection and fragment erasure',
          'Secure HttpOnly independent session, reload and actual controlled model round-trip',
          'Synced messages preserve each device’s pending draft',
          'Disconnect immediately removes target authorization while owner stays signed in',
          'Accessibility, viewport fit and no page errors',
        ],
      });
      console.log(
        `PASS ${mobile ? 'phone' : 'desktop'} device links and synchronized conversation`,
      );
    } catch (error) {
      await owner.screenshot({ path: join(evidence, 'device-links-failure.png') });
      await writeFile(
        join(evidence, 'device-links-failure.txt'),
        await owner.locator('body').innerText(),
      );
      console.error(
        'Owner device-link status',
        await owner.evaluate(async () => {
          const r = await fetch('/api/device-links');
          return { status: r.status, body: await r.json() };
        }),
      );
      throw error;
    } finally {
      await ownerContext.close();
      await targetContext.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'device-links-browser-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Independent local HTTPS/model service; browser phone layout is not native mobile or public network acceptance.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
