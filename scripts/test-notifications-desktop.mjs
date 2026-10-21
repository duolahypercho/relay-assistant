// SPDX-License-Identifier: MIT
// Packaged Electron, real cookie authentication, actual OS show event and controlled native click callback.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { Notifications } from '../server/notifications.mjs';
import { modelVaultKey } from '../server/model-connections.mjs';
import { command } from '../shared/domain.mjs';
import { appendAssistant } from '../shared/assistant.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-desktop-alert-')),
  data = join(directory, 'app'),
  evidence = resolve('../relay-evidence');
await mkdir(data);
await mkdir(evidence, { recursive: true });
const f = await assistantsFixture(directory, {
  accessKey: 'fixture-owner-key',
  configure(store, services) {
    services.notifications = new Notifications(store, { key: modelVaultKey(directory) });
  },
});
await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
const side = f.store.mutate((s) => command(s, 'thread.create', { title: 'Our weekend' }));
let app;
try {
  app = await electron.launch({
    executablePath: resolve('release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay'),
    args: [`--relay-test-data=${data}`],
  });
  let page = await app.firstWindow();
  app.context().setDefaultTimeout(15000);
  await page.getByLabel('Server access key', { exact: true }).fill('fixture-owner-key');
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const input = page.locator('.composer textarea');
  await input.fill('Keep my desktop draft');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: 'Notifications', exact: true })
    .click();
  await page.getByRole('switch', { name: 'Notify this device', exact: true }).click();
  await expect(
    page.getByRole('switch', { name: 'Notify this device', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await app.evaluate(({ Notification, BrowserWindow, app }) => {
    globalThis.alertEvents = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function () {
      globalThis.latestAlert = this;
      this.once('show', () =>
        globalThis.alertEvents.push({ kind: 'show', title: this.title, body: this.body }),
      );
      this.once('failed', (_event, error) =>
        globalThis.alertEvents.push({ kind: 'failed', error }),
      );
      return show.call(this);
    };
    BrowserWindow.getAllWindows()[0].focus();
    app.focus({ steal: true });
  });
  const focused = f.store.mutate((s) =>
    appendAssistant(s, side.id, { text: 'Quiet while you are here.', cards: [] }),
  );
  await expect
    .poll(
      () =>
        f.store.db
          .prepare('SELECT status FROM attention_outbox WHERE event_id=?')
          .get(`message:${focused.id}`)?.status,
      { timeout: 15000 },
    )
    .toBe('suppressed');
  expect(await app.evaluate(() => globalThis.alertEvents)).toEqual([]);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.close()),
  );
  const m = f.store.mutate((s) =>
    appendAssistant(s, side.id, { text: 'Your desktop update is ready.', cards: [] }),
  );
  await expect
    .poll(
      () =>
        f.store.db
          .prepare('SELECT status FROM attention_outbox WHERE event_id=?')
          .get(`message:${m.id}`)?.status,
      { timeout: 20000 },
    )
    .toMatch(/^(shown|failed)$/);
  const shown = await app.evaluate(() => globalThis.alertEvents);
  const osShown = shown.some((e) => e.kind === 'show');
  if (osShown)
    expect(shown).toEqual([
      { kind: 'show', title: 'Relay', body: 'You have an update. Open Relay to see it.' },
    ]);
  else {
    expect(shown.some((e) => e.kind === 'failed')).toBe(true);
    expect(f.services.notifications.status().devices[0].lastError).toContain('signed app build');
  }
  if (process.env.RELAY_REQUIRE_OS_NOTIFICATION === 'true') expect(osShown).toBe(true);
  await app.evaluate(() => globalThis.latestAlert.emit('click'));
  await expect.poll(() => app.windows().length).toBe(1);
  page = app.windows()[0];
  await expect(page.getByRole('heading', { name: 'Our weekend', exact: true })).toBeVisible();
  await expect(page.locator(`#message-${m.id}`)).toBeVisible();
  await page.screenshot({ path: join(evidence, 'notification-mac-destination.png') });
  await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my desktop draft');
  expect(f.store.read().messages.filter((m) => m.role === 'user')).toHaveLength(0);
  await writeFile(
    join(evidence, 'notifications-mac-native-acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        osDeliveryVerified: osShown,
        checks: [
          'owner cookie shared by window and background poll',
          'focused suppression',
          osShown
            ? 'actual Electron OS notification show event with every window closed'
            : 'unsigned Mac build rejects OS notification and shows a recovery explanation',
          'private preview',
          'controlled native click callback recreates window and routes exact message',
          'durable draft retained',
          'no incidental messages',
        ],
        limits:
          'Click emitted on the actual Notification object by the test, not a physical Notification Center tap. Unsigned builds cannot establish OS delivery; require it with RELAY_REQUIRE_OS_NOTIFICATION=true on a signed build.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS packaged Mac notifications: authenticated background delivery, focus suppression, reopen and draft',
  );
} finally {
  if (app)
    console.log(
      'NATIVE ALERT EVIDENCE',
      JSON.stringify(await app.evaluate(() => globalThis.alertEvents)),
    );
  await app?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
