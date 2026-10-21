// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelCapabilitiesFixture } from './model-capabilities-fixture.mjs';
const native = process.argv.includes('--mac'),
  checks = [],
  evidence = resolve('../relay-evidence');
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-abilities-'));
    const f = await modelCapabilitiesFixture(directory, {
      thinking: { values: [false, true], default: true },
    });
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
      await composer.fill('Keep my model abilities draft');
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      const setup = page.getByRole('region', { name: 'Local model setup', exact: true });
      await setup
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', 'text-chat']));
      await expect(setup).toContainText(
        'Chat & documents · Attach text, PDF or Office files and ask.',
      );
      assert.equal(f.requests.length, 0);
      assert.equal(f.provider.configured, false);
      await page.screenshot({ path: join(evidence, `model-capabilities-${label}.png`) });
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await go('#chat');
      await expect(composer).toHaveValue('Keep my model abilities draft');
      await composer.fill('Hello!');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('Hello! We can chat here without tools.', { exact: true }),
      ).toBeVisible();
      assert.equal(f.requests[0].tools, undefined);
      assert.equal(f.provider.current.replyMode, 'quick');
      assert.equal(f.requests[0].reasoning_effort, 'none');
      assert.equal(f.store.read().memories.length, 0);
      const before = f.requests.length;
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles({
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Keep these attached notes.'),
        });
      await composer.fill('Read my attached notes');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs.at(-1)?.status).toBe('completed');
      assert.equal(f.requests.length, before + 1);
      assert(JSON.stringify(f.requests.at(-1)).includes('Keep these attached notes.'));
      assert.equal(f.requests.at(-1).tools, undefined);
      assert.equal(f.store.read().files.length, 1);
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', 'tools-chat']));
      await expect(setup).toContainText('Assistant actions supported · No image support.');
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await go('#chat');
      await composer.fill('Remember: I prefer iced coffee.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByText('I saved your coffee preference.', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      assert.equal(f.store.read().memories.length, 1);
      assert(f.requests.some((r) => r.tools?.length));
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Edit Ollama · tools-chat', exact: true }).click();
      const replyStyle = page.getByRole('combobox', { name: 'Reply style', exact: true });
      await expect(replyStyle).toHaveValue('quick');
      await replyStyle.selectOption('default');
      await replyStyle.scrollIntoViewIfNeeded();
      await expect(replyStyle).toBeInViewport();
      await page.screenshot({ path: join(evidence, `quick-replies-${label}.png`) });
      await page
        .getByRole('combobox', { name: 'Assistant actions', exact: true })
        .selectOption('unsupported');
      await page
        .getByRole('combobox', { name: 'Image support', exact: true })
        .selectOption('unsupported');
      await page.getByRole('button', { name: 'Save & use model', exact: true }).click();
      await expect(page.getByText(/Chat & documents · Attach text/)).toBeVisible();
      await page.reload();
      await expect(page.getByText(/Chat & documents · Attach text/)).toBeVisible();
      assert.equal(f.provider.current.abilities.tools, 'unsupported');
      assert.equal(f.provider.current.replyMode, 'default');
      await page.getByRole('button', { name: 'Use a local model', exact: true }).click();
      await setup
        .getByLabel('Local model', { exact: true })
        .selectOption(JSON.stringify(['ollama', 'tools-chat']));
      await expect(setup).toContainText(
        'Chat & documents · Attach text, PDF or Office files and ask.',
      );
      await setup.getByRole('button', { name: 'Use this model', exact: true }).click();
      await go('#chat');
      await composer.fill('Hello again');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => f.store.read().runs.at(-1)?.status).toBe('completed');
      assert.equal(f.requests.at(-1).tools, undefined);
      assert.equal(f.requests.at(-1).reasoning_effort, undefined);
      await go('#settings?section=models');
      await page.getByRole('button', { name: 'Edit Ollama · tools-chat', exact: true }).click();
      await expect(replyStyle).toHaveValue('default');
      await replyStyle.selectOption('quick');
      await page.getByRole('button', { name: 'Save & use model', exact: true }).click();
      assert.equal(f.provider.current.replyMode, 'quick');
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await go('#settings?section=models');
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations,
        [],
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(evidence, `model-capabilities-dark-${label}.png`) });
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'Capabilities before selection, no inference or chat insertion during setup',
          'Text-only worker conversation omits tools',
          'Attached text is read directly, with original preserved',
          'Tool-capable model still performs real memory action',
          'Manual override persists across reload and affects future turns',
          'Quick replies only send supported local thinking control; model default persists and omits it',
          'Light/dark accessibility, viewport fit, draft retention',
        ],
      });
      console.log('PASS', label, 'model abilities');
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
  join(evidence, `model-capabilities-${native ? 'native-mac' : 'ui'}-acceptance.json`),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      passed: true,
      checks,
      scope:
        'Production Relay and independent HTTP model fixture; real model inference is a separate acceptance.',
    },
    null,
    2,
  ),
);
