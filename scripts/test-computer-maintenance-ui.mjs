// SPDX-License-Identifier: MIT
import { chromium, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';
const expect = baseExpect.configure({ timeout: 30000 });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const phone of [false, true]) {
    const label = phone ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-maintenance-ui-'));
    const f = await maintenanceFixture(directory);
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1365, height: 980 },
      isMobile: phone,
      hasTouch: phone,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(f.url);
      await page.getByLabel('Message Relay', { exact: true }).fill(`Keep my ${label} update draft`);
      const messages = f.store.read().messages;
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await page.getByRole('button', { name: 'Start computer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await page.getByText('Commands & activity', { exact: true }).click();
      await page
        .getByLabel('Private computer command')
        .fill(
          "printf 'Keep this file' > saved-before-update.txt; mkdir -p .home/chromium; printf 'profile marker' > .home/chromium/relay-profile-marker",
        );
      await page.getByRole('button', { name: 'Run command', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      const original = await f.computer.inspect();
      await page.getByText('Computer care', { exact: true }).first().click();
      await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Restart & update', exact: true })).toBeVisible(
        { timeout: 120000 },
      );
      expect((await f.computer.inspect()).Id).toBe(original.Id);
      expect(f.computer.controller).toBe('agent');
      expect(f.computer.image).toBe(f.oldImage);
      if (phone) {
        const button = page.getByRole('button', { name: 'Restart & update', exact: true });
        await expect
          .poll(() =>
            button.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight - 90),
          )
          .toBe(true);
      }
      await page.screenshot({ path: join(evidence, `computer-maintenance-review-${label}.png`) });
      await page.getByRole('button', { name: 'Not now', exact: true }).click();
      expect((await f.computer.inspect()).Id).toBe(original.Id);
      await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Restart & update', exact: true })).toBeVisible(
        { timeout: 120000 },
      );
      await page.reload();
      await page.getByText('Computer care', { exact: true }).first().click();
      await page.getByRole('button', { name: 'Restart & update', exact: true }).click();
      await expect(
        page.getByText(
          'Your computer is ready. Check your work, then give control back to Relay.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 60000 });
      const updated = await f.computer.inspect();
      expect(updated.Id).not.toBe(original.Id);
      expect(updated.Config.Image).not.toBe(f.oldImage);
      expect(f.computer.controller).toBe('owner');
      expect((await f.computer.runtime.inspect()).State.Paused).toBe(true);
      expect(
        Buffer.from((await f.computer.read('saved-before-update.txt')).base64, 'base64').toString(),
      ).toBe('Keep this file');
      expect(
        Buffer.from(
          (await f.computer.read('.home/chromium/relay-profile-marker')).base64,
          'base64',
        ).toString(),
      ).toBe('profile marker');
      await page.screenshot({ path: join(evidence, `computer-maintenance-ready-${label}.png`) });
      await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await expect(
        page.getByText('Your computer has the latest workspace included with this Relay app.', {
          exact: true,
        }),
      ).toBeVisible();
      expect((await f.computer.inspect()).Id).toBe(updated.Id);
      checks.push(
        `${label}: prepare without interrupting original computer, dismiss/reload review, apply new image, preserve file/profile bytes, pause new command runtime and report current without another restart`,
      );
      // A real broken display: freeze only this fixture's Xvfb, never the host display.
      await f.computer.checked([
        'exec',
        f.computer.name,
        'python3',
        '-c',
        'import pathlib,os,signal; [os.kill(int(p.name),signal.SIGSTOP) for p in pathlib.Path("/proc").iterdir() if p.name.isdigit() and (p/"comm").exists() and (p/"comm").read_text().strip()=="Xvfb"]',
      ]);
      await expect(page.getByRole('button', { name: 'Review recovery', exact: true })).toBeVisible({
        timeout: 45000,
      });
      await page.getByRole('button', { name: 'Review recovery', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Recover computer', exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(evidence, `computer-maintenance-recovery-${label}.png`) });
      await page.getByRole('button', { name: 'Recover computer', exact: true }).click();
      await expect(
        page.getByText(
          'Your computer is ready. Check your work, then give control back to Relay.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 60000 });
      expect((await f.computer.inspect()).Id).not.toBe(updated.Id);
      expect(
        Buffer.from((await f.computer.read('saved-before-update.txt')).base64, 'base64').toString(),
      ).toBe('Keep this file');
      await expect(page.locator('.computer-display img')).toBeVisible();
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        `Keep my ${label} update draft`,
      );
      expect(f.store.read().messages).toEqual(messages);
      expect(errors).toEqual([]);
      checks.push(
        `${label}: actual frozen guest display recovered into a fresh desktop; saved file, draft and chat history preserved; explicit handback, no dialogs/overflow/Axe errors`,
      );
      console.log(`PASS ${label} real update and display recovery`);
    } catch (error) {
      console.error('Maintenance state', f.maintenance.status());
      await page
        .screenshot({ path: join(evidence, `computer-maintenance-failed-${label}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await f.close();
    }
  }
  await writeFile(
    join(evidence, 'computer-maintenance-ui-acceptance.json'),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        limits:
          'Chrome desktop/phone emulation with real isolated Docker containers. Browser-profile bytes are preserved, not a live website sign-in test. No snapshot restoration or OS/VM repair.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
