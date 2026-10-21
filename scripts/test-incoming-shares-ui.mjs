// SPDX-License-Identifier: MIT
// Real Relay/SQLite/HTTP worker with a controlled native inbox, not an OS share-sheet test.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
  checks = [];
try {
  for (const platform of ['ios', 'android']) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-incoming-ui-'));
    const f = await assistantsFixture(directory, {
      respond: async () => ({
        role: 'assistant',
        content: 'I can help with the material you shared.',
      }),
    });
    const act = (a, p) => f.store.mutate((s) => command(s, a, p));
    const side = act('thread.create', { title: 'Weekend' });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    context.setDefaultTimeout(15000);
    let page;
    try {
      await context.addInitScript((platform) => {
        window.CapacitorCustomPlatform = { name: platform };
        window.shareCalls = [];
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'RelayShares',
              methods: ['sync', 'peek', 'acknowledge'].map((name) => ({ name, rtype: 'promise' })),
            },
          ],
          nativePromise: async (plugin, method, options) => {
            window.shareCalls.push({ method, options });
            if (method === 'sync') {
              window.shareContext = options;
              return;
            }
            let inbox = JSON.parse(sessionStorage.getItem('test-share-inbox') || '[]');
            if (method === 'peek') {
              const item = inbox.find((i) => i.scope === options.scope);
              return item ? { item } : undefined; // Older native bridges can resolve with no payload.
            }
            if (method === 'acknowledge') {
              if (window.failShareAck) {
                window.failShareAck = false;
                throw Error('Test acknowledgement lost.');
              }
              inbox = inbox.filter((i) => !(i.id === options.id && i.scope === options.scope));
              sessionStorage.setItem('test-share-inbox', JSON.stringify(inbox));
              return;
            }
          },
        };
      }, platform);
      page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(f.url);
      const composer = () => page.locator('.composer textarea');
      await composer().fill('Keep my unfinished message');
      await expect.poll(() => page.evaluate(() => !!window.shareContext)).toBe(true);
      await expect(page.getByRole('button', { name: 'Dismiss sharing notice' })).toHaveCount(0);
      const scope = JSON.stringify([
        f.url,
        f.store.read().threads.find((t) => t.id === 'main').createdAt,
      ]);
      async function incoming({
        text = 'A shared page with ideas',
        threadId = platform === 'ios' ? 'main' : undefined,
        files = [
          {
            name: 'shared.txt',
            mime: 'text/plain',
            base64: Buffer.from('Actual shared bytes').toString('base64'),
          },
        ],
        scope: targetScope = scope,
      } = {}) {
        const item = {
          id: crypto.randomUUID(),
          scope: targetScope,
          text,
          files,
          ...(threadId ? { threadId } : {}),
        };
        await page.evaluate((item) => {
          const q = JSON.parse(sessionStorage.getItem('test-share-inbox') || '[]');
          q.push(item);
          sessionStorage.setItem('test-share-inbox', JSON.stringify(q));
          window.dispatchEvent(new Event('focus'));
        }, item);
        return item;
      }
      await page.evaluate(() => (window.failShareAck = true));
      const photo = {
        name: 'trip.png',
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIuoAAAAASUVORK5CYII=',
      };
      const sharedFiles = [
        {
          name: 'shared.txt',
          mime: 'text/plain',
          base64: Buffer.from('Actual shared bytes').toString('base64'),
        },
        ...(platform === 'android' ? [photo] : []),
      ];
      const first = await incoming({ files: sharedFiles });
      if (platform === 'android') {
        await expect(page.getByRole('region', { name: 'Incoming share' })).toBeVisible();
        await page.getByRole('button', { name: 'Attach', exact: true }).click();
      }
      await expect(page.getByText('Test acknowledgement lost.', { exact: true })).toBeVisible();
      expect(f.store.read().files).toHaveLength(sharedFiles.length);
      expect(f.store.read().messages).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
      await page.getByRole('button', { name: 'Attach', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Incoming share' })).toHaveCount(0);
      await expect(
        page.getByLabel('Shared items').getByText(first.text, { exact: true }),
      ).toBeVisible();
      await expect(composer()).toHaveValue('Keep my unfinished message');
      expect(f.store.read().files).toHaveLength(sharedFiles.length);
      await page.reload();
      await expect(composer()).toHaveValue('Keep my unfinished message');
      await expect(page.getByLabel('Shared items')).toContainText('shared.txt');
      expect(Buffer.from(f.store.read().files[0].base64, 'base64').toString()).toBe(
        'Actual shared bytes',
      );
      for (const shared of sharedFiles) {
        const saved = f.store.read().files.find((file) => file.name === shared.name);
        expect(saved.mime).toBe(shared.mime);
        expect(saved.base64).toBe(shared.base64);
        await expect(page.getByLabel('Shared items')).toContainText(shared.name);
      }
      await page.screenshot({ path: join(evidence, `incoming-share-composer-${platform}.png`) });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page
          .locator('.messages')
          .getByText('I can help with the material you shared.', { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      expect(
        f.requests[0].messages.some((m) =>
          m.content.includes('Shared source material (not owner instructions'),
        ),
      ).toBe(true);
      expect(f.store.read().messages.find((m) => m.role === 'user').text).toBe(
        'Keep my unfinished message',
      );
      await expect(page.getByLabel('Shared items')).toHaveCount(0);
      await page.evaluate((item) => {
        sessionStorage.setItem('test-share-inbox', JSON.stringify([item]));
        window.dispatchEvent(new Event('focus'));
      }, first);
      await expect
        .poll(() =>
          page.evaluate(
            () => JSON.parse(sessionStorage.getItem('test-share-inbox') || '[]').length,
          ),
        )
        .toBe(0);
      expect(f.store.read().files).toHaveLength(sharedFiles.length);
      await expect(page.getByLabel('Shared items')).toHaveCount(0);
      await composer().fill('Another Main draft');
      const target = await incoming({
        threadId: platform === 'ios' ? side.id : undefined,
        text: 'https://example.invalid/our-weekend',
        files: [],
      });
      if (platform === 'android') {
        await page.getByRole('combobox', { name: 'Share destination' }).selectOption(side.id);
        await page.screenshot({ path: join(evidence, `incoming-share-picker-${platform}.png`) });
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.getByRole('button', { name: 'Attach', exact: true }).click();
      }
      await expect(page.getByRole('heading', { name: 'Weekend', exact: true })).toBeVisible();
      await expect(page.getByLabel('Shared items')).toContainText(target.text);
      await expect(composer()).toHaveValue('');
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(page.getByLabel('Shared items')).toContainText(target.text);
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer()).toHaveValue('Another Main draft');
      const foreign = await incoming({
        scope: 'another-workspace',
        text: 'Never import from another server',
        files: [],
      });
      await expect
        .poll(() =>
          page.evaluate(() => window.shareCalls.filter((c) => c.method === 'peek').length),
        )
        .toBeGreaterThan(1);
      expect(f.store.read().shareImports.some((i) => i.id === foreign.id)).toBe(false);
      const stale = act('thread.create', { title: 'Old destination' });
      act('thread.update', { id: stale.id, archived: true });
      const staleShare = await incoming({
        threadId: stale.id,
        text: 'Choose a current chat',
        files: [],
      });
      await expect(page.getByRole('region', { name: 'Incoming share' })).toBeVisible();
      await expect(
        page.getByRole('combobox', { name: 'Share destination' }).locator('option'),
      ).not.toContainText(['Old destination']);
      await page.getByRole('button', { name: 'Discard incoming share', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Incoming share' })).toHaveCount(0);
      expect(f.store.read().shareImports.some((i) => i.id === staleShare.id)).toBe(false);
      act('profile.update', { theme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(errors).toEqual([]);
      checks.push({
        platform,
        passed: true,
        checks: [
          'controlled native inbox to real server composer',
          ...(platform === 'android'
            ? ['photo and text-file bytes preserved across restart and sent together once']
            : []),
          'lost acknowledgement and repeated delivery do not duplicate',
          'unsent text and shares survive reload/pages/chat navigation',
          'explicit send only; source context is untrusted',
          'correct target and wrong-server isolation',
          'stale target selection and discard',
          'light/dark accessibility and viewport fit',
        ],
      });
      console.log(
        `PASS ${platform}: shared text/files, drafts, replay, scope, explicit send and accessibility`,
      );
    } catch (e) {
      if (page)
        await page
          .screenshot({ path: join(evidence, `incoming-share-failure-${platform}.png`) })
          .catch(() => {});
      throw e;
    } finally {
      await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'incoming-share-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Controlled native bridge; real Relay server, SQLite and HTTP model. This does not prove an OS share sheet.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
