// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { routineCommand } from '../shared/routines.mjs';
const mac = process.argv.includes('--mac');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/routine-updates');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [],
  previous = 'There are no new library openings.',
  current = 'No additional library openings were announced.';
try {
  for (const width of mac ? [1365] : [1365, 390, 320]) {
    const surface = mac ? 'mac' : `browser-${width}`;
    const directory = await mkdtemp(join(tmpdir(), 'relay-routine-ui-'));
    let text = previous;
    const f = await assistantsFixture(directory, {
      respond({ messages, tools }) {
        if (messages[0].content.startsWith('Compare routine updates')) {
          assert.equal((tools || []).length, 0);
          return {
            role: 'assistant',
            content: JSON.stringify({
              decision: text === current ? 'unchanged' : 'new',
              previousQuote: previous,
              currentQuote: text,
            }),
          };
        }
        return { role: 'assistant', content: text };
      },
    });
    const routine = f.store.mutate((s) =>
      routineCommand(s, 'routine.create', {
        title: 'Library watch',
        instructions: 'Watch library openings and tell me about changes.',
        threadId: 'main',
        schedule: { kind: 'interval', minutes: 60, timeZone: 'UTC' },
      }),
    );
    let app, context;
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
          viewport: { width, height: 950 },
          isMobile: width < 600,
          hasTouch: width < 600,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my unfinished message.');
      await expect.poll(() => f.store.read().threads[0].draft).toBe('Keep my unfinished message.');
      async function run(value, trigger = 'schedule') {
        text = value;
        const id = f.store.mutate((s) => {
          const r = routineCommand(s, 'routine.test', { id: routine.id });
          r.trigger = trigger;
          return r.id;
        });
        await expect
          .poll(() => f.store.read().runs.find((r) => r.id === id)?.status, { timeout: 15000 })
          .toBe('completed');
        return f.store.read().runs.find((r) => r.id === id);
      }
      assert((await run(previous)).surfaced);
      const quiet = await run(current);
      assert.equal(quiet.surfaced, false);
      assert.equal(f.store.read().messages.length, 1);
      assert.equal(f.store.read().notifications.length, 1);
      await page.goto(f.url + '/#routines');
      await page.getByText('Recent runs (2)', { exact: true }).click();
      await expect(
        page.getByText('Saved quietly · no meaningful change', { exact: true }),
      ).toBeVisible();
      await page.getByText('Why this stayed quiet', { exact: true }).click();
      await expect(page.getByText(`Previously: ${previous}`, { exact: true })).toBeVisible();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations,
        [],
      );
      await page.screenshot({ path: join(evidence, `quiet-${surface}.png`) });
      await page.reload();
      await page.getByText('Recent runs (2)', { exact: true }).click();
      await page.getByRole('button', { name: 'Show saved result in chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my unfinished message.');
      await expect(page.getByText(current, { exact: true })).toBeVisible();
      assert.equal(f.store.read().messages.length, 2);
      assert.equal(f.requests.length, 3); // Two task replies, one read-only comparison.
      const changed = await run('A new library opens on Saturday.');
      assert(changed.surfaced);
      await expect(page.getByText(changed.result.text, { exact: true })).toBeVisible();
      assert.equal(f.store.read().messages.length, 3);
      assert.equal(f.store.read().threads[0].draft, 'Keep my unfinished message.');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(evidence, `new-result-${surface}.png`) });
      checks.push({
        surface,
        passed: true,
        checks: [
          'one scheduled result, quiet paraphrase and surfaced new fact through the real worker',
          'saved explanation, explicit reveal, reload and retained Main draft',
          'no new modal, zero accessibility violations and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: selective routine updates`);
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
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Controlled HTTP model observations/comparison with actual Relay provider, worker, persistence and clients; semantic model quality checked separately.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
}
