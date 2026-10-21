// SPDX-License-Identifier: MIT
// Controlled bad model output against the real worker, checkpoint, API and UI.
import { chromium, _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';

const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/artifact-completion');
const mac = process.argv.includes('--mac');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const width of mac ? [1365] : [1365, 390]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-artifact-completion-'));
    let calls = 0;
    const f = await assistantsFixture(directory, {
      respond() {
        if (++calls <= 2)
          return { role: 'assistant', content: 'Counter.html is ready in your workspace!' };
        if (calls === 3)
          return {
            role: 'assistant',
            content: 'Saving your counter.',
            tool_calls: [
              {
                id: 'save-counter',
                type: 'function',
                function: {
                  name: 'save_artifact',
                  arguments: JSON.stringify({
                    kind: 'web',
                    title: 'Counter',
                    source:
                      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><output>0</output><button onclick="document.querySelector(\'output\').textContent=++count">Add one</button><script>let count=0</script></body></html>',
                  }),
                },
              },
            ],
          };
        return { role: 'assistant', content: 'Your counter is saved and ready to use.' };
      },
    });
    f.store.mutate((s) => command(s, 'profile.update', { memoryLearning: false }));
    const context = mac
      ? null
      : await browser.newContext({
          viewport: { width, height: 950 },
          isMobile: width === 390,
          hasTouch: width === 390,
        });
    if (mac) await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
    const app = mac
      ? await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        })
      : null;
    const page = mac ? await app.firstWindow() : await context.newPage(),
      pageErrors = [];
    if (mac)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.hide()),
      );
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const result = {
      surface: mac ? 'mac' : width === 390 ? 'phone-browser' : 'desktop-browser',
      passed: false,
    };
    try {
      await page.goto(f.url);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Make a little interactive page titled Counter.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs[0]?.status, { timeout: 15000 }).toBe('failed');
      await expect(page.locator('.messages')).toContainText('The requested result was not saved.');
      await expect(page.locator('.messages')).not.toContainText('Counter.html is ready');
      assert.equal(calls, 2);
      assert.equal(f.store.read().files.length, 0);
      await composer.fill('Keep this thought for later.');
      await page.reload();
      await expect(composer).toHaveValue('Keep this thought for later.');
      await page.screenshot({ path: join(evidence, `artifact-completion-${width}-failure.png`) });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect.poll(() => f.store.read().runs[0]?.status, { timeout: 15000 }).toBe('completed');
      await expect(composer).toHaveValue('Keep this thought for later.');
      assert.equal(calls, 4);
      assert.equal(f.store.read().artifacts.length, 1);
      assert.equal(f.store.read().files.length, 1);
      assert.equal(f.store.read().runs.length, 1);
      assert.equal(f.store.read().messages.filter((m) => m.role === 'user').length, 1);
      const messages = f.store.read().messages.length;
      await page
        .locator('.messages')
        .getByRole('button', { name: /Counter.*Version 1/ })
        .click();
      await expect(page.getByRole('article', { name: 'Result viewer' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const frame = page.frameLocator('iframe[title$="interactive preview"]');
      await frame.getByRole('button', { name: 'Add one', exact: true }).click();
      await expect(frame.getByText('1', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `artifact-completion-${width}-result.png`) });
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep this thought for later.');
      await expect(page.locator('.messages')).not.toContainText('Counter.html is ready');
      assert.equal(f.store.read().messages.length, messages);
      assert.deepEqual(pageErrors, []);
      result.passed = true;
      result.checks = [
        'unsupported completion withheld',
        'one automatic recovery then honest failure',
        'reload and explicit retry preserve draft',
        'one original request and one saved result',
        'working interactive preview on separate page without dialog or history noise',
      ];
      console.log(`PASS ${result.surface}: grounded completion, retry and usable result`);
    } catch (error) {
      result.error = String(error);
      await page
        .screenshot({ path: join(evidence, `artifact-completion-${width}-unexpected-failure.png`) })
        .catch(() => {});
      throw error;
    } finally {
      results.push(result);
      await context?.close();
      await app?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
  await writeFile(
    join(evidence, 'artifact-completion-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: results.length === (mac ? 1 : 2) && results.every((r) => r.passed),
        scope: mac
          ? 'Packaged Mac connected to an isolated test backend; controlled model HTTP output, real worker and persistence. Not live-model or bundled-backend evidence.'
          : 'Controlled model HTTP output; real worker, persistence, browser and phone viewport. Not real-model or native-phone evidence.',
        results,
      },
      null,
      2,
    ),
  );
}
