// SPDX-License-Identifier: MIT
// Controlled missing-result replies; real HTTP, worker, checkpoint, export and UI.
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { command } from '../shared/domain.mjs';
const expect = baseExpect.configure({ timeout: 15000 });
const evidence = resolve(
  process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/computer-delivery/ui',
);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  results = [];
const bytes = Buffer.from('Original saved checklist\nPassport\nCharger\n');
try {
  for (const width of [1365, 390, 320]) {
    const dir = await mkdtemp(join(tmpdir(), 'relay-computer-delivery-ui-'));
    await writeFile(join(dir, 'trip.txt'), bytes);
    let calls = 0,
      reads = 0;
    const f = await assistantsFixture(dir, {
      configure(store, services) {
        const computer = new PrivateComputer(store, { enabled: true, deployment: dir });
        computer.status = async () => ({
          enabled: true,
          state: 'running',
          controller: computer.controller,
        });
        computer.read = async (path) => {
          assert.equal(path, '.home/Downloads/trip.txt');
          reads++;
          return {
            name: 'trip.txt',
            base64: (await readFile(join(dir, 'trip.txt'))).toString('base64'),
          };
        };
        services.computer = computer;
      },
      respond() {
        if (++calls <= 2) return { role: 'assistant', content: 'The file is attached and ready!' };
        if (calls === 3)
          return {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'actual-export',
                type: 'function',
                function: {
                  name: 'computer_export',
                  arguments: JSON.stringify({ path: '.home/Downloads/trip.txt' }),
                },
              },
            ],
          };
        return { role: 'assistant', content: 'Your saved checklist is attached.' };
      },
    });
    f.store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 600,
      hasTouch: width < 600,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage(),
      errors = [],
      result = { width, passed: false };
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(f.url);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Find the saved checklist on your computer and attach the file here.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs[0]?.status).toBe('failed');
      await expect(page.locator('.messages')).toContainText(
        'The requested computer file was not attached.',
      );
      await expect(page.locator('.messages')).not.toContainText('The file is attached and ready!');
      assert.equal(calls, 2);
      assert.equal(reads, 0);
      assert.equal(f.store.read().files.length, 0);
      assert(
        f.requests[1].messages.some(
          (m) => typeof m.content === 'string' && m.content.startsWith('Relay delivery check:'),
        ),
      );
      await composer.fill('Keep my next thought.');
      await page.reload();
      await expect(composer).toHaveValue('Keep my next thought.');
      await page.screenshot({ path: join(evidence, `failure-${width}.png`) });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect.poll(() => f.store.read().runs[0]?.status).toBe('completed');
      await expect(page.locator('.messages')).toContainText('Your saved checklist is attached.');
      await expect(page.locator('.messages')).not.toContainText('The file is attached and ready!');
      assert.equal(calls, 4);
      assert.equal(reads, 1);
      assert.equal(f.store.read().runs.length, 1);
      assert.equal(f.store.read().files.length, 1);
      assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
      const file = f.store.read().files[0];
      assert.deepEqual(Buffer.from(file.base64, 'base64'), bytes);
      await expect(composer).toHaveValue('Keep my next thought.');
      await page
        .locator('.messages')
        .getByRole('button', { name: /trip\.txt/ })
        .click();
      await expect(page.locator('.document-preview pre')).toHaveText(bytes.toString());
      const pending = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download', exact: true }).click();
      const download = await pending;
      assert.equal(await download.failure(), null);
      const output = join(dir, 'download.txt');
      await download.saveAs(output);
      assert.deepEqual(await readFile(output), bytes);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my next thought.');
      await page.reload();
      await expect(composer).toHaveValue('Keep my next thought.');
      assert.equal(reads, 1);
      assert.equal(f.store.read().files.length, 1);
      assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(evidence, `delivered-${width}.png`) });
      result.passed = true;
      result.checks = [
        'unsupported completion withheld',
        'one private correction before honest failure',
        'reload and explicit retry preserve draft',
        'one original request/run and one actual export',
        'exact downloaded file bytes',
        'separate preview and unchanged history',
        'zero axe violations and no horizontal overflow',
      ];
      console.log(`PASS ${width}: missing delivery, retained retry, exact download and draft`);
    } catch (error) {
      result.error = error.stack;
      await page.screenshot({ path: join(evidence, `unexpected-${width}.png`) }).catch(() => {});
      throw error;
    } finally {
      results.push(result);
      await context.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  await writeFile(
    join(evidence, 'acceptance.json'),
    JSON.stringify(
      {
        passed: results.length === 3 && results.every((r) => r.passed),
        checkedAt: new Date().toISOString(),
        scope:
          'Controlled HTTP model and computer read bridge from an original fixture file; real worker/checkpoint/API and desktop/phone browsers. Actual isolated desktop and local inference have separate receipts.',
        results,
      },
      null,
      2,
    ),
  );
}
