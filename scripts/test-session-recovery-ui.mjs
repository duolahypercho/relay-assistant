// Production server and interface. Network faults are injected by the browser.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence'),
  checks = [];
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'relay-recovery-ui-'));
    const key = 'test-owner-session-key-more-than-24-characters';
    const f = await assistantsFixture(directory, { accessKey: key });
    const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Our weekend' }));
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 950 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
    });
    context.setDefaultTimeout(15000);
    const second = await browser.newContext();
    try {
      const page = await context.newPage(),
        companion = await second.newPage();
      const signIn = async (p) => {
        await p.getByLabel('Server access key', { exact: true }).fill(key);
        await p.getByRole('button', { name: 'Open workspace', exact: true }).click();
        await expect(p.getByLabel('Message Relay', { exact: true })).toBeVisible();
      };
      await page.goto(`${f.url}/#chat/${side.id}`);
      await signIn(page);
      const input = page.getByLabel('Message Relay', { exact: true });
      await expect(page.getByRole('heading', { name: 'Our weekend', exact: true })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({
        name: 'weekend.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Keep these bytes through reconnect.'),
      });
      await expect(
        page.getByRole('button', { name: 'Remove attachment', exact: true }),
      ).toBeVisible();
      await input.fill('A saved weekend draft');
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === side.id).draft)
        .toBe('A saved weekend draft');
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === side.id).draftFileIds?.length)
        .toBe(1);

      await context.setOffline(true);
      await input.fill('An unfinished thought while disconnected');
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
      expect(f.store.read().threads.find((t) => t.id === side.id).draft).toBe(
        'A saved weekend draft',
      );
      await page.screenshot({
        path: join(evidence, `recovery-offline-${mobile ? 'mobile' : 'desktop'}.png`),
      });
      await context.setOffline(false);
      // The online event restores the connection without an extra tap.
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === side.id).draft)
        .toBe('An unfinished thought while disconnected');
      await expect(page.locator('.storage-warning')).toBeHidden();
      await expect(
        page.getByRole('button', { name: 'Remove attachment', exact: true }),
      ).toBeVisible();

      // Expire authorization between a keystroke and its debounced write.
      f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
      await input.fill('Keep this last unsaved thought');
      await expect(page.getByLabel('Server access key', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Sign in to continue. Your unfinished message is kept on this device.', {
          exact: true,
        }),
      ).toBeVisible();
      await page.getByLabel('Server access key', { exact: true }).fill('wrong-test-key');
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Invalid access key');
      await signIn(page);
      await expect(input).toHaveValue('Keep this last unsaved thought');
      await expect(
        page.getByRole('button', { name: 'Remove attachment', exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => f.store.read().threads.find((t) => t.id === side.id).draft)
        .toBe('Keep this last unsaved thought');
      await page.screenshot({
        path: join(evidence, `recovery-restored-${mobile ? 'mobile' : 'desktop'}.png`),
      });

      // A known server must never become an unrelated sample when startup fails.
      await page.route('**/api/state', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"fixture unavailable"}',
        }),
      );
      await page.reload();
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sample mode', exact: true })).toHaveCount(0);
      await page.unroute('**/api/state');
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(input).toHaveValue('Keep this last unsaved thought');

      // Independent second device, one real send, shared server synchronization.
      await companion.goto(`${f.url}/#chat/${side.id}`);
      await signIn(companion);
      const before = f.store.read().messages.length;
      await companion
        .getByLabel('Message Relay', { exact: true })
        .fill('A message from my other device');
      await companion.getByLabel('Message Relay', { exact: true }).press('Enter');
      await expect(
        page
          .locator('.message.user .markdown')
          .filter({ hasText: 'A message from my other device' }),
      ).toBeVisible();
      await expect(input).toHaveValue('Keep this last unsaved thought');
      await expect
        .poll(
          () =>
            f.store
              .read()
              .messages.filter(
                (m) => m.role === 'user' && m.text === 'A message from my other device',
              ).length,
        )
        .toBe(1);
      expect(f.store.read().messages.length).toBeGreaterThan(before);
      expect(f.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(1);
      const cookies = await context.cookies(f.url);
      await context.request.post(f.url + '/api/logout');
      await expect(page.getByLabel('Server access key', { exact: true })).toBeVisible();
      await expect(companion.getByLabel('Message Relay', { exact: true })).toBeVisible();
      expect(cookies.some((c) => c.name === 'relay_session' && c.httpOnly)).toBe(true);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      checks.push({
        platform: mobile ? 'mobile' : 'desktop',
        passed: true,
        offlineDraftRetried: true,
        expiredSessionDraftRetained: true,
        fileRetained: true,
        knownServerNeverBecomesSample: true,
        independentDeviceSynchronization: true,
        logoutEndsStream: true,
        incidentalMessages: 0,
        axeViolations: 0,
      });
      console.log(
        `PASS ${mobile ? 'mobile' : 'desktop'}: offline draft, sign-in recovery, exact chat, attachment, second device and revoked stream`,
      );
    } finally {
      await context.close();
      await second.close();
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(evidence, 'session-recovery-ui-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Real HTTP server and separate browser sessions; browser-injected network faults. Native HTTPS tested separately.',
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
