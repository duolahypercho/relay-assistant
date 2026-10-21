// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { memoryFixture } from './memory-fixture.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-memory-ui-'));
    const fixture = await memoryFixture(directory);
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(fixture.url);
      const input = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      async function send(text) {
        await input.fill(text);
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await input.fill('Keep my trip draft');
      }
      await send('I prefer quiet hotels. Help me plan a weekend.');
      await expect(page.getByRole('button', { name: 'Memory saved', exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const savedLink = page.getByRole('button', { name: 'Memory saved', exact: true });
      if (mobile) {
        expect((await savedLink.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await savedLink.tap();
      } else await savedLink.click();
      const dialog = page.getByRole('dialog', { name: 'Your assistant', exact: true });
      await expect(dialog.getByText('Prefers quiet hotels.', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Learned from our chat', { exact: true })).toBeVisible();
      await expect(
        dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
      if (mobile) {
        for (const target of [
          dialog.locator('.memory-evidence summary'),
          dialog.getByRole('switch', { name: 'Learn from our chats' }),
          dialog.getByRole('button', { name: 'Edit memory Prefers quiet hotels.', exact: true }),
          dialog.getByRole('button', { name: 'Remove memory Prefers quiet hotels.', exact: true }),
        ]) {
          const bounds = await target.boundingBox();
          expect(bounds.height).toBeGreaterThanOrEqual(44);
          expect(bounds.width).toBeGreaterThanOrEqual(44);
        }
      }
      await dialog.getByText('Source quote', { exact: true }).click();
      await expect(dialog.getByText('I prefer quiet hotels', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `memory-learned-${label}.png`) });
      await dialog.getByRole('button', { name: 'From your message', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.search-match')).toContainText('I prefer quiet hotels');
      await expect(input).toHaveValue('Keep my trip draft');
      await page.getByRole('button', { name: 'Memory saved', exact: true }).click();
      await dialog
        .getByRole('button', { name: 'Edit memory Prefers quiet hotels.', exact: true })
        .click();
      await dialog.getByLabel('Edit memory', { exact: true }).fill('Quiet hotels with gardens.');
      await dialog.getByRole('button', { name: 'Save memory', exact: true }).click();
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await input.press('ControlOrMeta+A');
      await input.press('Backspace');
      await expect(input).toHaveValue('');
      await expect.poll(() => fixture.store.read().threads[0].draft).toBe('');
      await expect(input).toHaveValue('');
      await send('I now prefer lively hotels. Help me plan another trip.');
      await expect(
        page.getByRole('button', { name: 'Review memory update', exact: true }).last(),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Review memory update', exact: true }).last().click();
      await expect(dialog.getByText('Quiet hotels with gardens.', { exact: true })).toBeVisible();
      const proposal = dialog.getByRole('region', { name: 'Possible memory update', exact: true });
      await expect(proposal).toContainText('Prefers lively hotels.');
      expect(fixture.store.read().memories[0].text).toBe('Quiet hotels with gardens.');
      if (mobile) {
        const bounds = await proposal
          .getByRole('button', { name: 'Use update', exact: true })
          .boundingBox();
        expect(bounds.y).toBeGreaterThan(0);
        expect(bounds.y + bounds.height).toBeLessThan(844);
      }
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: join(evidence, `memory-proposal-${label}.png`) });
      await proposal.getByRole('button', { name: 'Use update', exact: true }).click();
      await expect(proposal).toHaveCount(0);
      await expect(dialog.getByText('Prefers lively hotels.', { exact: true })).toBeVisible();
      checks.push(
        `${label}: automatic learning links exact source, preserves draft, protects edited wording and applies an explicitly selected update without unsolicited dialogs`,
      );
      console.log('PASS', checks.at(-1));
      await dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }).click();
      await expect(
        dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await dialog
        .getByRole('button', { name: 'Remove memory Prefers lively hotels.', exact: true })
        .click();
      await expect(
        dialog.getByText('Tell me what you’d like me to remember.', { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(evidence, `memory-empty-${label}.png`) });
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await page.reload();
      await expect(input).toHaveValue('Keep my trip draft');
      await send('I prefer mountain hotels. Help me plan.');
      await expect(
        page.getByText(
          'Learning is off. I’ll use that for this conversation without saving a new memory.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      expect(fixture.store.read().memories).toHaveLength(0);
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await dialog.getByRole('button', { name: 'My memories', exact: true }).click();
      await expect(
        dialog.getByRole('switch', { name: 'Learn from our chats', exact: true }),
      ).toHaveAttribute('aria-checked', 'false');
      await dialog
        .getByRole('textbox', { name: 'New memory', exact: true })
        .fill('Keep Fridays free.');
      await dialog.getByRole('button', { name: 'Add memory', exact: true }).click();
      await expect(dialog.getByText('Keep Fridays free.', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Learned from our chat', { exact: true })).toHaveCount(0);
      expect(fixture.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(3);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(evidence, `memory-controls-${label}.png`) });
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(input).toHaveValue('Keep my trip draft');
      checks.push(
        `${label}: learning-off and forgetting survive reload; new messages stay unsaved; manual notes still work; no synthetic messages, lost draft, overflow, page errors or automated accessibility findings`,
      );
      console.log('PASS', checks.at(-1));
    } finally {
      await context.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'memory-ui-acceptance.json'),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        runtime:
          'Production web UI and real SQLite/server/worker; controlled model extraction decisions',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
