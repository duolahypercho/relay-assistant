import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { appContentJourneyFixture } from './app-content-journey-fixture.mjs';
const mac = process.argv.includes('--mac');
const options = process.argv.includes('--options');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/app-documents');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-document-browser-'));
    const f = await appContentJourneyFixture(directory, {
      connected: true,
      sse: mobile,
      completions: options,
    });
    const connection = f.services.connectors.publicState().connections[0];
    f.services.connectors.update({
      id: connection.id,
      revision: connection.revision,
      permissions: Object.fromEntries(connection.tools.map((tool) => [tool.name, 'ask'])),
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
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my unfinished thought.');
      const before = f.store.read();
      async function openDocuments() {
        await page
          .getByRole('navigation', { name: 'Workspace shortcuts' })
          .getByRole('button', { name: 'More', exact: true })
          .click();
        await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
        await page
          .getByRole('button', { name: 'Documents in Little library', exact: true })
          .click();
      }
      let failList = true;
      await page.route('**/api/connectors/documents/list', async (route) => {
        if (failList) {
          failList = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'The document list is temporarily unavailable.' }),
          });
        }
        return route.continue();
      });
      await openDocuments();
      await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      const search = page.getByRole('searchbox', { name: 'Find a document' });
      await search.fill('weekend');
      await expect(page.locator('.app-document-row')).toHaveCount(1);
      expect(f.remote.calls).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await search.fill('not found');
      await expect(
        page.getByRole('status').filter({ hasText: 'No matching documents.' }),
      ).toBeVisible();
      await search.fill('');
      await page.screenshot({ path: join(evidence, `documents-list-${surface}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      let loseResponse = true;
      await page.route('**/api/connectors/documents/read', async (route) => {
        if (loseResponse) {
          loseResponse = false;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Connection interrupted. Try opening again.' }),
          });
        }
        return route.continue();
      });
      await page.getByRole('button', { name: /Weekend plan The saved/ }).click();
      await expect(page.getByRole('alert')).toContainText('Connection interrupted');
      await page.getByRole('button', { name: 'Open document', exact: true }).click();
      await expect(page.locator('.document-preview')).toHaveText('Meet at noon. Bring a book.');
      expect(f.remote.calls).toHaveLength(1);
      expect(f.store.read().files).toHaveLength(before.files.length + 1);
      await page.screenshot({ path: join(evidence, `documents-preview-${surface}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('Weekend plan.txt');
      await openDocuments();
      await page.getByRole('button', { name: /Daily note Read the daily/ }).click();
      if (options) {
        const day = page.getByRole('textbox', { name: 'day', exact: true });
        const find = page.getByRole('button', { name: 'Find options for day', exact: true });
        await day.fill('2026');
        await page.getByRole('textbox', { name: 'tag', exact: true }).fill('reading');
        expect(f.remote.suggestions).toHaveLength(0);
        f.remote.completion({
          values: [
            '2026-10-14',
            '<b>plain text</b>',
            ...Array.from({ length: 9 }, (_, i) => `Option ${i}`),
          ],
          hasMore: true,
        });
        await find.click();
        const choices = page.getByRole('group', { name: 'Options for day', exact: true });
        await expect(choices.getByRole('button')).toHaveCount(8);
        await expect(
          choices.getByRole('button', { name: '<b>plain text</b>', exact: true }),
        ).toBeVisible();
        await expect(choices.locator('b')).toHaveCount(0);
        expect(f.remote.suggestions[0].params).toEqual({
          ref: { type: 'ref/resource', uri: 'notebook://daily/{day}{?tag*}' },
          argument: { name: 'day', value: '2026' },
          context: { arguments: { tag: 'reading' } },
        });
        await page.getByRole('button', { name: 'Show more options', exact: true }).click();
        await expect(choices.getByRole('button')).toHaveCount(11);
        await page.screenshot({ path: join(evidence, `document-options-${surface}.png`) });
        expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual(
          [],
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false,
        );
        await page.getByRole('button', { name: 'Hide options', exact: true }).click();
        await find.click();
        await expect(choices).toBeVisible();
        expect(f.remote.suggestions).toHaveLength(1);
        await day.fill('empty');
        f.remote.completion({ values: [], hasMore: false });
        await find.click();
        await expect(
          page.getByText('No options found. You can enter your own value.'),
        ).toBeVisible();
        await day.fill('invalid');
        f.remote.completion({ values: ['x'.repeat(2001)] });
        await find.click();
        await expect(page.getByRole('alert')).toContainText('Could not find options');
        await day.fill('slow');
        let release;
        f.remote.completionHold(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
        f.remote.completion({ values: ['late option'], hasMore: false });
        await find.click();
        await expect.poll(() => f.remote.suggestions.length).toBe(4);
        await page.getByRole('button', { name: 'Cancel lookup', exact: true }).click();
        await expect.poll(() => f.services.connectors.active.size).toBe(0);
        await day.fill('2026-10');
        release();
        f.remote.completionHold(undefined);
        f.remote.completion(undefined);
        await expect(choices).toHaveCount(0);
        await find.click();
        await choices.getByRole('button', { name: '2026-10-14', exact: true }).click();
        await expect(day).toHaveValue('2026-10-14');
        expect(f.remote.calls).toHaveLength(1);
        for (const key of ['messages', 'runs', 'approvals'])
          expect(f.store.read()[key]).toEqual(before[key]);
      } else await page.getByRole('textbox', { name: 'day', exact: true }).fill('2026-10-14');
      await page.getByRole('textbox', { name: 'tag', exact: true }).fill('reading');
      expect(f.remote.calls).toHaveLength(1);
      await page.getByRole('button', { name: 'Open document', exact: true }).click();
      await expect(page.locator('.document-preview')).toHaveText(
        'Daily note: Meet at noon. Bring a book.',
      );
      expect(f.remote.calls.at(-1).params.uri).toBe('notebook://daily/2026-10-14?tag=reading');
      await page.getByRole('button', { name: 'All documents', exact: true }).click();
      await page.getByRole('button', { name: /^Budget file/ }).click();
      await expect(page.locator('.document-preview')).toContainText('Train,25');
      const budget = f.store.read().files.find((file) => file.name === 'Budget.csv');
      expect(Buffer.from(budget.base64, 'base64').equals(f.remote.csv)).toBe(true);
      await page.getByRole('button', { name: 'All documents', exact: true }).click();
      const filesBeforeCancellation = f.store.read().files;
      let release;
      f.remote.hold(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await page.getByRole('button', { name: /Weekend plan The saved/ }).click();
      await expect.poll(() => f.remote.calls.length).toBe(4);
      await page.getByRole('button', { name: 'Cancel opening', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Open document', exact: true })).toBeEnabled();
      await expect.poll(() => f.services.connectors.active.size).toBe(0);
      release();
      f.remote.hold(undefined);
      await expect.poll(() => f.services.connectors.active.size).toBe(0);
      expect(f.store.read().files).toEqual(filesBeforeCancellation);
      await page.getByRole('button', { name: 'All documents', exact: true }).click();
      f.remote.hold(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await page.getByRole('button', { name: /Weekend plan The saved/ }).click();
      await expect.poll(() => f.remote.calls.length).toBe(5);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect.poll(() => f.services.connectors.active.size).toBe(0);
      release();
      f.remote.hold(undefined);
      expect(f.store.read().files).toEqual(filesBeforeCancellation);
      await openDocuments();
      await page.getByRole('button', { name: 'Your apps', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Manage Little library', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await page.reload();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('Weekend plan.txt');
      for (const key of ['messages', 'runs', 'approvals'])
        expect(f.store.read()[key]).toEqual(before[key]);
      expect(f.requests).toHaveLength(0);
      expect(f.remote.calls.every((call) => call.method === 'resources/read')).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'metadata-only search; no model or document access while browsing',
          'exact owner read under Ask policy, no approval dialog or chat event',
          'lost response retry reuses receipt and file, no duplicate remote read',
          'plain text preview and exact binary download bytes',
          'document contents retrieved only on Open document',
          ...(options
            ? [
                'explicit contextual document options, plain text and bounded display',
                'cached lookup, empty/error fallback, cancellation and discarded late values',
              ]
            : []),
          'cancelled read saves no late file',
          'Ask about this preserves Main draft and attachments after reload',
          'separate page navigation, accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: direct app documents`);
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `documents-failure-${surface}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `acceptance-${mac ? 'mac' : 'browser'}.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        scope:
          'Actual Relay server and clients with independent JSON/SSE MCP fixture. No model request is needed; not live vendor-account certification.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
