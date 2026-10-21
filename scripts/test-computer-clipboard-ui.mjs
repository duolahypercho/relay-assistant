// SPDX-License-Identifier: MIT
// Real guest window + production owner API and UI. No owner workspace or network accounts.
import { chromium, _electron as electron, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import express from 'express';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { createApp } from '../server/app.mjs';
import { computerInputFixture as fixture } from './computer-input-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-clipboard-'));
const evidence = resolve('../relay-evidence');
await mkdir(evidence, { recursive: true });
const store = new Store(join(directory, 'db.sqlite'), { sample: false });
const computer = new PrivateComputer(store, { enabled: true, deployment: directory });
const app = createApp(
  store,
  {
    mode: 'sample',
    computer,
    provider: { configured: false },
    google: { configured: false },
    browser: { enabled: false },
    terminal: { enabled: false },
  },
  { host: '127.0.0.1', port: 0, accessKey: '' },
);
app.use(express.static(resolve('dist')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const native = process.argv.includes('--mac');
let nativeApp, inspectedPage;
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const owner = (p) => computer.perform({ operationId: randomUUID(), ...p }, { actor: 'owner' });
const observe = async () =>
  JSON.parse(Buffer.from((await computer.read('input-state.json')).base64, 'base64').toString());
try {
  await computer.start('owner');
  await computer.takeControl();
  await owner({
    kind: 'files',
    action: 'write',
    path: 'input-test.py',
    base64: Buffer.from(fixture).toString('base64'),
  });
  await owner({
    kind: 'exec',
    command: 'python3 /workspace/input-test.py >/workspace/input-test.log 2>&1 </dev/null &',
  });
  await expect
    .poll(
      async () => {
        try {
          return (await observe()).text;
        } catch {
          return null;
        }
      },
      { timeout: 10000 },
    )
    .toBe('');
  for (const mobile of process.argv.includes('--terminal')
    ? []
    : native
      ? [false]
      : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    let page, savedClipboard;
    if (native) {
      const data = join(directory, 'native');
      await mkdir(data);
      await writeFile(join(data, 'desktop.json'), JSON.stringify({ server: url }));
      nativeApp = await electron.launch({
        executablePath: resolve(
          'release/desktop/Relay-darwin-arm64/Relay.app/Contents/MacOS/Relay',
        ),
        args: [`--relay-test-data=${data}`],
        timeout: 25000,
      });
      page = await nativeApp.firstWindow();
      await nativeApp.evaluate(async ({ clipboard, ClipboardItem }) => {
        globalThis.relayClipboardBackup = await Promise.all(
          (await clipboard.read()).map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(
                  await Promise.all(
                    item.types.map(async (type) => [type, await item.getType(type)]),
                  ),
                ),
              ),
          ),
        );
      });
      savedClipboard = true;
    } else page = await context.newPage();
    inspectedPage = page;
    const readClipboard = () =>
      native
        ? nativeApp.evaluate(({ clipboard }) => clipboard.readText())
        : page.evaluate(() => navigator.clipboard.readText());
    const writeClipboard = (value) =>
      native
        ? nativeApp.evaluate(({ clipboard }, v) => clipboard.writeText(v), value)
        : page.evaluate((v) => navigator.clipboard.writeText(v), value);
    try {
      if (!native) await page.goto(url + '/#chat');
      const draft = page.getByLabel('Message Relay', { exact: true });
      await draft.fill('Keep this clipboard draft');
      const before = store.read().messages.length;
      await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();
      const display = page.getByRole('button', { name: 'Control private desktop', exact: true });
      await expect(display).toBeVisible({ timeout: 20000 });
      const copy = page.getByRole('button', { name: 'Copy text from computer', exact: true });
      const ready = () => expect(copy).toBeEnabled({ timeout: 20000 });
      const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';
      let state = await observe();
      await owner({ kind: 'desktop', action: 'click', x: state.x + 30, y: state.y + 25 });
      await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
      const original = 'Hello 你好 café 🌱\nText from my computer.';
      await owner({ kind: 'desktop', action: 'type', text: original });
      await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
      await writeClipboard('Device clipboard stays until Copy');
      await copy.click();
      await expect.poll(readClipboard, { timeout: 15000 }).toBe(original);
      await ready();
      assert.equal((await observe()).text, original);
      check(`${label}: Copy transfers exact Unicode and multiline guest text to the device`);
      if (!mobile) {
        const keyboard = page.getByLabel('Type directly on the computer', { exact: true });
        await keyboard.focus();
        await page.keyboard.press(shortcut + '+a');
        await page.keyboard.insertText('Queued text こんにちは');
        await page.keyboard.press(shortcut + '+a');
        await page.keyboard.press(shortcut + '+c');
        await expect.poll(readClipboard, { timeout: 20000 }).toBe('Queued text こんにちは');
        await ready();
        await page.keyboard.press(shortcut + '+x');
        await expect.poll(async () => (await observe()).text, { timeout: 15000 }).toBe('');
        await ready();
        assert.equal(await readClipboard(), 'Queued text こんにちは');
        await page.keyboard.press(shortcut + '+v');
        await expect
          .poll(async () => (await observe()).text, { timeout: 15000 })
          .toBe('Queued text こんにちは');
        await ready();
        check(
          `${label}: native copy/cut/paste shortcuts follow queued typing and round-trip without duplication`,
        );
      }
      if (!native) {
        await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
        const expected = (await observe()).text;
        await page.evaluate(() => {
          window.clipboardOriginalWrite = navigator.clipboard.write.bind(navigator.clipboard);
          Object.defineProperty(navigator.clipboard, 'write', {
            configurable: true,
            value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
          });
        });
        await copy.click();
        const fallback = page.getByRole('textbox', { name: 'Copied computer text', exact: true });
        await expect(fallback).toHaveValue(expected, { timeout: 15000 });
        await ready();
        const requests = computer.receipts().length;
        await page.evaluate(() =>
          Object.defineProperty(navigator.clipboard, 'write', {
            configurable: true,
            value: window.clipboardOriginalWrite,
          }),
        );
        await page.getByRole('button', { name: 'Copy to device', exact: true }).click();
        await expect(fallback).toBeHidden();
        assert.equal(await readClipboard(), expected);
        assert.equal(computer.receipts().length, requests);
        check(
          `${label}: denied clipboard write offers inline text and explicit retry without another guest action`,
        );
        await writeClipboard('Preserve this device clipboard');
        let readyTransfer, releaseTransfer;
        const received = new Promise((r) => (readyTransfer = r)),
          hold = new Promise((r) => (releaseTransfer = r));
        await page.route('**/api/computer/clipboard', async (route) => {
          const response = await route.fetch();
          readyTransfer();
          await hold;
          await route.fulfill({ response }).catch(() => {});
        });
        await copy.click();
        await received;
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(draft).toBeVisible();
        releaseTransfer();
        await page.unrouteAll({ behavior: 'wait' });
        await expect(draft).toHaveValue('Keep this clipboard draft');
        assert.equal(await readClipboard(), 'Preserve this device clipboard');
        check(
          `${label}: leaving while Copy is in flight prevents a late overwrite and preserves the chat draft`,
        );
        await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();
        await expect(copy).toBeVisible();
      }
      await ready();
      await page.screenshot({ path: join(evidence, `computer-clipboard-${label}.png`) });
      assert.deepEqual(
        (await new AxeBuilder({ page }).setLegacyMode(native).include('.computer-page').analyze())
          .violations,
        [],
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.getByRole('button', { name: 'Give back to Relay', exact: true }).click();
      await expect(copy).toBeHidden();
      await assert.rejects(computer.copyClipboard('copy'), /Take control/);
      await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await expect(draft).toHaveValue('Keep this clipboard draft');
      assert.equal(store.read().messages.length, before);
      assert.ok(!JSON.stringify(computer.receipts()).includes('Text from my computer.'));
      check(
        `${label}: handback removes copying; text stays out of receipts/history and accessible controls fit the viewport`,
      );
      await computer.takeControl();
    } finally {
      if (nativeApp && savedClipboard)
        await nativeApp.evaluate(async ({ clipboard }) => {
          if (globalThis.relayClipboardBackup.length)
            await clipboard.write(globalThis.relayClipboardBackup);
          else clipboard.clear();
          delete globalThis.relayClipboardBackup;
        });
      await nativeApp?.close();
      nativeApp = undefined;
      await context.close();
    }
  }
  if (!native) {
    await owner({
      kind: 'exec',
      command: `pkill -f '^python3 /workspace/input-test.py$' || true
xterm -title 'Relay clipboard terminal' -geometry 50x10+100+180 -e sh -c "trap 'printf interrupted > /workspace/clipboard-interrupted' INT; printf 'terminal clipboard works'; while :; do sleep 1; done" >/workspace/terminal-test.log 2>&1 </dev/null &`,
    });
    await expect
      .poll(async () => (await computer.screenshot()).terminal, { timeout: 15000 })
      .toBe(true);
    const geometry = await owner({
      kind: 'exec',
      command: 'xwininfo -id $(xdotool getwindowfocus)',
    });
    const number = (key) =>
      Number(geometry.stdout.match(new RegExp('Absolute upper-left ' + key + ':\\s+(\\d+)'))[1]);
    const x = number('X'),
      y = number('Y');
    await writeFile(
      join(evidence, 'computer-clipboard-terminal-before.jpg'),
      Buffer.from((await computer.screenshot()).screenshot, 'base64'),
    );
    await owner({ kind: 'desktop', action: 'drag', x: x + 2, y: y + 9, toX: x + 240, toY: y + 9 });
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    inspectedPage = page;
    await page.goto(url + '/#computer');
    await page.getByRole('button', { name: 'Copy text from computer', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15000 })
      .toContain('terminal clipboard works');
    await assert.rejects(computer.read('clipboard-interrupted'));
    await assert.rejects(computer.copyClipboard('cut'), /Terminal selections/);
    await page.getByLabel('Type directly on the computer', { exact: true }).focus();
    await page.keyboard.press('Control+c');
    await expect
      .poll(
        async () => {
          try {
            return Buffer.from(
              (await computer.read('clipboard-interrupted')).base64,
              'base64',
            ).toString();
          } catch {
            return '';
          }
        },
        { timeout: 15000 },
      )
      .toBe('interrupted');
    check(
      'Terminal Copy uses selected text without sending Ctrl-C; terminal Cut is refused and Ctrl-C still interrupts the running command',
    );
    await context.close();
  }
  await writeFile(
    join(
      evidence,
      native
        ? 'computer-clipboard-native-mac-acceptance.json'
        : process.argv.includes('--terminal')
          ? 'computer-clipboard-terminal-acceptance.json'
          : 'computer-clipboard-ui-acceptance.json',
    ),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        scope:
          'Real Docker guest, actual clipboard APIs and production UI. Phone is a touch browser; native mobile acceptance is separate.',
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  await inspectedPage
    ?.screenshot({ path: join(evidence, 'computer-clipboard-failure.png') })
    .catch(() => {});
  console.error(
    'UI alerts',
    await inspectedPage
      ?.getByRole('alert')
      .allTextContents()
      .catch(() => []),
  );
  console.error('Receipts', JSON.stringify(computer.receipts()));
  console.error('Guest state', JSON.stringify(await observe().catch(() => null)));
  console.error('Guest title', (await computer.screenshot().catch(() => ({}))).title);
  throw error;
} finally {
  await nativeApp?.close().catch(() => {});
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await computer.stop().catch(() => {});
  await computer.dockerRun(['rm', '-f', computer.name]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.volume]).catch(() => {});
  await computer.dockerRun(['volume', 'rm', computer.displayVolume]).catch(() => {});
  store.close();
  await rm(directory, { recursive: true, force: true });
}
