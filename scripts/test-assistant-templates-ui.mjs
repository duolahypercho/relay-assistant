// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const native = process.env.RELAY_TEMPLATES_NATIVE === 'true';
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-template-ui-'));
    const publisher = await assistantsFixture(join(directory, 'publisher')),
      recipient = await assistantsFixture(join(directory, 'recipient'));
    const a = publisher.store.mutate((s) =>
      command(s, 'assistant.create', {
        name: 'Aster',
        description:
          'Plan quiet trips. API key: sk-syntheticsecret123456789 and https://localhost/private',
        tone: 'Brief',
        avatarColor: '#deba91',
      }),
    );
    publisher.store.mutate((s) =>
      command(s, 'memory.add', { assistantId: a.id, text: 'Private learned preference' }),
    );
    const skill = publisher.store.mutate((s) =>
      command(s, 'skill.create', {
        title: 'Plan a trip',
        slug: 'plan-trip',
        instructions: 'Read the calendar and suggest a plan.',
      }),
    );
    publisher.store.mutate((s) =>
      command(s, 'routine.create', {
        title: 'Travel check',
        instructions: 'Check travel weather',
        threadId: a.threadId,
        skillId: skill.id,
        schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      }),
    );
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    let app, page, publicPage;
    try {
      if (native) {
        const data = join(directory, 'native');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: publisher.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
        app.process().stderr.on('data', (chunk) => process.stderr.write(chunk));
        app.context().setDefaultTimeout(20000);
        await app.evaluate(async ({ clipboard, ClipboardItem }) => {
          const previous = [];
          for (const item of await clipboard.read()) {
            const content = {};
            for (const type of item.types) content[type] = await item.getType(type);
            if (Object.keys(content).length) previous.push(new ClipboardItem(content));
          }
          globalThis.__relayTemplateClipboard = previous;
        });
      } else {
        page = await context.newPage();
        await page.goto(publisher.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await page.getByLabel('Message Relay', { exact: true }).fill('Keep Main draft while sharing');
      await page.goto(publisher.url + '/#assistants');
      await page.getByRole('button', { name: 'Share Aster', exact: true }).click();
      const share = page.getByRole('region', { name: 'Share assistant template', exact: true });
      await expect(
        share.getByLabel('Template role and instructions', { exact: true }),
      ).not.toHaveValue(/syntheticsecret|localhost/);
      await expect(share.getByText(/Removed possible credentials/)).toBeVisible();
      await share.getByLabel('Template name', { exact: true }).fill('Aster travel kit');
      await share
        .getByLabel('Template role and instructions', { exact: true })
        .fill('Plan calm trips with room to rest.');
      await page.reload();
      await page.getByRole('button', { name: 'Share Aster', exact: true }).click();
      await expect(share.getByLabel('Template name', { exact: true })).toHaveValue(
        'Aster travel kit',
      );
      await share.getByRole('button', { name: 'Review template', exact: true }).click();
      await expect(
        share.getByRole('button', { name: 'Create public link', exact: true }),
      ).toBeVisible();
      let exported;
      if (!native) {
        const event = page.waitForEvent('download');
        await share.getByRole('link', { name: 'Download assistant template', exact: true }).click();
        const download = await event;
        exported = JSON.parse(await readFile(await download.path(), 'utf8'));
        expect(exported.profile.name).toBe('Aster travel kit');
        expect(JSON.stringify(exported)).not.toMatch(
          /Private learned preference|syntheticsecret|localhost|assistantId|sourceMessageId/,
        );
      }
      await share.getByRole('button', { name: 'Create public link', exact: true }).click();
      await expect(share.getByRole('status')).toContainText('Link created');
      const row = share.getByRole('article', { name: 'Shared template version 1', exact: true });
      const url = await row
        .getByRole('link', { name: 'View template details', exact: true })
        .getAttribute('href');
      await row.getByRole('button', { name: 'Copy link', exact: true }).click();
      await expect(share.getByRole('status')).toHaveText('Template link copied.');
      if (app) expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
      const raw = await (
        await fetch(publisher.url + '/api/shared-assistants/' + url.split('/').at(-1))
      ).json();
      expect(raw.template.profile.description).toBe('Plan calm trips with room to rest.');
      expect(publisher.store.read().assistants[0].description).toContain('syntheticsecret');
      expect(publisher.store.read().messages).toHaveLength(0);
      publicPage = await context.newPage();
      publicPage.on('pageerror', (e) => errors.push(e.message));
      await publicPage.goto(url);
      await expect(
        publicPage.getByRole('heading', { name: 'Aster travel kit', exact: true }),
      ).toBeVisible();
      await publicPage.screenshot({ path: join(evidence, `template-public-${label}.png`) });
      expect((await new AxeBuilder({ page: publicPage }).analyze()).violations).toEqual([]);
      expect(
        await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await expect(
        publicPage.getByRole('link', { name: 'Open in Relay', exact: true }),
      ).toHaveAttribute('href', /^relay-assistant:\/\/template\?url=/);
      await publicPage.getByText('Use a browser instead', { exact: true }).click();
      await publicPage.getByLabel('Your Relay server', { exact: true }).fill(recipient.url);
      await publicPage.getByRole('button', { name: 'Review in my Relay', exact: true }).click();
      const importer = publicPage.getByRole('region', {
        name: 'Import assistant template',
        exact: true,
      });
      await expect(importer.getByLabel('Template link', { exact: true })).toHaveValue(url);
      await importer.getByRole('button', { name: 'Load template', exact: true }).click();
      await expect(importer.getByRole('status')).toContainText('Template loaded');
      expect(recipient.store.read().assistants || []).toHaveLength(0);
      await importer.getByRole('button', { name: 'Review template', exact: true }).click();
      await importer.getByRole('button', { name: 'Add assistant', exact: true }).click();
      await expect(
        publicPage.getByLabel('Message Aster travel kit', { exact: true }),
      ).toBeVisible();
      const imported = recipient.store.read().assistants[0];
      expect(imported.description).toBe('Plan calm trips with room to rest.');
      expect(recipient.store.read().messages).toHaveLength(0);
      expect(recipient.store.read().memories).toHaveLength(0);
      expect(recipient.store.read().routines[0].paused).toBe(true);
      expect(recipient.store.read().runs).toHaveLength(0);
      await row.getByRole('button', { name: 'Update template', exact: true }).click();
      await share
        .getByLabel('Template role and instructions', { exact: true })
        .fill('Updated shared instructions, version two.');
      await share.getByRole('button', { name: 'Review template', exact: true }).click();
      await share.getByRole('button', { name: 'Update shared link', exact: true }).click();
      await expect(
        share.getByRole('article', { name: 'Shared template version 2', exact: true }),
      ).toBeVisible();
      expect(recipient.store.read().assistants[0].description).toBe(imported.description);
      await share
        .getByRole('heading', { name: 'Update shared template', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `template-sharing-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await share.getByRole('button', { name: 'Stop sharing', exact: true }).click();
      await expect(share.getByRole('status')).toContainText('Link stopped');
      expect((await fetch(url)).status).toBe(404);
      await publicPage.goto(recipient.url + '/#assistants');
      await publicPage.getByRole('button', { name: 'Import template', exact: true }).click();
      await importer.getByLabel('Template link', { exact: true }).fill(url);
      await importer.getByRole('button', { name: 'Load template', exact: true }).click();
      await expect(importer.getByRole('alert')).toContainText('unavailable');
      await importer.locator('input[type=file]').setInputFiles({
        name: 'invalid.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"memories":["should not import"]}'),
      });
      await expect(importer.getByRole('alert')).toContainText('unsupported');
      expect(recipient.store.read().assistants).toHaveLength(1);
      exported ||= raw.template;
      await importer.locator('input[type=file]').setInputFiles({
        name: 'assistant.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(exported)),
      });
      await expect(importer.getByRole('status')).toContainText('File loaded');
      await importer.getByRole('button', { name: 'Review template', exact: true }).click();
      await importer.getByRole('button', { name: 'Add assistant', exact: true }).click();
      await expect(
        publicPage.getByLabel('Message Aster travel kit', { exact: true }),
      ).toBeVisible();
      expect(recipient.store.read().assistants).toHaveLength(2);
      expect(recipient.store.read().skills.map((s) => s.slug)).toEqual([
        'plan-trip-2',
        'plan-trip',
      ]);
      await page.goto(publisher.url + '/#chat');
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Keep Main draft while sharing',
      );
      await page.goto(publisher.url + '/#settings?section=personal');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
      await page.goto(publisher.url + '/#assistants');
      await page.getByRole('button', { name: 'Share Aster', exact: true }).click();
      await page.screenshot({ path: join(evidence, `template-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'sanitized editable preview and persisted draft',
          'reviewed public link and copy',
          'isolated public preview',
          'cross-server browser import and paused routines',
          'immutable imported copy after link update',
          'revocation and malformed import rejection',
          'file import with unique skill shortcuts',
          'Main draft preserved and no navigation messages',
          'light/dark accessibility and overflow',
        ],
        downloadVerified: !native,
        nativeClipboardContentsVerified: native,
      });
      console.log(
        `PASS ${label}: reviewed templates, cross-server import, download/file import, update, revoke, privacy and accessibility`,
      );
    } catch (e) {
      if (page) await page.screenshot({ path: join(evidence, `template-failure-${label}.png`) });
      if (publicPage)
        await publicPage.screenshot({
          path: join(evidence, `template-recipient-failure-${label}.png`),
        });
      throw e;
    } finally {
      if (app) {
        await app
          .evaluate(async ({ clipboard }) => {
            const previous = globalThis.__relayTemplateClipboard;
            if (!previous) return;
            if (previous.length) await clipboard.write(previous);
            else await clipboard.clear();
            delete globalThis.__relayTemplateClipboard;
          })
          .catch(() => {});
        await app.close();
      }
      await context.close();
      await publisher.close();
      await recipient.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `templates-${native ? 'native' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Real isolated Relay servers; fictional configuration and deterministic local model services. No public deployment or external user data.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
