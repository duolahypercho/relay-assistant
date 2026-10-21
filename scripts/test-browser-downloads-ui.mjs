// SPDX-License-Identifier: MIT
// Actual Chromium + production Relay/worker, independent HTTPS site and controlled model.
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { trustedBrowserFixture } from './trusted-browser-fixture.mjs';
import { TrustedBrowser } from '../server/trusted-browser.mjs';
import { BrowserContainer } from '../server/browser-container.mjs';
const containerMode = process.env.RELAY_BROWSER_CONTAINER_TEST === 'true';
const expect = baseExpect.configure({ timeout: containerMode ? 20000 : 5000 });
import { PrivateComputer } from '../server/computer.mjs';
import { pinnedBrowserRequest } from '../server/browser-requests.mjs';
const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const chrome = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const site = await trustedBrowserFixture();
    let browser, computer;
    const f = await assistantsFixture(site.directory, {
      configure(store, services) {
        computer = new PrivateComputer(store, { enabled: true, deployment: site.directory });
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
          transport: (input, options) => pinnedBrowserRequest(input, { ...options, ca: site.cert }),
        });
        services.computer = computer;
        services.privateBrowser = browser;
      },
      respond({ messages }) {
        expect(JSON.stringify(messages)).not.toContain(site.password);
        expect(JSON.stringify(messages)).not.toContain(site.session);
        const response = messages.findLast((m) => m.role === 'tool');
        if (!response)
          return {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'get-report',
                type: 'function',
                function: {
                  name: 'private_browser_action',
                  arguments: JSON.stringify({
                    action: 'open',
                    url: site.origin + '/download-redirect',
                  }),
                },
              },
            ],
          };
        const result = JSON.parse(response.content).result;
        expect(result.receipt.phase).toBe('completed');
        expect(result.receipt.files).toHaveLength(1);
        expect(result.receipt.files[0].name).toBe('report.csv');
        return { role: 'assistant', content: 'Your report is saved. Open the file below.' };
      },
    });
    let app, page;
    const context = await chrome.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1060 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    try {
      if (native) {
        const data = join(site.directory, 'native');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
          timeout: 25000,
        });
        page = await app.firstWindow();
      } else {
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.getByLabel('Message Relay', { exact: true }).fill('Keep my unfinished thought');
      await page.evaluate(() => {
        location.hash = '#computer';
      });
      const ui = page.getByRole('region', { name: 'Private browser', exact: true });
      const address = ui.getByRole('textbox', { name: 'Website address', exact: true });
      const idle = () =>
        expect(ui.getByRole('status')).not.toHaveText('Updating page…', { timeout: 20000 });
      const open = async (path) => {
        await address.fill(site.origin + path);
        await ui.getByRole('button', { name: 'Open website', exact: true }).click();
        await expect.poll(() => browser.active, { timeout: 20000 }).toBe(null);
        await idle();
      };
      await ui.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        ui.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeEnabled();
      await open('/signin');
      await ui.getByLabel('Username', { exact: true }).fill('download-owner');
      await ui.getByLabel('Password', { exact: true }).fill(site.password);
      await ui.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(ui.getByLabel('Note', { exact: true })).toBeVisible();
      await idle();
      await open('/downloads');
      await ui.getByRole('button', { name: 'Download report', exact: true }).click();
      await expect.poll(() => f.store.read().files.length).toBe(1);
      await idle();
      const saved = ui.getByRole('region', { name: 'Browser downloads', exact: true });
      await saved.getByRole('button', { name: 'report.csv', exact: true }).click();
      await expect(page.getByRole('region', { name: 'File preview', exact: true })).toContainText(
        'Tea,4',
      );
      const blob = await page
        .getByRole('region', { name: 'File preview', exact: true })
        .getByRole('link', { name: 'Download', exact: true })
        .getAttribute('href');
      expect(await page.evaluate((url) => fetch(url).then((r) => r.text()), blob)).toBe(
        'Item,Amount\nTea,4\nTrain,12\n',
      );
      await page.goBack();
      await ui.getByRole('button', { name: 'Download binary', exact: true }).click();
      await expect.poll(() => f.store.read().files.length).toBe(2);
      await idle();
      expect(
        Buffer.from(
          f.store.read().files.find((file) => file.name === 'sample.bin').base64,
          'base64',
        ),
      ).toEqual(Buffer.from([0, 255, 128, 7, 0, 11]));
      expect(f.store.read().messages).toHaveLength(0);
      await ui.getByRole('button', { name: 'Download private value', exact: true }).click();
      await expect(ui.getByRole('alert')).toBeVisible();
      await idle();
      expect(f.store.read().files).toHaveLength(2);
      await expect(
        ui.getByRole('button', { name: 'Download oversized file', exact: true }),
      ).toBeVisible();
      await ui.getByRole('button', { name: 'Download oversized file', exact: true }).click();
      await expect(ui.getByRole('alert')).toBeVisible();
      await idle();
      expect(f.store.read().files).toHaveLength(2);
      await ui.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await expect(ui.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
      await page.goBack();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my unfinished thought',
      );
      await page.getByLabel('Message Relay', { exact: true }).fill('Download my report');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.evaluate(() => {
        location.hash = '#computer';
      });
      const review = ui.getByRole('region', { name: 'Website request review', exact: true });
      await expect(review).toContainText('/download-redirect');
      expect(site.calls.filter((c) => c.url === '/download-redirect')).toHaveLength(0);
      await review.getByRole('button', { name: 'Allow & continue', exact: true }).click();
      await expect(review).toContainText('/export.csv');
      expect(site.calls.filter((c) => c.url === '/export.csv')).toHaveLength(1);
      await review.getByRole('button', { name: 'Allow & continue', exact: true }).click();
      await expect.poll(() => f.store.read().files.length).toBe(3);
      await expect
        .poll(() => f.store.read().runs.at(-1).status, { timeout: 20000 })
        .toBe('completed');
      expect(site.calls.filter((c) => c.url === '/export.csv')).toHaveLength(2);
      const receipt = browser.downloads.list().find((file) => file.name === 'report.csv');
      const actionId = f.store.db
        .prepare('SELECT action_id FROM trusted_browser_downloads WHERE file_id=?')
        .get(receipt.id).action_id;
      const duplicate = await browser.begin(
        { operationId: actionId, action: 'open', url: site.origin + '/download-redirect' },
        'agent',
      );
      expect(duplicate.repeated).toBe(true);
      expect(duplicate.files).toHaveLength(1);
      expect(site.calls.filter((c) => c.url === '/export.csv')).toHaveLength(2);
      await page.goBack();
      await expect(
        page
          .locator('.messages')
          .getByText('Your report is saved. Open the file below.', { exact: true }),
      ).toBeVisible();
      const final = f.store.read().messages.at(-1);
      expect(final.cards).toContainEqual({ kind: 'file', id: receipt.id });
      expect(f.store.read().messages).toHaveLength(2);
      await page.screenshot({
        path: join(
          evidence,
          `${containerMode ? 'container-' : ''}browser-download-result-${label}.png`,
        ),
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.reload();
      await page.evaluate(() => {
        location.hash = '#computer';
      });
      await expect(saved.getByRole('button', { name: 'report.csv', exact: true })).toHaveCount(1);
      await saved.getByRole('button', { name: 'All files', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'A home for your work', exact: true }),
      ).toBeVisible();
      expect(f.store.read().messages).toHaveLength(2);
      await page.evaluate(() => {
        location.hash = '#computer';
      });
      // A declined new request produces no file and never reaches the website.
      const pendingAction = await browser.begin(
        {
          operationId: 'declined-download',
          action: 'open',
          url: site.origin + '/export.csv?decline=1',
        },
        'agent',
      );
      await expect(review).toContainText('decline=1');
      await review.getByRole('button', { name: 'Decline', exact: true }).click();
      const declined = await browser.waitForAction(pendingAction.id);
      expect(declined.phase).not.toBe('completed');
      expect(declined.files).toBeUndefined();
      expect(f.store.read().files).toHaveLength(3);
      expect(site.calls.some((c) => c.url.includes('decline=1'))).toBe(false);
      const slow = await browser.begin(
        { operationId: 'takeover-download', action: 'open', url: site.origin + '/export-slow' },
        'agent',
      );
      await expect(review).toContainText('/export-slow');
      await review.getByRole('button', { name: 'Allow & continue', exact: true }).click();
      await expect.poll(() => site.calls.filter((c) => c.url === '/export-slow').length).toBe(1);
      await ui.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        ui.getByRole('button', { name: 'Give back to Relay', exact: true }),
      ).toBeEnabled();
      site.releaseDownloads();
      expect((await browser.waitForAction(slow.id)).phase).toBe('interrupted');
      expect(f.store.read().files).toHaveLength(3);
      await ui.getByText('Saved sign-ins & browser data', { exact: true }).click();
      await ui.getByRole('button', { name: 'Clear browser data…', exact: true }).click();
      await ui.getByRole('button', { name: 'Clear browser data', exact: true }).click();
      await expect.poll(() => browser.vault.read().cookies.length).toBe(0);
      expect(browser.vault.storage()).toBeUndefined();
      expect(f.store.read().files).toHaveLength(3);
      expect(browser.downloads.list()).toHaveLength(3);
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'owner sign-in and attachment download',
          'HTML download attribute and exact binary bytes',
          'known-secret and oversize rejection',
          'draft/history preserved',
          'each agent redirect reviewed before dispatch',
          'file cards from real worker',
          'download receipt idempotency',
          'reload and decline without dispatch',
          'takeover cancels an in-flight HTTPS download',
          'clearing sign-ins retains saved Files',
          'accessibility and viewport fit',
        ],
        containerTransport: 'stubbed pause/resume only',
        website: 'independent local HTTPS fixture',
        liveAccount: false,
      });
      console.log(
        `PASS ${label}: private browser downloads, reviews, persistence and result cards`,
      );
    } catch (error) {
      if (page && !page.isClosed())
        await page
          .screenshot({
            path: join(
              evidence,
              `${containerMode ? 'container-' : ''}browser-download-failure-${label}.png`,
            ),
            timeout: 5000,
          })
          .catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      await context.close();
      await f.worker.stop();
      await browser.close();
      await f.close();
      await site.close();
    }
  }
} finally {
  await chrome.close();
}
await writeFile(
  join(
    evidence,
    `${containerMode ? 'container-' : ''}browser-downloads${native ? '-native-mac' : ''}-acceptance.json`,
  ),
  JSON.stringify(
    { date: new Date().toISOString(), passed: true, containerBrowser: containerMode, checks },
    null,
    2,
  ) + '\n',
);
