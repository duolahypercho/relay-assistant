// SPDX-License-Identifier: MIT
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { avatarFixture } from '../tests/fixtures/avatar.mjs';
import { command } from '../shared/domain.mjs';
import { assistantProfile } from '../shared/assistant-scope.mjs';
import { prepareTemplate } from '../shared/assistant-templates.mjs';
import { AssistantTemplates, templateReview } from '../server/assistant-templates.mjs';
const native = process.env.RELAY_APPEARANCE_NATIVE === 'true',
  evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'mobile' : 'desktop',
      directory = await mkdtemp(join(tmpdir(), 'relay-appearance-ui-'));
    const f = await assistantsFixture(directory);
    let app, page, publicPage;
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    context.setDefaultTimeout(20000);
    try {
      if (native) {
        const data = join(directory, 'native');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        page = await app.firstWindow();
        app.context().setDefaultTimeout(20000);
      } else {
        page = await context.newPage();
        await page.goto(f.url);
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await page.getByLabel('Message Relay', { exact: true }).fill('Preserve my Main thought');
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await page.getByRole('button', { name: 'Personalize', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Assistant profile', exact: true }),
        appearance = page.getByRole('region', { name: 'Assistant appearance', exact: true });
      await expect(editor.getByRole('heading', { name: 'Edit Relay', exact: true })).toBeVisible();
      await appearance.getByRole('button', { name: 'Puff character', exact: true }).click();
      await page.reload();
      await expect(
        appearance.getByRole('button', { name: 'Puff character', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await appearance
        .getByRole('button', { name: 'Preview character greeting', exact: true })
        .click();
      await expect(appearance.locator('.appearance-preview [data-look=puff]')).toHaveAttribute(
        'data-pose',
        'wave',
      );
      await page.screenshot({ path: join(evidence, `appearance-editor-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect.poll(() => assistantProfile(f.store.read()).appearance?.shape).toBe('puff');
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.locator('.companion-character [data-look=puff]')).toBeVisible();
      await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
        'Preserve my Main thought',
      );
      expect(f.store.read().messages).toHaveLength(0);
      await page.goto(f.url + '/#assistants');
      await page.getByRole('button', { name: 'New assistant', exact: true }).click();
      await editor.getByLabel('Assistant name', { exact: true }).fill('Mochi');
      await editor
        .getByLabel('Role and instructions', { exact: true })
        .fill('Make room for creative work.');
      const encodedPictures = await page.evaluate(
        async (png) => {
          const img = new Image();
          img.src = png;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          return ['image/jpeg', 'image/webp'].map((type) => ({
            type,
            data: canvas.toDataURL(type).split(',')[1],
          }));
        },
        'data:image/png;base64,' + avatarFixture().toString('base64'),
      );
      for (const picture of encodedPictures) {
        await appearance.getByLabel('Choose assistant picture', { exact: true }).setInputFiles({
          name: 'picture.' + picture.type.split('/')[1],
          mimeType: picture.type,
          buffer: Buffer.from(picture.data, 'base64'),
        });
        await expect(appearance.locator('.appearance-preview img')).toBeVisible();
        expect(
          (await appearance.locator('.appearance-preview img').getAttribute('src')).startsWith(
            'data:image/png;base64,',
          ),
        ).toBe(true);
      }
      await appearance
        .getByLabel('Choose assistant picture', { exact: true })
        .setInputFiles({ name: 'companion.png', mimeType: 'image/png', buffer: avatarFixture() });
      await expect(appearance.locator('.appearance-preview img')).toBeVisible();
      await appearance.getByText('Adjust picture', { exact: true }).click();
      const original = await appearance.locator('.appearance-preview img').getAttribute('src');
      await appearance.getByLabel('Picture zoom', { exact: true }).fill('1.5');
      await appearance.getByLabel('Picture horizontal position', { exact: true }).fill('0.3');
      const cropped = await appearance.locator('.appearance-preview img').getAttribute('src');
      expect(cropped).not.toBe(original);
      await appearance.getByLabel('Choose assistant picture', { exact: true }).setInputFiles({
        name: 'unsafe.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg onload="alert(1)"/>'),
      });
      await expect(appearance.getByRole('alert')).toContainText('PNG, JPEG or WebP');
      await appearance.getByLabel('Choose assistant picture', { exact: true }).setInputFiles({
        name: 'disguised.png',
        mimeType: 'image/png',
        buffer: Buffer.from('<svg onload="alert(1)"/>'),
      });
      await expect(appearance.getByRole('alert')).toContainText('not a PNG');
      expect(await appearance.locator('.appearance-preview img').getAttribute('src')).toBe(cropped);
      await page.reload();
      await expect(appearance.locator('.appearance-preview img')).toHaveAttribute('src', cropped);
      await editor.getByRole('button', { name: 'Create & chat', exact: true }).click();
      await expect(page.getByLabel('Message Mochi', { exact: true })).toBeVisible();
      const mochi = f.store.read().assistants[0];
      expect(mochi.appearance.data).toBe(cropped);
      expect(
        Buffer.from(cropped.split(',')[1], 'base64').includes(
          Buffer.from('private camera metadata'),
        ),
      ).toBe(false);
      expect((await page.locator('.companion-character img').getAttribute('src')) === cropped).toBe(
        true,
      );
      expect(
        (await page.locator('.chat-intro .assistant-avatar img').getAttribute('src')) === cropped,
      ).toBe(true);
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Chat with Mochi', exact: true }).locator('img'),
      ).toHaveAttribute('src', cropped);
      await page
        .locator('#chat-sidebar')
        .getByRole('button', { name: 'Hide chats', exact: true })
        .click();
      await page.getByLabel('Message Mochi', { exact: true }).fill('A different draft');
      await page.reload();
      await expect(page.getByLabel('Message Mochi', { exact: true })).toHaveValue(
        'A different draft',
      );
      await page.getByLabel('Message Mochi', { exact: true }).fill('Hello');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page
          .locator('.messages')
          .getByText('Mochi: Ready for our own conversation.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(JSON.stringify(f.requests)).not.toContain('data:image/png');
      await page.goto(f.url + '/#assistants');
      await page.getByRole('button', { name: 'Share Mochi', exact: true }).click();
      const share = page.getByRole('region', { name: 'Share assistant template', exact: true });
      await expect(
        share.getByText('This picture will be included in the template.', { exact: true }),
      ).toBeVisible();
      await share.getByRole('button', { name: 'Review template', exact: true }).click();
      await expect(share.locator('.template-review-identity img')).toHaveAttribute('src', cropped);
      await share.getByRole('button', { name: 'Create public link', exact: true }).click();
      const link = await share
        .getByRole('link', { name: 'View template details', exact: true })
        .getAttribute('href');
      publicPage = await context.newPage();
      await publicPage.goto(link);
      await expect(publicPage.locator('.badge img')).toBeVisible();
      expect(
        await publicPage
          .locator('.badge img')
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      ).toBe(true);
      const t = prepareTemplate(f.store.read(), mochi.id).template;
      t.profile.name = 'Mochi guest';
      await publicPage.goto(f.url + '/#assistants');
      await publicPage.getByRole('button', { name: 'Import template', exact: true }).click();
      const importer = publicPage.getByRole('region', {
        name: 'Import assistant template',
        exact: true,
      });
      await importer.locator('input[type=file]').setInputFiles({
        name: 'mochi.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(t)),
      });
      await importer.getByRole('button', { name: 'Review template', exact: true }).click();
      await importer.getByRole('button', { name: 'Add assistant', exact: true }).click();
      await expect(publicPage.getByLabel('Message Mochi guest', { exact: true })).toBeVisible();
      expect(
        (await publicPage.locator('.companion-character img').getAttribute('src')) === cropped,
      ).toBe(true);
      const manager = new AssistantTemplates(f.store);
      const template = prepareTemplate(f.store.read(), 'relay').template;
      const shapeLink = manager.save({
        assistantId: 'relay',
        template,
        access: 'public',
        reviewedDigest: templateReview(template, 'public').digest,
      });
      await publicPage.goto(f.url + '/share/assistant/' + shapeLink.token);
      await expect(publicPage.locator('.badge svg')).toBeVisible();
      await share.getByRole('button', { name: 'All assistants', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Mochi', exact: true }).click();
      // A second device edits the profile; this draft must not overwrite it.
      f.store.mutate((s) =>
        command(s, 'assistant.update', {
          ...assistantProfile(s, mochi.id),
          appearance: { kind: 'shape', shape: 'star' },
        }),
      );
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'changed in another window' }),
      ).toBeVisible();
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Mochi', exact: true }).click();
      await expect(
        appearance.getByRole('button', { name: 'Star character', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.goto(f.url + '/#settings?section=personal');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
      await page.goto(f.url + '/#assistants');
      await page.getByRole('button', { name: 'Open assistant details', exact: true }).click();
      await page.getByRole('button', { name: 'Personalize', exact: true }).click();
      await expect(editor.getByRole('heading', { name: 'Edit Mochi', exact: true })).toBeVisible();
      await page.screenshot({ path: join(evidence, `appearance-dark-${label}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode(native).analyze()).violations).toEqual(
        [],
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (!native) {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(appearance.locator('.appearance-preview .character-eyes')).toHaveCSS(
          'animation-name',
          'look-blink',
        );
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(appearance.locator('.appearance-preview .character-eyes')).toHaveCSS(
          'animation-name',
          'none',
        );
      }
      expect(errors).toEqual([]);
      checks.push({
        surface: label,
        passed: true,
        checks: [
          'direct personalization and persisted draft',
          'original shapes and picture crop',
          'JPEG/WebP/PNG normalize; unsupported upload preserves picture',
          'Main and specialist appearances persist',
          'header/sidebar/chat-intro identity matches',
          'picture absent from model request',
          'template preview and imported picture',
          'stale profile rejection',
          'light/dark accessibility and viewport fit',
          ...(native ? [] : ['reduced motion browser check']),
        ],
        nativeFilePickerVerified: false,
      });
      console.log(
        `PASS ${label}: appearance, crop, drafts, scopes, templates, stale writes and accessibility`,
      );
    } catch (e) {
      if (page) await page.screenshot({ path: join(evidence, `appearance-failure-${label}.png`) });
      throw e;
    } finally {
      if (app) await app.close();
      await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `appearance-${native ? 'native' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Isolated real Relay server with synthetic model and generated test PNG; no external provider or user pictures.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
