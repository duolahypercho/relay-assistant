// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopInputQueue, desktopKey } from '../shared/desktop-input.mjs';

test('fast typing coalesces without crossing a key or pointer action and remains ordered while busy', async () => {
  const sent = [],
    errors = [];
  let release;
  const queue = new DesktopInputQueue(
    async (input) => {
      sent.push(input);
      if (sent.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return { ok: true };
    },
    () => {},
    (e) => errors.push(e),
  );
  queue.push({ action: 'click', x: 50, y: 40 });
  const done = queue.drain();
  for (const text of ['H', 'e', 'l', 'l', 'o']) queue.push({ action: 'type', text });
  queue.push({ action: 'key', key: 'Return' });
  queue.push({ action: 'type', text: '你好' });
  queue.push({ action: 'type', text: ' 🌱' });
  queue.push({ action: 'drag', x: 1, y: 2, toX: 3, toY: 4 });
  assert.equal(sent.length, 1);
  release();
  await done;
  assert.deepEqual(
    sent.map((i) => i.text || i.action),
    ['click', 'Hello', 'key', '你好 🌱', 'drag'],
  );
  assert.deepEqual(errors, []);
});

test('an uncertain input is never retried and later queued keystrokes are discarded', async () => {
  const sent = [],
    errors = [];
  const queue = new DesktopInputQueue(
    async (input) => {
      sent.push(input);
      throw Error('Response lost');
    },
    () => {},
    (e) => errors.push(e),
  );
  queue.push({ action: 'type', text: 'send once' });
  queue.push({ action: 'key', key: 'Return' });
  await queue.drain();
  assert.equal(sent.length, 1);
  assert.deepEqual(errors, ['Response lost']);
  assert.equal(queue.items.length, 0);
});

test('leaving control discards unsent input without replaying the active action', async () => {
  const sent = [];
  let release;
  const queue = new DesktopInputQueue(async (input) => {
    sent.push(input);
    await new Promise((r) => {
      release = r;
    });
    return true;
  });
  queue.push({ action: 'key', key: 'Return' });
  const done = queue.drain();
  queue.push({ action: 'type', text: 'never after handback' });
  queue.clear();
  release();
  await done;
  assert.deepEqual(sent, [{ action: 'key', key: 'Return' }]);
  assert.equal(queue.items.length, 0);
});

test('input is bounded and native composition, paste and keyboard escape remain local', async () => {
  const queue = new DesktopInputQueue(async () => true);
  assert.equal(queue.push({ action: 'type', text: 'x'.repeat(4001) }), false);
  for (let i = 0; i < 64; i++) assert.equal(queue.push({ action: 'key', key: 'Left' }), true);
  assert.equal(queue.push({ action: 'key', key: 'Left' }), false);
  queue.clear();
  assert.equal(desktopKey({ key: 'Tab' }), null);
  assert.equal(desktopKey({ key: 'v', metaKey: true }), null);
  assert.equal(desktopKey({ key: 'Enter', isComposing: true }), null);
  assert.equal(desktopKey({ key: 'ArrowLeft', shiftKey: true, metaKey: true }), 'ctrl+shift+Left');
  assert.equal(desktopKey({ key: 'a', metaKey: true }), 'ctrl+a');
  assert.equal(desktopKey({ key: 'é' }), null);
});
