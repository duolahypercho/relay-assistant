import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askFileFixture } from './ask-file-fixture.mjs';
import { saveArtifact } from '../server/artifacts.mjs';

const mac = process.argv.includes('--mac');
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-ask-file-'));
    const f = await askFileFixture(directory);
    let app, context, page, releaseUpload;
    try {
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
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
        });
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      const attachments = page.getByRole('group', { name: 'Draft attachments', exact: true });
      async function preview(name) {
        await dock.getByRole('button', { name: 'Files', exact: true }).click();
        await page
          .locator('.file-tile')
          .filter({ has: page.getByText(name, { exact: true }) })
          .click();
        await expect(page.getByRole('region', { name: 'File preview', exact: true })).toBeVisible();
      }
      async function ask(name) {
        await preview(name);
        await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
        await expect(page.getByRole('region', { name: 'File preview', exact: true })).toHaveCount(
          0,
        );
        await expect(composer).toBeFocused();
      }
      await composer.fill('Keep my main draft.');
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      const side = f.store.read().threads.find((t) => t.id !== 'main');
      await composer.fill('Tell me about my saved plan.');
      // Merge with an unsaved local attachment rather than replacing its debounced copy.
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Draft note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Keep this draft attachment.'),
      });
      await expect(attachments).toContainText('Draft note.txt');
      await preview('Weekend plans.txt');
      await page.screenshot({
        path: join(evidence, `ask-file-preview-${surface}.png`),
        animations: 'disabled',
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue('Tell me about my saved plan.');
      await expect(attachments.locator('.attachment-item')).toHaveCount(2);
      await ask('Weekend plans.txt');
      await expect(attachments.locator('.attachment-item')).toHaveCount(2);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.store.read().files).toHaveLength(10);
      await page.reload();
      await expect(attachments.locator('.attachment-item')).toHaveCount(2);
      await expect(composer).toHaveValue('Tell me about my saved plan.');
      await page.screenshot({
        path: join(evidence, `ask-file-draft-${surface}.png`),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep my main draft.');
      await expect(attachments).toHaveCount(0);
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page
        .locator('#chat-sidebar')
        .getByRole('button', { name: side.title, exact: true })
        .and(page.locator('.thread-link:not(.new-side-chat)'))
        .click();
      await expect(attachments.locator('.attachment-item')).toHaveCount(2);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page
          .locator('.chat-workspace')
          .getByText('Your saved plan says to meet at noon and bring a book.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const sent = f.store.read().messages.find((m) => m.role === 'user');
      expect(sent.threadId).toBe(side.id);
      expect(sent.fileIds).toHaveLength(2);
      expect(sent.fileIds).toContain(f.files[0].id);
      expect(f.reads).toHaveLength(1);
      expect(f.errors).toEqual([]);
      expect(f.store.read().messages).toHaveLength(2);
      // Saved text is used; unsaved edits do not expose a misleading shortcut.
      await preview('Weekend plans.txt');
      await page.getByRole('button', { name: 'Edit text', exact: true }).click();
      await page.getByRole('textbox', { name: 'File text', exact: true }).fill('Unsaved change');
      await expect(page.getByRole('button', { name: 'Ask about this', exact: true })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Ask about this', exact: true })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await ask('Weekend plans.txt');
      for (let i = 1; i <= 7; i++) await ask(`Saved note ${i}.txt`);
      await expect(attachments.locator('.attachment-item')).toHaveCount(8);
      await preview('Saved note 8.txt');
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Your draft already has 8 files');
      expect(f.store.read().messages).toHaveLength(2);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(attachments.locator('.attachment-item')).toHaveCount(8);
      for (let i = 0; i < 8; i++)
        await attachments
          .getByRole('button', { name: 'Remove attachment', exact: true })
          .first()
          .click();
      // A pending upload reserves its opportunity to finish; asking cannot overfill it.
      let reached;
      const waiting = new Promise((r) => (reached = r));
      const blocked = new Promise((r) => (releaseUpload = r));
      await page.route('**/api/command', async (route) => {
        if (route.request().postDataJSON()?.action === 'file.add') {
          reached();
          await blocked;
        }
        await route.continue();
      });
      await page.locator('.composer input[type=file]').setInputFiles({
        name: 'Still uploading.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Pending upload.'),
      });
      await waiting;
      await preview('Saved note 8.txt');
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('still uploading');
      releaseUpload();
      await expect
        .poll(() => f.store.read().files.some((file) => file.name === 'Still uploading.txt'))
        .toBe(true);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(attachments).toContainText('Still uploading.txt');
      await ask('Saved note 8.txt');
      await expect(attachments.locator('.attachment-item')).toHaveCount(2);
      const result = await saveArtifact(f.store, {
        kind: 'document',
        title: 'Weekend result',
        source: '# Original version',
        operationId: 'ask-file-v1',
      });
      const latest = await saveArtifact(f.store, {
        id: result.id,
        kind: 'document',
        title: 'Weekend result',
        source: '# New version',
        expectedVersion: 1,
        operationId: 'ask-file-v2',
      });
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await page.locator('.file-tile').filter({ hasText: 'Weekend result' }).click();
      await page.getByRole('combobox', { name: 'Result version', exact: true }).selectOption('1');
      await expect(page.getByText('Original version', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
      await expect(composer).toBeFocused();
      await expect(attachments.locator('.attachment-item')).toHaveCount(3);
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === side.id).draftFileIds)
        .toContain(result.fileId);
      expect(f.store.read().threads.find((t) => t.id === side.id).draftFileIds).not.toContain(
        latest.fileId,
      );
      expect(f.store.read().messages).toHaveLength(2);
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        surface,
        passed: true,
        checks: [
          'existing file reused without upload or send',
          'main and side drafts stay separate',
          'local draft merge, duplicate prevention and reload recovery',
          'explicit send and actual agent read_file through HTTP',
          'unsaved edits and full drafts handled without loss',
          'pending upload kept intact',
          'accessibility and viewport fit',
        ],
      });
      console.log(`PASS ${surface}: saved file to draft and actual assistant read`);
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `ask-file-failure-${surface}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      releaseUpload?.();
      if (app) await app.close();
      else await context?.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, `ask-file-${mac ? 'native-mac' : 'ui'}-acceptance.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Isolated real Relay/SQLite/worker, controlled HTTP model; no live-account quality claim.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
