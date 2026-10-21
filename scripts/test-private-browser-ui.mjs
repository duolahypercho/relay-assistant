// SPDX-License-Identifier: MIT
// Real Relay UI, worker and host Chromium; independent local HTTPS site and HTTP model.
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { trustedBrowserFixture } from './trusted-browser-fixture.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { BrowserContainer } from '../server/browser-container.mjs';
const containerMode = process.env.RELAY_BROWSER_CONTAINER_TEST === 'true';
const expect = baseExpect.configure({ timeout: containerMode ? 20000 : 5000 });
import { PrivateComputer } from '../server/computer.mjs';
import { pinnedBrowserRequest } from '../server/browser-requests.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const native = process.env.RELAY_PRIVATE_BROWSER_NATIVE === 'true';
const chrome = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const tool = (name, args, id = name) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const site = await trustedBrowserFixture({ pageResources: true });
    let browser, computer;
    let releaseAsset;
    const assetGate = new Promise((resolve) => {
      releaseAsset = resolve;
    });
    const f = await assistantsFixture(site.directory, {
      configure(store, services) {
        computer = new PrivateComputer(store, { enabled: true, deployment: site.directory });
        // Production owner/epoch logic, with isolated no-op container transport.
        computer.inspect = async () => null;
        computer.runtime.pause = async () => {};
        computer.runtime.resume = async () => {};
        browser = new TrustedBrowser(store, {
          ...(containerMode ? { runtime: new BrowserContainer(computer) } : {}),
          key: randomBytes(32),
          enabled: true,
          channel: 'chrome',
          control: computer,
          resolver: site.resolver,
          transport: async (input, options) => {
            if (computer.controller === 'agent' && input.url.endsWith('/page-assets/style.css'))
              await assetGate;
            return pinnedBrowserRequest(input, { ...options, ca: site.cert });
          },
        });
        services.computer = computer;
        services.privateBrowser = browser;
      },
      respond({ messages, tools }) {
        expect(tools.some((t) => t.function.name === 'private_browser_action')).toBe(true);
        const results = messages
          .filter((m) => m.role === 'tool')
          .map((m) => {
            try {
              return JSON.parse(m.content).result;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const last = results.at(-1);
        if (messages.some((m) => m.role === 'tool' && JSON.parse(m.content).error))
          return { role: 'assistant', content: 'The browser action stopped. I did not repeat it.' };
        expect(JSON.stringify(messages)).not.toContain(site.password);
        expect(JSON.stringify(messages)).not.toContain(site.session);
        if (last?.receipt?.phase && last.receipt.phase !== 'completed')
          return { role: 'assistant', content: 'The browser action stopped. I did not repeat it.' };
        if (!results.length)
          return tool(
            'private_browser_action',
            { action: 'open', url: `${site.origin}/workspace` },
            'open',
          );
        if (results.length === 1) {
          const target = last.page.content.find(
            (n) => n.name === 'Note' && n.role === 'textbox',
          ).target;
          expect(last.page.content.find((n) => n.name === 'Private field').target).toBeUndefined();
          return tool(
            'private_browser_action',
            { action: 'type', target, text: `A quiet ${label} afternoon` },
            'type',
          );
        }
        if (results.length === 2)
          return tool(
            'private_browser_action',
            {
              action: 'click',
              target: last.page.content.find((n) => n.name === 'Save note' && n.role === 'button')
                .target,
            },
            'save',
          );
        expect(last.page.content.some((n) => n.name === 'Note saved')).toBe(true);
        return {
          role: 'assistant',
          content: 'Your note is saved. One quiet afternoon, ready when you are.',
        };
      },
    });
    let app, context, page;
    if (native) {
      const data = join(site.directory, 'native-client');
      await mkdir(data);
      await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
      app = await electron.launch({
        executablePath: resolve(
          'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
        ),
        args: [`--relay-test-data=${data}`],
      });
      page = await app.firstWindow();
    } else {
      context = await chrome.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1060 },
        isMobile: mobile,
        hasTouch: mobile,
        reducedMotion: 'reduce',
      });
      page = await context.newPage();
    }
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const address = page.getByRole('textbox', { name: 'Website address', exact: true });
    const ui = page.getByRole('region', { name: 'Private browser', exact: true });
    const untilIdle = () =>
      expect(ui.getByRole('status')).not.toHaveText('Updating page…', { timeout: 20000 });
    try {
      if (!native) await page.goto(f.url);
      await page.getByLabel('Message Relay', { exact: true }).fill('An unfinished thought');
      const before = structuredClone(f.store.read().messages);
      await page.evaluate(() => {
        location.hash = '#computer';
      });
      await expect(ui).toBeVisible();
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeEnabled();
      await address.fill(`${site.origin}/signin`);
      await page.getByRole('button', { name: 'Open website', exact: true }).click();
      await expect(ui.getByLabel('Username', { exact: true })).toBeVisible();
      await untilIdle();
      await ui.getByLabel('Username', { exact: true }).fill('fixture-owner');
      await ui.getByLabel('Password', { exact: true }).fill(site.password);
      // Clicking the form's button must first commit the focused private field.
      await ui.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(ui.getByLabel('Note', { exact: true })).toBeVisible();
      await untilIdle();
      await expect(address).toHaveValue(`${site.origin}/workspace`);
      expect(site.calls.filter((c) => c.url === '/signin' && c.method === 'POST')).toHaveLength(1);
      expect(site.calls.find((c) => c.url === '/workspace').cookie).toContain(site.session);
      expect(f.store.read().messages).toEqual(before);
      expect(JSON.stringify(f.store.read())).not.toContain(site.password);
      await page.screenshot({
        path: join(
          evidence,
          `${containerMode ? 'browser-container' : 'private-browser'}-${label}-signed-in.png`,
        ),
        fullPage: true,
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      const scroll = page.locator('.workspace-page-scroll');
      await scroll.evaluate((el) => {
        el.scrollTop = 300;
      });
      const handback = ui.getByRole('button', { name: 'Give back to Relay', exact: true });
      await expect
        .poll(() =>
          handback.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return !!hit && el.contains(hit) && r.y >= 0 && r.bottom <= innerHeight;
          }),
        )
        .toBe(true);
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      // Tab/page visits cannot append messages or lose the Main draft.
      await page.getByRole('button', { name: 'Desktop', exact: true }).click();
      await expect(ui).toBeHidden();
      await page.getByRole('button', { name: 'Browser', exact: true }).click();
      await expect(ui).toBeVisible();
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await expect(ui.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
      await expect(ui.getByLabel('Note', { exact: true })).toHaveCount(0);
      await page.evaluate(() => {
        location.hash = '#chat';
      });
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'An unfinished thought',
      );
      expect(f.store.read().messages).toEqual(before);
      await page
        .getByLabel('Message Relay', { exact: true })
        .fill('Save a quiet afternoon note in my website.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page
        .getByRole('button', { name: 'Open browser · review & follow along', exact: true })
        .click();
      const review = ui.getByRole('region', { name: 'Website request review' });
      await expect(review).toBeVisible();
      expect(site.calls.filter((c) => c.url === '/workspace')).toHaveLength(1);
      await page.reload();
      await expect(review).toBeVisible();
      await expect(review).toContainText('Forms, other pages and API calls still ask.');
      await expect(
        review.getByRole('button', { name: 'Only this request', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: join(
          evidence,
          `${containerMode ? 'browser-container' : 'private-browser'}-${label}-page-load.png`,
        ),
        fullPage: true,
      });
      await review.getByRole('button', { name: 'Allow & continue' }).click();
      await expect
        .poll(() =>
          browser.requests
            .list()
            .some((r) => r.authorization === 'page-load' && r.phase === 'pending'),
        )
        .toBe(true);
      await expect(review).toBeHidden();
      releaseAsset();
      // Resources included in this explicit page-load scope need no second click.
      let sawFormReview = false;
      for (let i = 0; i < 40; i++) {
        if (f.store.read().runs.at(-1).status === 'completed') break;
        const pending = browser.requests
          .list()
          .filter((r) => r.phase === 'pending' && r.reviewRequired !== false);
        if (pending.length) {
          await expect(review).toBeVisible();
          if (pending.some((r) => r.method === 'POST')) {
            sawFormReview = true;
            const assets = browser.requests
              .list()
              .filter((r) => r.url.includes('/page-assets/') && r.actor === 'agent');
            expect(assets.length).toBeGreaterThanOrEqual(3);
            expect(
              assets.every((r) => r.authorization === 'page-load' && r.phase === 'completed'),
            ).toBe(true);
            expect(browser.requests.pageLoads.size).toBe(0);
            expect(site.calls.filter((c) => c.url === '/save')).toHaveLength(0);
            await expect(review).toContainText(`A quiet ${label} afternoon`);
            await page.screenshot({
              path: join(
                evidence,
                `${containerMode ? 'browser-container' : 'private-browser'}-${label}-review.png`,
              ),
              fullPage: true,
            });
            expect(
              (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
            ).toEqual([]);
          }
          await review.getByRole('button', { name: 'Allow & continue' }).click();
        }
        await page.waitForTimeout(300);
      }
      expect(sawFormReview).toBe(true);
      await expect.poll(() => site.calls.filter((c) => c.url === '/save').length).toBe(1);
      expect(site.calls.find((c) => c.url === '/save').body).toBe(
        `note=A+quiet+${label}+afternoon`,
      );
      await expect.poll(() => f.store.read().runs.at(-1).status).toBe('completed');
      expect(f.store.read().messages.at(-1).text).toContain('Your note is saved.');
      expect(f.store.read().runs.at(-1).privateBrowserAction).toBeUndefined();
      await page.reload();
      await expect(ui).toBeVisible();
      expect(site.calls.filter((c) => c.url === '/save')).toHaveLength(1);
      // A second request can be declined from the page; no outbound page request follows.
      let workspaceRequests = site.calls.filter((c) => c.url === '/workspace').length;
      await page.evaluate(() => {
        location.hash = '#chat';
      });
      await page
        .getByLabel('Message Relay', { exact: true })
        .fill('Try again, but wait for my review.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page
        .getByRole('button', { name: 'Open browser · review & follow along', exact: true })
        .click();
      await expect(review).toBeVisible();
      await review.getByRole('button', { name: 'Decline', exact: true }).click();
      await expect.poll(() => f.store.read().runs.at(-1).status).toBe('completed');
      expect(site.calls.filter((c) => c.url === '/workspace')).toHaveLength(workspaceRequests);
      expect(f.store.read().messages.at(-1).text).toContain('did not repeat');
      // The narrower owner choice must not silently include resource permission.
      await page.evaluate(() => {
        location.hash = '#chat';
      });
      await page
        .getByLabel('Message Relay', { exact: true })
        .fill('Open the page with individual reviews.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page
        .getByRole('button', { name: 'Open browser · review & follow along', exact: true })
        .click();
      await expect(review).toBeVisible();
      const assetCalls = site.calls.filter((c) => c.url.includes('/page-assets/')).length;
      await review.getByRole('button', { name: 'Only this request', exact: true }).click();
      await expect
        .poll(() =>
          browser.requests
            .list()
            .some((r) => r.phase === 'pending' && r.url.includes('/page-assets/')),
        )
        .toBe(true);
      expect(site.calls.filter((c) => c.url.includes('/page-assets/')).length).toBe(assetCalls);
      expect(browser.requests.pageLoads.size).toBe(0);
      await ui.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect.poll(() => f.store.read().runs.at(-1).status).toBe('completed');
      expect(site.calls.filter((c) => c.url.includes('/page-assets/')).length).toBe(assetCalls);
      workspaceRequests = site.calls.filter((c) => c.url === '/workspace').length;
      await page.evaluate(() => {
        location.hash = '#chat';
      });
      await page
        .getByLabel('Message Relay', { exact: true })
        .fill('Open the site and wait while I take over.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page
        .getByRole('button', { name: 'Open browser · review & follow along', exact: true })
        .click();
      await expect(review).toBeVisible();
      const callsBeforeTakeover = f.requests.length;
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeEnabled();
      await expect(review).toHaveCount(0);
      await page.waitForTimeout(350);
      expect(f.requests.length).toBe(callsBeforeTakeover);
      expect(site.calls.filter((c) => c.url === '/workspace')).toHaveLength(workspaceRequests);
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await expect.poll(() => f.store.read().runs.at(-1).status).toBe('completed');
      expect(f.store.read().messages.at(-1).text).toContain('did not repeat');
      expect(site.calls.filter((c) => c.url === '/workspace')).toHaveLength(workspaceRequests);
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeEnabled();
      await ui.getByText('Saved sign-ins & browser data', { exact: true }).click();
      await ui.getByRole('button', { name: 'Clear browser data…', exact: true }).click();
      await ui.getByRole('button', { name: 'Keep data', exact: true }).click();
      expect(browser.vault.storage().cookies.length).toBeGreaterThan(0);
      await ui.getByRole('button', { name: 'Clear browser data…', exact: true }).click();
      await ui.getByRole('button', { name: 'Clear browser data', exact: true }).click();
      await expect.poll(() => browser.vault.storage()?.cookies.length || 0).toBe(0);
      await untilIdle();
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      await page.screenshot({
        path: join(
          evidence,
          `${containerMode ? 'browser-container' : 'private-browser'}-${label}-dark.png`,
        ),
        fullPage: true,
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      checks.push({
        label,
        passed: true,
        signIn: true,
        realModelToolProtocol: true,
        reviewedFormSubmitOnce: true,
        reviewAfterReload: true,
        takeoverWhileWaiting: true,
        handbackReachableAfterScroll: true,
        boundedPageLoad: true,
        exactOnlyFallback: true,
        noReviewForAuthorizedConnectingResource: true,
        decline: true,
        preservedHistoryAndDraft: true,
        clear: true,
        accessibilityLightAndDark: true,
        noOuterOverflow: true,
      });
      console.log('PASS', label);
    } catch (e) {
      await page
        .screenshot({
          path: join(
            evidence,
            `${containerMode ? 'browser-container' : 'private-browser'}-${label}-failure.png`,
          ),
          fullPage: true,
        })
        .catch(() => {});
      console.error(
        'Runtime state',
        browser.status('owner'),
        'requests',
        browser.requests.list().map((r) => ({
          phase: r.phase,
          method: r.method,
          url: r.url,
          authorization: r.authorization,
          destinationType: r.headers['sec-fetch-dest'],
        })),
      );
      throw e;
    } finally {
      releaseAsset();
      await app?.close();
      await context?.close();
      await f.worker.stop();
      await browser.close();
      await f.close();
      await site.close();
    }
  }
  await writeFile(
    join(
      evidence,
      `${containerMode ? 'browser-container' : 'private-browser'}-${native ? 'native-mac' : 'ui'}-acceptance.json`,
    ),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        checks,
        scope:
          'Production web UI, real worker and browser with local HTTPS/model fixtures. Actual PrivateComputer authority, mocked container pause/resume. No owner data or live accounts.',
        native,
        containerBrowser: containerMode,
        packagedClientOnly: native,
        newNativeBuild: false,
      },
      null,
      2,
    ),
  );
} finally {
  await chrome?.close();
}
