// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { readSkillDocument } from '../shared/skill-document.mjs';
const evidence = resolve('../relay-evidence'),
  native = process.argv.includes('--mac');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
const source =
  '---\nname: calm-plan\ndescription: Plan a quiet day.\nlicense: MIT\ncompatibility: Ask for the day before planning.\nmetadata:\n  author: Relay acceptance\nallowed-tools: calendar_write\n---\n\nAsk which day to plan. Suggest three calm activities. Prepare any changes for review.\n';
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-skill-files-'));
    const f = await assistantsFixture(directory, {
      respond: async () => ({
        role: 'assistant',
        content: 'Your saved calm plan method is ready.',
      }),
    });
    const original = f.store.mutate((s) =>
      command(s, 'skill.create', {
        title: 'Existing plan',
        slug: 'calm-plan',
        instructions: 'Keep the existing method.',
      }),
    );
    f.store.mutate((s) => command(s, 'skill.archive', { id: original.id }));
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
      context.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByLabel('Message Relay', { exact: true });
      await expect(composer).toBeVisible();
      await composer.fill('Keep my draft while adding a skill');
      await page.goto(f.url + '/#skills');
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      const sheet = page.getByRole('region', { name: 'Import a skill', exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      for (const file of [
        {
          name: 'SKILL.md',
          mimeType: 'text/markdown',
          buffer: Buffer.from('---\nname: bad\nname: duplicate\n---\nBody'),
        },
        { name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from([0xff, 0xfe, 0x00]) },
        {
          name: 'skill.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from('not a standalone file'),
        },
      ]) {
        await sheet.locator('input[type=file]').setInputFiles(file);
        await expect(sheet.getByRole('alert')).toBeVisible();
        expect(f.store.read().skills).toHaveLength(1);
      }
      await sheet.locator('input[type=file]').setInputFiles({
        name: 'SKILL.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(source),
      });
      await expect(sheet.getByLabel('Skill file', { exact: true })).toHaveValue(source);
      await sheet.locator('input[type=file]').setInputFiles({
        name: 'SKILL.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from([0xff]),
      });
      await expect(sheet.getByRole('alert')).toBeVisible();
      await expect(sheet.getByLabel('Skill file', { exact: true })).toHaveValue('');
      await expect(sheet.getByRole('button', { name: 'Review skill', exact: true })).toBeDisabled();
      await sheet.locator('input[type=file]').setInputFiles({
        name: 'SKILL.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(source),
      });
      await expect(sheet.getByLabel('Skill file', { exact: true })).toHaveValue(source);

      await sheet.getByRole('button', { name: 'Review skill', exact: true }).click();
      await expect(sheet.getByLabel('Shortcut', { exact: true })).toHaveValue('calm-plan-2');
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await sheet.getByLabel('Skill name', { exact: true }).fill('My calm plan');
      await sheet.getByRole('button', { name: 'Back to file', exact: true }).click();
      await expect(sheet.getByLabel('Skill file', { exact: true })).toHaveValue(/My calm plan/);
      await sheet.getByRole('button', { name: 'Review skill', exact: true }).click();
      await expect(sheet.getByLabel('Skill name', { exact: true })).toHaveValue('My calm plan');
      await page.screenshot({ path: join(evidence, `skill-import-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await sheet.getByRole('button', { name: 'Add skill', exact: true }).click();
      const card = page.getByRole('article', { name: 'My calm plan', exact: true });
      await expect(card).toBeVisible();
      expect(f.store.read().skills).toHaveLength(2);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      const imported = f.store.read().skills.find((s) => s.slug === 'calm-plan-2');
      expect(imported.documentMeta.license).toBe('MIT');
      expect(imported.documentMeta.metadata.author).toBe('Relay acceptance');
      expect(f.store.read().skills.find((s) => s.id === original.id)).toEqual({
        ...original,
        archived: true,
      });
      await card.getByRole('button', { name: 'Edit skill', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Edit skill', exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await editor
        .getByLabel('Instructions', { exact: true })
        .fill('Ask which day to plan. Suggest three calm activities and a break.');
      await editor.getByRole('button', { name: 'Save skill', exact: true }).click();
      await expect(card).toContainText('v2');
      await card.getByRole('button', { name: 'Share skill', exact: true }).click();
      const share = page.getByRole('region', { name: 'Share a skill', exact: true });
      await share.getByRole('button', { name: 'Review skill', exact: true }).click();
      let downloadedPath;
      if (app) {
        downloadedPath = join(directory, 'SKILL.md');
        await app.evaluate(({ app, BrowserWindow }, path) => {
          app.skillDownload = null;
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => {
              item.setSavePath(path);
              item.once('done', (_event, state) => {
                app.skillDownload = { name: item.getFilename(), state };
              });
            },
          );
        }, downloadedPath);
        await share.getByRole('link', { name: 'Download reviewed skill', exact: true }).click();
        await expect
          .poll(() => app.evaluate(({ app }) => app.skillDownload))
          .toEqual({ name: 'SKILL.md', state: 'completed' });
      } else {
        const event = page.waitForEvent('download');
        await share.getByRole('link', { name: 'Download reviewed skill', exact: true }).click();
        const download = await event;
        expect(download.suggestedFilename()).toBe('SKILL.md');
        downloadedPath = await download.path();
      }
      const exported = await readFile(downloadedPath, 'utf8'),
        parsed = readSkillDocument(exported);
      expect(parsed.title).toBe('My calm plan');
      expect(parsed.documentMeta.license).toBe('MIT');
      expect(exported).not.toMatch(/allowed-tools:|sourceMessageId|skill_/);
      await share.getByRole('button', { name: 'Back to skills', exact: true }).click();
      await card.getByRole('button', { name: 'Run skill', exact: true }).click();
      await page.getByLabel('Anything for this run?', { exact: true }).fill('Sunday');
      await page.getByRole('button', { name: 'Run in this chat', exact: true }).click();
      await expect(
        page.getByText('Your saved calm plan method is ready.', { exact: true }),
      ).toBeVisible();
      await expect(composer).toHaveValue('Keep my draft while adding a skill');
      expect(JSON.stringify(f.requests)).toContain('Suggest three calm activities and a break.');
      expect(JSON.stringify(f.requests)).toContain(
        'Requirements noted by the skill author: Ask for the day before planning.',
      );
      expect(f.store.read().runs[0].skill.version).toBe(2);
      await page.goto(f.url + '/#skills');
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      await sheet.locator('input[type=file]').setInputFiles({
        name: 'SKILL.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(exported),
      });
      await sheet.getByRole('button', { name: 'Review skill', exact: true }).click();
      await expect(sheet.getByLabel('Shortcut', { exact: true })).toHaveValue('calm-plan-2-2');
      await sheet.getByRole('button', { name: 'Add skill', exact: true }).click();
      await expect(sheet).toBeHidden();
      expect(f.store.read().skills).toHaveLength(3);
      expect(f.store.read().runs).toHaveLength(1);
      await page.reload();
      await expect(page.getByRole('article', { name: 'My calm plan', exact: true })).toHaveCount(2);
      await page.goto(f.url + '/#settings?section=personal');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
      await page.goto(f.url + '/#skills');
      await page.getByRole('button', { name: 'Import skill', exact: true }).click();
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await page.screenshot({ path: join(evidence, `skill-import-dark-${label}.png`) });
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'invalid YAML, UTF-8 and package rejection',
          'real file input and reviewed metadata',
          'collision-safe import, no automatic run or grant',
          'inline editor and preserved review edits',
          'downloaded SKILL.md bytes and round-trip',
          'live HTTP model receives frozen version and requirements',
          'Main draft preserved',
          'light/dark accessibility and overflow',
        ],
      });
      console.log(
        `PASS ${label}: reviewed skill files, inline editing, download, live run, draft and accessibility`,
      );
    } catch (e) {
      if (page) await page.screenshot({ path: join(evidence, `skill-file-failure-${label}.png`) });
      throw e;
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `skill-files-${native ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Isolated real Relay servers with independent deterministic HTTP model; standalone SKILL.md only.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
