// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ideasFixture } from './ideas-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-ideas-ui-'));
    const fixture = await ideasFixture(directory);
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(fixture.url + '/#chat');
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await composer.fill('Keep my unfinished draft');
      await page.goto(fixture.url + '/#ideas');
      const ideas = page.getByRole('region', { name: 'Personal ideas' });
      await expect(ideas.getByLabel('Background suggestions')).toHaveValue('off');
      await ideas.getByRole('button', { name: 'Check for ideas', exact: true }).click();
      const card = ideas.getByRole('article', { name: 'A little room for a walk' });
      await expect(card).toBeVisible({ timeout: 15000 });
      expect(fixture.store.read().messages).toHaveLength(0);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].tools || []).toEqual([]);
      await card.locator('summary').click();
      await expect(card.getByRole('blockquote')).toHaveText('Walk outdoors');
      await card.getByRole('button', { name: 'Walk outdoors' }).click();
      await expect(page).toHaveURL(/#goals/);
      expect(fixture.store.read().messages).toHaveLength(0);
      await page.goto(fixture.url + '/#ideas');
      await card.getByRole('button', { name: 'Make a little progress' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await card
        .getByRole('textbox', { name: 'What would you like Relay to do?' })
        .fill('Plan a 15-minute walk for tomorrow.');
      await page.screenshot({ path: join(evidence, `ideas-edit-${label}.png`) });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await card.getByRole('button', { name: 'Send to Main chat' }).click();
      await expect(page).toHaveURL(/#chat/);
      await expect(
        page.getByText('Let’s start with a short route and choose a time that works for you.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 20000 });
      await expect(composer).toHaveValue('Keep my unfinished draft');
      expect(fixture.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(1);
      expect(fixture.store.read().messages.find((m) => m.role === 'user').text).toBe(
        'Plan a 15-minute walk for tomorrow.',
      );
      expect(fixture.store.read().memories).toHaveLength(0);
      await page.reload();
      await expect(composer).toHaveValue('Keep my unfinished draft');
      checks.push({
        surface: label,
        check:
          'HTTP model → sourced inline idea → edited request → worker reply; draft preserved after reload; source navigation and checks create no chat history',
        passed: true,
      });
      // New eligible topic state, then dismissal, restoration and provider error recovery.
      fixture.store.mutate((s) => {
        s.ideas.accepted = [];
      });
      await page.goto(fixture.url + '/#ideas');
      await ideas.getByRole('button', { name: 'Check for ideas', exact: true }).click();
      await expect(card).toBeVisible({ timeout: 15000 });
      await card.getByRole('button', { name: 'Dismiss A little room for a walk' }).click();
      await expect(card).toHaveCount(0);
      await page.reload();
      await ideas.getByRole('button', { name: 'Check for ideas', exact: true }).click();
      await expect(ideas.getByRole('button', { name: 'Check for ideas', exact: true })).toBeEnabled(
        { timeout: 15000 },
      );
      await expect(card).toHaveCount(0);
      await ideas.locator('.idea-hidden summary').click();
      await ideas.getByRole('button', { name: 'Restore A little room for a walk' }).click();
      fixture.controls.fail = true;
      await ideas.getByRole('button', { name: 'Check for ideas', exact: true }).click();
      await expect(ideas.getByRole('alert')).toContainText('could not finish');
      fixture.controls.fail = false;
      await ideas.getByRole('button', { name: 'Check for ideas', exact: true }).click();
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(ideas.getByRole('alert')).toHaveCount(0);
      await ideas.getByLabel('Background suggestions').selectOption('quiet');
      await page.reload();
      await expect(ideas.getByLabel('Background suggestions')).toHaveValue('quiet');
      await expect(ideas.getByRole('button', { name: 'Check for ideas', exact: true })).toBeEnabled(
        { timeout: 15000 },
      );
      await page.screenshot({ path: join(evidence, `ideas-ready-${label}.png`) });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.goto(fixture.url + '/#settings?section=personal');
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('dark');
      await page.goto(fixture.url + '/#ideas');
      await expect(card).toBeVisible();
      await page.screenshot({ path: join(evidence, `ideas-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(errors).toEqual([]);
      fixture.store.mutate((s) => {
        s.goals[0].title = 'Plan changed';
      });
      await expect(card).toHaveCount(0, { timeout: 10000 });
      expect(fixture.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(1);
      checks.push({
        surface: label,
        check:
          'dismiss/reload/restore, honest HTTP error and retry, quiet mode persistence, source invalidation, light/dark accessibility and phone overflow',
        passed: true,
      });
      console.log(
        `PASS ${label}: sourced ideas, inline edit, real HTTP chat, persistence, dismissal, errors, privacy and accessibility`,
      );
    } finally {
      await context.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'ideas-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provider: 'Controlled local HTTP model; does not establish hosted model quality',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
