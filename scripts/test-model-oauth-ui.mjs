// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { modelOAuthFixture } from './model-oauth-fixture.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const native = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    const dir = await mkdtemp(join(tmpdir(), 'relay-model-oauth-ui-')),
      f = await modelOAuthFixture(dir, { accessKey: 'fixture-owner' });
    const external = await browser.newContext();
    let context, page, app;
    try {
      if (native) {
        const data = join(dir, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
        context = app.context();
        await app.evaluate(({ shell }) => {
          globalThis.__modelSignIn = '';
          shell.openExternal = async (url) => {
            globalThis.__modelSignIn = url;
          };
        });
      } else {
        context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 675 } : { width: 1365, height: 900 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      context.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.getByLabel('Server access key', { exact: true }).fill('fixture-owner');
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my model-setup draft');
      await page.getByRole('button', { name: 'Self-hosted sample', exact: true }).click();
      const panel = page.getByRole('article', { name: 'AI models', exact: true });
      // Both setup routes must be reachable on the first screen, including a
      // short phone viewport, without the dock covering either action.
      const firstChoices = [];
      for (const name of ['Connect OpenRouter', 'Add a model']) {
        const choice = panel.getByRole('button', { name, exact: true });
        await expect(choice).toBeVisible();
        const box = await choice.boundingBox();
        const dock = await page.getByRole('button', { name: 'More', exact: true }).boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThan(dock.y);
        firstChoices.push({ name, y: box.y, height: box.height, dockTop: dock.y });
      }
      await page.screenshot({ path: join(evidence, `model-setup-simple-entry-${label}.png`) });
      await writeFile(
        join(evidence, `model-setup-simple-layout-${label}.json`),
        JSON.stringify({ checkedAt: new Date().toISOString(), firstChoices }, null, 2),
      );
      const begin = async () => {
        if (native) {
          await app.evaluate(() => {
            globalThis.__modelSignIn = '';
          });
          await panel.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
          await expect
            .poll(() => app.evaluate(() => globalThis.__modelSignIn))
            .toContain('/api/models/oauth/open?');
          const auth = await external.newPage();
          await auth.goto(await app.evaluate(() => globalThis.__modelSignIn));
          return auth;
        }
        const popup = context.waitForEvent('page');
        await panel.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
        const auth = await popup;
        await auth.getByRole('button', { name: 'Allow Relay', exact: true }).waitFor();
        return auth;
      };
      let auth = await begin();
      await expect(
        panel.getByText('Finish signing in with OpenRouter', { exact: true }),
      ).toBeVisible();
      expect(f.provider.configured).toBe(false);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await page.reload();
      await expect(
        panel.getByRole('button', { name: 'Cancel sign-in', exact: true }),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
      await auth.getByRole('button', { name: 'Allow Relay', exact: true }).click();
      await expect(
        auth.getByRole('heading', { name: 'Sign-in wasn’t completed.', exact: true }),
      ).toBeVisible();
      expect(f.exchanges).toHaveLength(0);
      await auth.close();
      auth = await begin();
      await auth.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('declined');
      await auth.close();
      f.setCatalogFailure(true);
      auth = await begin();
      await auth.getByRole('button', { name: 'Allow Relay', exact: true }).click();
      await expect(
        auth.getByRole('heading', { name: 'OpenRouter is connected.', exact: true }),
      ).toBeVisible();
      await auth.close();
      await expect(panel.getByRole('alert')).toContainText('model list could not load');
      expect(f.exchanges).toHaveLength(1);
      expect(f.provider.configured).toBe(false);
      expect(f.requests).toHaveLength(0);
      await expect(panel.getByLabel('API key', { exact: true })).toHaveCount(0);
      f.setCatalogFailure(false);
      await panel.getByRole('button', { name: 'Find models', exact: true }).click();
      await panel
        .getByLabel('Available models', { exact: true })
        .selectOption('fixture/conversation');
      await expect(
        panel.getByRole('button', { name: 'Test connection', exact: true }),
      ).toBeHidden();
      await panel.getByText('Connection details', { exact: true }).click();
      await expect(
        panel.getByRole('button', { name: 'Test connection', exact: true }),
      ).toBeVisible();
      await panel.getByText('Connection details', { exact: true }).click();
      expect(f.requests).toHaveLength(0);
      await page.screenshot({ path: join(evidence, `model-sign-in-choice-${label}.png`) });
      const axe = new AxeBuilder({ page });
      if (native) axe.setLegacyMode();
      expect((await axe.analyze()).violations).toEqual([]);
      await panel.getByRole('button', { name: 'Save & use model', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'OpenRouter', exact: true })).toBeVisible();
      expect(f.provider.publicState().connections).toHaveLength(1);
      expect(f.provider.current.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(f.keys.has(f.provider.current.apiKey)).toBe(true);
      for (const secret of f.keys) {
        expect(JSON.stringify(f.store.read())).not.toContain(secret);
        expect(JSON.stringify(f.provider.publicState())).not.toContain(secret);
        expect(await page.content()).not.toContain(secret);
      }
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my model-setup draft');
      await composer.fill('I prefer short replies. Remember that.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('I saved your preference through the signed-in model.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(f.store.read().memories[0].text).toBe('Prefers short replies.');
      expect(f.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(1);
      await composer.fill('Still here after model sign-in');
      await page.reload();
      await expect(composer).toHaveValue('Still here after model sign-in');
      await page.screenshot({ path: join(evidence, `model-sign-in-result-${label}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (!native) {
        await page.goto(f.url + '/#settings?section=models');
        await page.evaluate(() => {
          window.open = () => null;
        });
        await panel.getByRole('button', { name: 'Connect OpenRouter', exact: true }).click();
        const fallback = panel.getByRole('link', { name: 'Open sign-in', exact: true });
        await expect(fallback).toBeVisible();
        const authFallback = await external.newPage();
        await authFallback.goto(await fallback.getAttribute('href'));
        await expect(
          authFallback.getByRole('button', { name: 'Allow Relay', exact: true }),
        ).toBeVisible();
        await panel.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
        await authFallback.close();
        expect(f.provider.publicState().connections).toHaveLength(1);
        expect(f.exchanges).toHaveLength(1);
        expect(f.store.read().threads.find((t) => t.id === 'main').draft).toBe(
          'Still here after model sign-in',
        );
      }
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        check:
          'cancelled/reloaded and declined browser sign-in; PKCE exchange; catalog failure/retry; explicit save; actual HTTP model tool loop; durable draft and private key',
      });
      console.log(
        `PASS ${label}: OpenRouter-style browser sign-in, real HTTP exchange, explicit save, model tool loop and retained draft`,
      );
    } finally {
      if (app) await app.close();
      else await context?.close();
      await external.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `model-sign-in-${native ? 'native-mac' : 'browser'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Independent local HTTP authorization/model provider. No live OpenRouter account or provider-quality claim. Mac opener is intercepted and its returned URL exercised in an independent browser.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
