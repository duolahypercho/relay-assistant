// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  skillRepositoryAcceptance,
  repositoryLink,
  repositoryAnswer,
} from './skill-repository-acceptance.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const surface = native ? 'native-mac' : mobile ? 'phone' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-repository-ui-'));
    const f = await skillRepositoryAcceptance(directory);
    let app, context, page;
    try {
      if (native) {
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
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
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
      const composer = page.getByLabel('Message Relay', { exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Keep my draft while adding a linked skill');
      await page.goto(f.url + '/#skills');
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      const sheet = page.getByRole('region', { name: 'Import a skill', exact: true }),
        field = sheet.getByLabel('GitHub skill link', { exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(sheet.getByLabel('Skill file', { exact: true })).toHaveCount(0);
      await sheet.getByRole('button', { name: 'Paste instructions', exact: true }).click();
      await expect(sheet.getByLabel('Skill file', { exact: true })).toBeVisible();
      await field.fill('https://example.invalid/skill');
      await sheet.getByRole('button', { name: 'Load skill', exact: true }).click();
      await expect(sheet.getByRole('alert')).toContainText('public GitHub');
      await expect(field).toHaveValue('https://example.invalid/skill');
      f.verifyReview();
      expect(f.remote.calls).toHaveLength(0);
      await field.fill(repositoryLink);
      f.remote.setDelay(4000);
      await sheet.getByRole('button', { name: 'Load skill', exact: true }).click();
      await expect(
        sheet.getByRole('button', { name: 'Cancel download', exact: true }),
      ).toBeVisible();
      await expect.poll(() => f.services.skillRepository.active).toBe(1);
      await sheet.getByRole('button', { name: 'Cancel download', exact: true }).click();
      await expect.poll(() => f.services.skillRepository.active).toBe(0);
      await expect(field).toHaveValue(repositoryLink);
      f.verifyReview();
      await sheet.getByRole('button', { name: 'Load skill', exact: true }).click();
      await expect.poll(() => f.services.skillRepository.active).toBe(1);
      await sheet.getByRole('button', { name: 'Back to skills', exact: true }).click();
      await expect.poll(() => f.services.skillRepository.active).toBe(0);
      f.verifyReview();
      f.remote.setDelay(0);
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      await field.fill(repositoryLink);
      await sheet.getByRole('button', { name: 'Load skill', exact: true }).click();
      await expect(sheet.getByLabel('Shortcut', { exact: true })).toHaveValue('calm-plan-2');
      f.verifyReview();
      await expect(
        sheet.getByRole('link', { name: 'relay-tests/methods · 1111111' }),
      ).toHaveAttribute(
        'href',
        `https://github.com/relay-tests/methods/tree/${f.commit}/calm-plan`,
      );
      await sheet.getByLabel('Skill name', { exact: true }).fill('My linked plan');
      await sheet.locator('summary[aria-label="4 supporting files"]').click();
      await sheet.locator('summary').filter({ hasText: 'scripts/check.py' }).click();
      await expect(sheet).toContainText('Import must never run this script');
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(evidence, `skill-repository-review-${surface}.png`) });
      await sheet.getByRole('button', { name: 'Add skill', exact: true }).click();
      const card = page.getByRole('article', { name: 'My linked plan', exact: true });
      await expect(card).toBeVisible();
      f.verifySaved();
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await page.reload();
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Run skill', exact: true }).click();
      await page.getByLabel('Anything for this run?', { exact: true }).fill('Sunday');
      await page.getByRole('button', { name: 'Run in this chat', exact: true }).click();
      await expect(page.getByText(repositoryAnswer, { exact: true })).toBeVisible();
      await expect(composer).toHaveValue('Keep my draft while adding a linked skill');
      f.verifyRun();
      await page.goto(f.url + '/#settings?section=personal');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
      await page.goto(f.url + '/#skills');
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(evidence, `skill-repository-entry-${surface}.png`) });
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        exactFiles: 4,
        checks: [
          'Invalid link retains input without a request',
          'Cancel and leaving abort download; no late review',
          'One load opens version-pinned editable review without a dialog',
          'Exact binary/text/script/license import and duplicate-safe save',
          'Reload, model reference read, frozen run and preserved draft',
          'Light/dark accessibility and viewport fit',
        ],
      });
      console.log(
        `PASS ${surface}: repository import, cancellation, exact files, reference tool, draft and accessibility`,
      );
    } catch (error) {
      if (page)
        await page.screenshot({ path: join(evidence, `skill-repository-failure-${surface}.png`) });
      throw error;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `skill-repository-${native ? 'mac' : 'ui'}.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        scope:
          'Real Relay HTTP/SQLite/worker with independent original GitHub-shaped HTTP service and controlled model. Actual public GitHub access is a separate receipt.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
}
