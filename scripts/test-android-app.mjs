// SPDX-License-Identifier: MIT
// Actual Android APK/WebView + external source APK/system chooser; never an owner device.
import { _android as android, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
import { command } from '../shared/domain.mjs';

const serial = process.env.RELAY_ANDROID_TEST_SERIAL;
const sdk = process.env.ANDROID_HOME;
if (!sdk || !/^emulator-\d+$/.test(serial || ''))
  throw Error(
    'Set ANDROID_HOME and RELAY_ANDROID_TEST_SERIAL to a dedicated Relay-QA-<timestamp> emulator.',
  );
const run = promisify(execFile);
const adbPath = join(sdk, 'platform-tools/adb');
const adb = async (...args) =>
  (await run(adbPath, ['-s', serial, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }))
    .stdout;
const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim();
assert.match(avd, /^Relay-QA-\d+$/, 'Refusing to modify an existing owner device');
assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
const appApk = resolve('native/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
const sourceApk = resolve(
  'native/mobile/android/acceptance/share-source/build/outputs/apk/debug/share-source-debug.apk',
);
const apkHashes = {};
for (const path of [appApk, sourceApk])
  apkHashes[path] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'relay-android-app-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const f = await assistantsFixture(directory, {
  respond: async () => ({ role: 'assistant', content: 'Your Android share arrived.' }),
});
const side = f.store.mutate((state) => command(state, 'thread.create', { title: 'Weekend' }));
const port = String(new URL(f.url).port);
let device, page;
// This Playwright protocol omits selector timeouts on the Android wire.
// Poll read-only native observations, then issue each tap/fill exactly once.
async function waitNative(selector, { timeout = 15000 } = {}) {
  await expect
    .poll(
      async () => {
        try {
          await device.info(selector);
          return true;
        } catch {
          return false;
        }
      },
      { timeout, intervals: [100, 200, 500] },
    )
    .toBe(true);
}
async function tapNative(selector) {
  await waitNative(selector);
  await device.tap(selector);
}
async function fillNative(selector, value) {
  await waitNative(selector);
  await device.fill(selector, value);
}

