import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  skillPackageFixture,
  packageZip,
  packageMethod,
  packageAnswer,
} from './skill-package-fixture.mjs';
import { readSkillPackage } from '../server/skill-package.mjs';
import { skillFiles } from '../shared/skill-package.mjs';
const native = process.argv.includes('--mac'),
  evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-skill-package-'));
    const f = await skillPackageFixture(directory);
    let context, page, app;
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
      context.setDefaultTimeout(20000);
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      const composer = page.getByLabel('Message Relay', { exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Keep my packing question');
      await page.goto(f.url + '/#skills');
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      const sheet = page.getByRole('region', { name: 'Import a skill', exact: true });
      await sheet.locator('input[type=file]').setInputFiles({
        name: 'packing-list.zip',
        mimeType: 'application/zip',
        buffer: packageZip,
      });
      await expect(sheet.getByLabel('Skill file', { exact: true })).toHaveValue(/packing-list/);
      await sheet.getByText('4 supporting files', { exact: true }).click();
      await sheet.locator('summary').filter({ hasText: 'scripts/pack.py' }).click();
      await expect(sheet.locator('pre:visible')).toContainText('writer.writerows');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await sheet.getByRole('button', { name: 'Review skill', exact: true }).click();
      expect(f.store.read().skills).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await page.screenshot({ path: join(evidence, `skill-package-review-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await sheet.getByRole('button', { name: 'Add skill', exact: true }).click();
      const card = page.getByRole('article', { name: 'My packing list', exact: true });
      await expect(card).toBeVisible();
      expect(f.store.read().skills[0].files).toEqual(skillFiles(packageMethod.files));
      await card.getByRole('button', { name: 'Edit skill', exact: true }).click();
      await page
        .getByLabel('Instructions', { exact: true })
        .fill(packageMethod.instructions + '\nDouble-check the row count.');
      await page.getByRole('button', { name: 'Save skill', exact: true }).click();
      expect(f.store.read().skills[0].files).toEqual(skillFiles(packageMethod.files));
      await card.getByRole('button', { name: 'Share skill', exact: true }).click();
      await page.getByRole('button', { name: 'Review skill', exact: true }).click();
      if (!native) {
        const pending = page.waitForEvent('download');
        await page.getByLabel('Download reviewed skill', { exact: true }).click();
        const download = await pending;
        expect(download.suggestedFilename()).toBe('packing-list.zip');
        expect((await readSkillPackage(await readFile(await download.path()))).files).toEqual(
          skillFiles(packageMethod.files),
        );
      }
      await page.getByRole('button', { name: 'Back to skills', exact: true }).click();
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await card.getByRole('button', { name: 'Run skill', exact: true }).click();
      await page.getByRole('button', { name: 'Run in this chat', exact: true }).click();
      await expect(page.getByText(packageAnswer, { exact: true })).toBeVisible({ timeout: 90000 });
      await expect(composer).toHaveValue('Keep my packing question');
      await expect(page.locator('.search-match')).toHaveCount(0);
      expect(f.errors).toEqual([]);
      expect(f.steps).toEqual([0, 1, 2, 3, 4]);
      const result = f.store.read().files.find((f) => f.name === 'packing-list.csv');
      const csv = Buffer.from(result.base64, 'base64').toString();
      expect(csv).toBe('item,packed\r\npassport,no\r\ncafé mug,no\r\n茶,no\r\n');
      expect(f.store.read().messages).toHaveLength(2);
      expect(f.store.read().runs[0].skill.version).toBe(2);
      expect(pageErrors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(evidence, `skill-package-result-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      checks.push({
        label,
        passed: true,
        modelRequests: f.requests.length,
        fileBytes: Buffer.byteLength(csv),
        computerExecution: 'Python 3 in isolated Docker runtime',
        download: !native,
      });
    } finally {
      await app?.close();
      if (!app) await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `skill-packages-${native ? 'native-mac' : 'browser'}-acceptance.json`),
    JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks }, null, 2),
  );
  console.log(
    'PASS: ZIP import, reference/script review, frozen edit, exact export, real private-computer execution and chat result',
    checks,
  );
} finally {
  await browser.close();
}
