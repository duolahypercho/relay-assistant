// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelDownloadFixture } from './local-model-download-fixture.mjs';
const native = process.argv.includes('--mac'),
  checks = [],
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-model-download-ui-'));
    const f = await localModelDownloadFixture(directory);
    let app, context, page;
    const errors = [];
    try {
      if (native) {
        await writeFile(join(directory, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`],
        });
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.on('pageerror', (e) => errors.push(e.message));
      const go = (hash) =>
        page.evaluate((hash) => {
          location.hash = hash;
        }, hash);
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my download setup draft');
      await go('#settings?section=models');
      const open = () =>
        page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      assert.equal(f.pulls.length, 0);
      await open();
      const setup = page.getByRole('region', { name: 'Local model setup', exact: true });
      const download = page.getByRole('region', { name: 'Download a local model', exact: true });
      const start = () =>
        download.getByRole('button', { name: 'Download · about 4 GB', exact: true }).click();
      await expect(download).toContainText('Downloads to your Relay computer');
      assert.equal(f.pulls.length, 0);
      await page.screenshot({ path: join(evidence, `local-model-download-empty-${label}.png`) });
      await start();
      await expect(download.getByRole('progressbar')).toHaveAttribute('value', '1200000000');
      assert.equal(f.provider.configured, false);
      assert.equal(f.store.read().messages.length, 0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.screenshot({ path: join(evidence, `local-model-download-progress-${label}.png`) });
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      await go('#chat');
      await expect(composer).toHaveValue('Keep my download setup draft');
      assert.equal(f.downloads.status().download.phase, 'running');
      await go('#settings?section=models');
      await open();
      await expect(download.getByRole('progressbar')).toBeVisible();
      await page.reload();
      await open();
      await expect(download.getByRole('progressbar')).toBeVisible();
      assert.equal(f.pulls.length, 1, 'Navigation/reload must not start another pull.');
      await download.getByRole('button', { name: 'Cancel download', exact: true }).click();
      await expect(download).toContainText('Download cancelled.');
      assert.equal(f.downloads.status().download.phase, 'cancelled');
      f.setMode('error');
      await start();
      await expect(download.getByRole('alert')).toContainText('The download did not finish');
      assert(!(await download.innerText()).includes('private-provider-detail'));
      f.setMode('hold');
      await start();
      await expect(download.getByRole('progressbar')).toBeVisible();
      f.finish();
      await expect(setup.getByLabel('Local model', { exact: true })).toHaveValue(
        JSON.stringify(['ollama', 'qwen3.5:4b']),
      );
      assert.equal(f.provider.configured, false);
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      assert.equal(f.provider.current.model, 'qwen3.5:4b');
      assert.equal(f.store.read().messages.length, 0);
      await go('#chat');
      await expect(composer).toHaveValue('Keep my download setup draft');
      await composer.fill('Hello from the downloaded model');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('Your downloaded model is connected.', { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await go('#settings?section=models');
      await open();
      await download.getByText('Get another model', { exact: true }).click();
      await download
        .getByRole('button', { name: 'Choose another Ollama model', exact: true })
        .click();
      await download
        .getByLabel('Ollama model tag', { exact: true })
        .fill('https://must-not-fetch.test/model:tag');
      await download.getByRole('button', { name: 'Download model', exact: true }).click();
      await expect(download.getByRole('alert')).toContainText('Enter an Ollama model and tag');
      assert.equal(f.pulls.length, 3);
      await download.getByLabel('Ollama model tag', { exact: true }).fill('publisher/small:latest');
      await download.getByRole('button', { name: 'Download model', exact: true }).click();
      await expect(download.getByRole('progressbar')).toBeVisible();
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await go('#settings?section=models');
      await expect(download.getByRole('progressbar')).toBeVisible();
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(evidence, `local-model-download-dark-${label}.png`) });
      f.finish();
      await expect(setup.getByLabel('Local model', { exact: true })).toHaveValue(
        JSON.stringify(['ollama', 'publisher/small:latest']),
      );
      assert.equal(
        f.provider.current.model,
        'qwen3.5:4b',
        'New download must not change the active model.',
      );
      assert.deepEqual(errors, []);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'Empty service to explicit download, per-file progress, no popup',
          'Navigation/reload retains one download and chat draft',
          'Cancel, retry, provider error redaction and custom tag validation',
          'Confirmed installation followed by explicit activation and actual worker reply',
          'Second model preselected without changing active connection',
          'Light/dark accessibility, no horizontal overflow or page errors',
        ],
      });
      console.log('PASS', label, 'local model download');
    } finally {
      await app?.close();
      await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
}
await writeFile(
  join(evidence, `local-model-download-${native ? 'native-mac' : 'ui'}-acceptance.json`),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      passed: true,
      checks,
      scope:
        'Production UI/API/worker with independent streaming HTTP Ollama fixture; no live weight transfer or inference in this fixture.',
    },
    null,
    2,
  ),
);