const errors = [];
const checks = [];
const stamp = Date.now();
const receipt = join(evidence, `android-app-${stamp}.json`);
const screenshots = [];
async function capture(name) {
  const path = join(evidence, `android-app-${name}-${stamp}.png`);
  await device.screenshot({ path });
  screenshots.push(path);
}
async function workspace(expectedOrigin) {
  const end = Date.now() + 45000;
  let last;
  while (Date.now() < end) {
    try {
      const view = await device.webView({ pkg: 'org.relay.assistant' }, { timeout: 5000 });
      // Activity.recreate replaces the WebView within the same process. Playwright
      // caches its first Page; inspect the live context rather than that closed page.
      const attached = await view.page();
      for (const candidate of attached
        .context()
        .pages()
        .filter((p) => !p.isClosed())) {
        if (expectedOrigin && !candidate.url().startsWith(expectedOrigin)) continue;
        candidate.setDefaultTimeout(15000);
        await expect(candidate.locator('.composer textarea')).toBeVisible({ timeout: 5000 });
        candidate.on('pageerror', (error) => errors.push(error.message));
        return candidate;
      }
    } catch (error) {
      last = error;
    }
    await delay(250);
  }
  throw new Error(
    `Relay WebView did not open ${expectedOrigin || 'the workspace'}: ${last?.message || 'wrong page'}`,
  );
}
async function source(button) {
  await adb(
    'shell',
    'am',
    'start',
    '-W',
    '-f',
    '0x10008000',
    '-n',
    'org.relay.sharesource/.ShareSourceActivity',
  );
  await waitNative({ desc: button }, { timeout: 30000 });
  await tapNative({ desc: button });
  await waitNative({ text: /^Relay$/ });
  await capture('system-chooser');
  await tapNative({ text: /^Relay$/ });
  page = await workspace(f.url);
  await expect(page.getByRole('region', { name: 'Incoming share' })).toBeVisible();
}
try {
  // A failed prior share can leave a chooser in the fixture source task.
  await adb('shell', 'am', 'force-stop', 'com.android.intentresolver');
  await adb('install', '-r', appApk);
  await adb('install', '-r', sourceApk);
  // The explicit dedicated AVD check above permits resetting only these fixture applications.
  assert.match(await adb('shell', 'pm', 'clear', 'org.relay.assistant'), /Success/);
  await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const devices = await android.devices();
  device = devices.find((candidate) => candidate.serial() === serial);
  assert(device, 'The dedicated test emulator must be connected to adb');
  device.setDefaultTimeout(15000);
  await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
  page = await workspace();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('button', { name: 'Data & devices', exact: true })
    .click();
  await page.getByRole('button', { name: 'Connect your devices', exact: true }).click();
  await fillNative({ desc: 'Relay server address' }, 'http://insecure.example.test');
  await tapNative({ res: 'android:id/button1' });
  await waitNative({
    text: 'Enter your server’s HTTPS address, without a path, password or query.',
  });
  await fillNative({ desc: 'Relay server address' }, f.url);
  await capture('native-connection');
  await tapNative({ res: 'android:id/button1' });
  page = await workspace(f.url);
  checks.push(
    'Real native connection form rejects insecure remote HTTP and connects a loopback development server',
  );
  const composer = () => page.locator('.composer textarea');
  await composer().fill('Keep my Android draft');
  await expect
    .poll(() => f.store.read().threads.find((thread) => thread.id === 'main').draft)
    .toBe('Keep my Android draft');
  // Parse Android JSONObject escaping before comparing the saved origin.
  await expect
    .poll(async () => {
      const context = JSON.parse(
        await adb(
          'shell',
          'run-as',
          'org.relay.assistant',
          'cat',
          'no_backup/relay-shares/context.json',
        ),
      );
      return JSON.parse(context.scope)[0];
    })
    .toBe(new URL(f.url).origin);
  await source('Share photo and file');
  await expect(page.getByRole('region', { name: 'Incoming share' })).toContainText(
    'android-share.png',
  );
  await expect(page.getByRole('region', { name: 'Incoming share' })).toContainText(
    'android-share.txt',
  );
  assert.equal(f.store.read().messages.length, 0);
  assert.equal(f.store.read().files.length, 0);
  assert.equal(f.requests.length, 0);
  await capture('incoming');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.getByLabel('Shared items')).toContainText('android-share.png');
  await expect(composer()).toHaveValue('Keep my Android draft');
  assert.equal(f.store.read().shareImports.length, 1);
  assert.equal(f.store.read().files.length, 2);
  assert.equal(f.store.read().messages.length, 0);
  assert.equal(f.requests.length, 0);
  await capture('composer');
  checks.push(
    'Separate source APK and real system chooser grant two content URIs; native bridge stages exact files beside the draft without sending',
  );
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(composer()).toBeHidden();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(composer()).toHaveValue('Keep my Android draft');
  await adb('shell', 'am', 'force-stop', 'org.relay.assistant');
  await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
  page = await workspace(f.url);
  await expect(composer()).toHaveValue('Keep my Android draft');
  await expect(page.getByLabel('Shared items')).toContainText('android-share.txt');
  assert.equal(f.store.read().files.length, 2);
  await capture('relaunch');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.locator('.messages').getByText('Your Android share arrived.', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const state = f.store.read();
  const messages = state.messages.filter((message) => message.role === 'user');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'Keep my Android draft');
  assert.equal(messages[0].fileIds.length, 2);
  assert(
    messages[0].sharedTexts.some(
      (text) =>
        text.includes('A real Android shared note') &&
        text.includes('https://example.invalid/android-share'),
    ),
  );
  const document = state.files.find((file) => file.name === 'android-share.txt');
  assert.equal(
    Buffer.from(document.base64, 'base64').toString(),
    'Actual Android shared file bytes.',
  );
  const photo = state.files.find((file) => file.name === 'android-share.png');
  assert.equal(photo.mime, 'image/png');
  assert.equal(
    photo.base64,
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIuoAAAAASUVORK5CYII=',
  );
  assert.deepEqual(state.threads.find((thread) => thread.id === 'main').draftShareIds, []);
  assert.equal(f.requests.length, 1);
  assert(
    !/item-.*\.json/.test(
      await adb('shell', 'run-as', 'org.relay.assistant', 'ls', 'no_backup/relay-shares'),
    ),
  );
  checks.push(
    'Pages preserve the draft; full Android process restart preserves the server and files; one manual Send reaches SQLite/model with original photo/document bytes',
  );
  await composer().fill('Keep my second Main draft');
  await source('Share text only');
  await page.getByRole('combobox', { name: 'Share destination' }).selectOption(side.id);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Weekend', exact: true })).toBeVisible();
  await expect(page.getByLabel('Shared items')).toContainText('A second Android note');
  await expect(composer()).toHaveValue('');
  await page.getByRole('button', { name: 'Back to main chat', exact: true }).click();
  await expect(composer()).toHaveValue('Keep my second Main draft');
  assert.equal(f.store.read().messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(f.requests.length, 1);
  checks.push(
    'A second text share uses onNewIntent, chooses a side chat and preserves the Main draft',
  );
  assert.deepEqual((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await capture('finished');
  await writeFile(
    receipt,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: true,
        serial,
        avd,
        apkHashes,
        checks,
        screenshots,
        scope:
          'Actual debug APKs, Android system chooser, WebView/native bridge, local HTTP Relay/SQLite and controlled model.',
        limits:
          'Dedicated Android emulator. No physical-device, HTTPS authentication, real accounts, live model, microphone/camera, notifications or signed distribution claim.',
      },
      null,
      2,
    ),
  );
  console.log(`PASS actual Android app acceptance; receipt ${receipt}`);
} catch (error) {
  if (device) await capture('failure').catch(() => {});
  await writeFile(
    receipt,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: false,
        serial,
        avd,
        apkHashes,
        checks,
        screenshots,
        error: error.stack,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await adb('logcat', '-d', '-t', '1500')
    .then((log) => writeFile(join(evidence, `android-app-logcat-${stamp}.txt`), log))
    .catch(() => {});
  await adb('reverse', '--remove', `tcp:${port}`).catch(() => {});
  await adb('shell', 'am', 'force-stop', 'org.relay.assistant').catch(() => {});
  await adb('shell', 'am', 'force-stop', 'org.relay.sharesource').catch(() => {});
  // End the owned instrumentation transport before disconnecting; current
  // Playwright otherwise leaves its Android driver socket open after success.
  await adb('shell', 'am', 'force-stop', 'com.microsoft.playwright.androiddriver').catch(() => {});
  await device?.close();
  await f.close();
  await rm(directory, { recursive: true, force: true });
}
