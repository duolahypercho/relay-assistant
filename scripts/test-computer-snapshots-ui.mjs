// SPDX-License-Identifier: MIT
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { maintenanceFixture } from './computer-maintenance-fixture.mjs';
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' }),
  checks = [];
try {
  for (const [name, viewport] of [
    ['desktop', { width: 1360, height: 960 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-snapshots-ui-')),
      f = await maintenanceFixture(directory);
    const context = await browser.newContext({ viewport }),
      page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [],
      dialogs = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const command = async (text) =>
      f.computer.perform(
        { kind: 'exec', command: text, operationId: crypto.randomUUID() },
        { actor: 'owner' },
      );
    const read = async (path) =>
      Buffer.from((await f.computer.read(path)).base64, 'base64').toString();
    try {
      await f.computer.start('owner');
      await f.computer.takeControl();
      await command(
        "printf 'saved before' > snapshot-note.txt; mkdir -p .home/chromium; printf 'profile before' > .home/chromium/relay-snapshot-marker; ln -s snapshot-note.txt note-link",
      );
      const original = (await f.computer.inspect()).Id,
        volume = f.computer.volume;
      await page.goto(f.url + '/#chat');
      await page.getByLabel('Message Relay', { exact: true }).fill('Keep my restore-point draft');
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await page.getByText('Restore points', { exact: true }).click();
      const panel = page.getByRole('region', { name: 'Restore points', exact: true });
      await panel.getByRole('button', { name: 'Save restore point', exact: true }).click();
      await expect(
        panel.getByText('Restore point saved. Your computer is ready to use.', { exact: true }),
      ).toBeVisible({ timeout: 120000 });
      expect(f.snapshots.points()).toHaveLength(1);
      expect((await f.computer.inspect()).Id).toBe(original);
      expect((await f.computer.inspect()).State.Paused).toBe(false);
      expect((await f.computer.runtime.inspect()).State.Paused).toBe(true);
      await command(
        "printf 'changed later' > snapshot-note.txt; printf 'profile after' > .home/chromium/relay-snapshot-marker; printf 'new file' > later.txt",
      );
      await panel.getByRole('button', { name: /Review restore point/ }).click();
      await expect(
        panel.getByRole('button', { name: 'Restore workspace', exact: true }),
      ).toBeVisible();
      expect(f.computer.volume).toBe(volume);
      expect(await read('snapshot-note.txt')).toBe('changed later');
      await panel.getByRole('button', { name: 'Not now', exact: true }).click();
      expect(f.computer.volume).toBe(volume);
      await panel.getByRole('button', { name: /Review restore point/ }).click();
      await page.reload();
      await page.getByText('Restore points', { exact: true }).click();
      await expect(
        panel.getByRole('button', { name: 'Restore workspace', exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: join(evidence, `computer-snapshots-review-${name}.png`) });
      await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
      await expect(
        panel.getByText(
          'Your workspace is restored. Check your work, then give control back to Relay.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 120000 });
      expect(f.computer.volume).not.toBe(volume);
      expect((await f.computer.inspect()).Id).not.toBe(original);
      expect(await read('snapshot-note.txt')).toBe('saved before');
      expect(await read('.home/chromium/relay-snapshot-marker')).toBe('profile before');
      await expect(async () => {
        const result = await command('readlink note-link; test ! -e later.txt');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('snapshot-note.txt');
      }).toPass();
      expect(f.computer.controller).toBe('owner');
      expect((await f.computer.runtime.inspect()).State.Paused).toBe(true);
      expect(f.snapshots.points()).toHaveLength(2);
      expect(f.store.db.prepare('SELECT volume FROM computer_workspace').get().volume).toBe(
        f.computer.volume,
      );
      await page.screenshot({ path: join(evidence, `computer-snapshots-restored-${name}.png`) });
      await panel
        .locator('li')
        .filter({ hasText: 'Before restore' })
        .getByRole('button', { name: /Review restore point/ })
        .click();
      await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
      await expect(
        panel.getByText(
          'Your workspace is restored. Check your work, then give control back to Relay.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 120000 });
      expect(await read('snapshot-note.txt')).toBe('changed later');
      expect(await read('later.txt')).toBe('new file');
      expect(await read('.home/chromium/relay-snapshot-marker')).toBe('profile after');
      const count = f.snapshots.points().length;
      await panel
        .locator('li')
        .filter({ hasText: 'Saved restore point' })
        .getByRole('button', { name: /Review removal/ })
        .click();
      await panel.getByRole('button', { name: 'Not now', exact: true }).click();
      expect(f.snapshots.points()).toHaveLength(count);
      await panel
        .locator('li')
        .filter({ hasText: 'Saved restore point' })
        .getByRole('button', { name: /Review removal/ })
        .click();
      await panel.getByRole('button', { name: 'Remove restore point', exact: true }).click();
      await expect(panel.getByText('Restore point removed.', { exact: true })).toBeVisible();
      expect(f.snapshots.points()).toHaveLength(count - 1);
      // A special file fails closed before copying; the desktop still thaws and saved points remain intact.
      await command('mkfifo unsupported-pipe');
      await panel.getByRole('button', { name: 'Save restore point', exact: true }).click();
      await expect(panel.getByRole('alert')).toContainText('named pipes', { timeout: 60000 });
      expect((await f.computer.inspect()).State.Paused).toBe(false);
      expect(f.snapshots.storedOperation()).toBe(null);
      expect(f.snapshots.points()).toHaveLength(count - 1);
      await command('rm unsupported-pipe');
      expect(
        (await new AxeBuilder({ page }).include('.computer-page').analyze()).violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my restore-point draft',
      );
      expect(f.store.read().messages).toHaveLength(0);
      expect(errors).toEqual([]);
      expect(dialogs).toEqual([]);
      checks.push(
        `${name}: real saved-file/profile/symlink capture; original desktop preserved; review cancel/reload; restoration removes later files; automatic previous point restores later work; reviewed removal; failed capture cleans up and thaws; owner freeze/handback; no chat changes, dialogs, overflow or Axe errors`,
      );
      console.log('PASS', name, 'restore-point lifecycle');
    } finally {
      await context.close();
      await f.close();
    }
  }
  await writeFile(
    join(evidence, 'computer-snapshots-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        checks,
        limits:
          'Real Docker/Colima and Chrome desktop/phone layouts. Saved workspace files/profile only; not unsaved application memory, lost disks, native clients, live account compatibility or a live model.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
