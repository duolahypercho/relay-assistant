// SPDX-License-Identifier: MIT
// Real Relay/SQLite/model HTTP and Docker; file drag/paste events are supplied by the test.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { PrivateComputer } from '../server/computer.mjs';

const mac = process.argv.includes('--mac');
const browser = mac ? null : await chromium.launch({ channel: 'chrome', headless: true });
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const checks = [];
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
async function dataTransfer(page, files) {
  return page.evaluateHandle((files) => {
    const data = new DataTransfer();
    for (const f of files) {
      const bytes = f.size
        ? new Uint8Array(f.size)
        : f.base64
          ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
          : f.text || 'A fictional test file.';
      data.items.add(new File([bytes], f.name, { type: f.type || 'text/plain' }));
    }
    return data;
  }, files);
}
async function drop(page, target, files, screenshot) {
  const data = await dataTransfer(page, files);
  try {
    await target.dispatchEvent('dragenter', { dataTransfer: data });
    await target.dispatchEvent('dragover', { dataTransfer: data });
    if (screenshot)
      await page.screenshot({ path: join(evidence, screenshot), animations: 'disabled' });
    await target.dispatchEvent('drop', { dataTransfer: data });
  } finally {
    await data.dispose();
  }
}
try {
  for (const mobile of mac ? [false] : [false, true]) {
    const surface = mac ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const directory = await mkdtemp(join(tmpdir(), 'relay-file-intake-'));
    let computer, app, context, page, releaseLate;
    const f = await assistantsFixture(directory, {
      respond: async () => ({ role: 'assistant', content: 'I received your attached files.' }),
      configure: (store, services) => {
        computer = new PrivateComputer(store, { enabled: true, deployment: directory });
        services.computer = computer;
      },
    });
    const check = (label) => {
      checks.push({ surface, label });
      console.log(`PASS ${surface}: ${label}`);
    };
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
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const composer = page.getByRole('textbox', { name: 'Message Relay', exact: true });
      const chat = page.locator('.chat-workspace');
      const attachments = page.locator('.composer .attachment-list');
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      await composer.fill('Keep this unfinished message.');
      const folder = await dataTransfer(page, [{ name: 'a-folder' }]);
      await chat.evaluate((element, data) => {
        const original = DataTransferItem.prototype.webkitGetAsEntry;
        try {
          DataTransferItem.prototype.webkitGetAsEntry = () => ({ isDirectory: true });
          element.dispatchEvent(
            new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
          );
        } finally {
          DataTransferItem.prototype.webkitGetAsEntry = original;
        }
      }, folder);
      await folder.dispose();
      await expect(page.getByRole('alert')).toContainText('Choose individual files');
      const stray = await dataTransfer(page, [{ name: 'outside.txt' }]);
      expect(
        await page.locator('.topbar').evaluate((element, data) => {
          const event = new DragEvent('drop', {
            dataTransfer: data,
            bubbles: true,
            cancelable: true,
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }, stray),
      ).toBe(true);
      await stray.dispose();
      expect(f.store.read().files).toHaveLength(0);
      await expect(composer).toHaveValue('Keep this unfinished message.');
      check(
        'folder drops are explained, and file drops outside a target cannot navigate away or upload',
      );
      await drop(
        page,
        chat,
        [
          { name: 'notes.txt', text: 'Original notes.' },
          { name: 'picture.png', base64: png, type: 'image/png' },
        ],
        `file-drop-chat-${surface}.png`,
      );
      await expect(attachments).toContainText('picture.png');
      await expect(composer).toHaveValue('Keep this unfinished message.');
      const pasted = await dataTransfer(page, [
        { name: 'pasted.png', base64: png, type: 'image/png' },
      ]);
      await composer.evaluate(
        (element, data) =>
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          ),
        pasted,
      );
      await pasted.dispose();
      await expect(attachments).toContainText('pasted.png');
      expect(f.store.read().files.find((file) => file.name === 'pasted.png').base64).toBe(png);
      expect(
        await composer.evaluate((el) => {
          const clipboard = new DataTransfer();
          clipboard.setData('text/plain', 'ordinary pasted words');
          const e = new ClipboardEvent('paste', {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        }),
      ).toBe(false);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      check(
        'dropped files and pasted image retain exact bytes and draft; plain text paste stays native; nothing sends automatically',
      );

      const late = new Promise((resolve) => {
        releaseLate = resolve;
      });
      let intercepted = false;
      await page.route('**/api/command', async (route) => {
        const body = route.request().postDataJSON();
        if (body.action === 'file.add' && body.payload.name === 'late.txt') {
          intercepted = true;
          await late;
        }
        await route.continue();
      });
      await drop(page, chat, [{ name: 'late.txt', text: 'This arrived after changing chats.' }]);
      await expect.poll(() => intercepted).toBe(true);
      await page.getByRole('button', { name: 'Show chats', exact: true }).click();
      await page.getByRole('button', { name: 'New side chat', exact: true }).click();
      await expect(composer).toHaveValue('');
      const sideId = f.store.read().threads.find((t) => t.id !== 'main').id;
      await composer.fill('Separate side draft.');
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer).toHaveValue('Keep this unfinished message.');
      releaseLate();
      await expect(attachments).toContainText('late.txt');
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === 'main').draftFileIds.length)
        .toBe(4);
      expect(f.store.read().threads.find((t) => t.id === sideId).draftFileIds || []).toEqual([]);
      await page.unroute('**/api/command');
      await page.reload();
      await expect(attachments).toContainText('late.txt');
      await expect(composer).toHaveValue('Keep this unfinished message.');
      check(
        'upload finishing after switching away and back attaches only to its original chat and survives reload',
      );

      await drop(page, chat, [{ name: 'too-large.bin', size: 8 * 1024 * 1024 + 1 }]);
      await expect(page.getByRole('alert')).toContainText('too-large.bin is too large');
      await drop(
        page,
        chat,
        Array.from({ length: 5 }, (_, n) => ({ name: `excess-${n}.txt` })),
      );
      await expect(page.getByRole('alert')).toContainText('4 more files');
      expect(f.store.read().files).toHaveLength(4);
      await drop(
        page,
        chat,
        Array.from({ length: 4 }, (_, n) => ({ name: `extra-${n}.txt` })),
      );
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === 'main').draftFileIds.length)
        .toBe(8);
      await drop(page, chat, [{ name: 'ninth.txt' }]);
      await expect(page.getByRole('alert')).toContainText('Remove an attachment');
      expect(f.store.read().files).toHaveLength(8);
      expect(f.requests).toHaveLength(0);
      expect(f.store.read().messages).toHaveLength(0);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText('I received your attached files.', { exact: true }),
      ).toBeVisible();
      expect(f.requests).toHaveLength(1);
      expect(f.store.read().messages).toHaveLength(2);
      expect(f.store.read().messages.find((m) => m.role === 'user').fileIds).toHaveLength(8);
      await expect(attachments).toHaveCount(0);
      check(
        'count/size preflight saves no rejected files; explicit Send sends all eight attachments once',
      );

      let failedRequests = 0;
      await page.route('**/api/command', async (route) => {
        const body = route.request().postDataJSON();
        if (body.action === 'file.add' && body.payload.name === 'failed.txt') {
          failedRequests++;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Could not add failed.txt. Try again.' }),
          });
        }
        await route.continue();
      });
      await drop(page, chat, [
        { name: 'kept.txt' },
        { name: 'failed.txt' },
        { name: 'not-started.txt' },
      ]);
      await expect(page.getByRole('alert')).toContainText('Could not add failed.txt');
      await expect(attachments).toContainText('kept.txt');
      expect(
        f.store.read().files.some((file) => ['failed.txt', 'not-started.txt'].includes(file.name)),
      ).toBe(false);
      await page.reload();
      await expect(attachments).toContainText('kept.txt');
      expect(failedRequests).toBe(1);
      await page.unroute('**/api/command');
      check(
        'partial upload failure keeps successful attachments, stops later files, and never silently retries',
      );

      await composer.fill('Still working on this.');
      await dock.getByRole('button', { name: 'Files', exact: true }).click();
      await drop(page, page.locator('.workspace-page .file-drop-target'), [
        { name: 'library.txt', text: 'Saved without a message.' },
      ]);
      await expect
        .poll(() => f.store.read().files.some((file) => file.name === 'library.txt'))
        .toBe(true);
      await drop(page, page.locator('.workspace-page .file-drop-target'), [
        { name: 'large-text.txt', size: 7_500_000 },
      ]);
      await expect
        .poll(
          () => f.store.read().files.find((file) => file.name === 'large-text.txt')?.base64.length,
        )
        .toBe(10_000_000);
      expect(f.store.read().files.find((file) => file.name === 'large-text.txt').text.length).toBe(
        2_000_000,
      );
      expect(f.requests).toHaveLength(1);
      expect(f.store.read().messages).toHaveLength(2);
      await dock.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Computer', exact: true }).click();
      await page.getByRole('button', { name: 'Start computer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
        timeout: 45000,
      });
      const computerArea = page.locator('.computer-window');
      await drop(page, computerArea, [{ name: 'not-permitted.txt' }]);
      expect(
        (await computer.list()).entries.some((file) => file.name === 'not-permitted.txt'),
      ).toBe(false);
      expect(computer.controller).toBe('agent');
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Add files from your device', exact: true }),
      ).toBeEnabled();
      await computer.perform(
        {
          kind: 'files',
          action: 'write',
          path: 'report.txt',
          base64: Buffer.from('Keep the existing file.').toString('base64'),
          operationId: 'original-file',
        },
        { actor: 'owner' },
      );
      await drop(
        page,
        computerArea,
        [
          { name: 'report.txt', text: 'Dropped onto the real computer.' },
          { name: 'report.txt', text: 'Second file with the same name.' },
        ],
        `file-drop-computer-${surface}.png`,
      );
      const pane = page.getByRole('region', { name: 'Computer files' });
      await expect(pane.getByText('report (3).txt', { exact: true })).toBeVisible();
      expect(Buffer.from((await computer.read('report.txt')).base64, 'base64').toString()).toBe(
        'Keep the existing file.',
      );
      expect(Buffer.from((await computer.read('report (2).txt')).base64, 'base64').toString()).toBe(
        'Dropped onto the real computer.',
      );
      expect(Buffer.from((await computer.read('report (3).txt')).base64, 'base64').toString()).toBe(
        'Second file with the same name.',
      );
      check(
        'computer drop requires owner control and writes exact bytes to Docker while keeping both same-name files and the original',
      );

      await page.locator('.computer-upload input[type=file]').setInputFiles({
        name: 'from-picker.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Picker path uses the same transfer.'),
      });
      await expect(pane.getByText('from-picker.txt', { exact: true })).toBeVisible();
      expect(
        Buffer.from((await computer.read('from-picker.txt')).base64, 'base64').toString(),
      ).toBe('Picker path uses the same transfer.');
      await pane
        .locator('.computer-file-row')
        .filter({ hasText: 'report (2).txt' })
        .getByRole('button', { name: 'Save to Relay' })
        .click();
      await expect
        .poll(() => f.store.read().files.some((file) => file.name === 'report (2).txt'))
        .toBe(true);
      await page.screenshot({
        path: join(evidence, `file-handoff-computer-${surface}.png`),
        animations: 'disabled',
      });
      expect((await new AxeBuilder({ page }).setLegacyMode(mac).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer).toHaveValue('Still working on this.');
      expect(f.store.read().messages).toHaveLength(2);
      expect(f.requests).toHaveLength(1);
      expect(errors).toEqual([]);
      check(
        'picker transfer, return-to-Relay bytes, accessibility, viewport and unchanged conversation all pass',
      );
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `file-handoff-failure-${surface}.png`) })
        .catch(() => {});
      throw error;
    } finally {
      releaseLate?.();
      await app?.close();
      if (!app) await context?.close();
      await computer?.stop().catch(() => {});
      if (computer) {
        await computer.dockerRun(['rm', '-f', computer.name]).catch(() => {});
        await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
        await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
      }
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(
      evidence,
      mac ? 'file-intake-native-mac-acceptance.json' : 'file-intake-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Production UI, real SQLite/HTTP provider and Docker; DOM file/paste events and renderer file input, not OS Finder/clipboard/picker certification. Phone is browser-sized, not a physical device.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
