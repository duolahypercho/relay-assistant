// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { command } from '../shared/domain.mjs';
import { appContentJourneyFixture } from './app-content-journey-fixture.mjs';
const mac = process.argv.includes('--mac');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/picked-templates');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const width of mac ? [1365] : [1365, 390, 320]) {
    const surface = mac ? 'mac' : `browser-${width}`;
    const directory = await mkdtemp(join(tmpdir(), 'relay-picked-template-'));
    const f = await appContentJourneyFixture(directory, {
      connected: true,
      completions: true,
      sse: width < 600,
      pickedTemplate: true,
      expectedMood: 'curious',
    });
    f.store.mutate((s) => {
      const file = command(s, 'file.add', {
        name: 'My draft.txt',
        mime: 'text/plain',
        text: 'Keep this attachment.',
      });
      s.threads[0].draftFileIds = [file.id];
    });
    let app, context, page, release;
    try {
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
          viewport: { width, height: 950 },
          isMobile: width < 600,
          hasTouch: width < 600,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my unfinished thought.');
      const before = f.store.read();
      async function open() {
        await page
          .getByRole('navigation', { name: 'Workspace shortcuts' })
          .getByRole('button', { name: 'More', exact: true })
          .click();
        await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
        await page
          .getByRole('button', { name: 'Templates in Little library', exact: true })
          .click();
      }
      async function choose() {
        await page.getByRole('button', { name: /A calmer plan Use a gentle/ }).click();
      }
      await open();
      const search = page.getByRole('searchbox', { name: 'Find a template', exact: true });
      await search.fill('missing');
      await expect(page.getByText('No matching templates.')).toBeVisible();
      await search.fill('calmer');
      await expect(page.locator('.app-document-row')).toHaveCount(1);
      expect(f.remote.calls).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await choose();
      const mood = page.getByRole('textbox', { name: 'mood', exact: true });
      await mood.fill('quiet');
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await page.reload();
      await open();
      await choose();
      await expect(mood).toHaveValue('quiet');
      f.remote.hold(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
      await expect.poll(() => f.remote.calls.length).toBe(1);
      await page.getByRole('button', { name: 'Cancel opening', exact: true }).click();
      await expect.poll(() => f.services.connectors.active.size).toBe(0);
      release();
      f.remote.hold(undefined);
      for (const key of ['messages', 'runs', 'approvals'])
        expect(f.store.read()[key]).toEqual(before[key]);
      await mood.fill('cu');
      await page.getByRole('button', { name: 'Find options for mood', exact: true }).click();
      await page
        .getByRole('group', { name: 'Options for mood' })
        .getByRole('button', { name: 'curious', exact: true })
        .click();
      await expect(mood).toHaveValue('curious');
      expect(f.remote.suggestions[0].params).toEqual({
        ref: { type: 'ref/prompt', name: 'quiet_plan' },
        argument: { name: 'mood', value: 'cu' },
      });
      await page.screenshot({ path: join(evidence, `template-fields-${surface}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      let lose = true;
      await page.route('**/api/connectors/templates/use', async (route) => {
        if (lose) {
          lose = false;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Connection interrupted. Try again.' }),
          });
        }
        return route.continue();
      });
      await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Connection interrupted');
      await expect
        .poll(() => f.store.read().runs.filter((r) => r.status === 'completed').length)
        .toBe(1);
      await page.reload();
      await page.getByRole('button', { name: 'Templates in Little library', exact: true }).click();
      await choose();
      await expect(mood).toHaveValue('curious');
      await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('My draft.txt');
      await expect(
        page.locator('.message.assistant').filter({ hasText: 'Here is a gentle plan:' }),
      ).toHaveCount(1);
      const state = f.store.read();
      expect(state.messages.filter((m) => m.role === 'user')).toHaveLength(1);
      expect(state.runs).toHaveLength(1);
      expect(state.approvals).toHaveLength(0);
      expect(state.memories).toEqual(before.memories);
      expect(f.remote.calls).toHaveLength(2);
      expect(f.remote.calls.every((c) => c.method === 'prompts/get')).toBe(true);
      expect(f.requests).toHaveLength(1);
      expect(state.messages.find((m) => m.role === 'user').fileIds).toEqual([]);
      await page.reload();
      await expect(composer).toHaveValue('Keep my unfinished thought.');
      await expect(
        page.getByRole('group', { name: 'Draft attachments', exact: true }),
      ).toContainText('My draft.txt');
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(evidence, `template-chat-${surface}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'metadata-only searchable template picker',
          'retained template fields and chat draft across navigation/reload',
          'cancelled retrieval creates no chat work',
          'explicit contextual choices and plain fields',
          'lost completed response reuses one retrieval/request/reply after reload',
          'draft attachment retained and never sent by template action',
          'no additional review or learned memory',
          'accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: chosen template, durable retry and retained drafts`);
    } catch (error) {
      await page?.screenshot({ path: join(evidence, `failure-${surface}.png`) }).catch(() => {});
      throw error;
    } finally {
      release?.();
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
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Independent MCP and controlled HTTP model, real Relay worker and clients; no live vendor or general model-quality claim.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
}
