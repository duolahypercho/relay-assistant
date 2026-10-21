// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelsFixture } from './models-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-models-ui-'));
    const fixture = await modelsFixture(directory);
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(fixture.url + '/#chat');
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep this chat draft');
      await page.goto(fixture.url + '/#settings?section=models');
      const panel = page.getByRole('article', { name: 'AI models', exact: true });
      await panel.getByRole('button', { name: 'Add a model', exact: true }).click();
      await panel.getByLabel('Provider', { exact: true }).selectOption('custom');
      await panel.getByLabel('Connection name', { exact: true }).fill('My chat model');
      await panel.getByLabel('Endpoint', { exact: true }).fill(fixture.baseUrl);
      await panel.getByLabel('API key (optional)', { exact: true }).fill('fixture-key');
      await panel.getByRole('button', { name: 'Find models', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('2 models found');
      await expect(panel.getByLabel('Model', { exact: true })).toHaveCount(0);
      await panel.getByLabel('Available models', { exact: true }).selectOption('relay-chat-test');
      await panel.getByRole('button', { name: 'Enter a model ID instead', exact: true }).click();
      await expect(panel.getByLabel('Available models', { exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('relay-chat-test');
      await panel.getByRole('button', { name: 'Choose from the list', exact: true }).click();
      await expect(panel.getByLabel('Available models', { exact: true })).toHaveValue(
        'relay-chat-test',
      );
      await panel.getByLabel('API key (optional)', { exact: true }).fill('fixture-key-refreshed');
      await expect(panel.getByLabel('Available models', { exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('relay-chat-test');
      await panel.getByLabel('API key (optional)', { exact: true }).fill('fixture-key');
      await panel.getByRole('button', { name: 'Test connection', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('The model replied');
      await panel.getByRole('button', { name: 'Save & use model', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Connection saved');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.reload();
      await expect(
        panel.getByRole('heading', { name: 'My chat model', exact: true }),
      ).toBeVisible();
      await page.goto(fixture.url + '/#chat');
      await expect(composer).toHaveValue('Keep this chat draft');
      await composer.fill('Hello through my saved model.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('This reply came through your saved chat connection.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      checks.push({
        surface: label,
        check:
          'discover, test, save, reload and real worker chat through saved HTTP endpoint; draft preserved; no setup chat messages',
        passed: true,
      });
      await page.goto(fixture.url + '/#settings?section=models');
      await panel.getByRole('button', { name: 'Add a model', exact: true }).click();
      await panel.getByLabel('Provider', { exact: true }).selectOption('custom');
      await panel.getByLabel('Connection name', { exact: true }).fill('My Claude model');
      await panel.getByLabel('Endpoint', { exact: true }).fill(fixture.baseUrl);
      await panel.getByLabel('API format', { exact: true }).selectOption('anthropic');
      await panel.getByLabel('API key (optional)', { exact: true }).fill('rejected-key');
      await panel.getByLabel('Model', { exact: true }).fill('relay-claude-test');
      await panel.getByRole('button', { name: 'Test connection', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('HTTP 401');
      await expect(panel.getByRole('alert')).not.toContainText('rejected-key');
      await panel.getByLabel('API key (optional)', { exact: true }).fill('fixture-key');
      await panel.getByRole('button', { name: 'Save & use model', exact: true }).click();
      await expect(
        panel.getByRole('heading', { name: 'My Claude model', exact: true }),
      ).toBeVisible();
      const publicState = fixture.provider.publicState();
      const a = publicState.connections.find((c) => c.name === 'My chat model');
      const b = publicState.connections.find((c) => c.name === 'My Claude model');
      await panel.getByLabel('Active connection', { exact: true }).selectOption(a.id);
      await expect(
        panel.getByRole('heading', { name: 'My chat model', exact: true }),
      ).toBeVisible();
      await panel.getByLabel('Active connection', { exact: true }).selectOption(b.id);
      await expect(
        panel.getByRole('heading', { name: 'My Claude model', exact: true }),
      ).toBeVisible();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `models-settings-${label}.png`) });
      await page.goto(fixture.url + '/#chat');
      await composer.fill('I prefer iced coffee. Remember that for tomorrow.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('I saved your coffee preference through the second model connection.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('button', { name: 'Memory saved', exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `models-tool-reply-${label}.png`) });
      expect(fixture.store.read().memories[0].text).toBe('Prefers iced coffee.');
      expect(fixture.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(2);
      expect(JSON.stringify(fixture.store.read())).not.toContain('fixture-key');
      await page.goto(fixture.url + '/#settings?section=models');
      await panel.getByRole('button', { name: 'Edit My chat model', exact: true }).click();
      await expect(panel.getByLabel('API key (optional)', { exact: true })).toHaveValue('');
      await expect(
        panel.getByText('A key is saved. Leave blank to keep it, or enter a replacement.'),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Remove connection', exact: true }).click();
      await panel.getByRole('button', { name: 'Remove saved connection', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Connection removed');
      await panel.getByLabel('Active connection', { exact: true }).selectOption('');
      await expect(panel.getByRole('heading', { name: 'AI is off', exact: true })).toBeVisible();
      await page.reload();
      await expect(panel.getByLabel('Active connection', { exact: true })).toHaveValue('');
      expect(fixture.provider.configured).toBe(false);
      expect(fixture.provider.publicState().connections).toHaveLength(1);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance & personality', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await page.getByRole('button', { name: 'All settings', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name: 'AI models', exact: true })
        .click();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `models-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        check:
          'provider errors, model switching, native-format tool loop, encrypted key retention, removal, disconnect persistence, light/dark accessibility and overflow',
        passed: true,
      });
      console.log(
        `PASS ${label}: model setup, switching, errors, real HTTP tool loop, persistence, key privacy and light/dark accessibility`,
      );
    } finally {
      await context.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'models-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provider: 'controlled local HTTP fixtures; no external model credentials',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
