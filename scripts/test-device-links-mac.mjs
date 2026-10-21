// SPDX-License-Identifier: MIT
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deviceLinksFixture } from './device-links-fixture.mjs';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
const expect = baseExpect.configure({ timeout: 30000 });
const directory = await mkdtemp(join(tmpdir(), 'relay-device-links-desktop-')),
  evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence');
const label = process.env.RELAY_DESKTOP_TEST_LABEL || 'mac';
if (!/^[a-z0-9-]{1,40}$/.test(label)) throw Error('Use a simple desktop test label.');
const expectedName =
  process.platform === 'darwin'
    ? 'My Mac'
    : process.platform === 'win32'
      ? 'My Windows PC'
      : 'My Linux PC';
const capture = (name) => join(evidence, `device-links-native-${label}-${name}`);
await mkdir(evidence, { recursive: true });
const f = await deviceLinksFixture(directory),
  data = join(directory, 'client');
await mkdir(data);
const cert = await readFile(join(directory, 'server.pem'), 'utf8');
const pin = createHash('sha256')
  .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const options = {
  executablePath: resolve(
    process.env.RELAY_DESKTOP_EXECUTABLE ||
      'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
  ),
  chromiumSandbox: true,
  args: [
    `--relay-test-data=${data}`,
    '--relay-local-port=0',
    `--ignore-certificate-errors-spki-list=${pin}`,
  ],
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RELAY_'))),
    RELAY_MODE: 'sample',
    RELAY_BROWSER_ENABLED: 'false',
    RELAY_DESKTOP_ENABLED: 'false',
  },
};
let app;
async function launch() {
  app = await electron.launch(options);
  const page = await app.firstWindow();
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);
  return page;
}
try {
  let page = await launch();
  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  const link = await f.ownerCall('/api/device-links', {});
  const opened = app.waitForEvent('window');
  await app.evaluate(({ app, Menu }) => {
    // Capture the normal quit and relaunch ourselves, so Playwright owns both
    // instances. Authentication, cookie persistence and config saving are real.
    app.relaunch = () => {};
    const find = (menu) => {
      for (const item of menu.items) {
        if (item.label === 'Connect to shared server…') return item;
        const child = item.submenu && find(item.submenu);
        if (child) return child;
      }
    };
    find(Menu.getApplicationMenu()).click();
  });
  const connection = await opened;
  await connection.getByLabel('Server address or connection link').fill(link.url);
  await connection.screenshot({ path: capture('entry.png') });
  const closed = app.waitForEvent('close');
  await connection.getByRole('button', { name: 'Connect', exact: true }).click();
  await closed;
  app = null;
  const saved = JSON.parse(await readFile(join(data, 'desktop.json'), 'utf8'));
  assert.deepEqual(saved, { server: f.url });
  page = await launch();

  await expect(page.getByLabel('Message Relay', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Server access key')).toHaveCount(0);
  await page.getByLabel('Message Relay', { exact: true }).fill('Hello from my linked desktop');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByText('Your devices are sharing this conversation.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Message Relay', { exact: true }).fill('Keep my connected desktop draft');
  await app.close();
  app = null;
  // Hold the first stylesheet so Reload deterministically replaces an unfinished
  // startup navigation. All other requests still use the real HTTPS backend.
  const handlers = f.server.listeners('request');
  assert.equal(handlers.length, 1);
  f.server.removeListener('request', handlers[0]);
  let heldResponse,
    hold = true;
  f.server.on('request', (request, response) => {
    if (hold && new URL(request.url, f.url).pathname.endsWith('.css')) {
      hold = false;
      heldResponse = response;
      return;
    }
    handlers[0](request, response);
  });
  page = await launch();
  await expect.poll(() => !!heldResponse).toBe(true);
  await app.evaluate(({ dialog }) => {
    // Record a fatal dialog instead of blocking the unattended test behind it.
    globalThis.startupErrors = [];
    dialog.showErrorBox = (title, message) => globalThis.startupErrors.push({ title, message });
  });
  await page.reload();
  heldResponse.destroy();
  await expect(page.getByLabel('Message Relay', { exact: true })).toHaveValue(
    'Keep my connected desktop draft',
  );
  expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
  await page.screenshot({ path: capture('conversation.png') });
  expect(await app.evaluate(() => globalThis.startupErrors)).toEqual([]);
  const devices = await f.ownerCall('/api/device-links');
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].name, expectedName);
  await f.ownerCall(`/api/devices/${devices.devices[0].id}/disconnect`, {});
  await expect(page.getByLabel('Server access key')).toBeVisible();
  assert.equal(f.store.read().messages.length, 2);
  assert.equal(f.requests.length, 1);
  await writeFile(
    capture('acceptance.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        platform: process.platform,
        arch: process.arch,
        deviceName: devices.devices[0].name,
        checks: [
          'Actual packaged native connection window accepts one-use HTTPS link',
          'Native partition gets Secure HttpOnly cookie and saves only origin',
          'Full quit/relaunch preserves session, controlled model conversation and draft',
          'Reload during an unfinished initial HTTPS navigation keeps the app open without a fatal dialog',
          'Owner revocation closes the desktop live session',
        ],
        limits:
          'Unsigned desktop package. Fixture certificate trusted only in the disposable app session. Test captures automatic app relaunch and performs it explicitly; no public network or live provider claim.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS packaged desktop device link, session persistence, conversation and revocation',
  );
} catch (error) {
  await app
    ?.firstWindow()
    .then((page) => page.screenshot({ path: capture('failure.png') }))
    .catch(() => {});
  await writeFile(
    capture('acceptance.json'),
    JSON.stringify(
      {
        passed: false,
        checkedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        error: error.stack,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
