// SPDX-License-Identifier: MIT
// Real native Android forms and offline recovery on a dedicated disposable emulator.
import { _android as android, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantsFixture } from './assistants-fixture.mjs';
const serial = process.env.RELAY_ANDROID_TEST_SERIAL,
  sdk = process.env.ANDROID_HOME;
assert(
  sdk && /^emulator-\d+$/.test(serial || ''),
  'Set ANDROID_HOME and a dedicated RELAY_ANDROID_TEST_SERIAL',
);
const run = promisify(execFile),
  adbPath = join(sdk, 'platform-tools/adb');
const adb = async (...args) =>
  (await run(adbPath, ['-s', serial, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }))
    .stdout;
const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim();
assert.match(avd, /^Relay-QA-\d+$/);
assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
const apk = resolve('native/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
const apkSha256 = createHash('sha256')
  .update(await readFile(apk))
  .digest('hex');
const dir = await mkdtemp(join(tmpdir(), 'relay-android-connection-'));
const evidence = resolve('../relay-evidence'),
  stamp = Date.now();
await mkdir(evidence, { recursive: true });
const copy = JSON.parse(await readFile('public/native-connection-language.json', 'utf8'));
const f = await assistantsFixture(dir);
const port = new URL(f.url).port;
const offline = 'https://127.0.0.1:44443/';
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

const checks = [],
  screenshots = [];
async function capture(name) {
  const path = join(evidence, `android-connection-${name}-${stamp}.png`);
  await device.screenshot({ path });
  screenshots.push(path);
}
async function workspace(origin) {
  let last;
  for (let i = 0; i < 45; i++) {
    try {
      const view = await device.webView({ pkg: 'org.relay.assistant' }, { timeout: 2500 });
      const attached = await view.page();
      for (const p of attached
        .context()
        .pages()
        .filter((p) => !p.isClosed())) {
        if (origin && !p.url().startsWith(origin)) continue;
        await expect(p.locator('.composer textarea')).toBeVisible({ timeout: 2500 });
        p.setDefaultTimeout(15000);
        return p;
      }
    } catch (error) {
      last = error;
    }
    await delay(200);
  }
  throw Error(`Android workspace unavailable: ${last?.message}`);
}
async function launch() {
  await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
}
async function show(locale) {
  await page.evaluate(async (locale) => {
    await window.Capacitor.Plugins.RelayConnection.show({ locale });
  }, locale);
}
async function connect(url, locale = 'en') {
  await show(locale);
  const label =
    locale === 'en'
      ? 'Relay server address'
      : copy['Relay server address'][locale === 'zh-CN' ? 0 : 1];
  await fillNative({ desc: label }, url);
  await tapNative({ res: 'android:id/button1' });
}
try {
  await adb('install', '-r', apk);
  device = (await android.devices()).find((d) => d.serial() === serial);
  assert(device);
  device.setDefaultTimeout(15000);
  await adb('reverse', `tcp:${port}`, `tcp:${port}`);
  for (const locale of ['en', 'zh-CN', 'zh-TW']) {
    assert.match(await adb('shell', 'pm', 'clear', 'org.relay.assistant'), /Success/);
    await adb(
      'shell',
      'cmd',
      'locale',
      'set-app-locales',
      'org.relay.assistant',
      '--locales',
      locale,
    );
    await launch();
    page = await workspace();
    await connect(f.url);
    page = await workspace(f.url);
    const draft = `Keep my Android ${locale} draft`;
    await page.locator('.composer textarea').fill(draft);
    await expect.poll(() => f.store.read().threads.find((t) => t.id === 'main').draft).toBe(draft);
    const originalUrl = page.url();
    await page.evaluate(
      () =>
        new Promise((done) => {
          const img = new Image();
          img.onerror = () => {
            img.remove();
            done(true);
          };
          img.src = '/missing-android-acceptance-image.png';
          document.body.append(img);
        }),
    );
    await expect(page.locator('.composer textarea')).toHaveValue(draft);
    assert.equal(page.url(), originalUrl);
    const text = (key) => (locale === 'en' ? key : copy[key][locale === 'zh-CN' ? 0 : 1]);
    await show(locale);
    await waitNative({ text: text('Connect your devices') });
    const field = { desc: text('Relay server address') };
    for (const [input, message] of [
      [
        'http://insecure.example.test',
        'Enter your server’s HTTPS address, without a path, password or query.',
      ],
      [
        'https://example.test:22',
        'This address uses a port the app cannot open. Check your server’s web address.',
      ],
    ]) {
      await fillNative(field, input);
      await tapNative({ res: 'android:id/button1' });
      await waitNative({ text: text(message) });
      assert.equal((await device.info(field)).text, input);
    }
    await capture(`${locale}-validation`);
    await tapNative({ res: 'android:id/button2' });
    await expect(page.locator('.composer textarea')).toHaveValue(draft);
    await connect(offline, locale);
    await waitNative({ text: text('Let’s reconnect.') });
    await waitNative({ text: offline });
    const errorPage = await (await device.webView({ pkg: 'org.relay.assistant' })).page();
    await expect
      .poll(() =>
        errorPage
          .context()
          .pages()
          .filter((p) => !p.isClosed())
          .map((p) => new URL(p.url()).pathname),
      )
      .toContain('/native-connection.html');
    await capture(`${locale}-offline`);
    await tapNative({ text: text('Try again').toUpperCase() });
    await waitNative({ text: text('Let’s reconnect.') });
    await adb('shell', 'am', 'force-stop', 'org.relay.assistant');
    await launch();
    await waitNative({ text: text('Let’s reconnect.') });
    await tapNative({ text: text('Change server').toUpperCase() });
    await waitNative(field);
    assert.equal((await device.info(field)).text, offline);
    await tapNative({ res: 'android:id/button2' });
    await waitNative({ text: text('Let’s reconnect.') });
    await tapNative({ text: text('Change server').toUpperCase() });
    await tapNative({ res: 'android:id/button3' });
    page = await workspace();
    assert(!page.url().startsWith(offline));
    await connect(f.url, locale);
    page = await workspace(f.url);
    await expect(page.locator('.composer textarea')).toHaveValue(draft);
    assert.equal(f.store.read().messages.length, 0);
    assert.equal(f.store.read().runs.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await capture(`${locale}-returned`);
    checks.push({
      locale,
      passed: true,
      checks: [
        'Actual native translated form, invalid HTTP and blocked-port errors with retained text',
        'Native Cancel preserves connected draft; failing image subresource keeps workspace',
        'Unavailable allowed-port HTTPS opens exact bundled error page with native controls',
        'Try again and full process restart recover to the correct native screen',
        'Change server, Cancel and Use sample operate without a WebView plugin bridge',
        'Reconnect restores original server draft without a message or model run',
      ],
    });
    console.log(`PASS Android native connection and recovery: ${locale}`);
  }
  await writeFile(
    join(evidence, `android-connection-${stamp}.json`),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        serial,
        avd,
        apk,
        apkSha256,
        checks,
        screenshots,
        scope:
          'Actual debug APK, native controls and Android WebView on a dedicated emulator; synthetic local server. Connection forms opened through the same production plugin used by Settings.',
        limits:
          'No physical device, valid public TLS/account join, microphone, push or signed release acceptance.',
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  if (device) await capture('failure').catch(() => {});
  await writeFile(
    join(evidence, `android-connection-${stamp}.json`),
    JSON.stringify(
      {
        passed: false,
        checkedAt: new Date().toISOString(),
        serial,
        avd,
        apkSha256,
        checks,
        screenshots,
        error: error.stack,
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await adb('logcat', '-d', '-t', '1500')
    .then((log) => writeFile(join(evidence, `android-connection-logcat-${stamp}.txt`), log))
    .catch(() => {});
  await adb('reverse', '--remove', `tcp:${port}`).catch(() => {});
  await adb('shell', 'am', 'force-stop', 'org.relay.assistant').catch(() => {});
  // End the owned instrumentation transport before disconnecting; current
  // Playwright otherwise leaves its Android driver socket open after success.
  await adb('shell', 'am', 'force-stop', 'com.microsoft.playwright.androiddriver').catch(() => {});
  await device?.close();
  await f.close();
  await rm(dir, { recursive: true, force: true });
}
