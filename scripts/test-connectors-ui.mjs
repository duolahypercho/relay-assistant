// SPDX-License-Identifier: MIT
// Independent HTTP model + MCP server: exercises production routes, worker and UI.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { connectorFixture } from './connectors-fixture.mjs';
import { Connectors } from '../server/connectors.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';

const evidence = resolve('../relay-evidence');
const native = process.env.RELAY_CONNECTORS_NATIVE === 'true';
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const tool = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: `fixture-${name}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
try {
  for (const { mobile, addressOnly } of (native ? [false] : [false, true]).flatMap((mobile) =>
    [false, true].map((addressOnly) => ({ mobile, addressOnly })),
  )) {
    const label = `${native ? 'native-mac' : mobile ? 'mobile' : 'desktop'}${addressOnly ? '-address-only' : ''}`;
    const directory = await mkdtemp(join(tmpdir(), 'relay-apps-ui-'));
    const remote = await connectorFixture({
      sse: mobile,
      ...(addressOnly ? { authenticate: () => true } : {}),
    });
    let connection;
    const final =
      'Your Sunday plan is saved in your notebook. A slow morning, then a walk by the water.';
    const f = await assistantsFixture(directory, {
      configure(store, services) {
        services.connectors = new Connectors(store, { key: modelVaultKey(directory) });
      },
      respond({ messages }) {
        const all = JSON.stringify(messages);
        if (all.includes('Continue the original request using the confirmed result')) {
          expect(all).toContain('Saved the Sunday plan in your notebook.');
          return { role: 'assistant', content: final };
        }
        const outputs = messages
          .filter((m) => m.role === 'tool')
          .map((m) => {
            try {
              return JSON.parse(m.content).result || {};
            } catch {
              return {};
            }
          });
        if (!outputs.some((o) => o.apps))
          return tool('list_app_tools', { connectionId: connection.id, toolName: 'find_note' });
        if (!outputs.some((o) => o.toolName === 'find_note'))
          return tool('use_app_tool', {
            connectionId: connection.id,
            revision: connection.revision,
            toolName: 'find_note',
            arguments: { topic: 'Sunday' },
          });
        if (!outputs.some((o) => o.apps?.[0]?.tools?.[0]?.name === 'save_note'))
          return tool('list_app_tools', { connectionId: connection.id, toolName: 'save_note' });
        return tool('use_app_tool', {
          connectionId: connection.id,
          revision: connection.revision,
          toolName: 'save_note',
          arguments: { title: 'Sunday', body: 'A slow morning, then a walk by the water.' },
        });
      },
    });
    let app, context, page;
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
        });
        page = await app.firstWindow();
        app.context().setDefaultTimeout(20000);
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        context.setDefaultTimeout(20000);
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = () => page.locator('.composer textarea');
      async function openApps() {
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Your apps', exact: true })).toBeVisible();
      }
      await composer().fill('Keep my quiet weekend draft');
      const before = f.store.read().messages;
      await openApps();
      await expect(composer()).not.toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Add an app', exact: true }).click();
      await expect(page.getByLabel('App name', { exact: true })).toHaveCount(0);
      if (addressOnly) {
        await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
        await page.getByLabel('App address', { exact: true }).fill(`${remote.endpoint}/not-an-app`);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('Could not connect');
        await expect(
          page.getByRole('button', { name: 'Sign in with browser', exact: true }),
        ).toHaveCount(0);
        expect(f.services.connectors.read()).toHaveLength(0);
        await page.getByLabel('App address', { exact: true }).fill(remote.endpoint);
        await expect(page.getByRole('alert')).toHaveCount(0);
        await page.screenshot({ path: join(evidence, `apps-address-start-${label}.png`) });
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
      } else {
        await page.getByLabel('App address', { exact: true }).fill(remote.endpoint);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(
          page.getByText('This app needs you to sign in.', { exact: false }),
        ).toBeVisible();
        await page.getByText('Other connection options', { exact: true }).click();
        await page.getByLabel(/Bearer token/).fill(remote.token);
        await page.getByRole('button', { name: 'Find tools', exact: true }).click();
      }
      await expect(page.getByLabel('Permission for Save a note', { exact: true })).toHaveValue(
        'ask',
      );
      expect(remote.calls).toHaveLength(0);
      await expect(page.getByLabel('App name', { exact: true })).toHaveValue('Local app');
      await page.getByLabel('App name', { exact: true }).fill('Little notebook');
      expect(f.services.connectors.read()).toHaveLength(0);
      expect(page.context().pages()).toHaveLength(1);
      await page.getByLabel('Allow trusted read tools without review', { exact: true }).check();
      await expect(page.getByLabel('Permission for Find a note', { exact: true })).toHaveValue(
        'auto',
      );
      await expect(
        page
          .getByLabel('Permission for Save a note', { exact: true })
          .locator('option[value="auto"]'),
      ).toHaveCount(0);
      await page.getByLabel('Permission for Get a picture', { exact: true }).selectOption('off');
      // Credentials remain masked, and screenshots do not include even fictional secret values.
      await page.getByLabel(/Bearer token/).evaluate((el) => (el.style.visibility = 'hidden'));
      await page.screenshot({
        path: join(evidence, `apps-permissions-${label}.png`),
        fullPage: true,
      });
      await page.getByLabel(/Bearer token/).evaluate((el) => (el.style.visibility = ''));
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.getByRole('button', { name: 'Connect selected tools', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Manage Little notebook', exact: true }),
      ).toBeVisible();
      connection = f.services.connectors.publicState().connections[0];
      expect(connection.tools.find((t) => t.name === 'get_picture').mode).toBe('off');
      const publicState = await (await page.request.get(`${f.url}/api/state`)).text();
      expect(publicState).not.toContain(remote.token);
      expect(JSON.stringify(f.store.read())).not.toContain(remote.token);
      expect(f.store.read().messages).toEqual(before);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer()).toHaveValue('Keep my quiet weekend draft');
      await composer().fill('Find my Sunday plan and save a calmer version in my notebook.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const approve = page.getByRole('button', { name: 'Approve app action', exact: true });
      await expect(approve).toBeVisible({ timeout: 30000 });
      expect(remote.calls.map((c) => c.name)).toEqual(['find_note']);
      expect(remote.notes).toHaveLength(0);
      await expect(page.getByLabel('Exact app arguments')).toContainText('A slow morning');
      await composer().fill('Keep this thought for later');
      await page.screenshot({ path: join(evidence, `apps-review-${label}.png`) });
      await page.reload();
      await expect(composer()).toHaveValue('Keep this thought for later');
      await expect(approve).toBeVisible();
      await approve.click();
      await expect(page.locator('.messages').getByText(final, { exact: true })).toBeVisible({
        timeout: 30000,
      });
      expect(remote.notes).toEqual([
        { title: 'Sunday', body: 'A slow morning, then a walk by the water.' },
      ]);
      expect(remote.calls.map((c) => c.name)).toEqual(['find_note', 'save_note']);
      expect(f.store.read().runs).toHaveLength(2);
      expect(f.store.read().runs.every((r) => r.status === 'completed')).toBe(true);
      expect(JSON.stringify(f.requests)).not.toContain(remote.token);
      await expect(composer()).toHaveValue('Keep this thought for later');
      await page.screenshot({ path: join(evidence, `apps-result-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      const history = f.store.read().messages;
      await openApps();
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
      expect(f.services.connectors.list('relay')).toEqual([]);
      await page.getByRole('button', { name: 'Enable', exact: true }).click();
      await page.getByRole('button', { name: 'Manage Little notebook', exact: true }).click();
      await expect(page.getByLabel(/Bearer token/)).toHaveValue('');
      await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
      await expect(page.getByLabel('Permission for Find a note', { exact: true })).toHaveValue(
        'auto',
      );
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Manage Little notebook', exact: true }),
      ).toBeVisible();
      const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
      if (await dismiss.isVisible()) await dismiss.click();
      await page.screenshot({ path: join(evidence, `apps-connected-${label}.png`) });
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByLabel('Search your workspace').fill('dark mode');
      await page.getByLabel('Search your workspace').press('Enter');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByLabel('Search your workspace').fill('Connect apps');
      await page.getByLabel('Search your workspace').press('Enter');
      await page.screenshot({ path: join(evidence, `apps-connected-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Manage Little notebook', exact: true }).click();
      await page.getByRole('button', { name: 'Disconnect…', exact: true }).click();
      await page.getByRole('button', { name: 'Disconnect app', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add an app', exact: true })).toBeVisible();
      expect(f.services.connectors.publicState().connections).toEqual([]);
      expect(f.store.read().messages).toEqual(history);
      expect(remote.notes).toHaveLength(1);
      expect(errors).toEqual([]);
      checks.push({
        platform: label,
        discoveryWithoutExecution: true,
        exactReview: true,
        workerContinuation: true,
        credentialIsolation: true,
        draftRetained: true,
        separatePage: true,
        duplicateWrites: 0,
        axeViolations: 0,
        overflow: false,
      });
    } catch (e) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `apps-failure-${label}.png`) })
          .catch(() => {});
      console.error(
        JSON.stringify({
          runs: f.store.read().runs.map((r) => ({ status: r.status, error: r.error })),
          reviews: f.store.read().approvals.map((a) => ({ status: a.status, error: a.error })),
          calls: remote.calls.map((c) => c.name),
        }),
      );
      throw e;
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `apps-acceptance${native ? '-native' : ''}.json`),
    JSON.stringify(checks, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser?.close();
}
