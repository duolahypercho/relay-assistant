// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localModelSetupFixture } from './local-model-setup-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const native = process.argv.includes('--mac');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-local-setup-'));
    const f = await localModelSetupFixture(directory);
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    let app, page;
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
        page = await context.newPage();
        await page.goto(f.url + '/#chat');
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my setup draft');
      const go = (hash) =>
        page.evaluate((value) => {
          location.hash = value;
        }, hash);
      await go('#settings?section=models');
      const panel = page.getByRole('article', { name: 'AI models', exact: true });
      await expect(
        panel.getByRole('button', { name: 'Use a local model', exact: true }),
      ).toBeVisible();
      assert.equal(f.requests.length, 0, 'Opening Settings must not scan local services.');
      await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
      const setup = page.getByRole('region', { name: 'Local model setup', exact: true });
      await expect(setup.getByLabel('Local model', { exact: true })).toHaveValue(
        JSON.stringify(['ollama', 'local-chat']),
      );
      assert.equal(f.provider.configured, false);
      assert.equal(f.store.read().messages.length, 0);
      assert(f.requests.every((r) => r.method === 'GET' || r.url.endsWith('/api/show')));
      await expect(setup.getByLabel('Endpoint', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await setup.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `local-model-setup-${label}.png`) });
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

      f.setMode('multiple');
      await setup.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(setup.getByLabel('Local model', { exact: true })).toHaveValue('');
      await setup
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', 'local-vision']));
      await expect(
        setup.getByRole('button', { name: 'Use this model', exact: true }),
      ).toBeEnabled();
      f.setMode('empty');
      await setup.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(setup).toContainText('is running with no models listed.');
      await expect(setup.getByRole('button', { name: 'Use this model', exact: true })).toHaveCount(
        0,
      );
      f.setMode('offline');
      await setup.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(setup.getByRole('status')).toContainText('No local models found');
      await page.screenshot({ path: join(evidence, `local-model-empty-${label}.png`) });
      f.setMode('slow');
      await setup.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(setup.getByRole('status')).toContainText('Looking for local models');
      await setup.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(setup).toHaveCount(0);
      assert.equal(f.provider.configured, false);
      f.setMode('ready');
      await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup.getByRole('button', { name: 'Enter connection details', exact: true }).click();
      await expect(panel.getByLabel('Provider', { exact: true })).toHaveValue('ollama');
      await expect(panel.getByLabel('Endpoint', { exact: true })).toHaveValue(
        'http://127.0.0.1:11434/v1',
      );
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Connection saved');
      assert.equal(f.provider.current.model, 'local-chat');
      assert.equal(f.store.read().messages.length, 0);
      await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await expect(setup).toHaveCount(0);
      assert.equal(
        f.provider.publicState().connections.length,
        1,
        'Reusing a local model must not create duplicate connections.',
      );
      await go('#chat');
      await expect(composer).toHaveValue('Keep my setup draft');
      await composer.fill('Hello from my local model.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('Your local model is connected. We can keep talking here.', { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await composer.fill('Keep this after setup');
      await page.reload();
      await expect(composer).toHaveValue('Keep this after setup');
      await go('#settings?section=models');
      await expect(
        panel.getByRole('heading', { name: 'Ollama · local-chat', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await go('#settings?section=models');
      await panel.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await expect(
        setup.getByRole('button', { name: 'Use this model', exact: true }),
      ).toBeVisible();
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      assert.deepEqual(errors, []);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'Two-action single-model setup, no key/URL entry, no setup inference or chat messages',
          'Multiple models, empty and unavailable services, cancel during discovery and manual fallback',
          'Explicit activation, saved-connection reuse, actual worker reply and draft/reload preservation',
          'Light/dark automated accessibility, no overflow or page errors',
        ],
      });
      console.log('PASS', label, 'local model setup and recovery');
    } finally {
      await app?.close();
      await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      native
        ? 'local-model-setup-native-mac-acceptance.json'
        : 'local-model-setup-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Controlled local model transport. Browser phone layout is not native mobile acceptance.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
