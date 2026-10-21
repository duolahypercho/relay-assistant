// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import {
  maintenanceFixture,
  oldComputer,
  cleanupComputer,
} from './computer-maintenance-fixture.mjs';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { ComputerSetup } from '../server/computer-setup.mjs';
const native = process.argv.includes('--mac');
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/backup-controls');
await mkdir(evidence, { recursive: true });
const report = { checkedAt: new Date().toISOString(), passed: false, checks: [], native };
const password = 'synthetic control backup password';
const browser = native ? null : await chromium.launch({ channel: 'chrome' });
try {
  for (const name of native ? ['mac'] : ['desktop', 'phone']) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-backup-controls-'));
    let f, app, context, page;
    try {
      f = native
        ? await oldComputer(directory)
        : await maintenanceFixture(directory, { accessKey: 'synthetic-backup-controls-owner-key' });
      await f.computer.start('owner');
      await f.computer.takeControl();
      await f.computer.perform(
        {
          kind: 'exec',
          command:
            "printf 'saved from the backup controls' > controls.txt; dd if=/dev/zero of=large-backup.bin bs=1048576 count=10 status=none",
          operationId: crypto.randomUUID(),
        },
        { actor: 'owner' },
      );
      const target = join(directory, 'chosen.relaybackup');
      if (native) {
        f.store.close();
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${directory}`, '--relay-local-port=0'],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !/^(RELAY_|GOOGLE_|DOCKER_)/.test(key)),
            ),
            RELAY_MODE: 'sample',
            RELAY_BROWSER_ENABLED: 'false',
          },
        });
        await app.evaluate(({ dialog }, target) => {
          let calls = 0;
          dialog.showSaveDialog = async (_window, options) => {
            if (options.title !== 'Save computer backup') throw Error('Unexpected dialog');
            return ++calls === 1 ? { canceled: true } : { canceled: false, filePath: target };
          };
        }, target);
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: name === 'phone' ? { width: 390, height: 844 } : { width: 1360, height: 900 },
        });
        await context.request.post(f.url + '/api/login', {
          data: { key: 'synthetic-backup-controls-owner-key' },
        });
        page = await context.newPage();
        await page.goto(f.url + '/#chat');
      }
      page.setDefaultTimeout(30000);
      const errors = [],
        dialogs = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const call = (path, body) =>
        page.evaluate(
          async ({ path, body }) => {
            const response = await fetch(
              '/api' + path,
              body
                ? {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  }
                : undefined,
            );
            const result = await response.json();
            if (!response.ok) throw Error(result.error);
            return result;
          },
          { path, body },
        );
      const command = (command) =>
        call('/computer/action', { kind: 'exec', command, operationId: crypto.randomUUID() });
      await page.getByLabel('Message Relay', { exact: true }).fill('Keep my backup controls draft');
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await page.getByText('Restore points', { exact: true }).click();
      const panel = page.getByRole('region', { name: 'Restore points', exact: true });
      await panel.getByRole('button', { name: 'Save backup to a file', exact: true }).click();
      let form = page.getByRole('form', { name: 'Save computer backup' });
      await form.getByLabel('New backup password', { exact: true }).fill(password);
      await form
        .getByLabel('Repeat password', { exact: true })
        .fill('different synthetic password');
      await form.getByRole('button', { name: 'Save backup', exact: true }).click();
      await expect(form.getByRole('alert')).toHaveText('The passwords do not match.');
      assert.equal((await call('/computer/snapshots')).points.length, 0);
      await form.getByLabel('Repeat password', { exact: true }).fill(password);
      await form.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `backup-form-${name}.png`) });
      if (native) {
        await form.getByRole('button', { name: 'Save backup', exact: true }).click();
        await expect(
          form.getByText('Save cancelled. Your backup is ready if you want to try again.', {
            exact: true,
          }),
        ).toBeVisible({ timeout: 120000 });
        await assert.rejects(readFile(target), { code: 'ENOENT' });
        await form.getByRole('button', { name: 'Save file', exact: true }).click();
        await expect(
          form.getByText('Backup saved. Keep its password somewhere safe.', { exact: true }),
        ).toBeVisible({ timeout: 120000 });
      } else {
        const download = page.waitForEvent('download', { timeout: 120000 });
        await form.getByRole('button', { name: 'Save backup', exact: true }).click();
        await (await download).saveAs(target);
      }
      const bytes = await readFile(target);
      assert.ok(bytes.length > 10 * 1024 * 1024);
      assert.equal(bytes.subarray(0, 16).toString(), 'RELAY-COMPUTER-1');
      assert.ok(!bytes.includes('saved from the backup controls'));
      assert.equal((await call('/computer/snapshots')).points.length, 1);
      await form.getByRole('button', { name: 'Back to restore points', exact: true }).click();
      await command("printf 'later work' > controls.txt");
      await panel.getByRole('button', { name: 'Import backup', exact: true }).click();
      form = page.getByRole('form', { name: 'Import computer backup' });
      await form.getByLabel('Backup file', { exact: true }).setInputFiles(target);
      await form.getByLabel('Backup password', { exact: true }).fill('wrong synthetic password');
      await form.getByRole('button', { name: 'Import & review', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText('password is incorrect', {
        timeout: 120000,
      });
      assert.equal((await call('/computer/snapshots')).points.length, 1);
      assert.equal(await form.getByLabel('Backup file').evaluate((input) => input.files.length), 1);
      await form.getByLabel('Backup password', { exact: true }).fill(password);
      await form.getByRole('button', { name: 'Import & review', exact: true }).click();
      await expect(
        panel.getByRole('button', { name: 'Restore workspace', exact: true }),
      ).toBeVisible({ timeout: 120000 });
      assert.equal((await command('cat controls.txt')).stdout.trim(), 'later work');
      await page.screenshot({ path: join(evidence, `backup-import-review-${name}.png`) });
      await panel.getByRole('button', { name: 'Restore workspace', exact: true }).click();
      await expect(
        panel.getByText(
          'Your workspace is restored. Check your work, then give control back to Relay.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 120000 });
      assert.equal(
        (await command('cat controls.txt')).stdout.trim(),
        'saved from the backup controls',
      );
      assert.equal((await call('/computer/snapshots')).points.length, 3);
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).include('.computer-page').analyze())
          .violations,
        [],
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep my backup controls draft',
      );
      assert.equal((await call('/state')).messages.length, 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      report.checks.push({
        name,
        backupBytes: bytes.length,
        originalBytesRecovered: true,
        draftKept: true,
        nativeSaveDialog: native
          ? 'Controlled cancel/save responses; real packaged bridge and filesystem'
          : 'Browser download',
        accessibility: true,
      });
      console.log('PASS', name, 'backup controls');
    } finally {
      await context?.close();
      if (native) {
        await app?.close();
        const store = new Store(join(directory, 'workspace/relay.sqlite'));
        const computer = new PrivateComputer(store, { deployment: join(directory, 'workspace') });
        new ComputerSetup(computer, { environment: {} });
        await cleanupComputer({ store, computer });
        await rm(directory, { recursive: true, force: true });
      } else await f?.close();
    }
  }
  report.passed = true;
} finally {
  await browser?.close();
  await writeFile(
    join(evidence, `backup-controls-${native ? 'mac' : 'browser'}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
}
