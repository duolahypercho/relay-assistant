// SPDX-License-Identifier: MIT
// Controlled HTTP model, actual tools/worker/storage and rendered clients.
import assert from 'node:assert/strict';
import { chromium, _electron as electron, _android as android, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assistantsFixture } from './assistants-fixture.mjs';
import { dispatchRoutines, routineCommand } from '../shared/routines.mjs';
import { uiText } from '../shared/ui-language.mjs';

const mac = process.argv.includes('--mac');
const nativeAndroid = process.argv.includes('--android');
assert(!(mac && nativeAndroid));
const evidence = resolve(process.env.RELAY_EVIDENCE_DIR || '../relay-evidence/simple-reminders/ui');
await mkdir(evidence, { recursive: true });
const browser =
  mac || nativeAndroid ? null : await chromium.launch({ channel: 'chrome', headless: true });
let device, avd, apkSha256;
const serial = process.env.RELAY_ANDROID_TEST_SERIAL;
const exec = promisify(execFile);
const adb = async (...args) =>
  (
    await exec(join(process.env.ANDROID_HOME, 'platform-tools/adb'), ['-s', serial, ...args], {
      timeout: 60000,
    })
  ).stdout;
async function dismissKeyboardContactsPrompt() {
  const permission = await device
    .info({ res: 'com.android.permissioncontroller:id/permission_message' })
    .catch(() => null);
  if (permission?.text === 'Allow Android Keyboard (AOSP) to access your contacts?') {
    await device.tap({ res: 'com.android.permissioncontroller:id/permission_deny_button' });
  }
}
async function androidPage(origin) {
  // Activity.recreate can replace the CDP target without changing the process
  // or socket name. Reattach the test driver after native navigation/relaunch.
  if (origin) {
    await device.close();
    device = (await android.devices()).find((d) => d.serial() === serial);
    assert(device);
    device.setDefaultTimeout(15000);
  }
  let page, lastError;
  await expect
    .poll(
      async () => {
        try {
          const attached = await (
            await device.webView({ pkg: 'org.relay.assistant' }, { timeout: 5000 })
          ).page();
          page = attached
            .context()
            .pages()
            .find((p) => !p.isClosed() && (!origin || p.url().startsWith(origin)));
          if (!page)
            lastError = `Observed WebView pages: ${attached
              .context()
              .pages()
              .map((p) => p.url())
              .join(', ')}`;
          return !!page;
        } catch (error) {
          lastError = error.message;
          return false;
        }
      },
      { timeout: 60000, message: 'Waiting for the actual Android WebView' },
    )
    .toBe(true)
    .catch((error) => {
      throw new Error(lastError || error.message);
    });
  return page;
}
const report = {
  passed: false,
  checks: [],
  scope:
    'Controlled HTTP model; actual chat, tool, SQLite, worker and clients. Due time is advanced explicitly in the fixture, not a real-time timing or model-quality claim.',
};
try {
  if (nativeAndroid) {
    assert(
      process.env.ANDROID_HOME && /^emulator-\d+$/.test(serial || ''),
      'Use the dedicated acceptance emulator.',
    );
    avd = (await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim();
    assert.match(avd, /^Relay-QA-\d+$/);
    assert.equal((await adb('shell', 'getprop', 'ro.kernel.qemu')).trim(), '1');
    // A 360dp phone viewport with fewer physical pixels keeps the dedicated
    // software-rendered emulator affordable on a busy development machine.
    await adb('shell', 'wm', 'size', '540x1170');
    await adb('shell', 'wm', 'density', '240');
    const apk = resolve('native/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
    apkSha256 = createHash('sha256')
      .update(await readFile(apk))
      .digest('hex');
    await adb('install', '-r', apk);
    assert.match(await adb('shell', 'pm', 'clear', 'org.relay.assistant'), /Success/);
    device = (await android.devices()).find((d) => d.serial() === serial);
    assert(device);
    device.setDefaultTimeout(15000);
    await dismissKeyboardContactsPrompt();
  }
  for (const [width, theme, language] of mac || nativeAndroid
    ? [[1365, 'light', 'en']]
    : [
        [1365, 'light', 'en'],
        [390, 'dark', 'en'],
        [320, 'light', 'zh-CN'],
        [390, 'dark', 'zh-TW'],
      ]) {
    const surface = mac ? 'mac' : nativeAndroid ? 'android' : `${width}-${theme}-${language}`;
    const directory = await mkdtemp(join(tmpdir(), 'relay-reminders-ui-'));
    const t = (key) => uiText(language, key);
    const f = await assistantsFixture(directory, {
      configure(store) {
        store.mutate((s) => {
          s.profile.memoryLearning = false;
          s.profile.timeZone = 'Asia/Shanghai';
          s.profile.theme = theme;
        });
      },
      respond({ messages, tools }) {
        if (messages.at(-1).role === 'tool')
          return { role: 'assistant', content: 'I’ll remind you in five minutes.' };
        assert(tools.some((t) => t.function.name === 'create_reminder'));
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'water-reminder',
              type: 'function',
              function: {
                name: 'create_reminder',
                arguments: JSON.stringify({ text: 'Time for a glass of water.', delayMinutes: 5 }),
              },
            },
          ],
        };
      },
    });
    let app, context, page;
    try {
      if (mac) {
        const data = join(directory, 'desktop');
        await mkdir(data);
        await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: f.url }));
        app = await electron.launch({
          executablePath: resolve(
            'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
          ),
          args: [`--relay-test-data=${data}`],
        });
        context = app.context();
        page = await app.firstWindow();
      } else if (nativeAndroid) {
        const port = new URL(f.url).port;
        await adb('reverse', `tcp:${port}`, `tcp:${port}`);
        await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
        page = await androidPage();
        await page
          .getByRole('button', { name: 'More', exact: true })
          .click({ noWaitAfter: nativeAndroid });
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .click({ noWaitAfter: nativeAndroid });
        await page
          .getByRole('navigation', { name: 'Settings categories' })
          .getByRole('button', { name: 'Data & devices', exact: true })
          .click({ noWaitAfter: nativeAndroid });
        await page
          .getByRole('button', { name: 'Connect your devices', exact: true })
          .click({ noWaitAfter: nativeAndroid });
        await expect
          .poll(async () => {
            try {
              await device.info({ desc: 'Relay server address' });
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
        await device.fill({ desc: 'Relay server address' }, f.url);
        await dismissKeyboardContactsPrompt();
        if ((await device.info({ desc: 'Relay server address' })).text !== f.url)
          await device.fill({ desc: 'Relay server address' }, f.url);
        assert.equal((await device.info({ desc: 'Relay server address' })).text, f.url);
        await device.tap({ res: 'android:id/button1' });
        await expect
          .poll(
            async () => {
              const preferences = await adb(
                'shell',
                'run-as',
                'org.relay.assistant',
                'cat',
                'shared_prefs/relay-connection.xml',
              ).catch(() => '');
              return preferences.includes(f.url);
            },
            { timeout: 15000, message: 'Native Connect saved the fixture address' },
          )
          .toBe(true);
        page = await androidPage(f.url);
      } else {
        context = await browser.newContext({
          viewport: { width, height: width < 600 ? 844 : 950 },
          isMobile: width < 600,
          hasTouch: width < 600,
          reducedMotion: 'reduce',
        });
        await context.addInitScript(
          (language) => localStorage.setItem('relay.ui-language', language),
          language,
        );
        page = await context.newPage();
        await page.goto(f.url);
      }
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const composer = page.locator('.composer textarea');
      await composer.fill('Remind me in five minutes to drink water.');
      await page
        .getByRole('button', { name: t('Send message'), exact: true })
        .click({ noWaitAfter: nativeAndroid });
      const card = page.getByRole('article', { name: t('Reminder'), exact: true });
      await expect(card).toBeVisible();
      await expect(card.getByRole('status')).toHaveText(t('Scheduled'));
      await expect.poll(() => f.store.read().runs[0].status).toBe('completed');
      let s = f.store.read();
      const reminder = s.routines[0];
      assert.equal(reminder.paused, false);
      assert.equal(
        reminder.nextRunAt,
        Date.parse(s.messages.find((m) => m.role === 'user').createdAt) + 300000,
      );
      await composer.fill('Keep my unfinished message 原文');
      await expect
        .poll(() => f.store.read().threads[0].draft)
        .toBe('Keep my unfinished message 原文');
      const originalMessages = f.store.read().messages.length;
      // A transport failure stays in the card and changes no reminder or history.
      await page.route('**/api/command', async (route) => {
        if (route.request().postDataJSON().action === 'routine.pause') {
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Please try again.' }),
          });
        } else await route.continue();
      });
      await card
        .getByRole('button', { name: t('Pause'), exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await expect(card.getByRole('alert')).toBeVisible();
      assert.equal(f.store.read().routines[0].paused, false);
      await page.unroute('**/api/command');
      await card
        .getByRole('button', { name: t('Pause'), exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await expect(card.getByRole('status')).toHaveText(t('Paused'));
      await expect(card.getByRole('alert')).toHaveCount(0);
      await card
        .getByRole('button', { name: t('Resume'), exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await expect(card.getByRole('status')).toHaveText(t('Scheduled'));
      for (const button of await card.getByRole('button').all()) {
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44);
      }
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(mac || nativeAndroid).analyze()).violations,
        [],
      );
      await (nativeAndroid ? device : page).screenshot({
        path: join(evidence, `scheduled-${surface}.png`),
      });
      await card
        .getByRole('button', { name: t('Details'), exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await expect(page).toHaveURL(/#routines$/);
      assert.equal(f.store.read().messages.length, originalMessages);
      await page
        .getByRole('button', { name: t('Back to chat'), exact: true })
        .click({ noWaitAfter: nativeAndroid });
      await expect(composer).toHaveValue('Keep my unfinished message 原文');
      await page.reload();
      await expect(card.getByRole('status')).toHaveText(t('Scheduled'));
      const modelRequests = f.requests.length;
      // Deterministic due-clock jump; actual delivery still runs through the worker.
      f.store.mutate((s) => dispatchRoutines(s, reminder.nextRunAt));
      await expect
        .poll(() => f.store.read().messages.filter((m) => m.routineId === reminder.id).length)
        .toBe(1);
      await expect(card.getByRole('status')).toHaveText(t('Delivered'));
      assert.equal(f.requests.length, modelRequests);
      assert.equal(
        f.store.read().messages.find((m) => m.routineId === reminder.id).text,
        'Time for a glass of water.',
      );
      await expect(card.getByRole('button', { name: t('Pause'), exact: true })).toHaveCount(0);
      await expect(composer).toHaveValue('Keep my unfinished message 原文');
      await (nativeAndroid ? device : page).screenshot({
        path: join(evidence, `delivered-${surface}.png`),
      });
      await f.worker.stop();
      const future = new Date(Date.now() + 3600000).toISOString();
      f.store.mutate((s) => {
        const revised = routineCommand(s, 'routine.update', {
          id: reminder.id,
          schedule: {
            kind: 'once',
            date: future.slice(0, 10),
            time: future.slice(11, 16),
            timeZone: 'UTC',
          },
        });
        routineCommand(s, 'routine.resume', { id: reminder.id });
        dispatchRoutines(s, revised.nextRunAt);
      });
      await expect(card.getByRole('status')).toHaveText(t('Due now'));
      f.worker.start();
      await expect
        .poll(() => f.store.read().messages.filter((m) => m.routineId === reminder.id).length)
        .toBe(2);
      await expect(card.getByRole('status')).toHaveText(t('Delivered'));
      assert.equal(f.requests.length, modelRequests);
      f.store.mutate((s) =>
        routineCommand(s, 'routine.update', {
          id: reminder.id,
          execution: 'assistant',
          schedule: { kind: 'interval', minutes: 60, timeZone: 'Asia/Shanghai' },
        }),
      );
      const edited = page.getByRole('article', { name: t('Routine'), exact: true });
      await expect(edited).toBeVisible();
      await expect(edited).toContainText(
        uiText(language, 'Every {minutes} minutes', { minutes: 60 }),
      );
      assert.equal(f.store.read().routines[0].reminderRelative, false);
      f.store.mutate((s) => routineCommand(s, 'routine.archive', { id: reminder.id }));
      await expect(edited.getByRole('status')).toHaveText(t('Cancelled'));
      if (nativeAndroid) {
        await adb('shell', 'am', 'force-stop', 'org.relay.assistant');
        await adb('shell', 'am', 'start', '-n', 'org.relay.assistant/.MainActivity');
        page = await androidPage(f.url);
        await expect(page.locator('.composer textarea')).toHaveValue(
          'Keep my unfinished message 原文',
        );
        await expect(
          page.getByRole('article', { name: 'Routine', exact: true }).getByRole('status'),
        ).toHaveText('Cancelled');
      }
      assert.deepEqual(errors, []);
      report.checks.push({
        surface,
        ...(nativeAndroid ? { avd, apkSha256, nativeRelaunch: true } : {}),
        passed: true,
        modelRequests,
        messages: f.store.read().messages.length,
        checks: [
          'one-step enabled reminder',
          'inline failure/pause/resume with draft intact',
          'separate details page, no navigation transcript',
          'exactly one fixed-text worker delivery without AI',
          '44px controls, no overflow/modal, zero accessibility violations',
          'reload, delivered and archived states',
        ],
      });
      console.log(`PASS ${surface}: reminder creation, controls and delivery`);
    } catch (error) {
      await page
        ?.screenshot({ path: join(evidence, `failure-${surface}.png`), timeout: 15000 })
        .catch(() => {});
      throw error;
    } finally {
      if (app) await app.close();
      else await context?.close();
      if (nativeAndroid) await adb('reverse', '--remove', `tcp:${new URL(f.url).port}`);
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  report.passed = true;
} finally {
  await writeFile(
    join(evidence, `acceptance-${mac ? 'mac' : nativeAndroid ? 'android' : 'browser'}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser?.close();
  await device?.close();
}
