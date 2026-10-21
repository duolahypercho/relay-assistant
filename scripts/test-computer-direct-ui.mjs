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
import { executeTool } from '../server/agent.mjs';
import { computerInputFixture as fixture } from './computer-input-fixture.mjs';
const directory = await mkdtemp(join(tmpdir(), 'relay-direct-input-'));
const evidence = resolve('../relay-evidence');
const evidencePrefix = process.env.RELAY_COMPUTER_EVIDENCE_PREFIX || 'computer';
assert.match(evidencePrefix, /^[a-z0-9-]+$/);
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
  for (const mobile of native ? [false] : [false, true]) {
    const label = native ? 'native-mac' : mobile ? 'phone' : 'desktop';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    let page;
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
    } else page = await context.newPage();
    inspectedPage = page;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (!native) await page.goto(url + '/#chat');
    const draft = page.getByLabel('Message Relay', { exact: true });
    await draft.fill('Keep this ' + label + ' draft');
    const messageCount = store.read().messages.length;
    await page.getByRole('button', { name: 'Open computer', exact: true }).first().click();
    const display = page.getByRole('button', { name: 'Control private desktop', exact: true });
    await expect(display).toBeVisible({ timeout: 20000 });
    const ready = () =>
      expect(page.getByRole('button', { name: 'Give back to Relay', exact: true })).toBeEnabled({
        timeout: 15000,
      });
    async function client(x, y) {
      const box = await display.boundingBox();
      return { x: box.x + (x * box.width) / 1280, y: box.y + (y * box.height) / 800 };
    }
    async function clickPoint(x, y) {
      const p = await client(x, y);
      if (mobile) await page.touchscreen.tap(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
    }
    async function drag(from, to) {
      const a = await client(from.x, from.y),
        b = await client(to.x, to.y);
      if (mobile) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ ...a, id: 1 }],
        });
        for (let i = 1; i <= 12; i++)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
              { x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12, id: 1 },
            ],
          });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      } else {
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 12 });
        await page.screenshot({
          path: join(evidence, `${evidencePrefix}-drag-preview-${label}.png`),
        });
        await page.mouse.up();
      }
    }
    let state = await observe();
    await clickPoint(state.x + 35, state.y + 25);
    if (mobile) {
      await page.getByLabel('Type on the computer', { exact: true }).fill('Phone typing');
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
    } else {
      await expect(page.getByLabel('Type directly on the computer', { exact: true })).toBeFocused();
      await page.keyboard.type('Fast typing stays in order.', { delay: 0 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('Second line', { delay: 0 });
      await expect
        .poll(async () => (await observe()).text, { timeout: 20000 })
        .toBe('Fast typing stays in order.\nSecond line');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await page.keyboard.insertText('Hello 你好 café');
    }
    await expect
      .poll(async () => (await observe()).text, { timeout: 15000 })
      .toBe(mobile ? 'Phone typing' : 'Hello 你好 café');
    await ready();
    if (mobile) {
      const typing = page.getByLabel('Type on the computer', { exact: true });
      await expect(typing).not.toBeFocused();
      await expect(typing).toHaveAttribute('autocapitalize', 'off');
      await expect(typing).toHaveAttribute('autocorrect', 'off');
      await expect(typing).toHaveValue('');
      await typing.fill('Keep this buffered text.');
      await page.getByRole('button', { name: 'Show computer keyboard', exact: true }).click();
      const live = page.getByLabel('Type directly on the computer', { exact: true });
      await expect(live).toBeFocused();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await page.keyboard.insertText('Live 你好x');
      await live.evaluate((el) =>
        el.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'deleteContentBackward',
          }),
        ),
      );
      await live.evaluate((el) =>
        el.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertLineBreak',
          }),
        ),
      );
      await page.keyboard.insertText('Second line');
      await expect
        .poll(async () => (await observe()).text, { timeout: 20000 })
        .toBe('Live 你好\nSecond line');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(typing).toHaveValue('Keep this buffered text.');
      await typing.fill('');
      check(
        'phone: direct keyboard sends Unicode, Backspace and Return once to the real guest without a Send step',
      );
    }
    if (!mobile) {
      for (const text of [
        'Hello 你好 café 🌱',
        'こんにちは 世界',
        'Long text line\n'.repeat(40),
        'Hello 你好 café',
      ]) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        await page.keyboard.insertText(text);
        await expect.poll(async () => (await observe()).text, { timeout: 15000 }).toBe(text);
      }
      await ready();
    }
    check(`${label}: real keyboard input arrives in order without extra chat messages`);
    // Touch starts in page-scroll mode; moving guest items is an explicit choice.
    if (mobile) await page.getByRole('button', { name: 'Drag on the computer' }).click();
    // Actual WM titlebar drag, validated against the guest window position.
    state = await observe();
    const old = { x: state.x, y: state.y };
    await drag({ x: old.x + 240, y: old.y - 10 }, { x: old.x + 340, y: old.y + 50 });
    await expect
      .poll(async () => (await observe()).x, { timeout: 15000 })
      .toBeGreaterThan(old.x + 70);
    await expect.poll(async () => (await observe()).pressed).toBe(false);
    await ready();
    check(`${label}: dragging moves the real guest window and releases the pointer`);
    if (!mobile) {
      state = await observe();
      const a = state.boxes['1.0'],
        b = state.boxes['1.5'];
      await drag({ x: a[0] + 1, y: a[1] + a[3] / 2 }, { x: b[0] + 1, y: b[1] + b[3] / 2 });
      await expect.poll(async () => (await observe()).selection, { timeout: 15000 }).toBe('Hello');
      await ready();
      check(`${label}: dragging selects actual guest text`);
      // Keyboard access has an ordinary Tab exit; composition is committed exactly once.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      const input = page.getByLabel('Type directly on the computer', { exact: true });
      await input.dispatchEvent('compositionstart', { data: '' });
      await input.fill('かな');
      await input.dispatchEvent('compositionend', { data: 'かな' });
      await expect.poll(async () => (await observe()).text, { timeout: 15000 }).toBe('かな');
      await page.keyboard.press('Tab');
      await expect(page.getByLabel('Type on the computer', { exact: true })).toBeFocused();
      await ready();
      check(`${label}: composition commits once and Tab exits remote keyboard focus`);
    }
    await page.screenshot({ path: join(evidence, `${evidencePrefix}-direct-${label}.png`) });
    assert.deepEqual(
      (await new AxeBuilder({ page }).setLegacyMode(native).include('.computer-page').analyze())
        .violations,
      [],
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    await expect(draft).toHaveValue('Keep this ' + label + ' draft');
    assert.equal(store.read().messages.length, messageCount);
    assert.deepEqual(errors, []);
    await nativeApp?.close();
    nativeApp = undefined;
    await context.close();
    await owner({ kind: 'desktop', action: 'key', key: 'ctrl+a' });
    await owner({ kind: 'desktop', action: 'key', key: 'BackSpace' });
  }
  // A malformed gesture fails before it can move or press the pointer.
  const before = await observe();
  await assert.rejects(
    owner({
      kind: 'desktop',
      action: 'drag',
      x: before.x + 100,
      y: before.y - 10,
      toX: -5,
      toY: 5,
    }),
    /endpoints/,
  );
  assert.equal((await observe()).pressed, false);
  assert.equal((await observe()).x, before.x);
  check('Invalid drag endpoints leave the desktop untouched');
  const cancel = new AbortController();
  const current = await observe();
  const attempt = computer.perform(
    {
      kind: 'desktop',
      action: 'drag',
      x: current.x + 20,
      y: current.y + 20,
      toX: current.x + 400,
      toY: current.y + 180,
      operationId: randomUUID(),
    },
    { actor: 'owner', signal: cancel.signal },
  );
  const cancelled = assert.rejects(attempt, /stopped|abort/i);
  await expect
    .poll(async () => (await observe()).pressed, { intervals: [10, 20, 30], timeout: 10000 })
    .toBe(true);
  cancel.abort();
  await cancelled;
  await expect.poll(async () => (await observe()).pressed).toBe(false);
  check('Cancellation during a real drag releases the mouse button and never retries the gesture');
  const step = {
    operationId: 'agent-drag',
    action: 'drag',
    x: current.x + 220,
    y: current.y - 10,
    toX: current.x + 260,
    toY: current.y + 20,
  };
  await assert.rejects(
    executeTool(store, 'computer_use', step, { computer, runId: 'direct-test' }),
    /owner has taken control/i,
  );
  await computer.release();
  const result = await executeTool(store, 'computer_use', step, { computer, runId: 'direct-test' });
  assert.ok(result.image?.startsWith('data:image/jpeg;base64,'));
  const moved = await observe();
  assert.ok(moved.x > current.x + 20);
  const repeated = await executeTool(store, 'computer_use', step, {
    computer,
    runId: 'direct-test',
  });
  assert.equal(repeated.result.repeated, true);
  assert.equal((await observe()).x, moved.x);
  check(
    'Assistant drag respects takeover, returns a real screenshot and replays only the saved receipt',
  );

  await writeFile(
    join(
      evidence,
      native
        ? `${evidencePrefix}-direct-native-mac-acceptance.json`
        : `${evidencePrefix}-direct-input-acceptance.json`,
    ),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        checks,
        runtime: 'Real Docker desktop + production owner API and desktop/390px touch browser UI',
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  await inspectedPage
    ?.screenshot({ path: join(evidence, `${evidencePrefix}-direct-failure.png`) })
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
