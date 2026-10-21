// SPDX-License-Identifier: MIT
// Local HTTP model and real server; authored test images never enter the owner's workspace.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
import { avatarFixture } from '../tests/fixtures/avatar.mjs';

const mac = process.argv.includes('--mac');
const tablet = process.argv.includes('--tablet');
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const checks = [];
const first = await readFile('src/assets/relay-sprout.png');
const second = avatarFixture({ width: 120, height: 220, metadata: false });
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac
      ? 'native-mac'
      : tablet
        ? mobile
          ? 'tablet-portrait'
          : 'tablet-landscape'
        : mobile
          ? 'phone'
          : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-photo-chat-'));
    let context, app;
    const f = await assistantsFixture(directory, {
      respond: async (body) => {
        if (body.messages.some((m) => m.role === 'tool'))
          return { role: 'assistant', content: 'I can see the illustration you attached.' };
        const id = f.store.read().files.find((file) => file.name === 'Sprout.png').id;
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'read-picture',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ id }) },
            },
          ],
        };
      },
    });
    const check = (label) => {
      checks.push({ surface, label });
      console.log(`PASS ${surface}: ${label}`);
    };
    try {
      let page;
      if (mac) {
        const desktopData = join(directory, 'desktop');
        await mkdir(desktopData);
        await writeFile(join(desktopData, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${desktopData}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else {
        context = await browser.newContext({
          viewport: tablet
            ? mobile
              ? { width: 820, height: 1180 }
              : { width: 1180, height: 820 }
            : mobile
              ? { width: 390, height: 844 }
              : { width: 1365, height: 950 },
          isMobile: tablet || mobile,
          hasTouch: tablet || mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const draft = page.locator('.composer .draft-attachments').last();
      const input = page.locator('.composer input[type=file]');
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      await composer.fill('What do you think of these pictures?');
      await input.setInputFiles([
        { name: 'Sprout.png', mimeType: 'image/png', buffer: first },
        { name: 'Portrait.png', mimeType: 'image/png', buffer: second },
        {
          name: 'Notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Please keep the original image.'),
        },
      ]);
      await expect(draft.locator('img')).toHaveCount(2);
      await expect
        .poll(() =>
          draft
            .locator('img')
            .evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0)),
        )
        .toBe(true);
      await expect(
        draft.getByRole('button', { name: 'Open Notes.txt', exact: true }),
      ).toBeVisible();
      expect(f.requests.length).toBe(0);
      expect(f.store.read().messages.length).toBe(0);
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === 'main').draftFileIds?.length)
        .toBe(3);
      await page.screenshot({ path: join(evidence, `photo-draft-${surface}.png`) });
      const open = draft.getByRole('button', { name: 'Open Sprout.png', exact: true });
      await open.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('region', { name: 'File preview', exact: true });
      await expect(dialog.getByRole('img', { name: 'Sprout.png', exact: true })).toBeVisible();
      await expect
        .poll(() => dialog.locator('img').evaluate((img) => img.naturalWidth > 0))
        .toBe(true);
      if (mac) {
        const savedPath = join(directory, 'downloaded-image.png');
        await app.evaluate(({ app, BrowserWindow }, path) => {
          app.photoDownload = '';
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => {
              item.setSavePath(path);
              item.once('done', (_e, state) => {
                app.photoDownload = state;
              });
            },
          );
        }, savedPath);
        await dialog.getByRole('link', { name: 'Download', exact: true }).click();
        await expect.poll(() => app.evaluate(({ app }) => app.photoDownload)).toBe('completed');
        expect((await readFile(savedPath)).equals(first)).toBe(true);
      } else {
        const downloadEvent = page.waitForEvent('download');
        await dialog.getByRole('link', { name: 'Download', exact: true }).click();
        const download = await downloadEvent;
        expect((await readFile(await download.path())).equals(first)).toBe(true);
      }
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(open).toBeFocused();
      await expect(composer).toHaveValue('What do you think of these pictures?');
      check(
        'draft thumbnails decode; keyboard opens and returns focus; original image download and unsent caption remain exact',
      );

      await draft
        .locator('.attachment-item')
        .filter({ has: page.getByRole('button', { name: 'Open Portrait.png', exact: true }) })
        .getByRole('button', { name: 'Remove attachment', exact: true })
        .click();
      await expect(draft.locator('img')).toHaveCount(1);
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === 'main').draftFileIds?.length)
        .toBe(2);
      const oldUrl = await draft.locator('img').getAttribute('src');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await expect(draft).toHaveCount(0);
      expect(
        await page.evaluate(async (url) => {
          try {
            await fetch(url);
            return true;
          } catch {
            return false;
          }
        }, oldUrl),
      ).toBe(false);
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(draft.locator('img')).toHaveCount(1);
      await page.reload();
      await expect(draft.locator('img')).toHaveCount(1);
      await expect(composer).toHaveValue('What do you think of these pictures?');
      expect(f.store.read().files).toHaveLength(3);
      check(
        'removing a draft photo preserves the file; side chats and reload retain the right attachments; image URLs are released on unmount',
      );

      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('I can see the illustration you attached.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const sent = page.locator('.message.user .message-attachments');
      const returned = page.locator('.message.assistant .message-attachments');
      await expect(sent.locator('img')).toHaveCount(1);
      await expect(returned.locator('img')).toHaveCount(1);
      const visionParts = f.requests
        .flatMap((r) => r.messages)
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      expect(
        visionParts.some(
          (part) =>
            part.type === 'image_url' && part.image_url.url.endsWith(first.toString('base64')),
        ),
      ).toBe(true);
      await composer.fill('Keep my next thought.');
      const messageCount = f.store.read().messages.length;
      const requestCount = f.requests.length;
      await returned.getByRole('button', { name: 'Open Sprout.png', exact: true }).click();
      await expect(dialog.getByRole('img', { name: 'Sprout.png', exact: true })).toBeVisible();
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect(composer).toHaveValue('Keep my next thought.');
      expect(f.store.read().messages.length).toBe(messageCount);
      expect(f.requests.length).toBe(requestCount);
      check(
        'sent and assistant-returned images are visible in chat; actual read_file supplies exact image bytes to the HTTP vision request; preview adds no messages',
      );

      const add = (type, payload) => f.store.mutate((s) => command(s, type, payload));
      await input.setInputFiles([
        { name: 'Sprout.png', mimeType: 'image/png', buffer: first },
        { name: 'Portrait.png', mimeType: 'image/png', buffer: second },
        { name: 'Broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') },
        {
          name: 'Untrusted.svg',
          mimeType: 'image/svg+xml',
          buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
        },
      ]);
      const picture = f.store.read().files.find((file) => file.name === 'Sprout.png');
      const portrait = f.store.read().files.find((file) => file.name === 'Portrait.png');
      await expect(draft.getByText('Preview unavailable', { exact: true })).toBeVisible();
      await expect(
        draft.getByRole('button', { name: 'Open Untrusted.svg', exact: true }),
      ).toBeVisible();
      await expect(draft.locator('img')).toHaveCount(2);
      await draft.getByRole('button', { name: 'Open Broken.png', exact: true }).click();
      await expect(
        dialog.getByRole('heading', { name: 'Preview unavailable', exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute(
        'href',
        /^blob:/,
      );
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      expect(
        await page
          .locator('.photo-attachments img')
          .evaluateAll((imgs) => imgs.every((img) => img.src.startsWith('blob:'))),
      ).toBe(true);
      check(
        'broken images fall back clearly; SVG remains a document; thumbnails load only local blob URLs',
      );

      add('share.attach', {
        id: 'photo-share-fixture-1234',
        threadId: 'main',
        text: 'A shared illustration.',
        files: [{ name: 'Shared photo.png', mime: 'image/png', base64: second.toString('base64') }],
      });
      const shared = page.locator('.shared-composer-items');
      await expect(
        shared.getByRole('button', { name: 'Open Shared photo.png', exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => shared.locator('img').evaluate((img) => img.naturalWidth > 0))
        .toBe(true);
      await shared.getByRole('button', { name: 'Open Shared photo.png', exact: true }).click();
      await expect(
        dialog.getByRole('img', { name: 'Shared photo.png', exact: true }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await shared.getByRole('button', { name: 'Remove shared item', exact: true }).click();
      await expect(shared).toHaveCount(0);
      expect(f.store.read().messages.length).toBe(messageCount);
      check(
        'shared photos have the same thumbnail and preview; removing the share preserves the caption and conversation',
      );

      // A persisted two-photo message exercises album layout without another model request.
      f.store.mutate((s) => {
        const user = s.messages.find((m) => m.role === 'user');
        user.fileIds = [picture.id, portrait.id];
      });
      await expect(sent.locator('img')).toHaveCount(2);
      await draft
        .getByRole('button', { name: 'Open Sprout.png', exact: true })
        .scrollIntoViewIfNeeded();
      for (const dark of [false, true]) {
        add('profile.update', { theme: dark ? 'dark' : 'light' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'dark' : 'light');
        const result = await new AxeBuilder({ page }).setLegacyMode(mac).analyze();
        expect(result.violations.map((x) => ({ id: x.id, impact: x.impact }))).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        await page.screenshot({
          path: join(evidence, `photo-chat-${surface}-${dark ? 'dark' : 'light'}.png`),
        });
      }
      expect(errors).toEqual([]);
      check(
        'mixed photos/documents and multi-photo messages fit desktop/phone; light/dark accessibility and no runtime errors pass',
      );
    } finally {
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `photo-chat-${mac ? 'native-mac-' : tablet ? 'tablet-' : ''}acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Real server/SQLite/HTTP model, renderer file input; local fixture images and controlled vision request, not live model semantic judgment or physical-device certification.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
}
