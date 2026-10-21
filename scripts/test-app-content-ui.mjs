import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { appContentJourneyFixture, contentAnswer } from './app-content-journey-fixture.mjs';
const mac = process.argv.includes('--mac'),
  options = process.argv.includes('--options'),
  evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-app-content-'));
    const f = await appContentJourneyFixture(directory, {
      sse: mobile,
      expectedMood: 'curious',
      completions: options,
    });
    let app, context, page;
    try {
      if (mac) {
        const desktopData = join(directory, 'desktop');
        await mkdir(desktopData);
        await writeFile(join(desktopData, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${desktopData}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let fieldFailure = true;
      await page.route('**/api/connectors/prompts/*', async (route) => {
        if (fieldFailure && route.request().method() === 'GET') {
          fieldFailure = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Template details are temporarily unavailable.' }),
          });
        }
        return route.continue();
      });
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my unfinished thought.');
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      await dock.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
      await page.getByRole('button', { name: 'Add an app', exact: true }).click();
      await page.getByLabel('App address', { exact: true }).fill(f.remote.endpoint);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(
        page.getByLabel('Permission for Read Weekend plan', { exact: true }),
      ).toHaveValue('ask');
      await page.getByLabel('App name', { exact: true }).fill('Little library');
      await page.getByLabel('Allow trusted read tools without review', { exact: true }).check();
      await expect(page.getByLabel('Permission for Read Daily note', { exact: true })).toHaveValue(
        'auto',
      );
      const promptPermission = page.getByLabel('Permission for Use template: A calmer plan', {
        exact: true,
      });
      await expect(promptPermission).toHaveValue('ask');
      await expect(promptPermission.locator('option[value=auto]')).toHaveCount(0);
      expect(f.remote.calls).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await page.screenshot({
        path: join(evidence, `app-content-connect-${surface}.png`),
        fullPage: true,
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: 'Connect app', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Manage Little library', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await composer.fill('Read my saved plan and budget, then use the calmer template.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const approve = page.getByRole('button', { name: 'Use template', exact: true });
      await expect(
        page
          .getByRole('alert')
          .filter({ hasText: 'Template details are temporarily unavailable.' }),
      ).toBeVisible({ timeout: 30000 });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(approve).toBeEnabled();
      expect(f.remote.calls.map((c) => c.method)).toEqual([
        'resources/read',
        'resources/read',
        'resources/read',
      ]);
      expect(f.remote.calls[1].params.uri).toBe('notebook://daily/2026-10-12?tag=books&tag=tea');
      expect(
        Buffer.from(
          f.store.read().files.find((x) => x.name === 'Budget.csv').base64,
          'base64',
        ).equals(f.remote.csv),
      ).toBe(true);
      const mood = page.getByRole('textbox', { name: 'mood', exact: true });
      await expect(mood).toHaveValue('quiet');
      const beforeEditing = f.store.read().messages;
      if (options) {
        const find = page.getByRole('button', { name: 'Find options for mood', exact: true });
        const choices = page.getByRole('group', { name: 'Options for mood', exact: true });
        await expect(find).toBeVisible();
        expect(f.remote.suggestions).toHaveLength(0);
        await mood.fill('cu');
        expect(f.remote.suggestions).toHaveLength(0);
        if (mobile) {
          await page.setViewportSize({ width: 390, height: 477 });
          await expect
            .poll(async () =>
              mood.evaluate((el) => {
                const view = el.closest('.messages').getBoundingClientRect();
                const field = el.getBoundingClientRect();
                const action = el
                  .closest('.prompt-review-field')
                  .querySelector('button')
                  .getBoundingClientRect();
                return (
                  field.top >= view.top && field.bottom <= view.bottom && action.top >= view.top
                );
              }),
            )
            .toBe(true);
          await page.setViewportSize({ width: 390, height: 844 });
        }
        let release;
        f.remote.completionHold(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
        await find.click();
        await expect.poll(() => f.remote.suggestions.length).toBe(1);
        await page.getByRole('button', { name: 'Cancel lookup', exact: true }).click();
        release();
        f.remote.completionHold(null);
        await expect(mood).toHaveValue('cu');
        await expect(choices).toHaveCount(0);
        f.remote.completionHold(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
        await mood.fill('ca');
        await find.click();
        await expect.poll(() => f.remote.suggestions.length).toBe(2);
        await mood.fill('qu');
        release();
        f.remote.completionHold(null);
        await expect(choices).toHaveCount(0);
        let unavailable = true;
        await page.route('**/api/connectors/prompts/suggest', async (route) => {
          if (unavailable) {
            unavailable = false;
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Options are temporarily unavailable.' }),
            });
          }
          return route.continue();
        });
        await find.click();
        await expect(
          page.getByRole('alert').filter({ hasText: 'Options are temporarily unavailable.' }),
        ).toBeVisible();
        await expect(mood).toHaveValue('qu');
        await mood.fill('no match');
        await find.click();
        await expect(
          page.getByText('No options found. You can enter your own value.', { exact: true }),
        ).toBeVisible();
        await mood.fill('cu');
        f.remote.completion({
          values: [
            'curious',
            '<b>Plain text</b>',
            ...Array.from({ length: 9 }, (_, index) => `Choice ${index + 1}`),
          ],
          hasMore: true,
          total: 20,
        });
        await find.click();
        await expect(choices.getByRole('button', { name: 'curious', exact: true })).toBeVisible();
        await expect(
          choices.getByRole('button', { name: '<b>Plain text</b>', exact: true }),
        ).toBeVisible();
        expect(await choices.locator('b').count()).toBe(0);
        const count = f.remote.suggestions.length;
        await page.getByRole('button', { name: 'Show more options', exact: true }).click();
        await expect(choices.getByRole('button', { name: 'Choice 9', exact: true })).toBeVisible();
        expect(f.remote.suggestions).toHaveLength(count);
        expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual(
          [],
        );
        if (mobile) expect((await find.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await page
          .locator('.prompt-review-editor')
          .screenshot({ path: join(evidence, `app-content-options-${surface}.png`) });
        await page.getByRole('button', { name: 'Hide options', exact: true }).click();
        await find.click();
        await expect(choices.getByRole('button', { name: 'curious', exact: true })).toBeVisible();
        expect(f.remote.suggestions).toHaveLength(count);
        await choices.getByRole('button', { name: 'curious', exact: true }).click();
      } else {
        await expect(
          page.getByRole('button', { name: 'Find options for mood', exact: true }),
        ).toHaveCount(0);
        await mood.fill('curious');
      }
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(mood).toHaveValue('curious');
      expect(f.remote.calls.filter((c) => c.method === 'prompts/get')).toHaveLength(0);
      expect(
        f.store.read().approvals.find((a) => a.status === 'pending').payload.arguments,
      ).toEqual({ mood: 'quiet' });
      expect(f.store.read().messages).toEqual(beforeEditing);
      await composer.fill('Keep this next thought.');
      await page.reload();
      await expect(composer).toHaveValue('Keep this next thought.');
      await expect(approve).toBeVisible();
      await expect(mood).toHaveValue('curious');
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: join(evidence, `app-content-choice-${surface}.png`),
        animations: 'disabled',
      });
      let useFailure = true;
      await page.route('**/api/connectors/prompts/use', async (route) => {
        if (useFailure) {
          useFailure = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Could not save this choice. Try again.' }),
          });
        }
        return route.continue();
      });
      await approve.click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Could not save this choice.' }),
      ).toBeVisible();
      await expect(mood).toHaveValue('curious');
      expect(f.remote.calls.filter((c) => c.method === 'prompts/get')).toHaveLength(0);
      await approve.click();
      await expect(page.locator('.messages').getByText(contentAnswer, { exact: true })).toBeVisible(
        { timeout: 30000 },
      );
      expect(f.remote.calls.filter((c) => c.method === 'prompts/get')).toHaveLength(1);
      expect(f.remote.calls.at(-1).params).toEqual({
        name: 'quiet_plan',
        arguments: { mood: 'curious' },
      });
      await expect(composer).toHaveValue('Keep this next thought.');
      expect(f.errors).toEqual([]);
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await page.locator('.file-tile').filter({ hasText: 'Budget.csv' }).click();
      await expect(page.getByRole('region', { name: 'File preview', exact: true })).toContainText(
        'Train,25',
      );
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('Budget.csv');
      await expect(composer).toHaveValue('Keep this next thought.');
      await page.screenshot({
        path: join(evidence, `app-content-result-${surface}.png`),
        animations: 'disabled',
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'content-only app connection with explicit policies',
          'bulk reads exclude prompt templates',
          'HTTP model reads app resources and RFC6570 template',
          'binary resource bytes saved without host URI fetch',
          'no prompt retrieval before choice',
          'edited fields survive navigation/reload, do not retrieve or approve while typing, and are sent exactly once with the frozen continuation',
          'inline field-loading and choice-save recovery keep edits and do not send the template early',
          ...(options
            ? [
                'explicit options lookup, cancellation, stale-response rejection, errors/empty results, plain-text choices, local caching, more choices and final exact use',
              ]
            : ['apps without completion capability retain manual fields without a lookup control']),
          'saved resource preview and draft attachment',
          'drafts, accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: connected documents and owner-chosen templates`);
    } catch (e) {
      await page
        ?.screenshot({ path: join(evidence, `app-content-failure-${surface}.png`) })
        .catch(() => {});
      throw e;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `app-content-${mac ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Real Relay/SQLite/worker with independent HTTP model and JSON/SSE MCP server; not live-account certification.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
