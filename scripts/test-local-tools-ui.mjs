// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localToolsFixture } from './local-tools-fixture.mjs';
const native = process.argv.includes('--mac');
const browser = native ? null : await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-local-ui-'));
    const f = await localToolsFixture(directory);
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
      page.setDefaultTimeout(45000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page
        .getByRole('textbox', { name: 'Message Relay', exact: true })
        .fill('Keep my local tool draft');
      const before = f.store.read().messages;
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
      await page.getByRole('button', { name: 'Add an app', exact: true }).click();
      await page.getByText('Other connection options', { exact: true }).click();
      await page
        .getByRole('button', { name: 'Use a program in Relay’s computer', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Run and find tools', exact: true }),
      ).toBeDisabled();
      await expect(page.getByLabel('App address', { exact: true })).toHaveCount(0);
      await page.getByLabel('Program', { exact: true }).fill('python3');
      await page.getByLabel('Arguments', { exact: true }).fill('/workspace/local-tools.py');
      await page.getByText('Folder and environment', { exact: true }).click();
      await page.getByLabel('Variable name', { exact: true }).fill('LOCAL_KEY');
      await page.getByRole('button', { name: 'Add variable', exact: true }).click();
      await page.getByLabel('Value for LOCAL_KEY', { exact: true }).fill('fictional-local-secret');
      await page.getByText('Folder and environment', { exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page
        .getByLabel('Arguments', { exact: true })
        .fill('/workspace/local-tools.py\n--slow-init');
      await page.getByRole('button', { name: 'Run and find tools', exact: true }).click();
      await expect
        .poll(
          async () => {
            try {
              return Buffer.from(
                (await f.computer.read('local-initializing.txt')).base64,
                'base64',
              ).toString();
            } catch {
              return '';
            }
          },
          { timeout: 45000 },
        )
        .toBe('started');
      await page.getByRole('button', { name: 'Cancel connection check', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Connection check cancelled.');
      await expect.poll(() => f.computer.stdio.rows().length, { timeout: 30000 }).toBe(0);
      expect(f.connectors.read()).toHaveLength(0);
      await page.getByLabel('Arguments', { exact: true }).fill('/workspace/local-tools.py');
      await page.screenshot({
        path: join(evidence, `local-tools-setup-${label}.png`),
        fullPage: true,
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.getByRole('button', { name: 'Run and find tools', exact: true }).click();
      await expect(page.getByLabel('Permission for Save local note', { exact: true })).toHaveValue(
        'ask',
      );
      expect(f.connectors.read()).toHaveLength(0);
      expect(f.computer.stdio.rows()).toHaveLength(0);
      await page.getByLabel('App name', { exact: true }).fill('Local notebook');
      await page.getByLabel('Permission for Read local note', { exact: true }).selectOption('auto');
      for (const title of ['Inspect tool computer', 'Slow local write', 'Interrupted local write'])
        await page.getByLabel(`Permission for ${title}`, { exact: true }).selectOption('off');
      await page.getByRole('button', { name: 'Connect selected tools', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Manage Local notebook', exact: true }),
      ).toBeVisible();
      expect(f.store.read().messages).toEqual(before);
      const publicView = await (await page.request.get(`${f.url}/api/connectors`)).text();
      expect(publicView).not.toContain('fictional-local-secret');
      await page.getByRole('button', { name: 'Manage Local notebook', exact: true }).click();
      await page.getByText('Folder and environment', { exact: true }).click();
      await expect(page.getByLabel('Value for LOCAL_KEY', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Value for LOCAL_KEY', { exact: true })).toHaveAttribute(
        'placeholder',
        'Saved value',
      );
      await page.getByRole('button', { name: 'Close app editor', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      await expect(composer).toHaveValue('Keep my local tool draft');
      await composer.fill('Read my local notebook and save a calm Sunday plan.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const approval = page.getByRole('button', { name: 'Approve app action', exact: true });
      await expect(approval).toBeVisible({ timeout: 45000 });
      expect(f.store.read().approvals.filter((a) => a.kind === 'connector')).toHaveLength(1);
      await page.screenshot({
        path: join(evidence, `local-tools-review-${label}.png`),
        fullPage: true,
      });
      await approval.click();
      await expect(page.getByText('Your local note is saved.', { exact: true })).toBeVisible({
        timeout: 45000,
      });
      const saved = Buffer.from(
        (await f.computer.read('local-note.txt')).base64,
        'base64',
      ).toString();
      expect(saved).toBe('A quiet Sunday, saved by the local tool.');
      expect(f.computer.stdio.rows()).toHaveLength(0);
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        platform: label,
        passed: true,
        realDockerStdio: true,
        discoveryBeforeSave: true,
        encryptedEnvironment: true,
        exactReviewedWrite: true,
        workerContinuation: true,
        draftPreserved: true,
        axeViolations: 0,
      });
    } catch (error) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `local-tools-failure-${label}.png`) })
          .catch(() => {});
      throw error;
    } finally {
      await app?.close();
      if (!native) await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `local-tools-${native ? 'mac' : 'browser'}-acceptance.json`),
    JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2) + '\n',
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser?.close();
}
