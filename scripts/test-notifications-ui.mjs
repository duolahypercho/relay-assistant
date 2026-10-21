// SPDX-License-Identifier: MIT
// Production server/UI with controlled native notification callbacks. OS delivery is tested separately.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { Notifications } from '../server/notifications.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { command, createApproval } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
const evidence = resolve('../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const platform of ['desktop', 'ios', 'android']) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-notifications-ui-'));
    const f = await assistantsFixture(directory, {
      configure(store, services) {
        services.notifications = new Notifications(store, {
          key: modelVaultKey(directory),
          providers: {
            status: () => ({ desktop: true, ios: true, android: true }),
            send: async () => ({ accepted: true }),
          },
        });
      },
    });
    const act = (a, p) => f.store.mutate((s) => command(s, a, p));
    const side = act('thread.create', { title: 'Our weekend' });
    const context = await browser.newContext({
      viewport: platform === 'desktop' ? { width: 1365, height: 980 } : { width: 390, height: 844 },
      isMobile: platform !== 'desktop',
      hasTouch: platform !== 'desktop',
      reducedMotion: 'reduce',
    });
    context.setDefaultTimeout(15000);
    try {
      await context.addInitScript((platform) => {
        window.testNotificationCalls = [];
        window.testPermission = 'prompt';
        window.testListeners = {};
        window.emitNotice = (value) => {
          if (platform === 'desktop') window.testOpenNotice?.(value);
          else
            Object.values(window.testListeners)
              .filter((x) => x.event === 'pushNotificationActionPerformed')
              .forEach((x) =>
                x.fn({
                  actionId: 'tap',
                  notification: {
                    data: { relayWorkspace: value.workspaceId, relayNotice: value.noticeId },
                  },
                }),
              );
        };
        if (platform === 'desktop') {
          window.relayNative = {
            platform: 'darwin',
            ready() {},
            onCommand() {
              return () => {};
            },
            notifications: {
              status: async () => ({ supported: true }),
              configure: async (p) => {
                window.testNotificationCalls.push({ method: 'configure', p });
              },
              onOpen: (fn) => {
                window.testOpenNotice = fn;
                return () => {
                  window.testOpenNotice = null;
                };
              },
            },
          };
          return;
        }
        window.CapacitorCustomPlatform = { name: platform };
        window.Capacitor = {
          PluginHeaders: [
            {
              name: 'PushNotifications',
              methods: [
                ...[
                  'checkPermissions',
                  'requestPermissions',
                  'register',
                  'createChannel',
                  'removeListener',
                ].map((name) => ({ name, rtype: 'promise' })),
                { name: 'addListener', rtype: 'callback' },
              ],
            },
          ],
          nativeCallback(plugin, method, options, fn) {
            const id = crypto.randomUUID();
            window.testListeners[id] = { event: options.eventName, fn };
            return id;
          },
          async nativePromise(plugin, method, options) {
            window.testNotificationCalls.push({ method, options });
            if (method === 'checkPermissions') return { receive: window.testPermission };
            if (method === 'requestPermissions') {
              window.testPermission = 'granted';
              return { receive: 'granted' };
            }
            if (method === 'removeListener') {
              delete window.testListeners[options.callbackId];
              return;
            }
            if (method === 'register')
              Object.values(window.testListeners)
                .filter((x) => x.event === 'registration')
                .forEach((x) =>
                  x.fn({ value: platform === 'ios' ? 'b'.repeat(64) : 'fictional-fcm-token' }),
                );
          },
        };
      }, platform);
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => {
        errors.push(e.message);
        console.error('UI error:', e.message);
      });
      await page.goto(f.url);
      const composer = () => page.locator('.composer textarea');
      await composer().fill('Keep my quiet weekend draft');
      f.store.mutate((s) =>
        appendAssistant(s, 'main', {
          text: 'Your files are here.',
          cards: [{ kind: 'workspace', page: 'files' }],
        }),
      );
      await page.getByRole('button', { name: 'Open your files', exact: true }).click();
      await expect(composer()).toBeHidden();
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(composer()).toHaveValue('Keep my quiet weekend draft');
      const before = f.store.read().messages.length;
      const dock = page.getByRole('navigation', { name: 'Workspace shortcuts' });
      for (const text of ['Chat', 'Files', 'Ideas', 'Tasks', 'More'])
        await expect(dock.getByText(text, { exact: true })).toBeVisible();
      // The composer keeps file attachment beside the teaching shortcut.
      await page.getByRole('button', { name: 'Add to chat', exact: true }).click();
      const picker = page.waitForEvent('filechooser');
      await page.getByRole('menuitem', { name: 'Attach files', exact: true }).click();
      await (
        await picker
      ).setFiles({
        name: 'weekend.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('A little weekend plan.'),
      });
      await expect(page.locator('.attachment-list')).toContainText('weekend.txt');
      await page.screenshot({ path: join(evidence, `simple-chat-${platform}.png`) });
      for (const [name, route] of [
        ['Files', 'files'],
        ['Ideas', 'ideas'],
        ['Tasks', 'activity'],
      ]) {
        await dock.getByRole('button', { name, exact: true }).click();
        await expect(composer()).toBeHidden();
        await expect(page).toHaveURL(new RegExp('#' + route + '$'));
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(composer()).toHaveValue('Keep my quiet weekend draft');
        await expect(page.locator('.attachment-list')).toContainText('weekend.txt');
      }
      await dock.getByRole('button', { name: 'More', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.locator('.more-list button')).toHaveCount(10);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(f.store.read().messages.length).toBe(before);
      await page.screenshot({ path: join(evidence, `simple-more-${platform}.png`) });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name: 'Notifications', exact: true })
        .click();
      const card = page.getByRole('article', { name: 'Device notifications' });
      const toggle = card.getByRole('switch', { name: 'Notify this device' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(f.services.notifications.status().devices).toHaveLength(0);
      expect(
        (await page.evaluate(() => window.testNotificationCalls)).filter((x) =>
          ['register', 'requestPermissions'].includes(x.method),
        ),
      ).toHaveLength(0);
      if (platform !== 'desktop') {
        await page.evaluate(() => (window.testPermission = 'denied'));
        await toggle.click();
        await expect(card.getByRole('alert')).toContainText('device settings');
        expect(f.services.notifications.status().devices).toHaveLength(0);
        await page.evaluate(() => (window.testPermission = 'prompt'));
      }
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(card.getByLabel('Show message previews', { exact: false })).not.toBeChecked();
      await card.getByLabel('Show message previews', { exact: false }).check();
      await expect.poll(() => f.services.notifications.status().devices[0]?.preview).toBe(true);
      await card.getByLabel('Show message previews', { exact: false }).uncheck();
      await expect.poll(() => f.services.notifications.status().devices[0]?.preview).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `notifications-settings-${platform}.png`) });
      const m = f.store.mutate((s) =>
        appendAssistant(s, side.id, { text: 'Your Sunday plan is ready.', cards: [] }),
      );
      await page.evaluate((v) => window.emitNotice(v), {
        workspaceId: f.services.notifications.workspaceId,
        noticeId: `message:${m.id}`,
      });
      await expect(page.getByRole('heading', { name: 'Our weekend', exact: true })).toBeVisible();
      await expect(page.locator(`#message-${m.id}`)).toBeVisible();
      await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
      await expect(composer()).toHaveValue('Keep my quiet weekend draft');
      await expect(page.locator('.attachment-list')).toContainText('weekend.txt');
      const reply = act('reply.open', { messageId: m.id });
      const child = f.store.mutate((s) =>
        appendAssistant(s, reply.id, { text: 'We can leave Saturday free.', cards: [] }),
      );
      await page.evaluate((v) => window.emitNotice(v), {
        workspaceId: f.services.notifications.workspaceId,
        noticeId: `message:${child.id}`,
      });
      await expect(page.getByLabel('Reply in thread', { exact: true })).toBeVisible();
      await expect(page.locator(`#message-${child.id}`)).toBeVisible();
      const url = page.url();
      await page.evaluate((v) => window.emitNotice(v), {
        workspaceId: 'another-workspace',
        noticeId: `message:${m.id}`,
      });
      await expect(page.getByRole('status')).toContainText('another Relay');
      expect(page.url()).toBe(url);
      const review = f.store.mutate((s) =>
        createApproval(s, {
          kind: 'terminal',
          title: 'Review this command',
          payload: { command: 'pwd' },
        }),
      );
      const notice = f.store.read().notifications.find((n) => n.reviewId === review.id);
      await page.evaluate((v) => window.emitNotice(v), {
        workspaceId: f.services.notifications.workspaceId,
        noticeId: notice.id,
      });
      await expect(
        page.getByRole('heading', { name: 'Review an action', exact: true }),
      ).toBeVisible();
      expect(f.store.read().approvals.find((a) => a.id === review.id).status).toBe('pending');
      act('profile.update', { theme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await dock.getByRole('button', { name: 'More', exact: true }).click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.screenshot({ path: join(evidence, `simple-more-dark-${platform}.png`) });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page
        .getByRole('navigation', { name: 'Settings categories' })
        .getByRole('button', { name: 'Notifications', exact: true })
        .click();
      await card.getByText('Your connected devices', { exact: true }).click();
      await card.getByRole('button', { name: 'Remove device', exact: true }).click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(f.services.notifications.status().devices).toHaveLength(0);
      expect(errors).toEqual([]);
      checks.push({
        platform,
        passed: true,
        checks: [
          'one-click file attachment',
          'labelled navigation',
          'separate pages retain draft and attachment without adding history',
          'explicit opt-in and private previews',
          'permission denial inline',
          'exact side-chat, reply-thread and review taps',
          'wrong-workspace rejection',
          'removal',
          'light/dark accessibility and phone overflow',
        ],
      });
      console.log('PASS', platform);
    } finally {
      await context.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'notifications-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope: 'Real HTTP server and UI. Native callback fixtures; no OS delivery claim.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
