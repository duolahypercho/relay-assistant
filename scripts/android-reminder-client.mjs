// SPDX-License-Identifier: MIT
// Dedicated-emulator helper. Never clears or connects an owner device.
import assert from 'node:assert/strict';
import { _android as android, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export async function androidReminderClient() {
  const serial = process.env.RELAY_ANDROID_TEST_SERIAL,
    sdk = process.env.ANDROID_HOME;
  assert(sdk && /^emulator-\d+$/.test(serial || ''));
  const exec = promisify(execFile);
  const adb = async (...args) =>
    (await exec(join(sdk, 'platform-tools/adb'), ['-s', serial, ...args], { timeout: 60000 }))
      .stdout;
  const avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim();
  assert.match(avd, /^Relay-QA-\d+$/);
  assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
  const started = Number((await adb('shell', 'date', '+%s')).trim());
  assert(Number.isFinite(started));
  const webView = (await adb('shell', 'dumpsys', 'webviewupdate'))
    .split(/\r?\n/)
    .find((line) => line.includes('Current WebView package'))
    ?.trim();
  assert(webView, 'The test device must report its WebView provider.');
  const fingerprint = (await adb('shell', 'getprop', 'ro.build.fingerprint')).trim();
  await adb('shell', 'wm', 'size', '540x1170');
  await adb('shell', 'wm', 'density', '240');
  const apk = resolve('native/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
  const apkSha256 = createHash('sha256')
    .update(await readFile(apk))
    .digest('hex');
  await adb('install', '-r', apk);
  assert.match(await adb('shell', 'pm', 'clear', 'org.relay.assistant'), /Success/);
  const device = (await android.devices()).find((d) => d.serial() === serial);
  assert(device);
  device.setDefaultTimeout(15000);
  const contexts = new Set();
  const relaunches = [];
  let port;
  async function keyboardPrompt() {
    const p = await device
      .info({ res: 'com.android.permissioncontroller:id/permission_message' })
      .catch(() => null);
    if (p?.text === 'Allow Android Keyboard (AOSP) to access your contacts?') {
      await device.tap({ res: 'com.android.permissioncontroller:id/permission_deny_button' });
      return true;
    }
    return false;
  }
  async function pageAt(origin, pid) {
    let page;
    await expect
      .poll(
        async () => {
          try {
            const webView = pid
              ? device.webViews().find((v) => v.pkg() === 'org.relay.assistant' && v.pid() === pid)
              : await device.webView({ pkg: 'org.relay.assistant' }, { timeout: 5000 });
            if (!webView) return false;
            const attached = await webView.page();
            const context = attached.context();
            contexts.add(context);
            page = context
              .pages()
              .find((p) => !p.isClosed() && (!origin || p.url().startsWith(origin)));
            return !!page;
          } catch {
            return false;
          }
        },
        { timeout: 60000, message: 'Relay Android WebView navigation' },
      )
      .toBe(true);
    return page;
  }
  return {
    avd,
    serial,
    apkSha256,
    webView,
    fingerprint,
    relaunches,
    async diagnostics() {
      const log = (await adb('logcat', '-b', 'crash', '-d', '-v', 'epoch'))
        .split(/\r?\n/)
        .filter((line) => Number(line.trim().split(/\s+/, 1)[0]) >= started);
      return {
        webView,
        fingerprint,
        crashes: log.filter(
          (line) =>
            line.includes('>>> org.relay.assistant <<<') ||
            (line.includes('Fatal signal') && line.includes('relay.assistant')),
        ),
        crashLog: log.join('\n'),
      };
    },
    async connect(url) {
      port = new URL(url).port;
      await adb('reverse', `tcp:${port}`, `tcp:${port}`);
      await keyboardPrompt();
      await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
      const page = await pageAt();
      for (const name of ['More', 'Settings', 'Data & devices', 'Connect your devices'])
        await page.getByRole('button', { name, exact: true }).click({ noWaitAfter: true });
      await expect
        .poll(async () => !!(await device.info({ desc: 'Relay server address' }).catch(() => null)))
        .toBe(true);
      await device.fill({ desc: 'Relay server address' }, url);
      await keyboardPrompt();
      if ((await device.info({ desc: 'Relay server address' })).text !== url)
        await device.fill({ desc: 'Relay server address' }, url);
      assert.equal((await device.info({ desc: 'Relay server address' })).text, url);
      await device.tap({ res: 'android:id/button1' });
      let handledLateKeyboardPrompt = false;
      await expect
        .poll(
          async () => {
            if (
              (
                await adb(
                  'shell',
                  'run-as',
                  'org.relay.assistant',
                  'cat',
                  'shared_prefs/relay-connection.xml',
                ).catch(() => '')
              ).includes(url)
            )
              return true;
            if (!handledLateKeyboardPrompt && (await keyboardPrompt())) {
              handledLateKeyboardPrompt = true;
              await device.fill({ desc: 'Relay server address' }, url);
              assert.equal((await device.info({ desc: 'Relay server address' })).text, url);
              await device.tap({ res: 'android:id/button1' });
            }
            return false;
          },
          { timeout: 15000 },
        )
        .toBe(true);
      const connected = await pageAt(url);
      await expect(connected.locator('.composer textarea')).toBeVisible();
      // Focus the actual native WebView editor after Activity recreation. CDP
      // focus alone can leave Android's keyboard attached to the old dialog.
      await device.tap({ clazz: 'android.widget.EditText', pkg: 'org.relay.assistant' });
      return connected;
    },
    screenshot: (options) => device.screenshot(options),
    async type(input, text) {
      assert.match(text, /^[A-Za-z0-9 @._-]+$/, 'Native acceptance input must be plain ASCII.');
      await input.click({ noWaitAfter: true });
      await expect
        .poll(async () =>
          (await adb('shell', 'dumpsys', 'input_method')).includes('mInputShown=true'),
        )
        .toBe(true);
      // Playwright's Android input.type maps letters to unshifted key codes.
      // Android's own text injector preserves case and still uses native input.
      // The whitelist and encoded spaces keep this remote shell argument literal.
      await adb('shell', 'input', 'text', text.replaceAll(' ', '%s'));
    },
    async hideKeyboard(page) {
      // The IME application's mIsInputViewShown can remain true after hiding.
      // Read the input manager's current state, not the application's history.
      const shown = async () =>
        (await adb('shell', 'dumpsys', 'input_method')).match(/mInputShown=(true|false)/)?.[1] ===
        'true';
      // Hide through the installed native keyboard plugin. Back can navigate
      // away when the IME closes between observation and key dispatch.
      await page.evaluate(async () => {
        const cap = globalThis.Capacitor;
        if (!cap?.isPluginAvailable('Keyboard')) throw Error('Native keyboard plugin unavailable');
        const keyboard = cap.Plugins.Keyboard || cap.registerPlugin('Keyboard');
        try {
          await keyboard.hide();
        } catch (error) {
          if (!String(error?.message).includes('not currently focused')) throw error;
        }
      });
      await expect.poll(shown, { timeout: 15000 }).toBe(false);
      // Native keyboard/window animations finish outside WebView animation frames.
      await new Promise((done) => setTimeout(done, 250));
    },
    async relaunch(url) {
      const before = Number((await adb('shell', 'pidof', 'org.relay.assistant')).trim());
      assert(Number.isInteger(before) && before > 0);
      await adb('shell', 'am', 'force-stop', 'org.relay.assistant');
      await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
      let after;
      await expect
        .poll(
          async () => {
            after = Number(
              (await adb('shell', 'pidof', 'org.relay.assistant').catch(() => '')).trim(),
            );
            return Number.isInteger(after) && after > 0 && after !== before;
          },
          { timeout: 30000 },
        )
        .toBe(true);
      // Android's WebView discovery can briefly retain the terminated process.
      // Attach only the new process, never the cached page from before relaunch.
      const page = await pageAt(url, after);
      relaunches.push({ before, after });
      return page;
    },
    async close() {
      for (const context of contexts) await context.close().catch(() => {});
      if (port) await adb('reverse', '--remove', `tcp:${port}`).catch(() => {});
      await device.close();
      // This Android driver leaves its instrumentation shell open on close.
      // Release only that test driver on the verified dedicated AVD.
      assert.equal((await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim(), avd);
      await adb('shell', 'am', 'force-stop', 'com.microsoft.playwright.androiddriver');
    },
  };
}
