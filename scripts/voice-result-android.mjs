// SPDX-License-Identifier: MIT
// Inspect an actual voice-created deliverable on a dedicated native Android app.
import { _android as android, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
export async function inspectVoiceResultOnAndroid({
  url,
  file,
  bytes,
  evidence,
  draft,
  inspectChat,
}) {
  const sdk = process.env.ANDROID_HOME,
    serial = process.env.RELAY_ANDROID_TEST_SERIAL;
  assert(sdk && /^emulator-\d+$/.test(serial || ''), 'Use a dedicated Relay-QA emulator');
  const run = promisify(execFile),
    adbPath = join(sdk, 'platform-tools/adb');
  const adb = async (...args) =>
    (await run(adbPath, ['-s', serial, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }))
      .stdout;
  const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim();
  assert.match(avd, /^Relay-QA-\d+$/);
  assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
  const apk = resolve('native/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  const report = {
    passed: false,
    avd,
    serial,
    apk,
    apkSha256: hash(await readFile(apk)),
    screenshots: [],
    scope:
      'Actual dedicated Android emulator, native connection form, WebView document preview and authenticated file bytes. Draft saved for a separate desktop continuation check. No physical phone or native export claim.',
  };
  const port = new URL(url).port;
  let device, page;
  async function native(selector) {
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
        { timeout: 20000 },
      )
      .toBe(true);
  }
  async function workspace(origin) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const attached = await (
          await device.webView({ pkg: 'org.relay.assistant' }, { timeout: 2500 })
        ).page();
        for (const candidate of attached.context().pages()) {
          if (candidate.isClosed() || (origin && !candidate.url().startsWith(origin))) continue;
          await expect(candidate.locator('.composer textarea')).toBeVisible({ timeout: 2000 });
          candidate.setDefaultTimeout(15000);
          return candidate;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error('The dedicated Android workspace did not become visible');
  }
  async function capture(name) {
    const path = join(evidence, `android-${name}.png`);
    await device.screenshot({ path });
    const image = await loadImage(await readFile(path)),
      canvas = createCanvas(image.width, image.height),
      context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(
      0,
      Math.floor(image.height * 0.12),
      image.width,
      Math.floor(image.height * 0.75),
    ).data;
    let drawn = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] < 210 && pixels[i + 1] < 210 && pixels[i + 2] < 210 && pixels[i + 3] > 0)
        drawn++;
    report.screenshots.push({ path, drawnPixels: drawn });
    assert(drawn > 500, 'Native viewport is blank despite DOM content');
  }
  try {
    await adb('install', '-r', apk);
    assert.match(await adb('shell', 'pm', 'clear', 'org.relay.assistant'), /Success/);
    await adb(
      'shell',
      'cmd',
      'locale',
      'set-app-locales',
      'org.relay.assistant',
      '--locales',
      'en',
    );
    await adb('reverse', `tcp:${port}`, `tcp:${port}`);
    device = (await android.devices()).find((d) => d.serial() === serial);
    assert(device);
    device.setDefaultTimeout(15000);
    await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
    page = await workspace();
    await page.evaluate(() => window.Capacitor.Plugins.RelayConnection.show({ locale: 'en' }));
    await native({ desc: 'Relay server address' });
    await device.fill({ desc: 'Relay server address' }, url);
    await native({ res: 'android:id/button1' });
    await device.tap({ res: 'android:id/button1' });
    page = await workspace(url);
    const before = await page.evaluate(async () => (await fetch('/api/state')).json());
    if (inspectChat) {
      await inspectChat(page);
      await capture('chat-result');
    }
    await page
      .locator('.messages')
      .getByRole('button', { name: new RegExp(file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .click();
    await expect(page.locator('.document-preview')).toContainText('sketchbook');
    const downloaded = await page.evaluate(async (id) => {
      const response = await fetch('/api/files/' + encodeURIComponent(id));
      if (!response.ok) throw Error('File delivery failed');
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, file.id);
    assert.deepEqual(Buffer.from(downloaded), bytes);
    report.deliveredSha256 = hash(Buffer.from(downloaded));
    await capture('corrected-brief');
    await page.goto(url + '/#chat');
    const input = page.locator('.composer textarea');
    await expect(input).toBeVisible();
    await input.fill(draft);
    await input.blur();
    await expect
      .poll(
        async () =>
          (await page.evaluate(async () => (await fetch('/api/state')).json())).threads.find(
            (t) => t.id === 'main',
          ).draft,
      )
      .toBe(draft);
    const after = await page.evaluate(async () => (await fetch('/api/state')).json());
    assert.deepEqual(
      after.messages,
      before.messages,
      'File navigation and draft transfer must not add chat messages',
    );
    await capture('desktop-continuation-draft');
    report.passed = true;
    return report;
  } catch (error) {
    report.error = error.stack;
    await capture('failure').catch(() => {});
    error.androidReport = report;
    throw error;
  } finally {
    await adb('shell', 'am', 'force-stop', 'org.relay.assistant').catch(() => {});
    await adb('reverse', '--remove', `tcp:${port}`).catch(() => {});
    await adb('shell', 'am', 'force-stop', 'com.microsoft.playwright.androiddriver').catch(
      () => {},
    );
    await device?.close();
  }
}
