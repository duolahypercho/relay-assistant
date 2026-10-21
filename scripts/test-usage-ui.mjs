// SPDX-License-Identifier: MIT
// Controlled HTTP responses, actual worker/SQLite, disposable browser or Mac client.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
const mac = process.argv.includes('--mac');
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const checks = [];
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-usage-ui-'));
    let context, app;
    let reportTokens = true,
      failRead = false;
    const f = await assistantsFixture(directory, {
      usage: () =>
        reportTokens
          ? {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 70 },
              completion_tokens_details: { reasoning_tokens: 5 },
            }
          : undefined,
      respond: async (body) =>
        body.messages.some((m) => m.role === 'tool') ||
        body.messages.at(-1)?.content === 'Usage check'
          ? { role: 'assistant', content: 'Your file list is ready.' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'list-for-usage',
                  type: 'function',
                  function: { name: 'list_files', arguments: '{}' },
                },
              ],
            },
      middleware: (req, res, next) => {
        if (failRead && req.path === '/api/usage') {
          failRead = false;
          return res
            .status(503)
            .json({ error: 'The usage connection is temporarily unavailable.' });
        }
        next();
      },
    });
    const check = (label) => {
      checks.push({ surface, label });
      console.log(`PASS ${surface}: ${label}`);
    };
    try {
      let page;
      if (mac) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
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
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      const usage = page.getByRole('article', { name: 'Model usage' });
      async function openUsage() {
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('textbox', { name: 'Search your workspace' }).fill('usage');
        await page.getByRole('button', { name: 'Usage Settings', exact: true }).click();
        await expect(usage).toBeVisible();
      }
      await composer.fill('Keep my unfinished thought');
      await openUsage();
      await expect(
        usage.getByRole('heading', { name: 'No model requests in this period' }),
      ).toBeVisible();
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      check(
        'search opens a dedicated Usage page with an honest empty state and no model request or chat message',
      );
      await dock.getByRole('button', { name: 'Main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought');
      await composer.fill('List my files');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs[0]?.status).toBe('completed');
      expect(f.requests).toHaveLength(2);
      await composer.fill('Keep my usage draft');
      const messages = structuredClone(f.store.read().messages);
      await openUsage();
      await expect(usage.locator('.usage-totals dd').nth(0)).toHaveText('2');
      await expect(usage.locator('.usage-totals dd').nth(1)).toHaveText('240');
      await usage.locator('.usage-models summary').click();
      await expect(usage.locator('.usage-breakdown dd')).toHaveText([
        '200',
        '40',
        '140',
        'Not reported',
        '10',
      ]);
      expect(f.provider.usage.summary().totals.requests).toBe(2);
      expect(f.requests.every((r) => r.stream_options?.include_usage)).toBe(true);
      await page.screenshot({ path: join(evidence, `usage-${surface}.png`) });
      check(
        'a real worker tool round-trip records two HTTP calls; input, output, cached and reasoning totals render without double-counting',
      );
      reportTokens = false;
      await f.provider.complete([{ role: 'user', content: 'Usage check' }]);
      await usage.getByRole('button', { name: 'Refresh usage' }).click();
      await expect(usage.locator('.usage-totals dd').nth(0)).toHaveText('3');
      await expect(usage.getByText(/1 request has no reported total/)).toBeVisible();
      await expect(usage.locator('.usage-totals dd').nth(1)).toHaveText('240');
      const first = f.store.db
        .prepare('SELECT id FROM model_usage ORDER BY started_at,id LIMIT 1')
        .get().id;
      f.store.db
        .prepare('UPDATE model_usage SET started_at=? WHERE id=?')
        .run(Date.now() - 2 * 86400000, first);
      await usage.getByRole('combobox', { name: 'Usage period' }).selectOption('24h');
      await expect(usage.locator('.usage-totals dd').nth(0)).toHaveText('2');
      await expect(usage.locator('.usage-totals dd').nth(1)).toHaveText('120');
      await usage.getByRole('combobox', { name: 'Usage period' }).selectOption('30d');
      await expect(usage.locator('.usage-totals dd').nth(0)).toHaveText('3');
      await expect(usage.locator('.usage-totals dd').nth(1)).toHaveText('240');
      check(
        'missing usage stays unknown, reporting periods filter persisted request times, and opening totals never dispatches another completion',
      );
      failRead = true;
      await usage.getByRole('button', { name: 'Refresh usage' }).click();
      await expect(usage.getByRole('alert')).toContainText('temporarily unavailable');
      await expect(usage.getByText('Showing the last loaded figures.')).toBeVisible();
      await usage.getByRole('button', { name: 'Try again' }).click();
      await expect(usage.getByRole('alert')).toHaveCount(0);
      await expect(usage.locator('.usage-totals dd').nth(1)).toHaveText('240');
      check(
        'read failure keeps labeled previous figures and retries inline without losing the chat draft',
      );
      for (const theme of ['light', 'dark']) {
        await page.getByRole('button', { name: 'All settings', exact: true }).click();
        await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
        await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption(theme);
        await openUsage();
        await expect(usage.locator('.usage-totals dd').nth(0)).toHaveText('3');
        expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual(
          [],
        );
        if (mobile) await page.setViewportSize({ width: 320, height: 640 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (theme === 'dark')
          await page.screenshot({ path: join(evidence, `usage-${surface}-dark.png`) });
      }
      await page.reload();
      await expect(usage.locator('.usage-totals dd').nth(0)).toHaveText('3');
      await dock.getByRole('button', { name: 'Main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my usage draft');
      expect(f.store.read().messages).toEqual(messages);
      expect(f.requests).toHaveLength(3);
      expect(errors).toEqual([]);
      check(
        'light/dark accessibility, narrow screens, deep-link reload and preserved conversation/draft pass',
      );
    } finally {
      await app?.close();
      if (!mac) await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, mac ? 'usage-native-mac-acceptance.json' : 'usage-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Actual Relay worker/SQLite and controlled HTTP token counters. Not live provider billing, subscription allowances or physical-device acceptance.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
}
