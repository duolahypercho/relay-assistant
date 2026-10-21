// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { oauthConnectorFixture } from './connector-oauth-fixture.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { appDirectory } from '../server/app-directory.mjs';
const native = process.env.RELAY_CONNECTORS_NATIVE === 'true' || process.argv.includes('--mac');
const directoryMode =
  process.env.RELAY_APP_DIRECTORY === 'true' || process.argv.includes('--directory');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    const dir = await mkdtemp(join(tmpdir(), 'relay-oauth-ui-')),
      remote = await oauthConnectorFixture();
    let discoveryRequests = 0,
      probeMode = directoryMode ? 'failure' : 'normal';
    const f = await assistantsFixture(dir, {
      accessKey: 'test-owner',
      configure(store, services) {
        services.connectors = new Connectors(store, {
          key: modelVaultKey(dir),
          ...(directoryMode
            ? {
                directory: [
                  ...appDirectory,
                  {
                    id: 'notebook',
                    name: 'Notebook',
                    description: 'An independent notebook for acceptance.',
                    keywords: 'journal notes',
                    endpoint: remote.endpoint,
                    guide: `${new URL(remote.endpoint).origin}/guide`,
                  },
                ],
                fetcher: async (input, init) => {
                  expect(String(input)).toBe(remote.endpoint);
                  discoveryRequests++;
                  if (probeMode === 'failure') throw Error('Independent offline fixture');
                  if (probeMode === 'slow')
                    await new Promise((_, reject) => {
                      if (init.signal.aborted) reject(init.signal.reason);
                      else
                        init.signal.addEventListener('abort', () => reject(init.signal.reason), {
                          once: true,
                        });
                    });
                  return fetch(input, init);
                },
              }
            : {}),
        });
      },
    });
    let app, context, page;
    const externalContext = await browser.newContext();
    try {
      if (native) {
        const data = join(dir, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
        context = app.context();
        await app.evaluate(({ shell }) => {
          globalThis.__openedSignIn = '';
          shell.openExternal = async (value) => {
            globalThis.__openedSignIn = value;
          };
        });
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      context.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByLabel('Server access key', { exact: true }).fill('test-owner');
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await page.locator('.composer textarea').fill('Keep our chat draft');
      const before = f.store.read().messages;
      const unauth = await externalContext.request.post(`${f.url}/api/connectors/oauth/begin`, {
        data: { name: 'Unauthorized', endpoint: remote.endpoint },
      });
      expect(unauth.status()).toBe(401);
      const crossOrigin = await page.request.post(`${f.url}/api/connectors/oauth/begin`, {
        headers: { Origin: 'https://wrong.example' },
        data: { name: 'Cross-origin', endpoint: remote.endpoint },
      });
      expect(crossOrigin.status()).toBe(403);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
      if (directoryMode) {
        const search = page.getByRole('searchbox', { name: 'Search apps', exact: true });
        await expect(
          page.getByRole('button', { name: 'Connect Notion', exact: true }),
        ).toBeVisible();
        await search.fill('no matching app');
        await expect(
          page.getByText('No matching apps. You can add one using its connection link below.'),
        ).toBeVisible();
        await search.fill('journal');
        await expect(
          page.getByRole('button', { name: 'Connect Notebook', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Connect Notion', exact: true })).toHaveCount(
          0,
        );
        expect(discoveryRequests).toBe(0);
        expect(remote.clients.size).toBe(0);
        await page.screenshot({
          path: join(evidence, `app-directory-search-${label}.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Connect Notebook', exact: true }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        expect(f.services.connectors.read()).toHaveLength(0);
        expect(remote.clients.size).toBe(0);
        await expect(page.getByLabel('App address', { exact: true })).toHaveCount(0);
        probeMode = 'slow';
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(
          page.getByRole('button', { name: 'Cancel connection check', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Cancel connection check', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('Connection check cancelled.');
        probeMode = 'normal';
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Add an app', exact: true }).click();
        await page.getByLabel('App address', { exact: true }).fill(remote.endpoint);
        await expect(page.getByLabel('App name', { exact: true })).toHaveCount(0);
        await expect(page.getByLabel(/Bearer token/)).not.toBeVisible();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      }
      await expect(
        page.getByRole('button', { name: 'Sign in with browser', exact: true }),
      ).toBeVisible();
      expect(context.pages()).toHaveLength(1);
      expect(remote.calls).toHaveLength(0);
      expect(await page.getByRole('dialog').count()).toBe(0);
      await page.screenshot({
        path: join(
          evidence,
          `${directoryMode ? 'app-directory' : 'app-sign-in'}-start-${label}.png`,
        ),
        fullPage: true,
      });
      async function start() {
        let popup;
        if (native) {
          await app.evaluate(() => {
            globalThis.__openedSignIn = '';
          });
          await page.getByRole('button', { name: 'Sign in with browser', exact: true }).click();
          await expect.poll(() => app.evaluate(() => globalThis.__openedSignIn)).not.toBe('');
          popup = await externalContext.newPage();
          await popup.goto(await app.evaluate(() => globalThis.__openedSignIn));
        } else {
          const opening = context.waitForEvent('page');
          await page.getByRole('button', { name: 'Sign in with browser', exact: true }).click();
          popup = await opening;
        }
        await expect(popup.getByRole('button', { name: 'Allow Relay', exact: true })).toBeVisible();
        return popup;
      }
      // Declining keeps the setup inline, and does not create a connection or chat event.
      let popup = await start();
      await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('cancelled or declined');
      await popup.close();
      expect(f.services.connectors.read()).toHaveLength(0);
      popup = await start();
      // Refreshing Relay while the browser is signing in restores the pending flow.
      await page.reload();
      await expect(
        page.getByText('Finish signing in in your browser', { exact: true }),
      ).toBeVisible();
      let offline = true;
      await page.route('**/api/connectors/oauth/result?*', (route) =>
        offline ? route.abort('connectionrefused') : route.continue(),
      );
      await popup.getByRole('button', { name: 'Allow Relay', exact: true }).click();
      await expect(
        popup.getByRole('heading', { name: 'You’re signed in.', exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem('relay-app-sign-in')))
        .not.toBeNull();
      offline = false;
      await expect(page.getByLabel('Permission for Save a note', { exact: true })).toHaveValue(
        'ask',
      );
      expect(f.services.connectors.read()).toHaveLength(0);
      expect(remote.calls).toHaveLength(0);
      await popup.close();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.getByLabel('App name', { exact: true }).fill('Little notebook');
      await page.getByLabel('Allow trusted read tools without review', { exact: true }).check();
      await page.screenshot({
        path: join(
          evidence,
          `${directoryMode ? 'app-directory' : 'app-sign-in'}-review-${label}.png`,
        ),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Connect selected tools', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Manage Little notebook', exact: true }),
      ).toBeVisible();
      const record = f.services.connectors.read()[0];
      expect(record.oauth).toBeTruthy();
      const state = await (await page.request.get(`${f.url}/api/connectors`)).text();
      expect(state).not.toContain(record.token);
      expect(state).not.toContain(record.oauth.tokens.refresh_token);
      expect(f.store.read().messages).toEqual(before);
      if (directoryMode) {
        // Reload during OAuth intentionally resets a transient search. Existing endpoint
        // matching still returns the saved connection, including its custom name.
        const clientCount = remote.clients.size;
        await page.getByRole('button', { name: 'Open Notebook', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'Manage Little notebook', exact: true }),
        ).toBeVisible();
        await page.getByText('Connection details', { exact: true }).click();
        await page.getByRole('button', { name: 'Edit connection address', exact: true }).click();
        await expect(page.getByLabel('App address', { exact: true })).toHaveValue(remote.endpoint);
        await page.getByRole('button', { name: 'Close app editor', exact: true }).click();
        expect(f.services.connectors.read()).toHaveLength(1);
        expect(remote.clients.size).toBe(clientCount);
      }
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.locator('.composer textarea')).toHaveValue('Keep our chat draft');
      await f.services.connectors.call(
        {
          connectionId: record.id,
          revision: record.revision,
          toolName: 'find_note',
          arguments: { topic: 'Sunday' },
        },
        'relay',
        'oauth-ui-read',
      );
      expect(remote.calls).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      checks.push({
        platform: label,
        passed: true,
        checks: [
          ...(directoryMode
            ? [
                'search by name/purpose without provider requests',
                'no-address setup with failure/cancel/retry',
                'existing app opens management without duplicate sign-in',
              ]
            : []),
          'collapsed technical fields',
          'cancel and retry',
          'PKCE browser consent',
          'pending sign-in survives reload',
          'explicit tool review before connect',
          'encrypted credentials omitted from UI/state',
          'authorized MCP call',
          'chat and draft preserved',
          'no dialogs, horizontal overflow or accessibility violations',
        ],
        ...(native
          ? {
              browserLaunch:
                'Production native IPC/URL validation; OS launch captured into independent Chrome session.',
            }
          : {}),
      });
    } finally {
      await externalContext.close();
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await remote.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      `${directoryMode ? 'app-directory' : 'app-sign-in'}-${native ? 'native-mac' : 'browser'}-acceptance.json`,
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Independent OAuth/MCP provider. Real vendor accounts and production client registrations remain unverified.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser.close();
}
